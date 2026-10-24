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

// Walks a folder whose local copy is about to go. It stops at the first item that exists only on this computer, since
// removing the folder would lose it. Otherwise it returns what it saw, the folder itself first and then in walk order,
// to remove from.
export async function scanLocalCopies(opts: {
    syncDir: string;
    relPath: string;
    ignorePatterns: string[];
    isUnchangedSyncedCopy(relPath: string, fullPath: string, st: Stats): Promise<boolean>;
}): Promise<{ localOnly: LocalOnlyItem[]; entries: ScanEntry[] }> {
    const entries: ScanEntry[] = [{ relPath: opts.relPath, signature: 'dir' }];
    const walk = async (rel: string): Promise<LocalOnlyItem | null> => {
        for (const entry of await readdir(path.join(opts.syncDir, rel), { withFileTypes: true })) {
            const relPath = `${rel}/${entry.name}`;
            const fullPath = path.join(opts.syncDir, relPath);
            const st = await lstat(fullPath).catch(() => null);
            if (!st) {
                continue; // Deleted since the listing
            }
            entries.push({ relPath, signature: treeEntrySignature(st) });
            if (st.isFile() && isEngineTempName(entry.name)) {
                continue; // Our own in-progress download, safe to drop
            }
            if (matchesIgnorePatterns(relPath, opts.ignorePatterns)) {
                return { relPath, reason: 'ignored' };
            }
            if (st.isDirectory()) {
                const found = await walk(relPath);
                if (found) {
                    return found;
                }
            } else if (!st.isFile()) {
                return { relPath, reason: 'not-a-file' };
            } else if (!(await opts.isUnchangedSyncedCopy(relPath, fullPath, st))) {
                return { relPath, reason: 'not-in-cloud' };
            }
        }
        return null;
    };
    const found = await walk(opts.relPath);
    return { localOnly: found ? [found] : [], entries };
}

// Removes scanned items from the bottom up, touching only what the scan saw and only while it is unchanged, so anything
// saved meanwhile survives and stops the removal; what is left keeps its records and is looked at again later. Each
// record is dropped just before its file or folder, so no deletion event can be taken for the user deleting something
// synced. Nothing is removed recursively. Returns whether everything went.
export async function removeScannedEntries(opts: {
    syncDir: string;
    entries: ScanEntry[];
    dropRecord(relPath: string): void;
    shouldContinue(): boolean;
}): Promise<{ complete: boolean }> {
    // Reverse walk order puts everything in a folder before the folder itself
    for (const { relPath, signature } of [...opts.entries].reverse()) {
        if (!opts.shouldContinue()) {
            return { complete: false }; // Called off: what is left syncs normally
        }
        const fullPath = path.join(opts.syncDir, relPath);
        const st = await lstat(fullPath).catch(() => null);
        if (!st) {
            opts.dropRecord(relPath); // Already gone, and its local copy was going anyway
            continue;
        }
        if (treeEntrySignature(st) !== signature) {
            return { complete: false };
        }
        opts.dropRecord(relPath);
        try {
            await (st.isDirectory() ? rmdir(fullPath) : unlink(fullPath));
        } catch {
            return { complete: false }; // A folder that is no longer empty: something new was saved into it
        }
    }
    return { complete: true };
}
