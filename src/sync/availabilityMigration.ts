import { existsSync } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { AvailabilityPolicy } from './availability';
import type { SyncStateDatabase } from './syncStateDb';

const MIGRATED = 'availabilityMigrated';
// Set for a fresh install: the engine pins the root at its first sync, once the root's uid is known, so everything is
// synced as before
export const PIN_ROOT_ON_FIRST_SYNC = 'pinRootOnFirstSync';

// One time, before the engine first starts with the availability policy: what is synced today stays on this computer
// (every synced top-level item is pinned), and the old Cloud only folders become online-only (no flag, not hidden).
// A fresh install (nothing synced, no Cloud only folders) gets its root pinned instead. It only writes records and
// flags, never touches files, and can be run again after a crash at any step.
export async function migrateExcludedFolders(
    stateDb: SyncStateDatabase,
    policy: AvailabilityPolicy,
    dbFilePath: string,
): Promise<'migrated' | 'already-done'> {
    if (stateDb.getMeta(MIGRATED) === '1') {
        return 'already-done';
    }

    await backUp(stateDb, `${dbFilePath}.pre-availability.bak`);

    const legacyNames = stateDb.readLegacyExcludedFolders();
    const fresh = legacyNames.length === 0 && stateDb.getAllItems().length === 0;
    // Old Cloud only folders. A removal that stopped part way left records behind; any whose file is gone would read as
    // the user deleting it, now that nothing skips these folders, and the cloud copy would be trashed.
    const cloudOnly = new Set(
        legacyNames
            .map((name) => name.trim().replace(/^\/+|\/+$/g, ''))
            .filter((name) => name && name !== '.' && name !== '..' && !name.includes('/')),
    );
    const { syncDir } = stateDb.getSettings();
    const orphaned: string[] = [];
    for (const item of stateDb.getAllItems()) {
        const top = item.localRelPath.split('/')[0]!;
        if (cloudOnly.has(top) && !(await lstat(path.join(syncDir, item.localRelPath)).then(() => true, () => false))) {
            orphaned.push(item.localRelPath);
        }
    }

    // All in one transaction, so a crash leaves either nothing or everything (marker included) written
    stateDb.connection.transaction(() => {
        for (const relPath of orphaned) {
            stateDb.removeItemByPath(relPath);
        }
        for (const item of stateDb.getAllItems()) {
            if (!item.localRelPath.includes('/') && !cloudOnly.has(item.localRelPath)) {
                policy.setPin(item.nodeUid, 'pinned', false);
            }
        }
        if (fresh) {
            stateDb.setMeta(PIN_ROOT_ON_FIRST_SYNC, '1');
        }
        stateDb.setMeta('excludedFolders', '[]'); // The retired setting, kept in the same table
        stateDb.setMeta(MIGRATED, '1');
    })();
    return 'migrated';
}

// SQLite refuses to VACUUM INTO an existing file, so a backup left by an earlier run is kept. It is written under a
// temporary name and renamed into place, so a crash mid-write never leaves a partial backup under the real name.
async function backUp(stateDb: SyncStateDatabase, backupPath: string): Promise<void> {
    if (existsSync(backupPath)) {
        return;
    }
    const partial = `${backupPath}.partial`;
    await rm(partial, { force: true });
    stateDb.connection.run('VACUUM INTO ?', [partial]);
    await rename(partial, backupPath);
}
