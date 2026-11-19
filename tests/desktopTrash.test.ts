import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { homeTrash, homeTrashDir, trashCommand, trashInfoPath } from '../src/sync/desktopTrash';

// The real `gio trash` is never run here: these use stand-in commands to check how the outcome is read
describe('desktop Trash command', () => {
    test('counts as moved only when the command exits 0', async () => {
        expect(await trashCommand(['true'])('/nowhere')).toBe(true);
        expect(await trashCommand(['false'])('/nowhere')).toBe(false);
    });

    test('a command that cannot be started counts as not moved', async () => {
        expect(await trashCommand(['/nonexistent/proton-drive-no-such-command'])('/nowhere')).toBe(false);
    });

    test('the path is passed whole as the last argument, even with spaces or a leading dash', async () => {
        expect(await trashCommand(['sh', '-c', '[ "$#" = 1 ] && [ "$1" = "-x y" ]', 'sh'])('-x y')).toBe(true);
    });

    test('a command that hangs is stopped and counts as not moved', async () => {
        const started = Date.now();
        expect(await trashCommand(['sh', '-c', 'sleep 5', 'sh'], 100)('/nowhere')).toBe(false);
        expect(Date.now() - started).toBeLessThan(3000);
    });
});

describe('the home Trash, with the path the user knows (#40)', () => {
    const dirs: string[] = [];
    afterEach(() => {
        while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    });
    const setup = () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-trash-'));
        dirs.push(dir);
        const store = path.join(dir, 'files');
        mkdirSync(path.join(store, 'Projects', 'app', '.git'), { recursive: true });
        writeFileSync(path.join(store, 'Projects', 'app', '.git', 'HEAD'), 'ref');
        const trash = path.join(dir, 'Trash');
        const fallbacks: string[] = [];
        const fallback = async (p: string) => (fallbacks.push(p), true);
        const at = new Date(2026, 10, 2, 9, 5, 7);
        return { dir, store, trash, fallbacks, move: homeTrash(trash, fallback, () => at) };
    };

    test('moves the item into files/ and records where the user knows it, escaped, and when', async () => {
        const t = setup();
        const shown = '/home/u/Proton Drive/Projects/app/.git';
        expect(await t.move(path.join(t.store, 'Projects/app/.git'), shown)).toBe(true);
        expect(readFileSync(path.join(t.trash, 'files', '.git', 'HEAD'), 'utf8')).toBe('ref');
        expect(readFileSync(path.join(t.trash, 'info', '.git.trashinfo'), 'utf8')).toBe(
            '[Trash Info]\nPath=/home/u/Proton%20Drive/Projects/app/.git\nDeletionDate=2026-11-02T09:05:07\n',
        );
        expect(t.fallbacks).toEqual([]);
    });

    test('a name already in the Trash gets .2, then .3, and an item in files/ without its info keeps its name', async () => {
        const t = setup();
        for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(path.join(t.store, name), name);
        mkdirSync(path.join(t.trash, 'files'), { recursive: true });
        writeFileSync(path.join(t.trash, 'files', 'x.txt.2'), 'orphan');
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
            const renamed = path.join(t.store, 'x.txt');
            rmSync(renamed, { force: true });
            writeFileSync(renamed, name);
            expect(await t.move(renamed, `/home/u/ProtonDrive/${name}`)).toBe(true);
        }
        expect(readdirSync(path.join(t.trash, 'files')).sort()).toEqual(['x.txt', 'x.txt.2', 'x.txt.3', 'x.txt.4']);
        expect(readFileSync(path.join(t.trash, 'files', 'x.txt.3'), 'utf8')).toBe('b.txt');
        expect(readdirSync(path.join(t.trash, 'info')).sort()).toEqual(['x.txt.3.trashinfo', 'x.txt.4.trashinfo', 'x.txt.trashinfo']);
    });

    test('a move that fails leaves no info behind; with no shown path, GIO trashes it as before', async () => {
        const t = setup();
        expect(await t.move(path.join(t.store, 'missing.txt'), '/home/u/ProtonDrive/missing.txt')).toBe(false);
        expect(readdirSync(path.join(t.trash, 'info'))).toEqual([]);
        expect(await t.move(path.join(t.store, 'Projects'))).toBe(true);
        expect(t.fallbacks).toEqual([path.join(t.store, 'Projects')]);
    });

    // A real move across filesystems: the Trash on /dev/shm (tmpfs) and the store in the temp folder, where they differ
    const shm = '/dev/shm';
    const otherDisk = (() => {
        try {
            const probe = mkdtempSync(path.join(shm, 'pd-trash-'));
            rmSync(probe, { recursive: true });
            return true;
        } catch {
            return false;
        }
    })();
    test.skipIf(!otherDisk)('across disks, GIO moves it instead and nothing is left in the home Trash', async () => {
        const t = setup();
        const trash = mkdtempSync(path.join(shm, 'pd-trash-'));
        dirs.push(trash);
        const fallbacks: string[] = [];
        const move = homeTrash(trash, async (p) => (fallbacks.push(p), true));
        const item = path.join(t.store, 'Projects');
        expect(await move(item, '/home/u/ProtonDrive/Projects')).toBe(true);
        expect(fallbacks).toEqual([item]);
        expect(readdirSync(path.join(trash, 'info'))).toEqual([]);
        expect(readdirSync(path.join(trash, 'files'))).toEqual([]);
    });

    test('Path= escapes as a URI path, keeping the slashes', () => {
        expect(trashInfoPath('/home/u/a b/é%#?.txt')).toBe('/home/u/a%20b/%C3%A9%25%23%3F.txt');
    });

    test('the home Trash is under XDG_DATA_HOME when it is absolute, else ~/.local/share', () => {
        expect(homeTrashDir({ XDG_DATA_HOME: '/data' })).toBe('/data/Trash');
        expect(homeTrashDir({ XDG_DATA_HOME: 'relative' })).toBe(path.join(os.homedir(), '.local/share/Trash'));
        expect(homeTrashDir({})).toBe(path.join(os.homedir(), '.local/share/Trash'));
    });

    // #353: info/<name>.trashinfo must also fit Linux's 255-byte NAME_MAX, including on .2 collisions
    test('trims long file names so both files/ and info/.trashinfo stay within 255 bytes', async () => {
        const t = setup();
        const longAscii = `${'a'.repeat(251)}.txt`;
        expect(Buffer.byteLength(longAscii)).toBe(255);
        for (const content of ['first', 'second']) {
            const p = path.join(t.store, longAscii);
            writeFileSync(p, content);
            expect(await t.move(p, `/home/u/ProtonDrive/${longAscii}`)).toBe(true);
        }
        expect(t.fallbacks).toEqual([]);
        const files = readdirSync(path.join(t.trash, 'files')).sort();
        const infos = readdirSync(path.join(t.trash, 'info')).sort();
        expect(files).toHaveLength(2);
        expect(infos).toEqual(files.map((f) => `${f}.trashinfo`).sort());
        for (const info of infos) {
            expect(Buffer.byteLength(info)).toBeLessThanOrEqual(255);
            expect(readFileSync(path.join(t.trash, 'info', info), 'utf8')).toContain(`Path=/home/u/ProtonDrive/${longAscii}\n`);
        }
        expect(files.map((f) => readFileSync(path.join(t.trash, 'files', f), 'utf8')).sort()).toEqual(['first', 'second']);

        for (const longName of [`${'é'.repeat(125)}.txt`, `${'😀'.repeat(62)}.txt`, `a.${'x'.repeat(250)}`]) {
            const p = path.join(t.store, longName);
            writeFileSync(p, longName);
            expect(await t.move(p, `/home/u/ProtonDrive/${longName}`)).toBe(true);
        }
        for (const info of readdirSync(path.join(t.trash, 'info'))) {
            expect(Buffer.byteLength(info)).toBeLessThanOrEqual(255);
        }
    });
});
