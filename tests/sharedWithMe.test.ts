import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemberRole, NodeType } from '@protontech/drive-sdk';

import { ShareError } from '../src/daemon/shareService';
import { resolveDownloadsDir } from '../src/daemon/downloadsDir';
import { createSharedWithMeService, downloadNames, redactingLogger } from '../src/daemon/sharedWithMe';
import { LOCAL_RESERVE_BYTES } from '../src/sync/syncEngine';

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

const tmpDirs: string[] = [];
afterEach(async () => {
    while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swm-'));
    tmpDirs.push(dir);
    return dir;
};

function make(
    opts: {
        invitations?: any[];
        nodes?: any[];
        failWith?: Error;
        urlFails?: boolean;
        downloads?: string;
        free?: number;
        fetchFile?: (node: any, toPath: string) => Promise<void>;
        logError?: (line: string) => void;
    } = {},
) {
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
    const fetched: string[] = [];
    const service = createSharedWithMeService({
        sdk,
        logActivity: (e) => logs.push(e),
        now: () => 1000,
        logError: opts.logError,
        downloadsDir: async () => opts.downloads ?? tmp(),
        freeBytes: async () => opts.free ?? LOCAL_RESERVE_BYTES * 10,
        fetchFile:
            opts.fetchFile ??
            (async (n: any, toPath: string) => {
                fetched.push(toPath);
                await writeFile(toPath, `content of ${n.uid}`);
            }),
    });
    return { service, calls, logs, fetched };
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

describe('shared with me: download', () => {
    const file = (uid: string, name: string, over: Record<string, unknown> = {}) =>
        node(uid, { name: ok(name), activeRevision: { claimedSize: 10 }, ...over });

    test('downloads a file into Downloads under its own name and logs Downloaded <name> to Downloads', async () => {
        const dir = tmp();
        const { service, logs, fetched } = make({ downloads: dir, nodes: [file('n1', 'Report.pdf')] });
        const { path: result } = await service.download('n1');
        expect(result).toBe(path.join(dir, 'Report.pdf'));
        expect(await readFile(result, 'utf8')).toBe('content of n1');
        expect(await readdir(dir)).toEqual(['Report.pdf']);
        expect(fetched).toHaveLength(1);
        expect(path.basename(fetched[0]!).startsWith('.proton-drive-tmp-')).toBe(true);
        expect(logs.map((l) => [l.action, l.details])).toEqual([['share', 'Downloaded Report.pdf to Downloads']]);
    });

    test('the activity never carries an address from the name', async () => {
        const { service, logs } = make({ nodes: [file('n1', 'from ann@proton.me.txt')] });
        await service.download('n1');
        expect(logs[0]!.details).toBe('Downloaded from an address to Downloads');
    });

    test('a taken name gets (1), (2): an existing file is never overwritten', async () => {
        const dir = tmp();
        await writeFile(path.join(dir, 'Report.pdf'), 'mine 0');
        await writeFile(path.join(dir, 'Report (1).pdf'), 'mine 1');
        const { service } = make({ downloads: dir, nodes: [file('n1', 'Report.pdf')] });
        const { path: result } = await service.download('n1');
        expect(result).toBe(path.join(dir, 'Report (2).pdf'));
        expect(await readFile(path.join(dir, 'Report.pdf'), 'utf8')).toBe('mine 0');
        expect(await readFile(path.join(dir, 'Report (1).pdf'), 'utf8')).toBe('mine 1');
        expect(await readFile(result, 'utf8')).toBe('content of n1');
        expect((await readdir(dir)).sort()).toEqual(['Report (1).pdf', 'Report (2).pdf', 'Report.pdf']);
    });

    test('two downloads of the same name at once end as two files', async () => {
        const dir = tmp();
        const { service } = make({ downloads: dir, nodes: [file('a', 'Same.txt'), file('b', 'Same.txt')] });
        const [x, y] = await Promise.all([service.download('a'), service.download('b')]);
        expect(x.path).not.toBe(y.path);
        expect([x.path, y.path].sort()).toEqual([path.join(dir, 'Same (1).txt'), path.join(dir, 'Same.txt')]);
        expect(await readFile(x.path, 'utf8')).toBe('content of a');
        expect(await readFile(y.path, 'utf8')).toBe('content of b');
        expect(await readdir(dir)).toHaveLength(2);
    });

    test('unsafe names are made safe and stay inside Downloads', async () => {
        const cases: Array<[string, string]> = [
            ['..', 'Shared file'],
            ['.', 'Shared file'],
            ['a/b', 'a_b'],
            ['../../etc/passwd', '.._.._etc_passwd'],
            ['a\0b.txt', 'ab.txt'],
            ['', 'Shared file'],
            ['.hidden', '.hidden'],
        ];
        for (const [name, expected] of cases) {
            const dir = tmp();
            const { service } = make({ downloads: dir, nodes: [file('n1', name)] });
            const { path: result } = await service.download('n1');
            expect([name, path.dirname(result), path.basename(result)]).toEqual([name, dir, expected]);
            expect(await readFile(result, 'utf8')).toBe('content of n1');
        }
    });

    test('an unreadable name is saved as Shared file', async () => {
        const dir = tmp();
        const { service } = make({ downloads: dir, nodes: [file('n1', 'x', { name: { ok: false, error: { name: 'x' } } })] });
        expect((await service.download('n1')).path).toBe(path.join(dir, 'Shared file'));
    });

    test('a very long name is shortened and keeps its extension', async () => {
        const dir = tmp();
        const { service } = make({ downloads: dir, nodes: [file('n1', `${'x'.repeat(400)}.pdf`)] });
        const { path: result } = await service.download('n1');
        expect(result.endsWith('.pdf')).toBe(true);
        expect(Buffer.byteLength(path.basename(result))).toBeLessThanOrEqual(150);
    });

    test('a long name is cut by character, never inside one, and the returned path exists', async () => {
        const dir = tmp();
        const name = `${'a'.repeat(143)}😀😀😀.pdf`;
        const { service } = make({ downloads: dir, nodes: [file('n1', name)] });
        const { path: result } = await service.download('n1');
        expect(existsSync(result)).toBe(true);
        expect(result.endsWith('.pdf')).toBe(true);
        expect(result).toBe(result.toWellFormed());
        expect(Buffer.byteLength(path.basename(result))).toBeLessThanOrEqual(150);
        expect(await readdir(dir)).toEqual([path.basename(result)]);
    });

    test('control characters of both ranges and the marks that reverse text are stripped', async () => {
        const dir = tmp();
        const { service } = make({ downloads: dir, nodes: [file('n1', 'evil\u202Efdp.exe\u0085\u009f\u2066x\u2069')] });
        expect(path.basename((await service.download('n1')).path)).toBe('evilfdp.exex');
    });

    test('a local failure of the fetch is said plainly, with no Proton blame and no temp path, and its code is logged', async () => {
        for (const [code, text] of [
            ['ENOSPC', "Couldn't save to your Downloads folder: there's no space left"],
            ['EPERM', "Couldn't save to your Downloads folder: it doesn't allow this"],
            ['EACCES', "Couldn't save to your Downloads folder: you don't have permission to write there"],
            ['EROFS', "Couldn't save to your Downloads folder: it is read-only"],
        ] as const) {
            const dir = tmp();
            const lines: string[] = [];
            const { service } = make({
                downloads: dir,
                nodes: [file('n1', 'a.txt')],
                fetchFile: async (_n, toPath) => {
                    await writeFile(toPath, 'half');
                    throw Object.assign(new Error(`${code}: failed, write '${toPath}'`), { code });
                },
                logError: (l) => lines.push(l),
            });
            const err = await service.download('n1').catch((e) => e);
            expect([code, err.message]).toEqual([code, text]);
            expect(err.message).not.toContain('.proton-drive-tmp-');
            expect(lines).toEqual([`Download: saving failed (${code})`]);
            expect(await readdir(dir)).toEqual([]);
        }
    });

    test('an EPERM from link is said plainly, with no temp path', async () => {
        const dir = tmp();
        const lines: string[] = [];
        // A folder where the file should be: link() refuses it with EPERM
        const { service } = make({
            downloads: dir,
            nodes: [file('n1', 'a.txt')],
            fetchFile: async (_n, toPath) => {
                await mkdir(toPath);
            },
            logError: (l) => lines.push(l),
        });
        const err = await service.download('n1').catch((e) => e);
        expect(err).toBeInstanceOf(ShareError);
        expect(err.message).toBe("Couldn't save to your Downloads folder: it doesn't allow this");
        expect(err.message).not.toContain(dir);
        expect(lines).toEqual(['Download: saving failed (EPERM)']);
        expect(existsSync(path.join(dir, 'a.txt'))).toBe(false);
    });

    test('a failing fetch for a name with an address logs no address', async () => {
        const logged: string[] = [];
        const sink = {
            debug: (m: string) => logged.push(m),
            info: (m: string) => logged.push(m),
            warn: (m: string) => logged.push(m),
            error: (m: string, e?: unknown) => logged.push(m, e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '')),
        };
        const logger = redactingLogger(sink);
        const secret = 'Contract - john@acme.com.pdf';
        logger.debug(`Downloading ${secret}`);
        logger.info(`Downloading ${secret}`);
        logger.warn(`Downloading ${secret}`);
        logger.error(`Failed downloading ${secret} to /d/.proton-drive-tmp-x-${secret}`, new Error(`rename ${secret} failed`));
        logger.error(`Failed ${secret}`, `text ${secret}`);
        expect(logged.length).toBeGreaterThan(5);
        expect(logged.join('\n')).not.toContain('john@acme.com');
        expect(logged.join('\n')).toContain('Contract - an address');
    });

    test('the names go name, name (1), name (2) with the extension last', () => {
        const names = downloadNames('Report.tar.gz');
        expect([names.next().value, names.next().value, names.next().value]).toEqual(['Report.tar.gz', 'Report.tar (1).gz', 'Report.tar (2).gz']);
        const plain = downloadNames('README');
        expect([plain.next().value, plain.next().value]).toEqual(['README', 'README (1)']);
        const dot = downloadNames('.bashrc');
        expect([dot.next().value, dot.next().value]).toEqual(['.bashrc', '.bashrc (1)']);
    });

    test('the Downloads folder is created if missing', async () => {
        const dir = path.join(tmp(), 'not', 'yet', 'Downloads');
        const { service } = make({ downloads: dir, nodes: [file('n1', 'a.txt')] });
        expect((await service.download('n1')).path).toBe(path.join(dir, 'a.txt'));
        expect(existsSync(path.join(dir, 'a.txt'))).toBe(true);
    });

    test('refused when it would leave less than LOCAL_RESERVE_BYTES free, and nothing is written', async () => {
        const dir = tmp();
        const { service, fetched, logs } = make({
            downloads: dir,
            free: LOCAL_RESERVE_BYTES + 99,
            nodes: [file('n1', 'big.bin', { activeRevision: { claimedSize: 100 } })],
        });
        const err = await service.download('n1').catch((e) => e);
        expect(err).toBeInstanceOf(ShareError);
        expect(err.message).toBe("There isn't enough free space on this computer to download this file");
        expect(fetched).toEqual([]);
        expect(await readdir(dir)).toEqual([]);
        expect(logs).toEqual([]);
    });

    test('exactly the reserve left is allowed; the size falls back to totalStorageSize', async () => {
        const ok1 = make({ free: LOCAL_RESERVE_BYTES + 100, nodes: [file('n1', 'a', { activeRevision: { claimedSize: 100 } })] });
        await ok1.service.download('n1');
        const tight = make({ free: LOCAL_RESERVE_BYTES + 100, nodes: [file('n1', 'a', { activeRevision: undefined, totalStorageSize: 101 })] });
        await expect(tight.service.download('n1')).rejects.toBeInstanceOf(ShareError);
    });

    test('refused for folders, Docs and Sheets', async () => {
        const dir = tmp();
        const { service, fetched, logs } = make({
            downloads: dir,
            nodes: [
                file('folder', 'F', { type: NodeType.Folder }),
                file('doc', 'D', { mediaType: DOC }),
                file('sheet', 'S', { mediaType: SHEET }),
            ],
        });
        for (const uid of ['folder', 'doc', 'sheet']) await expect(service.download(uid)).rejects.toBeInstanceOf(ShareError);
        expect(fetched).toEqual([]);
        expect(await readdir(dir)).toEqual([]);
        expect(logs).toEqual([]);
    });

    test('an item that is gone is a ShareError', async () => {
        await expect(make({ nodes: [] }).service.download('nope')).rejects.toBeInstanceOf(ShareError);
    });

    test('a failed fetch leaves no temp file and no target, and logs nothing', async () => {
        const dir = tmp();
        const { service, logs } = make({
            downloads: dir,
            nodes: [file('n1', 'a.txt')],
            fetchFile: async (_n, toPath) => {
                await writeFile(toPath, 'half');
                throw new Error('connection lost');
            },
        });
        await expect(service.download('n1')).rejects.toBeInstanceOf(ShareError);
        expect(await readdir(dir)).toEqual([]);
        expect(logs).toEqual([]);
    });

    test('a failed placing leaves no temp file', async () => {
        const dir = tmp();
        await writeFile(path.join(dir, 'unrelated'), 'keep');
        // The fetched file is gone before placing: the link fails with ENOENT
        const { service } = make({
            downloads: dir,
            nodes: [file('n1', 'a.txt')],
            fetchFile: async (_n, toPath) => {
                await writeFile(toPath, 'x');
                await rm(toPath);
            },
        });
        await expect(service.download('n1')).rejects.toBeInstanceOf(ShareError);
        expect(await readdir(dir)).toEqual(['unrelated']);
        expect(await readFile(path.join(dir, 'unrelated'), 'utf8')).toBe('keep');
    });
});

describe('the Downloads folder', () => {
    const home = '/home/u';
    test('is what xdg-user-dir says', async () => {
        expect(await resolveDownloadsDir(home, async () => '/data/Incoming\n'.trim())).toBe('/data/Incoming');
    });
    test('falls back to ~/Downloads when xdg-user-dir is missing, fails, prints $HOME or a relative path', async () => {
        for (const asked of [null, '', home, `${home}/`, 'Downloads']) {
            expect([asked, await resolveDownloadsDir(home, async () => asked)]).toEqual([asked, '/home/u/Downloads']);
        }
        expect(await resolveDownloadsDir(home, async () => Promise.reject(new Error('no')))).toBe('/home/u/Downloads');
    });
});
