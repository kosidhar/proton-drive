import { describe, expect, mock, test } from 'bun:test';

import { ValidationError } from '@protontech/drive-sdk/errors';
import { ErrorCode } from '@protontech/drive-sdk/internal/apiService/errorCodes';
import { SharingManagement } from '@protontech/drive-sdk/internal/sharing/sharingManagement';

import { createShareService, ShareError, type ShareService } from '../src/daemon/shareService';

const EXPIRY = new Date('2027-01-02T03:04:05Z');
// A link's URL ends with the 12-character password the SDK generates for it
const LINK_URL = 'https://drive.proton.me/urls/X#abcdefghijkl';

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
                    url: LINK_URL,
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
    urlAccess: { uid: 'u', url: LINK_URL, role: 'viewer', customPassword: 's3cret', expirationTime: EXPIRY },
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
        expect(info.link).toEqual({ url: LINK_URL, hasPassword: true, expiresAt: EXPIRY.getTime(), role: 'viewer' });
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
        expect(await svc.ensureLink('a.txt')).toEqual({ url: LINK_URL, created: false });
        expect(fake.calls.some((c) => c.fn === 'shareNode')).toBe(false);
        expect(logs).toEqual([]);
    });

    test('ensureLink creates a viewer link with no password or expiry', async () => {
        const { svc, fake } = setup(undefined);
        const r = await svc.ensureLink('a.txt');
        expect(r.created).toBe(true);
        expect(r.url).toContain('drive.proton.me');
        // First a look at the item's real sharing (which writes no link), then the link
        expect(fake.calls.filter((c) => c.fn === 'shareNode').map((c) => c.args)).toEqual([
            ['node1', {}],
            ['node1', { urlAccess: { role: 'viewer' } }],
        ]);
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

    test('setLinkSettings on an expired link needs the expiry set too', async () => {
        const expired = () => shared({ urlAccess: { ...shared().urlAccess, expirationTime: new Date(500) } });
        let t = setup(expired());
        const e = await rejects(t.svc.setLinkSettings('a.txt', { password: 'new' }));
        expect(e).toBeInstanceOf(ShareError);
        expect(e.message).toBe('This link has expired: set a new expiry date, or remove the expiry, to change it');
        expect(t.fake.calls.some((c) => c.fn === 'shareNode')).toBe(false);

        t = setup(expired());
        await t.svc.setLinkSettings('a.txt', { password: 'new', expiresAt: null });
        expect(t.fake.calls.find((c) => c.fn === 'shareNode')!.args[1].urlAccess).toEqual({ role: 'viewer', customPassword: 'new', expiration: undefined });

        t = setup(expired());
        await t.svc.setLinkSettings('a.txt', { password: 'new', expiresAt: 5_000_000_000_000 });
        expect(t.fake.calls.find((c) => c.fn === 'shareNode')!.args[1].urlAccess.expiration).toEqual(new Date(5_000_000_000_000));
    });

    test('setRole and removePerson act only on someone already on the list', async () => {
        const { svc, fake, logs } = setup(shared());
        for (const c of [() => svc.setRole('a.txt', 'stranger@x.co', 'editor'), () => svc.removePerson('a.txt', 'stranger@x.co')]) {
            const e = await rejects(c());
            expect(e).toBeInstanceOf(ShareError);
            expect(e.message).toBe("That person doesn't have access to this item");
        }
        expect(fake.calls.some((c) => c.fn === 'shareNode' || c.fn === 'unshareNode')).toBe(false);
        expect(logs).toEqual([]);
        await svc.setRole('a.txt', 'INV@x.co', 'editor');
        await svc.removePerson('a.txt', 'Ext@X.co');
        expect(fake.calls.find((c) => c.fn === 'shareNode')!.args[1]).toEqual({ users: [{ email: 'inv@x.co', role: 'editor' }] });
        expect(fake.calls.find((c) => c.fn === 'unshareNode')!.args[1]).toEqual({ users: ['ext@x.co'] });
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
        const { svc, logs } = setup(shared({ urlAccess: undefined }));
        await svc.ensureLink('a.txt');
        await svc.setLinkSettings('a.txt', { password: 's3cret' });
        await svc.removeLink('a.txt');
        await svc.invite('a.txt', ['a@b.co', 'c@d.co'], 'viewer');
        await svc.setRole('a.txt', 'mem@x.co', 'editor');
        await svc.removePerson('a.txt', 'mem@x.co');
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

// Finding 1 of the PR 1 review: the SDK keeps nodes in a cache on disk and learns of a share made elsewhere only from its
// events, so getSharingInfo can say "not shared" while the item has a link. Asking shareNode for a link then UPDATES that
// link with the settings given, which replace its own: its password and expiry were wiped.
describe('Copy Link while the SDK has not heard of a link made elsewhere', () => {
    test('the link the share really has comes back unchanged, and nothing writes a link', async () => {
        const { svc, fake, logs } = setup(undefined);
        const real = shared();
        fake.sdk.shareNode = async (...args: any[]) => {
            fake.calls.push({ fn: 'shareNode', args });
            return real; // the share exists: shareNode refreshed the node and found it, with its link
        };
        expect(await svc.ensureLink('a.txt')).toEqual({ url: LINK_URL, created: false });
        const writes = fake.calls.filter((c) => c.fn === 'shareNode');
        expect(writes.map((c) => c.args)).toEqual([['node1', {}]]);
        expect(fake.calls.some((c) => c.fn === 'shareNode' && c.args[1].urlAccess !== undefined)).toBe(false);
        expect(logs).toEqual([]);
    });

    test("through the SDK's own sharing code: the link's password and expiry are never rewritten", async () => {
        let stale = true; // the cached node doesn't know the share made on the web
        const webLink = {
            uid: 'shareId~urlId',
            url: LINK_URL,
            creationTime: new Date('2026-11-01'),
            role: 'viewer',
            customPassword: 'webSecret',
            expirationTime: new Date('2030-01-01'),
            creatorEmail: 'me@proton.me',
        };
        const updateURLAccess = mock(async () => {});
        const createURLAccess = mock(async () => ({ uid: 'new', publicUrl: 'https://drive.proton.me/urls/NEW' }));
        const apiService = {
            createStandardShare: mock(async () => {
                throw new ValidationError('Share already exists', ErrorCode.ALREADY_EXISTS);
            }),
            getShareInvitations: async () => [],
            getShareExternalInvitations: async () => [],
            getShareMembers: async () => [],
            getURLAccess: async () => webLink,
            updateURLAccess,
            createURLAccess,
        };
        const nodesService = {
            getNode: async (uid: string) => ({ uid, parentUid: 'p', ...(stale ? {} : { shareId: 'shareId' }) }),
            getNodeKeys: async () => ({ key: 'k' }),
            getNodePrivateAndSessionKeys: async () => ({}),
            getRootNodeEmailKey: async () => ({ email: 'me@proton.me', addressKey: 'ak', addressId: 'a' }),
            notifyNodeChanged: async () => {
                stale = false;
            },
        };
        const sharesService = {
            loadEncryptedShare: async () => ({ creatorEmail: 'me@proton.me', passphraseSessionKey: 's', editorsCanShare: false }),
            getRootIDs: async () => ({ volumeId: 'vol' }),
        };
        const cryptoService = {
            generateShareKeys: async () => ({ shareKey: { encrypted: 'e', decrypted: { passphraseSessionKey: 's' } } }),
            decryptShare: async () => ({ passphraseSessionKey: 's' }),
            decryptURLAccess: async (u: unknown) => u,
            encryptURLAccess: async () => ({ crypto: 'c', srp: 's' }),
            generatePublicLinkPassword: async () => 'newgenerated',
        };
        const quiet = { debug() {}, info() {}, warn() {}, error() {} };
        const mgmt = new SharingManagement(
            quiet,
            apiService as never,
            { hasSharedByMeNodeUidsLoaded: async () => false } as never,
            cryptoService as never,
            { hasProtonAccount: async () => true } as never,
            sharesService as never,
            nodesService as never,
        );
        const logs: string[] = [];
        const svc = createShareService({
            sdk: {
                getSharingInfo: (uid) => mgmt.getSharingInfo(uid as string),
                shareNode: (uid, s) => mgmt.shareNode(uid as string, s),
                unshareNode: (uid, s) => mgmt.unshareNode(uid as string, s),
            },
            nodeFor: () => ({ uid: 'vol~node', name: 'report.pdf' }),
            logActivity: (e) => logs.push(e.details),
            now: () => new Date('2026-11-14T12:00:00Z').getTime(),
        });

        expect(await svc.ensureLink('Docs/report.pdf')).toEqual({ url: LINK_URL, created: false });
        expect(updateURLAccess).not.toHaveBeenCalled();
        expect(createURLAccess).not.toHaveBeenCalled();
        expect(logs).toEqual([]);
    });
});

// Finding 2: an operation reads the item's sharing and then writes it whole, so two at once undid one another
describe('share operations on one item run one at a time', () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));

    function linkFake() {
        let link: any = { uid: 'u', url: LINK_URL, role: 'viewer', customPassword: undefined, expirationTime: undefined };
        const result = () => ({ protonInvitations: [], nonProtonInvitations: [], members: [], urlAccess: { ...link }, editorsCanShare: false });
        const sdk: any = {
            async getSharingInfo() {
                await tick(); // several API calls in reality
                return result();
            },
            async shareNode(_uid: string, s: any) {
                await tick();
                link = { ...link, customPassword: s.urlAccess.customPassword, expirationTime: s.urlAccess.expiration };
                return result();
            },
            async unshareNode() {
                return result();
            },
        };
        return { sdk, link: () => link };
    }

    test('a password and an expiry set at once both stay', async () => {
        const fake = linkFake();
        const svc = createShareService({ sdk: fake.sdk, nodeFor: () => ({ uid: 'n', name: 'a.txt' }), logActivity() {}, now: () => 1000 });
        const future = Date.now() + 7 * 86_400_000;
        await Promise.all([svc.setLinkSettings('a.txt', { password: 'pw' }), svc.setLinkSettings('a.txt', { expiresAt: future })]);
        expect(fake.link().customPassword).toBe('pw');
        expect(fake.link().expirationTime).toEqual(new Date(future));
    });

    test('a failed operation lets the next one on that item go', async () => {
        const fake = linkFake();
        let failNext = true;
        const getSharingInfo = fake.sdk.getSharingInfo;
        fake.sdk.getSharingInfo = async () => {
            if (failNext) {
                failNext = false;
                throw new Error('Nope');
            }
            return getSharingInfo();
        };
        const svc = createShareService({ sdk: fake.sdk, nodeFor: () => ({ uid: 'n', name: 'a.txt' }), logActivity() {}, now: () => 1000 });
        const [first, second] = await Promise.allSettled([svc.setLinkSettings('a.txt', { password: 'pw' }), svc.info('a.txt')]);
        expect(first.status).toBe('rejected');
        expect(second).toMatchObject({ status: 'fulfilled', value: { link: { url: LINK_URL } } });
    });

    test('operations on different items run side by side', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const sdk: any = {
            async getSharingInfo(uid: string) {
                if (uid === 'slow') await gate;
                return undefined;
            },
        };
        const svc = createShareService({ sdk, nodeFor: (p) => ({ uid: p, name: p }), logActivity() {}, now: () => 1000 });
        const slow = svc.info('slow');
        const fast = await Promise.race([svc.info('fast'), Bun.sleep(500).then(() => 'held up')]);
        expect(fast).toEqual({ link: null, people: [] });
        release();
        expect(await slow).toEqual({ link: null, people: [] });
    });

    test('a second operation on an item waits for the first to finish', async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let first = true;
        const sdk: any = {
            async getSharingInfo() {
                const mine = first;
                first = false;
                order.push(mine ? 'first starts' : 'second starts');
                if (mine) await gate;
                order.push(mine ? 'first ends' : 'second ends');
                return undefined;
            },
        };
        const svc = createShareService({ sdk, nodeFor: () => ({ uid: 'n', name: 'a' }), logActivity() {}, now: () => 1000 });
        const a = svc.info('a');
        const b = svc.info('a');
        await Bun.sleep(20);
        expect(order).toEqual(['first starts']);
        release();
        await Promise.all([a, b]);
        expect(order).toEqual(['first starts', 'first ends', 'second starts', 'second ends']);
    });
});

void (null as unknown as ShareService);
