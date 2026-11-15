import { describe, expect, test } from 'bun:test';

import { createShareService, ShareError, type ShareService } from '../src/daemon/shareService';

const EXPIRY = new Date('2027-01-02T03:04:05Z');

function makeFake(initial: any) {
    const calls: Array<{ fn: string; args: any[] }> = [];
    let state = initial;
    let failWith: unknown = null;
    const sdk: any = {
        async getSharingInfo(...args: any[]) {
            calls.push({ fn: 'getSharingInfo', args });
            if (failWith) throw failWith;
            return state;
        },
        async shareNode(...args: any[]) {
            calls.push({ fn: 'shareNode', args });
            if (failWith) throw failWith;
            const s = args[1];
            const next = state ?? { protonInvitations: [], nonProtonInvitations: [], members: [], editorsCanShare: false };
            if (s.urlAccess) {
                const o = s.urlAccess === true ? { role: 'viewer' } : s.urlAccess;
                next.urlAccess = {
                    uid: 'u',
                    url: 'https://drive.proton.me/urls/X#abc',
                    role: o.role,
                    customPassword: o.customPassword,
                    expirationTime: o.expiration,
                };
            }
            state = next;
            return state;
        },
        async unshareNode(...args: any[]) {
            calls.push({ fn: 'unshareNode', args });
            if (failWith) throw failWith;
            return state;
        },
    };
    return {
        sdk,
        calls,
        fail(e: unknown) {
            failWith = e;
        },
    };
}

const shared = (over: any = {}) => ({
    protonInvitations: [{ inviteeEmail: 'inv@x.co', role: 'viewer' }],
    nonProtonInvitations: [{ inviteeEmail: 'ext@x.co', role: 'editor', state: 'pending' }],
    members: [{ inviteeEmail: 'mem@x.co', role: 'admin' }],
    urlAccess: { uid: 'u', url: 'https://drive.proton.me/urls/X#abc', role: 'viewer', customPassword: 's3cret', expirationTime: EXPIRY },
    editorsCanShare: false,
    ...over,
});

function setup(initial: any, nodeFor?: any) {
    const fake = makeFake(initial);
    const logs: Array<{ action: 'share'; localRelPath: string; details: string }> = [];
    const svc = createShareService({
        sdk: fake.sdk,
        nodeFor: nodeFor ?? (() => ({ uid: 'node1', name: 'a.txt' })),
        logActivity: (e) => logs.push(e),
        now: () => 1000,
    });
    return { svc, fake, logs };
}

const rejects = async (p: Promise<unknown>) => {
    try {
        await p;
    } catch (e) {
        return e as Error;
    }
    throw new Error('did not reject');
};

describe('ShareService', () => {
    test('info maps the link and people', async () => {
        const { svc } = setup(shared());
        const info = await svc.info('a.txt');
        expect(info.link).toEqual({ url: 'https://drive.proton.me/urls/X#abc', hasPassword: true, expiresAt: EXPIRY.getTime(), role: 'viewer' });
        expect(info.people).toEqual([
            { email: 'mem@x.co', role: 'editor', state: 'member' },
            { email: 'inv@x.co', role: 'viewer', state: 'invited' },
            { email: 'ext@x.co', role: 'editor', state: 'invited-not-proton' },
        ]);
        const none = setup(undefined);
        expect(await none.svc.info('a.txt')).toEqual({ link: null, people: [] });
    });

    test('info never carries the password', async () => {
        const { svc } = setup(shared());
        expect(JSON.stringify(await svc.info('a.txt'))).not.toContain('s3cret');
    });

    test("password returns the link's password, or null", async () => {
        expect(await setup(shared()).svc.password('a.txt')).toBe('s3cret');
        expect(await setup(shared({ urlAccess: { ...shared().urlAccess, customPassword: undefined } })).svc.password('a.txt')).toBeNull();
        expect(await setup(undefined).svc.password('a.txt')).toBeNull();
    });

    test('ensureLink returns an existing link unchanged', async () => {
        const { svc, fake, logs } = setup(shared());
        expect(await svc.ensureLink('a.txt')).toEqual({ url: 'https://drive.proton.me/urls/X#abc', created: false });
        expect(fake.calls.some((c) => c.fn === 'shareNode')).toBe(false);
        expect(logs).toEqual([]);
    });

    test('ensureLink creates a viewer link with no password or expiry', async () => {
        const { svc, fake } = setup(undefined);
        const r = await svc.ensureLink('a.txt');
        expect(r.created).toBe(true);
        expect(r.url).toContain('drive.proton.me');
        const share = fake.calls.filter((c) => c.fn === 'shareNode');
        expect(share.length).toBe(1);
        expect(share[0].args).toEqual(['node1', { urlAccess: { role: 'viewer' } }]);
    });

    test("refuses an item that isn't uploaded yet, or is hidden", async () => {
        const { svc, fake, logs } = setup(shared(), () => ({ refused: 'Not uploaded yet' }));
        const calls: Array<() => Promise<unknown>> = [
            () => svc.info('a'),
            () => svc.password('a'),
            () => svc.ensureLink('a'),
            () => svc.setLinkSettings('a', { password: 'x' }),
            () => svc.removeLink('a'),
            () => svc.invite('a', ['a@b.co'], 'viewer'),
            () => svc.setRole('a', 'a@b.co', 'editor'),
            () => svc.removePerson('a', 'a@b.co'),
        ];
        for (const c of calls) {
            const e = await rejects(c());
            expect(e).toBeInstanceOf(ShareError);
            expect(e.message).toBe('Not uploaded yet');
        }
        expect(fake.calls).toEqual([]);
        expect(logs).toEqual([]);
    });

    test('an SDK failure is one plain error and nothing else happens', async () => {
        const { svc, fake, logs } = setup(shared());
        fake.fail(new TypeError('fetch failed'));
        let e = await rejects(svc.removeLink('a.txt'));
        expect(e).toBeInstanceOf(ShareError);
        expect(e.message).toBe('Proton Drive is offline: try again when you are connected');
        fake.fail(new Error('Nope'));
        e = await rejects(svc.info('a.txt'));
        expect(e).toBeInstanceOf(ShareError);
        expect(e.message).toBe('Proton Drive refused: Nope');
        expect(logs).toEqual([]);
    });

    test('setLinkSettings without a link is refused', async () => {
        const { svc, fake } = setup(undefined);
        const e = await rejects(svc.setLinkSettings('a.txt', { password: 'x' }));
        expect(e).toBeInstanceOf(ShareError);
        expect(e.message).toBe('Turn the link on first');
        expect(fake.calls.some((c) => c.fn === 'shareNode')).toBe(false);
    });

    test('setLinkSettings changes only what it is given', async () => {
        const sent = (fake: ReturnType<typeof makeFake>) => fake.calls.filter((c) => c.fn === 'shareNode').at(-1)!.args[1].urlAccess;

        let t = setup(shared());
        await t.svc.setLinkSettings('a.txt', { password: 'new' });
        expect(sent(t.fake)).toEqual({ role: 'viewer', customPassword: 'new', expiration: EXPIRY });

        t = setup(shared());
        await t.svc.setLinkSettings('a.txt', { expiresAt: 5_000_000_000_000 });
        expect(sent(t.fake)).toEqual({ role: 'viewer', customPassword: 's3cret', expiration: new Date(5_000_000_000_000) });

        t = setup(shared());
        await t.svc.setLinkSettings('a.txt', { password: null });
        expect(sent(t.fake)).toEqual({ role: 'viewer', customPassword: undefined, expiration: EXPIRY });

        t = setup(shared());
        await t.svc.setLinkSettings('a.txt', { expiresAt: null });
        expect(sent(t.fake)).toEqual({ role: 'viewer', customPassword: 's3cret', expiration: undefined });
    });

    test('invite checks every address first', async () => {
        const { svc, fake } = setup(shared());
        const e = await rejects(svc.invite('a.txt', ['a@b.co', 'not-an-email'], 'viewer'));
        expect(e).toBeInstanceOf(ShareError);
        expect(e.message).toBe('Not a valid email address: not-an-email');
        expect(fake.calls).toEqual([]);
        await svc.invite('a.txt', ['a@b.co', 'c@d.co'], 'editor');
        const s = fake.calls.find((c) => c.fn === 'shareNode')!;
        expect(s.args[1]).toEqual({
            users: [
                { email: 'a@b.co', role: 'editor' },
                { email: 'c@d.co', role: 'editor' },
            ],
        });
    });

    test('removePerson and removeLink unshare just that', async () => {
        const { svc, fake } = setup(shared());
        await svc.removePerson('a.txt', 'mem@x.co');
        await svc.removeLink('a.txt');
        const u = fake.calls.filter((c) => c.fn === 'unshareNode');
        expect(u[0].args).toEqual(['node1', { users: ['mem@x.co'] }]);
        expect(u[1].args).toEqual(['node1', { urlAccess: 'remove' }]);
    });

    test('setRole sends just that person with the new role', async () => {
        const { svc, fake } = setup(shared());
        await svc.setRole('a.txt', 'mem@x.co', 'viewer');
        expect(fake.calls.find((c) => c.fn === 'shareNode')!.args[1]).toEqual({ users: [{ email: 'mem@x.co', role: 'viewer' }] });
    });

    test('activity says what was shared without passwords or addresses', async () => {
        const { svc, logs } = setup(undefined);
        await svc.ensureLink('a.txt');
        await svc.setLinkSettings('a.txt', { password: 's3cret' });
        await svc.removeLink('a.txt');
        await svc.invite('a.txt', ['a@b.co', 'c@d.co'], 'viewer');
        await svc.setRole('a.txt', 'a@b.co', 'editor');
        await svc.removePerson('a.txt', 'a@b.co');
        expect(logs.map((l) => l.details)).toEqual([
            'Shared a.txt with a link',
            'Changed the link to a.txt',
            'Stopped sharing the link to a.txt',
            'Invited 2 people to a.txt',
            "Changed someone's access to a.txt",
            "Removed someone's access to a.txt",
        ]);
        for (const l of logs) {
            expect(l.action).toBe('share');
            expect(l.localRelPath).toBe('a.txt');
            expect(l.details).not.toContain('@');
            expect(l.details).not.toContain('s3cret');
        }
    });
});

void (null as unknown as ShareService);
