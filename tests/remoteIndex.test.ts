import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeType } from '@protontech/drive-sdk';

import { entryFromNode, RemoteIndex, type RemoteIndexEntry } from '../src/sync/remoteIndex';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { makeMockNode } from './helpers/mockNodes';

function folder(uid: string, parentUid: string, relPath: string): RemoteIndexEntry {
    return { uid, parentUid, relPath, name: relPath.split('/').pop()!, type: 'folder', size: 0, mtimeMs: 0, sha1: null };
}

function file(uid: string, parentUid: string, relPath: string): RemoteIndexEntry {
    return { ...folder(uid, parentUid, relPath), type: 'file', size: 1, sha1: 'abc' };
}

describe('RemoteIndex', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;
    let index: RemoteIndex;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-remote-index-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
        index = new RemoteIndex(stateDb.connection);
        index.setRoot('root');
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    test('replaceChildren removes vanished children and their subtrees', () => {
        index.replaceChildren('root', '', [folder('a', 'root', 'A')]);
        index.replaceChildren('a', 'A', [file('x', 'a', 'A/x.txt'), folder('b', 'a', 'A/B')]);
        index.replaceChildren('b', 'A/B', [file('y', 'b', 'A/B/y.txt')]);
        expect(index.getByPath('A/B/y.txt')?.uid).toBe('y');

        index.replaceChildren('root', '', []);
        expect(index.getByPath('A')).toBeNull();
        expect(index.getByPath('A/x.txt')).toBeNull();
        expect(index.getByPath('A/B/y.txt')).toBeNull();
        expect(index.getByUid('y')).toBeNull();
        expect(index.getByPath('')?.uid).toBe('root');
    });

    test('upsert of a moved folder rewrites its subtree', () => {
        index.replaceChildren('root', '', [folder('a', 'root', 'A'), folder('z', 'root', 'Z')]);
        index.replaceChildren('a', 'A', [folder('b', 'a', 'A/B')]);
        index.replaceChildren('b', 'A/B', [file('y', 'b', 'A/B/y.txt')]);

        index.upsert(folder('a', 'z', 'Z/A'));
        expect(index.getByPath('Z/A/B/y.txt')?.uid).toBe('y');
        expect(index.getByPath('A/B/y.txt')).toBeNull();
        expect(index.getByPath('A')).toBeNull();
        expect(index.getByUid('b')?.relPath).toBe('Z/A/B');
        expect(index.getByUid('a')?.parentUid).toBe('z');
    });

    test('paths match byte-exactly', () => {
        const nfc = 'café';
        const nfd = 'café';
        index.replaceChildren('root', '', [
            folder('photos-up', 'root', 'Photos'),
            folder('photos-low', 'root', 'photos'),
            folder('my_docs', 'root', 'my_docs'),
            folder('my-docs', 'root', 'my-docs'),
            folder('cafe-nfc', 'root', nfc),
            folder('cafe-nfd', 'root', nfd),
        ]);
        index.upsert(file('a', 'photos-up', 'Photos/a'));
        index.upsert(file('b', 'photos-low', 'photos/b'));
        index.upsert(file('x', 'my_docs', 'my_docs/x'));
        index.upsert(file('y', 'my-docs', 'my-docs/y'));
        index.upsert(file('n', 'cafe-nfc', `${nfc}/n`));
        index.upsert(file('d', 'cafe-nfd', `${nfd}/d`));

        expect(index.listChildren('Photos').map((e) => e.name)).toEqual(['a']);
        expect(index.getByPath(`${nfc}/n`)?.uid).toBe('n');
        expect(index.getByPath(`${nfd}/n`)).toBeNull();
        expect(index.getByPath(`${nfd}/d`)?.uid).toBe('d');

        index.removeSubtree('my_docs');
        expect(index.getByPath('my_docs/x')).toBeNull();
        expect(index.getByPath('my-docs/y')?.uid).toBe('y');
    });

    test('entryFromNode maps claimedSize, claimedModificationTime and claimedDigests.sha1', () => {
        const node = makeMockNode({ uid: 'f1', nameStr: 'a.txt', type: NodeType.File, content: 'hello', sha1: 'deadbeef' });
        const mtime = new Date('2024-05-06T07:08:09Z');
        node.activeRevision!.claimedModificationTime = mtime;
        expect(entryFromNode(node, 'Docs')).toEqual({
            uid: 'f1',
            parentUid: 'vol~root',
            relPath: 'Docs/a.txt',
            name: 'a.txt',
            type: 'file',
            size: 5,
            mtimeMs: mtime.getTime(),
            sha1: 'deadbeef',
        });

        const dir = makeMockNode({ uid: 'd1', nameStr: 'sub', type: NodeType.Folder });
        expect(entryFromNode(dir, '')).toMatchObject({ relPath: 'sub', type: 'folder', size: 0, sha1: null });

        const doc = makeMockNode({ uid: 'p1', nameStr: 'n.protondoc', type: NodeType.File });
        doc.mediaType = 'application/vnd.proton.doc';
        expect(entryFromNode(doc, '')).toBeNull();
    });
});
