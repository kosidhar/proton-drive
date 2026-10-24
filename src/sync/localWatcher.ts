import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type LocalFileChangeEvent = {
    relPath: string;
    fullPath: string;
    eventType: 'change' | 'rename';
};

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
        const glob = new Bun.Glob(trimmed);
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

    private async watchDirectoryTree(dirPath: string): Promise<void> {
        if (!this.running) {
            return;
        }
        const rootDir = this.getRootDir();
        const relDir = path.relative(rootDir, dirPath).split(path.sep).join('/');
        if (relDir && this.shouldIgnore(relDir)) {
            return;
        }

        if (!this.watchers.has(dirPath)) {
            try {
                const watcher = watch(dirPath, (eventType, filename) => {
                    if (!filename) {
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
                if (entry.isDirectory()) {
                    await this.watchDirectoryTree(path.join(dirPath, entry.name));
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
                await this.watchDirectoryTree(fullPath);
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
