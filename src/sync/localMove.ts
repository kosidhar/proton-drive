import { linkSync, lstatSync, renameSync, unlinkSync } from 'node:fs';

// Moves a file or folder to a path that must be free, never replacing what is there, and says whether it moved; it
// throws when the move itself fails. rename(2) would replace a file at the new path, so a file is hard-linked there
// first, which fails at once if anything is there, and then unlinked from its old path. Where hard links aren't
// supported, a look just before the rename has to do. A folder is renamed: that fails onto anything but an empty
// folder, and an empty folder holds nothing to lose. Synchronous, so the caller can move records along with it with
// nothing running in between.
export function moveWithoutReplacing(from: string, to: string): boolean {
    if (!lstatSync(from).isDirectory()) {
        try {
            linkSync(from, to);
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
                return false;
            }
            if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') {
                throw error;
            }
            return renameIfFree(from, to); // No hard links on this file system
        }
        try {
            unlinkSync(from);
        } catch {
            unlinkSync(to); // Left as it was: the new link goes again
            return false;
        }
        return true;
    }
    return renameIfFree(from, to);
}

function renameIfFree(from: string, to: string): boolean {
    if (lstatSync(to, { throwIfNoEntry: false })) {
        return false;
    }
    renameSync(from, to);
    return true;
}
