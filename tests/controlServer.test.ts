import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultControlSocketPath, startControlServer } from '../src/daemon/controlServer';
import { DriveOpError, type VfsEntry } from '../src/sync/driveOps';
import type { AvailabilityAction, AvailabilityResult } from '../src/sync/syncEngine';

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
        async hydrate(relPath: string): Promise<void> {
            driveCalls.push(['hydrate', relPath]);
            if (relPath === 'offline.txt') throw new DriveOpError('EIO', 'Network unreachable');
            if (relPath === 'gone.txt') throw new DriveOpError('ENOENT', `Not in Proton Drive: ${relPath}`);
            if (relPath === 'odd.txt') throw new Error('Something unexpected');
        },
        async renameItem(fromRel: string, toRel: string, opts?: { noReplace?: boolean }): Promise<void> {
            driveCalls.push(['rename', fromRel, toRel, opts]);
            if (toRel === 'taken.txt') throw new DriveOpError('EEXIST', `Already exists: ${toRel}`);
            if (fromRel === 'online-only.txt') throw new DriveOpError('EXDEV', `Not on this computer: ${fromRel}`);
        },
        async deleteItem(relPath: string, opts?: { onlyIfEmpty?: boolean }): Promise<void> {
            driveCalls.push(['delete', relPath, opts]);
            if (relPath === 'missing.txt') throw new DriveOpError('ENOENT', `Not found: ${relPath}`);
            if (relPath === 'Full' && opts?.onlyIfEmpty) throw new DriveOpError('ENOTEMPTY', `Not empty: ${relPath}`);
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

    test('POST /vfs/rename passes noReplace through, and POST /vfs/delete passes onlyIfEmpty through', async () => {
        const { socketPath, engine } = await start();
        const renamed = await post(socketPath, '/vfs/rename', { from: 'a é.txt', to: 'Docs/b é.txt', noReplace: true });
        expect(renamed.status).toBe(200);
        expect(await renamed.json()).toEqual({ ok: true });
        expect((await post(socketPath, '/vfs/rename', { from: 'x', to: 'y' })).status).toBe(200);
        const deleted = await post(socketPath, '/vfs/delete', { path: 'Docs/b é.txt' });
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ ok: true });
        expect((await post(socketPath, '/vfs/delete', { path: 'Docs/été', onlyIfEmpty: true })).status).toBe(200);
        expect(engine.driveCalls).toEqual([
            ['rename', 'a é.txt', 'Docs/b é.txt', { noReplace: true }],
            ['rename', 'x', 'y', { noReplace: false }],
            ['delete', 'Docs/b é.txt', { onlyIfEmpty: false }],
            ['delete', 'Docs/été', { onlyIfEmpty: true }],
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
        ];
        for (const res of bad) {
            expect(res.status).toBe(400);
            expect(((await res.json()) as { code: string }).code).toBe('EIO');
        }
        expect((await post(socketPath, '/vfs/children', { path: '' })).status).toBe(405);
        expect((await call(socketPath, '/vfs/hydrate?path=a')).status).toBe(405);
        expect((await call(socketPath, '/vfs/rename')).status).toBe(405);
        expect((await call(socketPath, '/vfs/delete')).status).toBe(405);
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
