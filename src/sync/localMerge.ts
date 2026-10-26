import { accessSync, closeSync, constants, lstatSync, openSync, readdirSync, readlinkSync, readSync, rmdirSync, type Stats, unlinkSync } from 'node:fs';

import { conflictMark } from './conflictResolver';
import { moveWithoutReplacing } from './localMove';

// Paths here are bytes: a name that isn't valid UTF-8 must move as it is, and a string can't hold it
const SLASH = 0x2f;
const NAME_MAX = 255; // bytes in one name
const CONFLICT = Buffer.from(' (conflict ');

export function bytesOf(p: string | Buffer): Buffer {
    return typeof p === 'string' ? Buffer.from(p) : p;
}

export function joinBytes(dir: Buffer, name: Buffer): Buffer {
    return Buffer.concat([dir, Buffer.from([SLASH]), name]);
}

export function parentOf(p: Buffer): Buffer {
    const slash = p.lastIndexOf(SLASH);
    return slash > 0 ? p.subarray(0, slash) : Buffer.from(slash === 0 ? '/' : '.');
}

export function nameOf(p: Buffer): Buffer {
    return p.subarray(p.lastIndexOf(SLASH) + 1);
}

export interface MergeOptions {
    now?: Date; // the time in conflict names
    // Moves an entry to a path that must be free, never replacing what is there; false when the path is taken.
    // moveWithoutReplacing unless given (moving files between disks copies them).
    move?: (from: Buffer, to: Buffer) => boolean;
    // Which entry keeps a name both have: the one already there (the default: the incoming one gets a conflict name),
    // or the incoming one (the one there steps aside to a conflict name)
    keepsName?: 'existing' | 'incoming';
    // A source folder still holding something once merged is left for a later round instead of failing (ENOTEMPTY)
    leaveNonEmptyFolders?: boolean;
    // Whether a file's mode is part of what makes two copies the same (unless the destination can't keep modes)
    modesMatter?: boolean;
    // Runs before entries move out of a source folder into the folder already there (stats from before), so that both
    // can be made writable
    openFolders?: (from: Buffer, fromStat: Stats, to: Buffer, toStat: Stats) => void;
    // Runs after a folder's entries change here (an entry dropped, stepped aside or removed), with that folder
    changed?: (dir: Buffer) => void;
    // For tests: runs as an emptied source folder is about to go
    beforeRmdir?: (folder: string) => void;
}

// Moves an entry to a path, never replacing anything there: a folder already at the path is merged into, entry by
// entry, and when both have a name, one of them gets a conflict name (see keepsName) that fits in a name. A second name
// of the same file, or a copy with the same bytes, is dropped rather than kept twice. Answers where conflict-named
// entries went. Throws when something can't be moved; what wasn't moved stays put.
export function mergeInto(from: string | Buffer, to: string | Buffer, opts: MergeOptions = {}): string[] {
    const renamed: Buffer[] = [];
    mergeEntry(bytesOf(from), bytesOf(to), opts.now ?? new Date(), renamed, opts);
    return renamed.map((p) => p.toString());
}

function mergeEntry(from: Buffer, to: Buffer, now: Date, renamed: Buffer[], opts: MergeOptions): void {
    const move = opts.move ?? moveWithoutReplacing;
    // moveWithoutReplacing undoes a move it can't finish without saying why; this says why first
    accessSync(parentOf(from), constants.W_OK | constants.X_OK);
    for (let attempt = 0; attempt < 3; attempt++) {
        const there = lstatSync(to, { throwIfNoEntry: false });
        if (!there) {
            if (move(from, to)) return;
            if (!lstatSync(to, { throwIfNoEntry: false })) throw new Error(`Could not move ${from} to ${to}`);
            continue; // the name was taken meanwhile
        }
        const coming = lstatSync(from);
        if (there.isDirectory() && coming.isDirectory()) {
            opts.openFolders?.(from, coming, to, there);
            for (const name of readdirSync(from, { encoding: 'buffer' })) {
                mergeEntry(joinBytes(from, name), joinBytes(to, name), now, renamed, opts);
            }
            opts.beforeRmdir?.(from.toString());
            try {
                rmdirSync(from); // ENOTEMPTY if something new arrived: then this folder isn't merged yet
            } catch (error: unknown) {
                if (!opts.leaveNonEmptyFolders || (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
                return;
            }
            opts.changed?.(parentOf(from));
            return;
        }
        if (sameContent(from, coming, to, there, opts.modesMatter ?? true)) {
            unlinkSync(from); // what is there already holds every byte of it (a move cut short by a crash leaves this)
            opts.changed?.(parentOf(from));
            return;
        }
        if (opts.keepsName === 'incoming') {
            // Beside it, in the same folder: a plain rename that never replaces
            renamed.push(moveToConflictName(to, to, now, moveWithoutReplacing, opts));
            continue;
        }
        renamed.push(moveToConflictName(from, to, now, move, opts));
        return;
    }
    throw new Error(`Could not move ${from} to ${to}: its name keeps changing`);
}

// Moves an entry to a free conflict name of `to`, beside it. One whose earlier move there was cut short between link(2)
// and unlink(2) already has a conflict name in that folder: only this name of it goes.
function moveToConflictName(entry: Buffer, to: Buffer, now: Date, move: (from: Buffer, to: Buffer) => boolean, opts: MergeOptions): Buffer {
    const dir = parentOf(to);
    const st = lstatSync(entry);
    if (!st.isDirectory() && st.nlink > 1) {
        const twin = conflictTwin(dir, entry, st);
        if (twin) {
            unlinkSync(entry);
            opts.changed?.(parentOf(entry));
            return twin;
        }
    }
    for (let n = 0; n < 1000; n++) {
        const candidate = joinBytes(dir, conflictName(nameOf(to), now, n));
        if (move(entry, candidate)) {
            opts.changed?.(dir);
            opts.changed?.(parentOf(entry));
            return candidate;
        }
    }
    throw new Error(`No free conflict name for ${to}`);
}

function conflictTwin(dir: Buffer, entry: Buffer, st: Stats): Buffer | null {
    for (const name of readdirSync(dir, { encoding: 'buffer' })) {
        if (!name.includes(CONFLICT)) continue;
        const other = joinBytes(dir, name);
        const ost = lstatSync(other, { throwIfNoEntry: false });
        if (ost && ost.dev === st.dev && ost.ino === st.ino && !other.equals(entry)) return other;
    }
    return null;
}

// formatConflictFileName (with -<n> for the n-th taken), in bytes, its stem shortened to fit NAME_MAX without
// splitting a UTF-8 sequence
export function conflictName(name: Buffer, now: Date, n = 0): Buffer {
    const dot = name.lastIndexOf(0x2e);
    const hasExt = dot > 0 && dot < name.length - 1;
    const mark = Buffer.from(`${conflictMark(now)}${n > 0 ? `-${n}` : ''}`);
    let [stem, ext] = hasExt ? [name.subarray(0, dot), name.subarray(dot)] : [name, Buffer.alloc(0)];
    if (mark.length + ext.length >= NAME_MAX) {
        [stem, ext] = [name, Buffer.alloc(0)]; // an extension too long to keep is kept as part of the stem
    }
    const room = NAME_MAX - mark.length - ext.length;
    if (stem.length > room) {
        let end = room;
        while (end > 0 && (stem[end]! & 0xc0) === 0x80) end--; // not in the middle of a character
        stem = stem.subarray(0, end);
    }
    return Buffer.concat([stem, mark, ext]);
}

// Two names of one file, two links to the same place, or two files with the same bytes and mode (never folders)
function sameContent(a: Buffer, aStat: Stats, b: Buffer, bStat: Stats, modesMatter: boolean): boolean {
    if (aStat.isDirectory() || bStat.isDirectory()) return false;
    if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) return true;
    if (aStat.isSymbolicLink() && bStat.isSymbolicLink()) {
        return (readlinkSync(a, { encoding: 'buffer' }) as Buffer).equals(readlinkSync(b, { encoding: 'buffer' }) as Buffer);
    }
    if (!aStat.isFile() || !bStat.isFile() || aStat.size !== bStat.size) return false;
    if (modesMatter && (aStat.mode & 0o7777) !== (bStat.mode & 0o7777)) return false;
    return sameBytes(a, b);
}

export function sameBytes(a: string | Buffer, b: string | Buffer): boolean {
    const [fa, fb] = [openSync(a, 'r'), openSync(b, 'r')];
    try {
        const [ba, bb] = [Buffer.alloc(1 << 16), Buffer.alloc(1 << 16)];
        for (;;) {
            const na = readFull(fa, ba);
            const nb = readFull(fb, bb);
            if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
            if (na < ba.length) return true;
        }
    } finally {
        closeSync(fa);
        closeSync(fb);
    }
}

// Fills the buffer unless the file ends first; answers how much it read
function readFull(fd: number, buf: Buffer): number {
    let n = 0;
    while (n < buf.length) {
        const got = readSync(fd, buf, n, buf.length - n, null);
        if (got === 0) break;
        n += got;
    }
    return n;
}
