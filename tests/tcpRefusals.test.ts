import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { controlServerOptions } from '../src/daemon/controlWiring';
import { startControlServer } from '../src/daemon/controlServer';
import { REFUSED_ON_TCP, refuseOnTcp } from '../src/daemon/tcpRefusals';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

describe('What the TCP API refuses, and how the daemon is wired (#32, #33, #36)', () => {
    const table = {
        '/api/auth/login': 'Sign in and out from the Proton Drive app',
        '/api/auth/logout': 'Sign in and out from the Proton Drive app',
        '/api/conflicts/resolve': 'Resolve conflicts from the Proton Drive app',
        '/api/settings': 'Change settings from the Proton Drive app',
        '/api/remote/mkdir': 'Create folders from the Proton Drive app',
    };

    test('the refusal table is exactly the routes that moved to the socket', () => {
        expect(Object.fromEntries(REFUSED_ON_TCP)).toEqual(table);
    });

    test('each refused route answers 403 EACCES to a POST, whatever the body, and a GET is let through', async () => {
        for (const [route, error] of Object.entries(table)) {
            for (const body of ['{}', '[]', 'not json', JSON.stringify({ ignorePatterns: ['*'], id: 1, choice: 'keep-local' })]) {
                const res = refuseOnTcp(new Request(`http://127.0.0.1:49152${route}`, { method: 'POST', body }));
                expect([route, res?.status, await res?.json()]).toEqual([route, 403, { error, code: 'EACCES' }]);
            }
            expect(refuseOnTcp(new Request(`http://127.0.0.1:49152${route}`))).toBeNull();
        }
        for (const route of ['/api/status', '/api/conflicts', '/api/activity', '/api/sync', '/api/pause', '/api/quit', '/api/remote/list']) {
            expect([route, refuseOnTcp(new Request(`http://127.0.0.1:49152${route}`, { method: 'POST' }))]).toEqual([route, null]);
        }
    });

    // The daemon's own fetch handler can't be started here (it signs in to Proton and owns the real folders), so the
    // source is held to what it must do: refuse first, and hold no handler for a route that moved
    test('the daemon refuses before it routes, and has no handler left for a moved route', () => {
        const source = readFileSync(path.join(import.meta.dir, '../src/daemon/daemonServer.ts'), 'utf8');
        const fetchAt = source.indexOf('async fetch(req, srv)');
        const guardAt = source.indexOf('isTrustedLocalRequest(', fetchAt);
        const refuseAt = source.search(/const refused = refuseOnTcp\(req\);\s*if \(refused\) return refused;/);
        const firstRouteAt = source.indexOf("pathname === '/", fetchAt);
        expect(fetchAt).toBeGreaterThan(0);
        expect(guardAt).toBeGreaterThan(fetchAt);
        expect(refuseAt).toBeGreaterThan(guardAt);
        expect(refuseAt).toBeLessThan(firstRouteAt);
        for (const route of Object.keys(table)) {
            expect([route, source.includes(`'${route}'`)]).toEqual([route, false]);
        }
        expect(source).not.toMatch(/settingsRoute|resolveConflictManually\(Number/);
    });

    test('the control socket reaches what the daemon passes: sign-in to sign-in, sign-out to sign-out, and so on', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-wiring-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        cleanups.push(() => stateDb.close());
        stateDb.updateSettings({ syncDir: path.join(dir, 'ProtonDrive') });
        const calls: unknown[][] = [];
        const options = controlServerOptions({
            socketPath: path.join(dir, 'control.sock'),
            engine: {
                resolveConflictManually: async (id: number, choice: string) => {
                    calls.push(['resolve', id, choice]);
                    return { id } as never;
                },
                reconcileNow: async () => {},
                confirmFilesMissingDeleted: async (expected: unknown) => {
                    calls.push(['files-missing', expected]);
                    return { root: '/r', names: ['Docs'], items: 1 };
                },
            } as never,
            drive: { mountAgain: async () => void calls.push(['mount']), resolveMove: async () => {}, relocate: async (to: string) => to, setVirtualDriveWanted: async () => {}, status: () => ({}) as never } as never,
            stateDb,
            signIn: async () => {
                calls.push(['signIn']);
                return { signInUrl: 'https://sign.in', disclosure: 'd' };
            },
            signOut: async () => void calls.push(['signOut']),
            makeRemoteFolder: async (parentPath, name) => {
                calls.push(['mkdir', parentPath, name]);
                return { uid: 'u1', name };
            },
        });
        const server = await startControlServer(options);
        cleanups.push(() => server.stop());
        const post = (route: string, body?: unknown) =>
            fetch(`http://localhost${route}`, { unix: options.socketPath, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) } as RequestInit).then(
                async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }),
            );

        expect((await post('/auth/login')).json).toMatchObject({ signInUrl: 'https://sign.in' });
        expect((await post('/auth/logout')).status).toBe(200);
        expect((await post('/conflicts/resolve', { id: 3, choice: 'keep-local' })).status).toBe(200);
        expect((await post('/remote/mkdir', { parentPath: '/my-files', name: 'New' })).json).toEqual({ ok: true, folder: { uid: 'u1', name: 'New' } });
        expect((await post('/drive/settings', { notificationsEnabled: false })).status).toBe(200);
        expect(stateDb.getSettings().notificationsEnabled).toBe(false);
        expect((await post('/sync/files-missing', { action: 'delete-in-cloud', root: '/r', names: ['Docs'] })).json).toEqual({
            ok: true,
            root: '/r',
            names: ['Docs'],
            items: 1,
        });
        expect(calls).toEqual([
            ['signIn'],
            ['signOut'],
            ['resolve', 3, 'keep-local'],
            ['mkdir', '/my-files', 'New'],
            ['files-missing', { root: '/r', names: ['Docs'] }],
        ]);
    });

    test('the mkdir route checks its body and reports a failure', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-mkdir-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const socketPath = path.join(dir, 'control.sock');
        const server = await startControlServer({
            socketPath,
            engine: {} as never,
            remoteMkdir: async (_parent, name) => {
                if (name === 'boom') throw new Error('Network unreachable');
                return { uid: 'u', name };
            },
        });
        cleanups.push(() => server.stop());
        const post = (raw: string, method = 'POST') =>
            fetch('http://localhost/remote/mkdir', { unix: socketPath, method, body: method === 'POST' ? raw : undefined } as RequestInit).then(
                async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }),
            );
        for (const body of ['{}', '{"name":""}', '{"name":"  "}', '{"name":"."}', '{"name":".."}', '{"name":"a\\u0000b"}', '{"name":3}', '{"name":"a/b"}', '{"name":"a","parentPath":4}', '[1]', 'not json']) {
            const res = await post(body);
            expect([body, res.status, res.json.code]).toEqual([body, 400, 'EINVAL']);
        }
        expect((await post('{"name":"ok"}')).json).toEqual({ ok: true, folder: { uid: 'u', name: 'ok' } });
        expect((await post('{"name":"boom"}')).status).toBe(500);
        expect((await post('', 'GET')).status).toBe(405);
    });
});
