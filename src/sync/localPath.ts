import path from 'node:path';

import { remoteNameProblem } from '../sdk/node';

// The one way a path on disk is made from a relative path of the sync folder or the backing store (a record's, the
// remote index's, or one made of names from Proton Drive): localPathIn refuses any that could lead elsewhere (#536).
// Remote names are checked where they come in (see remoteNameProblem); this is what stops one that got past that, or a
// bad path a sync before #536 left in the records, from ever reaching the disk.

// A relative path that would lead outside its root, or to no item in it. Callers skip the item and log it: it is never
// a reason to delete anything, nor taken for something deleted here or in Proton Drive.
export class UnsafeLocalPathError extends Error {
    readonly code = 'EUNSAFEPATH';

    constructor(
        readonly root: string,
        readonly relPath: string,
        reason: string,
    ) {
        super(`Not a path inside ${root}: ${JSON.stringify(relPath)} (${reason})`);
        this.name = 'UnsafeLocalPathError';
    }
}

// Why a relative path can't name an item inside its root, or null when it can. '' is the root itself. Anything else is
// names joined by single slashes, none of them empty, `.` or `..`, and no NUL anywhere.
export function relPathProblem(relPath: string): string | null {
    if (relPath === '') {
        return null;
    }
    if (relPath.startsWith('/')) {
        return 'it is absolute';
    }
    for (const segment of relPath.split('/')) {
        const problem = remoteNameProblem(segment);
        if (problem !== null) {
            return problem === 'it is empty' ? 'it has an empty name in it' : `a name in it: ${problem}`;
        }
    }
    return null;
}

export function isSafeRelPath(relPath: string): boolean {
    return relPathProblem(relPath) === null;
}

// The path on disk of the item at relPath inside root ('' is root). Throws UnsafeLocalPathError for an absolute path, an
// empty, `.` or `..` name, a NUL, or anything that resolves outside root.
export function localPathIn(root: string, relPath: string): string {
    const problem = relPathProblem(relPath);
    if (problem !== null) {
        throw new UnsafeLocalPathError(root, relPath, problem);
    }
    const full = path.join(root, relPath);
    const back = path.relative(root, full);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back) || back.includes('\0')) {
        throw new UnsafeLocalPathError(root, relPath, 'it leads outside');
    }
    return full;
}

// An SQL condition that holds for every non-empty relative path in `column` that relPathProblem refuses: a `.` or `..`
// name, an empty one (a path that starts or ends with '/', or holds '//'), a NUL, or a path long enough to hold a
// segment over 255 UTF-8 bytes. Only the rows it finds are read, and each is checked again with relPathProblem.
export const UNSAFE_PATH_SQL = (column: string) =>
    `(${column} IN ('.', '..') OR ${column} LIKE './%' OR ${column} LIKE '../%' OR ${column} LIKE '%/.' OR ${column} LIKE '%/..'
      OR ${column} LIKE '%/./%' OR ${column} LIKE '%/../%' OR ${column} LIKE '%//%' OR ${column} LIKE '/%' OR ${column} LIKE '%/'
      OR instr(${column}, char(0)) > 0 OR length(CAST(${column} AS BLOB)) > 255)`;
