import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { runAvailabilityCommand, toMyFilesRelPath } from '../src/cli/availabilityCommands';
import type { AvailabilityAction, AvailabilityResult } from '../src/sync/syncEngine';

const SYNC = '/home/u/ProtonDrive';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

describe('toMyFilesRelPath relative to the working directory', () => {
    const inDocs = `${SYNC}/Docs`;
    test('resolves against cwd when it is inside the sync folder', () => {
        expect(toMyFilesRelPath('.', SYNC, inDocs)).toBe('Docs');
        expect(toMyFilesRelPath('./', SYNC, inDocs)).toBe('Docs');
        expect(toMyFilesRelPath('file.txt', SYNC, inDocs)).toBe('Docs/file.txt');
        expect(toMyFilesRelPath('../Other', SYNC, inDocs)).toBe('Other');
    });

    test('refuses an escape from the sync folder', () => {
        expect(() => toMyFilesRelPath('..', SYNC, SYNC)).toThrow();
        expect(() => toMyFilesRelPath('../..', SYNC, inDocs)).toThrow();
    });

    test('refuses empty and dot targets that would mean the whole drive', () => {
        for (const cwd of ['/tmp', SYNC]) {
            for (const input of ['', '  ', '.', './']) {
                expect(() => toMyFilesRelPath(input, SYNC, cwd)).toThrow('to act on the whole drive, use /my-files');
            }
        }
        expect(() => toMyFilesRelPath('..', SYNC, inDocs)).toThrow();
    });

    test('the root can be named explicitly', () => {
        expect(toMyFilesRelPath('/my-files', SYNC, '/tmp')).toBe('');
        expect(toMyFilesRelPath(SYNC, SYNC, '/tmp')).toBe('');
        expect(toMyFilesRelPath(`${SYNC}/`, SYNC, inDocs)).toBe('');
    });

    test('outside the sync folder, relative input is My files relative', () => {
        expect(toMyFilesRelPath('a/b', SYNC, '/tmp')).toBe('a/b');
    });
});

describe('toMyFilesRelPath', () => {
    test('normalises the accepted forms', () => {
        expect(toMyFilesRelPath(`${SYNC}/a/b`, SYNC)).toBe('a/b');
        expect(toMyFilesRelPath('/my-files/a/b', SYNC)).toBe('a/b');
        expect(toMyFilesRelPath('a/b/', SYNC, '/tmp')).toBe('a/b');
        expect(toMyFilesRelPath(`${SYNC}/`, SYNC)).toBe('');
        expect(toMyFilesRelPath('/my-files', SYNC)).toBe('');
        expect(toMyFilesRelPath('a/../b', SYNC, '/tmp')).toBe('b');
    });

    test('refuses anything outside My files', () => {
        expect(() => toMyFilesRelPath('/etc/passwd', SYNC)).toThrow();
        expect(() => toMyFilesRelPath('../x', SYNC, '/tmp')).toThrow();
        expect(() => toMyFilesRelPath('a/../../x', SYNC, '/tmp')).toThrow();
        expect(() => toMyFilesRelPath(`${SYNC}/../x`, SYNC)).toThrow();
        expect(() => toMyFilesRelPath('/my-files/../etc', SYNC)).toThrow();
        expect(() => toMyFilesRelPath(`${SYNC}-evil/a`, SYNC)).toThrow();
    });
});

async function fakeDaemon(result: AvailabilityResult) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pd-cli-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const calls: Array<[string, AvailabilityAction]> = [];
    const engine = {
        async setAvailability(relPath: string, action: AvailabilityAction) {
            calls.push([relPath, action]);
            return result;
        },
        availability: { stateOf: () => 'pinned' as const },
    };
    const socketPath = path.join(root, 'd', 'control.sock');
    const server = await startControlServer({ socketPath, engine: engine as never });
    cleanups.push(() => server.stop());
    return { socketPath, calls };
}

function capture() {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    const error = spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
    cleanups.push(() => {
        log.mockRestore();
        error.mockRestore();
    });
    return { out, err };
}

describe('runAvailabilityCommand', () => {
    test('prints the refusal and exits 1', async () => {
        const { socketPath, calls } = await fakeDaemon({
            state: 'downloaded',
            kept: [],
            refused: "Can't hide Docs: Docs/x.tmp exists only on this computer",
        });
        const { err } = capture();
        const code = await runAvailabilityCommand('hide', `${SYNC}/Docs/`, SYNC, socketPath);
        expect(code).toBe(1);
        expect(calls).toEqual([['Docs', 'hide']]);
        expect(err.join('\n')).toContain("Can't hide Docs: Docs/x.tmp exists only on this computer");
    });

    test('prints the new state and kept items and exits 0', async () => {
        const { socketPath } = await fakeDaemon({ state: 'online-only', kept: ['Docs/a.txt'], refused: null });
        const { out } = capture();
        expect(await runAvailabilityCommand('free', 'Docs', SYNC, socketPath)).toBe(0);
        expect(out[0]).toContain('Docs');
        expect(out.join('\n')).toContain('online-only');
        expect(out.join('\n')).toContain('Docs/a.txt');
    });

    test('status reads the state', async () => {
        const { socketPath } = await fakeDaemon({ state: 'pinned', kept: [], refused: null });
        const { out } = capture();
        expect(await runAvailabilityCommand('status', 'Docs', SYNC, socketPath)).toBe(0);
        expect(out.join('\n')).toContain('pinned');
    });

    test('exits 2 with the not-running message when there is no socket', async () => {
        const { err } = capture();
        const code = await runAvailabilityCommand('pin', 'Docs', SYNC, path.join(os.tmpdir(), 'pd-nonexistent', 'c.sock'));
        expect(code).toBe(2);
        expect(err.join('\n')).toContain(`The Proton Drive daemon isn't running; start it with "protondrive daemon".`);
    });

    test('a path outside My files exits 1 without contacting the daemon', async () => {
        const { err } = capture();
        const code = await runAvailabilityCommand('pin', '/etc/passwd', SYNC, '/nonexistent.sock');
        expect(code).toBe(1);
        expect(err.join('\n')).toContain('outside');
    });
});
