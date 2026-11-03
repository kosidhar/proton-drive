import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RemoteOpsJournal } from '../src/sync/remoteOps';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

describe('RemoteOpsJournal', () => {
    let tempDir: string;
    let dbPath: string;
    let stateDb: SyncStateDatabase;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-remote-ops-'));
        dbPath = path.join(tempDir, 'state.sqlite');
        stateDb = new SyncStateDatabase(dbPath);
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    test('operations come back in the order they were journalled, each with its own fields', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        const first = journal.enqueue({ kind: 'trash', nodeUid: 'vol~b', path: 'Docs/b.txt' });
        const second = journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'Docs/z.txt' });
        const third = journal.enqueue({ kind: 'move', nodeUid: 'vol~c', toPath: 'Other/c.txt' });

        expect(first < second && second < third).toBe(true);
        expect(journal.pending()).toEqual([
            { id: first, kind: 'trash', nodeUid: 'vol~b', path: 'Docs/b.txt', attempts: 0 },
            { id: second, kind: 'rename', nodeUid: 'vol~a', toPath: 'Docs/z.txt', attempts: 0 },
            { id: third, kind: 'move', nodeUid: 'vol~c', toPath: 'Other/c.txt', attempts: 0 },
        ]);
    });

    test('pending operations survive a new journal on the same database, and the database being reopened', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'Work' });
        journal.enqueue({ kind: 'trash', nodeUid: 'vol~b', path: 'b.txt' });
        const before = journal.pending();

        expect(new RemoteOpsJournal(stateDb.connection).pending()).toEqual(before);
        stateDb.close();
        stateDb = new SyncStateDatabase(dbPath);
        expect(new RemoteOpsJournal(stateDb.connection).pending()).toEqual(before);
    });

    test('complete removes an operation; failed keeps it pending, counting the attempt and keeping the error', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        const a = journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'A2' });
        const b = journal.enqueue({ kind: 'move', nodeUid: 'vol~b', toPath: 'X/b' });

        journal.failed(a, 'Network unreachable');
        journal.failed(a, 'Still unreachable');
        journal.complete(b);

        expect(journal.pending()).toEqual([{ id: a, kind: 'rename', nodeUid: 'vol~a', toPath: 'A2', attempts: 2 }]);
        const row = stateDb.connection.query('SELECT lastError FROM remote_ops WHERE id = $id').get({ $id: a }) as {
            lastError: string;
        };
        expect(row.lastError).toBe('Still unreachable');
        journal.complete(a);
        expect(journal.pending()).toEqual([]);
    });

    test('failed keeps when an operation first failed, and when it may be tried again', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        const a = journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'A2' });
        expect(journal.failures(a)).toEqual({ firstFailedAt: null, retryAfter: null });

        const first = Date.now();
        journal.failed(a, 'Refused', first + 60_000);
        const after = journal.failures(a);
        expect(after.firstFailedAt).toBeGreaterThanOrEqual(first);
        expect(after.retryAfter).toBe(first + 60_000);

        journal.failed(a, 'Refused again');
        expect(journal.failures(a)).toEqual({ firstFailedAt: after.firstFailedAt, retryAfter: null });
        // Kept through a snapshot and its restore
        const rows = journal.snapshot();
        journal.complete(a);
        journal.restore(rows);
        expect(journal.failures(a).firstFailedAt).toBe(after.firstFailedAt);
    });

    test('hasLaterOn tells whether a later operation on the same node is pending', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        const a = journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'A2' });
        const b = journal.enqueue({ kind: 'rename', nodeUid: 'vol~b', toPath: 'B2' });
        const a2 = journal.enqueue({ kind: 'move', nodeUid: 'vol~a', toPath: 'X/A2' });

        expect(journal.hasLaterOn(a, 'vol~a')).toBe(true);
        expect(journal.hasLaterOn(a2, 'vol~a')).toBe(false);
        expect(journal.hasLaterOn(b, 'vol~b')).toBe(false);
        journal.complete(a2);
        expect(journal.hasLaterOn(a, 'vol~a')).toBe(false);
    });

    test('a later local rename takes the targets of pending moves along, and leaves look-alike paths alone', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        const intoNew = journal.enqueue({ kind: 'move', nodeUid: 'vol~x', toPath: 'New/x.txt' });
        const theFolder = journal.enqueue({ kind: 'rename', nodeUid: 'vol~n', toPath: 'New' });
        const lookAlike = journal.enqueue({ kind: 'move', nodeUid: 'vol~y', toPath: 'NewX/y.txt' });
        const trash = journal.enqueue({ kind: 'trash', nodeUid: 'vol~t', path: 'New/t.txt' });

        const changed = journal.retarget('New', 'Renamed');

        expect(changed.sort((p, q) => p.id - q.id)).toEqual([
            { id: intoNew, toPath: 'New/x.txt' },
            { id: theFolder, toPath: 'New' },
        ]);
        const targets = journal.pending().map((op) => (op.kind === 'trash' ? op.path : op.toPath));
        expect(targets).toEqual(['Renamed/x.txt', 'Renamed', 'NewX/y.txt', 'New/t.txt']);
        expect(journal.get(lookAlike)?.kind).toBe('move');
        expect(journal.get(trash)).toEqual({ id: trash, kind: 'trash', nodeUid: 'vol~t', path: 'New/t.txt', attempts: 0 });
    });

    // Review C2: once an earlier operation is superseded, the later one still says where the cloud has the node
    test('an operation keeps where the cloud has the node while earlier operations on it are pending', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        const first = journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'Docs/b.txt', fromPath: 'Docs/a.txt' });
        const second = journal.enqueue({ kind: 'rename', nodeUid: 'vol~a', toPath: 'Docs/c.txt', fromPath: 'Docs/b.txt' });
        const trash = journal.enqueue({ kind: 'trash', nodeUid: 'vol~a', path: 'Docs/c.txt' });
        const other = journal.enqueue({ kind: 'trash', nodeUid: 'vol~z', path: 'Docs/z.txt' });

        journal.complete(first);
        journal.complete(second);

        expect(journal.get(trash)).toMatchObject({ kind: 'trash', path: 'Docs/a.txt' });
        expect(journal.get(other)).toMatchObject({ kind: 'trash', path: 'Docs/z.txt' });
        expect(journal.guard().paths.sort()).toEqual(['Docs/a.txt', 'Docs/z.txt']);
    });

    test('a pending move also guards where the node is once moved but not yet renamed', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        journal.enqueue({ kind: 'move', nodeUid: 'vol~x', toPath: 'B/y.txt', fromPath: 'A/x.txt' });

        expect(journal.guard().paths.sort()).toEqual(['A/x.txt', 'B/x.txt', 'B/y.txt']);
    });

    test('the paths and nodes pending operations are about, the old place of a move included', () => {
        const journal = new RemoteOpsJournal(stateDb.connection);
        journal.enqueue({ kind: 'move', nodeUid: 'vol~x', toPath: 'B/x.txt', fromPath: 'A/x.txt' });
        journal.enqueue({ kind: 'trash', nodeUid: 'vol~t', path: 'C/t.txt' });

        const guard = journal.guard();

        expect([...guard.uids].sort()).toEqual(['vol~t', 'vol~x']);
        expect(guard.paths.sort()).toEqual(['A/x.txt', 'B/x.txt', 'C/t.txt']);
    });
});
