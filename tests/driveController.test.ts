import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    chownSync,
    existsSync,
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

import { startControlServer } from '../src/daemon/controlServer';
import { driveSettings, settingsRoute } from '../src/daemon/settingsRoute';
import { DriveController, type DriveSupervisor } from '../src/daemon/driveController';
import type { VfsStatus } from '../src/daemon/vfsSupervisor';
import { readDriveLayout } from '../src/sync/driveMode';
import { LAYOUT_MOVING, type MoveSeams, SYNC_DIR_MOVING, unsafeFolderReason } from '../src/sync/layoutMigration';
import { moveWithoutReplacing } from '../src/sync/localMove';
import { LOCAL_MOVE_IN_PROGRESS, ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { makeMockDrive } from './helpers/mockDrive';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

const modeOf = (p: string) => statSync(p).mode & 0o777;
const exdev = () => Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

// Every entry under a folder: kind, mode, mtime, size, and content or link target. A folder whose copy across disks was
// cut short by a crash gets a new time: its source's changed as its files went.
function snapshot(root: string, opts: { folderTimes?: boolean } = {}): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const rel = path.relative(root, full);
            const st = lstatSync(full);
            const mode = (st.mode & 0o7777).toString(8);
            if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(full)} ${st.mtimeMs}`;
            else if (st.isDirectory()) {
                out[rel] = opts.folderTimes === false ? `dir ${mode}` : `dir ${mode} ${st.mtimeMs}`;
                walk(full);
            } else out[rel] = `file ${mode} ${st.mtimeMs} ${st.size} ${readFileSync(full, 'base64')}`;
        }
    };
    walk(root);
    return out;
}

// Waits until nothing runs in the engine (a pass started in the background, say)
async function settled(engine: ProtonDriveSyncEngine): Promise<void> {
    await engine.holdForMove();
    engine.releaseHold();
}

// The drive's helper, faked: start mounts, stop unmounts (held up while stopGate is set)
class FakeSupervisor implements DriveSupervisor {
    events: string[] = [];
    mounted = false;
    stopGate: Promise<void> | null = null;
    stillMounted: string | null = null; // what release() answers
    constructor(readonly mountpoint: string) {}
    async start(): Promise<void> {
        this.events.push('start');
        this.mounted = true;
    }
    async stop(): Promise<void> {
        this.events.push('stop');
        if (this.stopGate) await this.stopGate;
        this.mounted = false;
    }
    async release(): Promise<string | null> {
        await this.stop();
        this.events.push('release');
        return this.stillMounted;
    }
    async mountAgain(): Promise<void> {
        this.events.push('mountAgain');
        this.mounted = true;
    }
    status(): VfsStatus {
        return { mode: 'virtual', mounted: this.mounted, reason: this.mounted ? null : 'ejected' };
    }
}

function setup(opts: { fuseOk?: boolean; wanted?: boolean; loggedIn?: boolean; moveSeams?: MoveSeams; holdTimeoutMs?: number } = {}) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pd-drive-')));
    const appDir = path.join(root, 'app');
    const backingDir = path.join(appDir, 'files');
    const syncDir = path.join(root, 'ProtonDrive');
    mkdirSync(appDir);
    mkdirSync(syncDir);
    const stateDb = new SyncStateDatabase(path.join(appDir, 'state.sqlite'));
    stateDb.updateSettings({ syncDir, notificationsEnabled: false });
    if (opts.wanted === false) stateDb.setMeta('virtualDriveWanted', '0');
    const drive = makeMockDrive();
    const logs: string[] = [];
    const logger = {
        debug: () => {},
        info: (m: string) => logs.push(`info ${m}`),
        warn: (m: string) => logs.push(`warn ${m}`),
        error: (m: string) => logs.push(`error ${m}`),
    };
    const supervisors: FakeSupervisor[] = [];
    let engine!: ProtonDriveSyncEngine;
    let controller!: DriveController;
    // A daemon start: a new engine and controller on the same database and folders
    const start = (more: { fuseOk?: boolean; moveSeams?: MoveSeams } = {}) => {
        engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => opts.loggedIn ?? false }, stateDb, logger, {
            backingDir,
            moveSeams: more.moveSeams ?? opts.moveSeams,
        });
        controller = new DriveController({
            stateDb,
            engine,
            appDir,
            backingDir,
            logger,
            fuseOk: more.fuseOk ?? opts.fuseOk ?? true,
            makeSupervisor: (mountpoint) => {
                const s = new FakeSupervisor(mountpoint);
                supervisors.push(s);
                return s;
            },
            holdTimeoutMs: opts.holdTimeoutMs,
            moveSeams: more.moveSeams ?? opts.moveSeams,
        });
        const [startedEngine, startedController] = [engine, controller];
        cleanups.push(async () => {
            await startedController.stop();
            await settled(startedEngine);
            await startedEngine.stop();
        });
        return { engine, controller };
    };
    // What startSyncDaemon does with them
    const boot = async (more: { fuseOk?: boolean; moveSeams?: MoveSeams } = {}) => {
        const started = start(more);
        await started.controller.settleAtStart();
        await started.engine.start({ backgroundInitialReconcile: false });
        await started.controller.startDrive(true);
        return started;
    };
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
    const put = (p: string, content: string, mtimeSec = 1_700_000_000) => {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
        utimesSync(p, mtimeSec, mtimeSec);
    };
    const fillTree = (dir: string) => {
        put(path.join(dir, 'Docs', 'report.odt'), 'report', 1_700_000_000.25);
        put(path.join(dir, 'Docs', 'Deep', 'notes.txt'), 'deep', 1_700_000_100);
        put(path.join(dir, 'run.sh'), '#!/bin/sh\n', 1_700_000_200);
        chmodSync(path.join(dir, 'run.sh'), 0o755);
        mkdirSync(path.join(dir, 'Empty'));
        symlinkSync('Docs/report.odt', path.join(dir, 'link'));
        utimesSync(path.join(dir, 'Docs'), 1_700_000_300, 1_700_000_300);
    };
    // The virtual layout as an earlier start left it: the files in the store, the mount point empty and 0555
    const leftVirtual = () => {
        fillTree(backingDir);
        chmodSync(syncDir, 0o555);
        stateDb.setMeta('driveLayout', 'virtual');
    };
    return {
        root,
        appDir,
        backingDir,
        syncDir,
        stateDb,
        drive,
        logs,
        supervisors,
        start,
        boot,
        put,
        fillTree,
        leftVirtual,
        get engine() {
            return engine;
        },
        get controller() {
            return controller;
        },
    };
}

describe('DriveController at start', () => {
    test('with the helper missing, files left in the store move back into the plain folder', async () => {
        const s = setup({ fuseOk: false });
        s.leftVirtual();
        const before = snapshot(s.backingDir);

        await s.boot();

        expect(snapshot(s.syncDir)).toEqual(before);
        expect(modeOf(s.syncDir)).toBe(0o755);
        expect(readdirSync(s.backingDir)).toEqual([]);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'fuse-unavailable' });
        // Whatever was mounted there went first, and no drive is started over the plain folder
        expect(s.supervisors.map((x) => x.events)).toEqual([['stop', 'release']]);
    });

    test('with FUSE available, a plain folder moves into the store and the drive mounts', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);

        await s.boot();

        expect(snapshot(s.backingDir)).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(s.supervisors.map((x) => [x.mountpoint, x.events])).toEqual([[s.syncDir, ['start']]]);
        expect(s.controller.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
    });

    test('switched off, a plain folder stays as it is', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        await s.boot();
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(s.supervisors).toEqual([]);
        expect(s.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
    });

    test('a sync folder on another disk stays plain, saying so', async () => {
        const s = setup({ moveSeams: { deviceOf: (p) => (p.includes(`${path.sep}app`) ? 2 : 1) } });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        await s.boot();
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.supervisors).toEqual([]);
        expect(s.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'different-disk' });
    });

    test('an interrupted move is finished first, then the files move to match the mode', async () => {
        const s = setup({ fuseOk: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        // Cut short moving into the store: one entry there, the rest still in the sync folder
        mkdirSync(s.backingDir, { recursive: true });
        moveWithoutReplacing(path.join(s.syncDir, 'Docs'), path.join(s.backingDir, 'Docs'));
        s.stateDb.setMeta(LAYOUT_MOVING, 'virtual');

        await s.boot();

        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(s.logs.some((l) => l.includes('Finishing'))).toBe(true);
    });

    test('a local move cut short by a crash is finished before any file moves', async () => {
        const s = setup();
        s.put(path.join(s.syncDir, 'Docs', 'a.txt'), 'a');
        s.stateDb.upsertItem({
            localRelPath: 'Docs/b.txt',
            nodeUid: 'vol~Docs/a.txt',
            parentNodeUid: 'vol~Docs',
            type: 'file',
            localSha1: null,
            remoteSha1: null,
            localMtimeMs: 1,
            remoteMtimeMs: 1,
            size: 1,
            syncStatus: 'synced',
            lastError: null,
        });
        s.stateDb.setMeta(LOCAL_MOVE_IN_PROGRESS, JSON.stringify({ from: 'Docs/a.txt', to: 'Docs/b.txt', replace: false }));
        const seenWhenMoving: Array<string | null> = [];
        await s.boot({ moveSeams: { onStep: () => seenWhenMoving.push(s.stateDb.getMeta(LOCAL_MOVE_IN_PROGRESS)) } });

        expect(seenWhenMoving.length).toBeGreaterThan(0);
        expect(seenWhenMoving.every((v) => v === null)).toBe(true);
        expect(readFileSync(path.join(s.backingDir, 'Docs', 'b.txt'), 'utf8')).toBe('a');
        expect(existsSync(path.join(s.backingDir, 'Docs', 'a.txt'))).toBe(false);
    });

    test('starting again moves nothing more', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        await s.boot();
        const after = snapshot(s.backingDir);
        await s.controller.stop();
        await s.engine.stop();

        let steps = 0;
        await s.boot({ moveSeams: { onStep: () => steps++ } });
        expect(steps).toBe(0);
        expect(snapshot(s.backingDir)).toEqual(after);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
    });

    test('a move into the store that fails part way is undone, and the plain folder syncs on', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        let failed = false;
        await s.boot({
            moveSeams: {
                onStep: (step) => {
                    if (step === 'entry' && !failed) {
                        failed = true;
                        throw new Error('EACCES: permission denied');
                    }
                },
            },
        });

        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(s.supervisors.filter((x) => x.events.includes('start'))).toEqual([]);
        expect(s.controller.status()).toMatchObject({ mode: 'plain', mounted: false, reason: 'move-failed', error: 'EACCES: permission denied' });
        expect(() => s.engine.vfsChildren('')).not.toThrow(); // not held
    });

    test('a cross-device refusal part way into the store is undone, and the folder stays plain on its disk', async () => {
        const s = setup();
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        let moves = 0;
        await s.boot({
            moveSeams: {
                moveSameDisk: (from, to) => {
                    if (++moves === 2) throw exdev();
                    return moveWithoutReplacing(from, to);
                },
            },
        });
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'different-disk' });
    });

    test('a move out of the store that fails stays marked, the engine stays held, and the next start finishes it', async () => {
        const s = setup({ fuseOk: false });
        s.leftVirtual();
        const before = snapshot(s.backingDir, { folderTimes: false });
        let copies = 0;
        const { copyFileSync } = await import('node:fs');
        const { engine, controller } = await s.boot({
            moveSeams: {
                moveSameDisk: () => {
                    throw exdev();
                },
                copyFile: (from, to) => {
                    if (++copies === 2) throw enospc();
                    copyFileSync(from, to);
                },
            },
        });

        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('plain');
        expect(controller.status()).toMatchObject({ reason: 'move-failed', mounted: false });
        expect(controller.status().error).toMatch(/ENOSPC/);
        expect(() => engine.vfsChildren('')).toThrow('Proton Drive is busy moving files');

        await controller.stop();
        await engine.stop();
        const restarted = await s.boot({ fuseOk: false });
        expect(snapshot(s.syncDir, { folderTimes: false })).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(restarted.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'fuse-unavailable' });
        expect(() => restarted.engine.vfsChildren('')).not.toThrow();
    });
});

describe('DriveController: a store already holding one of the sync folder\'s names (C1, m3)', () => {
    test('stops the move before anything moves: every file stays in the plain folder with its record', async () => {
        const s = setup({ loggedIn: false });
        for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) s.put(path.join(s.syncDir, `${n}.txt`), `content ${n}`);
        const first = readdirSync(s.syncDir)[0]!;
        s.put(path.join(s.backingDir, first), `content ${first[0]}`); // an identical copy already in the store
        s.stateDb.upsertItem({
            localRelPath: first,
            nodeUid: `uid-${first}`,
            parentNodeUid: null,
            type: 'file',
            localSha1: null,
            remoteSha1: null,
            localMtimeMs: 1,
            remoteMtimeMs: 1,
            size: 9,
            syncStatus: 'synced',
            lastError: null,
        });
        const before = snapshot(s.syncDir);
        const store = snapshot(s.backingDir);
        const { controller } = await s.boot({ moveSeams: { moveSameDisk: () => { throw exdev(); } } });

        expect(snapshot(s.syncDir)).toEqual(before);
        expect(snapshot(s.backingDir)).toEqual(store);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(controller.status()).toMatchObject({ mode: 'plain', mounted: false, reason: 'move-failed' });
        expect(controller.status().error).toMatch(new RegExp(`already holds ${first.replace('.', '\\.')}`));
        for (const item of s.stateDb.getAllItems()) expect(existsSync(path.join(s.syncDir, item.localRelPath))).toBe(true);
    });
});

describe('DriveController: the switch when things go wrong', () => {
    test('a switch that waits too long for the engine changes nothing, not even the setting, and says why', async () => {
        const s = setup({ loggedIn: true, wanted: false, holdTimeoutMs: 50 });
        s.fillTree(s.syncDir);
        const { engine, controller } = await s.boot();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const iterate = s.drive.sdk.iterateFolderChildren.bind(s.drive.sdk);
        (s.drive.sdk as { iterateFolderChildren: unknown }).iterateFolderChildren = async function* (parent: Parameters<typeof iterate>[0]) {
            await gate;
            yield* iterate(parent);
        };
        const pass = engine.reconcileNow();
        try {
            await expect(controller.setVirtualDriveWanted(true)).rejects.toThrow(/still busy/);
            expect(s.stateDb.getMeta('virtualDriveWanted')).toBe('0');
            expect(readDriveLayout(s.stateDb)).toBe('plain');
            expect(controller.status()).toMatchObject({ reason: 'move-failed' });
            expect(controller.status().error).toMatch(/still busy/);
        } finally {
            release();
            await pass;
        }
    });

    test('a drive mounted again after its release failed shows as mounted, not as the old failure', async () => {
        const s = setup();
        s.leftVirtual();
        const { controller } = await s.boot();
        s.supervisors[0]!.stillMounted = 'Something else (fuse.sshfs) is mounted there';
        await expect(controller.setVirtualDriveWanted(false)).rejects.toThrow(/sshfs/);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(s.supervisors).toHaveLength(2); // the drive runs again on the store
        expect(controller.status()).toMatchObject({ mode: 'virtual', mounted: true, reason: null });
    });
});

describe('DriveController: switching the virtual drive on and off', () => {
    test('a round trip, plain to virtual to plain, leaves every file as it was', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const { controller } = await s.boot();

        await controller.setVirtualDriveWanted(true);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(snapshot(s.backingDir)).toEqual(before);
        expect(modeOf(s.syncDir)).toBe(0o555);
        expect(controller.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
        expect(s.stateDb.getMeta('virtualDriveWanted')).toBe('1');

        await controller.setVirtualDriveWanted(false);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(modeOf(s.syncDir)).toBe(0o755);
        expect(readdirSync(s.backingDir)).toEqual([]);
        expect(s.supervisors.map((x) => x.events)).toEqual([['start', 'stop', 'release']]);
        expect(controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
    });

    test('while the switch runs, a drive route answers EIO busy and changes nothing', async () => {
        const s = setup();
        s.leftVirtual();
        const { engine, controller } = await s.boot();
        const socketPath = path.join(s.root, 'control.sock');
        const server = await startControlServer({ socketPath, engine });
        cleanups.push(() => server.stop());
        const call = (route: string, init: RequestInit = {}) =>
            fetch(`http://localhost${route}`, { unix: socketPath, ...init } as RequestInit);

        let release!: () => void;
        s.supervisors[0]!.stopGate = new Promise<void>((resolve) => (release = resolve));
        const switching = controller.setVirtualDriveWanted(false);
        await Bun.sleep(20);

        expect(controller.status().reason).toBe('moving');
        const renamed = await call('/vfs/rename', { method: 'POST', body: JSON.stringify({ from: 'Docs/report.odt', to: 'Docs/x.odt' }) });
        expect(renamed.status).toBe(400);
        expect(await renamed.json()).toEqual({ error: 'Proton Drive is busy moving files', code: 'EIO' });
        const listed = await call('/vfs/children?path=Docs');
        expect(await listed.json()).toEqual({ error: 'Proton Drive is busy moving files', code: 'EIO' });
        const freed = await call('/availability', { method: 'POST', body: JSON.stringify({ path: 'Docs', action: 'free' }) });
        expect(freed.status).toBe(400);
        expect(readFileSync(path.join(s.backingDir, 'Docs', 'report.odt'), 'utf8')).toBe('report');
        expect(existsSync(path.join(s.backingDir, 'Docs', 'x.odt'))).toBe(false);
        await expect(controller.setVirtualDriveWanted(true)).rejects.toThrow('Proton Drive is busy moving files');
        await expect(controller.mountAgain()).rejects.toThrow('Proton Drive is busy moving files');
        await expect(controller.relocate(path.join(s.root, 'Elsewhere'))).rejects.toThrow('Proton Drive is busy moving files');
        expect(await controller.relocate(`${s.syncDir}/`)).toBe(s.syncDir); // a settings save naming the same folder

        release();
        await switching;
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(readFileSync(path.join(s.syncDir, 'Docs', 'report.odt'), 'utf8')).toBe('report');
        expect(existsSync(path.join(s.syncDir, 'Docs', 'x.odt'))).toBe(false);
    });

    test('synced files go through a round trip with nothing uploaded, downloaded again or trashed', async () => {
        const s = setup({ loggedIn: true, wanted: false });
        s.drive.add('Docs/a.txt', 'a');
        s.drive.add('Photos/p.jpg', 'p');
        const { engine, controller } = await s.boot();
        engine.availability.setPin(s.drive.root.uid, 'pinned', false);
        await engine.reconcileNow();
        await engine.reconcileNow();
        expect(readFileSync(path.join(s.syncDir, 'Docs', 'a.txt'), 'utf8')).toBe('a');
        const downloads = [...s.drive.calls.downloads];

        await controller.setVirtualDriveWanted(true);
        await settled(engine);
        await engine.start({ backgroundInitialReconcile: false });
        expect(readFileSync(path.join(s.backingDir, 'Docs', 'a.txt'), 'utf8')).toBe('a');
        await controller.setVirtualDriveWanted(false);
        await settled(engine);
        await engine.start({ backgroundInitialReconcile: false });
        await settled(engine);

        expect(readFileSync(path.join(s.syncDir, 'Docs', 'a.txt'), 'utf8')).toBe('a');
        expect(readFileSync(path.join(s.syncDir, 'Photos', 'p.jpg'), 'utf8')).toBe('p');
        expect(s.drive.calls.uploads).toEqual([]);
        expect(s.drive.calls.trashed).toEqual([]);
        expect(s.drive.calls.downloads).toEqual(downloads);
    });

    test('a switch on that fails is undone and reported; switching off again clears the report', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        let failed = false;
        const { controller } = await s.boot({
            moveSeams: {
                onStep: (step) => {
                    if (step === 'entry' && !failed) {
                        failed = true;
                        throw new Error('EACCES: permission denied');
                    }
                },
            },
        });
        await expect(controller.setVirtualDriveWanted(true)).rejects.toThrow('EACCES: permission denied');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(controller.status()).toMatchObject({ mode: 'plain', mounted: false, reason: 'move-failed', error: 'EACCES: permission denied' });
        await controller.setVirtualDriveWanted(false);
        expect(controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
    });

    test('a switch that FUSE can not make changes nothing', async () => {
        const s = setup({ fuseOk: false, wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const { controller } = await s.boot();
        await controller.setVirtualDriveWanted(true);
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'fuse-unavailable' });
    });
});

describe('DriveController: relocating the drive folder', () => {
    test('in the virtual layout no file moves: the drive is unmounted, the old folder made normal, and mounted at the new one', async () => {
        const s = setup();
        s.leftVirtual();
        const store = snapshot(s.backingDir);
        const { controller } = await s.boot();
        const target = path.join(s.root, 'Elsewhere');

        expect(await controller.relocate(target)).toBe(target);

        expect(s.stateDb.getSettings().syncDir).toBe(target);
        expect(snapshot(s.backingDir)).toEqual(store);
        expect(modeOf(s.syncDir)).toBe(0o755);
        expect(s.supervisors.map((x) => [x.mountpoint, x.events])).toEqual([
            [s.syncDir, ['start', 'stop', 'release']],
            [target, ['start']],
        ]);
    });

    test('files that appear in the new folder while the drive is being unmounted keep it from mounting there (m3)', async () => {
        const s = setup();
        s.leftVirtual();
        const store = snapshot(s.backingDir);
        const { controller } = await s.boot();
        const target = path.join(s.root, 'Elsewhere');
        const release = s.supervisors[0]!.release.bind(s.supervisors[0]!);
        s.supervisors[0]!.release = async () => {
            s.put(path.join(target, 'saved meanwhile.txt'), "an app's"); // after the first look, before the mount
            return release();
        };

        await expect(controller.relocate(target)).rejects.toThrow(`Choose an empty folder, or a new one: ${target} already holds files`);

        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        expect(s.supervisors.map((x) => [x.mountpoint, x.events])).toEqual([
            [s.syncDir, ['start', 'stop', 'release']],
            [s.syncDir, ['start']],
        ]);
        expect(readFileSync(path.join(target, 'saved meanwhile.txt'), 'utf8')).toBe("an app's");
        expect(snapshot(s.backingDir)).toEqual(store);
    });

    test('the folder it already is, however it is written, changes nothing and leaves the drive mounted', async () => {
        const s = setup();
        s.leftVirtual();
        const { controller } = await s.boot();
        expect(await controller.relocate(`${s.syncDir}/`)).toBe(s.syncDir);
        expect(await controller.relocate(path.join(s.syncDir, '..', 'ProtonDrive'))).toBe(s.syncDir);
        expect(s.supervisors.map((x) => x.events)).toEqual([['start']]);
        expect(modeOf(s.syncDir)).toBe(0o555);
    });

    test('in the virtual layout, a folder inside the old one or holding it is refused, changing nothing', async () => {
        const s = setup();
        s.leftVirtual();
        const { controller } = await s.boot();
        await expect(controller.relocate(path.join(s.syncDir, 'Sub'))).rejects.toThrow(/inside/);
        await expect(controller.relocate(s.root)).rejects.toThrow(/inside|overlaps/);
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        expect(s.supervisors.map((x) => x.events)).toEqual([['start']]);
    });

    test('a folder overlapping the app dir or the backing store is refused, changing nothing', async () => {
        const s = setup();
        s.leftVirtual();
        const { controller } = await s.boot();
        for (const target of [s.appDir, s.backingDir, path.join(s.backingDir, 'Docs'), path.join(s.appDir, 'Drive'), s.root]) {
            await expect(controller.relocate(target)).rejects.toThrow(/overlaps/);
        }
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        expect(s.supervisors.map((x) => x.events)).toEqual([['start']]);
    });
});

describe('DriveController: a new folder must be missing or empty (S30)', () => {
    for (const layout of ['plain', 'virtual'] as const) {
        test(`in the ${layout} layout, a folder that already holds files is refused and nothing changes`, async () => {
            const s = setup(layout === 'plain' ? { wanted: false } : {});
            if (layout === 'virtual') s.leftVirtual();
            else s.fillTree(s.syncDir);
            const { engine, controller } = await s.boot();
            const where = layout === 'virtual' ? s.backingDir : s.syncDir;
            const before = snapshot(where);
            const to = path.join(s.root, 'Documents');
            s.put(path.join(to, 'mine.txt'), "the user's own");
            chmodSync(to, 0o755); // whatever the umask: a folder others can write is refused before it is looked into

            await expect(controller.relocate(to)).rejects.toThrow(`Choose an empty folder, or a new one: ${to} already holds files`);

            expect(snapshot(where)).toEqual(before);
            expect(readdirSync(to)).toEqual(['mine.txt']);
            expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
            expect(s.supervisors.map((x) => x.events)).toEqual(layout === 'virtual' ? [['start']] : []);
            expect(() => engine.vfsChildren('')).not.toThrow();

            // An empty one is fine
            rmSync(path.join(to, 'mine.txt'));
            expect(await controller.relocate(to)).toBe(to);
        });
    }
});

describe('DriveController: a plain relocation cut short', () => {
    test('is finished at the next start, before the files move to match the mode', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        const to = path.join(s.root, 'Elsewhere');
        // Cut short: one entry moved, the rest still in the old folder, the setting not yet saved
        mkdirSync(to);
        moveWithoutReplacing(path.join(s.syncDir, 'Docs'), path.join(to, 'Docs'));
        s.stateDb.setMeta(SYNC_DIR_MOVING, JSON.stringify({ from: s.syncDir, to }));

        const { controller } = await s.boot();

        expect(s.stateDb.getSettings().syncDir).toBe(to);
        expect(snapshot(to)).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).toBeNull();
        expect(controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
    });

    test('a relocation that stops part way keeps the engine held, saying why, until a start finishes it', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        let failing = true;
        const flaky: MoveSeams = {
            onStep: (step) => {
                if (step === 'entry' && failing) throw new Error('EIO: i/o error');
            },
        };
        const { engine, controller } = await s.boot({ moveSeams: flaky });
        const to = path.join(s.root, 'Elsewhere');

        await expect(controller.relocate(to)).rejects.toThrow('EIO: i/o error');
        expect(controller.status()).toMatchObject({ reason: 'move-failed', error: 'EIO: i/o error' });
        expect(() => engine.vfsChildren('')).toThrow('Proton Drive is busy moving files');
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        await expect(controller.relocate(path.join(s.root, 'Third'))).rejects.toThrow(/Move the Proton Drive folder back, or finish moving it/);

        failing = false;
        await controller.stop();
        await engine.stop();
        const restarted = await s.boot();
        expect(s.stateDb.getSettings().syncDir).toBe(to);
        expect(readdirSync(s.syncDir)).toEqual([]);
        expect(() => restarted.engine.vfsChildren('')).not.toThrow();
    });
});

// S31: finishing, retrying or moving back a move that stopped is an explicit action, over the control socket, never
// implied by a settings save, the switch or Mount again (a daemon start still finishes an interrupted move)
describe('Explicit actions for a move that stopped (S31)', () => {
    const over = (s: ReturnType<typeof setup>) => {
        const socketPath = path.join(s.root, 'control.sock');
        const settings = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch: (req) => settingsRoute(req, { stateDb: s.stateDb, drive: s.controller, engine: s.engine }),
        });
        cleanups.push(() => void settings.stop(true));
        const json = async (r: Response) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> });
        return {
            start: async () => {
                const server = await startControlServer({
                    socketPath,
                    engine: s.engine,
                    mountAgain: () => s.controller.mountAgain(),
                    driveMove: (action, from, to) => s.controller.resolveMove(action, from, to),
                    driveSettings: (change) => driveSettings(change, { stateDb: s.stateDb, drive: s.controller, engine: s.engine }),
                });
                cleanups.push(() => server.stop());
            },
            saveSettings: (body: unknown) =>
                fetch(`http://127.0.0.1:${settings.port}/api/settings`, { method: 'POST', body: JSON.stringify(body) }).then(json),
            driveSettings: (body: unknown) =>
                fetch('http://localhost/drive/settings', { unix: socketPath, method: 'POST', body: JSON.stringify(body) } as RequestInit).then(json),
            move: (body: unknown) =>
                fetch('http://localhost/drive/move', { unix: socketPath, method: 'POST', body: JSON.stringify(body) } as RequestInit).then(json),
            mountAgain: () => fetch('http://localhost/vfs/mount', { unix: socketPath, method: 'POST' } as RequestInit).then(json),
        };
    };

    // Switched off, the move out of the store stops part way (one disk, so no copy is involved)
    const stuckMovingOut = async () => {
        const s = setup();
        s.leftVirtual();
        const before = snapshot(s.backingDir);
        let failing = false;
        const started = await s.boot({
            moveSeams: {
                onStep: (step) => {
                    if (step === 'entry' && failing) throw new Error('EIO: i/o error');
                },
            },
        });
        const api = over(s);
        await api.start();
        failing = true;
        expect((await api.driveSettings({ virtualDriveWanted: false })).json.switchError).toBe('EIO: i/o error');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('plain');
        expect(() => started.engine.vfsChildren('')).toThrow('Proton Drive is busy moving files');
        return { s, before, api, ...started, recover: () => (failing = false) };
    };

    test('a stuck layout move is named in the status with its actions; the switch and Mount again refuse, pointing to them', async () => {
        const { s, api, controller } = await stuckMovingOut();
        expect(controller.status()).toMatchObject({
            reason: 'move-failed',
            error: 'EIO: i/o error',
            move: { kind: 'layout', from: s.backingDir, to: s.syncDir, error: 'EIO: i/o error', actions: ['finish', 'move-back'] },
        });
        const switched = await api.driveSettings({ virtualDriveWanted: true });
        expect(switched.status).toBe(200);
        expect(String(switched.json.switchError)).toMatch(/Finish moving files, or Move files back/);
        expect(s.stateDb.getMeta('virtualDriveWanted')).toBe('0');
        const mounted = await api.mountAgain();
        expect(mounted.status).toBe(400);
        expect(String(mounted.json.error)).toMatch(/Finish moving files, or Move files back/);
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('plain');
    });

    test('finish completes the move out', async () => {
        const { s, before, api, controller, engine, recover } = await stuckMovingOut();
        recover();
        expect(await api.move({ action: 'finish' })).toEqual({ status: 200, json: { ok: true } });
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
        expect(() => engine.vfsChildren('')).not.toThrow();
    });

    test('move back returns the files to the drive, mounts it, and the switch shows it on', async () => {
        const { s, before, api, controller, recover } = await stuckMovingOut();
        recover();
        expect((await api.move({ action: 'move-back' })).status).toBe(200);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(snapshot(s.backingDir)).toEqual(before);
        expect(s.stateDb.getMeta('virtualDriveWanted')).toBe('1');
        expect(controller.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
    });

    for (const seenAs of ['another device', 'a cross-device refusal'] as const) {
        test(`moving back while a move out to another disk is stuck (${seenAs}) asks to free space there and moves nothing more`, async () => {
            const s = setup();
            s.leftVirtual();
            const before = snapshot(s.backingDir, { folderTimes: false });
            let full = false;
            let copies = 0;
            const { copyFileSync } = await import('node:fs');
            const { controller } = await s.boot({
                moveSeams: {
                    // A bind mount: one device number, yet rename(2) refuses
                    deviceOf: (p) => (seenAs === 'another device' && p.startsWith(s.syncDir) ? 2 : 1),
                    moveSameDisk: () => {
                        throw exdev();
                    },
                    copyFile: (from, to) => {
                        if (full && ++copies > 2) throw enospc();
                        copyFileSync(from, to);
                    },
                },
            });
            const api = over(s);
            await api.start();
            full = true;
            expect(String((await api.driveSettings({ virtualDriveWanted: false })).json.switchError)).toMatch(/ENOSPC/);
            const copiesWhenStuck = copies;
            if (seenAs === 'another device') {
                expect(controller.status().move?.actions).toEqual(['finish']);
            }

            const back = await api.move({ action: 'move-back' });
            expect(back.status).toBe(seenAs === 'another device' ? 409 : 500);
            expect(String(back.json.error)).toMatch(/Free space on the disk holding .*ProtonDrive/);
            expect(copies).toBe(copiesWhenStuck);
            expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBe('plain');
            expect(s.stateDb.getMeta('virtualDriveWanted')).toBe('0');

            full = false; // space freed
            expect((await api.move({ action: 'finish' })).status).toBe(200);
            expect(readDriveLayout(s.stateDb)).toBe('plain');
            expect(snapshot(s.syncDir, { folderTimes: false })).toEqual(before);
        });
    }

    test('a move into the drive that failed and was undone offers retry; Mount again refuses until then', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        let failures = 1; // the move in fails once; the undo goes through
        const { controller } = await s.boot({
            moveSeams: {
                onStep: (step) => {
                    if (step === 'entry' && failures > 0) {
                        failures--;
                        throw new Error('EIO: i/o error');
                    }
                },
            },
        });
        const api = over(s);
        await api.start();
        expect((await api.driveSettings({ virtualDriveWanted: true })).json.switchError).toBe('EIO: i/o error');
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(s.stateDb.getMeta(LAYOUT_MOVING)).toBeNull();
        expect(controller.status().move).toEqual({ kind: 'layout', from: s.syncDir, to: s.backingDir, error: 'EIO: i/o error', actions: ['retry'] });
        const mounted = await api.mountAgain();
        expect(mounted.status).toBe(400);
        expect(String(mounted.json.error)).toMatch(/what can be done: retry/);
        expect((await api.move({ action: 'retry' })).status).toBe(200);
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
        expect(snapshot(s.backingDir)).toEqual(before);
        expect(controller.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
    });

    test('with nothing waiting, or a malformed action, the route refuses and changes nothing', async () => {
        const s = setup({ wanted: false });
        await s.boot();
        const api = over(s);
        await api.start();
        expect(await api.move({ action: 'finish' })).toEqual({
            status: 409,
            json: { error: 'Nothing is waiting to be finished or moved back', move: null },
        });
        expect((await api.move({ action: 'replace' })).status).toBe(400);
        expect((await api.move({ action: 'retry', from: 3 })).status).toBe(400);
    });

    // A relocation of the plain folder stops part way (an injected I/O error)
    const stoppedRelocation = async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        const before = snapshot(s.syncDir);
        let failing = true;
        await s.boot({
            moveSeams: {
                onStep: (step) => {
                    if (step === 'entry' && failing) throw new Error('EIO: i/o error');
                },
            },
        });
        const api = over(s);
        await api.start();
        const to = path.join(s.root, 'Elsewhere');
        const moved = await api.driveSettings({ syncDir: to });
        expect(moved.status).toBe(200);
        expect(moved.json.folderError).toBe('EIO: i/o error');
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).not.toBeNull();
        return { s, before, api, to, recover: () => (failing = false) };
    };

    test('a settings save naming the folder as it is stored changes nothing on disk, and saves the rest', async () => {
        const { s, api, to } = await stoppedRelocation();
        const old = snapshot(s.syncDir);
        const moved = snapshot(to);
        const res = await api.saveSettings({ syncDir: s.syncDir, notificationsEnabled: true, conflictStrategy: 'keep-local' });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, folderError: null });
        expect(snapshot(s.syncDir)).toEqual(old);
        expect(snapshot(to)).toEqual(moved);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).not.toBeNull();
        expect(s.stateDb.getSettings()).toMatchObject({ notificationsEnabled: true, conflictStrategy: 'keep-local', syncDir: s.syncDir });
        expect(s.controller.status().move).toEqual({
            kind: 'relocation',
            from: s.syncDir,
            to,
            error: 'EIO: i/o error',
            actions: ['move-back', 'retry'],
        });
    });

    test('move back and retry must name the stopped relocation exactly; move back then restores the old folder', async () => {
        const { s, before, api, to, recover } = await stoppedRelocation();
        const current = { kind: 'relocation', from: s.syncDir, to, error: 'EIO: i/o error', actions: ['move-back', 'retry'] };
        for (const body of [{ action: 'move-back', from: to, to: s.syncDir }, { action: 'move-back' }, { action: 'retry', from: s.syncDir }]) {
            const res = await api.move(body);
            expect([body, res.status]).toEqual([body, 409]);
            expect(res.json.move).toEqual(current);
        }
        expect((await api.move({ action: 'finish', from: s.syncDir, to })).status).toBe(409); // not a relocation's action
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).not.toBeNull();

        recover();
        expect((await api.move({ action: 'move-back', from: `${s.syncDir}/`, to })).status).toBe(200);
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(readdirSync(to)).toEqual([]);
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
        expect(s.stateDb.getMeta(SYNC_DIR_MOVING)).toBeNull();
        expect(s.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
    });

    test('retry finishes the stopped relocation', async () => {
        const { s, before, api, to, recover } = await stoppedRelocation();
        recover();
        expect((await api.move({ action: 'retry', from: s.syncDir, to })).status).toBe(200);
        expect(s.stateDb.getSettings().syncDir).toBe(to);
        expect(snapshot(to)).toEqual(before);
        expect(readdirSync(s.syncDir)).toEqual([]);
    });

    test('a folder that is refused changes nothing', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        await s.boot();
        const api = over(s);
        await api.start();
        const busy = path.join(s.root, 'Documents');
        s.put(path.join(busy, 'mine.txt'), "the user's own");
        chmodSync(busy, 0o755);
        const res = await api.driveSettings({ syncDir: busy });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, folderError: `Choose an empty folder, or a new one: ${busy} already holds files` });
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);
    });
});

describe('The drive folder and the virtual drive change only over the control socket (#31)', () => {
    const over = (s: ReturnType<typeof setup>) => {
        const socketPath = path.join(s.root, 'control.sock');
        const deps = { stateDb: s.stateDb, drive: s.controller, engine: s.engine };
        const tcp = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => settingsRoute(req, deps) });
        cleanups.push(() => void tcp.stop(true));
        const json = async (r: Response) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> });
        return {
            start: async () => {
                const server = await startControlServer({ socketPath, engine: s.engine, driveSettings: (change) => driveSettings(change, deps) });
                cleanups.push(() => server.stop());
            },
            tcp: (body: unknown) => fetch(`http://127.0.0.1:${tcp.port}/api/settings`, { method: 'POST', body: JSON.stringify(body) }).then(json),
            socket: (body: unknown, raw?: string) =>
                fetch('http://localhost/drive/settings', { unix: socketPath, method: 'POST', body: raw ?? JSON.stringify(body) } as RequestInit).then(json),
        };
    };

    test('TCP refuses a changed folder and a changed switch, saves the rest, and moves nothing', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        await s.boot();
        const before = snapshot(s.syncDir);
        const api = over(s);
        const to = path.join(s.root, 'Elsewhere');
        const res = await api.tcp({ syncDir: to, virtualDriveWanted: true, notificationsEnabled: true, ignorePatterns: ['*.bak'] });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, code: 'EACCES', virtualDriveWanted: false });
        expect(String(res.json.folderError)).toMatch(/Proton Drive app/);
        expect(String(res.json.switchError)).toMatch(/Proton Drive app/);
        expect(s.stateDb.getSettings()).toMatchObject({ syncDir: s.syncDir, notificationsEnabled: true, ignorePatterns: ['*.bak'] });
        expect(s.stateDb.getMeta('virtualDriveWanted')).toBe('0');
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(existsSync(to)).toBe(false);
        expect(s.supervisors).toEqual([]);
    });

    test('TCP ignores an unchanged folder, however written, and an unchanged switch', async () => {
        const s = setup({ wanted: false });
        await s.boot();
        const api = over(s);
        const res = await api.tcp({ syncDir: `${s.syncDir}/`, virtualDriveWanted: false, conflictStrategy: 'keep-local' });
        expect(res.json).toMatchObject({ ok: true, folderError: null, switchError: null });
        expect(res.json.code).toBeUndefined();
        expect(s.stateDb.getSettings()).toMatchObject({ syncDir: s.syncDir, conflictStrategy: 'keep-local' });
    });

    test('TCP still rejects a malformed switch', async () => {
        const s = setup({ wanted: false });
        await s.boot();
        expect((await over(s).tcp({ virtualDriveWanted: 'yes' })).status).toBe(400);
    });

    test('the socket relocates the folder and switches the drive', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        await s.boot();
        const before = snapshot(s.syncDir);
        const api = over(s);
        await api.start();
        const to = path.join(s.root, 'Elsewhere');
        const moved = await api.socket({ syncDir: to });
        expect(moved).toMatchObject({ status: 200, json: { ok: true, folderError: null, switchError: null } });
        expect(s.stateDb.getSettings().syncDir).toBe(to);
        expect(snapshot(to)).toEqual(before);
        expect(modeOf(to)).toBe(0o700); // made by the daemon for the user alone
        expect(await api.socket({ syncDir: `${to}/` })).toMatchObject({ json: { folderError: null } }); // unchanged

        expect((await api.socket({ virtualDriveWanted: true })).json).toMatchObject({ switchError: null, virtualDriveWanted: true });
        expect(readDriveLayout(s.stateDb)).toBe('virtual');
    });

    test('the socket refuses a malformed request with 400 { error, code }', async () => {
        const s = setup({ wanted: false });
        await s.boot();
        const api = over(s);
        await api.start();
        for (const body of [{ syncDir: 3 }, { virtualDriveWanted: 'yes' }, { notificationsEnabled: true }, [1]]) {
            const res = await api.socket(body);
            expect([body, res.status, res.json.code]).toEqual([body, 400, 'EINVAL']);
        }
        expect((await api.socket(null, 'not json')).status).toBe(400);
    });

    test('an existing folder others can write is refused, one made closed is taken, and S30 still holds', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        await s.boot();
        const before = snapshot(s.syncDir);
        const api = over(s);
        await api.start();
        const open = path.join(s.root, 'Open');
        mkdirSync(open);
        for (const mode of [0o777, 0o757, 0o707]) {
            chmodSync(open, mode);
            const res = await api.socket({ syncDir: open });
            expect([mode, res.json.folderError]).toEqual([mode, `${open} can be changed by other users; choose a folder only you can write to, or run chmod go-w on it`]);
        }
        expect(snapshot(s.syncDir)).toEqual(before);
        expect(s.stateDb.getSettings().syncDir).toBe(s.syncDir);

        chmodSync(open, 0o755);
        s.put(path.join(open, 'mine.txt'), "the user's own");
        expect((await api.socket({ syncDir: open })).json.folderError).toBe(`Choose an empty folder, or a new one: ${open} already holds files`);
        rmSync(path.join(open, 'mine.txt'));
        expect((await api.socket({ syncDir: open })).json.folderError).toBeNull();
        expect(s.stateDb.getSettings().syncDir).toBe(open);
    });

    test('a folder owned by another user is refused', () => {
        const s = setup();
        const me = { uid: (process.getuid?.() ?? 0) + 1, gid: process.getgid?.() ?? 0 };
        expect(unsafeFolderReason(s.root, me)).toBe(`${s.root} belongs to another user; choose a folder that you own`);
        expect(unsafeFolderReason(path.join(s.root, 'missing'), me)).toBeNull();
    });

    test('group-writable is fine in the user\'s own group (Files makes 0775), refused in any other; world-writable never (S33)', () => {
        const s = setup();
        const dir = path.join(s.root, 'Shared');
        mkdirSync(dir);
        const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
        chmodSync(dir, 0o775);
        expect(statSync(dir).gid).toBe(me.gid);
        expect(unsafeFolderReason(dir, me)).toBeNull();
        expect(unsafeFolderReason(dir, { ...me, gid: me.gid + 1 })).toMatch(/can be changed by other users/);
        for (const mode of [0o777, 0o757, 0o707]) {
            chmodSync(dir, mode);
            expect([mode, unsafeFolderReason(dir, me)]).toEqual([mode, `${dir} can be changed by other users; choose a folder only you can write to, or run chmod go-w on it`]);
        }
        chmodSync(dir, 0o755);
        expect(unsafeFolderReason(dir, me)).toBeNull();
        // A group of the user's that is not the primary one, where the system has one
        const other = process.getgroups?.().find((g) => g !== me.gid);
        if (other !== undefined) {
            chmodSync(dir, 0o775);
            chownSync(dir, me.uid, other);
            expect(unsafeFolderReason(dir, me)).toMatch(/can be changed by other users/);
        }
    });

    test('a missing folder is made 0700, and the parents the daemon makes get the default mode', async () => {
        const s = setup({ wanted: false });
        s.fillTree(s.syncDir);
        await s.boot();
        const api = over(s);
        await api.start();
        const parent = path.join(s.root, 'New parent');
        const to = path.join(parent, 'Drive');
        expect((await api.socket({ syncDir: to })).json.folderError).toBeNull();
        expect(modeOf(to)).toBe(0o700);
        const plain = path.join(s.root, 'plain');
        mkdirSync(plain);
        expect(modeOf(parent)).toBe(modeOf(plain));
    });
});
