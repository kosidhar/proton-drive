import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { driveSettings } from '../src/daemon/settingsRoute';
import { parseSettings } from '../src/daemon/settingsValidation';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { MAX_IGNORE_PATTERNS, problemWithIgnorePatterns, usableIgnorePatterns } from '../src/sync/settingsRules';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { DEFAULT_IGNORE_PATTERNS, SyncStateDatabase } from '../src/sync/syncStateDb';
import { makeMockDrive } from './helpers/mockDrive';
import { uploadAtOnce } from './helpers/engineOptions';

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

describe('settings are validated, every field, before any is stored (#34, #36)', () => {
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

    // Each of these hides every file; the first three are what the first review found
    for (const set of [['?', '??*'], ['*[!b]', '*b'], ['[a-m]*', '[!a-m]*'], ['[A-Z]*', '[!A-Z]*'], ['*', 'a'], ['*/**', 'a/**']]) {
        test(`${JSON.stringify(set)} match every file: 400, nothing stored`, async () => {
            const s = setup();
            const res = await s.save({ ignorePatterns: set, notificationsEnabled: false });
            expect([res.status, res.json.code]).toEqual([400, 'EINVAL']);
            expect(s.stateDb.getSettings()).toEqual(s.before);
        });
    }

    test('two patterns that together hide everything are refused as a set, though each is fine alone', async () => {
        expect(parseSettings({ ignorePatterns: ['[A-Z]*'] }).ok).toBe(true);
        expect(parseSettings({ ignorePatterns: ['[!A-Z]*'] }).ok).toBe(true);
        const res = await setup().save({ ignorePatterns: ['[A-Z]*', '[!A-Z]*'] });
        expect(String(res.json.error)).toMatch(/together/);
    });

    // Real lists, which name real-looking files, are not taken for matching everything
    for (const list of [
        ['*.pdf', '*.jpg', 'b'],
        ['?', '*.pdf', '*.jpg'],
        ['Documents', 'photos', 'a'],
        ['node_modules', '.git', '*.log', 'build', 'dist', '*.pdf', '*.jpg', '?'],
    ]) {
        test(`${JSON.stringify(list)} is accepted and stored`, async () => {
            const s = setup();
            expect((await s.save({ ignorePatterns: list })).status).toBe(200);
            expect(s.stateDb.getSettings().ignorePatterns).toEqual(list);
        });
    }
});

// I2: values stored before the checks existed must never stop syncing or hide the drive
describe('a bad stored setting is not used, and not overwritten (#34)', () => {
    const stored: Array<[string, string, string[]]> = [
        ['null', 'null', DEFAULT_IGNORE_PATTERNS],
        ['an object', '{}', DEFAULT_IGNORE_PATTERNS],
        ['not JSON', '{oops', DEFAULT_IGNORE_PATTERNS],
        ['a list of nothing usable', '[1,null,""]', DEFAULT_IGNORE_PATTERNS],
        ['everything', '["*"]', DEFAULT_IGNORE_PATTERNS],
        ['everything together', '["[A-Z]*","[!A-Z]*"]', DEFAULT_IGNORE_PATTERNS],
        ['a number among good patterns', '["*.bak",1,"build/**"]', ['*.bak', 'build/**']],
        ['everything among good patterns', '["*.bak","*","build/**"]', ['*.bak', 'build/**']],
        ['an empty pattern among good ones', '["","*.bak"]', ['*.bak']],
    ];
    for (const [name, raw, expected] of stored) {
        test(`ignorePatterns stored as ${name}: only the usable part applies, syncing goes on, and the files upload`, async () => {
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
                ...uploadAtOnce,
                backingDir: path.join(dir, 'files'),
            });
            cleanups.push(() => void engine.stop());
            writeFileSync(path.join(syncDir, 'mine.txt'), 'mine');

            await engine.reconcileNow();

            expect(stateDb.getSettings().ignorePatterns).toEqual(expected);
            expect(engine.getStatus().settings.ignorePatterns).toEqual(expected);
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

    // What is stored is the user's: a fallback used while loading is never written over it
    test('a stored list that is refused stays in the database byte for byte after a pause and after a save of another field', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-legacy-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        cleanups.push(() => stateDb.close());
        const raw = '["*.bak", 1, "*"]';
        stateDb.setMeta('ignorePatterns', raw);
        stateDb.setMeta('conflictStrategy', 'old-value');
        const engine = new ProtonDriveSyncEngine(makeMockDrive().sdk, makeMockDrive().eventsManager, { isLoggedIn: () => true }, stateDb, makeMockDrive().logger, {
            ...uploadAtOnce,
            backingDir: path.join(dir, 'files'),
        });
        cleanups.push(() => void engine.stop());
        await engine.setPaused(true);
        expect(stateDb.getMeta('ignorePatterns')).toBe(raw);
        expect(stateDb.getMeta('conflictStrategy')).toBe('old-value');
        stateDb.updateSettings({ notificationsEnabled: false });
        expect(stateDb.getMeta('ignorePatterns')).toBe(raw);
        expect(stateDb.getMeta('conflictStrategy')).toBe('old-value');
        expect(stateDb.getMeta('paused')).toBe('true');
        expect(stateDb.getMeta('notificationsEnabled')).toBe('false');
        expect(stateDb.getSettings().ignorePatterns).toEqual(['*.bak']); // while it is used, only what is usable
    });

    test('updateSettings writes only the keys it is given, and answers all of them', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-legacy-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        cleanups.push(() => stateDb.close());
        expect(stateDb.getMeta('paused')).toBeNull();
        const next = stateDb.updateSettings({ paused: true });
        expect(next.paused).toBe(true);
        expect(next.conflictStrategy).toBe('keep-both');
        expect(stateDb.getMeta('paused')).toBe('true');
        for (const key of ['syncDir', 'conflictStrategy', 'notificationsEnabled', 'reconcileIntervalSec', 'ignorePatterns']) {
            expect([key, stateDb.getMeta(key)]).toEqual([key, null]);
        }
    });
});

describe('blockedApps', () => {
    test('a list of app names is stored and reads back; an empty list unblocks everything', async () => {
        const t = setup();
        expect(t.before.blockedApps).toEqual([]);
        const saved = await t.save({ blockedApps: ['rg', 'code', 'baloo_file_extr'] });
        expect(saved.status).toBe(200);
        expect(t.stateDb.getSettings().blockedApps).toEqual(['rg', 'code', 'baloo_file_extr']);
        expect((await t.save({ blockedApps: [] })).status).toBe(200);
        expect(t.stateDb.getSettings().blockedApps).toEqual([]);
    });

    const bad: Array<[string, unknown]> = [
        ['not a list', 'rg'],
        ['an empty name', ['']],
        ['a name that is not text', [42]],
        ['a name longer than 15 bytes', ['a-very-long-name']],
        ['15 characters but more bytes', ['éééééééé']],
        ['a path', ['/usr/bin/rg']],
        ['a control character', ['r\ng']],
        ['spaces around it', [' rg']],
        ['a duplicate', ['rg', 'rg']],
        ['too many', Array.from({ length: 101 }, (_, i) => `app${i}`)],
    ];
    for (const [name, blockedApps] of bad) {
        test(`${name}: 400 EINVAL, nothing stored`, async () => {
            const t = setup();
            const saved = await t.save({ blockedApps });
            expect(saved.status).toBe(400);
            expect(saved.json.code).toBe('EINVAL');
            expect(t.stateDb.getSettings().blockedApps).toEqual([]);
        });
    }

    test('100 names of 15 bytes are fine', () => {
        const apps = Array.from({ length: 100 }, (_, i) => `app-${String(i).padStart(11, '0')}`);
        expect(parseSettings({ blockedApps: apps })).toEqual({ ok: true, value: { blockedApps: apps } });
    });

    test('a stored list that is unusable reads as none blocked, and is kept as it is', () => {
        const t = setup();
        t.stateDb.connection.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('blockedApps', '{not json')");
        expect(t.stateDb.getSettings().blockedApps).toEqual([]);
        t.stateDb.connection.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('blockedApps', '["/bin/sh"]')`);
        expect(t.stateDb.getSettings().blockedApps).toEqual([]);
        expect(t.stateDb.getMeta('blockedApps')).toBe('["/bin/sh"]');
    });
});

// #43: the check that a pattern hides everything keys on names unlike real files in every feature, so a broad but
// legitimate pattern that keys on one feature (a hyphen, a digit, a first letter, its case) is never taken for it
describe('ignore patterns that are broad but leave files out are allowed (#43)', () => {

    for (const pattern of ['*-*', '*[0-9]*', '[n-z]*', '[a-z]*', '[!A-Z]*', '[A-Z]*', '*_*', '* *', '*.*', '[0-9]*']) {
        test(`${pattern} is allowed, alone and as stored`, () => {
            expect(problemWithIgnorePatterns([pattern])).toBeNull();
            expect(usableIgnorePatterns([pattern])).toEqual({ patterns: [pattern], dropped: 0 });
        });
    }

    for (const pair of [['[A-Z]*', '[!A-Z]*'], ['[a-z]*', '[!a-z]*']] as const) {
        test(`${pair.join(' with ')} together are refused, as they hide everything`, () => {
            expect(problemWithIgnorePatterns([...pair])).toMatch(/together match every file/);
            expect(usableIgnorePatterns([...pair])).toBeNull();
        });
    }

    test('patterns that leave only dotfiles, the whole drive as it is seen, are refused', () => {
        for (const pattern of ['[!.]*', '[a-zA-Z0-9]*']) {
            expect(problemWithIgnorePatterns([pattern])).toMatch(/matches every file/);
        }
        expect(problemWithIgnorePatterns(['[a-z]*', '[A-Z]*', '[0-9]*'])).toMatch(/together match every file/);
    });

    test('lists keyed on what real files do not all share are allowed', () => {
        for (const list of [['*7*', '*5*'], ['.*'], ['.*/**'], ['*.tmp', '*.log', 'build/**', '__pycache__', '.cache/**', '.*.swp']]) {
            expect(problemWithIgnorePatterns(list)).toBeNull();
        }
    });

    test('patterns that match everything are still refused', () => {
        for (const pattern of everything) {
            expect(problemWithIgnorePatterns([pattern])).toMatch(/matches every file/);
        }
    });

    test('a stored list longer than the cap keeps the first 500 usable patterns', () => {
        const stored = Array.from({ length: MAX_IGNORE_PATTERNS + 20 }, (_, i) => `file-${i}.tmp`);
        const usable = usableIgnorePatterns(stored)!;
        expect(usable.patterns).toEqual(stored.slice(0, MAX_IGNORE_PATTERNS));
        expect(usable.dropped).toBe(20);
    });
});

// #147: ignore patterns are plain globs, as in .gitignore: no extglob, no negation, which no fixed sample list can check
describe('ignore patterns are matched as plain globs, never extglobs or negations (#147)', () => {
    test('a leading ! and parentheses are taken literally', () => {
        expect(matchesIgnorePatterns('Report.pdf', ['!(Bqk|4y k)'])).toBe(false);
        expect(matchesIgnorePatterns('Report.pdf', ['!(*q*)'])).toBe(false);
        expect(matchesIgnorePatterns('Report.pdf', ['!Bqk'])).toBe(false);
        expect(matchesIgnorePatterns('notes', ['@(notes|todo)'])).toBe(false);
        expect(matchesIgnorePatterns('aaa', ['+(a)'])).toBe(false);
        expect(matchesIgnorePatterns('!(x)', ['!(x)'])).toBe(true);
        expect(matchesIgnorePatterns('!draft', ['!draft'])).toBe(true);
        expect(matchesIgnorePatterns('f(1).txt', ['*(1).txt'])).toBe(true);
        expect(matchesIgnorePatterns('f1.txt', ['*(1).txt'])).toBe(false);
    });

    test('so they can no longer hide the drive past the check', () => {
        for (const pattern of ['!(Bqk|4y k)', '!(*q*)', '!(*[qk]*)', '!Bqk']) {
            expect(problemWithIgnorePatterns([pattern])).toBeNull(); // allowed: it hides only files named like that
            expect(matchesIgnorePatterns('Documents/Report.pdf', [pattern])).toBe(false);
        }
    });

    test('what the user escaped already stays as they wrote it', () => {
        expect(matchesIgnorePatterns('(x)', ['\\(x\\)'])).toBe(true);
        expect(matchesIgnorePatterns('Report (copy).pdf', ['Report \\(copy\\).pdf'])).toBe(true);
        expect(matchesIgnorePatterns('a(', ['a[(]'])).toBe(true);
        expect(matchesIgnorePatterns('a\\', ['a[(]'])).toBe(false);
        expect(matchesIgnorePatterns('a(', ['a[\\(]'])).toBe(true);
        expect(matchesIgnorePatterns('a\\', ['a[\\(]'])).toBe(false);
        expect(matchesIgnorePatterns('ac', ['a!(b)'])).toBe(false);
        expect(matchesIgnorePatterns('Report.pdf', [' !(x)'])).toBe(false);
    });

    test('ordinary globs still work', () => {
        expect(matchesIgnorePatterns('a.bak', ['*.bak'])).toBe(true);
        expect(matchesIgnorePatterns('b', ['[!a]*'])).toBe(true);
        expect(matchesIgnorePatterns('a', ['[!a]*'])).toBe(false);
        expect(matchesIgnorePatterns('x.tmp', ['*.{tmp,log}'])).toBe(true);
        expect(matchesIgnorePatterns('build/out/x', ['build/**'])).toBe(true);
    });
});

// #151: a class or range that leaves out only what the samples start with hides nearly every real file, past them
describe('ignore patterns that hide nearly every ordinary name are refused (#151)', () => {
    // [!0-9]* too: every name not starting with a digit is nearly every real file
    for (const pattern of ['[0-x]*', '[!yz.]*', '[!z.]*', '[A-Za-y]*', '[\\x00-\\x7f]*', '[!q]*', '[!0-9]*']) {
        test(`${pattern} is refused when saved`, () => {
            expect(problemWithIgnorePatterns([pattern])).toMatch(/matches (every|nearly every) file/);
        });
    }

    test('stored before the check, such a list is kept as saved: nothing kept out starts syncing after an update', () => {
        expect(usableIgnorePatterns(['[0-x]*'])).toEqual({ patterns: ['[0-x]*'], dropped: 0 });
        expect(usableIgnorePatterns(['*[aeiou]*', '*[AEIOU]*'])).toEqual({ patterns: ['*[aeiou]*', '*[AEIOU]*'], dropped: 0 });
        expect(usableIgnorePatterns(['*'])).toBeNull(); // everything, as before
    });

    test('the message says nearly every file, and lists cross the line together too', () => {
        expect(problemWithIgnorePatterns(['[0-x]*'])).toMatch(/matches nearly every file/);
        expect(problemWithIgnorePatterns(['[a-m]*', '[n-z]*', '[A-Z]*'])).toMatch(/together match nearly every file/);
    });

    test('names of files or folders never count toward nearly every file', () => {
        expect(problemWithIgnorePatterns(['*.*', 'Documents', 'Desktop', 'todo', 'keys'])).toBeNull();
        expect(problemWithIgnorePatterns(['Documents', 'Desktop', 'Music', 'todo', 'keys', 'notes.txt', 'README.md'])).toBeNull();
    });

    test('realistic and broad-but-partial lists still pass', () => {
        for (const list of [
            DEFAULT_IGNORE_PATTERNS,
            ['*.tmp', '*.log', 'build/**', '__pycache__', '.cache/**', '.*.swp', 'node_modules'],
            ['[A-Z]*'],
            ['[a-z]*'],
            ['*.*'],
            ['*.jpg', '*.png', '*.mp4'],
            ['Documents', 'Photos', 'Music'],
        ]) {
            expect(problemWithIgnorePatterns(list)).toBeNull();
        }
    });
});

// #155: a leading class that leaves out only a few letters hides nearly every file, whatever the sample names start with;
// and a list that leaves files in folders visible is not taken for hiding everything
describe('leading classes are judged by how much they cover (#155)', () => {
    for (const pattern of ['[!ryzRYZ]*', '[!dyzDYZ]*', '[!akyAKY]*', '[!anyANY]*', '[!ayDd]*', '[^ryzRYZ]*']) {
        test(`${pattern} is refused`, () => {
            expect(problemWithIgnorePatterns([pattern])).toMatch(/matches nearly every file/);
        });
    }

    test('classes covering part of the alphabet are still allowed', () => {
        for (const pattern of ['[A-Z]*', '[a-z]*', '[0-9]*', '[a-m]*', '[A-Za-f]*', '[!xyz]*.tmp']) {
            expect(problemWithIgnorePatterns([pattern])).toBeNull();
        }
    });

    test('rewritten, joined or escaped, such a class is refused all the same', () => {
        for (const pattern of [
            '[!ryzRYZ]*?', '[!ryzRYZ]*[!q]', '[!ryzRYZ][!.]*', '**/[!ryzRYZ]*', '{[!ryzRYZ]*,x}', '[!ryzRYZ]*[a-z]*',
            '[!]ryzRYZ]*', '[!\\]ryzRYZ]*', '[!r\\-zRYZ]*', '[!M]*/**', '[!Z9a.]*/**',
        ]) {
            expect(problemWithIgnorePatterns([pattern])).not.toBeNull();
        }
        expect(problemWithIgnorePatterns(['[a-q]*', '[s-x]*', '[A-Q]*', '[S-X]*', '[0-9]*'])).not.toBeNull();
        expect(problemWithIgnorePatterns(['[!ryzRYZ]*.*', '[!ryzRYZ]*[!.]'])).not.toBeNull();
    });

    test('a class that leaves out a fair share is allowed', () => {
        for (const pattern of ['[!\\-a-z]*', '[!qryzRYZ]*', '[A-Za-m]*']) {
            expect(problemWithIgnorePatterns([pattern])).toBeNull();
        }
    });

    test('*[0-9]* with *.* leaves files in folders visible, and is allowed', () => {
        expect(problemWithIgnorePatterns(['*[0-9]*', '*.*'])).toBeNull();
    });
});
