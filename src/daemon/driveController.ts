import { chmodSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import { type DriveLayout, readDriveLayout, virtualDriveWanted } from '../sync/driveMode';
import { DifferentDiskError, LAYOUT_MOVING, type MoveSeams, moveToLayout } from '../sync/layoutMigration';
import { pathsOverlap } from '../sync/mountPoint';
import { type ProtonDriveSyncEngine, resolveSyncDirInput } from '../sync/syncEngine';
import type { SyncStateDatabase } from '../sync/syncStateDb';
import { notMountableReason, unsupervisedStatus, type VfsSupervisor, type VfsStatus } from './vfsSupervisor';

// Runs the drive as the user's choice and the system allow (the mode rule): the files move between the sync folder and
// the backing store to match, at every start and when the user switches the virtual drive, with the engine held and
// the drive unmounted meanwhile; and while the files are in the backing store, the helper is supervised.

export type DriveSupervisor = Pick<VfsSupervisor, 'start' | 'stop' | 'mountAgain' | 'status' | 'release'>;

const BUSY = 'Proton Drive is busy moving files';
// How long a switch waits for what the engine is doing (an upload, a download) before giving up
const HOLD_TIMEOUT_MS = 60_000;

export interface DriveControllerOptions {
    stateDb: SyncStateDatabase;
    engine: Pick<ProtonDriveSyncEngine, 'start' | 'holdForMove' | 'releaseHold' | 'recoverLocalMove' | 'relocateSyncFolder'>;
    appDir: string;
    backingDir: string;
    logger: Logger;
    fuseOk: boolean; // FUSE and the helper, looked for once at start
    // A supervisor for the drive at a mount point (the daemon's: its helper, socket and stray merge)
    makeSupervisor: (mountpoint: string) => DriveSupervisor;
    holdTimeoutMs?: number;
    moveSeams?: MoveSeams; // for tests
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class DriveController {
    private supervisor: DriveSupervisor | null = null;
    private moving = false;
    // A move that couldn't finish and is still marked: the engine stays held until a start finishes it
    private stuck = false;
    private moveError: string | null = null;
    private differentDisk = false;
    private driveStarted = false;
    private socketUp = false; // whether the helper can reach this daemon

    constructor(private readonly opts: DriveControllerOptions) {}

    status(): VfsStatus {
        const { stateDb, fuseOk } = this.opts;
        const mode = readDriveLayout(stateDb);
        if (this.moving) return { mode, mounted: false, reason: 'moving' };
        if (this.moveError !== null) return { mode, mounted: false, reason: 'move-failed', error: this.moveError };
        if (this.supervisor) return this.supervisor.status();
        if (mode === 'virtual' && fuseOk) {
            return { mode, mounted: false, reason: this.driveStarted ? 'mount-point-busy' : 'starting' };
        }
        const status = unsupervisedStatus(mode, virtualDriveWanted(stateDb), fuseOk);
        return status.reason === null && this.differentDisk ? { ...status, reason: 'different-disk' } : status;
    }

    // Before the engine starts: finishes a move cut short (meta layoutMoving), runs beforeLayoutMove, then moves the
    // files to match the mode. The engine is held throughout, and stays held if a move out of the backing store can't
    // finish (start() then does nothing): the next start finishes it.
    async settleAtStart(beforeLayoutMove?: () => Promise<void>): Promise<void> {
        const { stateDb, engine, logger } = this.opts;
        this.moving = true;
        try {
            await engine.holdForMove();
            const pending = stateDb.getMeta(LAYOUT_MOVING);
            if (pending !== null) {
                logger.info(`Finishing moving the files to the ${pending} layout, cut short last time`);
                await this.moveTo(pending === 'virtual' ? 'virtual' : 'plain');
                if (this.stuck) return;
            }
            await beforeLayoutMove?.();
            const target = this.target();
            if (target !== readDriveLayout(stateDb)) {
                logger.info(
                    target === 'virtual'
                        ? 'Moving the files into the virtual drive'
                        : `Moving the files back into the plain folder: ${
                              virtualDriveWanted(stateDb) ? "FUSE or protondrive-vfs isn't available" : 'the virtual drive is switched off'
                          }`,
                );
                engine.recoverLocalMove();
                await this.moveTo(target);
            }
        } finally {
            this.moving = false;
            if (!this.stuck) engine.releaseHold();
        }
    }

    // Once the engine and the control socket are up: mounts the drive when the files are in the backing store
    async startDrive(controlSocketUp: boolean): Promise<void> {
        this.driveStarted = true;
        this.socketUp = controlSocketUp;
        await this.superviseIfVirtual();
    }

    // The Settings switch: saves the choice, then moves the files to match it (with the engine held and the drive
    // unmounted meanwhile) and starts the engine and the drive again. Throws when the move failed (status says why).
    async setVirtualDriveWanted(wanted: boolean): Promise<void> {
        this.refuseWhileBusy();
        this.opts.stateDb.setMeta('virtualDriveWanted', wanted ? '1' : '0');
        const target = this.target();
        if (target === readDriveLayout(this.opts.stateDb)) {
            // FUSE can't run the drive, or the files are where the choice wants them already: an earlier move that
            // failed (and was undone) is no longer what the status is about
            this.moveError = null;
            this.differentDisk = false;
            return;
        }
        await this.switchTo(target);
        if (this.moveError !== null) throw new Error(this.moveError);
    }

    // A new sync folder. In the virtual layout no file moves: the drive is unmounted, the old mount point becomes a
    // normal folder again, and the drive mounts at the new one. In the plain layout the engine moves the files. A folder
    // overlapping the app's own files is refused.
    async relocate(raw: string): Promise<string> {
        this.refuseWhileBusy();
        const { stateDb, engine, appDir, backingDir } = this.opts;
        const oldDir = stateDb.getSettings().syncDir;
        const newDir = resolveSyncDirInput(raw);
        if (newDir === path.resolve(oldDir)) {
            return oldDir;
        }
        for (const dir of [appDir, backingDir]) {
            if (pathsOverlap(newDir, dir)) {
                throw new Error(`${newDir} overlaps ${dir}, where Proton Drive keeps its own files; choose another folder`);
            }
        }
        this.moving = true;
        try {
            if (readDriveLayout(stateDb) !== 'virtual') {
                return await engine.relocateSyncFolder(oldDir, newDir);
            }
            const stillMounted = await this.releaseMountPoint();
            if (stillMounted) throw new Error(stillMounted);
            try {
                if (statSync(oldDir).isDirectory()) chmodSync(oldDir, 0o755);
            } catch (error: unknown) {
                this.opts.logger.warn(`Could not make ${oldDir} a normal folder again: ${messageOf(error)}`);
            }
            return await engine.relocateSyncFolder(oldDir, newDir);
        } finally {
            this.moving = false;
            await this.superviseIfVirtual(); // at whichever folder the setting names now
        }
    }

    async mountAgain(): Promise<void> {
        if (this.moving) throw new Error(BUSY);
        if (!this.supervisor) throw new Error(notMountableReason(this.status()));
        await this.supervisor.mountAgain();
    }

    async stop(): Promise<void> {
        await this.supervisor?.stop();
    }

    // The mode rule: virtual when the user wants it (the default) and FUSE and the helper are there
    private target(): DriveLayout {
        return virtualDriveWanted(this.opts.stateDb) && this.opts.fuseOk ? 'virtual' : 'plain';
    }

    private refuseWhileBusy(): void {
        if (this.moving) throw new Error(BUSY);
        if (this.stuck) {
            throw new Error(`Moving the files stopped (${this.moveError}); restart Proton Drive to finish moving them`);
        }
    }

    private async switchTo(target: DriveLayout): Promise<void> {
        const { engine } = this.opts;
        this.moving = true;
        try {
            try {
                await engine.holdForMove({ timeoutMs: this.opts.holdTimeoutMs ?? HOLD_TIMEOUT_MS });
            } catch (error: unknown) {
                await engine.start({ backgroundInitialReconcile: true }); // nothing moved: it runs on as it was
                throw error;
            }
            engine.recoverLocalMove();
            await this.moveTo(target);
        } finally {
            this.moving = false;
        }
        if (!this.stuck) {
            engine.releaseHold();
            await engine.start({ backgroundInitialReconcile: true });
            await this.superviseIfVirtual();
        }
    }

    // With the engine held: moves the files. A move into the backing store that can't finish is undone (they came by
    // renames, so they go back the same way) and the folder stays plain; a move out that can't finish stays marked, and
    // the engine held, for the next start to finish. The drive is unmounted before files move out of the store.
    private async moveTo(target: DriveLayout): Promise<void> {
        const { stateDb, logger } = this.opts;
        this.moveError = null;
        this.differentDisk = false;
        if (target === 'plain') {
            const stillMounted = await this.releaseMountPoint();
            if (stillMounted) {
                logger.error(`Not moving the files out of the drive's store: ${stillMounted}`);
                this.fail(stillMounted);
                return;
            }
        }
        try {
            this.differentDisk = (await this.move(target)) === 'different-disk';
            return;
        } catch (error: unknown) {
            logger.error(`Could not move the files to the ${target} layout: ${messageOf(error)}`);
            this.fail(messageOf(error));
            if (target === 'virtual' && stateDb.getMeta(LAYOUT_MOVING) !== null) {
                await this.undoMoveIntoStore(error);
            }
        }
    }

    private async undoMoveIntoStore(cause: unknown): Promise<void> {
        try {
            await this.move('plain');
        } catch (error: unknown) {
            this.opts.logger.error(`Could not move the files back to the plain folder: ${messageOf(error)}`);
            this.fail(`${messageOf(cause)}; moving them back failed too: ${messageOf(error)}`);
            return;
        }
        this.stuck = false;
        if (cause instanceof DifferentDiskError) {
            this.moveError = null;
            this.differentDisk = true;
        }
    }

    private fail(message: string): void {
        this.moveError = message;
        this.stuck = this.opts.stateDb.getMeta(LAYOUT_MOVING) !== null;
    }

    private move(target: DriveLayout) {
        const { stateDb, backingDir, appDir, logger, moveSeams } = this.opts;
        return moveToLayout({ stateDb, syncDir: stateDb.getSettings().syncDir, backingDir, appDir, target, logger, seams: moveSeams });
    }

    // Unmounts the drive at the sync folder, this session's or one an earlier session left; answers why something is
    // still mounted there, or null
    private async releaseMountPoint(): Promise<string | null> {
        const supervisor = this.supervisor ?? this.opts.makeSupervisor(this.opts.stateDb.getSettings().syncDir);
        this.supervisor = null;
        return supervisor.release();
    }

    private async superviseIfVirtual(): Promise<void> {
        const { stateDb, fuseOk, logger } = this.opts;
        if (!this.driveStarted || this.supervisor || this.stuck || !fuseOk || readDriveLayout(stateDb) !== 'virtual') {
            return;
        }
        if (!this.socketUp) {
            // The helper can't reach this daemon, and a socket held by another daemon means that one runs the drive:
            // starting here would unmount it
            logger.error('Not mounting the drive: the control socket is unavailable');
            return;
        }
        this.supervisor = this.opts.makeSupervisor(stateDb.getSettings().syncDir);
        await this.supervisor.start();
    }
}
