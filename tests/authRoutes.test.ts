import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { refuseOnTcp } from '../src/daemon/tcpRefusals';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

// The TCP API as the daemon serves it for these routes (refuseOnTcp first), and the control socket, over real HTTP and
// a real Unix socket in a temp dir; sign-in and sign-out are fakes that note their calls
function setup(withAuth = true) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-auth-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const calls: string[] = [];
    const tcp = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (req) => refuseOnTcp(req) ?? Response.json({ ok: true, reached: new URL(req.url).pathname }),
    });
    cleanups.push(() => void tcp.stop(true));
    const socketPath = path.join(dir, 'control.sock');
    const engine = {} as Parameters<typeof startControlServer>[0]['engine'];
    return {
        calls,
        start: async () => {
            const server = await startControlServer({
                socketPath,
                engine,
                ...(withAuth
                    ? {
                          login: async () => {
                              calls.push('login');
                              return { signInUrl: 'https://account.proton.test/sign-in', disclosure: 'third party' };
                          },
                          logout: async () => {
                              calls.push('logout');
                          },
                      }
                    : {}),
            });
            cleanups.push(() => server.stop());
        },
        tcp: async (pathname: string, method = 'POST') => {
            const res = await fetch(`http://127.0.0.1:${tcp.port}${pathname}`, { method, body: method === 'POST' ? '{}' : undefined });
            return { status: res.status, json: (await res.json()) as Record<string, unknown> };
        },
        socket: async (pathname: string, method = 'POST') => {
            const res = await fetch(`http://localhost${pathname}`, { unix: socketPath, method } as RequestInit);
            return { status: res.status, json: (await res.json()) as Record<string, unknown> };
        },
    };
}

describe('Signing in and out only over the control socket (#32)', () => {
    test('TCP refuses login and logout with 403 EACCES and reaches nothing', async () => {
        const s = setup();
        await s.start();
        for (const route of ['/api/auth/login', '/api/auth/logout']) {
            const res = await s.tcp(route);
            expect([route, res.status, res.json]).toEqual([route, 403, { error: 'Sign in and out from the Proton Drive app', code: 'EACCES' }]);
        }
        expect(s.calls).toEqual([]);
    });

    test('TCP still answers the other routes', async () => {
        const s = setup();
        expect((await s.tcp('/api/status', 'GET')).json).toEqual({ ok: true, reached: '/api/status' });
        expect((await s.tcp('/api/auth/login', 'GET')).json.reached).toBe('/api/auth/login'); // not a POST: falls through to 404 in the daemon
    });

    test('the socket signs in and answers the sign-in URL', async () => {
        const s = setup();
        await s.start();
        expect(await s.socket('/auth/login')).toEqual({
            status: 200,
            json: { ok: true, signInUrl: 'https://account.proton.test/sign-in', disclosure: 'third party' },
        });
        expect(s.calls).toEqual(['login']);
    });

    test('the socket signs out', async () => {
        const s = setup();
        await s.start();
        expect(await s.socket('/auth/logout')).toEqual({ status: 200, json: { ok: true } });
        expect(s.calls).toEqual(['logout']);
    });

    test('the socket answers 405 for another method and 404 without sign-in wired', async () => {
        const s = setup();
        await s.start();
        expect((await s.socket('/auth/login', 'GET')).status).toBe(405);
        expect((await s.socket('/auth/logout', 'GET')).status).toBe(405);
        expect(s.calls).toEqual([]);
        const bare = setup(false);
        await bare.start();
        expect((await bare.socket('/auth/login')).status).toBe(404);
    });
});
