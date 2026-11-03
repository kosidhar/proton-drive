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

    test('renameItemPath moves the path and what is under it, and nothing named alike', () => {
        const kept = ['AB/z', 'a/q', 'A0/w', 'A.txt'];
        for (const p of ['A', 'A/x', 'A/B', 'A/B/y', ...kept]) {
            stateDb.upsertItem(record(p));
        }

        stateDb.renameItemPath('A', 'Z/A');

        expect(paths()).toEqual(['Z/A', 'Z/A/x', 'Z/A/B', 'Z/A/B/y', ...kept].sort());
        // Only the path changes
        expect(stateDb.getItemByPath('Z/A/B/y')?.nodeUid).toBe('uid-A/B/y');
    });

    test('renameItemPath never moves the root, a path into itself, or onto records already there', () => {
        for (const p of ['A', 'A/x', 'Z/A/old']) {
            stateDb.upsertItem(record(p));
        }

        expect(() => stateDb.renameItemPath('', 'Z')).toThrow();
        expect(() => stateDb.renameItemPath('A', '')).toThrow();
        expect(() => stateDb.renameItemPath('A', 'A/x/A')).toThrow();
        expect(() => stateDb.renameItemPath('A', 'Z/A')).toThrow();

        expect(paths()).toEqual(['A', 'A/x', 'Z/A/old']);
    });
});

// #66: an unresolved conflict at a path is kept once, refreshed when queued again, never duplicated
describe('SyncStateDatabase conflicts', () => {
    let tempDir: string;
    let dbPath: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-statedb-test-'));
        dbPath = path.join(tempDir, 'state.sqlite');
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    const conflict = (remoteSha1: string, resolved = false) => ({
        localRelPath: 'Docs/doc.txt',
        nodeUid: 'vol~Docs/doc.txt',
        localSha1: 'mine',
        remoteSha1,
        localMtimeMs: 1,
        remoteMtimeMs: 2,
        resolved,
    });

    test('queueing a conflict again refreshes the one waiting, keeping its id', () => {
        const stateDb = new SyncStateDatabase(dbPath);
        const first = stateDb.queueConflict(conflict('theirs'));
        expect(first.queued).toBe(true);
        const again = stateDb.queueConflict(conflict('theirs, newer'));
        expect(again.queued).toBe(false);

        expect(stateDb.listConflicts().map((c) => ({ id: c.id, remoteSha1: c.remoteSha1 }))).toEqual([
            { id: first.conflict.id, remoteSha1: 'theirs, newer' },
        ]);
        // Once resolved, a new conflict at the path is a new one
        stateDb.markConflictResolved(first.conflict.id, 'keep-local');
        expect(stateDb.queueConflict(conflict('later')).queued).toBe(true);
        expect(stateDb.listConflicts().length).toBe(1);
        expect(stateDb.listConflicts(true).length).toBe(2);
        stateDb.close();
    });

    // #77: a resolved conflict keeps what it says happened; a late mark (a resolution that raced another) changes nothing
    test('marking a conflict already resolved changes nothing', () => {
        const stateDb = new SyncStateDatabase(dbPath);
        const { conflict: row } = stateDb.queueConflict(conflict('theirs'));
        stateDb.markConflictResolved(row.id, 'keep-remote');
        stateDb.markConflictResolved(row.id, 'keep-local', 'copy.txt');
        expect(stateDb.getConflictById(row.id)).toMatchObject({ resolved: 1, resolution: 'keep-remote', conflictCopyPath: null });
        stateDb.close();
    });

    test('duplicates left by earlier versions are folded into one when the database opens', () => {
        const stateDb = new SyncStateDatabase(dbPath);
        stateDb.connection.run('DROP INDEX IF EXISTS idx_conflicts_one_unresolved_per_path');
        const insert = (remoteSha1: string, resolved: number) =>
            stateDb.connection.run(
                `INSERT INTO conflicts (localRelPath, nodeUid, localSha1, remoteSha1, localMtimeMs, remoteMtimeMs, detectedAt, resolved)
                 VALUES ('Docs/doc.txt', 'vol~Docs/doc.txt', 'mine', ?, 1, 2, 1, ?)`,
                [remoteSha1, resolved],
            );
        insert('old', 1);
        insert('a', 0);
        insert('b', 0);
        insert('c', 0);
        stateDb.close();

        const reopened = new SyncStateDatabase(dbPath);
        expect(reopened.listConflicts().map((c) => c.remoteSha1)).toEqual(['c']);
        expect(reopened.listConflicts(true).length).toBe(2);
        expect(reopened.queueConflict(conflict('d')).queued).toBe(false);
        expect(reopened.listConflicts().map((c) => c.remoteSha1)).toEqual(['d']);
        reopened.close();
    });
});

// #66 follow-up: opening the database never needs the write lock once it is set up, so a CLI command opens it while the
// daemon is in the middle of a write
describe('SyncStateDatabase opening', () => {
    test('opens while another connection holds a write transaction', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-statedb-test-'));
        const dbPath = path.join(tempDir, 'state.sqlite');
        try {
            const daemon = new SyncStateDatabase(dbPath);
            daemon.connection.run('PRAGMA busy_timeout = 0');
            daemon.connection.run('BEGIN IMMEDIATE');
            const started = Date.now();
            let opened: SyncStateDatabase | null = null;
            try {
                opened = new SyncStateDatabase(dbPath);
                opened.connection.run('PRAGMA busy_timeout = 0');
                expect(opened.listConflicts()).toEqual([]);
            } finally {
                opened?.close();
                daemon.connection.run('ROLLBACK');
                daemon.close();
            }
            expect(Date.now() - started).toBeLessThan(2000);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }, 15_000);
});
