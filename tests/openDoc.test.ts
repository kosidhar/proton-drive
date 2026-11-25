import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDoc, parseDocLink } from '../src/cli/openDoc';
import { docUrl, placeholderContent, type DocRecord } from '../src/sync/docNodes';

const rec = (kind: 'doc' | 'sheet'): DocRecord => ({
    uid: 'vol1~node1',
    parentUid: 'vol1~parent',
    name: 'Plan',
    kind,
    mtimeMs: 0,
});

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'opendoc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness() {
    const opened: string[] = [];
    const notes: Array<[string, string]> = [];
    return { opened, notes, deps: { open: (u: string) => void opened.push(u), notify: (t: string, b: string) => void notes.push([t, b]) } };
}

const asContent = (url: string, type = 'doc') => JSON.stringify({ type, url, name: 'x' }) + '\n';

test("a placeholder's link is accepted", () => {
    for (const kind of ['doc', 'sheet'] as const) {
        const r = rec(kind);
        expect(parseDocLink(placeholderContent(r))).toEqual({ url: docUrl(r.uid, kind), kind });
    }
});

test('anything but a Proton document link is refused', () => {
    for (const url of [
        'https://evil.example/doc?type=doc&volumeId=a&linkId=b',
        'http://docs.proton.me/doc?type=doc&volumeId=a&linkId=b',
        'https://docs.proton.me.evil.example/doc?type=doc&volumeId=a&linkId=b',
        'https://docs.proton.me:8443/doc?type=doc&volumeId=a&linkId=b',
        'https://user@docs.proton.me/doc?type=doc&volumeId=a&linkId=b',
        'https://user:pw@docs.proton.me/doc?type=doc&volumeId=a&linkId=b',
        'https://docs.proton.me/other?type=doc&volumeId=a&linkId=b',
        'https://docs.proton.me/doc/?type=doc&volumeId=a&linkId=b',
        'https://docs.proton.me/doc?type=pdf&volumeId=a&linkId=b',
        'https://docs.proton.me/doc?type=doc&linkId=b',
        'https://docs.proton.me/doc?type=doc&volumeId=a',
        'https://docs.proton.me/doc?type=doc&volumeId=&linkId=b',
        'https://docs.proton.me/doc?type=doc&volumeId=a&linkId=',
        'javascript:alert(1)',
        'not a url',
    ]) {
        expect(parseDocLink(asContent(url))).toBeNull();
    }
    for (const text of ['not json', '', 'null', '[]', '"x"', '{}', JSON.stringify({ url: 5 })]) {
        expect(parseDocLink(text)).toBeNull();
    }
});

test('openDoc opens a good link and exits 0', async () => {
    const h = harness();
    const file = path.join(dir, 'Plan.protondoc');
    writeFileSync(file, placeholderContent(rec('sheet')));
    expect(await openDoc(file, h.deps)).toBe(0);
    expect(h.opened).toEqual([docUrl(rec('sheet').uid, 'sheet')]);
    expect(h.notes).toEqual([]);
});

test("openDoc refuses a bad link, notifies, and exits 1", async () => {
    const h = harness();
    const file = path.join(dir, 'bad.protondoc');
    writeFileSync(file, asContent('https://evil.example/doc?type=doc&volumeId=a&linkId=b'));
    expect(await openDoc(file, h.deps)).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.notes).toEqual([['Proton Drive', "This isn't a Proton Drive document link"]]);
});

test('openDoc refuses a missing file, a directory and a file over 64 KiB', async () => {
    const h = harness();
    const big = path.join(dir, 'big.protondoc');
    writeFileSync(big, placeholderContent(rec('doc')) + ' '.repeat(64 * 1024));
    expect(await openDoc(path.join(dir, 'missing'), h.deps)).toBe(1);
    expect(await openDoc(dir, h.deps)).toBe(1);
    expect(await openDoc(big, h.deps)).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.notes).toHaveLength(3);
});
