#!/usr/bin/env bun

import path from 'node:path';

import { launchDesktopWindow } from '../gui/launcher';
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, startSyncDaemon } from '../daemon/daemonServer';
import {
    DEFAULT_APP_VERSION,
    DEFAULT_CLIENT_UID_PREFIX,
    DEFAULT_SDK_VERSION,
    downloadDriveNodeToLocal,
    getClaimedSize,
    getName,
    init as initSdkRuntime,
    listFolderChildren,
    openBrowserUrl,
    PathType,
    THIRD_PARTY_DISCLOSURE,
    uploadLocalFileToDrive,
} from '../sdk';
import { formatBytes, ProtonDriveSyncEngine } from '../sync/syncEngine';
import { SyncStateDatabase } from '../sync/syncStateDb';

const DAEMON_BASE_URL = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;

async function isDaemonRunning(): Promise<boolean> {
    try {
        const res = await fetch(`${DAEMON_BASE_URL}/api/status`, {
            signal: AbortSignal.timeout(1000),
        });
        return res.ok;
    } catch {
        return false;
    }
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
    console.log(`Proton Drive for Ubuntu (Unofficial Client powered by Proton Drive SDK)
Notice: ${THIRD_PARTY_DISCLOSURE}
App Version Header: ${DEFAULT_APP_VERSION}

Usage:
  proton-drive-ubuntu <command> [options]

Daemon & Desktop GUI Commands:
  daemon                         Run two-way folder sync daemon & local control server
  gui                            Launch Ubuntu Desktop GUI window (starts daemon if needed)
  status [--json]                Show sync status, local folder, and synced file counts
  sync                           Trigger an immediate two-way synchronization pass
  pause                          Pause background synchronization
  resume                         Resume background synchronization

Authentication Commands (OS Keyring / libsecret):
  auth login                     Sign in via web browser (stores session in OS Keyring)
  auth logout                    Sign out and clear local caches
  auth status                    Check current authentication status

Conflict & Selective Sync Commands:
  conflicts                      List detected file conflicts
  conflicts resolve <id> <mode>  Resolve conflict (#id) with keep-both | keep-local | keep-remote
  selective-sync list            List remote top-level folders and their inclusion status
  selective-sync exclude <name>  Exclude a top-level remote folder from local sync
  selective-sync include <name>  Re-include a top-level remote folder in local sync

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
            await fetch(`${DAEMON_BASE_URL}/api/sync`, { method: 'POST' });
            console.log('Triggered immediate synchronization pass on running daemon.');
            return;
        }
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            if (!runtime.auth.isLoggedIn()) {
                throw new Error('Not signed in. Run `proton-drive-ubuntu auth login` first.');
            }
            const stateDb = new SyncStateDatabase(path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite'));
            const engine = new ProtonDriveSyncEngine(
                runtime.sdk,
                runtime.eventsManager,
                runtime.auth,
                stateDb,
                runtime.logger,
            );
            console.log(`Syncing ${stateDb.getSettings().syncDir} with Proton Drive...`);
            await engine.reconcileNow();
            const stats = stateDb.getSummaryStats();
            console.log(
                `Sync complete: ${stats.totalFiles} files (${formatBytes(stats.totalBytes)}), ${stats.totalFolders} folders.`,
            );
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
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const stateDb = new SyncStateDatabase(path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite'));
            if (sub === 'resolve') {
                const id = Number(args[2]);
                const choice = args[3] as 'keep-both' | 'keep-local' | 'keep-remote';
                if (!id || !['keep-both', 'keep-local', 'keep-remote'].includes(choice)) {
                    throw new Error('Usage: proton-drive-ubuntu conflicts resolve <id> <keep-both|keep-local|keep-remote>');
                }
                const engine = new ProtonDriveSyncEngine(
                    runtime.sdk,
                    runtime.eventsManager,
                    runtime.auth,
                    stateDb,
                    runtime.logger,
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
        const folderName = args[2];
        const runtime = await createStandaloneRuntime(verboseFlag);
        try {
            const stateDb = new SyncStateDatabase(path.join(runtime.config.appDir, 'ubuntu-sync-state.sqlite'));
            const settings = stateDb.getSettings();
            const excluded = new Set(settings.excludedFolders);

            if (sub === 'exclude' && folderName) {
                excluded.add(folderName);
                stateDb.updateSettings({ excludedFolders: Array.from(excluded) });
                console.log(`Excluded '${folderName}' from local synchronization.`);
            } else if (sub === 'include' && folderName) {
                excluded.delete(folderName);
                stateDb.updateSettings({ excludedFolders: Array.from(excluded) });
                console.log(`Included '${folderName}' in local synchronization.`);
            } else {
                const engine = new ProtonDriveSyncEngine(
                    runtime.sdk,
                    runtime.eventsManager,
                    runtime.auth,
                    stateDb,
                    runtime.logger,
                );
                const folders = await engine.listRemoteTopLevelFolders();
                if (jsonFlag) {
                    console.log(JSON.stringify({ folders, excludedFolders: Array.from(excluded) }, null, 2));
                } else {
                    console.log('Excluded Top-Level Folders:', Array.from(excluded).join(', ') || '(none)');
                    for (const f of folders) {
                        console.log(`  [${f.excluded ? 'EXCLUDED' : 'SYNCED'}] /my-files/${f.name}`);
                    }
                }
            }
            stateDb.close();
        } finally {
            await runtime.dispose();
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
