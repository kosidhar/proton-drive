import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { moveWithoutReplacing } from '../src/sync/localMove';

// A local copy moved to follow a rename in the cloud must never replace something already at its new path
describe('moveWithoutReplacing', () => {
    let dir: string;
    const at = (rel: string) => path.join(dir, rel);
    const exists = (rel: string) => stat(at(rel)).then(() => true, () => false);

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'proton-drive-move-test-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('moves a file to a free path', async () => {
        await writeFile(at('a.txt'), 'a');
        expect(moveWithoutReplacing(at('a.txt'), at('b.txt'))).toBe(true);
        expect(await exists('a.txt')).toBe(false);
        expect(await readFile(at('b.txt'), 'utf8')).toBe('a');
    });

    test('never replaces a file already at the new path', async () => {
        await writeFile(at('a.txt'), 'a');
        await writeFile(at('b.txt'), 'made here meanwhile');
        expect(moveWithoutReplacing(at('a.txt'), at('b.txt'))).toBe(false);
        expect(await readFile(at('a.txt'), 'utf8')).toBe('a');
        expect(await readFile(at('b.txt'), 'utf8')).toBe('made here meanwhile');
    });

    test('never replaces a folder already at the new path with a file', async () => {
        await writeFile(at('a.txt'), 'a');
        await mkdir(at('b.txt'));
        expect(moveWithoutReplacing(at('a.txt'), at('b.txt'))).toBe(false);
        expect(await readFile(at('a.txt'), 'utf8')).toBe('a');
        expect((await stat(at('b.txt'))).isDirectory()).toBe(true);
    });

    test('moves a folder with everything in it to a free path', async () => {
        await mkdir(at('A/.git'), { recursive: true });
        await writeFile(at('A/.git/HEAD'), 'ref');
        expect(moveWithoutReplacing(at('A'), at('B'))).toBe(true);
        expect(await exists('A')).toBe(false);
        expect(await readFile(at('B/.git/HEAD'), 'utf8')).toBe('ref');
    });

    test('never replaces a folder or a file already at the new path with a folder', async () => {
        await mkdir(at('A'));
        await writeFile(at('A/x'), 'x');
        await mkdir(at('B'));
        await writeFile(at('B/y'), 'y');
        await writeFile(at('C'), 'c');
        expect(moveWithoutReplacing(at('A'), at('B'))).toBe(false);
        expect(moveWithoutReplacing(at('A'), at('C'))).toBe(false);
        expect(await readdir(at('A'))).toEqual(['x']);
        expect(await readdir(at('B'))).toEqual(['y']);
        expect(await readFile(at('C'), 'utf8')).toBe('c');
    });

    // Final review L64: a file system with no hard links can answer link(2) with ENOSYS as well
    const linkFailing = (code: string) => () => {
        throw Object.assign(new Error(`${code}: link`), { code });
    };

    for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
        test(`without hard links (link answers ${code}), a file still moves to a free path, and never over anything`, async () => {
            await writeFile(at('a.txt'), 'a');
            expect(moveWithoutReplacing(at('a.txt'), at('b.txt'), linkFailing(code))).toBe(true);
            expect(await exists('a.txt')).toBe(false);
            expect(await readFile(at('b.txt'), 'utf8')).toBe('a');

            await writeFile(at('c.txt'), 'c');
            expect(moveWithoutReplacing(at('c.txt'), at('b.txt'), linkFailing(code))).toBe(false);
            expect(await readFile(at('c.txt'), 'utf8')).toBe('c');
            expect(await readFile(at('b.txt'), 'utf8')).toBe('a');
        });
    }

    test('any other link failure is thrown, and the file stays', async () => {
        await writeFile(at('a.txt'), 'a');
        expect(() => moveWithoutReplacing(at('a.txt'), at('b.txt'), linkFailing('EIO'))).toThrow(/EIO/);
        expect(await readFile(at('a.txt'), 'utf8')).toBe('a');
        expect(await exists('b.txt')).toBe(false);
    });
});
