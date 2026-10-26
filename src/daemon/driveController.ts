import { chmodSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import { type DriveLayout, readDriveLayout, virtualDriveWanted } from '../sync/driveMode';
import {
    DifferentDiskError,
    emptyFolderNeeded,
    finishRelocation,
    holdsFiles,
    LAYOUT_MOVING,
    type MoveSeams,
    moveToLayout,
    onSameDisk,
    pendingRelocation,
    relocateFiles,
    SYNC_DIR_MOVING,
} from '../sync/layoutMigration';
import { pathsOverlap } from '../sync/mountPoint';
import { type ProtonDriveSyncEngine, resolveSyncDirInput } from '../sync/syncEngine';
import type { SyncStateDatabase } from '../sync/syncStateDb';
import { notMountableReason, unsupervisedStatus, type VfsSupervisor, type VfsStatus } from './vfsSupervisor';

// Runs the drive as the user's choice and the system allow (the mode rule): the files move between the sync folder and
// the backing store to match, at every start and when the user switches the virtual drive, with the engine held and
// the drive unmounted meanwhile; and while the files are in the backing store, the helper is supervised. A move that
// fails always has a way out: switching again (either way), Mount again, the next start, or for a relocation, moving
// the folder back.

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
    // A move that couldn't finish and is still marked (layoutMoving or syncDirMoving): the engine stays held until it
    // is finished or undone
    private stuck = false;
    private moveError: string | null = null;
    private differentDisk = false;
    private driveStarted = false;
    // Moving back failed because the files are moving out to another disk, where only that move can go on
    private onlyOnwardOut = false;
    private socketUp = false; // whether the helper can reach this daemon

    constructor(private readonly opts: DriveControllerOptions) {}

    status(): VfsStatus {
        const { stateDb, fuseOk } = this.opts;
        const mode = readDriveLayout(stateDb);
        if (this.moving) return { mode, mounted: false, reason: 'moving' };
        const live = this.supervisor?.status();
        if (live?.mounted) return live; // mounted again since a move failed: that is what matters now
        if (this.moveError !== null) return { mode, mounted: false, reason: 'move-failed', error: this.moveError };
        if (live) return live;
        if (mode === 'virtual' && fuseOk) {
            return { mode, mounted: false, reason: this.driveStarted ? 'mount-point-busy' : 'starting' };
        }
        const status = unsupervisedStatus(mode, virtualDriveWanted(stateDb), fuseOk);
        return status.reason === null && this.differentDisk ? { ...status, reason: 'different-disk' } : status;
    }

    // Before the engine starts: finishes a move cut short (a relocation of the plain folder, meta syncDirMoving, or a
    // layout move, meta layoutMoving), runs beforeLayoutMove, then moves the files to match the mode. The engine is held
    // throughout, and stays held if a move out of the backing store or a relocation can't finish (start() then does
    // nothing) until it is finished or undone.
    async settleAtStart(beforeLayoutMove?: () => Promise<void>): Promise<void> {
        const { stateDb, engine, logger } = this.opts;
        this.moving = true;
        try {
            await engine.holdForMove();
            try {
                await finishRelocation({ stateDb, logger, seams: this.opts.moveSeams });
            } catch (error: unknown) {
                logger.error(`Could not finish moving the Proton Drive folder: ${messageOf(error)}`);
                this.moveError = messageOf(error);
                this.stuck = true;
                return;
            }
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

    // The Settings switch: moves the files to match the choice (with the engine held and the drive unmounted meanwhile)
    // and starts the engine and the drive again; the choice is saved once the engine is held. Allowed while a layout
    // move that failed is still marked: it then finishes that move, or moves the files back. Throws when the move
    // failed (the status says why until it is resolved).
    async setVirtualDriveWanted(wanted: boolean): Promise<void> {
        if (this.moving) throw new Error(BUSY);
        this.refuseWhileRelocationStopped();
        const { stateDb } = this.opts;
        const save = () => stateDb.setMeta('virtualDriveWanted', wanted ? '1' : '0');
        const target: DriveLayout = wanted && this.opts.fuseOk ? 'virtual' : 'plain';
        this.refuseMovingBackFromAnotherDisk(target);
        if (!this.layoutMovePending() && target === readDriveLayout(stateDb)) {
            // FUSE can't run the drive, or the files are where the choice wants them already: an earlier move that
            // failed (and was undone) is no longer what the status is about
            save();
            this.moveError = null;
            this.differentDisk = false;
            return;
        }
        const previous = stateDb.getMeta('virtualDriveWanted');
        await this.switchTo(target, save);
        if (this.onlyOnwardOut) {
            // The files can only go on moving out, to another disk (see moveTo): the choice stays as it was
            if (previous === null) stateDb.deleteMeta('virtualDriveWanted');
            else stateDb.setMeta('virtualDriveWanted', previous);
        }
        if (this.moveError !== null) throw new Error(this.moveError);
    }

    // A new sync folder. In the virtual layout no file moves: the drive is unmounted, the old mount point becomes a
    // normal folder again, and the drive mounts at the new one. In the plain layout the engine moves the files. A folder
    // overlapping the app's own files, or inside the old one or holding it, is refused. While a relocation that failed
    // is still marked, only moving back to the old folder (undoing it) or to the new one again is allowed.
    async relocate(raw: string): Promise<string> {
        const { stateDb, engine, appDir, backingDir } = this.opts;
        const newDir = resolveSyncDirInput(raw);
        const stopped = this.stuck ? pendingRelocation(stateDb) : null;
        if (stopped) {
            if (this.moving) throw new Error(BUSY);
            if (newDir === path.resolve(stopped.from) || newDir === path.resolve(stopped.to)) {
                return this.resumeRelocation(stopped, newDir);
            }
            throw new Error(this.relocationStopped(stopped));
        }
        const oldDir = stateDb.getSettings().syncDir;
        if (newDir === path.resolve(oldDir)) {
            return oldDir; // the folder it already is, however it is written: nothing to do, even while files move
        }
        if (this.moving) throw new Error(BUSY);
        if (this.stuck) {
            throw new Error(`Moving the files stopped (${this.moveError}); switch the virtual drive again, or restart Proton Drive, to finish first`);
        }
        for (const dir of [appDir, backingDir]) {
            if (pathsOverlap(newDir, dir)) {
                throw new Error(`${newDir} overlaps ${dir}, where Proton Drive keeps its own files; choose another folder`);
            }
        }
        if (pathsOverlap(newDir, oldDir)) {
            throw new Error(`${newDir} and ${oldDir} are inside one another; choose a folder outside the current Proton Drive folder`);
        }
        // Then everything in it comes from the old folder: a move that stops can be undone exactly, nothing unrelated
        // is pulled into the drive (the stray merge would take it into the store), and nothing of the user's is mounted
        // over
        if (holdsFiles(newDir)) {
            throw new Error(emptyFolderNeeded(newDir));
        }
        this.moving = true;
        try {
            if (readDriveLayout(stateDb) !== 'virtual') {
                try {
                    return await engine.relocateSyncFolder(oldDir, newDir);
                } catch (error: unknown) {
                    if (stateDb.getMeta(SYNC_DIR_MOVING) !== null) {
                        // Cut short with the engine held: moving back, or the next start, finishes it
                        this.moveError = messageOf(error);
                        this.stuck = true;
                    }
                    throw error;
                }
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

    // Mount again: after a move that failed (still marked, or undone), tries it again first; when that leaves the files
    // in the plain folder (the drive switched off, or FUSE missing), that was all there was to do
    async mountAgain(): Promise<void> {
        if (this.moving) throw new Error(BUSY);
        this.refuseWhileRelocationStopped();
        const target = this.target();
        this.refuseMovingBackFromAnotherDisk(target);
        if (this.layoutMovePending() || (this.moveError !== null && target !== readDriveLayout(this.opts.stateDb))) {
            await this.switchTo(target);
            if (this.moveError !== null) throw new Error(this.moveError);
            if (readDriveLayout(this.opts.stateDb) !== 'virtual') return;
        }
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

    private layoutMovePending(): boolean {
        return this.opts.stateDb.getMeta(LAYOUT_MOVING) !== null;
    }

    private relocationStopped(stopped: { from: string; to: string }): string {
        return `Moving the Proton Drive folder to ${stopped.to} stopped (${this.moveError}); move it back to ${stopped.from}, or to ${stopped.to} again`;
    }

    // A move out that stopped on another disk (a full one, say) can only go on there: moving back would copy the files
    // into the store, and undoing that would push them out again
    private refuseMovingBackFromAnotherDisk(target: DriveLayout): void {
        const { stateDb, backingDir, moveSeams } = this.opts;
        if (target !== 'virtual' || stateDb.getMeta(LAYOUT_MOVING) !== 'plain') return;
        const syncDir = stateDb.getSettings().syncDir;
        if (!onSameDisk(syncDir, backingDir, moveSeams?.deviceOf)) {
            throw new Error(this.freeSpaceFirst(syncDir, this.moveError));
        }
    }

    private freeSpaceFirst(syncDir: string, why: string | null): string {
        return `Free space on the disk holding ${syncDir}, then try again: the files are moving there${why ? ` (${why})` : ''}, and they can't move back into the drive's store from another disk`;
    }

    private refuseWhileRelocationStopped(): void {
        const stopped = this.stuck ? pendingRelocation(this.opts.stateDb) : null;
        if (stopped) throw new Error(`${this.relocationStopped(stopped)} first`);
    }

    // Moving back to the old folder (undoing it: everything in the new folder goes back) or on to the new one
    private async resumeRelocation(stopped: { from: string; to: string }, newDir: string): Promise<string> {
        const { stateDb, engine, logger } = this.opts;
        const [from, to] = newDir === path.resolve(stopped.from) ? [stopped.to, stopped.from] : [stopped.from, stopped.to];
        this.moving = true;
        try {
            await relocateFiles({ stateDb, from, to, logger, seams: this.opts.moveSeams });
        } catch (error: unknown) {
            this.moveError = messageOf(error);
            throw error;
        } finally {
            this.moving = false;
        }
        this.stuck = false;
        this.moveError = null;
        engine.releaseHold();
        await engine.start({ backgroundInitialReconcile: true });
        return to;
    }

    private async switchTo(target: DriveLayout, onceHeld?: () => void): Promise<void> {
        const { engine } = this.opts;
        this.moving = true;
        try {
            try {
                await engine.holdForMove({ timeoutMs: this.opts.holdTimeoutMs ?? HOLD_TIMEOUT_MS });
            } catch (error: unknown) {
                this.moveError = messageOf(error); // nothing moved and nothing saved: the status says why
                await engine.start({ backgroundInitialReconcile: true });
                throw error;
            }
            onceHeld?.();
            // Never on a half-moved tree: it ran before that move began
            if (!this.layoutMovePending()) engine.recoverLocalMove();
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
    // the engine held, until a switch, Mount again or the next start finishes it or moves the files back. The drive is
    // unmounted before files move out of the store.
    private async moveTo(target: DriveLayout): Promise<void> {
        const { stateDb, logger } = this.opts;
        const movingOut = stateDb.getMeta(LAYOUT_MOVING) === 'plain';
        const earlier = this.moveError;
        this.moveError = null;
        this.differentDisk = false;
        this.onlyOnwardOut = false;
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
            this.stuck = false;
            return;
        } catch (error: unknown) {
            logger.error(`Could not move the files to the ${target} layout: ${messageOf(error)}`);
            if (target === 'virtual' && movingOut && error instanceof DifferentDiskError) {
                // Moving back from a move out that stopped on another disk: that move is the one to finish
                stateDb.setMeta(LAYOUT_MOVING, 'plain');
                this.fail(this.freeSpaceFirst(stateDb.getSettings().syncDir, earlier));
                this.onlyOnwardOut = true;
                return;
            }
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
        this.stuck = this.layoutMovePending();
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
