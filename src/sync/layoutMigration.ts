import { createHash } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    fsyncSync,
    lstatSync,
    lutimesSync,
    mkdirSync,
    openSync,
    readdirSync,
    readlinkSync,
    rmdirSync,
    type Stats,
    statSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
} from 'node:fs';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import { type DriveLayout, readDriveLayout } from './driveMode';
import { mergeInto, type MergeOptions } from './localMerge';
import { moveWithoutReplacing } from './localMove';
import { canonicalPath, mountsAt, pathsOverlap, readMountInfo } from './mountPoint';
import type { SyncStateDatabase } from './syncStateDb';

// Moving the files between the sync folder (the plain layout) and the backing store (the virtual drive's layout).
// Nothing is ever replaced, no source goes before its content is safely at the destination, and a move cut short by a
// crash at any point is finished by running it again. Records never change: their paths are relative to either place.

// Meta key set while the files move: the layout they are moving to. Found set at start, the move is finished before
// anything looks at the files.
export const LAYOUT_MOVING = 'layoutMoving';
// Meta key set while the plain sync folder's files move to a new sync folder: { from, to }, the same way
export const SYNC_DIR_MOVING = 'syncDirMoving';
// A copy in progress, beside where it goes (the sync ignores, and the drive hides, every .proton-drive-tmp-* name)
const COPY_PREFIX = '.proton-drive-tmp-move-';
// Rounds of moving what is in the source folder: an app may save into the sync folder while its files move out
const MOVE_ROUNDS = 3;

export type MoveStep = 'entry' | 'copied' | 'placed' | 'removed';

export interface MoveSeams {
    // The move on one disk (moveWithoutReplacing); EXDEV from it takes the copy path
    moveSameDisk?: (from: string, to: string) => boolean;
    // Copies a file to a path that must be free
    copyFile?: (from: string, to: string) => void;
    deviceOf?: (p: string) => number;
    readMountInfo?: () => string;
    // Runs after each step of the move, for a test to stop it there as a crash would: a top-level entry done; a file
    // copied beside where it goes, put there, its source removed
    onStep?: (step: MoveStep, path: string) => void;
}

// Moving into the drive's store takes renames on one disk; a copy of everything is never made that way
export class DifferentDiskError extends Error {}

function errnoOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | null)?.code;
}

// Moves the files to the layout given, finishing first a move that was cut short (meta layoutMoving, which is set for
// as long as files move). Moving into the backing store takes renames on one disk: a sync folder on another disk stays
// as it is ('different-disk'). Moving out copies across disks when it has to, file by file, verifying each copy before
// its source goes. The engine and the drive must be stopped meanwhile. Throws when the files can't all move, with the
// move still marked so the next run finishes it; refuses (throwing before anything moves) a sync folder that overlaps
// the app's own files, or that the drive is still mounted at.
export async function moveToLayout(opts: {
    stateDb: SyncStateDatabase;
    syncDir: string;
    backingDir: string;
    target: DriveLayout;
    logger: Logger;
    appDir?: string; // never moved into or out of
    now?: Date; // the time in conflict names
    seams?: MoveSeams;
}): Promise<'moved' | 'already' | 'different-disk'> {
    const { stateDb, syncDir, backingDir, target, logger } = opts;
    const seams = opts.seams ?? {};
    const resuming = stateDb.getMeta(LAYOUT_MOVING) !== null;
    if (!resuming && readDriveLayout(stateDb) === target) {
        return 'already';
    }
    for (const dir of opts.appDir ? [backingDir, opts.appDir] : [backingDir]) {
        if (pathsOverlap(syncDir, dir)) {
            throw new Error(`The Proton Drive folder ${syncDir} overlaps ${dir}; not moving any files`);
        }
    }
    if (target === 'plain') {
        refuseIfMounted(syncDir, seams.readMountInfo ?? readMountInfo);
    } else if (!resuming && hasEntries(syncDir) && !onSameDisk(syncDir, backingDir, seams.deviceOf ?? deviceOf)) {
        logger.warn(`${syncDir} and ${backingDir} are on different disks: the files stay in ${syncDir}`);
        return 'different-disk';
    }

    const [from, to] = target === 'virtual' ? [syncDir, backingDir] : [backingDir, syncDir];
    mkdirSync(to, target === 'virtual' ? { recursive: true, mode: 0o700 } : { recursive: true });
    if (target === 'plain') {
        chmodSync(syncDir, 0o755); // the drive's mount point is 0555 while unmounted
    }
    stateDb.setMeta(LAYOUT_MOVING, target);
    const mover = new Mover({ logger, now: opts.now ?? new Date(), allowCopy: target === 'plain', seams });
    let left: string[];
    try {
        left = existsSync(from) ? mover.moveAll(from, to) : [];
    } catch (error: unknown) {
        if (error instanceof DifferentDiskError && !resuming && !mover.movedSomething) {
            stateDb.deleteMeta(LAYOUT_MOVING);
            logger.warn(`${syncDir} and ${backingDir} are on different disks: the files stay in ${syncDir}`);
            return 'different-disk';
        }
        throw error;
    }
    if (target === 'virtual') {
        mkdirSync(syncDir, { recursive: true });
        if (left.length === 0) {
            chmodSync(syncDir, 0o555);
        } else {
            logger.warn(`Still in ${syncDir} after its files moved: ${left.join(', ')}; the drive takes them in when it mounts`);
        }
    } else if (left.length > 0) {
        logger.warn(`Left in ${backingDir}, as they can't move to another disk: ${left.join(', ')}`);
    }
    stateDb.connection.transaction(() => {
        stateDb.setMeta('driveLayout', target);
        stateDb.deleteMeta(LAYOUT_MOVING);
    })();
    logger.info(target === 'virtual' ? `Moved the files in ${syncDir} into ${backingDir}` : `Moved the files in ${backingDir} into ${syncDir}`);
    return 'moved';
}

// Moves the plain sync folder's files into a new folder, never replacing anything there (see Mover), and saves it as the
// sync folder. Records stay as they are, except those whose file was already gone, which are dropped so that the file
// comes back rather than reading as deleted here. The engine must be held meanwhile. Throws when the files can't all
// move, with the move still marked (meta syncDirMoving) for finishRelocation to finish at the next start.
export async function relocateFiles(opts: {
    stateDb: SyncStateDatabase;
    from: string;
    to: string;
    logger: Logger;
    now?: Date;
    seams?: MoveSeams;
}): Promise<void> {
    const { stateDb, from, to, logger } = opts;
    if (pathsOverlap(from, to)) {
        throw new Error(`${to} and ${from} are inside one another; choose a folder outside the current Proton Drive folder`);
    }
    mkdirSync(to, { recursive: true });
    stateDb.setMeta(SYNC_DIR_MOVING, JSON.stringify({ from, to }));
    const mover = new Mover({ logger, now: opts.now ?? new Date(), allowCopy: true, seams: opts.seams ?? {} });
    const left = existsSync(from) ? mover.moveAll(from, to) : [];
    if (left.length > 0) {
        logger.warn(`Left in ${from}, as they can't move to another disk: ${left.join(', ')}`);
    }
    const gone = stateDb.getAllItems().filter((item) => !lstatSync(path.join(to, item.localRelPath), { throwIfNoEntry: false }));
    stateDb.connection.transaction(() => {
        for (const item of gone) {
            stateDb.removeItemByPath(item.localRelPath);
        }
        stateDb.updateSettings({ syncDir: to });
        stateDb.deleteMeta(SYNC_DIR_MOVING);
    })();
    logger.info(`Moved the files in ${from} into ${to}, the new Proton Drive folder`);
}

// Finishes a relocation cut short (meta syncDirMoving); answers whether there was one. Throws as relocateFiles does.
export async function finishRelocation(opts: { stateDb: SyncStateDatabase; logger: Logger; seams?: MoveSeams }): Promise<boolean> {
    const raw = opts.stateDb.getMeta(SYNC_DIR_MOVING);
    if (raw === null) {
        return false;
    }
    let intent: { from?: unknown; to?: unknown } = {};
    try {
        intent = JSON.parse(raw) as typeof intent;
    } catch {
        // Reported below
    }
    if (typeof intent.from !== 'string' || typeof intent.to !== 'string') {
        // Where the files went is unknown: nothing may look at them until someone does
        throw new Error(`Can't tell where the Proton Drive folder was moving (${raw})`);
    }
    opts.logger.info(`Finishing moving the Proton Drive folder from ${intent.from} to ${intent.to}, cut short last time`);
    await relocateFiles({ stateDb: opts.stateDb, from: intent.from, to: intent.to, logger: opts.logger, seams: opts.seams });
    return true;
}

// Files moved into a mount would go into the drive, that is into the backing store they are moving out of
function refuseIfMounted(syncDir: string, readInfo: () => string): void {
    const at = mountsAt(readInfo(), canonicalPath(syncDir));
    if (at.some((fstype) => fstype === 'fuse' || fstype.startsWith('fuse.'))) {
        throw new Error(`Something (${at.join(', ')}) is still mounted at ${syncDir}; not moving files into it`);
    }
    try {
        statSync(syncDir);
    } catch (error: unknown) {
        if (errnoOf(error) === 'ENOTCONN') {
            throw new Error(`${syncDir} is a dead mount ("Transport endpoint is not connected"); not moving files into it`);
        }
    }
}

function hasEntries(dir: string): boolean {
    try {
        return readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

function deviceOf(p: string): number {
    return statSync(p).dev;
}

// The folder itself, or for one not made yet, its nearest parent that is there
function onSameDisk(a: string, b: string, devOf: (p: string) => number): boolean {
    let existing = path.resolve(b);
    while (!existsSync(existing) && path.dirname(existing) !== existing) {
        existing = path.dirname(existing);
    }
    return devOf(a) === devOf(existing);
}

interface MoverOptions {
    logger: Logger;
    now: Date;
    allowCopy: boolean; // across disks: copy, verify, then remove the source
    seams: MoveSeams;
}

// Moves everything in one folder into another at the same relative paths, never replacing anything: what is already at
// a path steps aside to a conflict name, and a folder there is merged into (see mergeInto). A rename on one disk; across
// disks, when allowed, a copy of each file that is verified (size and time), and made durable, before its source goes.
// A symlink moves as a link; a fifo, socket or device only by a rename on one disk (otherwise it stays, and is logged).
export class Mover {
    movedSomething = false;
    private readonly merge: MergeOptions;

    constructor(private readonly opts: MoverOptions) {
        this.merge = {
            now: opts.now,
            keepsName: 'incoming',
            leaveNonEmptyFolders: true,
            move: (from, to) => this.move(from, to),
        };
    }

    // Answers what is still in the source folder after the last round
    moveAll(fromRoot: string, toRoot: string): string[] {
        for (let round = 0; round < MOVE_ROUNDS; round++) {
            const names = readdirSync(fromRoot);
            if (names.length === 0) {
                return [];
            }
            for (const name of names) {
                this.mergeOne(path.join(fromRoot, name), path.join(toRoot, name));
                this.opts.seams.onStep?.('entry', name);
            }
        }
        return readdirSync(fromRoot);
    }

    private mergeOne(from: string, to: string): void {
        for (const renamed of mergeInto(from, to, this.merge)) {
            this.opts.logger.warn(`Something was already where ${from} goes; it was kept as ${renamed}`);
        }
    }

    // To a path that must be free; false when it is taken
    private move(from: string, to: string): boolean {
        let moved: boolean;
        try {
            moved = this.moveOnDisk(from, to);
        } catch (error: unknown) {
            if (errnoOf(error) !== 'EXDEV') {
                throw error;
            }
            if (!this.opts.allowCopy) {
                throw new DifferentDiskError(`${from} and ${to} are on different disks`, { cause: error });
            }
            moved = this.copyAcross(from, to);
        }
        if (moved) {
            this.movedSomething = true;
        }
        return moved;
    }

    // A folder moved to another parent must be writable (rename(2) updates its '..'): a read-only one is made writable
    // for the move, and given its mode back
    private moveOnDisk(from: string, to: string): boolean {
        const moveSameDisk = this.opts.seams.moveSameDisk ?? moveWithoutReplacing;
        try {
            return moveSameDisk(from, to);
        } catch (error: unknown) {
            const st = lstatSync(from, { throwIfNoEntry: false });
            if (errnoOf(error) !== 'EACCES' || !st?.isDirectory() || st.mode & 0o200) {
                throw error;
            }
            chmodSync(from, st.mode | 0o700);
            let moved = false;
            try {
                moved = moveSameDisk(from, to);
            } finally {
                chmodSync(moved ? to : from, st.mode & 0o7777);
            }
            return moved;
        }
    }

    private copyAcross(from: string, to: string): boolean {
        const st = lstatSync(from);
        if (st.isDirectory()) {
            return this.copyFolder(from, to, st);
        }
        if (st.isSymbolicLink()) {
            try {
                symlinkSync(readlinkSync(from), to);
            } catch (error: unknown) {
                if (errnoOf(error) === 'EEXIST') return false;
                throw error;
            }
            try {
                lutimesSync(to, st.atimeMs / 1000, st.mtimeMs / 1000);
            } catch {
                // a link's own times are cosmetic
            }
            syncToDisk(path.dirname(to));
            this.opts.seams.onStep?.('placed', to);
            unlinkSync(from);
            this.opts.seams.onStep?.('removed', from);
            return true;
        }
        if (!st.isFile()) {
            this.opts.logger.warn(`${from} is a ${kindOf(st)}, which moves only within one disk: it stays where it is`);
            return true; // done with it
        }
        return this.copyFile(from, to);
    }

    // Made, filled entry by entry, then given the source's mode and times; the source goes once it is empty
    private copyFolder(from: string, to: string, st: Stats): boolean {
        try {
            mkdirSync(to);
        } catch (error: unknown) {
            if (errnoOf(error) === 'EEXIST') return false;
            throw error;
        }
        chmodSync(to, (st.mode & 0o7777) | 0o700); // writable while it fills
        const readOnly = (st.mode & 0o300) !== 0o300;
        if (readOnly) {
            chmodSync(from, st.mode | 0o700); // its entries can't go otherwise
        }
        for (const name of readdirSync(from)) {
            this.mergeOne(path.join(from, name), path.join(to, name));
        }
        chmodSync(to, st.mode & 0o7777);
        utimesSync(to, st.atimeMs / 1000, st.mtimeMs / 1000);
        try {
            rmdirSync(from);
        } catch (error: unknown) {
            if (errnoOf(error) !== 'ENOTEMPTY') throw error;
            if (readOnly) chmodSync(from, st.mode & 0o7777); // something stays in it
        }
        return true;
    }

    // Copied beside where it goes, under a name of its own, given the source's mode and times and made durable; put in
    // place without replacing anything; checked; and only then is the source removed
    private copyFile(from: string, to: string): boolean {
        const copy = path.join(
            path.dirname(to),
            `${COPY_PREFIX}${createHash('sha1').update(path.basename(to)).digest('hex').slice(0, 16)}`,
        );
        let st = lstatSync(from);
        for (let attempt = 1; ; attempt++) {
            removeOwnCopy(copy); // a copy cut short by a crash
            try {
                (this.opts.seams.copyFile ?? copyExclusive)(from, copy);
                chmodSync(copy, st.mode & 0o7777);
                utimesSync(copy, st.atimeMs / 1000, st.mtimeMs / 1000);
                syncToDisk(copy);
                this.opts.seams.onStep?.('copied', from);
            } catch (error: unknown) {
                removeOwnCopy(copy); // never anything but our own incomplete copy
                throw error;
            }
            const now = lstatSync(from);
            if (sameSizeAndTime(lstatSync(copy), st) && sameSizeAndTime(now, st)) {
                break;
            }
            removeOwnCopy(copy);
            if (attempt === 3) {
                throw new Error(`${from} keeps changing while it is copied; it stays where it is`);
            }
            st = now;
        }
        if (!moveWithoutReplacing(copy, to)) {
            removeOwnCopy(copy);
            return false; // the name was taken meanwhile: the merge looks again
        }
        syncToDisk(path.dirname(to));
        this.opts.seams.onStep?.('placed', to);
        if (!sameSizeAndTime(lstatSync(to), st)) {
            throw new Error(`The copy of ${from} at ${to} doesn't match it; ${from} stays where it is`);
        }
        unlinkSync(from);
        this.opts.seams.onStep?.('removed', from);
        return true;
    }
}

function copyExclusive(from: string, to: string): void {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
}

function removeOwnCopy(copy: string): void {
    try {
        unlinkSync(copy);
    } catch (error: unknown) {
        if (errnoOf(error) !== 'ENOENT') throw error;
    }
}

// So that a power cut after the source goes can't lose what the copy holds
function syncToDisk(p: string): void {
    const fd = openSync(p, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function sameSizeAndTime(a: Stats, b: Stats): boolean {
    return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;
}

function kindOf(st: Stats): string {
    if (st.isFIFO()) return 'fifo';
    if (st.isSocket()) return 'socket';
    return 'device';
}
