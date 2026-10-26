import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { driveSettings, settingsRoute } from '../src/daemon/settingsRoute';
import { parseSettings } from '../src/daemon/settingsValidation';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { DEFAULT_IGNORE_PATTERNS, SyncStateDatabase } from '../src/sync/syncStateDb';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-settings-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
    cleanups.push(() => stateDb.close());
    stateDb.updateSettings({ syncDir: path.join(dir, 'ProtonDrive'), notificationsEnabled: true, conflictStrategy: 'keep-both' });
    let reconciles = 0;
    const deps = {
        stateDb,
        drive: {
            relocate: async (to: string) => to,
            setVirtualDriveWanted: async () => {},
            status: () => ({}) as never,
        },
        engine: { reconcileNow: async () => void (reconciles += 1) },
    };
    const tcp = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => settingsRoute(req, deps) });
    cleanups.push(() => void tcp.stop(true));
    const socketPath = path.join(dir, 'control.sock');
    const json = async (r: Response) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> });
    return {
        stateDb,
        reconciles: () => reconciles,
        before: stateDb.getSettings(),
        tcp: (body: unknown, raw?: string) => fetch(`http://127.0.0.1:${tcp.port}/api/settings`, { method: 'POST', body: raw ?? JSON.stringify(body) }).then(json),
        startSocket: async () => {
            const server = await startControlServer({ socketPath, engine: {} as never, driveSettings: (change) => driveSettings(change, deps) });
            cleanups.push(() => server.stop());
        },
        socket: async (body: unknown) => {
            return fetch('http://localhost/drive/settings', { unix: socketPath, method: 'POST', body: JSON.stringify(body) } as RequestInit).then(json);
        },
    };
}

const everything = ['*', '**', '**/*', ' * ', '*/**', '**/**', '**/*/**'];

describe('/api/settings validates every field before it stores anything (#34)', () => {
    test('a valid request is stored', async () => {
        const s = setup();
        const res = await s.tcp({ ignorePatterns: ['*.bak', 'build/**', '.cache'], conflictStrategy: 'prompt', notificationsEnabled: false });
        expect(res.status).toBe(200);
        expect(s.stateDb.getSettings()).toMatchObject({ ignorePatterns: ['*.bak', 'build/**', '.cache'], conflictStrategy: 'prompt', notificationsEnabled: false });
        expect(s.reconciles()).toBe(1);
    });

    test('every strategy the engine knows is accepted', async () => {
        const s = setup();
        for (const conflictStrategy of ['keep-both', 'keep-local', 'keep-remote', 'prompt'] as const) {
            expect((await s.tcp({ conflictStrategy })).status).toBe(200);
            expect(s.stateDb.getSettings().conflictStrategy).toBe(conflictStrategy);
        }
    });

    const bad: Array<[string, Record<string, unknown>]> = [
        ['ignorePatterns null', { ignorePatterns: null }],
        ['ignorePatterns a string', { ignorePatterns: '*.bak' }],
        ['ignorePatterns an object', { ignorePatterns: { 0: 'a' } }],
        ['a number in ignorePatterns', { ignorePatterns: [1] }],
        ['a null in ignorePatterns', { ignorePatterns: ['a', null] }],
        ['an empty pattern', { ignorePatterns: ['a', ''] }],
        ['a blank pattern', { ignorePatterns: ['   '] }],
        ['501 patterns', { ignorePatterns: Array.from({ length: 501 }, (_, i) => `p${i}`) }],
        ['a 1025-character pattern', { ignorePatterns: ['a'.repeat(1025)] }],
        ['a pattern with a null byte', { ignorePatterns: ['a\0b'] }],
        ['conflictStrategy unknown', { conflictStrategy: 'delete-everything' }],
        ['conflictStrategy a number', { conflictStrategy: 1 }],
        ['conflictStrategy null', { conflictStrategy: null }],
        ['notificationsEnabled a string', { notificationsEnabled: 'false' }],
        ['notificationsEnabled a number', { notificationsEnabled: 0 }],
        ['notificationsEnabled null', { notificationsEnabled: null }],
        ['virtualDriveWanted a string', { virtualDriveWanted: 'yes' }],
        ...everything.map((p): [string, Record<string, unknown>] => [`the pattern ${JSON.stringify(p)} that matches everything`, { ignorePatterns: ['*.bak', p] }]),
    ];
    for (const [name, field] of bad) {
        test(`${name}: 400 EINVAL, and the good fields beside it are not stored either`, async () => {
            const s = setup();
            const res = await s.tcp({ ...field, conflictStrategy: field.conflictStrategy === undefined ? 'keep-local' : field.conflictStrategy, notificationsEnabled: field.notificationsEnabled === undefined ? false : field.notificationsEnabled });
            expect([name, res.status, res.json.code]).toEqual([name, 400, 'EINVAL']);
            expect(typeof res.json.error).toBe('string');
            expect(s.stateDb.getSettings()).toEqual(s.before);
            expect(s.reconciles()).toBe(0);
        });
    }

    test('a good field is not stored when another is bad', async () => {
        const s = setup();
        const res = await s.tcp({ conflictStrategy: 'keep-remote', notificationsEnabled: false, ignorePatterns: ['*'] });
        expect(res.status).toBe(400);
        expect(s.stateDb.getSettings()).toEqual(s.before);
    });

    test('a body that is not an object, or not JSON, is 400', async () => {
        const s = setup();
        for (const body of [[1], 'x', null, 3]) expect([body, (await s.tcp(body)).status]).toEqual([body, 400]);
        expect((await s.tcp(null, 'not json')).status).toBe(400);
        expect(s.stateDb.getSettings()).toEqual(s.before);
    });

    test('keys it does not know are ignored, and never stored', async () => {
        const s = setup();
        const res = await s.tcp({ notificationsEnabled: false, theme: 'dark', paused: true, reconcileIntervalSec: 'soon' });
        expect(res.status).toBe(200);
        expect(s.stateDb.getSettings()).toEqual({ ...s.before, notificationsEnabled: false });
    });

    test('limits are inclusive: 500 patterns of 1024 characters are fine, and an empty list clears them', async () => {
        const s = setup();
        const patterns = Array.from({ length: 500 }, (_, i) => `${i}`.padEnd(1024, 'x'));
        expect((await s.tcp({ ignorePatterns: patterns })).status).toBe(200);
        expect(s.stateDb.getSettings().ignorePatterns).toEqual(patterns);
        expect((await s.tcp({ ignorePatterns: [] })).status).toBe(200);
        expect(s.stateDb.getSettings().ignorePatterns).toEqual([]);
    });

    test('the default patterns, and ordinary ones, are not taken for matching everything', () => {
        for (const p of [...DEFAULT_IGNORE_PATTERNS, '*.tmp', 'a*', '*a', '**/*.log', 'node_modules/**', '.*', '?', '[ab]*']) {
            expect([p, parseSettings({ ignorePatterns: [p] }).ok]).toEqual([p, true]);
        }
    });

    test('matching everything is judged by what the watcher would ignore', () => {
        for (const p of ['*', '**', '**/*']) {
            for (const rel of ['a', 'a/b', 'Documents/report.pdf', '.hidden', 'x.y.z']) {
                expect([p, rel, matchesIgnorePatterns(rel, [p])]).toEqual([p, rel, true]);
            }
        }
    });

    test('the socket still refuses a key other than the drive folder and the switch, and stores nothing', async () => {
        const s = setup();
        await s.startSocket();
        for (const body of [{ ignorePatterns: ['*'] }, { conflictStrategy: 'prompt' }, { notificationsEnabled: false }]) {
            const res = await s.socket(body);
            expect([body, res.status, res.json.code]).toEqual([body, 400, 'EINVAL']);
        }
        expect(s.stateDb.getSettings()).toEqual(s.before);
    });
});
