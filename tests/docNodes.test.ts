import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { NodeType } from '@protontech/drive-sdk';

import { DocNodes, type DocRecord, docKindOf, docUrl, placeholderContent, placeholderName } from '../src/sync/docNodes';
import { makeMockNode } from './helpers/mockNodes';

const rec = (uid: string, parentUid: string, name = 'Plan', kind: 'doc' | 'sheet' = 'doc'): DocRecord => ({ uid, parentUid, name, kind, mtimeMs: 5 });

describe('docNodes', () => {
    test('docUrl builds the SDK getNodeUrl format from the uid', () => {
        expect(docUrl('volA~nodeB', 'doc')).toBe('https://docs.proton.me/doc?type=doc&mode=open&volumeId=volA&linkId=nodeB');
        expect(docUrl('volA~nodeB', 'sheet')).toContain('type=sheet&');
    });

    test('the SDK still builds document URLs this way', () => {
        const source = readFileSync(`${import.meta.dir}/../vendor/sdk/client/js/src/internal/nodes/nodesAccess.ts`, 'utf8');
        expect(source).toContain('https://docs.proton.me/doc?type=${type}&mode=open&volumeId=${volumeId}&linkId=${nodeId}');
    });

    test('placeholder name and content', () => {
        const r = rec('v~n', 'v~p');
        expect(placeholderName(r)).toBe('Plan.protondoc');
        expect(placeholderName({ ...r, kind: 'sheet' })).toBe('Plan.protonsheet');
        expect(placeholderContent(r)).toBe(JSON.stringify({ type: 'doc', url: docUrl('v~n', 'doc'), name: 'Plan' }) + '\n');
    });

    test('docKindOf tells Docs and Sheets from files and folders', () => {
        const file = (mediaType: string | undefined) => Object.assign(makeMockNode({ uid: 'v~a', nameStr: 'a', type: NodeType.File }), { mediaType });
        expect(docKindOf(file('application/vnd.proton.doc'))).toBe('doc');
        expect(docKindOf(file('application/vnd.proton.sheet'))).toBe('sheet');
        expect(docKindOf(file('text/plain'))).toBeNull();
        expect(docKindOf(makeMockNode({ uid: 'v~f', nameStr: 'f', type: NodeType.Folder }))).toBeNull();
    });

    test("DocNodes replaces a folder's documents, moves a doc by uid, and removes it", () => {
        const db = new Database(':memory:');
        const docs = new DocNodes(db);
        const a = rec('v~a', 'p1', 'A');
        const b = rec('v~b', 'p1', 'B', 'sheet');
        docs.replaceChildren('p1', [a, b]);
        expect(docs.listChildren('p1')).toEqual([a, b]);
        expect(docs.anyChildren('p1')).toBe(true);
        expect(docs.anyChildren('p2')).toBe(false);

        // Listed under another folder: it leaves the first
        docs.replaceChildren('p2', [{ ...a, parentUid: 'p2' }]);
        expect(docs.listChildren('p2').map((d) => d.uid)).toEqual(['v~a']);
        expect(docs.listChildren('p1').map((d) => d.uid)).toEqual(['v~b']);

        // A listing without a doc drops it
        docs.replaceChildren('p1', []);
        expect(docs.anyChildren('p1')).toBe(false);

        docs.remove('v~a');
        expect(docs.anyChildren('p2')).toBe(false);
    });

    test('the table survives reopening the database', () => {
        const db = new Database(':memory:');
        new DocNodes(db).replaceChildren('p1', [rec('v~a', 'p1')]);
        expect(new DocNodes(db).listChildren('p1')).toEqual([rec('v~a', 'p1')]);
    });
});
