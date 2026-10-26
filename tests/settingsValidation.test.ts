import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { driveSettings } from '../src/daemon/settingsRoute';
import { parseSettings } from '../src/daemon/settingsValidation';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { DEFAULT_IGNORE_PATTERNS, SyncStateDatabase } from '../src/sync/syncStateDb';
import { makeMockDrive } from './helpers/mockDrive';

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
    const socketPath = path.join(dir, 'control.sock');
    const json = async (r: Response) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> });
    let started = false;
    const start = async () => {
        if (started) return;
        started = true;
        const server = await startControlServer({ socketPath, engine: {} as never, driveSettings: (change) => driveSettings(change, deps) });
        cleanups.push(() => server.stop());
    };
    return {
        dir,
        stateDb,
        reconciles: () => reconciles,
        before: stateDb.getSettings(),
        // POST /drive/settings on the control socket: the only way to write settings
        save: async (body: unknown, raw?: string) => {
            await start();
            return fetch('http://localhost/drive/settings', { unix: socketPath, method: 'POST', body: raw ?? JSON.stringify(body) } as RequestInit).then(json);
        },
    };
}

const everything = ['*', '**', '**/*', ' * ', '*/**', '**/**', '**/*/**'];

describe('settings are validated, every field, before any is stored (#34, #36) before it stores anything (#34)', () => {
    test('a valid request is stored', async () => {
        const s = setup();
        const res = await s.save({ ignorePatterns: ['*.bak', 'build/**', '.cache'], conflictStrategy: 'prompt', notificationsEnabled: false });
        expect(res.status).toBe(200);
        expect(s.stateDb.getSettings()).toMatchObject({ ignorePatterns: ['*.bak', 'build/**', '.cache'], conflictStrategy: 'prompt', notificationsEnabled: false });
        expect(s.reconciles()).toBe(1);
    });

    test('every strategy the engine knows is accepted', async () => {
        const s = setup();
        for (const conflictStrategy of ['keep-both', 'keep-local', 'keep-remote', 'prompt'] as const) {
            expect((await s.save({ conflictStrategy })).status).toBe(200);
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
            const res = await s.save({ ...field, conflictStrategy: field.conflictStrategy === undefined ? 'keep-local' : field.conflictStrategy, notificationsEnabled: field.notificationsEnabled === undefined ? false : field.notificationsEnabled });
            expect([name, res.status, res.json.code]).toEqual([name, 400, 'EINVAL']);
            expect(typeof res.json.error).toBe('string');
            expect(s.stateDb.getSettings()).toEqual(s.before);
            expect(s.reconciles()).toBe(0);
        });
    }

    test('a good field is not stored when another is bad', async () => {
        const s = setup();
        const res = await s.save({ conflictStrategy: 'keep-remote', notificationsEnabled: false, ignorePatterns: ['*'] });
        expect(res.status).toBe(400);
        expect(s.stateDb.getSettings()).toEqual(s.before);
    });

    test('a body that is not an object, or not JSON, is 400', async () => {
        const s = setup();
        for (const body of [[1], 'x', null, 3]) expect([body, (await s.save(body)).status]).toEqual([body, 400]);
        expect((await s.save(null, 'not json')).status).toBe(400);
        expect(s.stateDb.getSettings()).toEqual(s.before);
    });

    test('keys it does not know are refused with 400, and nothing is stored', async () => {
        const s = setup();
        const res = await s.save({ notificationsEnabled: false, theme: 'dark' });
        expect([res.status, res.json.code]).toEqual([400, 'EINVAL']);
        for (const key of ['paused', 'reconcileIntervalSec', '__proto__', 'constructor']) {
            expect([key, (await s.save(JSON.parse(`{"${key}": 1}`))).status]).toEqual([key, 400]);
        }
        expect(s.stateDb.getSettings()).toEqual(s.before);
    });

    test('the plain settings and the drive keys are saved together, or none is (a bad one stops the folder too)', async () => {
        const s = setup();
        const to = path.join(s.dir, 'Elsewhere');
        const bad = await s.save({ syncDir: to, virtualDriveWanted: true, notificationsEnabled: false, ignorePatterns: ['*'] });
        expect(bad.status).toBe(400);
        expect(s.stateDb.getSettings()).toEqual(s.before);
        const good = await s.save({ syncDir: to, notificationsEnabled: false, conflictStrategy: 'keep-remote', ignorePatterns: ['*.bak'] });
        expect(good.json).toMatchObject({ ok: true, folderError: null, switchError: null });
        expect(s.stateDb.getSettings()).toMatchObject({ syncDir: to, notificationsEnabled: false, conflictStrategy: 'keep-remote', ignorePatterns: ['*.bak'] });
    });

    test('limits are inclusive: 500 patterns of 1024 characters are fine, and an empty list clears them', async () => {
        const s = setup();
        const patterns = Array.from({ length: 500 }, (_, i) => `${i}`.padEnd(1024, 'x'));
        expect((await s.save({ ignorePatterns: patterns })).status).toBe(200);
        expect(s.stateDb.getSettings().ignorePatterns).toEqual(patterns);
        expect((await s.save({ ignorePatterns: [] })).status).toBe(200);
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

    // I1: each pattern alone is fine, together they hide everything
    for (const set of [['?', '??*'], ['*[!b]', '*b'], ['[a-m]*', '[!a-m]*']]) {
        test(`${JSON.stringify(set)} together match every file: 400, nothing stored`, async () => {
            expect(set.every((p) => parseSettings({ ignorePatterns: [p] }).ok)).toBe(true);
            const s = setup();
            const res = await s.save({ ignorePatterns: set, notificationsEnabled: false });
            expect([res.status, res.json.code]).toEqual([400, 'EINVAL']);
            expect(String(res.json.error)).toMatch(/together/);
            expect(s.stateDb.getSettings()).toEqual(s.before);
        });
    }
});

// I2: values stored before the checks existed must never stop syncing or hide the drive
describe('a bad stored setting falls back to its default (#34)', () => {
    const stored: Array<[string, string]> = [
        ['null', 'null'],
        ['a number in the list', '[1]'],
        ['an object', '{}'],
        ['not JSON', '{oops'],
        ['everything', '["*"]'],
        ['everything together', '["?","??*"]'],
        ['an empty pattern', '[""]'],
    ];
    for (const [name, raw] of stored) {
        test(`ignorePatterns stored as ${name}: the defaults apply, syncing goes on, and the files upload`, async () => {
            const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-legacy-'));
            cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
            const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
            cleanups.push(() => stateDb.close());
            const syncDir = path.join(dir, 'ProtonDrive');
            mkdirSync(syncDir);
            stateDb.updateSettings({ syncDir, notificationsEnabled: false });
            stateDb.setMeta('ignorePatterns', raw);
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                backingDir: path.join(dir, 'files'),
            });
            cleanups.push(() => void engine.stop());
            writeFileSync(path.join(syncDir, 'mine.txt'), 'mine');

            await engine.reconcileNow();

            expect(stateDb.getSettings().ignorePatterns).toEqual(DEFAULT_IGNORE_PATTERNS);
            expect(engine.getStatus().settings.ignorePatterns).toEqual(DEFAULT_IGNORE_PATTERNS);
            expect(engine.getStatus().state).not.toBe('error');
            expect(drive.calls.uploads).toEqual(['mine.txt']);
        });
    }

    test('a stored empty list and good patterns are kept; a stored unknown strategy falls back', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-legacy-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        cleanups.push(() => stateDb.close());
        stateDb.setMeta('ignorePatterns', '[]');
        expect(stateDb.getSettings().ignorePatterns).toEqual([]);
        stateDb.setMeta('ignorePatterns', '["*.bak","build/**"]');
        expect(stateDb.getSettings().ignorePatterns).toEqual(['*.bak', 'build/**']);
        stateDb.setMeta('conflictStrategy', 'delete-everything');
        expect(stateDb.getSettings().conflictStrategy).toBe('keep-both');
        stateDb.setMeta('conflictStrategy', 'prompt');
        expect(stateDb.getSettings().conflictStrategy).toBe('prompt');
    });
});
