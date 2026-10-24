import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SyncStateDatabase } from '../src/sync/syncStateDb';

describe('SyncStateDatabase paths', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;

    const record = (localRelPath: string) => ({
        localRelPath,
        nodeUid: `uid-${localRelPath}`,
        parentNodeUid: null,
        type: 'file' as const,
        localSha1: null,
        remoteSha1: null,
        localMtimeMs: 0,
        remoteMtimeMs: 0,
        size: 0,
        syncStatus: 'synced' as const,
        lastError: null,
    });
    const paths = () =>
        stateDb
            .getAllItems()
            .map((i) => i.localRelPath)
            .sort();

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-statedb-test-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    test('removeItemByPath removes the path and what is under it, and nothing named alike', () => {
        const kept = ['Photos.txt', 'Photos0/x.jpg', 'my-docs/y', 'my.docs/z', 'photos/b.jpg', 'Photosynth/c.jpg'];
        for (const p of ['Photos', 'Photos/a.jpg', 'Photos/2025/d.jpg', 'my_docs', 'my_docs/x', ...kept]) {
            stateDb.upsertItem(record(p));
        }

        stateDb.removeItemByPath('Photos');
        stateDb.removeItemByPath('my_docs');

        expect(paths()).toEqual([...kept].sort());
    });

    test('hasItemsUnder matches the same way', () => {
        stateDb.upsertItem(record('photos/b.jpg'));
        stateDb.upsertItem(record('my-docs/y'));
        expect(stateDb.hasItemsUnder('Photos')).toBe(false);
        expect(stateDb.hasItemsUnder('my_docs')).toBe(false);
        expect(stateDb.hasItemsUnder('photos')).toBe(true);
        expect(stateDb.hasItemsUnder('photos/b.jpg')).toBe(true);
    });
});
