import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
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
import { DriveController, type DriveSupervisor } from '../src/daemon/driveController';
import type { VfsStatus } from '../src/daemon/vfsSupervisor';
import { readDriveLayout } from '../src/sync/driveMode';
import { LAYOUT_MOVING, type MoveSeams } from '../src/sync/layoutMigration';
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
        return null;
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
        expect(s.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'move-failed', error: 'EACCES: permission denied' });
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
        await expect(controller.setVirtualDriveWanted(false)).rejects.toThrow(/restart/i);

        await controller.stop();
        await engine.stop();
        const restarted = await s.boot({ fuseOk: false });
        expect(snapshot(s.syncDir, { folderTimes: false })).toEqual(before);
        expect(readDriveLayout(s.stateDb)).toBe('plain');
        expect(restarted.controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'fuse-unavailable' });
        expect(() => restarted.engine.vfsChildren('')).not.toThrow();
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
        expect(controller.status()).toEqual({ mode: 'plain', mounted: false, reason: 'move-failed', error: 'EACCES: permission denied' });
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

    test('the folder it already is, however it is written, changes nothing and leaves the drive mounted', async () => {
        const s = setup();
        s.leftVirtual();
        const { controller } = await s.boot();
        expect(await controller.relocate(`${s.syncDir}/`)).toBe(s.syncDir);
        expect(await controller.relocate(path.join(s.syncDir, '..', 'ProtonDrive'))).toBe(s.syncDir);
        expect(s.supervisors.map((x) => x.events)).toEqual([['start']]);
        expect(modeOf(s.syncDir)).toBe(0o555);
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
