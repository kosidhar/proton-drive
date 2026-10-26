import { accessSync, closeSync, constants, lstatSync, openSync, readdirSync, readlinkSync, readSync, rmdirSync, type Stats, unlinkSync } from 'node:fs';
import path from 'node:path';

import { formatConflictFileName } from './conflictResolver';
import { moveWithoutReplacing } from './localMove';

export interface MergeOptions {
    now?: Date; // the time in conflict names
    // Moves an entry to a path that must be free, never replacing what is there; false when the path is taken.
    // moveWithoutReplacing unless given (moving files between disks copies them).
    move?: (from: string, to: string) => boolean;
    // Which entry keeps a name both have: the one already there (the default: the incoming one gets a conflict name),
    // or the incoming one (the one there steps aside to a conflict name)
    keepsName?: 'existing' | 'incoming';
    // A source folder still holding something once merged is left for a later round instead of failing (ENOTEMPTY)
    leaveNonEmptyFolders?: boolean;
    // For tests: runs as an emptied source folder is about to go
    beforeRmdir?: (folder: string) => void;
}

// Moves an entry to a path, never replacing anything there: a folder already at the path is merged into, entry by
// entry, and when both have a name, one of them gets a conflict name (see keepsName). A second name of the same file,
// or an identical copy of it, is dropped rather than kept twice. Answers where conflict-named entries went. Throws when
// something can't be moved; what wasn't moved stays put.
export function mergeInto(from: string, to: string, opts: MergeOptions = {}): string[] {
    const renamed: string[] = [];
    mergeEntry(from, to, opts.now ?? new Date(), renamed, opts);
    return renamed;
}

function mergeEntry(from: string, to: string, now: Date, renamed: string[], opts: MergeOptions): void {
    const move = opts.move ?? moveWithoutReplacing;
    // moveWithoutReplacing undoes a move it can't finish without saying why; this says why first
    accessSync(path.dirname(from), constants.W_OK | constants.X_OK);
    for (let attempt = 0; attempt < 3; attempt++) {
        const there = lstatSync(to, { throwIfNoEntry: false });
        if (!there) {
            if (move(from, to)) return;
            if (!lstatSync(to, { throwIfNoEntry: false })) throw new Error(`Could not move ${from} to ${to}`);
            continue; // the name was taken meanwhile
        }
        const coming = lstatSync(from);
        if (there.isDirectory() && coming.isDirectory()) {
            for (const name of readdirSync(from)) {
                mergeEntry(path.join(from, name), path.join(to, name), now, renamed, opts);
            }
            opts.beforeRmdir?.(from);
            try {
                rmdirSync(from); // ENOTEMPTY if something new arrived: then this folder isn't merged yet
            } catch (error: unknown) {
                if (!opts.leaveNonEmptyFolders || (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
            }
            return;
        }
        if (sameContent(from, coming, to, there)) {
            unlinkSync(from); // what is there already holds every byte of it (a move cut short by a crash leaves this)
            return;
        }
        if (opts.keepsName === 'incoming') {
            // Beside it, in the same folder: a plain rename that never replaces
            renamed.push(moveToConflictName(to, to, now, moveWithoutReplacing));
            continue;
        }
        renamed.push(moveToConflictName(from, to, now, move));
        return;
    }
    throw new Error(`Could not move ${from} to ${to}: its name keeps changing`);
}

function moveToConflictName(from: string, to: string, now: Date, move: (from: string, to: string) => boolean): string {
    const name = formatConflictFileName(path.basename(to), now);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 0; n < 1000; n++) {
        const candidate = path.join(path.dirname(to), n === 0 ? name : `${stem}-${n}${ext}`);
        if (move(from, candidate)) return candidate;
    }
    throw new Error(`No free conflict name for ${to}`);
}

// Two names of one file, two links to the same place, or two files with the same size, time and bytes (never folders)
function sameContent(a: string, aStat: Stats, b: string, bStat: Stats): boolean {
    if (aStat.isDirectory() || bStat.isDirectory()) return false;
    if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) return true;
    if (aStat.isSymbolicLink() && bStat.isSymbolicLink()) return readlinkSync(a) === readlinkSync(b);
    if (!aStat.isFile() || !bStat.isFile() || aStat.size !== bStat.size || Math.abs(aStat.mtimeMs - bStat.mtimeMs) >= 1) {
        return false;
    }
    return sameBytes(a, b);
}

function sameBytes(a: string, b: string): boolean {
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
