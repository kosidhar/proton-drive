import { describe, expect, test } from 'bun:test';
import { NodeType } from '@protontech/drive-sdk';

import { createShareService, ListCancelled, ShareError, type ShareInfo, type ShareService } from '../src/daemon/shareService';
import { shareRoute } from '../src/daemon/shareRoutes';
import type { SharedWithMeService } from '../src/daemon/sharedWithMe';
import { refuseOnTcp } from '../src/daemon/tcpRefusals';

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
        list: rec('list', []),
        info: rec('info', INFO),
        password: rec('password', 'pw'),
        ensureLink: rec('ensureLink', { url: 'https://x', created: true }),
        setLinkSettings: rec('setLinkSettings', INFO),
        removeLink: rec('removeLink', INFO),
        invite: rec('invite', INFO),
        setRole: rec('setRole', INFO),
        removePerson: rec('removePerson', INFO),
        stopSharing: rec('stopSharing', INFO),
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
        expect(await go(service, 'GET', '/share/list')).toEqual({ status: 200, json: { items: [] } });
        expect(await go(service, 'DELETE', '/share/all', { path: 'Documents/report.pdf', uid: 'vol~n1' })).toEqual({ status: 200, json: INFO as never });
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
            ['list', expect.any(AbortSignal)],
            ['stopSharing', 'Documents/report.pdf', 'vol~n1'],
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
        for (const body of [{}, { path: '' }, { path: '/a' }, { path: 3 }]) {
            expect((await go(service, 'DELETE', '/share/all', body)).json).toEqual({ error: PATH_ERROR });
        }
        expect(calls).toEqual([]);
    });

    // #260: stopping sharing names the item that was listed
    test('stopping sharing without the listed item\'s uid is a 400 before the service', async () => {
        const { service, calls } = fake();
        const UID_ERROR = 'uid must be the uid of the listed item';
        for (const body of [{ path: 'a' }, { path: 'a', uid: '' }, { path: 'a', uid: 3 }, { path: 'a', uid: null }]) {
            expect([body, await go(service, 'DELETE', '/share/all', body)]).toEqual([body, { status: 400, json: { error: UID_ERROR } }]);
        }
        expect(calls).toEqual([]);
    });

    test('listing while signed out is Sign in to share', async () => {
        const { service, calls } = fake();
        expect(await go(service, 'GET', '/share/list', undefined, false)).toEqual({ status: 400, json: { error: 'Sign in to share' } });
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

    // #257: the app gave up on the list (its request is gone), and the list stops: nothing for anyone to read, nothing logged
    test("the list is given the request's signal, and a list cancelled is 400 Cancelled, logging nothing", async () => {
        const lines: string[] = [];
        const gone = new AbortController();
        let given: AbortSignal | undefined;
        const service = {
            list: async (signal?: AbortSignal) => {
                given = signal;
                gone.abort();
                if (signal?.aborted) throw new ListCancelled();
                return [];
            },
        } as unknown as ShareService;
        const url = new URL('http://localhost/share/list');
        const req = new Request(url, { signal: gone.signal });
        const res = await shareRoute(req, url, service, () => true, (line) => lines.push(line));
        expect(given).toBe(req.signal);
        expect([res.status, await res.json()]).toEqual([400, { error: 'Cancelled' }]);
        expect(lines).toEqual([]);
    });

    test('GET /share/list includes kind for files and folders and omits it for missing nodes', async () => {
        const nodes: any[] = [
            { uid: 'f1', name: { ok: true, value: 'Makefile' }, type: NodeType.File },
            { uid: 'd1', name: { ok: true, value: 'v1.2 notes' }, type: NodeType.Folder },
            { missingUid: 'm1' },
        ];
        const service = createShareService({
            sdk: {
                async *iterateSharedNodeUids() {
                    yield* ['f1', 'd1', 'm1'];
                },
                async *iterateNodes() {
                    yield* nodes;
                },
                async getSharingInfo() {
                    return { members: [], protonInvitations: [], nonProtonInvitations: [], editorsCanShare: false };
                },
                shareNode: async () => {
                    throw new Error('unused');
                },
                unshareNode: async () => {
                    throw new Error('unused');
                },
            } as never,
            nodeFor: () => ({ refused: 'unused' }),
            placeOf: (uid) =>
                uid === 'f1'
                    ? { relPath: 'Makefile', hidden: false }
                    : uid === 'd1'
                      ? { relPath: 'v1.2 notes', hidden: false }
                      : null,
            logActivity() {},
            now: () => 1000,
        });
        const res = await go(service, 'GET', '/share/list');
        expect(res.status).toBe(200);
        const items = res.json.items as Array<Record<string, unknown>>;
        expect(items.map((i) => ({ uid: i.uid, name: i.name, kind: i.kind }))).toEqual([
            { uid: 'f1', name: 'Makefile', kind: 'file' },
            { uid: 'd1', name: 'v1.2 notes', kind: 'folder' },
            { uid: 'm1', name: 'An item', kind: undefined },
        ]);
        expect('kind' in items[2]).toBe(false);
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

describe('shared with me routes', () => {
    const LIST = { invitations: [], items: [] };
    function fakeWithMe(fail?: Error) {
        const calls: Array<[string, ...unknown[]]> = [];
        const rec =
            <T>(name: string, result: T) =>
            async (...args: unknown[]) => {
                calls.push([name, ...args]);
                if (fail) throw fail;
                return result;
            };
        const withMe: SharedWithMeService = {
            list: rec('list', LIST),
            accept: rec('accept', undefined),
            decline: rec('decline', undefined),
            leave: rec('leave', undefined),
            openUrl: rec('openUrl', { url: 'https://x/y' }),
            download: rec('download', { path: '/p' }),
        };
        return { withMe, calls };
    }
    async function goWith(withMe: SharedWithMeService | undefined, method: string, route: string, body?: unknown, signedIn = true) {
        const url = new URL(`http://localhost${route}`);
        const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
        const res = await shareRoute(req, url, undefined, () => signedIn, undefined, withMe);
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }

    test('each route maps to the service and returns its JSON', async () => {
        const { withMe, calls } = fakeWithMe();
        expect(await goWith(withMe, 'GET', '/share/with-me')).toEqual({ status: 200, json: LIST });
        expect(await goWith(withMe, 'POST', '/share/with-me/accept', { invitationUid: 'i1' })).toEqual({ status: 200, json: { ok: true } });
        expect(await goWith(withMe, 'POST', '/share/with-me/decline', { invitationUid: 'i2' })).toEqual({ status: 200, json: { ok: true } });
        expect(await goWith(withMe, 'POST', '/share/with-me/leave', { uid: 'n1' })).toEqual({ status: 200, json: { ok: true } });
        expect(await goWith(withMe, 'POST', '/share/with-me/open-url', { uid: 'n2' })).toEqual({ status: 200, json: { url: 'https://x/y' } });
        expect(calls).toEqual([['list', expect.any(AbortSignal)], ['accept', 'i1'], ['decline', 'i2'], ['leave', 'n1'], ['openUrl', 'n2']]);
    });

    test('a missing uid is a 400 before the service', async () => {
        const { withMe, calls } = fakeWithMe();
        for (const [route, field] of [['accept', 'invitationUid'], ['decline', 'invitationUid'], ['leave', 'uid'], ['open-url', 'uid']] as const) {
            for (const body of [{}, { [field]: '' }, { [field]: 3 }]) {
                const r = await goWith(withMe, 'POST', `/share/with-me/${route}`, body);
                expect([route, r.status, String(r.json.error)]).toEqual([route, 400, expect.stringContaining('uid')]);
            }
        }
        expect(calls).toEqual([]);
    });

    test('a ShareError is 400 with its message, signed out is refused, and the routes are absent without the service', async () => {
        expect(await goWith(fakeWithMe(new ShareError('Nope')).withMe, 'POST', '/share/with-me/leave', { uid: 'n' })).toEqual({ status: 400, json: { error: 'Nope' } });
        const { withMe, calls } = fakeWithMe();
        expect((await goWith(withMe, 'GET', '/share/with-me', undefined, false)).status).toBe(400);
        expect(calls).toEqual([]);
        expect((await goWith(undefined, 'GET', '/share/with-me')).status).toBe(404);
        expect((await goWith(withMe, 'GET', '/share/with-me/accept')).status).toBe(405);
    });

    test('the acting routes are refused on TCP', async () => {
        for (const route of ['accept', 'decline', 'leave', 'open-url']) {
            const res = refuseOnTcp(new Request(`http://127.0.0.1:49152/share/with-me/${route}`, { method: 'POST', body: '{}' }));
            expect([route, res?.status]).toEqual([route, 403]);
        }
    });
});
