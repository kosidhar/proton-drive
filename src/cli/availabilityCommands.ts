import path from 'node:path';

import { defaultControlSocketPath } from '../daemon/controlServer';
import type { AvailabilityAction } from '../sync/syncEngine';

export const DAEMON_NOT_RUNNING_MESSAGE = `The Proton Drive daemon isn't running; start it with "protondrive daemon".`;

const MY_FILES_PREFIX = '/my-files';

const WHOLE_DRIVE_HINT = 'Name a file or folder inside your Proton Drive folder; to act on the whole drive, use /my-files.';

/**
 * Turn a user-typed path into a My files relPath (no leading slash, root is '').
 * Accepts '<syncDir>/a/b' and '/my-files/a/b' (absolute), or a relative path, which resolves against `cwd`
 * when cwd is inside syncDir and against the My files root otherwise. Throws for anything outside My files,
 * and for empty or dot targets that would mean the whole drive: the root has to be named explicitly.
 */
export function toMyFilesRelPath(input: string, syncDir: string, cwd: string = process.cwd()): string {
    const raw = input.trim();
    const syncRoot = path.resolve(syncDir);
    let rel: string;
    if (raw === MY_FILES_PREFIX || raw.startsWith(`${MY_FILES_PREFIX}/`)) {
        rel = raw.slice(MY_FILES_PREFIX.length);
        if (!isWithin(rel)) throw new Error(`${input} is outside your Proton Drive folder`);
    } else if (path.isAbsolute(raw)) {
        const fromRoot = path.relative(syncRoot, path.resolve(raw));
        if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
            throw new Error(`${input} is outside your Proton Drive folder (${syncRoot})`);
        }
        rel = fromRoot.split(path.sep).join('/');
    } else {
        const cwdFromRoot = path.relative(syncRoot, path.resolve(cwd));
        const cwdInside = cwdFromRoot !== '..' && !cwdFromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(cwdFromRoot);
        const base = cwdInside ? cwdFromRoot.split(path.sep).join('/') : '';
        rel = base ? `${base}/${raw}` : raw;
        if (!isWithin(rel)) throw new Error(`${input} is outside your Proton Drive folder`);
        if (path.posix.normalize(`/${rel}`).replace(/^\/+|\/+$/g, '') === '') {
            throw new Error(WHOLE_DRIVE_HINT);
        }
    }
    return path.posix.normalize(`/${rel}`).replace(/^\/+|\/+$/g, '');
}

/** True if '..' segments never climb above the start of the path. */
function isWithin(rel: string): boolean {
    let depth = 0;
    for (const segment of rel.split('/')) {
        if (segment === '' || segment === '.') continue;
        depth += segment === '..' ? -1 : 1;
        if (depth < 0) return false;
    }
    return true;
}

interface AvailabilityReply {
    state?: string;
    kept?: string[];
    refused?: string | null;
    error?: string;
}

/** Runs one availability command against the daemon's control socket and returns the exit code. */
export async function runAvailabilityCommand(
    action: AvailabilityAction | 'status',
    input: string,
    syncDir: string,
    socketPath: string = defaultControlSocketPath(),
): Promise<number> {
    let relPath: string;
    try {
        relPath = toMyFilesRelPath(input, syncDir);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
    }

    const verbs = { pin: 'Pinning', free: 'Freeing', hide: 'Hiding', unhide: 'Unhiding', status: 'Checking' };
    console.log(`${verbs[action]} ${relPath || '/my-files'}…`);

    let res: Response;
    try {
        const init: RequestInit & { unix: string } = { unix: socketPath };
        if (action === 'status') {
            res = await fetch(`http://localhost/availability?path=${encodeURIComponent(relPath)}`, init);
        } else {
            res = await fetch('http://localhost/availability', {
                ...init,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: relPath, action }),
            });
        }
    } catch {
        console.error(DAEMON_NOT_RUNNING_MESSAGE);
        return 2;
    }

    let body: AvailabilityReply;
    try {
        body = (await res.json()) as AvailabilityReply;
    } catch {
        console.error(`Unexpected reply from the daemon (HTTP ${res.status})`);
        return 1;
    }
    if (!res.ok) {
        console.error(body.error ?? `The daemon refused the request (HTTP ${res.status})`);
        return 1;
    }

    console.log(`${relPath || '/my-files'}: ${body.state}`);
    for (const kept of body.kept ?? []) {
        console.log(`Kept on this device: ${kept}`);
    }
    if (body.refused) {
        console.error(body.refused);
        return 1;
    }
    return 0;
}
