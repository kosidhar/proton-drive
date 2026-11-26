import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

// The user's Downloads folder: what xdg-user-dir says, else ~/Downloads. xdg-user-dir prints $HOME itself when the
// folder isn't set, and isn't there at all on some systems: both fall back.

const XDG_TIMEOUT_MS = 3000;

function xdgDownloadDir(): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            execFile('xdg-user-dir', ['DOWNLOAD'], { timeout: XDG_TIMEOUT_MS }, (error, stdout) => {
                resolve(error ? null : String(stdout).trim() || null);
            });
        } catch {
            resolve(null);
        }
    });
}

export async function resolveDownloadsDir(home: string = homedir(), ask: () => Promise<string | null> = xdgDownloadDir): Promise<string> {
    const fallback = path.join(home, 'Downloads');
    const asked = await ask().catch(() => null);
    if (!asked || !path.isAbsolute(asked) || path.resolve(asked) === path.resolve(home)) return fallback;
    return path.resolve(asked);
}
