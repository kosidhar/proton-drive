import path from 'node:path';

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
import { backingDirFor } from '../sync/driveMode';
import { ProtonDriveSyncEngine } from '../sync/syncEngine';
import { SyncStateDatabase } from '../sync/syncStateDb';
import { defaultControlSocketPath, startControlServer } from './controlServer';
import { isTrustedLocalRequest } from './requestGuard';

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

    const engine = new ProtonDriveSyncEngine(
        runtime.sdk,
        runtime.eventsManager,
        runtime.auth,
        stateDb,
        runtime.logger,
        { backingDir: backingDirFor(runtime.config.appDir) },
    );

    // Before the first sync with the availability policy, so what is synced today stays downloaded. A failure stops
    // the start: syncing unmigrated would leave old Cloud only records that read as local deletions.
    if ((await migrateExcludedFolders(stateDb, engine.availability, stateDbPath, engine.localRoot())) === 'migrated') {
        runtime.logger.info('Migrated Cloud only folders to the availability policy');
    }
    await engine.start({ backgroundInitialReconcile: true });
    ensureSystemTrayIndicator();

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

    // Availability is computed per response, never cached, so a cached listing still shows the current state
    const withAvailability = (remotePath: string, items: CachedRemoteItem[]) => {
        if (remotePath !== '/my-files' && !remotePath.startsWith('/my-files/')) {
            return items;
        }
        const relDir = remotePath.replace(/^\/my-files\/?/, '').replace(/^\/+|\/+$/g, '');
        return items.map((item) => ({
            ...item,
            availability: engine.availability.stateOf(relDir ? `${relDir}/${item.name}` : item.name),
        }));
    };

    if (runtime.auth.isLoggedIn()) {
        void fetchRemotePathItems('/my-files').catch(() => {});
    }

    const settings = stateDb.getSettings();
    const reconcileTimer = setInterval(() => {
        const s = stateDb.getSettings();
        if (runtime.auth.isLoggedIn()) {
            void refreshAccountInfo();
            if (!s.paused) {
                void engine.reconcileNow();
            }
        }
    }, Math.max(30, settings.reconcileIntervalSec) * 1000);

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
                    const body = (await req.json().catch(() => ({}))) as { paused?: boolean };
                    await engine.setPaused(Boolean(body.paused));
                    return Response.json({ ok: true, status: engine.getStatus() });
                }

                if (req.method === 'POST' && pathname === '/api/auth/login') {
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

                    return Response.json({ ok: true, signInUrl, disclosure: THIRD_PARTY_DISCLOSURE });
                }

                if (req.method === 'POST' && pathname === '/api/auth/logout') {
                    await engine.stop();
                    await runtime.auth.logout();
                    await runtime.clearCaches();
                    cachedAccount = null;
                    stateDb.logActivity({
                        action: 'auth',
                        localRelPath: '/',
                        details: 'Signed out and cleared local crypto/entity caches',
                    });
                    return Response.json({ ok: true });
                }

                if (req.method === 'GET' && pathname === '/api/conflicts') {
                    const conflicts = stateDb.listConflicts(true);
                    return Response.json(conflicts);
                }

                if (req.method === 'POST' && pathname === '/api/conflicts/resolve') {
                    const body = (await req.json()) as {
                        id: number;
                        choice: 'keep-both' | 'keep-local' | 'keep-remote';
                    };
                    const resolved = await engine.resolveConflictManually(Number(body.id), body.choice);
                    return Response.json({ ok: true, conflict: resolved });
                }

                if (req.method === 'POST' && pathname === '/api/settings') {
                    const prev = stateDb.getSettings();
                    const body = (await req.json()) as Record<string, unknown>;
                    if (typeof body.syncDir === 'string' && body.syncDir.trim() && body.syncDir.trim() !== prev.syncDir) {
                        const relocated = await engine.relocateSyncFolder(prev.syncDir, body.syncDir.trim());
                        body.syncDir = relocated;
                    }
                    const updated = stateDb.updateSettings(body);
                    if (
                        prev.syncDir !== updated.syncDir ||
                        JSON.stringify(prev.ignorePatterns) !== JSON.stringify(updated.ignorePatterns)
                    ) {
                        void engine.reconcileNow();
                    }
                    return Response.json({ ok: true, settings: stateDb.getSettings() });
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
                        return Response.json({ path: remotePath, items: withAvailability(remotePath, cached.items) });
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
                        return Response.json({ path: remotePath, items: withAvailability(remotePath, items) });
                    }
                    const items = await livePromise;
                    return Response.json({ path: remotePath, items: withAvailability(remotePath, items) });
                }

                if (req.method === 'POST' && pathname === '/api/remote/mkdir') {
                    const body = (await req.json()) as { parentPath: string; name: string };
                    const targetParent = body.parentPath || '/my-files';
                    const parentNode = await runtime.paths.getNode(targetParent, [
                        PathType.MyFiles,
                        PathType.SharedWithMe,
                        PathType.Devices,
                    ]);
                    const created = await runtime.sdk.createFolder(parentNode, body.name);
                    remoteListCache.delete(targetParent);
                    void fetchRemotePathItems(targetParent).catch(() => {});
                    return Response.json({
                        ok: true,
                        folder: { uid: created.uid, name: getName(created) },
                    });
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

    // The only way to pin, free, hide or unhide: a user-only Unix socket, never the TCP API above
    let controlServer: { stop(): void } | null = null;
    try {
        controlServer = await startControlServer({ socketPath: defaultControlSocketPath(), engine });
    } catch (err) {
        runtime.logger.error(`Control socket unavailable, availability actions are disabled: ${String(err)}`);
    }

    const stop = async () => {
        clearInterval(reconcileTimer);
        server.stop();
        controlServer?.stop();
        await engine.stop();
        stateDb.close();
        await runtime.dispose();
    };

    return {
        url: `http://${host}:${server.port}`,
        port: server.port,
        engine,
        stateDb,
        runtime,
        stop,
    };
}
