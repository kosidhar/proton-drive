import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withAvailability } from '../src/daemon/remoteListing';
import { AvailabilityPolicy } from '../src/sync/availability';
import { RemoteIndex, type RemoteIndexEntry } from '../src/sync/remoteIndex';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

const entry = (uid: string, parentUid: string, relPath: string, type: 'file' | 'folder'): RemoteIndexEntry => ({
    uid,
    parentUid,
    relPath,
    name: relPath.split('/').pop()!,
    type,
    size: type === 'file' ? 1 : 0,
    mtimeMs: 0,
    sha1: type === 'file' ? 'abc' : null,
});

describe('withAvailability (#83)', () => {
    let dir: string;
    let stateDb: SyncStateDatabase;
    let index: RemoteIndex;
    let policy: AvailabilityPolicy;
    const record = (rel: string) =>
        stateDb.upsertItem({
            localRelPath: rel, nodeUid: `uid-${rel}`, parentNodeUid: null, type: 'file', localSha1: null, remoteSha1: null,
            localMtimeMs: 0, remoteMtimeMs: 0, size: 1, syncStatus: 'synced', lastError: null,
        });

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'pd-listing-'));
        stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        index = new RemoteIndex(stateDb.connection);
        policy = new AvailabilityPolicy(stateDb.connection, index);
        index.setRoot('root');
        index.replaceChildren('root', '', [entry('big', 'root', 'Big', 'folder'), entry('small', 'root', 'Small', 'folder')]);
        for (const [uid, rel, n] of [['big', 'Big', 3000], ['small', 'Small', 10]] as const) {
            const children: RemoteIndexEntry[] = [];
            for (let i = 0; i < n; i++) {
                children.push(i % 10 === 0 ? entry(`${uid}-d${i}`, uid, `${rel}/d${i}`, 'folder') : entry(`${uid}-f${i}`, uid, `${rel}/f${i}.txt`, 'file'));
            }
            index.replaceChildren(uid, rel, children);
            for (let i = 1; i < n; i += 2) if (i % 10 !== 0) record(`${rel}/f${i}.txt`);
        }
    });

    afterEach(async () => {
        stateDb.close();
        await rm(dir, { recursive: true, force: true });
    });

    const listing = (rel: string) => index.listChildren(rel).map((e) => ({ name: e.name, uid: e.uid }));
    const queriesFor = (remotePath: string, items: Array<{ name: string }>) => {
        const spies = (['query', 'prepare', 'run', 'exec'] as const).map((m) => spyOn(stateDb.connection, m));
        try {
            const out = withAvailability(policy, remotePath, items);
            return { out, queries: spies.reduce((n, s) => n + s.mock.calls.length, 0) };
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    };

    test('a folder of 3,000 items costs as many queries as one of 10, and every state is what stateOf says', () => {
        const big = queriesFor('/my-files/Big', listing('Big'));
        const small = queriesFor('/my-files/Small', listing('Small'));
        expect(big.out.length).toBe(3000);
        expect(big.queries).toBe(small.queries);
        for (const item of big.out) {
            expect((item as { availability: string }).availability).toBe(policy.stateOf(`Big/${item.name}`));
        }
    });

    test('pinned, hidden and hiding items, nested hides included, read as stateOf has them', () => {
        policy.setPin('small-f1', 'pinned', false);
        policy.setHide('small-f2', 'hidden');
        policy.setHide('small-d0', 'pending');
        index.replaceChildren('small-d0', 'Small/d0', [entry('inner', 'small-d0', 'Small/d0/Inner', 'folder')]);
        policy.setHide('inner', 'hidden');
        for (const [remotePath, rel] of [['/my-files/Small', 'Small'], ['/my-files/Small/d0', 'Small/d0']] as const) {
            for (const item of withAvailability(policy, remotePath, listing(rel))) {
                expect((item as { availability: string }).availability).toBe(policy.stateOf(`${rel}/${item.name}`));
            }
        }
        const states = withAvailability(policy, '/my-files/Small', listing('Small')).map((i) => (i as { availability: string }).availability);
        expect(states).toEqual(expect.arrayContaining(['pinned', 'hidden', 'hiding']));
    });

    test('an item the index does not hold is asked about on its own', () => {
        const out = withAvailability(policy, '/my-files/Small', [{ name: 'f1.txt' }, { name: 'Untitled document' }]);
        expect(out.map((i) => (i as { availability: string }).availability)).toEqual([
            policy.stateOf('Small/f1.txt'),
            policy.stateOf('Small/Untitled document'),
        ]);
    });

    test('the top of My files, and listings outside it', () => {
        const top = withAvailability(policy, '/my-files', [{ name: 'Big' }, { name: 'Small' }]);
        expect(top.map((i) => (i as { availability: string }).availability)).toEqual([policy.stateOf('Big'), policy.stateOf('Small')]);
        const shared = [{ name: 'x' }];
        expect(withAvailability(policy, '/shared-with-me', shared)).toBe(shared);
    });
});
