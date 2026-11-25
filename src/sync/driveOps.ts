// What the virtual drive asks of the daemon over the control socket, and how a drive operation fails.

// An item of a folder's listing in the drive, from the remote index: a file or folder Proton Drive has, whether or not
// it is on this computer too
export interface VfsEntry {
    name: string;
    type: 'file' | 'folder';
    size: number;
    mtimeMs: number;
    // A Proton Doc or Sheet, shown as a read-only file that holds this content (the drive opens it in the browser)
    placeholder?: { kind: 'doc' | 'sheet'; content: string };
}

// The errno a drive operation fails with, for the FUSE helper to return: ENOENT for a path that isn't there, EACCES for
// a hidden one, EEXIST for a target in the way, EXDEV for a rename that has to be done as copy and delete (an online-only
// file replacing another), ENOTEMPTY for a folder that a delete only if empty (rmdir) finds something in, EINVAL for
// something that can't be done to that item (putting back Proton Drive's version of a file it has none of), ENOSPC for a
// download for an open that would leave this computer's disk with less than the drive's reserve (#301), EIO for anything
// else (a failed download, say), EPERM for a change to a Proton Doc or Sheet's placeholder (they open in the browser), EISDIR for an unlink of a
// folder (neither rmdir nor Move to Trash), which is refused before anything is trashed or removed (#432)
export type DriveOpErrorCode = 'ENOENT' | 'EEXIST' | 'EACCES' | 'EIO' | 'EXDEV' | 'ENOTEMPTY' | 'EINVAL' | 'ENOSPC' | 'EPERM' | 'EISDIR';

export class DriveOpError extends Error {
    constructor(
        readonly code: DriveOpErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = 'DriveOpError';
    }
}
