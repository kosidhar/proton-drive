import { cp, lstat, mkdir, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
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
import { createLocalConflictCopy } from './conflictResolver';
import { LocalFolderWatcher, matchesIgnorePatterns } from './localWatcher';
import type { ConflictRecord, SyncedItemRecord, SyncSettings, SyncStateDatabase } from './syncStateDb';

// Something in a folder that only exists on this computer, so making the folder Cloud only would lose it
interface LocalOnlyItem {
    relPath: string;
    reason: 'ignored' | 'not-a-file' | 'not-in-cloud';
}

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
    private exclusionRun: Promise<void> = Promise.resolve();
    private reportedUnsyncedCopies = new Set<string>();

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

    // Runs Cloud only removals one at a time, and lets the code that could race them (re-including a folder, local
    // change handling) wait for them: a deletion seen while the folder's records still exist reads as the user
    // deleting synced files and would trash the cloud copy.
    applySelectiveSyncExclusions(): Promise<void> {
        const run = this.exclusionRun.then(() => this.applySelectiveSyncExclusionsNow());
        this.exclusionRun = run.catch(() => {});
        return run;
    }

    private async applySelectiveSyncExclusionsNow(): Promise<void> {
        const settings = this.stateDb.getSettings();
        for (const reported of this.reportedUnsyncedCopies) {
            if (!settings.excludedFolders.includes(reported)) {
                this.reportedUnsyncedCopies.delete(reported); // Synced again; report afresh if it goes Cloud only later
            }
        }
        for (const folderName of settings.excludedFolders ?? []) {
            const trimmed = folderName.trim().replace(/^\/+|\/+$/g, '');
            // Only a single top-level name: something like '..' or 'a/b' must never select other files to delete
            if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) {
                continue;
            }
            this.syncingFolders.delete(trimmed);
            const localFolderFullPath = path.join(settings.syncDir, trimmed);
            const lst = await lstat(localFolderFullPath).catch(() => null);
            if (!lst) {
                // Records left from before the folder was Cloud only must never read as local deletions later
                this.stateDb.removeItemByPath(trimmed);
                continue;
            }
            if (lst.isSymbolicLink()) {
                // Only the link goes; whatever it points to is left alone
                this.stateDb.removeItemByPath(trimmed);
                await rm(localFolderFullPath, { force: true }).catch(() => {});
                this.logCloudOnlyRemoval(trimmed);
                continue;
            }
            if (!lst.isDirectory()) {
                continue;
            }
            if (!this.stateDb.hasItemsUnder(trimmed)) {
                // Already Cloud only, and something (an app, the user) has put a local folder back: it holds nothing
                // synced, so it is left as it is
                this.reportUnsyncedLocalCopy(trimmed, settings);
                continue;
            }

            const scan = await this.scanFolderForCloudOnly(trimmed, settings).catch((err: unknown) => {
                this.logger.warn(`Cloud only: could not check ${trimmed}, keeping it for now: ${String(err)}`);
                return null;
            });
            if (!scan || !this.stateDb.getSettings().excludedFolders.includes(folderName)) {
                continue; // Switched back to Sync while we looked
            }
            if (scan.localOnly) {
                this.refuseCloudOnly(folderName, trimmed, scan.localOnly, settings);
                continue;
            }
            if (await this.removeScannedCloudOnlyFolder(folderName, trimmed, scan.entries, settings)) {
                this.logCloudOnlyRemoval(trimmed);
            }
        }
    }

    // Walks a folder about to become Cloud only. It stops at the first item that exists only on this computer, since
    // deleting the folder would lose it. Otherwise it returns what it saw, in walk order, to delete from.
    private async scanFolderForCloudOnly(
        relDir: string,
        settings: SyncSettings,
    ): Promise<{ localOnly: LocalOnlyItem | null; entries: Array<{ relPath: string; signature: string }> }> {
        const entries: Array<{ relPath: string; signature: string }> = [];
        const walk = async (rel: string): Promise<LocalOnlyItem | null> => {
            for (const entry of await readdir(path.join(settings.syncDir, rel), { withFileTypes: true })) {
                const relPath = `${rel}/${entry.name}`;
                const fullPath = path.join(settings.syncDir, relPath);
                const st = await lstat(fullPath).catch(() => null);
                if (!st) {
                    continue; // Deleted since the listing
                }
                entries.push({ relPath, signature: treeEntrySignature(st) });
                if (st.isFile() && isEngineTempName(entry.name)) {
                    continue; // Our own in-progress download, safe to drop
                }
                if (matchesIgnorePatterns(relPath, settings.ignorePatterns, [])) {
                    return { relPath, reason: 'ignored' };
                }
                if (st.isDirectory()) {
                    const found = await walk(relPath);
                    if (found) {
                        return found;
                    }
                } else if (!st.isFile()) {
                    return { relPath, reason: 'not-a-file' };
                } else if (!(await this.isUnchangedSyncedCopy(relPath, fullPath, st))) {
                    return { relPath, reason: 'not-in-cloud' };
                }
            }
            return null;
        };
        return { localOnly: await walk(relDir), entries };
    }

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

    // Deletes a scanned folder from the bottom up, touching only what the scan saw and only while it is unchanged, so
    // anything saved into the folder meanwhile survives and stops the removal; what is left keeps its records and is
    // looked at again on the next pass. Each record goes just before its file or folder, so no deletion event can be
    // taken for the user deleting something synced. Returns whether the whole folder went.
    private async removeScannedCloudOnlyFolder(
        folderName: string,
        relDir: string,
        entries: Array<{ relPath: string; signature: string }>,
        settings: SyncSettings,
    ): Promise<boolean> {
        // Reverse walk order puts everything in a folder before the folder itself
        for (const { relPath, signature } of [...entries.reverse(), { relPath: relDir, signature: 'dir' }]) {
            if (!this.stateDb.getSettings().excludedFolders.includes(folderName)) {
                return false; // Switched back to Sync: what is left syncs normally
            }
            const fullPath = path.join(settings.syncDir, relPath);
            const st = await lstat(fullPath).catch(() => null);
            if (!st) {
                this.stateDb.removeItemByPath(relPath); // Already gone, and its folder is going Cloud only
                continue;
            }
            if (treeEntrySignature(st) !== signature) {
                return false;
            }
            this.stateDb.removeItemByPath(relPath);
            try {
                await (st.isDirectory() ? rmdir(fullPath) : unlink(fullPath));
            } catch {
                return false; // A folder that is no longer empty: something new was saved into it
            }
        }
        return true;
    }

    private refuseCloudOnly(folderName: string, relDir: string, localOnly: LocalOnlyItem, settings: SyncSettings): void {
        this.stateDb.updateSettings({
            excludedFolders: this.stateDb.getSettings().excludedFolders.filter((f) => f !== folderName),
        });
        const why = {
            ignored: 'matches an ignore pattern, so it was never uploaded',
            'not-a-file': "isn't a regular file, so it was never uploaded",
            'not-in-cloud': "isn't in Proton Drive in its current form (new, edited, or not uploaded yet)",
        }[localOnly.reason];
        const fix =
            localOnly.reason === 'not-in-cloud' ? 'Move it out of the folder or wait for it to sync' : 'Move it out of the folder';
        const message = `${relDir} stays on this computer: ${localOnly.relPath} ${why}, and making the folder Cloud only would delete it. ${fix}, then try again.`;
        this.stateDb.logActivity({ action: 'error', localRelPath: relDir, details: message });
        sendDesktopNotification({
            title: 'Proton Drive: folder kept on this computer',
            body: message,
            urgency: 'normal',
            enabled: settings.notificationsEnabled,
        });
    }

    private reportUnsyncedLocalCopy(relDir: string, settings: SyncSettings): void {
        if (this.reportedUnsyncedCopies.has(relDir)) {
            return;
        }
        this.reportedUnsyncedCopies.add(relDir);
        const message = `${relDir} is Cloud only, but a local ${relDir} folder exists. It is left as it is and is not synced; move what you need out of it, or switch the folder back to Sync.`;
        this.stateDb.logActivity({ action: 'sync', localRelPath: relDir, details: message });
        sendDesktopNotification({
            title: 'Proton Drive: local folder not synced',
            body: message,
            urgency: 'normal',
            enabled: settings.notificationsEnabled,
        });
    }

    private logCloudOnlyRemoval(relDir: string): void {
        this.stateDb.logActivity({
            action: 'delete-local',
            localRelPath: relDir,
            details: 'Excluded by Selective Sync (removed local copy; kept in Proton Drive cloud)',
        });
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

    async syncFoldersPriority(folderNames: string[]): Promise<void> {
        const cleaned = folderNames
            .map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
            .filter(Boolean);
        if (cleaned.length === 0 || !this.auth.isLoggedIn()) {
            return;
        }
        this.markFoldersSyncing(cleaned);
        await this.exclusionRun;
        const settings = this.stateDb.getSettings();
        if (settings.paused) {
            return;
        }

        this.state = 'syncing';
        try {
            await mkdir(settings.syncDir, { recursive: true });
            const root = await this.getRootFolder();
            const children = await listFolderChildren(this.sdk, root);
            const childByName = new Map<string, NodeEntity>();
            for (const c of children) {
                childByName.set(getName(c), c);
            }

            const remoteMap = new Map<string, NodeEntity>();
            for (const folderName of cleaned) {
                const liveSettings = this.stateDb.getSettings();
                if (liveSettings.paused || liveSettings.excludedFolders.includes(folderName)) {
                    this.syncingFolders.delete(folderName);
                    continue;
                }
                const remoteFolder = childByName.get(folderName);
                if (!remoteFolder) {
                    this.syncingFolders.delete(folderName);
                    continue;
                }
                try {
                    this.currentAction = `Syncing ${folderName}`;
                    remoteMap.set(folderName, remoteFolder);
                    const localFullPath = path.join(liveSettings.syncDir, folderName);
                    const st = await stat(localFullPath).catch(() => null);
                    const localInfo = st
                        ? { isDirectory: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs }
                        : undefined;
                    let dbRecord = this.stateDb.getItemByPath(folderName) ?? undefined;
                    if (!localInfo && dbRecord) {
                        // Stale record from before the folder was Cloud only: never treat as a local deletion
                        this.stateDb.removeItemByPath(folderName);
                        dbRecord = undefined;
                    }
                    await this.reconcileSinglePath(
                        folderName,
                        remoteFolder,
                        localInfo,
                        dbRecord,
                        remoteMap,
                        liveSettings,
                    );
                    if (remoteFolder.type === NodeType.Folder) {
                        await this.reconcileDirectoryIncremental(remoteFolder, folderName, remoteMap, liveSettings);
                    }
                } finally {
                    this.syncingFolders.delete(folderName);
                }
            }
        } catch (err) {
            this.logger.warn(`Priority folder sync encountered error: ${err}`);
            for (const folderName of cleaned) {
                this.syncingFolders.delete(folderName);
            }
        } finally {
            if (!this.reconcileRunning && this.syncingFolders.size === 0) {
                this.currentAction = null;
                this.state = this.stateDb.getSettings().paused ? 'paused' : 'idle';
            }
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
        this.currentAction = 'Applying selective sync rules...';
        this.lastError = null;

        try {
            await mkdir(settings.syncDir, { recursive: true });
            await this.applySelectiveSyncExclusions();
            const root = await this.getRootFolder();
            await this.eventsManager.subscribeDriveScope(root.treeEventScopeId);

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

        // Case 1: Present remotely, not present locally
        if (remoteNode && !localInfo) {
            if (dbRecord) {
                // Was previously synced, so user deleted it locally -> trash remotely. Look again first: the listing
                // can predate the record being dropped (e.g. by Cloud only) or the item coming back; either way the
                // next pass, with a fresh listing, deals with it.
                const stillTracked = this.stateDb.getItemByPath(relPath) !== null;
                const backLocally = await stat(localFullPath).then(
                    () => true,
                    () => false,
                );
                if (stillTracked && !backLocally) {
                    await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
                }
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

        await this.exclusionRun;
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
        _initialSettings: SyncSettings,
    ): Promise<void> {
        const liveSettings = this.stateDb.getSettings();
        if (liveSettings.paused) {
            return;
        }
        if (prefix && matchesIgnorePatterns(prefix, liveSettings.ignorePatterns, liveSettings.excludedFolders)) {
            await this.applySelectiveSyncExclusions();
            return;
        }

        const localDirFullPath = prefix ? path.join(liveSettings.syncDir, prefix) : liveSettings.syncDir;
        this.watcher.suppressPath(prefix || '.');
        await mkdir(localDirFullPath, { recursive: true });

        this.currentAction = `Listing /my-files/${prefix || ''}`;
        const remoteChildren = await listFolderChildren(this.sdk, folderNode);
        const freshSettings = this.stateDb.getSettings();
        const remoteChildByName = new Map<string, NodeEntity>();
        for (const child of remoteChildren) {
            const name = getName(child);
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (!matchesIgnorePatterns(relPath, freshSettings.ignorePatterns, freshSettings.excludedFolders)) {
                remoteChildByName.set(name, child);
                remoteMap.set(relPath, child);
            }
        }

        const localEntries = await readdir(localDirFullPath, { withFileTypes: true }).catch(() => []);
        const localChildByName = new Map<string, { isDirectory: boolean; size: number; mtimeMs: number }>();
        for (const entry of localEntries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (matchesIgnorePatterns(relPath, freshSettings.ignorePatterns, freshSettings.excludedFolders)) {
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
                if (!matchesIgnorePatterns(item.localRelPath, freshSettings.ignorePatterns, freshSettings.excludedFolders)) {
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
            if (matchesIgnorePatterns(relPath, stepSettings.ignorePatterns, stepSettings.excludedFolders)) {
                await this.applySelectiveSyncExclusions();
                continue;
            }
            if (!prefix && this.syncingFolders.has(name)) {
                // Being handled by syncFoldersPriority right now; avoid concurrent duplicate work
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
            }
        }

        for (const sub of subFoldersToRecurse) {
            const nextSettings = this.stateDb.getSettings();
            if (nextSettings.paused) {
                return;
            }
            if (matchesIgnorePatterns(sub.relPath, nextSettings.ignorePatterns, nextSettings.excludedFolders)) {
                await this.applySelectiveSyncExclusions();
                continue;
            }
            await this.reconcileDirectoryIncremental(sub.node, sub.relPath, remoteMap, nextSettings);
        }
    }
}

function isEngineTempName(name: string): boolean {
    return name.startsWith('.proton-drive-tmp-');
}

function treeEntrySignature(st: { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }): string {
    // Directory mtimes are left out: a folder that gains an entry fails to delete because it isn't empty
    return st.isFile() ? `file:${st.size}:${st.mtimeMs}` : st.isDirectory() ? 'dir' : 'other';
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
