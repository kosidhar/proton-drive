import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

// Where a folder really is, and what is mounted at it: the drive's mount point is named as the kernel names it, and
// the drive must never sit over, or under, the app's own files.

// The canonical path, worked out from the parent and readlink, never by looking inside: a dead or stuck mount at the
// path must still be named as mountinfo and fusermount3 name it
export function canonicalPath(p: string): string {
    let current = path.resolve(p);
    for (let hops = 0; hops < 40; hops++) {
        let joined: string;
        try {
            joined = path.join(realpathSync(path.dirname(current)), path.basename(current));
        } catch {
            return current;
        }
        try {
            current = path.resolve(path.dirname(joined), readlinkSync(joined));
        } catch {
            return joined; // not a symlink
        }
    }
    return current;
}

// Whether one path is the other or holds it, once both are canonical
export function pathsOverlap(a: string, b: string): boolean {
    const [ca, cb] = [canonicalPath(a), canonicalPath(b)];
    const inside = (child: string, parent: string) => {
        const rel = path.relative(parent, child);
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    return inside(ca, cb) || inside(cb, ca);
}

// The file system types mounted exactly at a path, bottom first. mountinfo escapes space, tab, newline and backslash
// in octal (\040); the text is read as latin1 so each char is one byte and the comparison is byte for byte.
export function mountsAt(mountinfo: string, mountpoint: string): string[] {
    const wanted = Buffer.from(mountpoint, 'utf8').toString('latin1');
    const found: string[] = [];
    for (const line of mountinfo.split('\n')) {
        const fields = line.split(' ');
        const separator = fields.indexOf('-', 6);
        if (separator < 0 || fields[4] === undefined) continue;
        const at = fields[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
        if (at === wanted) found.push(fields[separator + 1] ?? '');
    }
    return found;
}

// The text of /proc/self/mountinfo, read as latin1 (see mountsAt); empty when it can't be read
export function readMountInfo(): string {
    try {
        return readFileSync('/proc/self/mountinfo', 'latin1');
    } catch {
        return '';
    }
}
