import { expect } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { computeLocalFileSha1 } from '../../src/sdk/fileOps';
import type { SyncStateDatabase } from '../../src/sync/syncStateDb';

// Files in the sync folder, as the engine or the user leaves them, and checks on how they line up with the records.
export function localFiles(stateDb: SyncStateDatabase) {
    const syncDir = () => stateDb.getSettings().syncDir;
    const exists = (rel: string) =>
        stat(path.join(syncDir(), rel))
            .then(() => true)
            .catch(() => false);
    const recordCount = (dir: string) =>
        stateDb.getAllItems().filter((i) => i.localRelPath === dir || i.localRelPath.startsWith(`${dir}/`)).length;
    const writeLocal = async (rel: string, content: string) => {
        await mkdir(path.dirname(path.join(syncDir(), rel)), { recursive: true });
        await writeFile(path.join(syncDir(), rel), content);
    };
    // A file as the engine leaves it after a sync: on disk and recorded with matching hashes
    const writeSynced = async (rel: string, content: string) => {
        await writeLocal(rel, content);
        const fullPath = path.join(syncDir(), rel);
        const st = await stat(fullPath);
        const sha1 = await computeLocalFileSha1(fullPath);
        stateDb.upsertItem({
            localRelPath: rel,
            nodeUid: `uid-${rel}`,
            parentNodeUid: null,
            type: 'file',
            localSha1: sha1,
            remoteSha1: sha1,
            localMtimeMs: st.mtimeMs,
            remoteMtimeMs: st.mtimeMs,
            size: st.size,
            syncStatus: 'synced',
            lastError: null,
        });
    };
    // A record whose file is gone reads as the user deleting it, and trashes the cloud copy on the next pass
    const expectNoRecordWithoutFile = async (dir: string) => {
        for (const item of stateDb.getAllItems().filter((i) => i.localRelPath.startsWith(`${dir}/`))) {
            expect({ path: item.localRelPath, exists: await exists(item.localRelPath) }).toEqual({
                path: item.localRelPath,
                exists: true,
            });
        }
    };
    // Runs `during` once, just before the n-th record removal (removal drops each record right before its file)
    const onRemoval = (n: number, during: (rel: string) => Promise<void> | void) => {
        const removeItemByPath = stateDb.removeItemByPath.bind(stateDb);
        let calls = 0;
        const pending: Promise<void>[] = [];
        stateDb.removeItemByPath = (rel: string) => {
            calls += 1;
            if (calls === n) {
                const result = during(rel);
                if (result) {
                    pending.push(result);
                }
            }
            removeItemByPath(rel);
        };
        return () => Promise.all(pending);
    };
    return { syncDir, exists, recordCount, writeLocal, writeSynced, expectNoRecordWithoutFile, onRemoval };
}
