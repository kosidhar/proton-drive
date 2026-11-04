import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { Database } from 'bun:sqlite';

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

    // #103: a folder recorded with its node is the cloud parent of the items directly in it, and of nothing else
    test('setParentOfChildren names the folder as the parent of what is directly in it only', () => {
        for (const p of ['my_docs', 'my_docs/a', 'my_docs/b', 'my_docs/sub/c', 'myXdocs/d', 'my_docs0/e', 'my_docs.txt', '😀😀/a/b', '😀😀/x']) {
            stateDb.upsertItem(record(p));
        }
        const before = stateDb.getItemByPath('my_docs/a')!.updatedAt;
        stateDb.setParentOfChildren('my_docs', 'uid-folder');
        stateDb.setParentOfChildren('😀😀', 'uid-emoji');
        const parents = Object.fromEntries(stateDb.getAllItems().map((i) => [i.localRelPath, i.parentNodeUid]));
        expect(parents).toEqual({
            my_docs: null,
            'my_docs/a': 'uid-folder',
            'my_docs/b': 'uid-folder',
            'my_docs/sub/c': null,
            'myXdocs/d': null,
            'my_docs0/e': null,
            'my_docs.txt': null,
            '😀😀/a/b': null,
            '😀😀/x': 'uid-emoji',
        });
        expect(stateDb.getItemByPath('my_docs/a')!.updatedAt).toBe(before);
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

// #180: what the engine decides (the activity log) also reaches the daemon's log file, through this hook
describe('SyncStateDatabase activity hook', () => {
    test('each activity entry is told to onActivity as it is logged', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-statedb-test-'));
        try {
            const stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
            const told: unknown[] = [];
            stateDb.onActivity = (entry) => told.push(entry);
            stateDb.logActivity({ action: 'delete-local', localRelPath: 'Docs/a.txt', details: 'Deleted on this computer' });
            expect(told).toEqual([{ action: 'delete-local', localRelPath: 'Docs/a.txt', details: 'Deleted on this computer' }]);
            stateDb.close();
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('SyncStateDatabase conflict strategy (#91)', () => {
    test('keep-local or keep-remote, stored by an older version, reads as keep-both, and is stored as keep-both at the next open', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-statedb-test-'));
        try {
            const dbPath = path.join(tempDir, 'state.sqlite');
            for (const retired of ['keep-local', 'keep-remote']) {
                const stateDb = new SyncStateDatabase(dbPath);
                const raw = new Database(dbPath);
                const stored = () => (raw.query("SELECT value FROM settings WHERE key = 'conflictStrategy'").get() as { value: string }).value;
                raw.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('conflictStrategy', ?)", [retired]);
                expect([retired, stateDb.getSettings().conflictStrategy]).toEqual([retired, 'keep-both']);
                stateDb.close();
                expect(stored()).toBe(retired);
                const reopened = new SyncStateDatabase(dbPath);
                expect(stored()).toBe('keep-both'); // an older version run next never overwrites by it
                expect(reopened.getSettings().conflictStrategy).toBe('keep-both');
                reopened.updateSettings({ conflictStrategy: 'prompt' });
                reopened.close();
                expect(stored()).toBe('prompt'); // the other strategies are left as they are
                expect(new SyncStateDatabase(dbPath).getSettings().conflictStrategy).toBe('prompt');
                raw.close();
            }
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('SyncStateDatabase content read time (#109)', () => {
    test('records from before it was kept take their updatedAt as when their content was read', async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-statedb-test-'));
        try {
            const dbPath = path.join(tempDir, 'state.sqlite');
            const old = new Database(dbPath);
            old.run(`CREATE TABLE synced_items (
                localRelPath TEXT PRIMARY KEY, nodeUid TEXT NOT NULL, parentNodeUid TEXT, type TEXT NOT NULL,
                localSha1 TEXT, remoteSha1 TEXT, localMtimeMs INTEGER NOT NULL DEFAULT 0, remoteMtimeMs INTEGER NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0, syncStatus TEXT NOT NULL DEFAULT 'synced', lastError TEXT, updatedAt INTEGER NOT NULL)`);
            old.run("INSERT INTO synced_items (localRelPath, nodeUid, type, updatedAt) VALUES ('a.txt', 'n1', 'file', 1234)");
            old.close();
            const stateDb = new SyncStateDatabase(dbPath);
            expect(stateDb.getItemByPath('a.txt')?.contentReadAt).toBe(1234);
            stateDb.upsertItem({ ...stateDb.getItemByPath('a.txt')!, localRelPath: 'b.txt', contentReadAt: undefined });
            expect(stateDb.getItemByPath('b.txt')?.contentReadAt).toBeNull(); // written without one: not known
            stateDb.touchItem('b.txt', 5000);
            expect(stateDb.getItemByPath('b.txt')?.contentReadAt).toBe(5000);
            stateDb.close();
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});
