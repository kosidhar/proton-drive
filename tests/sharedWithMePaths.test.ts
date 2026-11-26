import { describe, expect, test } from 'bun:test';

import { type NodeEntity, NodeType, ValidationError } from '@protontech/drive-sdk';

import { Paths } from '../src/sdk/paths';
import { makeMockNode } from './helpers/mockNodes';

const folder = (uid: string, name: string, parentUid = 'vol~root') =>
    makeMockNode({ uid, nameStr: name, type: NodeType.Folder, parentUid });
const file = (uid: string, name: string, parentUid: string) =>
    makeMockNode({ uid, nameStr: name, type: NodeType.File, parentUid });

// A fake SDK holding what is shared with the user. Only the uid iterators exist: the deprecated
// iterateSharedNodesWithMe is absent, so calling it fails the test.
function makePaths(opts: { shared: NodeEntity[]; children?: Record<string, NodeEntity[]>; unloadable?: string[]; extraUids?: string[] }) {
    const byUid = new Map(opts.shared.map((n) => [n.uid, n]));
    const unloadable = new Set(opts.unloadable ?? []);
    const sdk = {
        async *iterateSharedWithMeNodeUids() {
            for (const u of [...byUid.keys(), ...unloadable, ...(opts.extraUids ?? [])]) yield u;
        },
        async *iterateNodes(uids: string[]) {
            for (const u of uids) {
                if (unloadable.has(u)) throw new Error(`cannot decrypt ${u}`);
                const n = byUid.get(u);
                yield n ?? { missingUid: u };
            }
        },
        async *iterateFolderChildren(parent: NodeEntity) {
            for (const c of opts.children?.[parent.uid] ?? []) yield c;
        },
    };
    const events = { subscribeDriveScope: async () => {}, subscribePhotosScope: async () => {} };
    return new Paths(sdk as never, sdk as never, { isLoggedIn: () => true }, events as never);
}

describe('/shared-with-me paths', () => {
    test('listing the root gives the items shared with the user', async () => {
        const paths = makePaths({ shared: [folder('v~a', 'Alpha'), file('v~b', 'b.txt', 'v~x')] });
        const items = await paths.listSharedWithMe();
        expect(items.map((n) => n.uid)).toEqual(['v~a', 'v~b']);
    });

    test('a node that fails to load is skipped and reported, not a crash', async () => {
        const paths = makePaths({ shared: [folder('v~a', 'Alpha')], unloadable: ['v~bad'] });
        const skipped: string[] = [];
        const items = await paths.listSharedWithMe((uid) => skipped.push(uid));
        expect(items.map((n) => n.uid)).toEqual(['v~a']);
        expect(skipped).toEqual(['v~bad']);
    });

    test('a node the SDK reports missing is skipped and reported', async () => {
        const paths = makePaths({ shared: [folder('v~a', 'Alpha')], extraUids: ['v~gone'] });
        const skipped: string[] = [];
        const items = await paths.listSharedWithMe((uid) => skipped.push(uid));
        expect(items.map((n) => n.uid)).toEqual(['v~a']);
        expect(skipped).toEqual(['v~gone']);
    });

    test('a named shared item resolves, and so does a path below it', async () => {
        const sub = folder('v~s', 'sub', 'v~a');
        const doc = file('v~d', 'doc.txt', 'v~s');
        const paths = makePaths({
            shared: [folder('v~a', 'Alpha'), folder('v~z', 'Zed')],
            children: { 'v~a': [sub], 'v~s': [doc] },
        });
        expect((await paths.getNode('/shared-with-me/Alpha')).uid).toBe('v~a');
        expect((await paths.getNode('/shared-with-me/Alpha/sub/doc.txt')).uid).toBe('v~d');
    });

    test('a named item is found even when another shared node cannot load', async () => {
        const paths = makePaths({ shared: [folder('v~a', 'Alpha')], unloadable: ['v~bad'] });
        expect((await paths.getNode('/shared-with-me/Alpha')).uid).toBe('v~a');
    });

    test('a missing name is a validation error', async () => {
        const paths = makePaths({ shared: [folder('v~a', 'Alpha')] });
        await expect(paths.getNode('/shared-with-me/Nope')).rejects.toBeInstanceOf(ValidationError);
    });

    test('two items with the same name resolve to the first', async () => {
        const paths = makePaths({ shared: [folder('v~1', 'Dup'), folder('v~2', 'Dup')] });
        expect((await paths.getNode('/shared-with-me/Dup')).uid).toBe('v~1');
    });

    test('photos-shared-with-me resolves a named item the same way', async () => {
        const paths = makePaths({ shared: [folder('v~a', 'Alpha')] });
        expect((await paths.getNode('/photos-shared-with-me/Alpha')).uid).toBe('v~a');
    });

    test('isSharedWithMeRoot tells the bare root from items below it', () => {
        const paths = makePaths({ shared: [] });
        expect(paths.isSharedWithMeRoot('/shared-with-me')).toBe(true);
        expect(paths.isSharedWithMeRoot('/shared-with-me/')).toBe(true);
        expect(paths.isSharedWithMeRoot('/shared-with-me/Alpha')).toBe(false);
        expect(paths.isSharedWithMeRoot('/my-files')).toBe(false);
    });
});
