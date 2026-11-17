import path from 'node:path';

import { syncLoginEntry } from '../linux/autostart';
import { ensureSystemTrayIndicator, getSystemdServiceStatus, sendDesktopNotification } from '../linux/notifications';
import {
    DEFAULT_APP_VERSION,
    DEFAULT_CLIENT_UID_PREFIX,
    DEFAULT_SDK_VERSION,
    getClaimedSize,
    getName,
    init as initSdkRuntime,
    listFolderChildren,
    openBrowserUrl,
    PathType,
    THIRD_PARTY_DISCLOSURE,
} from '../sdk';
import { migrateExcludedFolders } from '../sync/availabilityMigration';
import { backingDirFor, virtualDriveWanted } from '../sync/driveMode';
import { ProtonDriveSyncEngine } from '../sync/syncEngine';
import { SyncStateDatabase } from '../sync/syncStateDb';
import type { Logger } from '@protontech/drive-sdk';
import { defaultControlSocketPath, startControlServer } from './controlServer';
import { controlServerOptions } from './controlWiring';
import { DriveController } from './driveController';
import { pauseRoute } from './pauseRoute';
import { withAvailability } from './remoteListing';
import { isTrustedLocalRequest } from './requestGuard';
import { createShareService } from './shareService';
import { refuseOnTcp } from './tcpRefusals';
import { findHelper, fuseAvailable, mergeStrayInto, VfsSupervisor } from './vfsSupervisor';

// How long the shutdown waits for a look at a file just written that is uploading it (see waitForRunningLooks)
const SHUTDOWN_LOOK_WAIT_MS = 5000;

export const DEFAULT_DAEMON_PORT = Number(process.env.PROTON_DRIVE_DAEMON_PORT || 49152);
export const DEFAULT_DAEMON_HOST = '127.0.0.1';

export interface ProtonAccountInfo {
    name: string;
    displayName: string;
    email: string;
    initials: string;
    usedSpace: number;
    maxSpace: number;
    usedDriveSpace: number;
}

function computeInitials(displayName: string, email: string): string {
    const source = (displayName || email.split('@')[0] || 'PD').trim();
    const parts = source.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
    }
    return source.slice(0, 2).toUpperCase();
}

function prettifyName(rawName: string, email: string): string {
    const trimmed = rawName.trim();
    if (trimmed && trimmed.includes(' ')) {
        return trimmed;
    }
    const candidate = trimmed || email.split('@')[0] || 'Proton User';
    return candidate
        .split(/[\s._-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

// The engine logs as [sync], and every decision it records in the activity log goes to the log file too: started
// detached by the app, the daemon has no other record of why it did what it did (#180). Returns the engine's logger
export function wireSyncLogging(runtime: { getLogger(name: string): Logger }, stateDb: SyncStateDatabase): Logger {
    const syncLogger = runtime.getLogger('sync');
    stateDb.onActivity = (entry) => syncLogger.info(activityLogLine(entry));
    return syncLogger;
}

// An activity log entry as a line of the daemon's log file
export function activityLogLine(entry: { action: string; localRelPath: string; details: string }): string {
    return `${entry.action} ${entry.localRelPath}: ${entry.details}`;
}

export async function startSyncDaemon(options: {
    port?: number;
    host?: string;
    enableConsoleLog?: boolean;
} = {}) {
    const port = options.port ?? DEFAULT_DAEMON_PORT;
    const host = options.host ?? DEFAULT_DAEMON_HOST;

    const runtime = await initSdkRuntime({
        appVersion: DEFAULT_APP_VERSION,
        sdkVersion: DEFAULT_SDK_VERSION,
        clientUidPrefix: DEFAULT_CLIENT_UID_PREFIX,
        enablePersistedEvents: true,
        enableConsoleLog: options.enableConsoleLog ?? false,
        enableMetrics: false,
    });

    const stateDbPath = path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite');
    const stateDb = new SyncStateDatabase(stateDbPath);

    const syncLogger = wireSyncLogging(runtime, stateDb);
    const engine = new ProtonDriveSyncEngine(
        runtime.sdk,
        runtime.eventsManager,
        runtime.auth,
        stateDb,
        syncLogger,
        { backingDir: backingDirFor(runtime.config.appDir) },
    );

    // The drive: the files move between the sync folder and the backing store to match the mode, and the helper runs
    // while they are in the store. FUSE and the helper are looked for once, here, so /api/status stays cheap.
    const appDir = runtime.config.appDir;
    const backingDir = backingDirFor(appDir);
    const helperPath = findHelper();
    const drive = new DriveController({
        stateDb,
        engine,
        appDir,
        backingDir,
        logger: runtime.logger,
        fuseOk: fuseAvailable(helperPath),
        makeSupervisor: (mountpoint) =>
            new VfsSupervisor({
                mountpoint,
                backingDir,
                appDir,
                socketPath: defaultControlSocketPath(),
                helperPath: helperPath ?? 'protondrive-vfs', // spawned only when FUSE and the helper were found
                logPath: path.join(appDir, 'vfs.log'),
                logger: runtime.logger,
                nudge: true, // so Files shows the drive in its sidebar as soon as it mounts (#49)
                // A file saved into the bare folder while the drive was down: the engine uploads it as a new local file
                mergeStray: async (fullPath) => {
                    for (const renamed of mergeStrayInto(fullPath, mountpoint, backingDir)) {
                        runtime.logger.warn(`A stray in ${mountpoint} took a name already in the drive; kept it as ${renamed}`);
                    }
                },
                // A new helper has no file open for writing (#64)
                onHelperStart: () => engine.clearDriveWriting(),
            }),
    });

    let cachedAccount: ProtonAccountInfo | null = null;
    let lastAccountFetchMs = 0;
    let accountFetchPromise: Promise<ProtonAccountInfo | null> | null = null;

    const refreshAccountInfo = async (force = false): Promise<ProtonAccountInfo | null> => {
        if (!runtime.auth.isLoggedIn()) {
            cachedAccount = null;
            return null;
        }
        const now = Date.now();
        if (!force && cachedAccount && now - lastAccountFetchMs < 60_000) {
            return cachedAccount;
        }
        if (accountFetchPromise) {
            return accountFetchPromise;
        }
        accountFetchPromise = (async () => {
            try {
                const res = (await runtime.apiClient.authenticatedRequest
                    .get(`${runtime.apiClient.baseUrlWithProtocol}/core/v4/users`)
                    .json()) as {
                    User?: {
                        Name?: string | null;
                        DisplayName?: string | null;
                        Email?: string | null;
                        UsedSpace?: number;
                        MaxSpace?: number;
                        ProductUsedSpace?: { Drive?: number };
                    };
                };
                const user = res.User;
                if (!user) {
                    return cachedAccount;
                }
                let email = (user.Email ?? '').trim();
                let rawDisplayName = (user.DisplayName ?? '').trim();
                const name = (user.Name ?? '').trim();
                if (!email) {
                    try {
                        const primary = await runtime.addresses.getOwnPrimaryAddress();
                        email = primary.email;
                    } catch {
                        // ignore
                    }
                }
                const displayName = rawDisplayName || prettifyName(name, email);
                const initials = computeInitials(displayName, email);
                const usedSpace = Number(user.UsedSpace ?? 0);
                const maxSpace = Number(user.MaxSpace ?? 0);
                const usedDriveSpace = Number(user.ProductUsedSpace?.Drive ?? usedSpace);
                cachedAccount = {
                    name: name || email.split('@')[0] || 'user',
                    displayName,
                    email,
                    initials,
                    usedSpace,
                    maxSpace,
                    usedDriveSpace,
                };
                lastAccountFetchMs = Date.now();
                return cachedAccount;
            } catch (err) {
                runtime.logger.debug(`Failed to fetch user quota info: ${String(err)}`);
                return cachedAccount;
            } finally {
                accountFetchPromise = null;
            }
        })();
        return accountFetchPromise;
    };

    void refreshAccountInfo(true);

    interface CachedRemoteItem {
        uid: string;
        name: string;
        type: string;
        size: number;
        modificationTime: string;
    }
    const remoteListCache = new Map<string, { items: CachedRemoteItem[]; updatedAt: number }>();

    const fetchRemotePathItems = async (remotePath: string): Promise<CachedRemoteItem[]> => {
        const node = await runtime.paths.getNode(remotePath, [
            PathType.MyFiles,
            PathType.SharedWithMe,
            PathType.Devices,
        ]);
        const children = await listFolderChildren(runtime.sdk, node);
        const items = children.map((child) => ({
            uid: child.uid,
            name: getName(child),
            type: child.type,
            size: getClaimedSize(child) ?? 0,
            modificationTime: (
                child.activeRevision?.claimedModificationTime ?? child.modificationTime
            ).toISOString(),
        }));
        remoteListCache.set(remotePath, { items, updatedAt: Date.now() });
        return items;
    };

    // What the remote index last saw in a My files folder, for answering before a live listing arrives
    const buildFallbackFromIndex = (remotePath: string): CachedRemoteItem[] => {
        if (remotePath !== '/my-files' && !remotePath.startsWith('/my-files/')) {
            return [];
        }
        const relDir = remotePath.replace(/^\/my-files\/?/, '').replace(/^\/+|\/+$/g, '');
        return engine.remoteIndex.listChildren(relDir).map((entry) => ({
            uid: entry.uid,
            name: entry.name,
            type: entry.type,
            size: entry.size,
            modificationTime: entry.mtimeMs > 0 ? new Date(entry.mtimeMs).toISOString() : '',
        }));
    };

    if (runtime.auth.isLoggedIn()) {
        void fetchRemotePathItems('/my-files').catch(() => {});
    }

    // Sign in and out: called only through the control socket (POST /auth/login, /auth/logout), never from the TCP API
    const signIn = async () => {
        let signInUrlResolver: ((url: string) => void) | null = null;
        const signInUrlPromise = new Promise<string>((resolve) => {
            signInUrlResolver = resolve;
        });

        // Run authViaWeb in background and resolve signInUrl as soon as ready
        void runtime.auth
            .authViaWeb((signInUrl) => {
                openBrowserUrl(signInUrl);
                signInUrlResolver?.(signInUrl);
            })
            .then(async () => {
                // Signed in, maybe to another account than the engine knew: what it knew of the last one (its root, that
                // it was checked) goes before anything runs under this session, and start() checks it afresh (#35)
                await engine.stop();
                await runtime.eventsManager.startSubscriptions();
                stateDb.logActivity({
                    action: 'auth',
                    localRelPath: '/',
                    details: 'Signed in to Proton Drive via web authentication',
                });
                sendDesktopNotification({
                    title: 'Proton Drive Connected',
                    body: 'Successfully signed in and started two-way folder sync.',
                    enabled: stateDb.getSettings().notificationsEnabled,
                });
                await engine.start({ backgroundInitialReconcile: true });
                void refreshAccountInfo(true);
                void fetchRemotePathItems('/my-files').catch(() => {});
                ensureSystemTrayIndicator();
            })
            .catch((err: unknown) => {
                runtime.logger.error('Web authentication failed', err);
            });

        const signInUrl = await Promise.race([
            signInUrlPromise,
            new Promise<string>((resolve) => setTimeout(() => resolve(''), 3000)),
        ]);
        return { signInUrl, disclosure: THIRD_PARTY_DISCLOSURE };
    };

    const signOut = async () => {
        await engine.stop();
        await runtime.auth.logout();
        await runtime.clearCaches();
        cachedAccount = null;
        engine.stateEvents.reset(); // the file manager's emblems start over
        stateDb.logActivity({
            action: 'auth',
            localRelPath: '/',
            details: 'Signed out and cleared local crypto/entity caches',
        });
    };

    // Called only through the control socket (POST /remote/mkdir), never from the TCP API
    const makeRemoteFolder = async (parentPath: string, name: string) => {
        const parentNode = await runtime.paths.getNode(parentPath, [PathType.MyFiles, PathType.SharedWithMe, PathType.Devices]);
        const created = await runtime.sdk.createFolder(parentNode, name);
        remoteListCache.delete(parentPath);
        void fetchRemotePathItems(parentPath).catch(() => {});
        return { uid: created.uid, name: getName(created) };
    };

    const settings = stateDb.getSettings();
    let controlServer: { stop(): void } | null = null;
    const reconcileTimer = setInterval(() => {
        const s = stateDb.getSettings();
        if (s.paused && s.pausedUntil !== null) {
            // A timed pause ends here too, so a machine asleep past its time picks up syncing within one check (#205);
            // endPauseIfDue syncs when it ends one
            void engine.endPauseIfDue();
        }
        if (runtime.auth.isLoggedIn()) {
            void refreshAccountInfo();
            if (!s.paused) {
                void engine.reconcileNow();
            }
        }
    }, Math.max(30, settings.reconcileIntervalSec) * 1000);

    // Unmounts first, while the daemon still answers the helper; bounded, so it never holds up the shutdown
    const stop = async () => {
        clearInterval(reconcileTimer);
        await drive.stop();
        server.stop();
        controlServer?.stop();
        await engine.stop();
        // A file being uploaded once written gets a few seconds to finish; the shutdown never waits longer
        if (!(await engine.waitForRunningLooks(SHUTDOWN_LOOK_WAIT_MS))) {
            runtime.logger.warn('Shutting down with an upload of a file still under way; it uploads again at the next start');
        }
        stateDb.close();
        await runtime.dispose();
    };

    // Listening before any file moves: a second daemon fails here (the port is taken) instead of moving files too, and
    // the app sees this one answer, busy, rather than starting another
    let lastRejectionLogAt = 0;
    const server = Bun.serve({
        hostname: host,
        port,
        // Every endpoint must be served from fetch() so this check runs; Bun.serve `routes` or `static` would skip it
        async fetch(req, srv) {
            if (!isTrustedLocalRequest(req, srv.port ?? port)) {
                const now = Date.now();
                if (now - lastRejectionLogAt > 60_000) {
                    lastRejectionLogAt = now;
                    runtime.logger.warn(
                        `Rejected daemon API request (host=${JSON.stringify(req.headers.get('host'))}, origin=${req.headers.has('origin')}, sec-fetch-site=${req.headers.has('sec-fetch-site')})`,
                    );
                }
                return Response.json(
                    { error: 'Forbidden: the daemon API only accepts local, non-browser clients on 127.0.0.1' },
                    { status: 403 },
                );
            }
            const refused = refuseOnTcp(req);
            if (refused) return refused;
            const url = new URL(req.url);
            const pathname = url.pathname;

            try {
                if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
                    return Response.json({
                        service: 'protondrive-daemon',
                        status: engine.getStatus().state,
                    });
                }

                if (req.method === 'GET' && pathname === '/api/status') {
                    if (!cachedAccount && runtime.auth.isLoggedIn()) {
                        await Promise.race([
                            refreshAccountInfo(),
                            new Promise((resolve) => setTimeout(resolve, 600)),
                        ]);
                    } else if (runtime.auth.isLoggedIn()) {
                        void refreshAccountInfo();
                    }
                    const systemd = await getSystemdServiceStatus();
                    return Response.json({
                        ...engine.getStatus(),
                        vfs: drive.status(),
                        virtualDriveWanted: virtualDriveWanted(stateDb),
                        account: cachedAccount,
                        appVersion: runtime.config.appVersion,
                        sdkVersion: runtime.config.sdkVersion,
                        disclosure: THIRD_PARTY_DISCLOSURE,
                        systemd,
                    });
                }

                if (req.method === 'POST' && pathname === '/api/quit') {
                    setTimeout(() => {
                        void stop().finally(() => {
                            process.exit(0);
                        });
                    }, 150);
                    return Response.json({ ok: true });
                }

                if (req.method === 'GET' && pathname === '/api/activity') {
                    const limit = Number(url.searchParams.get('limit') || 50);
                    return Response.json(stateDb.listActivity(limit));
                }

                if (req.method === 'POST' && pathname === '/api/sync') {
                    void engine.reconcileNow();
                    return Response.json({ ok: true, message: 'Reconciliation triggered' });
                }

                if (req.method === 'POST' && pathname === '/api/pause') {
                    return pauseRoute(await req.json().catch(() => ({})), engine, Date.now());
                }

                if (req.method === 'GET' && pathname === '/api/conflicts') {
                    const conflicts = stateDb.listConflicts(true);
                    return Response.json(conflicts);
                }

                // Remote browser endpoints
                if (req.method === 'GET' && pathname === '/api/remote/list') {
                    if (!runtime.auth.isLoggedIn()) {
                        return Response.json({ error: 'Not signed in' }, { status: 401 });
                    }
                    const remotePath = url.searchParams.get('path') || '/my-files';
                    const forceRefresh = url.searchParams.get('refresh') === '1';
                    const cached = remoteListCache.get(remotePath);
                    if (cached && !forceRefresh) {
                        if (Date.now() - cached.updatedAt > 15_000) {
                            void fetchRemotePathItems(remotePath).catch(() => {});
                        }
                        return Response.json({ path: remotePath, items: withAvailability(engine.availability, remotePath, cached.items) });
                    }
                    const livePromise = fetchRemotePathItems(remotePath);
                    const fallbackItems = buildFallbackFromIndex(remotePath);
                    if (fallbackItems.length > 0 && !forceRefresh) {
                        const items = await Promise.race([
                            livePromise.catch(() => fallbackItems),
                            new Promise<CachedRemoteItem[]>((resolve) =>
                                setTimeout(() => resolve(fallbackItems), 900),
                            ),
                        ]);
                        return Response.json({ path: remotePath, items: withAvailability(engine.availability, remotePath, items) });
                    }
                    const items = await livePromise;
                    return Response.json({ path: remotePath, items: withAvailability(engine.availability, remotePath, items) });
                }

                // Nautilus file status lookup endpoint
                if (req.method === 'GET' && pathname === '/api/file-status') {
                    const localPath = url.searchParams.get('path') || '';
                    const syncDir = stateDb.getSettings().syncDir;
                    if (!localPath.startsWith(syncDir)) {
                        return Response.json({ tracked: false, status: 'outside' });
                    }
                    const relPath = path.relative(syncDir, localPath).split(path.sep).join('/');
                    if (!relPath || relPath === '.') {
                        return Response.json({
                            tracked: true,
                            status: engine.getStatus().state === 'syncing' ? 'syncing' : 'synced',
                        });
                    }
                    const item = stateDb.getItemByPath(relPath);
                    if (!item) {
                        return Response.json({ tracked: false, status: 'untracked' });
                    }
                    return Response.json({
                        tracked: true,
                        status: item.syncStatus,
                        nodeUid: item.nodeUid,
                        size: item.size,
                        updatedAt: item.updatedAt,
                    });
                }

                return Response.json({ error: 'Not found' }, { status: 404 });
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                return Response.json({ error: msg }, { status: 500 });
            }
        },
    });

    // A move cut short is finished, then the files move to match the mode, all before the engine starts. The
    // availability migration runs in between, on a whole tree, before the first sync with the availability policy (so
    // what is synced today stays downloaded); its failure stops the start, as syncing unmigrated would leave old Cloud
    // only records that read as local deletions.
    await drive.settleAtStart(async () => {
        if ((await migrateExcludedFolders(stateDb, engine.availability, stateDbPath, engine.localRoot())) === 'migrated') {
            runtime.logger.info('Migrated Cloud only folders to the availability policy');
        }
    });
    await engine.start({ backgroundInitialReconcile: true }); // does nothing while a move that stopped holds it
    ensureSystemTrayIndicator();

    // The only way to pin, free, hide or unhide, to change settings or the drive folder or the virtual drive, to sign in
    // or out, to resolve a conflict or to make a cloud folder: a user-only Unix socket, never the TCP API above
    try {
        controlServer = await startControlServer(
            controlServerOptions({
                socketPath: defaultControlSocketPath(),
                engine,
                drive,
                stateDb,
                signIn,
                signOut,
                makeRemoteFolder,
                share: createShareService({
                    sdk: runtime.sdk,
                    nodeFor: (relPath) => {
                        if (engine.availability.hiddenBy(relPath)) {
                            return { refused: 'Hidden from this computer: unhide it in Settings to share it' };
                        }
                        const entry = engine.remoteIndex.getByPath(relPath);
                        if (!entry) return { refused: 'Not uploaded yet: Proton Drive can share it once it has uploaded' };
                        return { uid: entry.uid, name: entry.name };
                    },
                    placeOf: (uid) => {
                        const entry = engine.remoteIndex.getByUid(uid);
                        return entry ? { relPath: entry.relPath, hidden: Boolean(engine.availability.hiddenBy(entry.relPath)) } : null;
                    },
                    logActivity: (entry) => stateDb.logActivity(entry),
                    now: Date.now,
                }),
                shareSignedIn: () => runtime.auth.isLoggedIn(),
                shareLog: (line) => runtime.logger.error(line),
                // The drive's size (#181): what the account uses of its storage, from what the app shows (asked of the
                // API at most once a minute)
                space: async () => {
                    const account = await refreshAccountInfo();
                    return account && account.maxSpace > 0 ? { usedSpace: account.usedSpace, maxSpace: account.maxSpace } : null;
                },
            }),
        );
    } catch (err) {
        runtime.logger.error(`Control socket unavailable, so the app can't pin or free files, change settings, sign in or out, resolve conflicts or make folders: ${String(err)}`);
    }
    // The login entry as the setting asks, from this binary (it may have moved since): on for a new install (#92). Only
    // by the daemon that has the control socket: a second one, about to stop, never points it elsewhere
    if (controlServer !== null) {
        try {
            const result = syncLoginEntry(stateDb);
            if (result === 'turned-off-by-user') {
                syncLogger.info('Start at login was turned off outside the app (the login entry was disabled or deleted): left off');
            }
        } catch (error: unknown) {
            syncLogger.warn(`Could not set Proton Drive to start at login: ${String(error)}`);
        }
    }
    await drive.startDrive(controlServer !== null);

    return {
        url: `http://${host}:${server.port}`,
        port: server.port,
        engine,
        stateDb,
        runtime,
        stop,
    };
}
