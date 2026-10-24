import type { Stats } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { matchesIgnorePatterns } from './localWatcher';

// Something in a folder that only exists on this computer, so removing the folder's local copy would lose it
export type LocalOnlyReason = 'ignored' | 'not-a-file' | 'not-in-cloud';
export interface LocalOnlyItem {
    relPath: string;
    reason: LocalOnlyReason;
}

// An item seen by a scan, with what it looked like then, so a removal can tell whether it changed since
export interface ScanEntry {
    relPath: string;
    signature: string;
}

export function isEngineTempName(name: string): boolean {
    return name.startsWith('.proton-drive-tmp-');
}

export function treeEntrySignature(st: { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }): string {
    // Directory mtimes are left out: a folder that gains an entry fails to delete because it isn't empty
    return st.isFile() ? `file:${st.size}:${st.mtimeMs}` : st.isDirectory() ? 'dir' : 'other';
}

// Walks an item whose local copy is about to go (a folder, a single file, or '' for the whole sync folder, which is
// never itself removed). It notes everything that exists only on this computer, since removing it would lose it:
// with stopAtFirst it stops at the first such item, otherwise it reports them all (an ignored folder once, without
// walking into it). It also returns what it saw, the item itself first and then in walk order, to remove from.
export async function scanLocalCopies(opts: {
    syncDir: string;
    relPath: string;
    ignorePatterns: string[];
    stopAtFirst: boolean;
    isUnchangedSyncedCopy(relPath: string, fullPath: string, st: Stats): Promise<boolean>;
}): Promise<{ localOnly: LocalOnlyItem[]; entries: ScanEntry[] }> {
    const entries: ScanEntry[] = [];
    const localOnly: LocalOnlyItem[] = [];
    // Returns true once the scan should stop
    const found = (item: LocalOnlyItem) => {
        localOnly.push(item);
        return opts.stopAtFirst;
    };
    const visit = async (relPath: string): Promise<boolean> => {
        const fullPath = path.join(opts.syncDir, relPath);
        const st = await lstat(fullPath).catch(() => null);
        if (!st) {
            return false; // Deleted since the listing, or never here
        }
        if (relPath !== '') {
            entries.push({ relPath, signature: treeEntrySignature(st) });
            if (st.isFile() && isEngineTempName(path.posix.basename(relPath))) {
                return false; // Our own download in progress: removed only while it stays unchanged
            }
            if (matchesIgnorePatterns(relPath, opts.ignorePatterns)) {
                return found({ relPath, reason: 'ignored' });
            }
        }
        if (st.isDirectory()) {
            for (const entry of await readdir(fullPath)) {
                if (await visit(relPath ? `${relPath}/${entry}` : entry)) {
                    return true;
                }
            }
            return false;
        }
        if (!st.isFile()) {
            return found({ relPath, reason: 'not-a-file' });
        }
        if (!(await opts.isUnchangedSyncedCopy(relPath, fullPath, st))) {
            return found({ relPath, reason: 'not-in-cloud' });
        }
        return false;
    };
    await visit(opts.relPath);
    return { localOnly, entries };
}

// Removes scanned items from the bottom up, touching only what the scan saw and only while it is unchanged. Each
// record is dropped just before its file or folder (which is looked at once more in between), so no deletion can be
// taken for the user deleting something synced, and no record outlives its file. A folder's record (which takes the
// records below it along) goes only once the folder is empty, so things kept inside it keep theirs. Nothing is
// removed recursively.
// - 'all-or-nothing' stops at the first item in `keep`, changed since the scan, or not empty; what is left keeps its
//   records and is looked at again later.
// - 'keep-changed' leaves those in place and carries on with the rest.
// `kept` lists what was left in place on purpose; `complete` says whether everything went.
export async function removeScannedEntries(opts: {
    syncDir: string;
    entries: ScanEntry[];
    keep: Set<string>;
    mode: 'all-or-nothing' | 'keep-changed';
    dropRecord(relPath: string): void;
    shouldContinue(): boolean;
}): Promise<{ complete: boolean; kept: string[] }> {
    const kept: string[] = [];
    const isKept = (relPath: string) => {
        for (let p = relPath; ; p = p.slice(0, p.lastIndexOf('/'))) {
            if (opts.keep.has(p)) {
                return true;
            }
            if (!p.includes('/')) {
                return false;
            }
        }
    };
    // Returns whether to carry on after leaving an item in place
    const leave = (relPath: string) => {
        kept.push(relPath);
        return opts.mode === 'keep-changed';
    };
    // Reverse walk order puts everything in a folder before the folder itself
    for (const { relPath, signature } of [...opts.entries].reverse()) {
        if (!opts.shouldContinue()) {
            return { complete: false, kept }; // Called off: what is left syncs normally
        }
        if (isKept(relPath)) {
            if (opts.keep.has(relPath) && !leave(relPath)) {
                return { complete: false, kept };
            }
            continue;
        }
        const fullPath = path.join(opts.syncDir, relPath);
        const st = await lstat(fullPath).catch(() => null);
        if (!st) {
            opts.dropRecord(relPath); // Already gone, and its local copy was going anyway
            continue;
        }
        if (treeEntrySignature(st) !== signature) {
            if (!leave(relPath)) {
                return { complete: false, kept };
            }
            continue;
        }
        if (st.isDirectory()) {
            const inside = await readdir(fullPath).catch(() => null);
            if (inside === null || inside.length > 0) {
                // Holds something kept, or something new saved into it meanwhile
                if (!leave(relPath)) {
                    return { complete: false, kept };
                }
                continue;
            }
        }
        opts.dropRecord(relPath);
        // Looked at once more now that its record is gone: a file written to right then stays (the caller can put its
        // record back)
        const now = await lstat(fullPath).catch(() => null);
        if (now && treeEntrySignature(now) !== signature) {
            if (!leave(relPath)) {
                return { complete: false, kept };
            }
            continue;
        }
        try {
            await (st.isDirectory() ? rmdir(fullPath) : unlink(fullPath));
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue; // Gone already
            }
            // A folder that is no longer empty: something new was saved into it
            if (!leave(relPath)) {
                return { complete: false, kept };
            }
        }
    }
    return { complete: kept.length === 0, kept };
}
