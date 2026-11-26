import { describe, expect, test } from 'bun:test';
import { MemberRole, NodeType } from '@protontech/drive-sdk';

import { ShareError } from '../src/daemon/shareService';
import { createSharedWithMeService } from '../src/daemon/sharedWithMe';

const DOC = 'application/vnd.proton.doc';
const SHEET = 'application/vnd.proton.sheet';

const ok = <T>(value: T) => ({ ok: true as const, value });
const bad = (claimedAuthor?: string | null) => ({ ok: false as const, error: { claimedAuthor, error: 'Signature does not match' } });

function invitation(uid: string, over: Record<string, unknown> = {}, node: Record<string, unknown> = {}) {
    return {
        uid,
        invitationTime: new Date('2026-03-01T00:00:00Z'),
        addedByEmail: ok('ann@proton.me'),
        inviteeEmail: 'me@proton.me',
        role: MemberRole.Viewer,
        node: { uid: `n-${uid}`, name: ok(`Name ${uid}`), type: NodeType.File, ...node },
        ...over,
    };
}

function node(uid: string, over: Record<string, unknown> = {}) {
    return {
        uid,
        name: ok(`Name ${uid}`),
        type: NodeType.File,
        directRole: MemberRole.Viewer,
        membership: { role: MemberRole.Editor, inviteTime: new Date('2026-03-01T00:00:00Z'), sharedBy: ok('ann@proton.me') },
        ...over,
    };
}

function make(opts: { invitations?: any[]; nodes?: any[]; failWith?: Error; urlFails?: boolean } = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    const logs: Array<{ action: string; localRelPath: string; details: string }> = [];
    const nodes = opts.nodes ?? [];
    const sdk: any = {
        async *iterateInvitations() {
            yield* opts.invitations ?? [];
        },
        async *iterateSharedWithMeNodeUids() {
            for (const n of nodes) yield n.uid;
        },
        async *iterateNodes(uids: string[]) {
            for (const uid of uids) {
                const n = nodes.find((x) => x.uid === uid);
                yield n && !n.fails ? n : { missingUid: uid };
            }
        },
        async acceptInvitation(uid: string) {
            calls.push(['accept', uid]);
            if (opts.failWith) throw opts.failWith;
        },
        async rejectInvitation(uid: string) {
            calls.push(['reject', uid]);
            if (opts.failWith) throw opts.failWith;
        },
        async leaveSharedNode(uid: string) {
            calls.push(['leave', uid]);
            if (opts.failWith) throw opts.failWith;
        },
        experimental: {
            async getNodeUrl(uid: string) {
                if (opts.urlFails) throw new Error('no url');
                return `https://drive.proton.me/urls/${uid}`;
            },
        },
    };
    const service = createSharedWithMeService({ sdk, logActivity: (e) => logs.push(e), now: () => 1000 });
    return { service, calls, logs };
}

describe('shared with me: the list', () => {
    test('lists invitations newest first, with from/verified/kind/role', async () => {
        const { service } = make({
            invitations: [
                invitation('old', { invitationTime: new Date('2026-01-01T00:00:00Z') }),
                invitation('unverified', { invitationTime: new Date('2026-03-01T00:00:00Z'), addedByEmail: bad('x@proton.me'), role: MemberRole.Editor }, { type: NodeType.Folder }),
                invitation('anon', { invitationTime: new Date('2026-02-01T00:00:00Z'), addedByEmail: bad(), role: MemberRole.Admin }),
            ],
        });
        const { invitations } = await service.list();
        expect(invitations).toEqual([
            { invitationUid: 'unverified', name: 'Name unverified', kind: 'folder', from: 'x@proton.me', fromVerified: false, role: 'editor', invitedAt: Date.parse('2026-03-01T00:00:00Z') },
            { invitationUid: 'anon', name: 'Name anon', kind: 'file', from: null, fromVerified: false, role: 'admin', invitedAt: Date.parse('2026-02-01T00:00:00Z') },
            { invitationUid: 'old', name: 'Name old', kind: 'file', from: 'ann@proton.me', fromVerified: true, role: 'viewer', invitedAt: Date.parse('2026-01-01T00:00:00Z') },
        ]);
    });

    test("an invitation whose name can't be decrypted has name null", async () => {
        const { service } = make({ invitations: [invitation('i', {}, { name: { ok: false, error: new Error('decrypt') } })] });
        expect((await service.list()).invitations[0]!.name).toBeNull();
    });

    test('kind is doc/sheet from the Proton Docs/Sheets media types, else file/folder by type', async () => {
        const { service } = make({
            invitations: [invitation('d', {}, { mediaType: DOC }), invitation('s', {}, { mediaType: SHEET }), invitation('f', {}, { type: NodeType.Folder }), invitation('p', {}, { mediaType: 'text/plain' })],
            nodes: [node('nd', { mediaType: DOC }), node('ns', { mediaType: SHEET }), node('nf', { type: NodeType.Folder }), node('np', { mediaType: 'text/plain' })],
        });
        const { invitations, items } = await service.list();
        expect(Object.fromEntries(invitations.map((i) => [i.invitationUid, i.kind]))).toEqual({ d: 'doc', s: 'sheet', f: 'folder', p: 'file' });
        expect(Object.fromEntries(items.map((i) => [i.uid, i.kind]))).toEqual({ nd: 'doc', ns: 'sheet', nf: 'folder', np: 'file' });
    });

    test('items come from iterateSharedWithMeNodeUids, newest shared first, with sharedBy/sharedAt/role from membership', async () => {
        const at = (d: string) => ({ role: MemberRole.Admin, inviteTime: new Date(d), sharedBy: ok('ann@proton.me') });
        const { service } = make({
            nodes: [
                node('older', { membership: at('2026-01-01T00:00:00Z') }),
                node('newer', { membership: { ...at('2026-02-01T00:00:00Z'), sharedBy: bad('x@proton.me') } }),
            ],
        });
        expect((await service.list()).items).toEqual([
            { uid: 'newer', name: 'Name newer', kind: 'file', sharedBy: 'x@proton.me', sharedByVerified: false, sharedAt: Date.parse('2026-02-01T00:00:00Z'), role: 'admin', canLeave: true },
            { uid: 'older', name: 'Name older', kind: 'file', sharedBy: 'ann@proton.me', sharedByVerified: true, sharedAt: Date.parse('2026-01-01T00:00:00Z'), role: 'admin', canLeave: true },
        ]);
    });

    test('an item with no membership falls back to directRole, with sharedBy and sharedAt null and canLeave false', async () => {
        const { service } = make({ nodes: [node('n', { membership: undefined, directRole: MemberRole.Editor })] });
        expect((await service.list()).items).toEqual([
            { uid: 'n', name: 'Name n', kind: 'file', sharedBy: null, sharedByVerified: false, sharedAt: null, role: 'editor', canLeave: false },
        ]);
    });

    test('items without a date sort after the dated ones, then by name', async () => {
        const { service } = make({
            nodes: [node('b', { membership: undefined, name: ok('b') }), node('dated'), node('a', { membership: undefined, name: ok('a') })],
        });
        expect((await service.list()).items.map((i) => i.uid)).toEqual(['dated', 'a', 'b']);
    });

    test('an item that fails to load is listed with unreadable set', async () => {
        const { service } = make({ nodes: [node('good'), node('bad', { fails: true })] });
        const { items } = await service.list();
        expect(items.find((i) => i.uid === 'good')!.unreadable).toBeUndefined();
        expect(items.find((i) => i.uid === 'bad')).toEqual({
            uid: 'bad',
            name: null,
            kind: 'file',
            sharedBy: null,
            sharedByVerified: false,
            sharedAt: null,
            role: 'viewer',
            canLeave: false,
            unreadable: expect.any(String),
        });
    });
});

describe('shared with me: acting', () => {
    test('accept/decline/leave call the SDK with that uid and log what was done', async () => {
        const { service, calls, logs } = make({ invitations: [invitation('i1')], nodes: [node('n1')] });
        await service.accept('i1');
        await service.decline('i1');
        await service.leave('n1');
        expect(calls).toEqual([['accept', 'i1'], ['reject', 'i1'], ['leave', 'n1']]);
        expect(logs.map((l) => [l.action, l.details])).toEqual([
            ['share', 'Accepted an invitation to Name i1'],
            ['share', 'Declined an invitation to Name i1'],
            ['share', 'Left Name n1'],
        ]);
    });

    test('leave refuses an item with canLeave false, and an unreadable one', async () => {
        const { service, calls, logs } = make({ nodes: [node('own', { membership: undefined }), node('bad', { fails: true })] });
        await expect(service.leave('own')).rejects.toBeInstanceOf(ShareError);
        await expect(service.leave('bad')).rejects.toBeInstanceOf(ShareError);
        expect(calls).toEqual([]);
        expect(logs).toEqual([]);
    });

    test('an SDK error in accept/decline/leave becomes a ShareError, and nothing is logged', async () => {
        const { service, logs } = make({ invitations: [invitation('i1')], nodes: [node('n1')], failWith: new Error('boom') });
        for (const act of [() => service.accept('i1'), () => service.decline('i1'), () => service.leave('n1')]) {
            await expect(act()).rejects.toBeInstanceOf(ShareError);
        }
        expect(logs).toEqual([]);
    });

    test("openUrl returns getNodeUrl's URL, or the shared-with-me page when getNodeUrl throws", async () => {
        expect(await make().service.openUrl('n1').then((r) => r)).toEqual({ url: 'https://drive.proton.me/urls/n1' });
        expect(await make({ urlFails: true }).service.openUrl('n1')).toEqual({ url: 'https://drive.proton.me/shared-with-me' });
    });

    test('download is not there yet', async () => {
        await expect(make().service.download('n1')).rejects.toThrow('Not yet');
    });

    test('no logged detail contains an email address', async () => {
        const { service, logs } = make({
            invitations: [invitation('i1', { addedByEmail: ok('ann@proton.me') }, { name: ok('report for me@proton.me') })],
            nodes: [node('n1', { name: ok('from ann@proton.me.txt') })],
        });
        await service.accept('i1');
        await service.decline('i1');
        await service.leave('n1');
        expect(logs.length).toBe(3);
        for (const l of logs) expect(l.details + l.localRelPath).not.toMatch(/\S+@\S+\.\S+/);
    });
});
