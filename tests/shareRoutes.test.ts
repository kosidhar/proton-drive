import { describe, expect, test } from 'bun:test';

import { ShareError, type ShareInfo, type ShareService } from '../src/daemon/shareService';
import { shareRoute } from '../src/daemon/shareRoutes';

const INFO: ShareInfo = { link: null, people: [] };

function fake(opts: { fail?: Error } = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    const rec =
        <T>(name: string, result: T) =>
        async (...args: unknown[]) => {
            calls.push([name, ...args]);
            if (opts.fail) throw opts.fail;
            return result;
        };
    const service: ShareService = {
        info: rec('info', INFO),
        password: rec('password', 'pw'),
        ensureLink: rec('ensureLink', { url: 'https://x', created: true }),
        setLinkSettings: rec('setLinkSettings', INFO),
        removeLink: rec('removeLink', INFO),
        invite: rec('invite', INFO),
        setRole: rec('setRole', INFO),
        removePerson: rec('removePerson', INFO),
    };
    return { service, calls };
}

async function go(service: ShareService | undefined, method: string, route: string, body?: unknown, signedIn = true, log?: (line: string) => void) {
    const url = new URL(`http://localhost${route}`);
    const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await shareRoute(req, url, service, () => signedIn, log);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const PATH_ERROR = 'path must be a path inside My files';

describe('share routes', () => {
    test('each route calls the right method and answers its JSON', async () => {
        const { service, calls } = fake();
        expect(await go(service, 'GET', '/share/info?path=Docs/a.txt')).toEqual({ status: 200, json: INFO as never });
        expect((await go(service, 'GET', '/share/password?path=Docs')).json).toEqual({ password: 'pw' });
        expect((await go(service, 'POST', '/share/link', { path: 'Docs' })).json).toEqual({ url: 'https://x', created: true });
        expect((await go(service, 'POST', '/share/link/settings', { path: 'Docs', password: 'p', expiresAt: null })).status).toBe(200);
        expect((await go(service, 'POST', '/share/link/settings', { path: 'Docs', password: null })).status).toBe(200);
        expect((await go(service, 'DELETE', '/share/link', { path: 'Docs' })).json).toEqual(INFO as never);
        expect((await go(service, 'POST', '/share/invite', { path: 'Docs', emails: ['a@b.co'], role: 'editor' })).status).toBe(200);
        expect((await go(service, 'POST', '/share/role', { path: 'Docs', email: 'a@b.co', role: 'viewer' })).status).toBe(200);
        expect((await go(service, 'DELETE', '/share/person', { path: 'Docs', email: 'a@b.co' })).status).toBe(200);
        expect(calls).toEqual([
            ['info', 'Docs/a.txt'],
            ['password', 'Docs'],
            ['ensureLink', 'Docs'],
            ['setLinkSettings', 'Docs', { password: 'p', expiresAt: null }],
            ['setLinkSettings', 'Docs', { password: null }],
            ['removeLink', 'Docs'],
            ['invite', 'Docs', ['a@b.co'], 'editor'],
            ['setRole', 'Docs', 'a@b.co', 'viewer'],
            ['removePerson', 'Docs', 'a@b.co'],
        ]);
    });

    test('a missing, empty or rooted path is refused before the service', async () => {
        const { service, calls } = fake();
        for (const route of ['/share/info', '/share/info?path=', '/share/info?path=/Docs', '/share/password?path=%2FDocs']) {
            expect([route, await go(service, 'GET', route)]).toEqual([route, { status: 400, json: { error: PATH_ERROR } }]);
        }
        for (const body of [{}, { path: '' }, { path: '/a' }, { path: 3 }]) {
            expect((await go(service, 'POST', '/share/link', body)).json).toEqual({ error: PATH_ERROR });
        }
        expect(calls).toEqual([]);
    });

    test('a bad body is 400 naming the field', async () => {
        const { service, calls } = fake();
        const err = async (method: string, route: string, body: unknown) => {
            const r = await go(service, method, route, body);
            expect(r.status).toBe(400);
            return r.json.error as string;
        };
        expect(await err('POST', '/share/invite', { path: 'a', emails: ['a@b.co'], role: 'admin' })).toContain('role');
        expect(await err('POST', '/share/role', { path: 'a', email: 'a@b.co' })).toContain('role');
        expect(await err('POST', '/share/invite', { path: 'a', emails: [], role: 'viewer' })).toContain('emails');
        expect(await err('POST', '/share/invite', { path: 'a', emails: [1], role: 'viewer' })).toContain('emails');
        expect(await err('POST', '/share/invite', { path: 'a', emails: 'a@b.co', role: 'viewer' })).toContain('emails');
        const fifty = Array.from({ length: 50 }, (_, i) => `u${i}@b.co`);
        expect((await go(service, 'POST', '/share/invite', { path: 'a', emails: fifty, role: 'viewer' })).status).toBe(200);
        expect(await err('POST', '/share/invite', { path: 'a', emails: [...fifty, 'z@b.co'], role: 'viewer' })).toContain('emails');
        expect(await err('POST', '/share/role', { path: 'a', role: 'viewer' })).toContain('email');
        expect(await err('DELETE', '/share/person', { path: 'a', email: '' })).toContain('email');
        expect(await err('POST', '/share/link/settings', { path: 'a', password: 5 })).toContain('password');
        for (const expiresAt of [1.5, '5', 1000, Date.now() - 1000]) {
            expect(await err('POST', '/share/link/settings', { path: 'a', expiresAt })).toContain('expiresAt');
        }
        const future = Date.now() + 86_400_000;
        expect((await go(service, 'POST', '/share/link/settings', { path: 'a', expiresAt: future })).status).toBe(200);
        expect(calls.filter((c) => c[0] === 'setLinkSettings')).toEqual([['setLinkSettings', 'a', { expiresAt: future }]]);
        const bad = await shareRoute(
            new Request('http://localhost/share/link', { method: 'POST', body: 'not json' }),
            new URL('http://localhost/share/link'),
            service,
            () => true,
        );
        expect(bad.status).toBe(400);
    });

    test('a ShareError is 400 with its message; any other failure is 500 without its text', async () => {
        expect(await go(fake({ fail: new ShareError('Not uploaded yet') }).service, 'GET', '/share/info?path=a')).toEqual({
            status: 400,
            json: { error: 'Not uploaded yet' },
        });
        const other = await go(fake({ fail: new Error('secret@x.com') }).service, 'GET', '/share/info?path=a');
        expect(other.status).toBe(500);
        expect(JSON.stringify(other.json)).not.toContain('secret');
    });

    test('a link settings change with nothing to change is refused', async () => {
        const { service, calls } = fake();
        expect(await go(service, 'POST', '/share/link/settings', { path: 'Docs' })).toEqual({ status: 400, json: { error: 'Nothing to change' } });
        expect(calls).toEqual([]);
    });

    test('expiresAt must be within 10 years', async () => {
        const { service, calls } = fake();
        const year = 365 * 86_400_000;
        for (const expiresAt of [Date.now() + 11 * year, 8.64e15, Number.MAX_SAFE_INTEGER]) {
            expect(await go(service, 'POST', '/share/link/settings', { path: 'a', expiresAt })).toEqual({
                status: 400,
                json: { error: 'expiresAt must be within 10 years' },
            });
        }
        expect(calls).toEqual([]);
        const nineYears = Date.now() + 9 * year;
        expect((await go(service, 'POST', '/share/link/settings', { path: 'a', expiresAt: nineYears })).status).toBe(200);
        expect(calls).toEqual([['setLinkSettings', 'a', { expiresAt: nineYears }]]);
    });

    test("a failure other than a refusal logs only the error's class, never its text", async () => {
        const lines: string[] = [];
        const log = (line: string) => lines.push(line);
        const res = await go(fake({ fail: new TypeError('secret@x.com: s3cret') }).service, 'GET', '/share/info?path=a', undefined, true, log);
        expect(res).toEqual({ status: 500, json: { error: 'Sharing failed' } });
        expect(lines).toEqual(['Sharing failed: TypeError']);
        // A refusal, or a bad request, is the user's to read, and logs nothing
        await go(fake({ fail: new ShareError('Not uploaded yet') }).service, 'GET', '/share/info?path=a', undefined, true, log);
        await go(fake().service, 'POST', '/share/role', { path: 'a', role: 'viewer' }, true, log);
        expect(lines).toEqual(['Sharing failed: TypeError']);
    });

    test('a wrong method is 405, no service is 404, signed out is 400', async () => {
        const { service, calls } = fake();
        expect((await go(service, 'POST', '/share/info?path=a')).status).toBe(405);
        expect((await go(service, 'GET', '/share/link')).status).toBe(405);
        expect((await go(service, 'GET', '/share/invite')).status).toBe(405);
        expect((await go(service, 'PUT', '/share/person', { path: 'a', email: 'x' })).status).toBe(405);
        expect((await go(service, 'GET', '/share/nope?path=a')).status).toBe(404);
        expect((await go(undefined, 'GET', '/share/info?path=a')).status).toBe(404);
        expect(await go(service, 'GET', '/share/info?path=a', undefined, false)).toEqual({
            status: 400,
            json: { error: 'Sign in to share' },
        });
        expect(calls).toEqual([]);
    });
});
