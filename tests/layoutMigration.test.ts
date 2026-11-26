import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatConflictFileName } from '../src/sync/conflictResolver';
import { readDriveLayout } from '../src/sync/driveMode';
import {
    DifferentDiskError,
    finishRelocation,
    LAYOUT_MOVING,
    type MoveSeams,
    moveToLayout,
    relocateFiles,
    SYNC_DIR_MOVING,
} from '../src/sync/layoutMigration';
import { mergeInto } from '../src/sync/localMerge';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

const exdev = () => Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const modeOf = (p: string) => statSync(p).mode & 0o777;
const when = new Date(2026, 9, 26, 14, 5, 9);

// Every entry under a folder: its kind, mode, mtime, size, content or link target (what a round trip must keep). A
// folder whose copy across disks was cut short by a crash gets a new time: its source's changed as its files went.
function snapshot(root: string, opts: { folderTimes?: boolean } = {}): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const rel = path.relative(root, full);
            const st = lstatSync(full);
            const mode = (st.mode & 0o7777).toString(8);
            if (st.isSymbolicLink()) {
                out[rel] = `link ${readlinkSync(full)} ${st.mtimeMs}`;
            } else if (st.isDirectory()) {
                out[rel] = opts.folderTimes === false ? `dir ${mode}` : `dir ${mode} ${st.mtimeMs}`;
                walk(full);
            } else {
                out[rel] = `file ${mode} ${st.mtimeMs} ${st.size} ${readFileSync(full, 'base64')}`;
            }
        }
    };
    walk(root);
    return out;
}

function setup() {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pd-layout-')));
    const appDir = path.join(root, 'app');
    const backingDir = path.join(appDir, 'files');
    const syncDir = path.join(root, 'ProtonDrive');
    mkdirSync(appDir);
    mkdirSync(syncDir);
    const stateDb = new SyncStateDatabase(path.join(appDir, 'state.sqlite'));
    stateDb.updateSettings({ syncDir, notificationsEnabled: false });
    cleanups.push(() => {
        stateDb.close();
        const unlock = (dir: string) => {
            try {
                chmodSync(dir, 0o700);
                for (const name of readdirSync(dir)) {
                    const full = path.join(dir, name);
                    if (lstatSync(full).isDirectory()) unlock(full);
                }
            } catch {
                // gone already
            }
        };
        unlock(root);
        rmSync(root, { recursive: true, force: true });
    });
    const logs: string[] = [];
    const logger = {
        debug: (m: string) => logs.push(`debug ${m}`),
        info: (m: string) => logs.push(`info ${m}`),
        warn: (m: string) => logs.push(`warn ${m}`),
        error: (m: string) => logs.push(`error ${m}`),
    };
    const put = (p: string, content: string, mtimeSec?: number, mode?: number) => {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
        if (mode !== undefined) chmodSync(p, mode);
        if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
    };
    // A tree like a real sync folder: nested folders, an executable, a symlink, odd names and a staging file
    const fillTree = (dir: string) => {
        put(path.join(dir, 'Docs', 'report.odt'), 'report', 1_700_000_000.123456);
        put(path.join(dir, 'Docs', 'Deep', 'Deeper', 'notes.txt'), 'deep notes', 1_700_000_100);
        put(path.join(dir, 'Photos', 'a b c.jpg'), 'jpeg bytes', 1_700_000_200);
        put(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n', 1_700_000_300, 0o755);
        put(path.join(dir, 'Prôton ünïcode.txt'), 'ü', 1_700_000_400);
        put(path.join(dir, '.proton-drive-tmp-hydrate-1234'), 'staging', 1_700_000_500);
        mkdirSync(path.join(dir, 'Empty'));
        symlinkSync('Docs/report.odt', path.join(dir, 'link-to-report'));
        utimesSync(path.join(dir, 'Docs', 'Deep'), 1_700_000_600, 1_700_000_600);
    };
    // Records as the engine keeps them: by relative path, untouched by any move
    const record = (rel: string) =>
        stateDb.upsertItem({
            localRelPath: rel,
            nodeUid: `uid-${rel}`,
            parentNodeUid: null,
            type: 'file',
            localSha1: 'sha',
            remoteSha1: 'sha',
            localMtimeMs: 1,
            remoteMtimeMs: 1,
            size: 1,
            syncStatus: 'synced',
            lastError: null,
        });
    const move = (target: 'plain' | 'virtual', seams?: MoveSeams) =>
        moveToLayout({ stateDb, syncDir, backingDir, appDir, target, logger, now: when, seams });
    return { root, appDir, backingDir, syncDir, stateDb, logs, logger, put, fillTree, record, move };
}

describe('moveToLayout: plain to virtual', () => {
    test('puts every file in the backing store, leaves the sync folder empty at 0555, and keeps the records', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        s.record('Docs/report.odt');
        s.record('Photos/a b c.jpg');
        const before = snapshot(s.syncDir);
        const records = s.stateDb.getAllItems();

        expect(await s.move('virtual')).toBe('moved');

        expect(snapshot(s.backingDir)).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(modeOf(s.syncDir)).toBe(0o555);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(s.stateDb.getAllItems()).toEqual(records);
    });

    test('a crash after the first entry is finished by running it again, with nothing duplicated or lost', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        let entries = 0;
        const crash: MoveSeams = {
            onStep: (step) => {
                if (step === 'entry' && ++entries === 1) throw new Error('killed');
            },
        };

        await expect(s.move('virtual', crash)).rejects.toThrow('killed');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('virtual');
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(readdirSync(s.backingDir)).toHaveLength(1);

        expect(await s.move('virtual')).toBe('moved');
        expect(snapshot(s.backingDir)).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
    });

    test('a crash between linking a file at its new path and unlinking the old one leaves no duplicate', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'a.txt'), 'a', 1_700_000_000);
        mkdirSync(s.backingDir, { recursive: true });
        // What moveWithoutReplacing leaves when it dies between link(2) and unlink(2)
        linkSync(path.join(s.syncDir, 'a.txt'), path.join(s.backingDir, 'a.txt'));
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual');

        expect(await s.move('virtual')).toBe('moved');
        expect(readdirSync(s.backingDir)).toEqual(['a.txt']);
        expect(readFileSync(path.join(s.backingDir, 'a.txt'), 'utf8')).toBe('a');
        expect(readdirSync(s.syncDir)).toEqual([]);
    });

    test('a sync folder on another disk moves nothing: the layout stays plain', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const mode = modeOf(s.syncDir);
        const devices: MoveSeams = { deviceOf: (p) => (p.startsWith(s.syncDir) ? 1 : 2) };

        expect(await s.move('virtual', devices)).toBe('different-disk');

        expect(snapshot(s.syncDir)).toEqual(before);
        expect(existsSync(s.backingDir) ? readdirSync(s.backingDir) : []).toEqual([]);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(modeOf(s.syncDir)).toBe(mode);
        expect(s.logs.some((l) => l.startsWith('warn') && l.includes('disk'))).toBe(true);
    });

    test('a rename refused as cross-device stops with the move still marked; moving back restores everything', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);

        await expect(s.move('virtual', { moveSameDisk: () => { throw exdev(); } })).rejects.toBeInstanceOf(DifferentDiskError);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('virtual');

        expect(await s.move('plain')).toBe('moved');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
    });

    // A copy already in the store is dropped from the sync folder; a cross-device refusal after that must not read as
    // "nothing moved", or the file would be left only in the store, where its record reads as a deletion (C1)
    test('a cross-device refusal after an identical copy was dropped is never taken for nothing moved', async () => {
        const s = setup();
        for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) s.put(path.join(s.syncDir, `${n}.txt`), `content ${n}`);
        // The first name the move meets (it walks in readdir order), so its copy is dropped before the refusal
        const first = readdirSync(s.syncDir)[0]!;
        // An interrupted move leaves the store copy with the original's times. A copy written later (the 5 ms wait
        // makes it later for certain) would come back with its own time and fail the snapshot (#526)
        Bun.sleepSync(5);
        s.put(path.join(s.backingDir, first), `content ${first[0]}`);
        const sameTime = new Date('2026-01-02T03:04:05Z'); // whole seconds, which every disk keeps exactly
        for (const copy of [path.join(s.syncDir, first), path.join(s.backingDir, first)]) utimesSync(copy, sameTime, sameTime);
        s.record(first);
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual'); // a resume: a fresh move refuses a name the store already holds
        const before = snapshot(s.syncDir);

        await expect(s.move('virtual', { moveSameDisk: () => { throw exdev(); } })).rejects.toBeInstanceOf(DifferentDiskError);
        expect(existsSync(path.join(s.syncDir, first))).toBe(false); // dropped for the identical copy, before the refusal
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('virtual');
        expect(await s.move('plain')).toBe('moved');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readdirSync(s.backingDir)).toEqual([]);
    });

    test('refuses while something is mounted at the sync folder, moving nothing', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const mounted: MoveSeams = {
            readMountInfo: () => `99 30 0:99 / ${s.syncDir} rw,nosuid - fuse.protondrive protondrive rw\n`,
        };
        await expect(s.move('virtual', mounted)).rejects.toThrow(/mounted/);
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
    });

    test('the folders it changed are synced to disk before the layout flips', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const synced: string[] = [];
        const seams: MoveSeams = {
            fsyncDir: (dir) => {
                expect(readDriveLayout(s.stateDb)).toBe('plain');
                synced.push(dir.toString());
            },
        };
        expect(await s.move('virtual', seams)).toBe('moved');
        expect(synced).toContain(s.syncDir);
        expect(synced).toContain(s.backingDir);
    });

    test('a read-only folder made writable to move is read-only again after a crash and a resume', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'Locked', 'a.txt'), 'a');
        chmodSync(path.join(s.syncDir, 'Locked'), 0o555);
        let crashed = false;
        const crash: MoveSeams = {
            onStep: (step) => {
                if (step === 'opened' && !crashed) {
                    crashed = true;
                    throw new Error('killed');
                }
            },
        };
        await expect(s.move('virtual', crash)).rejects.toThrow('killed');
        expect(await s.move('virtual')).toBe('moved');
        expect(modeOf(path.join(s.backingDir, 'Locked'))).toBe(0o555);
        expect(readFileSync(path.join(s.backingDir, 'Locked', 'a.txt'), 'utf8')).toBe('a');
    });

    test('names and link targets that are not UTF-8 move byte for byte', async () => {
        const s = setup();
        const odd = (...parts: Array<string | number[]>) =>
            Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))));
        const sync = Buffer.from(s.syncDir);
        writeFileSync(odd(s.syncDir, '/bad-', [0xff, 0xfe], '.txt'), 'odd bytes');
        mkdirSync(path.join(s.syncDir, 'Docs'));
        writeFileSync(odd(s.syncDir, '/Docs/inner-', [0xff], '.txt'), 'inner');
        symlinkSync(odd('tgt-', [0xff]), odd(s.syncDir, '/ln'));
        s.put(path.join(s.backingDir, 'Docs', 'other.txt'), 'x'); // Docs is merged, not renamed
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual'); // a resume, as only then can the store hold a name already
        const names = (dir: Buffer) => readdirSync(dir, { encoding: 'buffer' }).map((b) => b.toString('hex')).sort();
        const before = { top: names(sync), docs: names(odd(s.syncDir, '/Docs')) };

        expect(await s.move('virtual')).toBe('moved');
        const store = Buffer.from(s.backingDir);
        expect(names(store)).toEqual(before.top);
        expect(names(odd(s.backingDir, '/Docs')).filter((h) => h !== Buffer.from('other.txt').toString('hex'))).toEqual(before.docs);
        expect((readlinkSync(odd(s.backingDir, '/ln'), { encoding: 'buffer' }) as Buffer).toString('hex')).toBe(odd('tgt-', [0xff]).toString('hex'));

        rmSync(path.join(s.backingDir, 'Docs', 'other.txt'));
        expect(await s.move('plain', { moveSameDisk: () => { throw exdev(); } })).toBe('moved');
        expect(names(sync)).toEqual(before.top);
        expect(names(odd(s.syncDir, '/Docs'))).toEqual(before.docs);
        expect(readFileSync(odd(s.syncDir, '/bad-', [0xff, 0xfe], '.txt'), 'utf8')).toBe('odd bytes');
        expect((readlinkSync(odd(s.syncDir, '/ln'), { encoding: 'buffer' }) as Buffer).toString('hex')).toBe(odd('tgt-', [0xff]).toString('hex'));
    });

    test('a long name taken in the store gets a conflict name that fits, never splitting a character', async () => {
        const s = setup();
        const long = `${'L'.repeat(246)}.txt`; // 250 bytes
        const accented = `${'é'.repeat(125)}`; // 250 bytes, two per character
        for (const name of [long, accented]) {
            s.put(path.join(s.syncDir, name), 'synced');
            s.put(path.join(s.backingDir, name), 'was in the store', 1_600_000_000);
        }
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual'); // a resume, as only then can the store hold a name already
        expect(await s.move('virtual')).toBe('moved');
        const stored = readdirSync(s.backingDir, { encoding: 'buffer' });
        expect(stored).toHaveLength(4);
        for (const name of stored) {
            expect(name.length).toBeLessThanOrEqual(255);
            expect(Buffer.from(name.toString('utf8')).equals(name)).toBe(true); // still valid UTF-8
        }
        expect(readFileSync(path.join(s.backingDir, long), 'utf8')).toBe('synced');
        expect(readFileSync(path.join(s.backingDir, accented), 'utf8')).toBe('synced');
        const kept = stored.map((b) => b.toString()).filter((n) => n.includes('(conflict '));
        expect(kept.map((n) => readFileSync(path.join(s.backingDir, n), 'utf8'))).toEqual(['was in the store', 'was in the store']);
        expect(kept.some((n) => n.endsWith('.txt'))).toBe(true);
    });

    test('a step aside cut short between its link and unlink leaves one conflict name, not two', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'a.txt'), 'synced');
        s.put(path.join(s.backingDir, 'a.txt'), 'was in the store', 1_600_000_000);
        // What the step aside leaves when it dies between link(2) and unlink(2), in an earlier run
        const earlier = formatConflictFileName('a.txt', new Date(2026, 0, 1, 10, 0, 0));
        linkSync(path.join(s.backingDir, 'a.txt'), path.join(s.backingDir, earlier));
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual');

        expect(await s.move('virtual')).toBe('moved');
        expect(readdirSync(s.backingDir).sort()).toEqual([earlier, 'a.txt'].sort());
        expect(readFileSync(path.join(s.backingDir, 'a.txt'), 'utf8')).toBe('synced');
        expect(readFileSync(path.join(s.backingDir, earlier), 'utf8')).toBe('was in the store');
    });

    test('a cross-device refusal after something moved stops with the move still marked, for the caller to undo', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        let moves = 0;
        const { moveWithoutReplacing } = await import('../src/sync/localMove');
        const seams: MoveSeams = {
            moveSameDisk: (from, to) => {
                if (++moves > 1) throw exdev();
                return moveWithoutReplacing(from, to);
            },
        };

        await expect(s.move('virtual', seams)).rejects.toBeInstanceOf(DifferentDiskError);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('virtual');
        expect(readDriveLayout(s.stateDb)).toBe('plain');
    });

    test('a fresh move into a store already holding one of the sync folder\'s names is refused, moving nothing', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        s.put(path.join(s.backingDir, 'Docs', 'stale.txt'), 'left in the store');
        s.put(path.join(s.backingDir, 'unrelated.txt'), 'left in the store too');
        const before = snapshot(s.syncDir);
        await expect(s.move('virtual')).rejects.toThrow(/already holds Docs/);
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.logs.some((l) => l.includes('already holds Docs'))).toBe(true);

        // Something that takes no name of the sync folder's doesn't stand in the way
        rmSync(path.join(s.backingDir, 'Docs'), { recursive: true });
        expect(await s.move('virtual')).toBe('moved');
        expect(readFileSync(path.join(s.backingDir, 'unrelated.txt'), 'utf8')).toBe('left in the store too');
    });

    test('resuming, nothing in the backing store is replaced: a folder is merged into, a taken name steps aside', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'Docs', 'same.txt'), 'synced copy');
        s.put(path.join(s.syncDir, 'Docs', 'new.txt'), 'new');
        s.put(path.join(s.syncDir, 'top.txt'), 'synced top');
        s.put(path.join(s.backingDir, 'Docs', 'same.txt'), 'was in the store');
        s.put(path.join(s.backingDir, 'Docs', 'kept.txt'), 'kept');
        s.put(path.join(s.backingDir, 'top.txt'), 'was in the store too');
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual');

        expect(await s.move('virtual')).toBe('moved');

        const b = (rel: string) => readFileSync(path.join(s.backingDir, rel), 'utf8');
        expect(b('Docs/same.txt')).toBe('synced copy');
        expect(b(`Docs/${formatConflictFileName('same.txt', when)}`)).toBe('was in the store');
        expect(b('Docs/new.txt')).toBe('new');
        expect(b('Docs/kept.txt')).toBe('kept');
        expect(b('top.txt')).toBe('synced top');
        expect(b(formatConflictFileName('top.txt', when))).toBe('was in the store too');
        expect(readdirSync(s.syncDir)).toEqual([]);
    });

    test('a file saved into the sync folder during the move is moved in another round', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'a.txt'), 'a');
        let saved = false;
        const seams: MoveSeams = {
            onStep: (step) => {
                if (step === 'entry' && !saved) {
                    saved = true;
                    writeFileSync(path.join(s.syncDir, 'late.txt'), 'late'); // an app saves meanwhile
                }
            },
        };
        expect(await s.move('virtual', seams)).toBe('moved');
        expect(readdirSync(s.backingDir).sort()).toEqual(['a.txt', 'late.txt']);
        expect(modeOf(s.syncDir)).toBe(0o555);
    });

    test('a sync folder that never stops filling is left at its mode, for the drive to merge when it mounts', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'a.txt'), 'a');
        const mode = modeOf(s.syncDir);
        let n = 0;
        const seams: MoveSeams = {
            onStep: (step) => {
                if (step === 'entry') writeFileSync(path.join(s.syncDir, `late-${n++}.txt`), 'late');
            },
        };
        expect(await s.move('virtual', seams)).toBe('moved');
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(readdirSync(s.syncDir).length).toBeGreaterThan(0);
        expect(modeOf(s.syncDir)).toBe(mode);
        expect(s.logs.some((l) => l.startsWith('warn') && l.includes(s.syncDir))).toBe(true);
    });

    test('a missing sync folder is an empty source even when the store already holds something', async () => {
        const s = setup();
        rmSync(s.syncDir, { recursive: true });
        s.put(path.join(s.backingDir, 'leftover.txt'), 'left in the store');
        expect(await s.move('virtual')).toBe('moved');
        expect(modeOf(s.syncDir)).toBe(0o555);
        expect(readFileSync(path.join(s.backingDir, 'leftover.txt'), 'utf8')).toBe('left in the store');
    });

    test('a destination that folds case refuses names that differ only in case, before anything moves, naming them', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'Docs', 'Report.txt'), 'one');
        s.put(path.join(s.syncDir, 'Docs', 'report.txt'), 'two');
        s.put(path.join(s.syncDir, 'fine.txt'), 'fine');
        const before = snapshot(s.syncDir);
        const folds: MoveSeams = { destinationFoldsCase: () => true };
        await expect(s.move('virtual', folds)).rejects.toThrow(/differ only in case.*Docs\/(Report|report)\.txt/);
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        // The same tree to a destination that keeps case moves
        expect(await s.move('virtual')).toBe('moved');
        expect(readdirSync(path.join(s.backingDir, 'Docs')).sort()).toEqual(['Report.txt', 'report.txt']);
    });

    test('the probes it makes at the destination are gone after the move, either way', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const probes = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.proton-drive-tmp-move-'));
        expect(await s.move('virtual')).toBe('moved');
        expect(probes(s.backingDir)).toEqual([]);
        expect(await s.move('plain', { moveSameDisk: () => { throw exdev(); } })).toBe('moved');
        expect(probes(s.syncDir)).toEqual([]);
    });

    test('a missing sync folder is an empty one: it is created as the 0555 mount point', async () => {
        const s = setup();
        rmSync(s.syncDir, { recursive: true });
        expect(await s.move('virtual')).toBe('moved');
        expect(modeOf(s.syncDir)).toBe(0o555);
        expect(statSync(s.backingDir).isDirectory()).toBe(true);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
    });

    test('running it again once the move is done does nothing', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        expect(await s.move('virtual')).toBe('moved');
        const after = snapshot(s.backingDir);
        expect(await s.move('virtual')).toBe('already');
        expect(snapshot(s.backingDir)).toEqual(after);
    });

    test('a sync folder overlapping the app dir or the backing store is refused, and nothing is touched', async () => {
        const s = setup();
        s.put(path.join(s.appDir, 'keep.txt'), 'app file');
        for (const syncDir of [s.appDir, s.backingDir, path.join(s.backingDir, 'Drive'), s.root]) {
            await expect(
                moveToLayout({ stateDb: s.stateDb, syncDir, backingDir: s.backingDir, appDir: s.appDir, target: 'virtual', logger: s.logger }),
            ).rejects.toThrow(/overlaps/);
            expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        }
        expect(readFileSync(path.join(s.appDir, 'keep.txt'), 'utf8')).toBe('app file');
        expect(readDriveLayout(s.stateDb)).toBe('plain');
    });
});

describe('moveToLayout: virtual to plain', () => {
    const virtualWith = async (s: ReturnType<typeof setup>) => {
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        expect(await s.move('virtual')).toBe('moved');
        return before;
    };

    test('puts everything back in the sync folder at 0755', async () => {
        const s = setup();
        const before = await virtualWith(s);
        expect(await s.move('plain')).toBe('moved');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(modeOf(s.syncDir)).toBe(0o755);
        expect(readdirSync(s.backingDir)).toEqual([]);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
    });

    test('refuses while the drive is still mounted at the sync folder, moving nothing', async () => {
        const s = setup();
        const before = await virtualWith(s);
        const mounted: MoveSeams = {
            readMountInfo: () => `99 30 0:99 / ${s.syncDir} rw,nosuid - fuse.protondrive protondrive rw\n`,
        };
        await expect(s.move('plain', mounted)).rejects.toThrow(/mounted/);
        expect(snapshot(s.backingDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
    });

    test('nothing in the sync folder is replaced: a folder is merged into, a taken name steps aside', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'Docs', 'same.txt'), 'synced copy');
        s.put(path.join(s.syncDir, 'top.txt'), 'synced top');
        expect(await s.move('virtual')).toBe('moved');
        chmodSync(s.syncDir, 0o755);
        s.put(path.join(s.syncDir, 'Docs', 'same.txt'), 'saved into the bare folder');
        s.put(path.join(s.syncDir, 'Docs', 'other.txt'), 'other');
        s.put(path.join(s.syncDir, 'top.txt'), 'saved too');

        expect(await s.move('plain')).toBe('moved');

        const p = (rel: string) => readFileSync(path.join(s.syncDir, rel), 'utf8');
        expect(p('Docs/same.txt')).toBe('synced copy');
        expect(p(`Docs/${formatConflictFileName('same.txt', when)}`)).toBe('saved into the bare folder');
        expect(p('Docs/other.txt')).toBe('other');
        expect(p('top.txt')).toBe('synced top');
        expect(p(formatConflictFileName('top.txt', when))).toBe('saved too');
    });

    test('a folder already in the sync folder keeps its own mode, a read-only one too, as entries are merged into it', async () => {
        const s = setup();
        s.put(path.join(s.backingDir, 'Docs', 'a.txt'), 'a');
        s.put(path.join(s.backingDir, 'Locked', 'b.txt'), 'b');
        chmodSync(path.join(s.backingDir, 'Docs'), 0o775);
        s.stateDb.setMeta('driveLayout', 'virtual');
        s.put(path.join(s.syncDir, 'Docs', 'stray.txt'), 'saved into the bare folder');
        s.put(path.join(s.syncDir, 'Locked', 'stray.txt'), 'saved too');
        chmodSync(path.join(s.syncDir, 'Docs'), 0o750);
        chmodSync(path.join(s.syncDir, 'Locked'), 0o555);

        expect(await s.move('plain')).toBe('moved');

        expect(modeOf(path.join(s.syncDir, 'Docs'))).toBe(0o750);
        expect(modeOf(path.join(s.syncDir, 'Locked'))).toBe(0o555);
        expect(readFileSync(path.join(s.syncDir, 'Docs', 'a.txt'), 'utf8')).toBe('a');
        expect(readFileSync(path.join(s.syncDir, 'Locked', 'b.txt'), 'utf8')).toBe('b');
        expect(readFileSync(path.join(s.syncDir, 'Locked', 'stray.txt'), 'utf8')).toBe('saved too');
    });

    describe('across disks', () => {
        const acrossDisks = (extra: MoveSeams = {}): MoveSeams => ({
            moveSameDisk: () => {
                throw exdev();
            },
            ...extra,
        });

        test('copies file by file, keeping modes, times and links, and removes each source once its copy is verified', async () => {
            const s = setup();
            const before = await virtualWith(s);
            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(snapshot(s.syncDir)).toEqual(before);
            expect(readdirSync(s.backingDir)).toEqual([]);
            expect(readDriveLayout(s.stateDb)).toBe('plain');
            // No copy in progress is left behind under a temporary name
            expect(Object.keys(snapshot(s.syncDir)).filter((rel) => rel.includes('.proton-drive-tmp-move-'))).toEqual([]);
        });

        test('a crash after some files, at any step, is finished by running it again, with nothing lost or duplicated', async () => {
            for (const crashAt of ['copied', 'placed', 'removed'] as const) {
                const s = setup();
                await virtualWith(s);
                const before = snapshot(s.backingDir, { folderTimes: false });
                let n = 0;
                const crash = acrossDisks({
                    onStep: (step) => {
                        if (step === crashAt && ++n === 3) throw new Error('killed');
                    },
                });
                await expect(s.move('plain', crash)).rejects.toThrow('killed');
                expect([crashAt, s.stateDb.getMeta(LAYOUT_MOVING)]).toEqual([crashAt, 'plain']);

                expect(await s.move('plain', acrossDisks())).toBe('moved');
                expect([crashAt, snapshot(s.syncDir, { folderTimes: false })]).toEqual([crashAt, before]);
                expect([crashAt, readdirSync(s.backingDir)]).toEqual([crashAt, []]);
            }
        });

        test('a partial copy left by a crash is never shown under the real name and is replaced on the next run', async () => {
            const s = setup();
            await virtualWith(s);
            const before = snapshot(s.backingDir, { folderTimes: false });
            let copies = 0;
            let partial: Buffer = Buffer.alloc(0);
            const { copyFileSync } = await import('node:fs');
            const crash = acrossDisks({
                copyFile: (from, to) => {
                    if (++copies === 2) {
                        partial = to;
                        throw new Error('killed');
                    }
                    copyFileSync(from, to);
                },
            });
            await expect(s.move('plain', crash)).rejects.toThrow('killed');
            // A real crash mid-copy leaves the partial copy where it was being written
            writeFileSync(partial, 'half');
            expect(path.dirname(partial.toString()).startsWith(s.syncDir)).toBe(true);
            expect(path.basename(partial.toString())).toStartWith('.proton-drive-tmp-');

            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(snapshot(s.syncDir, { folderTimes: false })).toEqual(before);
        });

        test('running out of space stops the move with the source intact and the move still marked', async () => {
            const s = setup();
            await virtualWith(s);
            const storeBefore = snapshot(s.backingDir);
            let copies = 0;
            const { copyFileSync } = await import('node:fs');
            const full = acrossDisks({
                copyFile: (from, to) => {
                    if (++copies === 3) {
                        writeFileSync(to, 'part of it');
                        throw enospc();
                    }
                    copyFileSync(from, to);
                },
            });
            await expect(s.move('plain', full)).rejects.toThrow(/ENOSPC/);
            expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('plain');
            expect(readDriveLayout(s.stateDb)).toBe('virtual');
            // Every file is in one place or the other, complete; the partial copy is gone
            const moved = snapshot(s.syncDir);
            const left = snapshot(s.backingDir);
            for (const [rel, entry] of Object.entries(storeBefore)) {
                if (entry.startsWith('dir')) continue;
                expect([rel, left[rel] ?? moved[rel]]).toEqual([rel, entry]);
            }
            expect(Object.keys(moved).filter((rel) => rel.includes('.proton-drive-tmp-'))).toEqual([]);
        });

        test('a file already copied by an earlier run counts as moved; a different one there steps aside', async () => {
            const s = setup();
            s.put(path.join(s.syncDir, 'same.txt'), 'same', 1_700_000_000);
            s.put(path.join(s.syncDir, 'differs.txt'), 'ours', 1_700_000_000);
            expect(await s.move('virtual')).toBe('moved');
            chmodSync(s.syncDir, 0o755);
            s.put(path.join(s.syncDir, 'same.txt'), 'same', 1_700_000_000); // copied, source not yet removed
            s.put(path.join(s.syncDir, 'differs.txt'), 'something else', 1_700_000_000);
            s.stateDb.setMeta(LAYOUT_MOVING, 'plain');

            expect(await s.move('plain', acrossDisks())).toBe('moved');

            expect(readdirSync(s.syncDir).sort()).toEqual(
                [formatConflictFileName('differs.txt', when), 'differs.txt', 'same.txt'].sort(),
            );
            expect(readFileSync(path.join(s.syncDir, 'differs.txt'), 'utf8')).toBe('ours');
            expect(readFileSync(path.join(s.syncDir, formatConflictFileName('differs.txt', when)), 'utf8')).toBe('something else');
            expect(readdirSync(s.backingDir)).toEqual([]);
        });

        test('read-only folders move in and out, keeping their modes', async () => {
            const s = setup();
            s.put(path.join(s.syncDir, 'Locked', 'Inner', 'a.txt'), 'a', 1_700_000_000);
            chmodSync(path.join(s.syncDir, 'Locked', 'Inner'), 0o555);
            chmodSync(path.join(s.syncDir, 'Locked'), 0o555);
            const before = snapshot(s.syncDir, { folderTimes: false });
            expect(await s.move('virtual')).toBe('moved');
            expect(snapshot(s.backingDir, { folderTimes: false })).toEqual(before);
            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(snapshot(s.syncDir, { folderTimes: false })).toEqual(before);
            expect(readdirSync(s.backingDir)).toEqual([]);
        });

        test('a destination that rounds times to 2 s and refuses chmod (exFAT, FAT) takes every file, even after a crash', async () => {
            const s = setup();
            await virtualWith(s);
            const before = snapshot(s.backingDir, { folderTimes: false });
            const fat: MoveSeams = {
                setTimes: (p, atime, mtime) => utimesSync(p, Math.round(atime / 2) * 2, Math.round(mtime / 2) * 2),
                setMode: () => {
                    throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
                },
            };
            let n = 0;
            const crash = acrossDisks({
                ...fat,
                onStep: (step) => {
                    if (step === 'placed' && ++n === 2) throw new Error('killed');
                },
            });
            await expect(s.move('plain', crash)).rejects.toThrow('killed');
            expect(await s.move('plain', acrossDisks(fat))).toBe('moved');
            // Every file whole and once: contents and links as they were (times and modes as the disk allows)
            const after = snapshot(s.syncDir, { folderTimes: false });
            const content = (snap: Record<string, string>) =>
                Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.startsWith('file') ? v.split(' ').slice(-1)[0] : v.split(' ')[0]]));
            expect(content(after)).toEqual(content(before));
            expect(readdirSync(s.backingDir)).toEqual([]);
            expect(s.logs.some((l) => l.startsWith('warn') && l.includes('EPERM'))).toBe(true);
        });

        test('an I/O error setting a mode is not taken for a disk that can\'t keep modes: the move stops and a re-run finishes it', async () => {
            const s = setup();
            const before = await virtualWith(s);
            let failed = false;
            const flaky = acrossDisks({
                setMode: (p, mode) => {
                    if (!failed && !p.toString().includes('.proton-drive-tmp-move-probe')) {
                        failed = true;
                        throw Object.assign(new Error('EIO: i/o error, chmod'), { code: 'EIO' });
                    }
                    chmodSync(p, mode);
                },
            });
            await expect(s.move('plain', flaky)).rejects.toThrow('EIO');
            expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('plain');
            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(snapshot(s.syncDir, { folderTimes: false })).toEqual(
                Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.startsWith('dir') ? v.split(' ').slice(0, 2).join(' ') : v])),
            );
        });

        test('a read-only folder whose copy was cut short between making it and opening its source resumes', async () => {
            const s = setup();
            mkdirSync(s.backingDir, { recursive: true });
            s.put(path.join(s.backingDir, 'Locked', 'Inner', 'a.txt'), 'a');
            chmodSync(path.join(s.backingDir, 'Locked', 'Inner'), 0o555);
            chmodSync(path.join(s.backingDir, 'Locked'), 0o555);
            s.stateDb.setMeta('driveLayout', 'virtual');
            // Cut short as Locked is made, then (Locked being there) as Inner is made
            for (let run = 0; run < 2; run++) {
                const crash = acrossDisks({
                    onStep: (step) => {
                        if (step === 'made') throw new Error('killed');
                    },
                });
                await expect(s.move('plain', crash)).rejects.toThrow('killed');
            }
            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(readFileSync(path.join(s.syncDir, 'Locked', 'Inner', 'a.txt'), 'utf8')).toBe('a');
            expect(modeOf(path.join(s.syncDir, 'Locked'))).toBe(0o555);
            expect(modeOf(path.join(s.syncDir, 'Locked', 'Inner'))).toBe(0o555);
            expect(readdirSync(s.backingDir)).toEqual([]);
        });

        test('a read-only folder holding a fifo is left behind with the fifo, and the move completes', async () => {
            const s = setup();
            mkdirSync(s.backingDir, { recursive: true });
            s.put(path.join(s.backingDir, 'Locked', 'a.txt'), 'a');
            expect(Bun.spawnSync(['mkfifo', path.join(s.backingDir, 'Locked', 'pipe')]).exitCode).toBe(0);
            chmodSync(path.join(s.backingDir, 'Locked'), 0o555);
            s.stateDb.setMeta('driveLayout', 'virtual');

            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(readDriveLayout(s.stateDb)).toBe('plain');
            expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
            expect(readFileSync(path.join(s.syncDir, 'Locked', 'a.txt'), 'utf8')).toBe('a');
            expect(lstatSync(path.join(s.backingDir, 'Locked', 'pipe')).isFIFO()).toBe(true);
            expect(modeOf(path.join(s.backingDir, 'Locked'))).toBe(0o555);
            expect(modeOf(path.join(s.syncDir, 'Locked'))).toBe(0o555);
            expect(s.logs.some((l) => l.startsWith('warn') && l.includes('Locked'))).toBe(true);
            expect(await s.move('plain', acrossDisks())).toBe('already');
        });

        test('a long name copied across disks keeps its name', async () => {
            const s = setup();
            mkdirSync(s.backingDir, { recursive: true });
            const long = `${'M'.repeat(251)}.txt`;
            s.put(path.join(s.backingDir, long), 'synced');
            s.stateDb.setMeta('driveLayout', 'virtual');
            expect(await s.move('plain', acrossDisks())).toBe('moved');
            expect(readFileSync(path.join(s.syncDir, long), 'utf8')).toBe('synced');
        });

        test('a fifo is left where it is and logged; everything else moves', async () => {
            const s = setup();
            mkdirSync(s.backingDir, { recursive: true });
            s.put(path.join(s.backingDir, 'Docs', 'a.txt'), 'a');
            expect(Bun.spawnSync(['mkfifo', path.join(s.backingDir, 'Docs', 'pipe')]).exitCode).toBe(0);
            s.stateDb.setMeta('driveLayout', 'virtual');

            expect(await s.move('plain', acrossDisks())).toBe('moved');

            expect(readFileSync(path.join(s.syncDir, 'Docs', 'a.txt'), 'utf8')).toBe('a');
            expect(lstatSync(path.join(s.backingDir, 'Docs', 'pipe')).isFIFO()).toBe(true);
            expect(existsSync(path.join(s.syncDir, 'Docs', 'pipe'))).toBe(false);
            expect(s.logs.some((l) => l.startsWith('warn') && l.includes('pipe'))).toBe(true);
        });
    });
});

describe('mergeInto', () => {
    test('a second name of the same file, or an identical copy, is dropped instead of kept twice', () => {
        const s = setup();
        const [from, to] = [path.join(s.root, 'from'), path.join(s.root, 'to')];
        s.put(path.join(from, 'linked.txt'), 'x');
        s.put(path.join(to, 'other.txt'), 'y');
        linkSync(path.join(from, 'linked.txt'), path.join(to, 'linked.txt'));
        s.put(path.join(from, 'copy.txt'), 'same', 1_700_000_000);
        s.put(path.join(to, 'copy.txt'), 'same', 1_700_000_000);
        // The same bytes with another time (a disk that rounds times) are the same file too
        s.put(path.join(from, 'touched.txt'), 'same', 1_700_000_000);
        s.put(path.join(to, 'touched.txt'), 'same', 1_700_000_002);
        s.put(path.join(from, 'differs.txt'), 'abcd', 1_700_000_000);
        s.put(path.join(to, 'differs.txt'), 'abce', 1_700_000_000);
        // The same bytes with another mode (an executable bit) are a different file
        s.put(path.join(from, 'run.sh'), 'echo', 1_700_000_000, 0o755);
        s.put(path.join(to, 'run.sh'), 'echo', 1_700_000_000, 0o644);
        for (const name of ['linked.txt', 'copy.txt', 'touched.txt', 'differs.txt', 'run.sh']) {
            mergeInto(path.join(from, name), path.join(to, name), { now: when });
        }
        expect(readdirSync(from)).toEqual([]);
        expect(readdirSync(to).sort()).toEqual(
            [
                'copy.txt',
                'differs.txt',
                formatConflictFileName('differs.txt', when),
                'linked.txt',
                'other.txt',
                'run.sh',
                formatConflictFileName('run.sh', when),
                'touched.txt',
            ].sort(),
        );
    });
});

// Issue #30: the plain sync folder moved to a new place, by the same mover
describe('relocateFiles', () => {
    const acrossDisks = (extra: MoveSeams = {}): MoveSeams => ({
        moveSameDisk: () => {
            throw exdev();
        },
        ...extra,
    });
    const relocation = (s: ReturnType<typeof setup>) => {
        const to = path.join(s.root, 'Elsewhere');
        const relocate = (seams?: MoveSeams) =>
            relocateFiles({ stateDb: s.stateDb, from: s.syncDir, to, logger: s.logger, now: when, seams });
        return { to, relocate };
    };

    test('across disks: copied and verified file by file, sources removed, the new folder saved', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        s.record('Docs/report.odt');
        const before = snapshot(s.syncDir);
        const records = s.stateDb.getAllItems();
        const { to, relocate } = relocation(s);

        await relocate(acrossDisks());

        expect(snapshot(to)).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(s.stateDb.getSettings().syncDir).toBe(to);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).toBeNull();
        expect(s.stateDb.getAllItems()).toEqual(records);
    });

    test('a crash part way is finished at the next start, which saves the new folder', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir, { folderTimes: false });
        const { to, relocate } = relocation(s);
        let n = 0;
        const crash = acrossDisks({
            onStep: (step) => {
                if (step === 'placed' && ++n === 2) throw new Error('killed');
            },
        });
        await expect(relocate(crash)).rejects.toThrow('killed');
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        expect(JSON.parse(s.stateDb.getMeta(SYNC_DIR_MOVING)!)).toEqual({ from: s.syncDir, to });

        expect(await finishRelocation({ stateDb: s.stateDb, logger: s.logger, seams: acrossDisks() })).toBe(true);
        expect(snapshot(to, { folderTimes: false })).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(s.stateDb.getSettings().syncDir).toBe(to);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).toBeNull();
        expect(await finishRelocation({ stateDb: s.stateDb, logger: s.logger })).toBe(false);
    });

    test('running out of space stops with every file whole in one place or the other, and the move still marked', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const { to, relocate } = relocation(s);
        let copies = 0;
        const { copyFileSync } = await import('node:fs');
        await expect(
            relocate(
                acrossDisks({
                    copyFile: (from, dest) => {
                        if (++copies === 2) {
                            writeFileSync(dest, 'part');
                            throw enospc();
                        }
                        copyFileSync(from, dest);
                    },
                }),
            ),
        ).rejects.toThrow(/ENOSPC/);
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).not.toBeNull();
        const moved = snapshot(to);
        const left = snapshot(s.syncDir);
        for (const [rel, entry] of Object.entries(before)) {
            if (!entry.startsWith('dir')) expect([rel, left[rel] ?? moved[rel]]).toEqual([rel, entry]);
        }
        expect(Object.keys(moved).filter((rel) => rel.includes('.proton-drive-tmp-move-'))).toEqual([]);
    });

    test('a new folder that already holds files is refused before anything happens; one holding only our own leftovers is not', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const { to, relocate } = relocation(s);
        s.put(path.join(to, 'mine.txt'), "the user's own");
        await expect(relocate()).rejects.toThrow(/Choose an empty folder, or a new one: .* already holds files/);
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readdirSync(to)).toEqual(['mine.txt']);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).toBeNull();
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);

        rmSync(path.join(to, 'mine.txt'));
        s.put(path.join(to, '.proton-drive-tmp-move-0123456789abcdef'), 'a copy a crash left');
        await relocate();
        expect(readFileSync(path.join(to, 'Docs', 'report.odt'), 'utf8')).toBe('report');
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(s.stateDb.getSettings().syncDir).toBe(to);
    });

    test('a record whose file was already gone is dropped, so the file comes back rather than being trashed', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'here.txt'), 'here');
        s.record('here.txt');
        s.record('deleted while the app was closed.txt');
        const { relocate } = relocation(s);
        await relocate();
        expect(s.stateDb.getAllItems().map((r) => r.localRelPath)).toEqual(['here.txt']);
    });
});
