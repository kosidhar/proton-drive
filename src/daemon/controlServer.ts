import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DriveOpError } from '../sync/driveOps';
import type { AvailabilityAction, ProtonDriveSyncEngine } from '../sync/syncEngine';
import type { DriveMoveAction } from './vfsSupervisor';

// Pin, free, hide and unhide change what is on disk, and so do the virtual drive's hydrate, rename and delete, so they
// are reachable only through this user-only Unix socket and never through the unauthenticated TCP API.

const ACTIONS: readonly string[] = ['pin', 'free', 'hide', 'unhide'] satisfies AvailabilityAction[];
const MOVE_ACTIONS: readonly string[] = ['finish', 'move-back', 'retry'] satisfies DriveMoveAction[];

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
    // Mount again (the tray and the app): absent while Proton Drive is a plain folder
    mountAgain?: () => Promise<void>;
    // Finish, move back or retry a move that stopped (see DriveController.resolveMove); its errors may carry an HTTP
    // status and the move waiting now
    driveMove?: (action: DriveMoveAction, from?: string, to?: string) => Promise<void>;
    // Change the drive folder and the virtual drive switch (see driveSettings in settingsRoute.ts); answers the response
    driveSettings?: (change: { syncDir?: string; virtualDriveWanted?: boolean }) => Promise<Response>;
    // Sign in (starts the browser sign-in and answers its URL, with what the app must show) and sign out
    login?: () => Promise<{ signInUrl: string } & Record<string, unknown>>;
    logout?: () => Promise<void>;
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
// made an empty local one); the last three also take deadlineMs. Paths are paths of My files, UTF-8 as they are ('' is
// the top); each answers { entries } or { ok: true }, or 400 { error, code }.
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
    // When the helper stops waiting (epoch ms): a change whose turn comes later is refused, not done behind its back
    if (route !== '/vfs/hydrate' && body.deadlineMs !== undefined && !Number.isFinite(body.deadlineMs)) {
        return driveError(new Error('deadlineMs must be a number'));
    }
    const deadlineMs = typeof body.deadlineMs === 'number' ? body.deadlineMs : undefined;
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
                await engine.renameItem(body.from, body.to, { noReplace: body.noReplace === true, deadlineMs });
                break;
            case '/vfs/delete':
                if (typeof body.path !== 'string') return driveError(new Error('Missing path'));
                if (body.onlyIfEmpty !== undefined && typeof body.onlyIfEmpty !== 'boolean') {
                    return driveError(new Error('onlyIfEmpty must be true or false'));
                }
                if (body.trash !== undefined && typeof body.trash !== 'boolean') {
                    return driveError(new Error('trash must be true or false'));
                }
                await engine.deleteItem(body.path, {
                    onlyIfEmpty: body.onlyIfEmpty === true,
                    trash: body.trash === true,
                    deadlineMs,
                });
                break;
            case '/vfs/truncate':
                if (typeof body.path !== 'string') return driveError(new Error('Missing path'));
                await engine.truncateItem(body.path, { deadlineMs });
                break;
        }
        return Response.json({ ok: true });
    } catch (err) {
        return driveError(err);
    }
}

const DRIVE_ROUTES: readonly string[] = ['/vfs/children', '/vfs/hydrate', '/vfs/rename', '/vfs/delete', '/vfs/truncate'];

// POST /vfs/mount: mounts the drive again after an eject, a crash streak or a busy mount point; { ok: true }, or 400
// { error, code } when the mount point can't be readied
async function mountRoute(req: Request, mountAgain: ControlServerOptions['mountAgain']): Promise<Response> {
    if (req.method !== 'POST') return driveError(new Error('Method not allowed'), 405);
    if (!mountAgain) return driveError(new Error('The virtual drive is off: Proton Drive is a plain folder'));
    try {
        await mountAgain();
        return Response.json({ ok: true });
    } catch (err) {
        return driveError(err);
    }
}

// POST /drive/move {action: 'finish' | 'move-back' | 'retry', from?, to?}: acts on a move that stopped, as /api/status
// vfs.move lists it (a relocation needs its from and to). { ok: true }; 400 for a malformed request; 409 { error, move }
// when the action can't be taken now (nothing waiting, another move, not possible), with the move waiting now (or null);
// 500 { error, move } when the move failed again. Moving files is never reachable from the TCP API.
async function driveMoveRoute(req: Request, driveMove: ControlServerOptions['driveMove']): Promise<Response> {
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!driveMove) return jsonError('Not found', 404);
    const body = await jsonBody(req);
    if (!body) return jsonError('Invalid JSON body');
    if (typeof body.action !== 'string' || !MOVE_ACTIONS.includes(body.action)) {
        return jsonError(`Unknown action: ${String(body.action)}`);
    }
    if ((body.from !== undefined && typeof body.from !== 'string') || (body.to !== undefined && typeof body.to !== 'string')) {
        return jsonError('from and to must be folder paths');
    }
    try {
        await driveMove(body.action as DriveMoveAction, body.from as string | undefined, body.to as string | undefined);
        return Response.json({ ok: true });
    } catch (err) {
        const refused = err as { status?: unknown; move?: unknown };
        const status = typeof refused.status === 'number' ? refused.status : 500;
        return Response.json({ error: messageOf(err), move: refused.move ?? null }, { status });
    }
}

// POST /drive/settings {syncDir?, virtualDriveWanted?}: moves the Proton Drive folder and switches the virtual drive on
// or off, which move every file: reachable only here, never through the TCP API. Answers 200 { ok: true, settings,
// virtualDriveWanted, vfs, folderError, switchError } (an error is null or why that change was refused or failed); 400
// { error, code } for a malformed request.
async function driveSettingsRoute(req: Request, driveSettings: ControlServerOptions['driveSettings']): Promise<Response> {
    const invalid = (message: string) => Response.json({ error: message, code: 'EINVAL' }, { status: 400 });
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!driveSettings) return jsonError('Not found', 404);
    const body = await jsonBody(req);
    if (!body) return invalid('Invalid JSON body');
    const unknown = Object.keys(body).filter((key) => key !== 'syncDir' && key !== 'virtualDriveWanted');
    if (unknown.length > 0) return invalid(`Unknown setting: ${unknown.join(', ')}`);
    if (body.syncDir !== undefined && (typeof body.syncDir !== 'string' || !body.syncDir.trim())) return invalid('syncDir must be the path of a folder');
    if (body.virtualDriveWanted !== undefined && typeof body.virtualDriveWanted !== 'boolean') {
        return invalid('virtualDriveWanted must be true or false');
    }
    return driveSettings({ syncDir: body.syncDir as string | undefined, virtualDriveWanted: body.virtualDriveWanted as boolean | undefined });
}

// POST /auth/login: starts the sign-in in the browser; 200 { ok: true, signInUrl, disclosure } (signInUrl is '' when the
// sign-in page was not ready in time). POST /auth/logout: signs out and clears the caches; 200 { ok: true }. Signing in
// or out is never reachable from the TCP API; 500 { error } when it fails.
async function authRoute(req: Request, route: string, opts: ControlServerOptions): Promise<Response> {
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    const action = route === '/auth/login' ? opts.login : opts.logout;
    if (!action) return jsonError('Not found', 404);
    try {
        const result = await action();
        return Response.json({ ok: true, ...(result ?? {}) });
    } catch (err) {
        return Response.json({ error: messageOf(err), code: 'EIO' }, { status: 500 });
    }
}

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
            if (url.pathname === '/vfs/mount') {
                return mountRoute(req, opts.mountAgain);
            }
            if (url.pathname === '/drive/move') {
                return driveMoveRoute(req, opts.driveMove);
            }
            if (url.pathname === '/auth/login' || url.pathname === '/auth/logout') {
                return authRoute(req, url.pathname, opts);
            }
            if (url.pathname === '/drive/settings') {
                return driveSettingsRoute(req, opts.driveSettings);
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
