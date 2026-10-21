import { mkdir, readdir, rm, stat } from 'node:fs/promises';
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
import { createLocalConflictCopy } from './conflictResolver';
import { LocalFolderWatcher, matchesIgnorePatterns } from './localWatcher';
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
    private localQueue = new Map<string, Promise<void>>();

    constructor(
        private readonly sdk: ProtonDriveClient,
        private readonly eventsManager: EventsManager,
        private readonly auth: { isLoggedIn(): boolean },
        private readonly stateDb: SyncStateDatabase,
        private readonly logger: Logger,
    ) {
        this.watcher = new LocalFolderWatcher(
            () => this.stateDb.getSettings().syncDir,
            () => {
                const s = this.stateDb.getSettings();
                return { ignorePatterns: s.ignorePatterns, excludedFolders: s.excludedFolders };
            },
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
            state: !loggedIn ? ('unauthenticated' as EngineState) : settings.paused ? ('paused' as EngineState) : this.state,
            currentAction: this.currentAction,
            loggedIn,
            syncDir: settings.syncDir,
            lastSyncAt: this.lastSyncAt,
            lastError: this.lastError,
            activeTransfers: Array.from(this.activeTransfers.values()),
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

    async listRemoteTopLevelFolders(): Promise<Array<{ name: string; uid: string; excluded: boolean }>> {
        if (!this.auth.isLoggedIn()) {
            return [];
        }
        const root = await this.getRootFolder();
        const children = await listFolderChildren(this.sdk, root);
        const { excludedFolders } = this.stateDb.getSettings();

        return children
            .filter((c) => c.type === NodeType.Folder)
            .map((folder) => {
                const name = getName(folder);
                return {
                    name,
                    uid: folder.uid,
                    excluded: excludedFolders.includes(name),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
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
        this.currentAction = 'Scanning remote Proton Drive folders...';
        this.lastError = null;

        try {
            await mkdir(settings.syncDir, { recursive: true });
            const root = await this.getRootFolder();
            await this.eventsManager.subscribeDriveScope(root.treeEventScopeId);

            // Sync folder-by-folder incrementally so files & folders appear in ~/ProtonDrive
            // and in the GUI dashboard immediately instead of waiting for a full tree scan.
            const remoteMap = new Map<string, NodeEntity>();
            await this.reconcileDirectoryIncremental(root, '', remoteMap, settings);

            this.lastSyncAt = Date.now();
            this.currentAction = null;
            this.state = this.stateDb.getSettings().paused ? 'paused' : 'idle';
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

        // Case 1: Present remotely, not present locally
        if (remoteNode && !localInfo) {
            if (dbRecord) {
                // Was previously synced, so user deleted it locally -> trash remotely
                await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
                return;
            }
            // New remote item -> create locally
            if (remoteNode.type === NodeType.Folder) {
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
            } else if (remoteNode.type === NodeType.File && !isUnsupportedRemoteNode(remoteNode)) {
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
        } catch (error: unknown) {
            this.logger.warn(`Failed to trash remote node for ${relPath}: ${error}`);
        }
    }

    private async handleLocalFileChange(relPath: string): Promise<void> {
        if (!this.auth.isLoggedIn()) {
            return;
        }
        const settings = this.stateDb.getSettings();
        if (settings.paused || matchesIgnorePatterns(relPath, settings.ignorePatterns, settings.excludedFolders)) {
            return;
        }

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
                        await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
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

    private async reconcileDirectoryIncremental(
        folderNode: NodeEntity,
        prefix: string,
        remoteMap: Map<string, NodeEntity>,
        settings: SyncSettings,
    ): Promise<void> {
        if (this.stateDb.getSettings().paused) {
            return;
        }

        const localDirFullPath = prefix ? path.join(settings.syncDir, prefix) : settings.syncDir;
        this.watcher.suppressPath(prefix || '.');
        await mkdir(localDirFullPath, { recursive: true });

        this.currentAction = `Listing /my-files/${prefix || ''}`;
        const remoteChildren = await listFolderChildren(this.sdk, folderNode);
        const remoteChildByName = new Map<string, NodeEntity>();
        for (const child of remoteChildren) {
            const name = getName(child);
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (!matchesIgnorePatterns(relPath, settings.ignorePatterns, settings.excludedFolders)) {
                remoteChildByName.set(name, child);
                remoteMap.set(relPath, child);
            }
        }

        const localEntries = await readdir(localDirFullPath, { withFileTypes: true }).catch(() => []);
        const localChildByName = new Map<string, { isDirectory: boolean; size: number; mtimeMs: number }>();
        for (const entry of localEntries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (matchesIgnorePatterns(relPath, settings.ignorePatterns, settings.excludedFolders)) {
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
                dbChildByName.set(path.posix.basename(item.localRelPath), item);
            }
        }

        const childNames = Array.from(
            new Set([...remoteChildByName.keys(), ...localChildByName.keys(), ...dbChildByName.keys()]),
        ).sort((a, b) => a.localeCompare(b));

        const subFoldersToRecurse: Array<{ node: NodeEntity; relPath: string }> = [];

        for (const name of childNames) {
            if (this.stateDb.getSettings().paused) {
                return;
            }
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (matchesIgnorePatterns(relPath, settings.ignorePatterns, settings.excludedFolders)) {
                continue;
            }

            this.currentAction = `Syncing ${relPath}`;
            const remoteChild = remoteChildByName.get(name);
            const localChild = localChildByName.get(name);
            const dbRecord = dbChildByName.get(name);

            await this.reconcileSinglePath(relPath, remoteChild, localChild, dbRecord, remoteMap, settings);

            const resolvedFolderNode = remoteMap.get(relPath) ?? remoteChild;
            const localStillExists = await stat(path.join(settings.syncDir, relPath))
                .then((s) => s.isDirectory())
                .catch(() => false);
            if (resolvedFolderNode && resolvedFolderNode.type === NodeType.Folder && localStillExists) {
                subFoldersToRecurse.push({ node: resolvedFolderNode, relPath });
            }
        }

        for (const sub of subFoldersToRecurse) {
            if (this.stateDb.getSettings().paused) {
                return;
            }
            await this.reconcileDirectoryIncremental(sub.node, sub.relPath, remoteMap, settings);
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
