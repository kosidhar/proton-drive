import { existsSync } from 'node:fs';
import net from 'node:net';

import { LAYOUT_MOVING, SYNC_DIR_MOVING } from '../sync/layoutMigration';
import { SyncStateDatabase } from '../sync/syncStateDb';

// What the CLI says instead of running an engine of its own on files that are moving between the sync folder and the
// backing store: only the daemon finishes that move (with its engine held)
export const MOVING_FILES_MESSAGE =
    'Proton Drive is in the middle of moving your files. Start the Proton Drive app/daemon to finish moving files, then try again.';

// Whether something accepts a connection on the control socket within timeoutMs
export function controlSocketAccepts(socketPath: string, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(socketPath);
        const done = (accepted: boolean) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(accepted);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

// The daemon runs when its control socket accepts a connection; failing that, when its TCP API answers (a daemon with
// no socket, which runs all the same)
export async function daemonRunning(opts: { socketPath: string; statusUrl: string; timeoutMs?: number }): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 1000;
    if (await controlSocketAccepts(opts.socketPath, timeoutMs)) {
        return true;
    }
    try {
        const res = await fetch(opts.statusUrl, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch {
        return false;
    }
}

// The move marker set in the state database (meta layoutMoving or syncDirMoving), or null when there is none or no
// database yet
export function pendingMoveMarker(dbPath: string): string | null {
    if (!existsSync(dbPath)) {
        return null;
    }
    const stateDb = new SyncStateDatabase(dbPath);
    try {
        return [LAYOUT_MOVING, SYNC_DIR_MOVING].find((key) => stateDb.getMeta(key) !== null) ?? null;
    } finally {
        stateDb.close();
    }
}
