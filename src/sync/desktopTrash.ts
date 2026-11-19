import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Moves a file or folder to the desktop Trash, where the file manager shows it and can restore it. True when moved.
// shownPath, when given, is where the user knows the item (its path under the virtual drive), to record as its origin.
export type MoveToDesktopTrash = (fullPath: string, shownPath?: string) => Promise<boolean>;

// Runs `argv` with the path appended as one more argument. Moved only when it exits 0: a failure, a command that
// can't be started, or one still running after `timeoutMs` (it is then killed) all count as not moved.
export function trashCommand(argv: string[], timeoutMs = 60_000): MoveToDesktopTrash {
    return async (fullPath) => {
        try {
            const proc = Bun.spawn([...argv, fullPath], {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                timeout: timeoutMs,
            });
            return (await proc.exited) === 0;
        } catch {
            return false;
        }
    };
}

// GIO's trash, as the Files app uses: the home Trash, or `.Trash-$uid` at the top of another drive. `--` keeps a path
// starting with '-' from being read as an option. Never `--force`, which also counts a missing path as trashed.
export const gioTrash: MoveToDesktopTrash = trashCommand(['gio', 'trash', '--']);

// The home Trash ($XDG_DATA_HOME/Trash), as the freedesktop.org Trash spec lays it out
export function homeTrashDir(env: NodeJS.ProcessEnv = process.env): string {
    const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'Trash');
}

// The Path= value of a .trashinfo: the absolute path, escaped as a URI path (every byte but the unreserved ones and '/')
export function trashInfoPath(absolutePath: string): string {
    return encodeURIComponent(absolutePath).replace(/%2F/g, '/');
}

// DeletionDate=: local time, YYYY-MM-DDThh:mm:ss
function deletionDate(at: Date): string {
    const two = (n: number) => String(n).padStart(2, '0');
    return (
        `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
        `T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
    );
}

const NAME_MAX = 255;
const TRASHINFO_SUFFIX = '.trashinfo';

// Entry name in Trash/files/ (with .2, .3, ... for clashes), shortened by whole code points so
// `<name>.trashinfo` in Trash/info/ fits within Linux's 255-byte NAME_MAX (#353).
function trashEntryName(base: string, n: number): string {
    const suffix = n === 1 ? '' : `.${n}`;
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
    const maxBaseBytes = NAME_MAX - bytes(TRASHINFO_SUFFIX) - bytes(suffix);
    if (bytes(base) <= maxBaseBytes) {
        return `${base}${suffix}`;
    }
    const dotIndex = base.lastIndexOf('.');
    const hasExt = dotIndex > 0 && dotIndex < base.length - 1;
    let stem = hasExt ? base.slice(0, dotIndex) : base;
    let ext = hasExt ? base.slice(dotIndex) : '';
    if (bytes(ext) >= maxBaseBytes) {
        [stem, ext] = [base, ''];
    }
    const chars = Array.from(stem);
    while (chars.length > 0 && bytes(chars.join('')) + bytes(ext) > maxBaseBytes) {
        chars.pop();
    }
    return `${chars.join('')}${ext}${suffix}`;
}

// Moves into the home Trash recording `shownPath` as where the item came from, instead of where it is: in the virtual
// layout an item lives in the hidden store, but the user knows it under the drive (#40). The name in the Trash is
// reserved first by creating its .trashinfo exclusively (taken names get .2, .3, ... as GIO does), then the item is
// renamed in. Across disks a rename can't move it: then `fallback` (GIO's trash) does, recording the store's path.
export function homeTrash(trashDir: string = homeTrashDir(), fallback: MoveToDesktopTrash = gioTrash, now = () => new Date()): MoveToDesktopTrash {
    return async (fullPath, shownPath) => {
        if (!shownPath) {
            return fallback(fullPath);
        }
        const filesDir = path.join(trashDir, 'files');
        const infoDir = path.join(trashDir, 'info');
        await mkdir(filesDir, { recursive: true, mode: 0o700 });
        await mkdir(infoDir, { recursive: true, mode: 0o700 });
        const base = path.basename(fullPath);
        const info = `[Trash Info]\nPath=${trashInfoPath(shownPath)}\nDeletionDate=${deletionDate(now())}\n`;
        for (let n = 1; n < 10_000; n++) {
            const name = trashEntryName(base, n);
            const infoFile = path.join(infoDir, `${name}${TRASHINFO_SUFFIX}`);
            try {
                await writeFile(infoFile, info, { flag: 'wx', mode: 0o600 });
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
                throw err;
            }
            if (await exists(path.join(filesDir, name))) {
                await rm(infoFile, { force: true }); // an item in files/ without its info: leave the name to it
                continue;
            }
            try {
                await rename(fullPath, path.join(filesDir, name));
                return true;
            } catch (err) {
                await rm(infoFile, { force: true });
                if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
                    return fallback(fullPath);
                }
                return false;
            }
        }
        return false;
    };
}

async function exists(p: string): Promise<boolean> {
    try {
        await lstat(p);
        return true;
    } catch {
        return false;
    }
}
