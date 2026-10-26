import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// GNOME's thumbnailer records a file it couldn't thumbnail (an online-only file it was refused) as failed, by the md5
// of the file's URI and its modified time. A download keeps the cloud's modified time, so that record has to go once
// the file is downloaded, or its thumbnail never shows.

// The bytes g_filename_to_uri leaves as they are in a path (GLib's UNSAFE_PATH set); every other byte of the UTF-8 path
// is percent-encoded in upper case, ';' included
const URI_PATH_SAFE = /[A-Za-z0-9\-._~!$&'()*+,=:@/]/;

function fileUri(fullPath: string): string {
    let escaped = '';
    for (const byte of Buffer.from(fullPath, 'utf8')) {
        const char = String.fromCharCode(byte);
        escaped += byte < 0x80 && URI_PATH_SAFE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return `file://${escaped}`;
}

// The cache folder the thumbnailer writes to: $XDG_CACHE_HOME (when it is an absolute path), else ~/.cache; under
// `home` when one is given
function cacheDir(home?: string): string {
    if (home !== undefined) {
        return path.join(home, '.cache');
    }
    const xdg = process.env.XDG_CACHE_HOME;
    return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache');
}

// Where GNOME keeps the failed-thumbnail record of a file, by its path as the user sees it (under the mount)
export function failedThumbnailPath(mountFullPath: string, home?: string): string {
    const md5 = createHash('md5').update(fileUri(mountFullPath)).digest('hex');
    return path.join(cacheDir(home), 'thumbnails', 'fail', 'gnome-thumbnail-factory', `${md5}.png`);
}

// Deletes that record, if there is one
export async function forgetFailedThumbnail(mountFullPath: string, home?: string): Promise<void> {
    try {
        await unlink(failedThumbnailPath(mountFullPath, home));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}
