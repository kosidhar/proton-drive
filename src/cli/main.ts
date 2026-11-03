#!/usr/bin/env bun

import path from 'node:path';

import { launchDesktopWindow } from '../gui/launcher';
import { ensureSystemTrayIndicator } from '../linux/notifications';
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, startSyncDaemon } from '../daemon/daemonServer';
import {
    DEFAULT_APP_VERSION,
    DEFAULT_CLIENT_UID_PREFIX,
    DEFAULT_SDK_VERSION,
    downloadDriveNodeToLocal,
    getClaimedSize,
    getConfig,
    getName,
    init as initSdkRuntime,
    listFolderChildren,
    openBrowserUrl,
    PathType,
    THIRD_PARTY_DISCLOSURE,
    uploadLocalFileToDrive,
} from '../sdk';
import { DAEMON_NOT_RUNNING_MESSAGE, runAvailabilityCommand } from './availabilityCommands';
import { controlSocketDirProblem, daemonRunning, MOVING_FILES_MESSAGE, pendingMoveMarker, syncPassError } from './daemonProbe';
import { defaultControlSocketPath } from '../daemon/controlServer';
import { migrateExcludedFolders } from '../sync/availabilityMigration';
import { backingDirFor } from '../sync/driveMode';
import { formatBytes, ProtonDriveSyncEngine } from '../sync/syncEngine';
import { SyncStateDatabase } from '../sync/syncStateDb';

// How long a one-off sync waits for files still being written to settle and upload (see waitForSettling)
const CLI_SETTLE_WAIT_MS = 30_000;

const DAEMON_BASE_URL = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;

// The daemon runs when its control socket accepts a connection, or else its TCP API answers
async function isDaemonRunning(): Promise<boolean> {
    return daemonRunning({ socketPath: defaultControlSocketPath(), statusUrl: `${DAEMON_BASE_URL}/api/status` });
}

// The state database, found without starting the SDK runtime (which a refusal never needs)
function stateDbPathFromConfig(): string {
    const config = getConfig({ appVersion: DEFAULT_APP_VERSION, sdkVersion: DEFAULT_SDK_VERSION, clientUidPrefix: DEFAULT_CLIENT_UID_PREFIX });
    return path.join(config.appDir, 'ubuntu-sync-state.sqlite');
}

// An engine of the CLI's own is never run while files are moving between the sync folder and the backing store: the
// half not moved yet would read as deleted. Only the daemon finishes that move.
function refuseWhileMoving(): void {
    if (pendingMoveMarker(stateDbPathFromConfig()) !== null) {
        console.error(MOVING_FILES_MESSAGE);
        process.exit(2);
    }
}

/** The sync folder, as the running daemon reports it; null when the daemon isn't running. */
async function daemonSyncDir(): Promise<string | null> {
    if (!(await isDaemonRunning())) return null;
    try {
        const res = await fetch(`${DAEMON_BASE_URL}/api/status`);
        const status = (await res.json()) as { syncDir?: string };
        return status.syncDir ?? null;
    } catch {
        return null;
    }
}

// POST /conflicts/resolve on the daemon's control socket; throws with the daemon's own message when it refuses
async function resolveConflictOnDaemon(id: number, choice: string): Promise<{ localRelPath: string }> {
    const unsafe = controlSocketDirProblem(defaultControlSocketPath());
    if (unsafe !== null) {
        throw new Error(unsafe);
    }
    let res: Response;
    try {
        res = await fetch('http://localhost/conflicts/resolve', {
            unix: defaultControlSocketPath(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, choice }),
        } as RequestInit & { unix: string });
    } catch {
        throw new Error(`The daemon is running, but its control socket ${defaultControlSocketPath()} didn't answer`);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; conflict?: { localRelPath?: string } };
    if (!res.ok) {
        throw new Error(body.error ?? `The daemon refused to resolve conflict #${id} (HTTP ${res.status})`);
    }
    return { localRelPath: body.conflict?.localRelPath ?? '?' };
}

async function runAvailabilityCli(action: 'pin' | 'free' | 'hide' | 'unhide' | 'status', target: string | undefined): Promise<void> {
    if (!target) {
        console.error(`Usage: protondrive ${action} <path>`);
        process.exit(1);
    }
    const syncDir = await daemonSyncDir();
    if (syncDir === null) {
        console.error(DAEMON_NOT_RUNNING_MESSAGE);
        process.exit(2);
    }
    const code = await runAvailabilityCommand(action, target, syncDir);
    if (code !== 0) process.exit(code);
}

async function createStandaloneRuntime(verbose = false) {
    return await initSdkRuntime({
        appVersion: DEFAULT_APP_VERSION,
        sdkVersion: DEFAULT_SDK_VERSION,
        clientUidPrefix: DEFAULT_CLIENT_UID_PREFIX,
        enablePersistedEvents: true,
        enableConsoleLog: verbose,
        enableMetrics: false,
    });
}

function printHelp(): void {
    console.log(`Proton Drive for Linux (Powered by Proton Drive SDK)
App Version Header: ${DEFAULT_APP_VERSION}

Usage:
  protondrive <command> [options]

Daemon & Desktop GUI Commands:
  daemon                         Run two-way folder sync daemon & local control server
  gui                            Launch Native Desktop GUI window (starts daemon if needed)
  status [--json]                Show sync status, local folder, and synced file counts
  status <path>                  Show whether a file or folder is kept, downloaded, online only or hidden
  pin <path>                     Always keep a file or folder on this device
  free <path>                    Free up space: make downloaded files online only
  hide <path>                    Hide a file or folder from this computer
  unhide <path>                  Unhide it (it becomes online only)
  sync                           Trigger an immediate two-way synchronization pass
  pause                          Pause background synchronization
  resume                         Resume background synchronization

Authentication Commands (OS Keyring / XDG Fallback):
  auth login                     Sign in via web browser (stores session in OS Keyring)
  auth logout                    Sign out and clear local caches
  auth status                    Check current authentication status

Conflict & Selective Sync Commands:
  conflicts                      List detected file conflicts
  conflicts resolve <id> <mode>  Resolve conflict (#id) with keep-both | keep-local | keep-remote
  selective-sync list            List top-level folders with their availability
  selective-sync exclude|include Same as hide|unhide

Direct Cloud File Commands (@protontech/drive-sdk):
  ls [remotePath]                List remote folder contents (default: /my-files)
  mkdir <parentPath> <name>      Create remote folder (e.g. /my-files Projects)
  upload <localFile> <remoteDir> Upload a local file to Proton Drive
  download <remoteFile> <local>  Download a file from Proton Drive
  trash <remotePath>             Move a remote file or folder to Trash
  version                        Display client and SDK versions
  help                           Show this help message
`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
    const jsonFlag = argv.includes('--json') || argv.includes('-j');
    const verboseFlag = argv.includes('--verbose') || argv.includes('-v');
    const args = argv.filter((a) => a !== '--json' && a !== '-j' && a !== '--verbose' && a !== '-v');

    const cmd = args[0] || 'help';

    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
        printHelp();
        return;
    }

    if (cmd === 'version' || cmd === '--version') {
        const info = {
            appVersion: DEFAULT_APP_VERSION,
            sdkVersion: DEFAULT_SDK_VERSION,
            disclosure: THIRD_PARTY_DISCLOSURE,
        };
        if (jsonFlag) {
            console.log(JSON.stringify(info, null, 2));
        } else {
            console.log(`App Version: ${info.appVersion}`);
            console.log(`SDK Version: ${info.sdkVersion}`);
            console.log(`Disclosure:  ${info.disclosure}`);
        }
        return;
    }

    if (cmd === 'daemon') {
        console.log(`[proton-drive-ubuntu] ${THIRD_PARTY_DISCLOSURE}`);
        const daemon = await startSyncDaemon({ enableConsoleLog: verboseFlag });
        console.log(`[proton-drive-ubuntu] Sync daemon listening at ${daemon.url}`);
        console.log(`[proton-drive-ubuntu] Syncing local folder: ${daemon.stateDb.getSettings().syncDir}`);

        const shutdown = async () => {
            console.log('\n[proton-drive-ubuntu] Shutting down sync daemon...');
            await daemon.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        // Keep process alive
        await new Promise(() => {});
        return;
    }

    if (cmd === 'gui') {
        if (await isDaemonRunning()) {
            console.log(`[proton-drive-ubuntu] Opening desktop GUI (${DAEMON_BASE_URL})...`);
            ensureSystemTrayIndicator();
            launchDesktopWindow(DAEMON_BASE_URL);
            await new Promise((r) => setTimeout(r, 200));
            return;
        }
        console.log(`[proton-drive-ubuntu] Starting sync daemon and opening desktop GUI...`);
        const daemon = await startSyncDaemon({ enableConsoleLog: verboseFlag });
        launchDesktopWindow(daemon.url);
        console.log(`[proton-drive-ubuntu] Desktop GUI opened at ${daemon.url}`);
        console.log(`[proton-drive-ubuntu] Syncing ${daemon.stateDb.getSettings().syncDir} in the background (keep open or install systemd service).`);
        const shutdown = async () => {
            await daemon.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await new Promise(() => {});
        return;
    }

    if (cmd === 'pin' || cmd === 'free' || cmd === 'hide' || cmd === 'unhide' || (cmd === 'status' && args[1])) {
        await runAvailabilityCli(cmd, args[1]);
        return;
    }

    if (cmd === 'status') {
        if (await isDaemonRunning()) {
            const res = await fetch(`${DAEMON_BASE_URL}/api/status`);
            const status = await res.json();
            if (jsonFlag) {
                console.log(JSON.stringify(status, null, 2));
            } else {
                console.log(`Notice:       ${THIRD_PARTY_DISCLOSURE}`);
                console.log(`Daemon:       Running (${DAEMON_BASE_URL})`);
                console.log(`Account:      ${status.loggedIn ? 'Signed In' : 'Not Signed In'}`);
                console.log(`Sync State:   ${status.state}`);
                console.log(`Sync Folder:  ${status.syncDir}`);
                console.log(`Synced Files: ${status.stats.totalFiles} (${formatBytes(status.stats.totalBytes)})`);
                console.log(`Folders:      ${status.stats.totalFolders}`);
                console.log(`Conflicts:    ${status.stats.unresolvedConflicts}`);
            }
            return;
        }

        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const stateDb = new SyncStateDatabase(path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite'));
            const settings = stateDb.getSettings();
            const stats = stateDb.getSummaryStats();
            const loggedIn = runtime.auth.isLoggedIn();
            const payload = {
                daemonRunning: false,
                loggedIn,
                syncDir: settings.syncDir,
                paused: settings.paused,
                stats,
                disclosure: THIRD_PARTY_DISCLOSURE,
            };
            if (jsonFlag) {
                console.log(JSON.stringify(payload, null, 2));
            } else {
                console.log(`Notice:       ${THIRD_PARTY_DISCLOSURE}`);
                console.log(`Daemon:       Stopped (run 'proton-drive-ubuntu daemon' to start)`);
                console.log(`Account:      ${loggedIn ? 'Signed In' : 'Not Signed In'}`);
                console.log(`Sync Folder:  ${settings.syncDir}`);
                console.log(`Synced Files: ${stats.totalFiles} (${formatBytes(stats.totalBytes)})`);
                console.log(`Folders:      ${stats.totalFolders}`);
                console.log(`Conflicts:    ${stats.unresolvedConflicts}`);
            }
            stateDb.close();
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'pause' || cmd === 'resume') {
        const paused = cmd === 'pause';
        if (await isDaemonRunning()) {
            await fetch(`${DAEMON_BASE_URL}/api/pause`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paused }),
            });
            console.log(`Synchronization ${paused ? 'paused' : 'resumed'}.`);
            return;
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const stateDb = new SyncStateDatabase(path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite'));
            stateDb.updateSettings({ paused });
            stateDb.close();
            console.log(`Synchronization ${paused ? 'paused' : 'resumed'}.`);
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'sync') {
        if (await isDaemonRunning()) {
            const res = await fetch(`${DAEMON_BASE_URL}/api/sync`, { method: 'POST' }).catch((err: unknown) => {
                throw new Error(`The daemon is running, but its API at ${DAEMON_BASE_URL} didn't answer: ${err instanceof Error ? err.message : String(err)}`);
            });
            if (!res.ok) {
                throw new Error(`The daemon refused to sync (HTTP ${res.status})`);
            }
            console.log('Triggered immediate synchronization pass on running daemon.');
            return;
        }
        refuseWhileMoving();
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            if (!runtime.auth.isLoggedIn()) {
                throw new Error('Not signed in. Run `proton-drive-ubuntu auth login` first.');
            }
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
            // As the daemon does, in case this is the first sync since Cloud only folders were retired
            await migrateExcludedFolders(stateDb, engine.availability, stateDbPath, engine.localRoot());
            console.log(`Syncing ${stateDb.getSettings().syncDir} with Proton Drive...`);
            await engine.reconcileNow();
            const failed = syncPassError(engine.getStatus());
            // Files still being written upload once they settle (see stillBeingWritten): waited for a while, and any
            // still being written after that are left for the next sync, and said so
            const stillWritten = failed === null ? await engine.waitForSettling(CLI_SETTLE_WAIT_MS) : 0;
            await engine.stop();
            if (failed !== null) {
                stateDb.close();
                throw new Error(failed);
            }
            const stats = stateDb.getSummaryStats();
            console.log(
                `Sync complete: ${stats.totalFiles} files (${formatBytes(stats.totalBytes)}), ${stats.totalFolders} folders.`,
            );
            if (stillWritten > 0) {
                console.log(`${stillWritten} file(s) still being written were not synced; they sync next time.`);
            }
            stateDb.close();
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'auth') {
        const sub = args[1] || 'status';
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            if (sub === 'status') {
                const loggedIn = runtime.auth.isLoggedIn();
                if (jsonFlag) {
                    console.log(JSON.stringify({ loggedIn, disclosure: THIRD_PARTY_DISCLOSURE }, null, 2));
                } else {
                    console.log(`Notice: ${THIRD_PARTY_DISCLOSURE}`);
                    console.log(`Status: ${loggedIn ? 'Signed In (OS Keyring)' : 'Signed Out'}`);
                }
                return;
            }
            if (sub === 'login') {
                console.log(`Notice: ${THIRD_PARTY_DISCLOSURE}`);
                await runtime.auth.authViaWeb((signInUrl) => {
                    openBrowserUrl(signInUrl);
                    console.log('Complete sign-in in your browser. Waiting for authentication...');
                    console.log(`If the browser did not open, visit:\n${signInUrl}`);
                });
                console.log('Authentication successful! Session saved to OS secret store.');
                return;
            }
            if (sub === 'logout') {
                await runtime.auth.logout();
                await runtime.clearCaches();
                console.log('Signed out and cleared local caches.');
                return;
            }
            throw new Error(`Unknown auth subcommand: ${sub}`);
        } finally {
            await runtime.dispose();
        }
    }

    if (cmd === 'conflicts') {
        const sub = args[1];
        if (sub === 'resolve') {
            const id = Number(args[2]);
            const choice = args[3] as 'keep-both' | 'keep-local' | 'keep-remote';
            if (!id || !['keep-both', 'keep-local', 'keep-remote'].includes(choice)) {
                throw new Error('Usage: proton-drive-ubuntu conflicts resolve <id> <keep-both|keep-local|keep-remote>');
            }
            // A running daemon resolves it with its own engine, over the user-only control socket
            if (await isDaemonRunning()) {
                const resolved = await resolveConflictOnDaemon(id, choice);
                console.log(`Conflict #${id} (${resolved.localRelPath}) resolved with ${choice}.`);
                return;
            }
            refuseWhileMoving();
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const stateDb = new SyncStateDatabase(path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite'));
            if (sub === 'resolve') {
                const id = Number(args[2]);
                const choice = args[3] as 'keep-both' | 'keep-local' | 'keep-remote';
                const engine = new ProtonDriveSyncEngine(
                    runtime.sdk,
                    runtime.eventsManager,
                    runtime.auth,
                    stateDb,
                    runtime.logger,
                    { backingDir: backingDirFor(runtime.config.appDir) },
                );
                const resolved = await engine.resolveConflictManually(id, choice);
                console.log(`Conflict #${id} (${resolved.localRelPath}) resolved with ${choice}.`);
            } else {
                const conflicts = stateDb.listConflicts(true);
                if (jsonFlag) {
                    console.log(JSON.stringify(conflicts, null, 2));
                } else if (conflicts.length === 0) {
                    console.log('No conflicts recorded.');
                } else {
                    for (const c of conflicts) {
                        console.log(
                            `#${c.id} [${c.resolved ? `RESOLVED: ${c.resolution}` : 'UNRESOLVED'}] ${c.localRelPath} (${new Date(c.detectedAt).toISOString()})`,
                        );
                    }
                }
            }
            stateDb.close();
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'selective-sync') {
        const sub = args[1] || 'list';
        if (sub === 'exclude' || sub === 'include') {
            await runAvailabilityCli(sub === 'exclude' ? 'hide' : 'unhide', args[2]);
            return;
        }
        if (!(await isDaemonRunning())) {
            console.error(DAEMON_NOT_RUNNING_MESSAGE);
            process.exit(2);
        }
        const res = await fetch(`${DAEMON_BASE_URL}/api/remote/list?path=${encodeURIComponent('/my-files')}`);
        if (!res.ok) {
            throw new Error(`The daemon could not list your folders (HTTP ${res.status})`);
        }
        const listing = (await res.json()) as { items: Array<{ uid: string; name: string; type: string; availability?: string }> };
        const folders = listing.items
            .filter((item) => item.type === 'folder')
            .map((item) => ({ name: item.name, uid: item.uid, availability: item.availability ?? 'online-only' }))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (jsonFlag) {
            console.log(JSON.stringify({ folders }, null, 2));
        } else {
            for (const folder of folders) {
                console.log(`/my-files/${folder.name}  [${folder.availability}]`);
            }
        }
        return;
    }

    if (cmd === 'ls') {
        const remotePath = args[1] || '/my-files';
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            if (!runtime.auth.isLoggedIn()) {
                throw new Error('Not signed in. Run `proton-drive-ubuntu auth login` first.');
            }
            const node = await runtime.paths.getNode(remotePath, [
                PathType.MyFiles,
                PathType.SharedWithMe,
                PathType.Devices,
            ]);
            const children = await listFolderChildren(runtime.sdk, node);
            const items = children.map((c) => ({
                uid: c.uid,
                name: getName(c),
                type: c.type,
                size: getClaimedSize(c) ?? 0,
                modified: (c.activeRevision?.claimedModificationTime ?? c.modificationTime).toISOString(),
            }));
            if (jsonFlag) {
                console.log(JSON.stringify(items, null, 2));
            } else {
                for (const item of items) {
                    const prefix = item.type === 'folder' ? 'd' : '-';
                    console.log(`${prefix}  ${formatBytes(item.size).padStart(10)}  ${item.modified}  ${item.name}`);
                }
            }
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'mkdir') {
        const parentPath = args[1];
        const name = args[2];
        if (!parentPath || !name) {
            throw new Error('Usage: proton-drive-ubuntu mkdir <remoteParentPath> <folderName>');
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const parent = await runtime.paths.getNode(parentPath, [
                PathType.MyFiles,
                PathType.SharedWithMe,
                PathType.Devices,
            ]);
            const created = await runtime.sdk.createFolder(parent, name);
            console.log(`Created folder '${getName(created)}' (${created.uid})`);
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'upload') {
        const localFile = args[1];
        const remoteDir = args[2] || '/my-files';
        if (!localFile) {
            throw new Error('Usage: proton-drive-ubuntu upload <localFilePath> [remoteParentPath]');
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const parentNode = await runtime.paths.getNode(remoteDir, [
                PathType.MyFiles,
                PathType.SharedWithMe,
                PathType.Devices,
            ]);
            const res = await uploadLocalFileToDrive({
                sdk: runtime.sdk,
                logger: runtime.logger,
                parentNode,
                localPath: path.resolve(localFile),
            });
            console.log(`Upload ${res.status}: ${res.remoteName} (${formatBytes(res.size)}, sha1=${res.sha1})`);
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'download') {
        const remoteFile = args[1];
        const localTarget = args[2];
        if (!remoteFile || !localTarget) {
            throw new Error('Usage: proton-drive-ubuntu download <remoteFilePath> <localTargetPath>');
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const remoteNode = await runtime.paths.getNode(remoteFile, [
                PathType.MyFiles,
                PathType.SharedWithMe,
                PathType.Devices,
            ]);
            const res = await downloadDriveNodeToLocal({
                sdk: runtime.sdk,
                logger: runtime.logger,
                remoteNode,
                localPath: path.resolve(localTarget),
            });
            console.log(`Download ${res.status}: ${res.localPath} (${formatBytes(res.size)})`);
        } finally {
            await runtime.dispose();
        }
        return;
    }

    if (cmd === 'trash') {
        const remotePath = args[1];
        if (!remotePath) {
            throw new Error('Usage: proton-drive-ubuntu trash <remotePath>');
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const node = await runtime.paths.getNode(remotePath, [
                PathType.MyFiles,
                PathType.SharedWithMe,
                PathType.Devices,
            ]);
            for await (const res of runtime.sdk.trashNodes([node])) {
                if (!res.ok) {
                    throw res.error;
                }
            }
            console.log(`Moved '${remotePath}' (${node.uid}) to Proton Drive Trash.`);
        } finally {
            await runtime.dispose();
        }
        return;
    }

    throw new Error(`Unknown command: ${cmd}. Run 'proton-drive-ubuntu help' for usage.`);
}

if (import.meta.main) {
    runCli()
        .then(() => {
            process.exit(0);
        })
        .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${msg}`);
            process.exit(1);
        });
}
