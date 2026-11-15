import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultControlSocketPath, startControlServer } from '../src/daemon/controlServer';
import type { ShareService } from '../src/daemon/shareService';
import { DriveOpError, type VfsEntry } from '../src/sync/driveOps';
import { type AvailabilityAction, type AvailabilityResult, type FilesMissingAction, FilesMissingRefused } from '../src/sync/syncEngine';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

function makeFake(rejectWith?: string) {
    const calls: Array<[string, AvailabilityAction]> = [];
    const driveCalls: unknown[][] = [];
    const engine = {
        calls,
        async setAvailability(relPath: string, action: AvailabilityAction): Promise<AvailabilityResult> {
            calls.push([relPath, action]);
            if (rejectWith) throw new Error(rejectWith);
            return { state: action === 'free' ? 'online-only' : 'pinned', kept: ['a.txt'], refused: null };
        },
        // The nearest indexed ancestor's state, for any path (what GET answered before it checked the path exists)
        availability: { stateOf: (relPath: string) => (relPath === 'Docs' ? ('pinned' as const) : ('online-only' as const)) },
        async availabilityOf(relPath: string) {
            if (relPath === 'typo.txt') throw new Error(`Not in Proton Drive: ${relPath}`);
            return relPath === 'Docs' ? ('pinned' as const) : ('online-only' as const);
        },
        // What is hidden from this computer, as the engine lists it (sorted by path)
        hidden: [] as Array<{ path: string; state: 'hidden' | 'hiding' }>,
        hiddenItems() {
            return this.hidden;
        },
        // The drive's routes: each call is noted; some paths fail as the engine fails them
        driveCalls,
        vfsChildren(relPath: string): VfsEntry[] {
            driveCalls.push(['children', relPath]);
            if (relPath === 'Hidden') throw new DriveOpError('EACCES', `Hidden: ${relPath}`);
            return [
                { name: 'Sub folder', type: 'folder', size: 0, mtimeMs: 1000 },
                { name: 'résumé b.txt', type: 'file', size: 12, mtimeMs: 2000 },
            ];
        },
        async hydrate(relPath: string, opts?: { opener?: string }): Promise<void> {
            driveCalls.push(opts?.opener === undefined ? ['hydrate', relPath] : ['hydrate', relPath, opts.opener]);
            if (relPath === 'offline.txt') throw new DriveOpError('EIO', 'Network unreachable');
            if (relPath === 'gone.txt') throw new DriveOpError('ENOENT', `Not in Proton Drive: ${relPath}`);
            if (relPath === 'odd.txt') throw new Error('Something unexpected');
        },
        async renameItem(fromRel: string, toRel: string, opts?: { noReplace?: boolean }): Promise<void> {
            driveCalls.push(['rename', fromRel, toRel, opts]);
            if (toRel === 'taken.txt') throw new DriveOpError('EEXIST', `Already exists: ${toRel}`);
            if (fromRel === 'online-only.txt') throw new DriveOpError('EXDEV', `Not on this computer: ${fromRel}`);
        },
        async deleteItem(relPath: string, opts?: { onlyIfEmpty?: boolean; trash?: boolean }): Promise<void> {
            driveCalls.push(['delete', relPath, opts]);
            if (relPath === 'missing.txt') throw new DriveOpError('ENOENT', `Not found: ${relPath}`);
            if (relPath === 'Full' && opts?.onlyIfEmpty) throw new DriveOpError('ENOTEMPTY', `Not empty: ${relPath}`);
        },
        async truncateItem(relPath: string, opts?: { deadlineMs?: number }): Promise<void> {
            driveCalls.push(opts?.deadlineMs === undefined ? ['truncate', relPath] : ['truncate', relPath, opts]);
            if (relPath === 'local.txt') throw new DriveOpError('EEXIST', `Already exists: ${relPath}`);
        },
    };
    return engine;
}

async function start(engine = makeFake(), socketRel = 'sock-dir/control.sock') {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const socketPath = path.join(root, socketRel);
    const server = await startControlServer({ socketPath, engine: engine as never });
    cleanups.push(() => server.stop());
    return { root, socketPath, server, engine };
}

const call = (socketPath: string, pathAndQuery: string, init: RequestInit = {}) =>
    fetch(`http://localhost${pathAndQuery}`, { unix: socketPath, ...init } as RequestInit);

describe('control socket', () => {
    test('POST /availability forwards and returns the result', async () => {
        const { socketPath, engine } = await start();
        const res = await call(socketPath, '/availability', {
            method: 'POST',
            body: JSON.stringify({ path: 'Docs', action: 'free' }),
        });
        expect(res.status).toBe(200);
        expect(engine.calls).toEqual([['Docs', 'free']]);
        expect(await res.json()).toEqual({ state: 'online-only', kept: ['a.txt'], refused: null });
    });

    test('GET /availability returns the state of a path', async () => {
        const { socketPath } = await start();
        const res = await call(socketPath, '/availability?path=Docs');
        expect(await res.json()).toEqual({ path: 'Docs', state: 'pinned' });
    });

    test('GET /availability on a path that is not in Proton Drive is 400', async () => {
        const { socketPath } = await start();
        const res = await call(socketPath, '/availability?path=typo.txt');
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Not in Proton Drive: typo.txt' });
    });

    test('GET /availability/hidden lists what is hidden from this computer, and nothing when nothing is', async () => {
        const { socketPath, engine } = await start();
        let res = await call(socketPath, '/availability/hidden');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ items: [] });

        engine.hidden = [
            { path: 'Docs/Private', state: 'hiding' },
            { path: 'Music', state: 'hidden' },
        ];
        res = await call(socketPath, '/availability/hidden');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            items: [
                { path: 'Docs/Private', state: 'hiding' },
                { path: 'Music', state: 'hidden' },
            ],
        });
        expect(engine.calls).toEqual([]);
    });

    test('GET /availability/hidden is GET only and changes nothing', async () => {
        const { socketPath, engine } = await start();
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const res = await call(socketPath, '/availability/hidden', {
                method,
                body: JSON.stringify({ path: 'Music', action: 'unhide' }),
            });
            expect(res.status).toBe(405);
        }
        expect(engine.calls).toEqual([]);
    });

    test('socket is user-only', async () => {
        const { socketPath } = await start();
        expect(statSync(socketPath).mode & 0o777).toBe(0o600);
        expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    });

    test('a stale socket file is replaced', async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        writeFileSync(socketPath, 'stale');
        const server = await startControlServer({ socketPath, engine: makeFake() as never });
        cleanups.push(() => server.stop());
        const res = await call(socketPath, '/availability?path=x');
        expect(res.status).toBe(200);
    });

    test('a stale socket left by a dead server is replaced', async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        // Bind and exit without unlinking: a real socket file that refuses connections, as after a crash
        const made = Bun.spawnSync(['python3', '-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', socketPath]);
        expect(made.exitCode).toBe(0);
        expect(statSync(socketPath).isSocket()).toBe(true);
        const server = await startControlServer({ socketPath, engine: makeFake() as never });
        cleanups.push(() => server.stop());
        expect((await call(socketPath, '/availability?path=x')).status).toBe(200);
    });

    test('never replaces a socket another live server is serving', async () => {
        const first = await start(makeFake(), 'control.sock');
        await expect(startControlServer({ socketPath: first.socketPath, engine: makeFake() as never })).rejects.toThrow(
            /already running|in use/i,
        );
        const res = await call(first.socketPath, '/availability?path=Docs');
        expect(res.status).toBe(200);
    });

    test('bad action is 400', async () => {
        const { socketPath, engine } = await start();
        const res = await call(socketPath, '/availability', {
            method: 'POST',
            body: JSON.stringify({ path: 'Docs', action: 'explode' }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain('explode');
        expect(engine.calls).toEqual([]);
    });

    test('a setAvailability rejection is 400 with its message', async () => {
        const { socketPath } = await start(makeFake('Not in Proton Drive: nope'));
        const res = await call(socketPath, '/availability', {
            method: 'POST',
            body: JSON.stringify({ path: 'nope', action: 'pin' }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Not in Proton Drive: nope' });
    });

    test('malformed body is 400 and unknown routes are 404', async () => {
        const { socketPath } = await start();
        expect((await call(socketPath, '/availability', { method: 'POST', body: '{nope' })).status).toBe(400);
        expect((await call(socketPath, '/elsewhere')).status).toBe(404);
    });
});

describe('drive routes', () => {
    const post = (socketPath: string, route: string, body: unknown) =>
        call(socketPath, route, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

    test('GET /vfs/children lists a folder, with names and paths kept as they are (spaces and accents)', async () => {
        const { socketPath, engine } = await start();
        const res = await call(socketPath, `/vfs/children?path=${encodeURIComponent('Docs/été 2026/a b')}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            entries: [
                { name: 'Sub folder', type: 'folder', size: 0, mtimeMs: 1000 },
                { name: 'résumé b.txt', type: 'file', size: 12, mtimeMs: 2000 },
            ],
        });
        // An empty path is the top of the drive
        expect((await call(socketPath, '/vfs/children?path=')).status).toBe(200);
        expect(engine.driveCalls).toEqual([
            ['children', 'Docs/été 2026/a b'],
            ['children', ''],
        ]);
    });

    test('POST /vfs/hydrate waits for the download and answers ok', async () => {
        const { socketPath, engine } = await start();
        const res = await post(socketPath, '/vfs/hydrate', { path: 'Docs/été/a é.txt' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(engine.driveCalls).toEqual([['hydrate', 'Docs/été/a é.txt']]);
    });

    test('POST /vfs/hydrate passes the opener through, and drops one that is not a short name', async () => {
        const { socketPath, engine } = await start();
        for (const opener of ['rg', '', 42, 'x'.repeat(65)]) {
            expect((await post(socketPath, '/vfs/hydrate', { path: 'a.txt', opener })).status).toBe(200);
        }
        expect(engine.driveCalls).toEqual([['hydrate', 'a.txt', 'rg'], ['hydrate', 'a.txt'], ['hydrate', 'a.txt'], ['hydrate', 'a.txt']]);
    });

    test('POST /vfs/rename passes noReplace through, and POST /vfs/delete passes onlyIfEmpty and trash through', async () => {
        const { socketPath, engine } = await start();
        const renamed = await post(socketPath, '/vfs/rename', { from: 'a é.txt', to: 'Docs/b é.txt', noReplace: true });
        expect(renamed.status).toBe(200);
        expect(await renamed.json()).toEqual({ ok: true });
        expect((await post(socketPath, '/vfs/rename', { from: 'x', to: 'y' })).status).toBe(200);
        const deleted = await post(socketPath, '/vfs/delete', { path: 'Docs/b é.txt' });
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ ok: true });
        expect((await post(socketPath, '/vfs/delete', { path: 'Docs/été', onlyIfEmpty: true })).status).toBe(200);
        expect((await post(socketPath, '/vfs/delete', { path: 'Docs/old', trash: true })).status).toBe(200);
        expect(engine.driveCalls).toEqual([
            ['rename', 'a é.txt', 'Docs/b é.txt', { noReplace: true }],
            ['rename', 'x', 'y', { noReplace: false }],
            ['delete', 'Docs/b é.txt', { onlyIfEmpty: false, trash: false }],
            ['delete', 'Docs/été', { onlyIfEmpty: true, trash: false }],
            ['delete', 'Docs/old', { onlyIfEmpty: false, trash: true }],
        ]);
    });

    test('POST /vfs/truncate passes the path through', async () => {
        const { socketPath, engine } = await start();
        const truncated = await post(socketPath, '/vfs/truncate', { path: 'Docs/été.txt' });
        expect(truncated.status).toBe(200);
        expect(await truncated.json()).toEqual({ ok: true });
        const refused = await post(socketPath, '/vfs/truncate', { path: 'local.txt' });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: 'Already exists: local.txt', code: 'EEXIST' });
        expect(engine.driveCalls).toEqual([
            ['truncate', 'Docs/été.txt'],
            ['truncate', 'local.txt'],
        ]);
    });

    test('the drive changes pass a deadline through', async () => {
        const { socketPath, engine } = await start();
        const deadlineMs = 1_800_000_000_000;
        expect((await post(socketPath, '/vfs/truncate', { path: 'a', deadlineMs })).status).toBe(200);
        expect((await post(socketPath, '/vfs/rename', { from: 'a', to: 'b', deadlineMs })).status).toBe(200);
        expect((await post(socketPath, '/vfs/delete', { path: 'b', deadlineMs })).status).toBe(200);
        expect(engine.driveCalls).toEqual([
            ['truncate', 'a', { deadlineMs }],
            ['rename', 'a', 'b', { noReplace: false, deadlineMs }],
            ['delete', 'b', { onlyIfEmpty: false, trash: false, deadlineMs }],
        ]);
    });

    test("an engine error is 400 with its message and code, and any other error is code EIO", async () => {
        const { socketPath } = await start();
        const expectError = async (res: Response, error: string, code: string) => {
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error, code });
        };
        await expectError(await call(socketPath, '/vfs/children?path=Hidden'), 'Hidden: Hidden', 'EACCES');
        await expectError(await post(socketPath, '/vfs/hydrate', { path: 'offline.txt' }), 'Network unreachable', 'EIO');
        await expectError(await post(socketPath, '/vfs/hydrate', { path: 'gone.txt' }), 'Not in Proton Drive: gone.txt', 'ENOENT');
        await expectError(await post(socketPath, '/vfs/hydrate', { path: 'odd.txt' }), 'Something unexpected', 'EIO');
        await expectError(
            await post(socketPath, '/vfs/rename', { from: 'a.txt', to: 'taken.txt', noReplace: true }),
            'Already exists: taken.txt',
            'EEXIST',
        );
        await expectError(
            await post(socketPath, '/vfs/rename', { from: 'online-only.txt', to: 'b.txt' }),
            'Not on this computer: online-only.txt',
            'EXDEV',
        );
        await expectError(await post(socketPath, '/vfs/delete', { path: 'missing.txt' }), 'Not found: missing.txt', 'ENOENT');
        await expectError(await post(socketPath, '/vfs/delete', { path: 'Full', onlyIfEmpty: true }), 'Not empty: Full', 'ENOTEMPTY');
    });

    test('malformed requests are 400 and reach nothing; wrong methods are 405; unknown routes 404', async () => {
        const { socketPath, engine } = await start();
        const bad = [
            await call(socketPath, '/vfs/children'),
            await post(socketPath, '/vfs/hydrate', '{nope'),
            await post(socketPath, '/vfs/hydrate', {}),
            await post(socketPath, '/vfs/rename', { from: 'a' }),
            await post(socketPath, '/vfs/rename', { from: 'a', to: 'b', noReplace: 'yes' }),
            await post(socketPath, '/vfs/delete', { path: 7 }),
            await post(socketPath, '/vfs/delete', { path: 'Full', onlyIfEmpty: 1 }),
            await post(socketPath, '/vfs/truncate', { path: 3 }),
            await post(socketPath, '/vfs/delete', { path: 'Docs', trash: 'yes' }),
            await post(socketPath, '/vfs/truncate', { path: 'a', deadlineMs: 'soon' }),
            await post(socketPath, '/vfs/rename', { from: 'a', to: 'b', deadlineMs: null }),
            await post(socketPath, '/vfs/delete', { path: 'a', deadlineMs: '1800000000000' }),
        ];
        for (const res of bad) {
            expect(res.status).toBe(400);
            expect(((await res.json()) as { code: string }).code).toBe('EIO');
        }
        expect((await post(socketPath, '/vfs/children', { path: '' })).status).toBe(405);
        expect((await call(socketPath, '/vfs/hydrate?path=a')).status).toBe(405);
        expect((await call(socketPath, '/vfs/rename')).status).toBe(405);
        expect((await call(socketPath, '/vfs/delete')).status).toBe(405);
        expect((await call(socketPath, '/vfs/truncate')).status).toBe(405);
        expect((await call(socketPath, '/vfs/elsewhere')).status).toBe(404);
        expect(engine.driveCalls).toEqual([]);
    });

    // Bun closes a connection that has been idle for 10 s by default, a hydrate waiting on a download included (and
    // server.timeout(req, 0) doesn't lift it on a Unix socket); a download triggered by an open may take 30 minutes
    test('requests are never cut short by an idle timeout', async () => {
        const serve = spyOn(Bun, 'serve');
        try {
            await start();
            expect(serve).toHaveBeenCalledTimes(1);
            expect((serve.mock.calls[0]![0] as { idleTimeout?: number }).idleTimeout).toBe(0);
        } finally {
            serve.mockRestore();
        }
    });
});

describe('POST /vfs/mount', () => {
    async function startWith(mountAgain?: () => Promise<void>) {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        const server = await startControlServer({ socketPath, engine: makeFake() as never, mountAgain });
        cleanups.push(() => server.stop());
        return socketPath;
    }

    test('mounts the drive again and answers ok', async () => {
        let calls = 0;
        const socketPath = await startWith(async () => {
            calls++;
        });
        const res = await call(socketPath, '/vfs/mount', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(calls).toBe(1);
    });

    test('a refusal is 400 with its message and a code', async () => {
        const socketPath = await startWith(async () => {
            throw new Error('Not mounting over /home/me/ProtonDrive/a.txt');
        });
        const res = await call(socketPath, '/vfs/mount', { method: 'POST' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Not mounting over /home/me/ProtonDrive/a.txt', code: 'EIO' });
    });

    test('with no supervisor (a plain folder) it is 400 with a clear error', async () => {
        const socketPath = await startWith();
        const res = await call(socketPath, '/vfs/mount', { method: 'POST' });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string; code: string };
        expect(body.error).toMatch(/virtual drive/i);
        expect(body.code).toBe('EIO');
    });

    test('only POST', async () => {
        let calls = 0;
        const socketPath = await startWith(async () => {
            calls++;
        });
        expect((await call(socketPath, '/vfs/mount')).status).toBe(405);
        expect(calls).toBe(0);
    });
});

describe('/share routes', () => {
    async function startWith(share?: ShareService, signedIn = true, shareLog?: (line: string) => void) {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        const server = await startControlServer({ socketPath, engine: makeFake() as never, share, shareSignedIn: () => signedIn, shareLog });
        cleanups.push(() => server.stop());
        return socketPath;
    }
    const service = { info: async () => ({ link: null, people: [] }) } as unknown as ShareService;

    test('/share/info answers through the control server', async () => {
        const res = await call(await startWith(service), '/share/info?path=Docs');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ link: null, people: [] });
    });

    test("a failure is 500, and the daemon's log gets only its class", async () => {
        const lines: string[] = [];
        const failing = { info: async () => Promise.reject(new RangeError('a@b.co')) } as unknown as ShareService;
        const res = await call(await startWith(failing, true, (line) => lines.push(line)), '/share/info?path=Docs');
        expect(res.status).toBe(500);
        expect(lines).toEqual(['Sharing failed: RangeError']);
    });

    test('404 with no service wired, and 400 while signed out', async () => {
        expect((await call(await startWith(), '/share/info?path=Docs')).status).toBe(404);
        expect((await call(await startWith(service, false), '/share/info?path=Docs')).status).toBe(400);
    });
});

// #181: what the drive reports as its size: the account's storage, which the helper asks for now and then
describe('GET /vfs/space', () => {
    async function startWith(space?: () => Promise<{ usedSpace: number; maxSpace: number } | null>) {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        const server = await startControlServer({ socketPath, engine: makeFake() as never, space });
        cleanups.push(() => server.stop());
        return socketPath;
    }

    test("answers the account's storage", async () => {
        const socketPath = await startWith(async () => ({ usedSpace: 13_570_000_000, maxSpace: 510_000_000_000 }));
        const res = await call(socketPath, '/vfs/space');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ space: { usedSpace: 13_570_000_000, maxSpace: 510_000_000_000 } });
    });

    test('null while it is not known, when it fails, or with nothing wired', async () => {
        expect(await (await call(await startWith(async () => null), '/vfs/space')).json()).toEqual({ space: null });
        const failing = await startWith(async () => {
            throw new Error('offline');
        });
        expect(await (await call(failing, '/vfs/space')).json()).toEqual({ space: null });
        expect(await (await call(await startWith(), '/vfs/space')).json()).toEqual({ space: null });
    });

    test('only GET', async () => {
        const socketPath = await startWith(async () => ({ usedSpace: 1, maxSpace: 2 }));
        expect((await call(socketPath, '/vfs/space', { method: 'POST' })).status).toBe(405);
    });
});

// S39 / #46: the user says the files missing from the folder, as they were shown (root and names), were deleted on
// purpose, so they go to the Proton Drive trash; #50: or keeps them in Proton Drive, online-only. Anything else than
// what is missing now is refused
describe('POST /sync/files-missing', () => {
    type Expected = { root: string; names: string[] };
    type Resolve = (action: FilesMissingAction, expected: Expected) => Promise<{ root: string; names: string[]; items: number }>;
    async function startWith(resolve?: Resolve) {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        const server = await startControlServer({ socketPath, engine: makeFake() as never, resolveFilesMissing: resolve });
        cleanups.push(() => server.stop());
        return socketPath;
    }
    const post = (socketPath: string, body: string) => call(socketPath, '/sync/files-missing', { method: 'POST', body });
    const shown = { root: '/home/u/ProtonDrive', names: ['Docs', 'Photos/p2.jpg'] };

    test('delete-in-cloud and keep-online-only each pass on what the user was shown, and answer what was done', async () => {
        const seen: Array<[FilesMissingAction, Expected]> = [];
        const socketPath = await startWith(async (action, expected) => {
            seen.push([action, expected]);
            return { root: '/home/u/ProtonDrive', names: ['Docs', 'Photos/p2.jpg'], items: 3 };
        });
        for (const action of ['delete-in-cloud', 'keep-online-only'] as const) {
            const res = await post(socketPath, JSON.stringify({ action, ...shown }));
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true, root: '/home/u/ProtonDrive', names: ['Docs', 'Photos/p2.jpg'], items: 3 });
        }
        expect(seen).toEqual([
            ['delete-in-cloud', shown],
            ['keep-online-only', shown],
        ]);
    });

    test('with nothing missing, or something else missing than what was shown, either action is 409 with the reason', async () => {
        for (const action of ['delete-in-cloud', 'keep-online-only']) {
            for (const reason of ['Nothing is missing from /home/u/ProtonDrive', 'What is missing from /home/u/ProtonDrive has changed']) {
                const socketPath = await startWith(async () => {
                    throw new FilesMissingRefused(reason);
                });
                const res = await post(socketPath, JSON.stringify({ action, ...shown }));
                expect({ action, status: res.status }).toEqual({ action, status: 409 });
                expect(await res.json()).toEqual({ error: reason, code: 'EEXIST' });
            }
        }
    });

    test('anything but {action: "delete-in-cloud" | "keep-online-only", root, names} is 400 and does nothing; only POST', async () => {
        let calls = 0;
        const socketPath = await startWith(async () => {
            calls++;
            return { root: '/r', names: [], items: 0 };
        });
        const { root, names } = shown;
        const bodies = ['{}', '{"action":"keep"}', 'not json', '[]', JSON.stringify({ action: 'trash', root, names })];
        for (const action of ['delete-in-cloud', 'keep-online-only']) {
            bodies.push(
                JSON.stringify({ action }), // what the app sent before #46: it names nothing
                JSON.stringify({ action, names }),
                JSON.stringify({ action, root }),
                JSON.stringify({ action, root: '', names }),
                JSON.stringify({ action, root, names: [] }),
                JSON.stringify({ action, root, names: 'Docs' }),
                JSON.stringify({ action, root, names: ['Docs', 3] }),
                JSON.stringify({ action, root, names: [''] }),
            );
        }
        for (const body of bodies) {
            expect({ body, status: (await post(socketPath, body)).status }).toEqual({ body, status: 400 });
        }
        expect((await call(socketPath, '/sync/files-missing')).status).toBe(405);
        expect(calls).toBe(0);
        expect((await post(await startWith(), JSON.stringify({ action: 'keep-online-only', ...shown }))).status).toBe(404);
    });
});

describe('defaultControlSocketPath', () => {
    test('uses XDG_RUNTIME_DIR when set, else a per-uid tmp dir', () => {
        const saved = process.env.XDG_RUNTIME_DIR;
        try {
            process.env.XDG_RUNTIME_DIR = '/run/user/1234';
            expect(defaultControlSocketPath()).toBe('/run/user/1234/protondrive/control.sock');
            delete process.env.XDG_RUNTIME_DIR;
            const uid = process.getuid?.() ?? 'user';
            expect(defaultControlSocketPath()).toBe(path.join(os.tmpdir(), `protondrive-${uid}`, 'control.sock'));
        } finally {
            if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
            else process.env.XDG_RUNTIME_DIR = saved;
        }
    });
});

// #35: the user's choice when signed in to another account than the records are of
describe('POST /account/start-fresh', () => {
    async function startWith(startFresh?: () => Promise<void>) {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-control-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const socketPath = path.join(root, 'control.sock');
        const server = await startControlServer({ socketPath, engine: makeFake() as never, startFresh });
        cleanups.push(() => server.stop());
        return socketPath;
    }

    test('starts fresh, and says why when it can not', async () => {
        let started = 0;
        const ok = await startWith(async () => void (started += 1));
        expect((await call(ok, '/account/start-fresh', { method: 'POST', body: '{}' })).status).toBe(200);
        expect(started).toBe(1);
        expect((await call(ok, '/account/start-fresh')).status).toBe(405);
        const refused = await startWith(async () => {
            throw new Error('The files on this computer are synced with the same Proton account');
        });
        const res = await call(refused, '/account/start-fresh', { method: 'POST', body: '{}' });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain('same Proton account');
        expect((await call(await startWith(), '/account/start-fresh', { method: 'POST', body: '{}' })).status).toBe(404);
    });
});
