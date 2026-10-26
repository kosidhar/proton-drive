import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DriveOpError } from '../sync/driveOps';
import type { AvailabilityAction, ProtonDriveSyncEngine } from '../sync/syncEngine';

// Pin, free, hide and unhide change what is on disk, and so do the virtual drive's hydrate, rename and delete, so they
// are reachable only through this user-only Unix socket and never through the unauthenticated TCP API.

const ACTIONS: readonly string[] = ['pin', 'free', 'hide', 'unhide'] satisfies AvailabilityAction[];

export function defaultControlSocketPath(): string {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir) {
        return path.join(runtimeDir, 'protondrive', 'control.sock');
    }
    const uid = process.getuid?.() ?? 'user';
    return path.join(os.tmpdir(), `protondrive-${uid}`, 'control.sock');
}

export interface ControlServerOptions {
    socketPath: string;
    engine: Pick<
        ProtonDriveSyncEngine,
        'setAvailability' | 'availabilityOf' | 'vfsChildren' | 'hydrate' | 'renameItem' | 'deleteItem' | 'truncateItem'
    >;
}

// 'live' when something accepts connections on the socket, 'stale' when it refuses or is gone
function probeSocket(socketPath: string): Promise<'live' | 'stale'> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolve('live');
        });
        socket.once('error', (err: NodeJS.ErrnoException) => {
            socket.destroy();
            if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK') {
                resolve('stale');
            } else {
                reject(err);
            }
        });
    });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
    let stat;
    try {
        stat = lstatSync(socketPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
    }
    if (stat.isDirectory()) {
        throw new Error(`Control socket path is a directory: ${socketPath}`);
    }
    // Never unlink a socket that another daemon is serving; a plain file or a refused socket is safe to replace
    if (stat.isSocket() && (await probeSocket(socketPath)) === 'live') {
        throw new Error(`Another daemon is already running on ${socketPath}`);
    }
    unlinkSync(socketPath);
}

function jsonError(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// The drive's routes answer an error with the errno for the helper to return: the engine's own code, EIO otherwise
function driveError(err: unknown, status = 400): Response {
    return Response.json({ error: messageOf(err), code: err instanceof DriveOpError ? err.code : 'EIO' }, { status });
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
    try {
        const body: unknown = await req.json();
        return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

type DriveEngine = ControlServerOptions['engine'];

// GET /vfs/children?path=, POST /vfs/hydrate {path}, POST /vfs/rename {from, to, noReplace?}, POST /vfs/delete {path,
// onlyIfEmpty?, trash?} (onlyIfEmpty is rmdir, trash a Move to Trash), POST /vfs/truncate {path} (an online-only file
// made an empty local one). Paths are paths of My files, UTF-8 as they are ('' is the top); each answers { entries } or
// { ok: true }, or 400 { error, code }.
async function driveRoute(req: Request, route: string, engine: DriveEngine): Promise<Response> {
    if (route === '/vfs/children') {
        if (req.method !== 'GET') return driveError(new Error('Method not allowed'), 405);
        const relPath = new URL(req.url).searchParams.get('path');
        if (relPath === null) return driveError(new Error('Missing path'));
        try {
            return Response.json({ entries: engine.vfsChildren(relPath) });
        } catch (err) {
            return driveError(err);
        }
    }
    if (req.method !== 'POST') return driveError(new Error('Method not allowed'), 405);
    const body = await jsonBody(req);
    if (!body) return driveError(new Error('Invalid JSON body'));
    try {
        switch (route) {
            case '/vfs/hydrate':
                if (typeof body.path !== 'string') return driveError(new Error('Missing path'));
                // Waits for the whole download: the helper gives up after its own limit (30 minutes)
                await engine.hydrate(body.path);
                break;
            case '/vfs/rename':
                if (typeof body.from !== 'string' || typeof body.to !== 'string') {
                    return driveError(new Error('Missing from or to'));
                }
                if (body.noReplace !== undefined && typeof body.noReplace !== 'boolean') {
                    return driveError(new Error('noReplace must be true or false'));
                }
                await engine.renameItem(body.from, body.to, { noReplace: body.noReplace === true });
                break;
            case '/vfs/delete':
                if (typeof body.path !== 'string') return driveError(new Error('Missing path'));
                if (body.onlyIfEmpty !== undefined && typeof body.onlyIfEmpty !== 'boolean') {
                    return driveError(new Error('onlyIfEmpty must be true or false'));
                }
                if (body.trash !== undefined && typeof body.trash !== 'boolean') {
                    return driveError(new Error('trash must be true or false'));
                }
                await engine.deleteItem(body.path, { onlyIfEmpty: body.onlyIfEmpty === true, trash: body.trash === true });
                break;
            case '/vfs/truncate':
                if (typeof body.path !== 'string') return driveError(new Error('Missing path'));
                await engine.truncateItem(body.path);
                break;
        }
        return Response.json({ ok: true });
    } catch (err) {
        return driveError(err);
    }
}

const DRIVE_ROUTES: readonly string[] = ['/vfs/children', '/vfs/hydrate', '/vfs/rename', '/vfs/delete', '/vfs/truncate'];

export async function startControlServer(opts: ControlServerOptions): Promise<{ stop(): void }> {
    const { socketPath, engine } = opts;
    const dir = path.dirname(socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    await removeStaleSocket(socketPath);

    // Bun closes a connection idle for 10 s by default, and a hydrate waits on its download for as long as it takes
    // (server.timeout(req, 0) doesn't lift that on a Unix socket); the clients give up by themselves. Bun's types offer
    // idleTimeout only with a port, but it applies to a Unix socket too.
    const noIdleTimeout: object = { idleTimeout: 0 };
    const server = Bun.serve({
        unix: socketPath,
        ...noIdleTimeout,
        async fetch(req) {
            const url = new URL(req.url);
            if (DRIVE_ROUTES.includes(url.pathname)) {
                return driveRoute(req, url.pathname, engine);
            }
            if (url.pathname !== '/availability') {
                return jsonError('Not found', 404);
            }
            if (req.method === 'GET') {
                const relPath = url.searchParams.get('path');
                if (relPath === null) return jsonError('Missing path');
                try {
                    return Response.json({ path: relPath, state: await engine.availabilityOf(relPath) });
                } catch (err) {
                    return jsonError(err instanceof Error ? err.message : String(err)); // Not in Proton Drive: <path>
                }
            }
            if (req.method === 'POST') {
                let body: { path?: unknown; action?: unknown };
                try {
                    body = (await req.json()) as typeof body;
                } catch {
                    return jsonError('Invalid JSON body');
                }
                if (typeof body?.path !== 'string') return jsonError('Missing path');
                if (typeof body.action !== 'string' || !ACTIONS.includes(body.action)) {
                    return jsonError(`Unknown action: ${String(body.action)}`);
                }
                try {
                    return Response.json(await engine.setAvailability(body.path, body.action as AvailabilityAction));
                } catch (err) {
                    return jsonError(err instanceof Error ? err.message : String(err));
                }
            }
            return jsonError('Method not allowed', 405);
        },
    });
    chmodSync(socketPath, 0o600);

    return {
        stop() {
            void server.stop(true);
            try {
                unlinkSync(socketPath);
            } catch {
                // already removed
            }
        },
    };
}
