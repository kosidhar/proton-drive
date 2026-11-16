import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DriveOpError } from '../sync/driveOps';
import {
    type AvailabilityAction,
    ConflictRefusedError,
    FILES_MISSING_ACTIONS,
    type FilesMissingAction,
    FilesMissingRefused,
    type ProtonDriveSyncEngine,
} from '../sync/syncEngine';
import type { ConflictRecord } from '../sync/syncStateDb';
import { type FileManagerSource, FM_ROUTES, fileManagerRoute } from './fileManagerRoutes';
import { parseSettingsRequest, type SettingsChange } from './settingsValidation';
import { shareRoute } from './shareRoutes';
import type { ShareService } from './shareService';
import type { DriveMoveAction } from './vfsSupervisor';

// Pin, free, hide and unhide change what is on disk, and so do the virtual drive's hydrate, rename and delete, so they
// are reachable only through this user-only Unix socket and never through the unauthenticated TCP API.

const ACTIONS: readonly string[] = ['pin', 'free', 'hide', 'unhide'] satisfies AvailabilityAction[];
type ConflictChoice = Parameters<NonNullable<ControlServerOptions['resolveConflict']>>[1];
const CONFLICT_CHOICES: readonly string[] = ['keep-both', 'keep-local', 'keep-remote'] satisfies ConflictChoice[];
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
        | 'setAvailability'
        | 'availabilityOf'
        | 'hiddenItems'
        | 'pinnedSummary'
        | 'vfsChildren'
        | 'hydrate'
        | 'renameItem'
        | 'deleteItem'
        | 'truncateItem'
    >;
    // What the file manager extension reads: where the drive is, the states of a folder's items, and what changes (see
    // fileManagerRoutes.ts)
    fileManager?: FileManagerSource;
    // Mount again (the tray and the app): absent while Proton Drive is a plain folder
    mountAgain?: () => Promise<void>;
    // The account's storage in bytes, or null while it isn't known: what the drive reports as its size (#181)
    space?: () => Promise<{ usedSpace: number; maxSpace: number } | null>;
    // Finish, move back or retry a move that stopped (see DriveController.resolveMove); its errors may carry an HTTP
    // status and the move waiting now
    driveMove?: (action: DriveMoveAction, from?: string, to?: string) => Promise<void>;
    // Save settings, which may move the drive folder or switch the virtual drive (see driveSettings in settingsRoute.ts);
    // the request is checked already, and the answer is the response
    driveSettings?: (change: SettingsChange) => Promise<Response>;
    // Sharing an item (see ShareService, shareRoutes.ts), while signed in: absent, the /share routes are not found
    share?: ShareService;
    shareSignedIn?: () => boolean;
    // Where a share route's unexpected failure is logged (only the error's class)
    shareLog?: (line: string) => void;
    // Make a folder in the cloud, in the folder My files or elsewhere by its path; answers the folder made
    remoteMkdir?: (parentPath: string, name: string) => Promise<{ uid: string; name: string }>;
    // Sign in (starts the browser sign-in and answers its URL, with what the app must show) and sign out
    login?: () => Promise<{ signInUrl: string } & Record<string, unknown>>;
    logout?: () => Promise<void>;
    // Resolve a conflict by hand (see ProtonDriveSyncEngine.resolveConflictManually); throws ConflictRefusedError for an
    // unknown or already resolved one
    resolveConflict?: (id: number, choice: 'keep-both' | 'keep-local' | 'keep-remote') => Promise<ConflictRecord>;
    // What the user chose about the files missing from the folder, as they were shown (the status's filesMissing root
    // and names): they were deleted on purpose (see ProtonDriveSyncEngine.confirmFilesMissingDeleted), or they stay in
    // Proton Drive, online-only (keepFilesMissingOnlineOnly); throws FilesMissingRefused when nothing is missing, or
    // something else than what was shown
    resolveFilesMissing?: (
        action: FilesMissingAction,
        expected: { root: string; names: string[] },
    ) => Promise<{ root: string; names: string[]; items: number }>;
    // Signed in to another account than the records are of: start fresh with this one (see
    // ProtonDriveSyncEngine.startFreshForThisAccount, #35); throws when there is nothing to start fresh from
    startFresh?: () => Promise<void>;
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

// GET /vfs/children?path=, POST /vfs/hydrate {path, opener?} (opener: the name of the app that opened it), POST /vfs/rename {from, to, noReplace?}, POST /vfs/delete {path,
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
                // Waits for the whole download: the helper gives up after its own limit (30 minutes). An opener that
                // isn't a short name is no name: never blocked, never counted
                await engine.hydrate(body.path, {
                    opener: typeof body.opener === 'string' && body.opener.length > 0 && body.opener.length <= 64 ? body.opener : undefined,
                });
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

// GET /vfs/space: the account's storage for the drive helper's statfs (#181), { space: { usedSpace, maxSpace } }, or
// { space: null } while it isn't known; the helper then reports the local disk
async function spaceRoute(req: Request, space: ControlServerOptions['space']): Promise<Response> {
    if (req.method !== 'GET') return driveError(new Error('Method not allowed'), 405);
    try {
        const known = space ? await space() : null;
        return Response.json({ space: known ? { usedSpace: known.usedSpace, maxSpace: known.maxSpace } : null });
    } catch {
        return Response.json({ space: null });
    }
}

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

// POST /drive/settings {ignorePatterns?, conflictStrategy?, notificationsEnabled?, syncDir?, virtualDriveWanted?}: the
// only way to save settings. syncDir and virtualDriveWanted move every file, so they are reachable only here, never
// through the TCP API. Every field is checked before any is stored (see parseSettingsRequest; an unknown key is
// refused). Answers 200 { ok: true, settings, virtualDriveWanted, vfs, folderError, switchError } (an error is null or
// why that change was refused or failed); 400 { error, code: 'EINVAL' } for an invalid request, with nothing stored.
async function driveSettingsRoute(req: Request, driveSettings: ControlServerOptions['driveSettings']): Promise<Response> {
    const invalid = (message: string) => Response.json({ error: message, code: 'EINVAL' }, { status: 400 });
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!driveSettings) return jsonError('Not found', 404);
    const body = await jsonBody(req);
    if (!body) return invalid('Invalid JSON body');
    const parsed = parseSettingsRequest(body);
    if (!parsed.ok) return invalid(parsed.error);
    return driveSettings(parsed.value);
}

// POST /remote/mkdir {parentPath?, name}: makes a folder in the cloud, in parentPath (default /my-files). 200 { ok: true,
// folder: { uid, name } }; 400 { error, code: 'EINVAL' } for a missing or bad name (empty, '.', '..', holding a '/')
// or parentPath; 500 { error, code: 'EIO' } when it failed. Never reachable from the TCP API.
async function remoteMkdirRoute(req: Request, remoteMkdir: ControlServerOptions['remoteMkdir']): Promise<Response> {
    const invalid = (message: string) => Response.json({ error: message, code: 'EINVAL' }, { status: 400 });
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!remoteMkdir) return jsonError('Not found', 404);
    const body = await jsonBody(req);
    if (!body) return invalid('Invalid JSON body');
    const { parentPath, name } = body;
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        return invalid('name must be the name of a folder');
    }
    if (parentPath !== undefined && typeof parentPath !== 'string') return invalid('parentPath must be a path');
    try {
        return Response.json({ ok: true, folder: await remoteMkdir(parentPath || '/my-files', name) });
    } catch (err) {
        return Response.json({ error: messageOf(err), code: 'EIO' }, { status: 500 });
    }
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

// POST /conflicts/resolve {id, choice: 'keep-both' | 'keep-local' | 'keep-remote'}: overwrites the local or the cloud
// copy as chosen. 200 { ok: true, conflict }; 400 { error, code: 'EINVAL' } for a malformed request; 404 { error, code:
// 'ENOENT' } for an unknown conflict; 409 { error, code: 'EEXIST' } for one already resolved, which is never acted on
// again; 500 { error, code: 'EIO' } when resolving failed. Never reachable from the TCP API.
async function resolveConflictRoute(req: Request, resolveConflict: ControlServerOptions['resolveConflict']): Promise<Response> {
    const invalid = (message: string) => Response.json({ error: message, code: 'EINVAL' }, { status: 400 });
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!resolveConflict) return jsonError('Not found', 404);
    const body = await jsonBody(req);
    if (!body) return invalid('Invalid JSON body');
    const { id, choice } = body;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return invalid('id must be the number of a conflict');
    if (typeof choice !== 'string' || !CONFLICT_CHOICES.includes(choice)) return invalid(`choice must be one of ${CONFLICT_CHOICES.join(', ')}`);
    try {
        return Response.json({ ok: true, conflict: await resolveConflict(id, choice as ConflictChoice) });
    } catch (err) {
        if (err instanceof ConflictRefusedError) {
            return Response.json({ error: err.message, code: err.status === 404 ? 'ENOENT' : 'EEXIST' }, { status: err.status });
        }
        return Response.json({ error: messageOf(err), code: 'EIO' }, { status: 500 });
    }
}

// POST /sync/files-missing {action, root, names}: what to do about the files missing from the folder (the engine holds
// while they are). 'delete-in-cloud': they were deleted on purpose, so the next sync pass moves them to the Proton Drive
// trash. 'keep-online-only': they stay in Proton Drive, online-only, and nothing is deleted. root and names are what
// the user was shown (filesMissing in /api/status), which must still be exactly what is missing, as /drive/move names
// its move by from and to. 200 { ok: true, root, names, items } with what was done; 400 { error, code: 'EINVAL' } for a
// malformed request; 409 { error, code: 'EEXIST' } when nothing is missing, or something else than what was shown; 500
// { error, code: 'EIO' } otherwise. Never reachable from the TCP API.
async function filesMissingRoute(req: Request, resolve: ControlServerOptions['resolveFilesMissing']): Promise<Response> {
    const invalid = (message: string) => Response.json({ error: message, code: 'EINVAL' }, { status: 400 });
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!resolve) return jsonError('Not found', 404);
    const body = await jsonBody(req);
    if (!body || typeof body.action !== 'string' || !FILES_MISSING_ACTIONS.includes(body.action)) {
        return invalid(`action must be one of ${FILES_MISSING_ACTIONS.join(', ')}`);
    }
    const { action, root, names } = body;
    if (typeof root !== 'string' || !root) return invalid('root must be the folder the files are missing from');
    if (!Array.isArray(names) || names.length === 0 || !names.every((name) => typeof name === 'string' && name !== '')) {
        return invalid('names must be the items missing');
    }
    try {
        return Response.json({ ok: true, ...(await resolve(action as FilesMissingAction, { root, names: names as string[] })) });
    } catch (err) {
        if (err instanceof FilesMissingRefused) {
            return Response.json({ error: err.message, code: 'EEXIST' }, { status: 409 });
        }
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
            if (FM_ROUTES.includes(url.pathname)) {
                return fileManagerRoute(req, url, opts.fileManager);
            }
            if (url.pathname === '/vfs/mount') {
                return mountRoute(req, opts.mountAgain);
            }
            if (url.pathname === '/vfs/space') {
                return spaceRoute(req, opts.space);
            }
            if (url.pathname.startsWith('/share/')) {
                return shareRoute(req, url, opts.share, opts.shareSignedIn ?? (() => false), opts.shareLog);
            }
            if (url.pathname === '/drive/move') {
                return driveMoveRoute(req, opts.driveMove);
            }
            if (url.pathname === '/auth/login' || url.pathname === '/auth/logout') {
                return authRoute(req, url.pathname, opts);
            }
            if (url.pathname === '/conflicts/resolve') {
                return resolveConflictRoute(req, opts.resolveConflict);
            }
            if (url.pathname === '/account/start-fresh') {
                if (req.method !== 'POST') return jsonError('Method not allowed', 405);
                if (!opts.startFresh) return jsonError('Not found', 404);
                try {
                    await opts.startFresh();
                    return Response.json({ ok: true });
                } catch (err) {
                    return Response.json({ error: messageOf(err), code: 'EEXIST' }, { status: 409 });
                }
            }
            if (url.pathname === '/sync/files-missing') {
                return filesMissingRoute(req, opts.resolveFilesMissing);
            }
            if (url.pathname === '/remote/mkdir') {
                return remoteMkdirRoute(req, opts.remoteMkdir);
            }
            if (url.pathname === '/drive/settings') {
                return driveSettingsRoute(req, opts.driveSettings);
            }
            // What is hidden from this computer, for the app's list with Unhide (which is POST /availability). Reads only.
            if (url.pathname === '/availability/hidden') {
                if (req.method !== 'GET') return jsonError('Method not allowed', 405);
                return Response.json({ items: engine.hiddenItems() });
            }
            // How many items are marked Always keep below the top level, and whether the whole drive is: whether the
            // app's Free up space offers to keep them (#296). Reads only.
            if (url.pathname === '/availability/pinned') {
                if (req.method !== 'GET') return jsonError('Method not allowed', 405);
                return Response.json(engine.pinnedSummary());
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
                let body: { path?: unknown; action?: unknown; keepPinned?: unknown };
                try {
                    body = (await req.json()) as typeof body;
                } catch {
                    return jsonError('Invalid JSON body');
                }
                if (typeof body?.path !== 'string') return jsonError('Missing path');
                if (typeof body.action !== 'string' || !ACTIONS.includes(body.action)) {
                    return jsonError(`Unknown action: ${String(body.action)}`);
                }
                // A free may keep what is marked Always keep below it (#296); without it, the free is as before
                const { keepPinned } = body;
                if (keepPinned !== undefined) {
                    if (typeof keepPinned !== 'boolean') return jsonError('keepPinned must be true or false');
                    if (body.action !== 'free') return jsonError(`keepPinned goes only with free, not ${body.action}`);
                }
                try {
                    const action = body.action as AvailabilityAction;
                    return Response.json(
                        await (keepPinned === undefined
                            ? engine.setAvailability(body.path, action)
                            : engine.setAvailability(body.path, action, { keepPinned })),
                    );
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
