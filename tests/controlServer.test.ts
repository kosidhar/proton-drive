import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultControlSocketPath, startControlServer } from '../src/daemon/controlServer';
import type { AvailabilityAction, AvailabilityResult } from '../src/sync/syncEngine';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

function makeFake(rejectWith?: string) {
    const calls: Array<[string, AvailabilityAction]> = [];
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
