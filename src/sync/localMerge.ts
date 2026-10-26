import { accessSync, constants, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';

import { formatConflictFileName } from './conflictResolver';
import { moveWithoutReplacing } from './localMove';

export interface MergeOptions {
    now?: Date; // the time in conflict names
    // For tests: runs as an emptied source folder is about to go
    beforeRmdir?: (folder: string) => void;
}

// Moves an entry to a path, never replacing anything there: a folder already at the path is merged into, entry by
// entry, and an entry whose name is taken there gets a conflict name. Answers where conflict-named entries went.
// Throws when something can't be moved; what wasn't moved stays put.
export function mergeInto(from: string, to: string, opts: MergeOptions = {}): string[] {
    const renamed: string[] = [];
    mergeEntry(from, to, opts.now ?? new Date(), renamed, opts);
    return renamed;
}

function mergeEntry(from: string, to: string, now: Date, renamed: string[], opts: MergeOptions): void {
    // moveWithoutReplacing undoes a move it can't finish without saying why; this says why first
    accessSync(path.dirname(from), constants.W_OK | constants.X_OK);
    for (let attempt = 0; attempt < 3; attempt++) {
        const there = lstatSync(to, { throwIfNoEntry: false });
        if (!there) {
            if (moveWithoutReplacing(from, to)) return;
            if (!lstatSync(to, { throwIfNoEntry: false })) throw new Error(`Could not move ${from} to ${to}`);
            continue; // the name was taken meanwhile
        }
        if (there.isDirectory() && lstatSync(from).isDirectory()) {
            for (const name of readdirSync(from)) {
                mergeEntry(path.join(from, name), path.join(to, name), now, renamed, opts);
            }
            opts.beforeRmdir?.(from);
            rmdirSync(from); // ENOTEMPTY if something new arrived: then this folder isn't merged yet
            return;
        }
        renamed.push(moveToConflictName(from, to, now));
        return;
    }
    throw new Error(`Could not move ${from} to ${to}: its name keeps changing`);
}

function moveToConflictName(from: string, to: string, now: Date): string {
    const name = formatConflictFileName(path.basename(to), now);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 0; n < 1000; n++) {
        const candidate = path.join(path.dirname(to), n === 0 ? name : `${stem}-${n}${ext}`);
        if (moveWithoutReplacing(from, candidate)) return candidate;
    }
    throw new Error(`No free conflict name for ${to}`);
}
