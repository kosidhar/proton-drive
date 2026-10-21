import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type LocalFileChangeEvent = {
    relPath: string;
    fullPath: string;
    eventType: 'change' | 'rename';
};

export function matchesIgnorePatterns(relPath: string, patterns: string[], excludedTopFolders: string[]): boolean {
    const normalized = relPath.split(path.sep).join('/');
    if (!normalized || normalized === '.') {
        return false;
    }

    const segments = normalized.split('/');
    const topFolder = segments[0]!;
    if (excludedTopFolders.includes(topFolder)) {
        return true;
    }

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
    private running = false;

    constructor(
        private readonly getRootDir: () => string,
        private readonly getIgnoreConfig: () => { ignorePatterns: string[]; excludedFolders: string[] },
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
        for (const watcher of this.watchers.values()) {
            try {
                watcher.close();
            } catch {}
        }
        this.watchers.clear();
    }

    private async watchDirectoryTree(dirPath: string): Promise<void> {
        if (!this.running) {
            return;
        }
        const rootDir = this.getRootDir();
        const relDir = path.relative(rootDir, dirPath).split(path.sep).join('/');
        const { ignorePatterns, excludedFolders } = this.getIgnoreConfig();
        if (relDir && matchesIgnorePatterns(relDir, ignorePatterns, excludedFolders)) {
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
                    this.watchers.delete(dirPath);
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
        if (this.isSuppressed(relPath)) {
            return;
        }
        const { ignorePatterns, excludedFolders } = this.getIgnoreConfig();
        if (matchesIgnorePatterns(relPath, ignorePatterns, excludedFolders)) {
            return;
        }

        const existingTimer = this.debounceTimers.get(relPath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(relPath);
            if (!this.running || this.isSuppressed(relPath)) {
                return;
            }
            // If a new directory appeared, attach an inotify watcher to it as well
            try {
                const st = await stat(fullPath);
                if (st.isDirectory()) {
                    await this.watchDirectoryTree(fullPath);
                }
            } catch {}

            try {
                await this.onLocalChange({ relPath, fullPath, eventType });
            } catch {}
        }, this.debounceMs);

        this.debounceTimers.set(relPath, timer);
    }
}
