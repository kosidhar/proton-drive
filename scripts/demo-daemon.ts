#!/usr/bin/env bun
// A stand-in for the daemon's TCP API that answers with made-up data, so the app can be photographed for the README
// without showing a real account (#520). It serves what protondrive-gui reads (GET /api/status, /api/activity,
// /api/conflicts; POST /api/sync, /api/pause) and nothing else: every other request is logged and answered 404.
//
//   bun scripts/demo-daemon.ts [port]        (or DEMO_DAEMON_PORT; 0 picks a free one)
//
// It listens on 127.0.0.1 only and refuses 49152, the port the real daemon uses. It never opens the control socket,
// and never contacts Proton.

const REAL_DAEMON_PORT = 49152;
// The app shows sizes in 1024s, so 38 GiB reads as "38 GB"
const GB = 1024 ** 3;
const MIN = 60_000;

/** The one account in this data. */
export const PERSONA = { name: 'Alex Rivera', email: 'alex@example.com', initials: 'AR', usedGb: 38, maxGb: 500 } as const;

/** The sync folder the app shows. A made-up path under a sample home. */
export const DEMO_SYNC_DIR = '/home/user/ProtonDrive';

/** How the daemon looks: in sync, or with a couple of uploads going. */
export type DemoState = 'idle' | 'syncing';

export function demoStatus(now: number, state: DemoState = 'idle') {
    const syncing = state === 'syncing';
    return {
        state,
        currentAction: syncing ? 'Uploading Photos/Lisbon/IMG_2041.jpg' : null,
        lastError: null,
        filesMissing: null,
        accountMismatch: null,
        loggedIn: true,
        syncDir: DEMO_SYNC_DIR,
        activeTransfers: syncing
            ? [
                  { id: 'demo-1', direction: 'upload', relPath: 'Photos/Lisbon/IMG_2041.jpg', bytesTransferred: 3_400_000, totalBytes: 8_200_000 },
                  { id: 'demo-2', direction: 'download', relPath: 'Projects/Shed/plans-v3.pdf', bytesTransferred: 900_000, totalBytes: 2_700_000 },
              ]
            : [],
        syncingFolders: syncing ? ['Photos/Lisbon', 'Projects/Shed'] : [],
        stats: { totalFiles: 1284, totalFolders: 96, totalBytes: 21 * GB, unresolvedConflicts: 0, errorItems: 0, cutShortFiles: 0 },
        settings: {
            syncDir: DEMO_SYNC_DIR,
            conflictStrategy: 'keep-both',
            notificationsEnabled: true,
            reconcileIntervalSec: 300,
            paused: false,
            pausedUntil: null,
            ignorePatterns: ['*.tmp', '.~lock.*', 'node_modules'],
            blockedApps: ['tracker-miner-fs-3'],
            startAtLogin: true,
        },
        account: {
            name: PERSONA.name,
            displayName: PERSONA.name,
            email: PERSONA.email,
            initials: PERSONA.initials,
            usedSpace: PERSONA.usedGb * GB,
            maxSpace: PERSONA.maxGb * GB,
            usedDriveSpace: 34 * GB,
        },
        vfs: { mode: 'virtual', mounted: true, reason: null, error: null, move: null },
        virtualDriveWanted: true,
        lastSyncAt: now - 2 * MIN,
        diskFull: null,
    };
}

export function demoActivity(now: number) {
    const entry = (id: number, minAgo: number, action: string, localRelPath: string, details: string) => ({
        id,
        timestamp: now - minAgo * MIN,
        action,
        localRelPath,
        details,
    });
    return [
        entry(12, 3, 'upload', 'Work/Meeting notes.protondoc', 'Uploaded 18 KB'),
        entry(11, 7, 'upload', 'Work/Budget 2026.protonsheet', 'Uploaded 42 KB'),
        entry(10, 22, 'download', 'Projects/Shed/plans-v3.pdf', 'Downloaded 2.6 MB'),
        entry(9, 41, 'upload', 'Photos/Lisbon/IMG_2038.jpg', 'Uploaded 7.9 MB'),
        entry(8, 41, 'upload', 'Photos/Lisbon/IMG_2039.jpg', 'Uploaded 8.1 MB'),
        entry(7, 95, 'mkdir', 'Photos/Lisbon', 'Created folder'),
        entry(6, 180, 'free-up', 'Photos/2024', 'Freed up space: 3.1 GB stays online only'),
        entry(5, 240, 'download', 'Taxes/2025/Return 2025.pdf', 'Downloaded 1.2 MB'),
        entry(4, 300, 'share', 'Documents/Lease agreement.pdf', 'Shared with a link'),
        entry(3, 1440, 'upload', 'Taxes/2025/Receipts.zip', 'Uploaded 54 MB'),
        entry(2, 1500, 'share', '', 'Accepted an invitation to Trip budget'),
        entry(1, 2880, 'download', 'Documents/Passport scan.pdf', 'Downloaded 3.4 MB'),
    ];
}

/** What every request is answered with: a made-up reply, or null for a request this does not know. */
export function route(method: string, pathname: string, now = Date.now(), state: DemoState = 'idle'): { status: number; body: unknown } | null {
    if (method === 'GET' && pathname === '/api/status') return { status: 200, body: demoStatus(now, state) };
    if (method === 'GET' && pathname === '/api/activity') return { status: 200, body: demoActivity(now) };
    if (method === 'GET' && pathname === '/api/conflicts') return { status: 200, body: [] };
    if (method === 'POST' && pathname === '/api/sync') return { status: 200, body: { ok: true, message: 'Reconciliation triggered' } };
    if (method === 'POST' && pathname === '/api/pause') return { status: 200, body: { ok: true } };
    return null;
}

export function startDemoDaemon(port: number, state: DemoState = 'idle', log: (line: string) => void = (l) => console.error(l)) {
    if (port === REAL_DAEMON_PORT) {
        throw new Error(`demo-daemon: refusing port ${REAL_DAEMON_PORT}, the real daemon's`);
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`demo-daemon: not a port: ${port}`);
    }
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch(req) {
            const url = new URL(req.url);
            const reply = route(req.method, url.pathname, Date.now(), state);
            if (!reply) {
                log(`demo-daemon: unknown request ${req.method} ${url.pathname}${url.search}`);
                return Response.json({ error: 'Not found' }, { status: 404 });
            }
            return Response.json(reply.body, { status: reply.status });
        },
    });
    if (server.port === REAL_DAEMON_PORT) {
        server.stop(true);
        throw new Error(`demo-daemon: refusing port ${REAL_DAEMON_PORT}, the real daemon's`);
    }
    return server;
}

if (import.meta.main) {
    const raw = process.argv[2] ?? process.env.DEMO_DAEMON_PORT ?? '0';
    const state: DemoState = process.env.DEMO_STATE === 'syncing' ? 'syncing' : 'idle';
    try {
        const server = startDemoDaemon(Number(raw), state);
        console.log(`demo-daemon listening on 127.0.0.1:${server.port}`);
    } catch (e) {
        console.error((e as Error).message);
        process.exit(2);
    }
}
