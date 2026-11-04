import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type LocalFileChangeEvent = {
    relPath: string;
    fullPath: string;
    eventType: 'change' | 'rename';
};

// An ignore pattern as a plain glob, as in .gitignore: Bun.Glob would take a leading ! as negating the whole pattern and
// parentheses as extglobs (!(x), @(a|b), +(…), *(…)), which can match nearly anything, so no check of what a pattern
// hides could hold (#147). Those characters are taken literally instead.
function plainGlob(pattern: string): string {
    return pattern.replace(/[()]/g, (c) => `\\${c}`).replace(/^!/, '\\!');
}

export function matchesIgnorePatterns(relPath: string, patterns: string[]): boolean {
    const normalized = relPath.split(path.sep).join('/');
    if (!normalized || normalized === '.') {
        return false;
    }

    const segments = normalized.split('/');
    const baseName = segments[segments.length - 1]!;
    if (baseName.startsWith('.proton-drive-tmp-')) {
        return true;
    }

    for (const pattern of patterns) {
        const trimmed = pattern.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed === baseName || trimmed === normalized) {
            return true;
        }
        if (segments.includes(trimmed.replace(/\/\*\*$/, ''))) {
            return true;
        }
        const glob = new Bun.Glob(plainGlob(trimmed));
        if (glob.match(normalized) || glob.match(baseName)) {
            return true;
        }
    }

    return false;
}

export class LocalFolderWatcher {
    private watchers = new Map<string, FSWatcher>();
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private suppressedPaths = new Map<string, number>();
    private renamedPaths = new Set<string>();
    private reportablePaths = new Set<string>();
    private running = false;

    constructor(
        private readonly getRootDir: () => string,
        // Paths whose changes are never reported and whose folders are not watched (ignore patterns, hidden items)
        private readonly shouldIgnore: (relPath: string) => boolean,
        private readonly onLocalChange: (event: LocalFileChangeEvent) => void | Promise<void>,
        private readonly debounceMs = 450,
    ) {}

    suppressPath(relPath: string, durationMs = 3000): void {
        const normalized = relPath.split(path.sep).join('/');
        this.suppressedPaths.set(normalized, Date.now() + durationMs);
    }

    isSuppressed(relPath: string): boolean {
        const normalized = relPath.split(path.sep).join('/');
        const until = this.suppressedPaths.get(normalized);
        if (!until) {
            return false;
        }
        if (Date.now() > until) {
            this.suppressedPaths.delete(normalized);
            return false;
        }
        return true;
    }

    async start(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        await this.watchDirectoryTree(this.getRootDir());
    }

    stop(): void {
        this.running = false;
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.renamedPaths.clear();
        this.reportablePaths.clear();
        for (const watcher of this.watchers.values()) {
            try {
                watcher.close();
            } catch {}
        }
        this.watchers.clear();
    }

    private unwatchTree(dirPath: string): void {
        for (const [watchedPath, watcher] of this.watchers) {
            if (watchedPath === dirPath || watchedPath.startsWith(`${dirPath}${path.sep}`)) {
                try {
                    watcher.close();
                } catch {}
                this.watchers.delete(watchedPath);
            }
        }
    }

    // `reportExisting`: the folder appeared while running (an event found it), so files saved into it before its watcher
    // attached raised no event of their own; those already in it are reported now (#13). Not at start: the first sync
    // pass looks at everything then.
    private async watchDirectoryTree(dirPath: string, reportExisting = false): Promise<void> {
        if (!this.running) {
            return;
        }
        const rootDir = this.getRootDir();
        const relDir = path.relative(rootDir, dirPath).split(path.sep).join('/');
        if (relDir && this.shouldIgnore(relDir)) {
            return;
        }

        const newlyWatched = !this.watchers.has(dirPath);
        if (newlyWatched) {
            try {
                const watcher = watch(dirPath, (eventType, filename) => {
                    if (!filename) {
                        return;
                    }
                    // A folder deleted reports itself to its own watcher, under its own name: joined onto its path that
                    // would be a phantom child (P/P). The parent's watcher reports the folder itself (#12). Not so for the
                    // sync folder, which has no parent watched: that report is how the engine learns at once that its
                    // files are missing (#45)
                    if (filename.toString() === path.basename(dirPath) && dirPath !== rootDir && !existsSync(dirPath)) {
                        return;
                    }
                    const fullPath = path.join(dirPath, filename.toString());
                    const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
                    this.handleRawFsEvent(eventType, relPath, fullPath);
                });
                watcher.on('error', () => {
                    // Its subtree goes too, so a path without a watcher never has watched folders under it
                    if (this.watchers.get(dirPath) === watcher) {
                        this.unwatchTree(dirPath);
                    }
                });
                this.watchers.set(dirPath, watcher);
            } catch {
                return;
            }
        }

        try {
            const entries = await readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const childPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    await this.watchDirectoryTree(childPath, reportExisting);
                } else if (reportExisting && newlyWatched) {
                    // As if its watcher had seen it made: suppression and ignore rules apply to the file's own path
                    this.handleRawFsEvent('rename', path.relative(rootDir, childPath).split(path.sep).join('/'), childPath);
                }
            }
        } catch {}
    }

    private handleRawFsEvent(eventType: 'change' | 'rename', relPath: string, fullPath: string): void {
        if (!this.running || !relPath || relPath.startsWith('..')) {
            return;
        }
        // Suppression and ignore rules only decide whether the change is reported. Keeping the watchers right has to
        // happen for every folder, including the ones the sync engine itself creates or deletes (it suppresses those).
        const reportable = !this.isSuppressed(relPath) && !this.shouldIgnore(relPath);
        if (!reportable && eventType !== 'rename' && !this.watchers.has(fullPath)) {
            return;
        }
        if (reportable) {
            this.reportablePaths.add(relPath);
        }
        if (eventType === 'rename') {
            this.renamedPaths.add(relPath);
        }
        const existingTimer = this.debounceTimers.get(relPath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(relPath);
            const renamed = this.renamedPaths.delete(relPath);
            const report = this.reportablePaths.delete(relPath) && !this.isSuppressed(relPath);
            if (!this.running) {
                return;
            }
            // A folder that went away, or was replaced, loses its watchers: a deleted folder's watcher just goes quiet
            // (no error event), so one recreated at the same path would otherwise never be watched again
            const st = await stat(fullPath).catch(() => null);
            const isDirectory = st?.isDirectory() ?? false;
            if (this.watchers.has(fullPath) && (!isDirectory || renamed)) {
                this.unwatchTree(fullPath);
            }
            if (isDirectory) {
                // Its files are reported only if the folder itself is: one the engine made or moved is suppressed, and
                // its files, synced already, aren't each worth a look (a whole moved folder would be hashed file by file)
                await this.watchDirectoryTree(fullPath, report);
            }

            if (report) {
                try {
                    await this.onLocalChange({ relPath, fullPath, eventType });
                } catch {}
            }
        }, this.debounceMs);

        this.debounceTimers.set(relPath, timer);
    }
}
