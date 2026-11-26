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
    type PathLike,
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
import { joinBytes, mergeInto, type MergeOptions, nameOf, parentOf, sameBytes } from './localMerge';
import { isSafeRelPath, localPathIn } from './localPath';
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
// Meta key: the modes of read-only folders a move made writable, put back once it is done (a crash can't lose them)
const FOLDER_MODES = 'moveFolderModes';
// A copy in progress, beside where it goes (the sync ignores, and the drive hides, every .proton-drive-tmp-* name)
const COPY_PREFIX = '.proton-drive-tmp-move-';
// Rounds of moving what is in the source folder: an app may save into the sync folder while its files move out
const MOVE_ROUNDS = 3;
// What a disk that can't keep a mode or times answers chmod or utimes with
const ATTRIBUTE_REFUSALS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL']);

// After each step, for a test to stop the move there as a crash would: a top-level entry done; a read-only folder made
// writable; a folder made at the destination; a file copied beside where it goes, put there, its source removed
export type MoveStep = 'entry' | 'opened' | 'made' | 'copied' | 'placed' | 'removed';

export interface MoveSeams {
    // The move on one disk (moveWithoutReplacing); EXDEV from it takes the copy path
    moveSameDisk?: (from: Buffer, to: Buffer) => boolean;
    // Copies a file to a path that must be free
    copyFile?: (from: Buffer, to: Buffer) => void;
    // A mode or times set at the destination (chmod, utimes in seconds): best effort, as some disks can't keep them
    setMode?: (p: Buffer, mode: number) => void;
    setTimes?: (p: Buffer, atimeSec: number, mtimeSec: number) => void;
    // fsync of a folder whose entries changed, before the move is recorded as done
    fsyncDir?: (dir: Buffer) => void;
    // Whether the destination takes two names that differ only in case for one (FAT, exFAT); probed otherwise
    destinationFoldsCase?: () => boolean;
    deviceOf?: (p: string) => number;
    readMountInfo?: () => string;
    onStep?: (step: MoveStep, path: string) => void;
}

// Moving into the drive's store takes renames on one disk; a copy of everything is never made that way
export class DifferentDiskError extends Error {}

function errnoOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | null)?.code;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Moves the files to the layout given, finishing first a move that was cut short (meta layoutMoving, which is set for
// as long as files move). Moving into the backing store takes renames on one disk: a sync folder found on another disk
// before anything moves stays as it is ('different-disk'); a cross-device refusal once the move began throws
// DifferentDiskError with the move still marked, for the caller to move everything back. Moving out copies across disks
// when it has to, file by file, verifying each copy before its source goes. The engine and the drive must be stopped
// meanwhile. Throws when the files can't all move, with the move still marked so the next run finishes it; refuses
// (throwing before anything moves) a sync folder that overlaps the app's own files, or that something is mounted at.
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
    // Either way: files moved into a mount go into the drive, and a listing of one isn't what is on disk
    refuseIfMounted(syncDir, seams.readMountInfo ?? readMountInfo);
    if (target === 'virtual' && !resuming) {
        if (hasEntries(syncDir) && !onSameDisk(syncDir, backingDir, seams.deviceOf)) {
            logger.warn(`${syncDir} and ${backingDir} are on different disks: the files stay in ${syncDir}`);
            return 'different-disk';
        }
        // Moving back after a failure moves everything in the store out: it must hold nothing but what came in
        const taken = takenNames(syncDir, backingDir);
        if (taken.length > 0) {
            const message = `${backingDir} already holds ${taken.join(', ')}, as ${syncDir} does: not moving the files into it (move those out of ${backingDir} first)`;
            logger.warn(message);
            throw new Error(message);
        }
    }

    const [from, to] = target === 'virtual' ? [syncDir, backingDir] : [backingDir, syncDir];
    mkdirSync(to, target === 'virtual' ? { recursive: true, mode: 0o700 } : { recursive: true });
    if (target === 'plain') {
        chmodSync(syncDir, 0o755); // the drive's mount point is 0555 while unmounted
    }
    refuseCaseClashes(from, to, seams, logger);
    stateDb.setMeta(LAYOUT_MOVING, target);
    const mover = new Mover({ stateDb, logger, now: opts.now ?? new Date(), allowCopy: target === 'plain', seams, from, to });
    const left = existsSync(from) ? mover.moveAll() : [];
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
// move, with the move still marked (meta syncDirMoving) for finishRelocation to finish at the next start, or for a
// relocation back to undo.
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
    // Everything in the new folder then came from the old one: a move that stops can be undone exactly, and nothing
    // unrelated is pulled into the sync folder. A move cut short (still marked) holds what it moved already.
    if (stateDb.getMeta(SYNC_DIR_MOVING) === null && holdsFiles(to)) {
        throw new Error(emptyFolderNeeded(to));
    }
    // The folder may have appeared while the move waited (the engine's hold): it is looked at again where it is used. A
    // move cut short (still marked) holds what it moved already, and a move back goes to the user's own old folder.
    const fresh = stateDb.getMeta(SYNC_DIR_MOVING) === null;
    if (makeUserFolder(to) === 'existed' && fresh) {
        const unsafe = unsafeFolderReason(to);
        if (unsafe !== null) throw new Error(unsafe);
        if (holdsFiles(to)) throw new Error(emptyFolderNeeded(to));
    }
    refuseCaseClashes(from, to, opts.seams ?? {}, logger);
    stateDb.setMeta(SYNC_DIR_MOVING, JSON.stringify({ from, to }));
    const mover = new Mover({ stateDb, logger, now: opts.now ?? new Date(), allowCopy: true, seams: opts.seams ?? {}, from, to });
    const left = existsSync(from) ? mover.moveAll() : [];
    if (left.length > 0) {
        logger.warn(`Left in ${from}, as they can't move to another disk: ${left.join(', ')}`);
    }
    // A record of a path that could lead outside the folder is left as it is, never looked up: the engine drops it (#536)
    const gone = stateDb
        .getAllItems()
        .filter((item) => isSafeRelPath(item.localRelPath) && !lstatSync(localPathIn(to, item.localRelPath), { throwIfNoEntry: false }));
    stateDb.connection.transaction(() => {
        for (const item of gone) {
            stateDb.removeItemByPath(item.localRelPath);
        }
        stateDb.updateSettings({ syncDir: to });
        stateDb.deleteMeta(SYNC_DIR_MOVING);
    })();
    logger.info(`Moved the files in ${from} into ${to}, the new Proton Drive folder`);
}

// A relocation cut short (meta syncDirMoving), or null. Throws when the note can't be read: where the files went is
// then unknown, and nothing may look at them until someone does.
export function pendingRelocation(stateDb: SyncStateDatabase): { from: string; to: string } | null {
    const raw = stateDb.getMeta(SYNC_DIR_MOVING);
    if (raw === null) {
        return null;
    }
    let intent: { from?: unknown; to?: unknown } = {};
    try {
        intent = JSON.parse(raw) as typeof intent;
    } catch {
        // Reported below
    }
    if (typeof intent.from !== 'string' || typeof intent.to !== 'string') {
        throw new Error(`Can't tell where the Proton Drive folder was moving (${raw})`);
    }
    return { from: intent.from, to: intent.to };
}

// Finishes a relocation cut short; answers whether there was one. Throws as relocateFiles does.
export async function finishRelocation(opts: { stateDb: SyncStateDatabase; logger: Logger; seams?: MoveSeams }): Promise<boolean> {
    const pending = pendingRelocation(opts.stateDb);
    if (!pending) {
        return false;
    }
    opts.logger.info(`Finishing moving the Proton Drive folder from ${pending.from} to ${pending.to}, cut short last time`);
    await relocateFiles({ stateDb: opts.stateDb, ...pending, logger: opts.logger, seams: opts.seams });
    return true;
}

function refuseIfMounted(syncDir: string, readInfo: () => string): void {
    const at = mountsAt(readInfo(), canonicalPath(syncDir));
    if (at.some((fstype) => fstype === 'fuse' || fstype.startsWith('fuse.'))) {
        throw new Error(`Something (${at.join(', ')}) is still mounted at ${syncDir}; not moving files through it`);
    }
    try {
        statSync(syncDir);
    } catch (error: unknown) {
        if (errnoOf(error) === 'ENOTCONN') {
            throw new Error(`${syncDir} is a dead mount ("Transport endpoint is not connected"); not moving files through it`);
        }
    }
}

// A destination that takes two names differing only in case for one (FAT, exFAT) can't hold both: the second would
// take the first's place. Such names are refused, before anything moves, naming them.
function refuseCaseClashes(from: string, to: string, seams: MoveSeams, logger: Logger): void {
    if (!existsSync(from) || !(seams.destinationFoldsCase ?? (() => foldsCase(to)))()) return;
    const clashes = caseClashes(from);
    if (clashes.length > 0) {
        const message = `${to} doesn't tell apart names that differ only in case, and ${from} holds such names: ${clashes.join('; ')}. Rename them first`;
        logger.warn(message);
        throw new Error(message);
    }
}

// Made under one case, looked for under another
function foldsCase(dir: string): boolean {
    const probe = joinBytes(Buffer.from(dir), Buffer.from(`${COPY_PREFIX}case-probe`));
    try {
        removeOwnCopy(probe);
        closeSync(openSync(probe, 'wx', 0o600));
        return lstatSync(joinBytes(Buffer.from(dir), Buffer.from(`${COPY_PREFIX}case-probe`.toUpperCase())), { throwIfNoEntry: false }) !== undefined;
    } catch {
        return false;
    } finally {
        try {
            removeOwnCopy(probe);
        } catch {
            // left for the next probe
        }
    }
}

// Names in one folder that differ only in case, anywhere in the tree (the first few)
function caseClashes(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: Buffer, rel: string) => {
        const seen = new Map<string, string>();
        for (const name of readdirSync(dir, { encoding: 'buffer' })) {
            const text = name.toString();
            const relPath = rel ? `${rel}/${text}` : text;
            const folded = text.toLowerCase();
            const other = seen.get(folded);
            if (other !== undefined && found.length < 10) found.push(`${other} and ${relPath}`);
            seen.set(folded, relPath);
            const full = joinBytes(dir, name);
            if (lstatSync(full).isDirectory()) walk(full, relPath);
        }
    };
    walk(Buffer.from(root), '');
    return found;
}

// The sync folder's top-level names that the store holds too
function takenNames(syncDir: string, backingDir: string): string[] {
    if (!existsSync(backingDir) || !existsSync(syncDir)) return []; // a missing sync folder is an empty one
    const store = Buffer.from(backingDir);
    return readdirSync(syncDir, { encoding: 'buffer' })
        .filter((name) => lstatSync(joinBytes(store, name), { throwIfNoEntry: false }))
        .map((name) => name.toString());
}

// A folder a sync folder can move to: missing, or holding nothing but what a move cut short leaves (its own copies)
export function holdsFiles(dir: string): boolean {
    try {
        return readdirSync(dir, { encoding: 'buffer' }).some((name) => !name.subarray(0, COPY_PREFIX.length).equals(Buffer.from(COPY_PREFIX)));
    } catch (error: unknown) {
        if (errnoOf(error) === 'ENOENT') return false;
        throw error;
    }
}

// An existing folder a sync folder moves to must be the user's own and closed to others, as the daemon may be asked
// by a program other than the user's app: files moved into a folder another user can write are theirs to read or delete.
// Group-writable is accepted only in the user's own primary group (Ubuntu's user-private groups, where Files makes
// folders 0775); world-writable never.
export function unsafeFolderReason(
    dir: string,
    me: { uid: number; gid: number } | undefined = process.getuid && process.getgid ? { uid: process.getuid(), gid: process.getgid() } : undefined,
): string | null {
    const link = lstatSync(dir, { throwIfNoEntry: false });
    if (link?.isSymbolicLink() && me && link.uid !== me.uid) {
        return `${dir} is a link owned by another user; choose a folder that you own`;
    }
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (link?.isSymbolicLink() && !stat) return `${dir} is a link to a folder that doesn't exist`;
    if (!stat || !me) return null; // a missing folder is made by the daemon, for the user alone
    if (stat.uid !== me.uid) {
        return `${dir} belongs to another user; choose a folder that you own`;
    }
    if ((stat.mode & 0o002) !== 0 || ((stat.mode & 0o020) !== 0 && stat.gid !== me.gid)) {
        return `${dir} can be changed by other users; choose a folder only you can write to, or run chmod go-w on it`;
    }
    return null;
}

// Makes a folder for the user alone (0700) and the parents it lacks with the default mode; 'existed' when it was there
export function makeUserFolder(dir: string): 'made' | 'existed' {
    mkdirSync(path.dirname(dir), { recursive: true });
    try {
        mkdirSync(dir, { mode: 0o700 });
        return 'made';
    } catch (error: unknown) {
        if (errnoOf(error) === 'EEXIST') return 'existed';
        throw error;
    }
}

export function emptyFolderNeeded(dir: string): string {
    return `Choose an empty folder, or a new one: ${dir} already holds files`;
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
export function onSameDisk(a: string, b: string, devOf: (p: string) => number = deviceOf): boolean {
    let existing = path.resolve(b);
    while (!existsSync(existing) && path.dirname(existing) !== existing) {
        existing = path.dirname(existing);
    }
    return devOf(a) === devOf(existing);
}

// The modes of read-only folders a move made writable (rename(2) needs write access to a folder moved to another
// parent, removing entries needs it on their folder, adding entries on theirs), kept in meta until the move is done,
// first value kept, then put back. Keys: `src:<rel>` a source folder (one left behind gets it back), `made:<rel>` a
// folder the move put at the destination (it gets its source's mode), `dst:<rel>` a folder already at the destination
// (it keeps its own), `root:<path>` either root. <rel> is the path relative to the roots, in hex.
type FolderSide = 'src' | 'made' | 'dst';

class FolderModes {
    private readonly modes: Record<string, number>;

    constructor(private readonly stateDb: SyncStateDatabase) {
        try {
            this.modes = JSON.parse(stateDb.getMeta(FOLDER_MODES) ?? '{}') as Record<string, number>;
        } catch {
            this.modes = {};
        }
    }

    remember(key: string, mode: number): void {
        if (key in this.modes) return;
        this.modes[key] = mode;
        this.stateDb.setMeta(FOLDER_MODES, JSON.stringify(this.modes));
    }

    putBack(from: Buffer, to: Buffer, setMode: (p: Buffer, mode: number) => void): void {
        for (const [key, mode] of Object.entries(this.modes)) {
            const [kind, hex] = key.split(':') as [string, string];
            const bytes = Buffer.from(hex, 'hex');
            if (kind === 'dst' && `made:${hex}` in this.modes) continue; // the move made it: its source's mode wins
            const place = kind === 'root' ? bytes : joinBytes(kind === 'src' ? from : to, bytes);
            if (lstatSync(place, { throwIfNoEntry: false })?.isDirectory()) setMode(place, mode);
        }
        this.stateDb.deleteMeta(FOLDER_MODES);
    }
}

interface MoverOptions {
    stateDb: SyncStateDatabase;
    logger: Logger;
    now: Date;
    allowCopy: boolean; // across disks: copy, verify, then remove the source
    seams: MoveSeams;
    from: string;
    to: string;
}

// Moves everything in one folder into another at the same relative paths, never replacing anything: what is already at
// a path steps aside to a conflict name, and a folder there is merged into (see mergeInto). Names and link targets are
// bytes, as they are on disk. A rename on one disk; across disks, when allowed, a copy of each file that is checked
// byte for byte, and made durable, before its source goes (its mode and times are kept where the disk can keep them).
// A symlink moves as a link; a fifo, socket or device only by a rename on one disk: otherwise it stays, with the folder
// holding it, and is logged. Read-only folders are made writable for the move and get their modes back at the end.
// The folders whose entries changed are synced to disk before the move counts as done.
export class Mover {
    private readonly from: Buffer;
    private readonly to: Buffer;
    private readonly merge: MergeOptions;
    private readonly modes: FolderModes;
    private readonly touched = new Map<string, Buffer>();
    private attributeFailures = 0;

    constructor(private readonly opts: MoverOptions) {
        this.from = Buffer.from(opts.from);
        this.to = Buffer.from(opts.to);
        this.modes = new FolderModes(opts.stateDb);
        this.merge = {
            now: opts.now,
            keepsName: 'incoming',
            leaveNonEmptyFolders: true,
            modesMatter: this.destinationKeepsModes(),
            move: (from, to) => this.move(from, to),
            // Both writable while entries move; the folder already there keeps its own mode
            openFolders: (from, fromStat, to, toStat) => {
                this.openFolder(from, fromStat, 'src');
                this.openFolder(to, toStat, 'dst');
            },
            changed: (dir) => this.touch(dir),
        };
    }

    // Whether a mode set at the destination sticks (not on exFAT or FAT): only then is a mode part of a duplicate match
    private destinationKeepsModes(): boolean {
        const probe = joinBytes(this.to, Buffer.from(`${COPY_PREFIX}probe`));
        try {
            removeOwnCopy(probe);
            closeSync(openSync(probe, 'wx', 0o600));
            const setMode = this.opts.seams.setMode ?? chmodSync;
            setMode(probe, 0o600);
            setMode(probe, 0o640);
            return (lstatSync(probe).mode & 0o777) === 0o640;
        } catch {
            return false;
        } finally {
            try {
                removeOwnCopy(probe);
            } catch {
                // left for the next move's probe
            }
        }
    }

    // Answers what is still in the source folder after the last round
    moveAll(): string[] {
        this.openFolder(this.from, lstatSync(this.from), 'src');
        for (let round = 0; round < MOVE_ROUNDS; round++) {
            const names = readdirSync(this.from, { encoding: 'buffer' });
            if (names.length === 0) break;
            for (const name of names) {
                this.mergeOne(joinBytes(this.from, name), joinBytes(this.to, name));
                this.opts.seams.onStep?.('entry', name.toString());
            }
        }
        const left = readdirSync(this.from, { encoding: 'buffer' }).map((name) => name.toString());
        this.modes.putBack(this.from, this.to, (p, mode) => this.setMode(p, mode));
        if (this.attributeFailures > 1) {
            this.opts.logger.warn(`${this.attributeFailures} modes or times couldn't be kept at ${this.opts.to}`);
        }
        this.syncTouched();
        return left;
    }

    private mergeOne(from: Buffer, to: Buffer): void {
        for (const renamed of mergeInto(from, to, this.merge)) {
            this.opts.logger.warn(`Something was already where ${from} goes; it was kept as ${renamed}`);
        }
    }

    // A root by its own path, anything else by its side and its path relative to the root it is in
    private keyOf(p: Buffer, side: FolderSide): string {
        for (const root of [this.from, this.to]) {
            if (p.equals(root)) return `root:${p.toString('hex')}`;
            if (p.length > root.length && p[root.length] === 0x2f && p.subarray(0, root.length).equals(root)) {
                return `${side}:${p.subarray(root.length + 1).toString('hex')}`;
            }
        }
        return `root:${p.toString('hex')}`;
    }

    // Writable for the move, its own mode remembered first
    private openFolder(folder: Buffer, st: Stats, side: FolderSide): void {
        if ((st.mode & 0o300) === 0o300) return;
        this.modes.remember(this.keyOf(folder, side), st.mode & 0o7777);
        chmodSync(folder, (st.mode & 0o7777) | 0o700);
        this.opts.seams.onStep?.('opened', folder.toString());
    }

    private touch(dir: Buffer): void {
        this.touched.set(dir.toString('hex'), dir);
    }

    // A power cut after the move is recorded as done must not bring back where things were
    private syncTouched(): void {
        const fsyncDir = this.opts.seams.fsyncDir ?? syncToDisk;
        for (const dir of [this.from, this.to, ...this.touched.values()]) {
            try {
                fsyncDir(dir);
            } catch (error: unknown) {
                if (errnoOf(error) !== 'ENOENT') throw error;
            }
        }
    }

    private setMode(p: Buffer, mode: number): void {
        this.bestEffort(() => (this.opts.seams.setMode ?? chmodSync)(p, mode), `the mode of ${p}`);
    }

    private setTimes(p: Buffer, st: Stats): void {
        this.bestEffort(() => (this.opts.seams.setTimes ?? utimesSync)(p, st.atimeMs / 1000, st.mtimeMs / 1000), `the times of ${p}`);
    }

    // Some disks (exFAT, FAT) can't keep a mode, or keep times only to 10 ms or 2 s: a refusal is never a reason to stop.
    // Anything else (an I/O error) stops the move, which the next run finishes.
    private bestEffort(set: () => void, what: string): void {
        try {
            set();
        } catch (error: unknown) {
            if (!ATTRIBUTE_REFUSALS.has(errnoOf(error) ?? '')) throw error;
            if (++this.attributeFailures === 1) this.opts.logger.warn(`Couldn't keep ${what}: ${messageOf(error)}`);
        }
    }

    // To a path that must be free; false when it is taken
    private move(from: Buffer, to: Buffer): boolean {
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
            return this.copyAcross(from, to);
        }
        if (moved) {
            this.touch(parentOf(from));
            this.touch(parentOf(to));
        }
        return moved;
    }

    // A folder moved to another parent must be writable (rename(2) updates its '..'): a read-only one is made writable
    // for the move, and gets its mode back at the end
    private moveOnDisk(from: Buffer, to: Buffer): boolean {
        const moveSameDisk = this.opts.seams.moveSameDisk ?? moveWithoutReplacing;
        try {
            return moveSameDisk(from, to);
        } catch (error: unknown) {
            const st = lstatSync(from, { throwIfNoEntry: false });
            if (errnoOf(error) !== 'EACCES' || !st?.isDirectory() || st.mode & 0o200) {
                throw error;
            }
            this.modes.remember(this.keyOf(from, 'made'), st.mode & 0o7777); // where it lands, it keeps its mode
            this.openFolder(from, st, 'src');
            return moveSameDisk(from, to);
        }
    }

    private copyAcross(from: Buffer, to: Buffer): boolean {
        const st = lstatSync(from);
        if (st.isDirectory()) {
            return this.copyFolder(from, to, st);
        }
        if (st.isSymbolicLink()) {
            try {
                symlinkSync(readlinkSync(from, { encoding: 'buffer' }) as Buffer, to);
            } catch (error: unknown) {
                if (errnoOf(error) === 'EEXIST') return false;
                throw error;
            }
            this.bestEffort(() => lutimesSync(to, st.atimeMs / 1000, st.mtimeMs / 1000), `the times of ${to}`);
            syncToDisk(parentOf(to));
            this.opts.seams.onStep?.('placed', to.toString());
            unlinkSync(from);
            this.touch(parentOf(from));
            this.opts.seams.onStep?.('removed', from.toString());
            return true;
        }
        if (!st.isFile()) {
            this.opts.logger.warn(`${from} is a ${kindOf(st)}, which moves only within one disk: it stays where it is`);
            return true; // done with it
        }
        return this.copyFile(from, to);
    }

    // Made beside where it goes with the source's mode (a read-only one writable until the end of the move), put in place
    // at once, filled entry by entry and given the source's times; the source goes once it is empty. Cut short
    // anywhere, the next run merges into it, and the modes are put back at the end of the move.
    private copyFolder(from: Buffer, to: Buffer, st: Stats): boolean {
        if ((st.mode & 0o300) !== 0o300) {
            this.modes.remember(this.keyOf(from, 'src'), st.mode & 0o7777);
            this.modes.remember(this.keyOf(from, 'made'), st.mode & 0o7777);
        }
        const made = joinBytes(parentOf(to), Buffer.from(`${COPY_PREFIX}dir-${createHash('sha1').update(nameOf(to)).digest('hex').slice(0, 16)}`));
        removeOwnFolder(made); // one a crash left before it was put in place: always empty
        mkdirSync(made, 0o700);
        this.setMode(made, (st.mode & 0o7777) | 0o700);
        if (!moveWithoutReplacing(made, to)) {
            removeOwnFolder(made);
            return false; // the name was taken meanwhile: the merge looks again
        }
        this.touch(parentOf(to));
        this.opts.seams.onStep?.('made', to.toString());
        this.openFolder(from, st, 'src');
        for (const name of readdirSync(from, { encoding: 'buffer' })) {
            this.mergeOne(joinBytes(from, name), joinBytes(to, name));
        }
        this.setTimes(to, st);
        try {
            rmdirSync(from);
            this.touch(parentOf(from));
        } catch (error: unknown) {
            if (errnoOf(error) !== 'ENOTEMPTY') throw error;
            this.opts.logger.warn(`${from} still holds something that can't move to another disk: it stays`);
        }
        return true;
    }

    // Copied beside where it goes, under a name of its own, given the source's mode and times where the disk keeps them,
    // made durable and checked byte for byte against the source (which must not have changed meanwhile); put in place
    // without replacing anything; and only then is the source removed
    private copyFile(from: Buffer, to: Buffer): boolean {
        const copy = joinBytes(
            parentOf(to),
            Buffer.from(`${COPY_PREFIX}${createHash('sha1').update(nameOf(to)).digest('hex').slice(0, 16)}`),
        );
        let st = lstatSync(from);
        for (let attempt = 1; ; attempt++) {
            removeOwnCopy(copy); // a copy cut short by a crash
            let good = false;
            try {
                (this.opts.seams.copyFile ?? copyExclusive)(from, copy);
                this.setMode(copy, st.mode & 0o7777);
                this.setTimes(copy, st);
                syncToDisk(copy);
                this.opts.seams.onStep?.('copied', from.toString());
                const now = lstatSync(from);
                good = now.size === st.size && now.mtimeMs === st.mtimeMs && lstatSync(copy).size === st.size && sameBytes(from, copy);
                if (!good) st = now;
            } catch (error: unknown) {
                removeOwnCopy(copy); // never anything but our own incomplete copy
                throw error;
            }
            if (good) break;
            removeOwnCopy(copy);
            if (attempt === 3) {
                throw new Error(`${from} keeps changing while it is copied, or its copy doesn't match it; it stays where it is`);
            }
        }
        const copied = lstatSync(copy);
        if (!moveWithoutReplacing(copy, to)) {
            removeOwnCopy(copy);
            return false; // the name was taken meanwhile: the merge looks again
        }
        syncToDisk(parentOf(to));
        this.touch(parentOf(to));
        this.opts.seams.onStep?.('placed', to.toString());
        const placed = lstatSync(to);
        if (placed.ino !== copied.ino || placed.dev !== copied.dev || placed.size !== st.size) {
            throw new Error(`The copy of ${from} at ${to} isn't what was checked; ${from} stays where it is`);
        }
        unlinkSync(from);
        this.touch(parentOf(from));
        this.opts.seams.onStep?.('removed', from.toString());
        return true;
    }
}

function copyExclusive(from: Buffer, to: Buffer): void {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
}

function removeOwnFolder(folder: Buffer): void {
    try {
        rmdirSync(folder);
    } catch (error: unknown) {
        if (errnoOf(error) !== 'ENOENT') throw error;
    }
}

function removeOwnCopy(copy: Buffer): void {
    try {
        unlinkSync(copy);
    } catch (error: unknown) {
        if (errnoOf(error) !== 'ENOENT') throw error;
    }
}

// So that a power cut after the source goes can't lose what the copy holds
function syncToDisk(p: PathLike): void {
    const fd = openSync(p, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function kindOf(st: Stats): string {
    if (st.isFIFO()) return 'fifo';
    if (st.isSocket()) return 'socket';
    return 'device';
}
