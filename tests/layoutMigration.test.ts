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
import { DifferentDiskError, LAYOUT_MOVING, type MoveSeams, moveToLayout } from '../src/sync/layoutMigration';
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

    test('a rename refused as cross-device before anything moved is a different disk too, and nothing moves', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);

        expect(await s.move('virtual', { moveSameDisk: () => { throw exdev(); } })).toBe('different-disk');

        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
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

    test('nothing in the backing store is replaced: a folder is merged into, a taken name steps aside', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'Docs', 'same.txt'), 'synced copy');
        s.put(path.join(s.syncDir, 'Docs', 'new.txt'), 'new');
        s.put(path.join(s.syncDir, 'top.txt'), 'synced top');
        s.put(path.join(s.backingDir, 'Docs', 'same.txt'), 'was in the store');
        s.put(path.join(s.backingDir, 'Docs', 'kept.txt'), 'kept');
        s.put(path.join(s.backingDir, 'top.txt'), 'was in the store too');

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
            let partial = '';
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
            expect(path.dirname(partial).startsWith(s.syncDir)).toBe(true);
            expect(path.basename(partial)).toStartWith('.proton-drive-tmp-');

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
        s.put(path.join(from, 'touched.txt'), 'same', 1_700_000_000);
        s.put(path.join(to, 'touched.txt'), 'same', 1_700_000_001);
        for (const name of ['linked.txt', 'copy.txt', 'touched.txt']) {
            mergeInto(path.join(from, name), path.join(to, name), { now: when });
        }
        expect(readdirSync(from)).toEqual([]);
        expect(readdirSync(to).sort()).toEqual(
            ['copy.txt', 'linked.txt', 'other.txt', formatConflictFileName('touched.txt', when), 'touched.txt'].sort(),
        );
    });
});
