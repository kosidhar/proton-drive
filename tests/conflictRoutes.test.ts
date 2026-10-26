import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { refuseOnTcp } from '../src/daemon/tcpRefusals';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { makeMockDrive } from './helpers/mockDrive';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

// A real engine over a mock drive and a real state database, the TCP API as the daemon serves it for these routes, and
// the control socket, in a temp dir
function setup() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pd-conflict-'));
    const syncDir = path.join(root, 'ProtonDrive');
    const appDir = path.join(root, 'app');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const stateDb = new SyncStateDatabase(path.join(root, 'state.sqlite'));
    cleanups.push(() => stateDb.close());
    stateDb.updateSettings({ syncDir, notificationsEnabled: false });
    mkdirSync(syncDir, { recursive: true });
    const drive = makeMockDrive();
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => false }, stateDb, logger, {
        backingDir: path.join(appDir, 'files'),
    });
    cleanups.push(() => engine.stop());

    // A file changed on both sides, recorded as a conflict waiting for the user
    const conflict = (name: string, resolved = false) => {
        drive.add(name, 'cloud copy');
        writeFileSync(path.join(syncDir, name), 'local copy');
        return stateDb.recordConflict({
            localRelPath: name,
            nodeUid: drive.uid(name),
            localSha1: 'l',
            remoteSha1: 'r',
            localMtimeMs: 1,
            remoteMtimeMs: 2,
            resolved,
            resolution: resolved ? 'keep-both' : null,
        });
    };

    let reached = 0;
    const tcp = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: async (req) => {
            const refused = refuseOnTcp(req);
            if (refused) return refused;
            reached += 1;
            const url = new URL(req.url);
            return url.pathname === '/api/conflicts' ? Response.json(stateDb.listConflicts(true)) : Response.json({ ok: true });
        },
    });
    cleanups.push(() => void tcp.stop(true));
    const socketPath = path.join(root, 'control.sock');
    const json = async (r: Response) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> });
    return {
        stateDb,
        drive,
        syncDir,
        conflict,
        reached: () => reached,
        read: (name: string) => readFileSync(path.join(syncDir, name), 'utf8'),
        start: async () => {
            const server = await startControlServer({
                socketPath,
                engine,
                resolveConflict: (id, choice) => engine.resolveConflictManually(id, choice),
            });
            cleanups.push(() => server.stop());
        },
        tcp: (method: string, pathname: string, body?: unknown) =>
            fetch(`http://127.0.0.1:${tcp.port}${pathname}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(json),
        socket: (body: unknown, raw?: string) =>
            fetch('http://localhost/conflicts/resolve', { unix: socketPath, method: 'POST', body: raw ?? JSON.stringify(body) } as RequestInit).then(json),
    };
}

describe('Resolving conflicts only over the control socket (#33)', () => {
    test('TCP refuses to resolve with 403 EACCES and leaves the files and the conflict alone', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        await s.start();
        for (const choice of ['keep-remote', 'keep-local', 'keep-both']) {
            const res = await s.tcp('POST', '/api/conflicts/resolve', { id: c.id, choice });
            expect([choice, res.status, res.json]).toEqual([choice, 403, { error: 'Resolve conflicts from the Proton Drive app', code: 'EACCES' }]);
        }
        expect(s.read('a.txt')).toBe('local copy');
        expect(s.drive.nodes.get(s.drive.uid('a.txt'))?.content).toBe('cloud copy');
        expect(s.stateDb.getConflictById(c.id)?.resolved).toBe(0);
        expect(s.reached()).toBe(0);
    });

    test('TCP still lists the conflicts', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        const res = await s.tcp('GET', '/api/conflicts');
        expect(res.status).toBe(200);
        expect((res.json as unknown as Array<{ id: number }>)[0]!.id).toBe(c.id);
    });

    test('the socket keeps the cloud copy: it replaces the local file, once', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        await s.start();
        const res = await s.socket({ id: c.id, choice: 'keep-remote' });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, conflict: { id: c.id, resolved: 1, resolution: 'keep-remote' } });
        expect(s.read('a.txt')).toBe('cloud copy');
    });

    test('the socket keeps the local copy: it replaces the cloud one', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        await s.start();
        const res = await s.socket({ id: c.id, choice: 'keep-local' });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, conflict: { resolved: 1, resolution: 'keep-local' } });
        expect(s.drive.calls.uploads).toEqual(['a.txt']);
    });

    test('a conflict that is already resolved is refused with 409 and nothing is touched', async () => {
        const s = setup();
        const done = s.conflict('a.txt', true);
        await s.start();
        for (const choice of ['keep-remote', 'keep-local', 'keep-both']) {
            const res = await s.socket({ id: done.id, choice });
            expect([choice, res.status, res.json.code]).toEqual([choice, 409, 'EEXIST']);
            expect(String(res.json.error)).toMatch(/already resolved/);
        }
        expect(s.read('a.txt')).toBe('local copy');
        expect(s.drive.calls.uploads).toEqual([]);
        expect(s.drive.nodes.get(s.drive.uid('a.txt'))?.content).toBe('cloud copy');
    });

    test('resolving twice acts once: the second answer is 409', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        await s.start();
        expect((await s.socket({ id: c.id, choice: 'keep-remote' })).status).toBe(200);
        writeFileSync(path.join(s.syncDir, 'a.txt'), 'edited since');
        expect((await s.socket({ id: c.id, choice: 'keep-remote' })).status).toBe(409);
        expect(s.read('a.txt')).toBe('edited since');
    });

    test('two resolves at the same moment act once', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        await s.start();
        const both = await Promise.all([s.socket({ id: c.id, choice: 'keep-local' }), s.socket({ id: c.id, choice: 'keep-local' })]);
        expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(s.drive.calls.uploads).toEqual(['a.txt']);
    });

    test('an unknown conflict is 404', async () => {
        const s = setup();
        await s.start();
        const res = await s.socket({ id: 999, choice: 'keep-local' });
        expect([res.status, res.json.code]).toEqual([404, 'ENOENT']);
    });

    test('a malformed request is 400 EINVAL', async () => {
        const s = setup();
        const c = s.conflict('a.txt');
        await s.start();
        for (const body of [{}, { id: c.id }, { choice: 'keep-local' }, { id: '1', choice: 'keep-local' }, { id: 1.5, choice: 'keep-local' }, { id: c.id, choice: 'delete' }, [1]]) {
            const res = await s.socket(body);
            expect([body, res.status, res.json.code]).toEqual([body, 400, 'EINVAL']);
        }
        expect((await s.socket(null, 'not json')).status).toBe(400);
        expect(s.stateDb.getConflictById(c.id)?.resolved).toBe(0);
    });
});
