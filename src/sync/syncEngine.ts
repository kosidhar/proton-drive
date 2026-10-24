import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    type DriveEvent,
    DriveEventType,
    type Logger,
    type NodeEntity,
    NodeType,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import { sendDesktopNotification } from '../linux/notifications';
import type { Manager as EventsManager } from '../sdk/events/manager';
import {
    computeLocalFileSha1,
    downloadDriveNodeToLocal,
    ensureRemoteFolder,
    isUnsupportedRemoteNode,
    listFolderChildren,
    uploadLocalFileToDrive,
} from '../sdk/fileOps';
import { getName } from '../sdk/node';
import { AvailabilityPolicy } from './availability';
import { PIN_ROOT_ON_FIRST_SYNC } from './availabilityMigration';
import { createLocalConflictCopy } from './conflictResolver';
import { LocalFolderWatcher, matchesIgnorePatterns } from './localWatcher';
import { entryFromNode, RemoteIndex, type RemoteIndexEntry } from './remoteIndex';
import type { ConflictRecord, SyncedItemRecord, SyncSettings, SyncStateDatabase } from './syncStateDb';

export interface ActiveTransfer {
    id: string;
    direction: 'upload' | 'download';
    relPath: string;
    bytesTransferred: number;
    totalBytes: number;
    startedAt: number;
}

export type EngineState = 'idle' | 'syncing' | 'paused' | 'unauthenticated' | 'error';

export class ProtonDriveSyncEngine {
    private state: EngineState = 'idle';
    private currentAction: string | null = null;
    private lastSyncAt: number | null = null;
    private lastError: string | null = null;
    private rootNode: NodeEntity | null = null;
    private activeTransfers = new Map<string, ActiveTransfer>();
    private watcher: LocalFolderWatcher;
    private unsubscribeDriveEvents: (() => void) | null = null;
    private reconcileRunning = false;
    private reconcileQueued = false;
    private syncingFolders = new Set<string>();
    private localQueue = new Map<string, Promise<void>>();
    // Availability changes that remove local copies run one at a time on this chain, and local change handling waits
    // for them: a deletion seen while the records still exist would read as the user deleting synced files.
    private availabilityRun: Promise<void> = Promise.resolve();
    private readonly index: RemoteIndex;
    private readonly policy: AvailabilityPolicy;

    constructor(
        private readonly sdk: ProtonDriveClient,
        private readonly eventsManager: EventsManager,
        private readonly auth: { isLoggedIn(): boolean },
        private readonly stateDb: SyncStateDatabase,
        private readonly logger: Logger,
    ) {
        this.index = new RemoteIndex(this.stateDb.connection);
        this.policy = new AvailabilityPolicy(this.stateDb.connection, this.index);
        this.watcher = new LocalFolderWatcher(
            () => this.stateDb.getSettings().syncDir,
            (relPath) =>
                matchesIgnorePatterns(relPath, this.stateDb.getSettings().ignorePatterns) ||
                this.policy.hiddenBy(relPath) !== null,
            async (ev) => {
                await this.handleLocalFileChange(ev.relPath);
            },
        );
    }

    getStatus() {
        const settings = this.stateDb.getSettings();
        const stats = this.stateDb.getSummaryStats();
        const loggedIn = this.auth.isLoggedIn();
        return {
            state: !loggedIn
                ? ('unauthenticated' as EngineState)
                : settings.paused
                  ? ('paused' as EngineState)
                  : this.syncingFolders.size > 0
                    ? ('syncing' as EngineState)
                    : this.state,
            currentAction: this.currentAction,
            loggedIn,
            syncDir: settings.syncDir,
            lastSyncAt: this.lastSyncAt,
            lastError: this.lastError,
            activeTransfers: Array.from(this.activeTransfers.values()),
            syncingFolders: Array.from(this.syncingFolders),
            stats,
            settings,
        };
    }

    async start(options: { backgroundInitialReconcile?: boolean } = {}): Promise<void> {
        const settings = this.stateDb.getSettings();
        await mkdir(settings.syncDir, { recursive: true });

        if (!this.auth.isLoggedIn()) {
            this.state = 'unauthenticated';
            return;
        }

        if (!this.unsubscribeDriveEvents) {
            this.unsubscribeDriveEvents = this.eventsManager.addEventListener(async (context, event) => {
                if (context === 'drive') {
                    await this.handleRemoteDriveEvent(event);
                }
            });
        }

        await this.watcher.start();
        void this.eventsManager.startSubscriptions?.()?.catch((err) => {
            this.logger.warn(`Failed starting event subscriptions: ${err}`);
        });

        if (!settings.paused) {
            if (options.backgroundInitialReconcile) {
                void this.reconcileNow();
            } else {
                await this.reconcileNow();
            }
        } else {
            this.state = 'paused';
        }
    }

    async stop(): Promise<void> {
        this.watcher.stop();
        if (this.unsubscribeDriveEvents) {
            this.unsubscribeDriveEvents();
            this.unsubscribeDriveEvents = null;
        }
        this.state = 'idle';
    }

    async setPaused(paused: boolean): Promise<void> {
        this.stateDb.updateSettings({ paused });
        if (paused) {
            this.state = 'paused';
            this.stateDb.logActivity({
                action: 'sync',
                localRelPath: '/',
                details: 'Synchronization paused by user',
            });
        } else {
            this.state = 'idle';
            this.stateDb.logActivity({
                action: 'sync',
                localRelPath: '/',
                details: 'Synchronization resumed by user',
            });
            await this.reconcileNow();
        }
    }

    async relocateSyncFolder(oldSyncDir: string, newSyncDirRaw: string): Promise<string> {
        const home = os.homedir();
        const expanded = newSyncDirRaw.startsWith('~/')
            ? path.join(home, newSyncDirRaw.slice(2))
            : newSyncDirRaw === '~'
              ? home
              : newSyncDirRaw;
        const resolvedNew = path.resolve(expanded);
        const resolvedOld = path.resolve(oldSyncDir);

        if (resolvedNew === '/' || resolvedNew === home) {
            throw new Error('Cannot use root (/) or home (~) directory directly as the Proton Drive sync folder.');
        }

        if (resolvedNew === resolvedOld) {
            return resolvedNew;
        }

        // Stop watcher on old directory before moving files so we never interpret relocation as local deletion
        this.watcher.stop();
        await mkdir(resolvedNew, { recursive: true });

        // Move existing synced files/folders from oldSyncDir -> newSyncDir (instant rename on same filesystem, or copy+rm across disks)
        const oldEntries = await readdir(resolvedOld).catch(() => [] as string[]);
        for (const entryName of oldEntries) {
            const srcPath = path.join(resolvedOld, entryName);
            const destPath = path.join(resolvedNew, entryName);
            if (srcPath === resolvedNew || resolvedNew.startsWith(`${srcPath}${path.sep}`)) {
                continue;
            }
            try {
                await rename(srcPath, destPath);
            } catch {
                try {
                    await cp(srcPath, destPath, { recursive: true, force: true });
                    await rm(srcPath, { recursive: true, force: true });
                } catch (err) {
                    this.logger.warn(`Failed relocating ${srcPath} -> ${destPath}: ${String(err)}`);
                }
            }
        }

        // Persist the normalized new syncDir in SQLite
        this.stateDb.updateSettings({ syncDir: resolvedNew });

        // Safety check: any DB record whose file is not present in resolvedNew must have its DB record cleared
        // so reconcileSinglePath downloads it from Proton Drive rather than treating it as locally deleted!
        for (const item of this.stateDb.getAllItems()) {
            const targetPath = path.join(resolvedNew, item.localRelPath);
            const st = await stat(targetPath).catch(() => null);
            if (!st) {
                this.stateDb.removeItemByPath(item.localRelPath);
            }
        }

        this.stateDb.logActivity({
            action: 'sync',
            localRelPath: '/',
            details: `Relocated local sync folder from ${resolvedOld} to ${resolvedNew}`,
        });

        await this.watcher.start();
        return resolvedNew;
    }

    // Whether a local file is exactly what Proton Drive holds, so removing its local copy loses nothing.
    private async isUnchangedSyncedCopy(
        relPath: string,
        fullPath: string,
        st: { size: number; mtimeMs: number },
    ): Promise<boolean> {
        const record = this.stateDb.getItemByPath(relPath);
        if (!record || record.type !== 'file' || record.syncStatus !== 'synced' || !record.remoteSha1) {
            return false;
        }
        if (
            st.size === record.size &&
            Math.abs(st.mtimeMs - record.localMtimeMs) < 10 &&
            record.localSha1 === record.remoteSha1
        ) {
            return true;
        }
        return (await computeLocalFileSha1(fullPath).catch(() => null)) === record.remoteSha1;
    }

    markFoldersSyncing(folderNames: string[]): void {
        for (const name of folderNames) {
            const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
            if (trimmed) {
                this.syncingFolders.add(trimmed);
            }
        }
        if (this.syncingFolders.size > 0 && this.auth.isLoggedIn() && !this.stateDb.getSettings().paused) {
            this.state = 'syncing';
        }
    }

    async reconcileNow(): Promise<void> {
        if (!this.auth.isLoggedIn()) {
            this.state = 'unauthenticated';
            return;
        }
        const settings = this.stateDb.getSettings();
        if (settings.paused) {
            this.state = 'paused';
            return;
        }
        if (this.reconcileRunning) {
            this.reconcileQueued = true;
            return;
        }

        this.reconcileRunning = true;
        this.state = 'syncing';
        this.currentAction = 'Starting sync...';
        this.lastError = null;

        try {
            await mkdir(settings.syncDir, { recursive: true });
            const root = await this.getRootFolder();
            await this.eventsManager.subscribeDriveScope(root.treeEventScopeId);
            this.index.setRoot(root.uid);
            if (this.stateDb.getMeta(PIN_ROOT_ON_FIRST_SYNC) === '1') {
                // A fresh install syncs everything, as before
                this.stateDb.connection.transaction(() => {
                    this.policy.setPin(root.uid, 'pinned', false);
                    this.stateDb.deleteMeta(PIN_ROOT_ON_FIRST_SYNC);
                })();
            }

            // Sync folder-by-folder incrementally so files & folders appear in ~/ProtonDrive
            // and in the GUI dashboard immediately instead of waiting for a full tree scan.
            const remoteMap = new Map<string, NodeEntity>();
            await this.reconcileDirectoryIncremental(root, '', remoteMap, this.stateDb.getSettings());

            this.lastSyncAt = Date.now();
            if (this.syncingFolders.size === 0) {
                this.currentAction = null;
                this.state = this.stateDb.getSettings().paused ? 'paused' : 'idle';
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.lastError = msg;
            this.currentAction = null;
            this.state = 'error';
            this.logger.error('Reconcile failed', error);
            this.stateDb.logActivity({
                action: 'error',
                localRelPath: '/',
                details: `Sync error: ${msg}`,
            });
        } finally {
            this.reconcileRunning = false;
            if (this.reconcileQueued) {
                this.reconcileQueued = false;
                void this.reconcileNow();
            }
        }
    }

    private async reconcileSinglePath(
        relPath: string,
        remoteNode: NodeEntity | undefined,
        localInfo: { isDirectory: boolean; size: number; mtimeMs: number } | undefined,
        dbRecord: SyncedItemRecord | undefined,
        remoteMap: Map<string, NodeEntity>,
        settings: SyncSettings,
    ): Promise<void> {
        const localFullPath = path.join(settings.syncDir, relPath);
        if (this.policy.hiddenBy(relPath)) {
            return; // Hidden (or being hidden): never downloaded, uploaded or trashed from here
        }

        // Case 1: Present remotely, not present locally
        if (remoteNode && !localInfo) {
            if (dbRecord) {
                // Was previously synced, so user deleted it locally -> trash remotely. Look again first: the listing
                // can predate the record being dropped (e.g. by Free up space or Hide) or the item coming back; either
                // way the next pass, with a fresh listing, deals with it.
                const stillTracked = this.stateDb.getItemByPath(relPath) !== null;
                const backLocally = await stat(localFullPath).then(
                    () => true,
                    () => false,
                );
                if (stillTracked && !backLocally) {
                    await this.trashForDeletedLocal(relPath, remoteNode);
                }
                return;
            }
            // New remote item: it comes to this computer only when pinned, and a folder also to hold something pinned
            // further down (it stays online-only itself). Hidden items never get here (checked above, as isPinned can
            // be true below a hidden folder).
            if (remoteNode.type === NodeType.Folder) {
                if (!this.policy.isPinned(relPath) && !this.policy.hasPinnedBelow(relPath)) {
                    return;
                }
                this.watcher.suppressPath(relPath);
                await mkdir(localFullPath, { recursive: true });
                const st = await stat(localFullPath);
                this.stateDb.upsertItem({
                    localRelPath: relPath,
                    nodeUid: remoteNode.uid,
                    parentNodeUid: remoteNode.parentUid ?? null,
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: st.mtimeMs,
                    remoteMtimeMs: remoteNode.modificationTime.getTime(),
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                });
                this.stateDb.logActivity({
                    action: 'mkdir',
                    localRelPath: relPath,
                    details: 'Created local folder from Proton Drive',
                });
            } else if (
                remoteNode.type === NodeType.File &&
                !isUnsupportedRemoteNode(remoteNode) &&
                this.policy.isPinned(relPath)
            ) {
                await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath);
            }
            return;
        }

        // Case 2: Present locally, not present remotely
        if (localInfo && !remoteNode) {
            if (dbRecord) {
                // Was previously synced, so it was deleted/trashed on Proton Drive -> remove locally
                this.watcher.suppressPath(relPath);
                await rm(localFullPath, { recursive: true, force: true });
                this.stateDb.removeItemByPath(relPath);
                this.stateDb.logActivity({
                    action: 'delete-local',
                    localRelPath: relPath,
                    details: 'Removed local item after remote deletion on Proton Drive',
                });
                return;
            }
            // New local item -> upload/create on Proton Drive
            const parentNode = await this.ensureParentFolderNode(relPath, remoteMap);
            if (localInfo.isDirectory) {
                const createdFolder = await ensureRemoteFolder(this.sdk, parentNode, path.basename(relPath));
                remoteMap.set(relPath, createdFolder);
                this.stateDb.upsertItem({
                    localRelPath: relPath,
                    nodeUid: createdFolder.uid,
                    parentNodeUid: createdFolder.parentUid ?? parentNode.uid,
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: localInfo.mtimeMs,
                    remoteMtimeMs: createdFolder.modificationTime.getTime(),
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                });
                this.stateDb.logActivity({
                    action: 'mkdir',
                    localRelPath: relPath,
                    details: 'Created folder on Proton Drive',
                });
            } else {
                await this.uploadLocalToRemote(relPath, localFullPath, parentNode);
            }
            return;
        }

        // Case 3: Deleted both locally and remotely, cleanup stale DB record
        if (!localInfo && !remoteNode && dbRecord) {
            this.stateDb.removeItemByPath(relPath);
            return;
        }

        // Case 4: Present both locally and remotely
        if (localInfo && remoteNode) {
            if (localInfo.isDirectory && remoteNode.type === NodeType.Folder) {
                if (!dbRecord) {
                    this.stateDb.upsertItem({
                        localRelPath: relPath,
                        nodeUid: remoteNode.uid,
                        parentNodeUid: remoteNode.parentUid ?? null,
                        type: 'folder',
                        localSha1: null,
                        remoteSha1: null,
                        localMtimeMs: localInfo.mtimeMs,
                        remoteMtimeMs: remoteNode.modificationTime.getTime(),
                        size: 0,
                        syncStatus: 'synced',
                        lastError: null,
                    });
                }
                return;
            }

            if (!localInfo.isDirectory && remoteNode.type === NodeType.File) {
                if (isUnsupportedRemoteNode(remoteNode)) {
                    return;
                }
                const remoteSha1 = remoteNode.activeRevision?.claimedDigests?.sha1 ?? null;
                const remoteMtimeMs = (
                    remoteNode.activeRevision?.claimedModificationTime ?? remoteNode.modificationTime
                ).getTime();

                // Fast path: if mtime & size match DB record and remoteSha1 matches DB record, no SHA1 recomputation needed
                if (
                    dbRecord &&
                    dbRecord.syncStatus === 'synced' &&
                    Math.abs(localInfo.mtimeMs - dbRecord.localMtimeMs) < 10 &&
                    localInfo.size === dbRecord.size &&
                    remoteSha1 === dbRecord.remoteSha1
                ) {
                    return;
                }

                const localSha1 = await computeLocalFileSha1(localFullPath);
                if (remoteSha1 && localSha1 === remoteSha1) {
                    this.stateDb.upsertItem({
                        localRelPath: relPath,
                        nodeUid: remoteNode.uid,
                        parentNodeUid: remoteNode.parentUid ?? null,
                        type: 'file',
                        localSha1,
                        remoteSha1,
                        localMtimeMs: localInfo.mtimeMs,
                        remoteMtimeMs,
                        size: localInfo.size,
                        syncStatus: 'synced',
                        lastError: null,
                    });
                    return;
                }

                const localChangedSinceSync = !dbRecord || localSha1 !== dbRecord.localSha1;
                const remoteChangedSinceSync = !dbRecord || remoteSha1 !== dbRecord.remoteSha1;

                if (localChangedSinceSync && !remoteChangedSinceSync) {
                    const parentNode = await this.ensureParentFolderNode(relPath, remoteMap);
                    await this.uploadLocalToRemote(relPath, localFullPath, parentNode, remoteNode.uid);
                } else if (!localChangedSinceSync && remoteChangedSinceSync) {
                    await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath);
                } else if (localChangedSinceSync && remoteChangedSinceSync) {
                    await this.handleFileConflict(
                        relPath,
                        localFullPath,
                        remoteNode,
                        localSha1,
                        remoteSha1,
                        localInfo.mtimeMs,
                        remoteMtimeMs,
                        remoteMap,
                        settings,
                    );
                }
            }
        }
    }

    private async handleFileConflict(
        relPath: string,
        localFullPath: string,
        remoteNode: NodeEntity,
        localSha1: string,
        remoteSha1: string | null,
        localMtimeMs: number,
        remoteMtimeMs: number,
        remoteMap: Map<string, NodeEntity>,
        settings: SyncSettings,
    ): Promise<void> {
        const strategy = settings.conflictStrategy;
        sendDesktopNotification({
            title: 'Proton Drive Sync Conflict',
            body: `Conflict detected on ${relPath} (strategy: ${strategy})`,
            urgency: 'normal',
            enabled: settings.notificationsEnabled,
        });

        if (strategy === 'prompt') {
            this.stateDb.setItemStatus(relPath, 'conflict', 'Both local and remote files were modified');
            this.stateDb.recordConflict({
                localRelPath: relPath,
                nodeUid: remoteNode.uid,
                localSha1,
                remoteSha1,
                localMtimeMs,
                remoteMtimeMs,
                resolved: false,
            });
            this.stateDb.logActivity({
                action: 'conflict',
                localRelPath: relPath,
                details: 'Conflict queued for manual resolution',
            });
            return;
        }

        if (strategy === 'keep-local') {
            const parentNode = await this.ensureParentFolderNode(relPath, remoteMap);
            await this.uploadLocalToRemote(relPath, localFullPath, parentNode, remoteNode.uid);
            this.stateDb.recordConflict({
                localRelPath: relPath,
                nodeUid: remoteNode.uid,
                localSha1,
                remoteSha1,
                localMtimeMs,
                remoteMtimeMs,
                resolved: true,
                resolution: 'keep-local',
            });
            return;
        }

        if (strategy === 'keep-remote') {
            await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath);
            this.stateDb.recordConflict({
                localRelPath: relPath,
                nodeUid: remoteNode.uid,
                localSha1,
                remoteSha1,
                localMtimeMs,
                remoteMtimeMs,
                resolved: true,
                resolution: 'keep-remote',
            });
            return;
        }

        // Default: keep-both
        const conflictCopyFullPath = await createLocalConflictCopy(localFullPath);
        const conflictCopyRelPath = path.relative(settings.syncDir, conflictCopyFullPath).split(path.sep).join('/');
        await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath);

        const parentNode = await this.ensureParentFolderNode(conflictCopyRelPath, remoteMap);
        await this.uploadLocalToRemote(conflictCopyRelPath, conflictCopyFullPath, parentNode);

        this.stateDb.recordConflict({
            localRelPath: relPath,
            nodeUid: remoteNode.uid,
            localSha1,
            remoteSha1,
            localMtimeMs,
            remoteMtimeMs,
            resolved: true,
            resolution: 'keep-both',
            conflictCopyPath: conflictCopyRelPath,
        });
        this.stateDb.logActivity({
            action: 'conflict',
            localRelPath: relPath,
            details: `Resolved conflict with keep-both: saved ${conflictCopyRelPath}`,
        });
    }

    async resolveConflictManually(
        conflictId: number,
        choice: 'keep-both' | 'keep-local' | 'keep-remote',
    ): Promise<ConflictRecord> {
        const conflict = this.stateDb.getConflictById(conflictId);
        if (!conflict) {
            throw new Error(`Conflict #${conflictId} not found`);
        }
        const settings = this.stateDb.getSettings();
        const localFullPath = path.join(settings.syncDir, conflict.localRelPath);
        const remoteNode = await this.sdk.getNode(conflict.nodeUid);
        const remoteMap = new Map<string, NodeEntity>();

        if (choice === 'keep-local') {
            const parentNode = await this.ensureParentFolderNode(conflict.localRelPath, remoteMap);
            await this.uploadLocalToRemote(conflict.localRelPath, localFullPath, parentNode, remoteNode.uid);
            this.stateDb.markConflictResolved(conflictId, 'keep-local');
        } else if (choice === 'keep-remote') {
            await this.downloadRemoteToLocal(conflict.localRelPath, remoteNode, localFullPath);
            this.stateDb.markConflictResolved(conflictId, 'keep-remote');
        } else {
            const conflictCopyFullPath = await createLocalConflictCopy(localFullPath);
            const conflictCopyRelPath = path
                .relative(settings.syncDir, conflictCopyFullPath)
                .split(path.sep)
                .join('/');
            await this.downloadRemoteToLocal(conflict.localRelPath, remoteNode, localFullPath);
            const parentNode = await this.ensureParentFolderNode(conflictCopyRelPath, remoteMap);
            await this.uploadLocalToRemote(conflictCopyRelPath, conflictCopyFullPath, parentNode);
            this.stateDb.markConflictResolved(conflictId, 'keep-both', conflictCopyRelPath);
        }

        return this.stateDb.getConflictById(conflictId)!;
    }

    private async downloadRemoteToLocal(
        relPath: string,
        remoteNode: NodeEntity,
        localFullPath: string,
    ): Promise<void> {
        const transferId = `dl:${relPath}`;
        this.watcher.suppressPath(relPath, 10000);
        this.activeTransfers.set(transferId, {
            id: transferId,
            direction: 'download',
            relPath,
            bytesTransferred: 0,
            totalBytes: remoteNode.activeRevision?.claimedSize ?? 0,
            startedAt: Date.now(),
        });

        try {
            const result = await downloadDriveNodeToLocal({
                sdk: this.sdk,
                logger: this.logger,
                remoteNode,
                localPath: localFullPath,
                onProgress: (downloadedBytes, totalBytes) => {
                    const current = this.activeTransfers.get(transferId);
                    if (current) {
                        current.bytesTransferred = downloadedBytes;
                        current.totalBytes = totalBytes;
                    }
                },
            });

            if (result.status === 'downloaded' || result.status === 'skipped-identical') {
                const remoteMtimeMs = (
                    remoteNode.activeRevision?.claimedModificationTime ?? remoteNode.modificationTime
                ).getTime();
                this.stateDb.upsertItem({
                    localRelPath: relPath,
                    nodeUid: remoteNode.uid,
                    parentNodeUid: remoteNode.parentUid ?? null,
                    type: 'file',
                    localSha1: result.sha1 ?? null,
                    remoteSha1: remoteNode.activeRevision?.claimedDigests?.sha1 ?? result.sha1 ?? null,
                    localMtimeMs: result.mtimeMs,
                    remoteMtimeMs,
                    size: result.size,
                    syncStatus: 'synced',
                    lastError: null,
                });

                if (result.status === 'downloaded') {
                    this.stateDb.logActivity({
                        action: 'download',
                        localRelPath: relPath,
                        details: `Downloaded from Proton Drive (${formatBytes(result.size)})`,
                        bytesTransferred: result.size,
                    });
                }
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.stateDb.setItemStatus(relPath, 'error', msg);
            this.stateDb.logActivity({
                action: 'error',
                localRelPath: relPath,
                details: `Download failed: ${msg}`,
            });
            throw error;
        } finally {
            this.activeTransfers.delete(transferId);
            this.watcher.suppressPath(relPath, 2500);
        }
    }

    private async uploadLocalToRemote(
        relPath: string,
        localFullPath: string,
        parentNode: NodeEntity,
        existingNodeUid?: string,
    ): Promise<void> {
        const transferId = `ul:${relPath}`;
        const st = await stat(localFullPath);
        this.activeTransfers.set(transferId, {
            id: transferId,
            direction: 'upload',
            relPath,
            bytesTransferred: 0,
            totalBytes: st.size,
            startedAt: Date.now(),
        });

        try {
            const result = await uploadLocalFileToDrive({
                sdk: this.sdk,
                logger: this.logger,
                parentNode,
                localPath: localFullPath,
                remoteName: path.basename(relPath),
                existingNodeUid,
                collisionMode: 'new-revision',
                onProgress: (uploadedBytes, totalBytes) => {
                    const current = this.activeTransfers.get(transferId);
                    if (current) {
                        current.bytesTransferred = uploadedBytes;
                        current.totalBytes = totalBytes;
                    }
                },
            });

            if (result.nodeUid) {
                this.stateDb.upsertItem({
                    localRelPath: relPath,
                    nodeUid: result.nodeUid,
                    parentNodeUid: parentNode.uid,
                    type: 'file',
                    localSha1: result.sha1,
                    remoteSha1: result.sha1,
                    localMtimeMs: result.mtimeMs,
                    remoteMtimeMs: Date.now(),
                    size: result.size,
                    syncStatus: 'synced',
                    lastError: null,
                });
            }

            if (result.status === 'uploaded' || result.status === 'updated-revision') {
                this.stateDb.logActivity({
                    action: 'upload',
                    localRelPath: relPath,
                    details: `${result.status === 'updated-revision' ? 'Updated revision' : 'Uploaded'} to Proton Drive (${formatBytes(result.size)})`,
                    bytesTransferred: result.size,
                });
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.stateDb.setItemStatus(relPath, 'error', msg);
            this.stateDb.logActivity({
                action: 'error',
                localRelPath: relPath,
                details: `Upload failed: ${msg}`,
            });
            throw error;
        } finally {
            this.activeTransfers.delete(transferId);
        }
    }

    private async trashRemoteNodeForDeletedLocal(relPath: string, remoteNode: NodeEntity): Promise<void> {
        try {
            for await (const res of this.sdk.trashNodes([remoteNode])) {
                if (!res.ok) {
                    throw res.error;
                }
            }
            this.stateDb.removeItemByPath(relPath);
            this.stateDb.logActivity({
                action: 'trash-remote',
                localRelPath: relPath,
                details: 'Moved remote item to Proton Drive Trash after local deletion',
            });
            this.index.removeSubtree(remoteNode.uid);
        } catch (error: unknown) {
            this.logger.warn(`Failed to trash remote node for ${relPath}: ${error}`);
        }
    }

    // The user deleted a synced item locally, so its cloud copy goes to the Proton Drive trash. A folder can also hold
    // things that never were on this computer: online-only, ignored or hidden items, Proton Docs and Sheets, or a node
    // that replaced the one synced here. Those stay in the cloud: only the items that had local copies are trashed, and
    // the folder is left online-only.
    private async trashForDeletedLocal(relPath: string, remoteNode: NodeEntity): Promise<void> {
        if (remoteNode.type !== NodeType.Folder) {
            // Checked here too, as callers may have waited on the network since: the record is still there and the
            // file still missing
            if (this.stateDb.getItemByPath(relPath) && !(await this.existsLocally(relPath))) {
                await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
            }
            return;
        }
        // Decide from what the cloud holds right now; without the whole picture, trash nothing this time
        const holdsDocs = new Set<string>(); // folders holding Proton Docs or Sheets, which the index leaves out
        if (!(await this.indexRemoteSubtree(remoteNode, relPath, holdsDocs))) {
            this.logger.warn(`Not trashing ${relPath} yet: could not list everything in it`);
            return;
        }
        const entries = this.index.listSubtree(relPath);
        const syncedUid = new Map(this.stateDb.getItemsUnder(relPath).map((item) => [item.localRelPath, item.nodeUid]));
        const hidden = this.policy.hiddenWithin(relPath);
        const isWithin = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
        // Everything that never was on this computer, with every folder above it up to the deleted one
        const holdsCloudOnly = new Set<string>();
        const markWithAncestors = (from: string) => {
            let p = from;
            while (!holdsCloudOnly.has(p)) {
                holdsCloudOnly.add(p);
                const slash = p.lastIndexOf('/');
                if (p === relPath || slash === -1) {
                    break;
                }
                p = p.slice(0, slash);
            }
        };
        for (const entry of entries) {
            if (syncedUid.get(entry.relPath) !== entry.uid || hidden.some((h) => isWithin(entry.relPath, h))) {
                markWithAncestors(entry.relPath);
            }
        }
        for (const folder of holdsDocs) {
            markWithAncestors(folder);
        }
        if (!holdsCloudOnly.has(relPath)) {
            // Look again, as listing took a while: only while the record is still there and the folder still missing
            if (this.stateDb.getItemByPath(relPath)?.nodeUid === remoteNode.uid && !(await this.existsLocally(relPath))) {
                await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
            }
            return;
        }

        // The topmost items that had local copies, along with everything in them (parents come before children)
        const trashRoots: RemoteIndexEntry[] = [];
        const rootPaths = new Set<string>();
        const underARoot = (p: string) => {
            for (let slash = p.lastIndexOf('/'); slash > 0; slash = p.lastIndexOf('/', slash - 1)) {
                if (rootPaths.has(p.slice(0, slash))) {
                    return true;
                }
            }
            return false;
        };
        for (const entry of entries) {
            if (!holdsCloudOnly.has(entry.relPath) && !underARoot(entry.relPath)) {
                trashRoots.push(entry);
                rootPaths.add(entry.relPath);
            }
        }
        const resolved: Array<{ relPath: string; node: NodeEntity }> = [];
        for (const entry of trashRoots) {
            const node = await this.sdk.getNode(entry.uid).catch(() => null);
            if (node) {
                resolved.push({ relPath: entry.relPath, node });
            }
        }
        // As for any trash, and checked last: only while the record is still there and the local item still missing
        const toTrash: Array<{ relPath: string; node: NodeEntity }> = [];
        for (const item of resolved) {
            if (
                this.stateDb.getItemByPath(item.relPath)?.nodeUid === item.node.uid &&
                !(await this.existsLocally(item.relPath))
            ) {
                toTrash.push(item);
            }
        }
        if (toTrash.length > 0) {
            await this.trashRemoteNodesForDeletedLocal(toTrash);
        }
        if (await this.existsLocally(relPath)) {
            return; // Back meanwhile: the next pass syncs what is there
        }
        // Online-only from now on: no records, so nothing below reads as deleted later, and not pinned, so it isn't
        // downloaded again
        this.stateDb.removeItemByPath(relPath);
        if (this.policy.isPinned(relPath) || this.policy.hasPinnedBelow(relPath)) {
            this.policy.setPin(remoteNode.uid, 'unpinned', true);
        }
        this.stateDb.logActivity({
            action: 'sync',
            localRelPath: relPath,
            details:
                'Deleted on this computer, so only what was downloaded went to Proton Drive Trash; the folder stays in Proton Drive, online only, with the items that were never on this computer',
        });
    }

    // Several locally deleted items in one trash call; each one that went loses its records and its index entries.
    private async trashRemoteNodesForDeletedLocal(items: Array<{ relPath: string; node: NodeEntity }>): Promise<void> {
        const byUid = new Map(items.map((item) => [item.node.uid, item]));
        try {
            for await (const res of this.sdk.trashNodes(items.map((item) => item.node))) {
                const item = byUid.get(res.uid);
                if (!item) {
                    continue;
                }
                if (!res.ok) {
                    this.logger.warn(`Failed to trash remote node for ${item.relPath}: ${res.error}`);
                    continue;
                }
                this.stateDb.removeItemByPath(item.relPath);
                this.stateDb.logActivity({
                    action: 'trash-remote',
                    localRelPath: item.relPath,
                    details: 'Moved remote item to Proton Drive Trash after local deletion',
                });
                this.index.removeSubtree(res.uid);
            }
        } catch (error: unknown) {
            this.logger.warn(`Failed to trash remote nodes for ${items.map((item) => item.relPath).join(', ')}: ${error}`);
        }
    }

    private existsLocally(relPath: string): Promise<boolean> {
        return lstat(path.join(this.stateDb.getSettings().syncDir, relPath)).then(
            () => true,
            () => false,
        );
    }

    private async handleLocalFileChange(relPath: string): Promise<void> {
        if (!this.auth.isLoggedIn()) {
            return;
        }
        const settings = this.stateDb.getSettings();
        if (
            settings.paused ||
            matchesIgnorePatterns(relPath, settings.ignorePatterns) ||
            this.policy.hiddenBy(relPath) !== null
        ) {
            return;
        }

        await this.availabilityRun;
        const existingTask = this.localQueue.get(relPath);
        if (existingTask) {
            await existingTask.catch(() => {});
        }

        const task = (async () => {
            const fullPath = path.join(settings.syncDir, relPath);
            const st = await stat(fullPath).catch(() => null);
            const dbRecord = this.stateDb.getItemByPath(relPath);

            if (!st) {
                // Local item was deleted
                if (dbRecord) {
                    try {
                        const remoteNode = await this.sdk.getNode(dbRecord.nodeUid);
                        await this.trashForDeletedLocal(relPath, remoteNode);
                    } catch {
                        this.stateDb.removeItemByPath(relPath);
                    }
                }
                return;
            }

            const remoteMap = new Map<string, NodeEntity>();
            const parentNode = await this.ensureParentFolderNode(relPath, remoteMap);

            if (st.isDirectory()) {
                const folder = await ensureRemoteFolder(this.sdk, parentNode, path.basename(relPath));
                this.stateDb.upsertItem({
                    localRelPath: relPath,
                    nodeUid: folder.uid,
                    parentNodeUid: parentNode.uid,
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: st.mtimeMs,
                    remoteMtimeMs: folder.modificationTime.getTime(),
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                });
            } else if (st.isFile()) {
                await this.uploadLocalToRemote(relPath, fullPath, parentNode, dbRecord?.nodeUid);
            }
        })();

        this.localQueue.set(relPath, task);
        try {
            await task;
        } finally {
            this.localQueue.delete(relPath);
        }
    }

    private async handleRemoteDriveEvent(event: DriveEvent): Promise<void> {
        const settings = this.stateDb.getSettings();
        if (settings.paused || !this.auth.isLoggedIn()) {
            return;
        }

        if (
            event.type === DriveEventType.TreeRefresh ||
            event.type === DriveEventType.FastForward ||
            event.type === DriveEventType.SharedWithMeUpdated
        ) {
            await this.reconcileNow();
            return;
        }

        if (event.type === DriveEventType.NodeDeleted) {
            this.index.removeSubtree(event.nodeUid);
            const tracked = this.stateDb.getItemByNodeUid(event.nodeUid);
            if (tracked) {
                const localFullPath = path.join(settings.syncDir, tracked.localRelPath);
                this.watcher.suppressPath(tracked.localRelPath);
                await rm(localFullPath, { recursive: true, force: true }).catch(() => {});
                this.stateDb.removeItemByNodeUid(event.nodeUid);
                this.stateDb.logActivity({
                    action: 'delete-local',
                    localRelPath: tracked.localRelPath,
                    details: 'Removed local item via real-time Proton Drive event',
                });
            }
            return;
        }

        if (event.type === DriveEventType.NodeCreated || event.type === DriveEventType.NodeUpdated) {
            if (event.isTrashed) {
                this.index.removeSubtree(event.nodeUid);
                const tracked = this.stateDb.getItemByNodeUid(event.nodeUid);
                if (tracked) {
                    const localFullPath = path.join(settings.syncDir, tracked.localRelPath);
                    this.watcher.suppressPath(tracked.localRelPath);
                    await rm(localFullPath, { recursive: true, force: true }).catch(() => {});
                    this.stateDb.removeItemByNodeUid(event.nodeUid);
                    this.stateDb.logActivity({
                        action: 'delete-local',
                        localRelPath: tracked.localRelPath,
                        details: 'Removed local item after remote move to Trash',
                    });
                }
                return;
            }

            // Trigger incremental reconcile
            await this.reconcileNow();
        }
    }

    get remoteIndex(): RemoteIndex {
        return this.index;
    }

    get availability(): AvailabilityPolicy {
        return this.policy;
    }

    private async getRootFolder(): Promise<NodeEntity> {
        if (!this.rootNode) {
            this.rootNode = await this.sdk.getMyFilesRootFolder();
        }
        return this.rootNode;
    }

    private async ensureParentFolderNode(relPath: string, remoteMap: Map<string, NodeEntity>): Promise<NodeEntity> {
        const dirRel = path.posix.dirname(relPath);
        const root = await this.getRootFolder();
        if (!dirRel || dirRel === '.') {
            return root;
        }

        const cached = remoteMap.get(dirRel);
        if (cached) {
            return cached;
        }

        const dbItem = this.stateDb.getItemByPath(dirRel);
        if (dbItem && dbItem.type === 'folder') {
            try {
                const existing = await this.sdk.getNode(dbItem.nodeUid);
                remoteMap.set(dirRel, existing);
                return existing;
            } catch {}
        }

        const segments = dirRel.split('/').filter(Boolean);
        let currentParent = root;
        let currentRel = '';

        for (const seg of segments) {
            currentRel = currentRel ? `${currentRel}/${seg}` : seg;
            const foundInMap = remoteMap.get(currentRel);
            if (foundInMap) {
                currentParent = foundInMap;
                continue;
            }
            const ensured = await ensureRemoteFolder(this.sdk, currentParent, seg);
            remoteMap.set(currentRel, ensured);
            currentParent = ensured;
        }

        return currentParent;
    }

    private indexEntries(children: NodeEntity[], parentRelPath: string) {
        return children.flatMap((child) => {
            const entry = entryFromNode(child, parentRelPath);
            return entry ? [entry] : [];
        });
    }

    // The index is a cache: a listing is written only for a folder the index still holds at that path (so no orphan rows),
    // and a failed write is logged without aborting the sync.
    private recordListing(folder: NodeEntity, relPath: string, children: NodeEntity[]): boolean {
        try {
            if (relPath !== '' && this.index.getByUid(folder.uid)?.relPath !== relPath) {
                return false;
            }
            this.index.replaceChildren(folder.uid, relPath, this.indexEntries(children, relPath));
            return true;
        } catch (error: unknown) {
            this.logger.warn(`Failed to update the remote index for ${relPath || '/'}: ${error}`);
            return false;
        }
    }

    // Lists and records a remote folder's subtree in the index without touching disk or sync state. Returns whether the
    // whole subtree was recorded: false when paused, when the folder is not indexed at relPath, or when a listing failed
    // (that is logged, and the rest is still crawled). Nothing is listed below a hidden folder. The index leaves out
    // Proton Docs and Sheets, so the folders whose listing holds one are added to `unsupportedIn` when given.
    private async indexRemoteSubtree(node: NodeEntity, relPath: string, unsupportedIn?: Set<string>): Promise<boolean> {
        if (this.stateDb.getSettings().paused || this.index.getByUid(node.uid)?.relPath !== relPath) {
            return false;
        }
        if (this.policy.hiddenBy(relPath)) {
            return true;
        }
        let children: NodeEntity[];
        try {
            children = await listFolderChildren(this.sdk, node);
        } catch (error: unknown) {
            this.logger.warn(`Could not list ${relPath} for the remote index: ${error}`);
            return false;
        }
        if (!this.recordListing(node, relPath, children)) {
            return false;
        }
        if (unsupportedIn && children.some((child) => entryFromNode(child, relPath) === null)) {
            unsupportedIn.add(relPath);
        }
        let complete = true;
        for (const child of children) {
            if (child.type === NodeType.Folder) {
                complete = (await this.indexRemoteSubtree(child, `${relPath}/${getName(child)}`, unsupportedIn)) && complete;
            }
        }
        return complete;
    }

    private async reconcileDirectoryIncremental(
        folderNode: NodeEntity,
        prefix: string,
        remoteMap: Map<string, NodeEntity>,
        _initialSettings: SyncSettings,
    ): Promise<void> {
        const liveSettings = this.stateDb.getSettings();
        if (liveSettings.paused) {
            return;
        }
        if (prefix && (matchesIgnorePatterns(prefix, liveSettings.ignorePatterns) || this.policy.hiddenBy(prefix))) {
            return;
        }

        const localDirFullPath = prefix ? path.join(liveSettings.syncDir, prefix) : liveSettings.syncDir;
        this.watcher.suppressPath(prefix || '.');
        await mkdir(localDirFullPath, { recursive: true });

        this.currentAction = `Listing /my-files/${prefix || ''}`;
        const remoteChildren = await listFolderChildren(this.sdk, folderNode);
        // Record the whole listing (ignored children too) before any child is reconciled
        this.recordListing(folderNode, prefix, remoteChildren);
        const freshSettings = this.stateDb.getSettings();
        const remoteChildByName = new Map<string, NodeEntity>();
        for (const child of remoteChildren) {
            const name = getName(child);
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (!matchesIgnorePatterns(relPath, freshSettings.ignorePatterns)) {
                remoteChildByName.set(name, child);
                remoteMap.set(relPath, child);
            }
        }

        const localEntries = await readdir(localDirFullPath, { withFileTypes: true }).catch(() => []);
        const localChildByName = new Map<string, { isDirectory: boolean; size: number; mtimeMs: number }>();
        for (const entry of localEntries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (matchesIgnorePatterns(relPath, freshSettings.ignorePatterns)) {
                continue;
            }
            const fullPath = path.join(localDirFullPath, entry.name);
            const st = await stat(fullPath).catch(() => null);
            if (st && (st.isDirectory() || st.isFile())) {
                localChildByName.set(entry.name, {
                    isDirectory: st.isDirectory(),
                    size: st.isDirectory() ? 0 : st.size,
                    mtimeMs: st.mtimeMs,
                });
            }
        }

        // Direct children previously tracked in DB under this prefix
        const allDbItems = this.stateDb.getAllItems();
        const dbChildByName = new Map<string, SyncedItemRecord>();
        for (const item of allDbItems) {
            const itemDir = path.posix.dirname(item.localRelPath);
            const expectedDir = prefix || '.';
            if (itemDir === expectedDir) {
                if (!matchesIgnorePatterns(item.localRelPath, freshSettings.ignorePatterns)) {
                    dbChildByName.set(path.posix.basename(item.localRelPath), item);
                }
            }
        }

        const childNames = Array.from(
            new Set([...remoteChildByName.keys(), ...localChildByName.keys(), ...dbChildByName.keys()]),
        ).sort((a, b) => a.localeCompare(b));

        const subFoldersToRecurse: Array<{ node: NodeEntity; relPath: string }> = [];

        for (const name of childNames) {
            const stepSettings = this.stateDb.getSettings();
            if (stepSettings.paused) {
                return;
            }
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (matchesIgnorePatterns(relPath, stepSettings.ignorePatterns)) {
                continue;
            }
            if (this.policy.hiddenBy(relPath)) {
                continue; // Skipped entirely: not downloaded, uploaded or trashed, and its listing is not fetched
            }
            if (!prefix && this.syncingFolders.has(name)) {
                // Being synced on its own right now; avoid concurrent duplicate work
                continue;
            }

            this.currentAction = `Syncing ${relPath}`;
            const remoteChild = remoteChildByName.get(name);
            const localChild = localChildByName.get(name);
            const dbRecord = dbChildByName.get(name);

            await this.reconcileSinglePath(relPath, remoteChild, localChild, dbRecord, remoteMap, stepSettings);

            const resolvedFolderNode = remoteMap.get(relPath) ?? remoteChild;
            const localStillExists = await stat(path.join(stepSettings.syncDir, relPath))
                .then((s) => s.isDirectory())
                .catch(() => false);
            if (resolvedFolderNode && resolvedFolderNode.type === NodeType.Folder && localStillExists) {
                subFoldersToRecurse.push({ node: resolvedFolderNode, relPath });
            } else if (resolvedFolderNode && resolvedFolderNode.type === NodeType.Folder) {
                await this.indexRemoteSubtree(resolvedFolderNode, relPath);
            }
        }

        for (const sub of subFoldersToRecurse) {
            const nextSettings = this.stateDb.getSettings();
            if (nextSettings.paused) {
                return;
            }
            if (matchesIgnorePatterns(sub.relPath, nextSettings.ignorePatterns) || this.policy.hiddenBy(sub.relPath)) {
                continue;
            }
            await this.reconcileDirectoryIncremental(sub.node, sub.relPath, remoteMap, nextSettings);
        }
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}
