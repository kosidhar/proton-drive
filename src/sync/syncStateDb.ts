import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';

import { selfOrDescendant, selfOrDescendantWhere } from './pathRange';

export type ItemSyncStatus = 'synced' | 'uploading' | 'downloading' | 'conflict' | 'error' | 'ignored';
export type ConflictStrategy = 'keep-both' | 'keep-local' | 'keep-remote' | 'prompt';

export interface SyncedItemRecord {
    localRelPath: string;
    nodeUid: string;
    parentNodeUid: string | null;
    type: 'file' | 'folder';
    localSha1: string | null;
    remoteSha1: string | null;
    localMtimeMs: number;
    remoteMtimeMs: number;
    size: number;
    syncStatus: ItemSyncStatus;
    lastError: string | null;
    updatedAt: number;
}

export interface ConflictRecord {
    id: number;
    localRelPath: string;
    nodeUid: string;
    localSha1: string | null;
    remoteSha1: string | null;
    localMtimeMs: number;
    remoteMtimeMs: number;
    detectedAt: number;
    resolved: number;
    resolution: string | null;
    conflictCopyPath: string | null;
}

export interface ActivityRecord {
    id: number;
    timestamp: number;
    action: 'upload' | 'download' | 'delete-local' | 'trash-remote' | 'mkdir' | 'conflict' | 'error' | 'auth' | 'sync';
    localRelPath: string;
    details: string;
    bytesTransferred: number;
}

export interface SyncSettings {
    syncDir: string;
    conflictStrategy: ConflictStrategy;
    notificationsEnabled: boolean;
    reconcileIntervalSec: number;
    paused: boolean;
    ignorePatterns: string[];
}

export const DEFAULT_IGNORE_PATTERNS = [
    '.git',
    '.git/**',
    'node_modules',
    'node_modules/**',
    '.proton-drive-tmp-*',
    '*.part',
    '*.crdownload',
    '*~',
    '.DS_Store',
    '.Trash-*',
];

export class SyncStateDatabase {
    private db: Database;

    // For modules that keep their own tables in this database file, such as RemoteIndex.
    get connection(): Database {
        return this.db;
    }

    constructor(dbFilePath: string) {
        this.db = new Database(dbFilePath, { create: true });
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.run('PRAGMA busy_timeout = 5000');
        this.initSchema();
    }

    private initSchema(): void {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS synced_items (
                localRelPath TEXT PRIMARY KEY,
                nodeUid TEXT NOT NULL,
                parentNodeUid TEXT,
                type TEXT NOT NULL,
                localSha1 TEXT,
                remoteSha1 TEXT,
                localMtimeMs INTEGER NOT NULL DEFAULT 0,
                remoteMtimeMs INTEGER NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0,
                syncStatus TEXT NOT NULL DEFAULT 'synced',
                lastError TEXT,
                updatedAt INTEGER NOT NULL
            )
        `);
        this.db.run('CREATE INDEX IF NOT EXISTS idx_synced_items_node_uid ON synced_items(nodeUid)');

        this.db.run(`
            CREATE TABLE IF NOT EXISTS conflicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                localRelPath TEXT NOT NULL,
                nodeUid TEXT NOT NULL,
                localSha1 TEXT,
                remoteSha1 TEXT,
                localMtimeMs INTEGER NOT NULL,
                remoteMtimeMs INTEGER NOT NULL,
                detectedAt INTEGER NOT NULL,
                resolved INTEGER NOT NULL DEFAULT 0,
                resolution TEXT,
                conflictCopyPath TEXT
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                action TEXT NOT NULL,
                localRelPath TEXT NOT NULL,
                details TEXT NOT NULL,
                bytesTransferred INTEGER NOT NULL DEFAULT 0
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
    }

    getSettings(): SyncSettings {
        const defaultSyncDir = process.env.PROTON_DRIVE_SYNC_DIR || path.join(homedir(), 'ProtonDrive');
        const rows = this.db.query('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
        const map = new Map(rows.map((r) => [r.key, r.value]));

        let ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
        try {
            if (map.has('ignorePatterns')) {
                ignorePatterns = JSON.parse(map.get('ignorePatterns')!) as string[];
            }
        } catch {}

        return {
            syncDir: map.get('syncDir') || defaultSyncDir,
            conflictStrategy: (map.get('conflictStrategy') as ConflictStrategy) || 'keep-both',
            notificationsEnabled: map.has('notificationsEnabled') ? map.get('notificationsEnabled') === 'true' : true,
            reconcileIntervalSec: Number(map.get('reconcileIntervalSec') || 120),
            paused: map.get('paused') === 'true',
            ignorePatterns,
        };
    }

    updateSettings(partial: Partial<SyncSettings>): SyncSettings {
        const current = this.getSettings();
        const next: SyncSettings = { ...current, ...partial };
        const upsert = this.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)');

        upsert.run({ $key: 'syncDir', $value: next.syncDir });
        upsert.run({ $key: 'conflictStrategy', $value: next.conflictStrategy });
        upsert.run({ $key: 'notificationsEnabled', $value: String(next.notificationsEnabled) });
        upsert.run({ $key: 'reconcileIntervalSec', $value: String(next.reconcileIntervalSec) });
        upsert.run({ $key: 'paused', $value: String(next.paused) });
        upsert.run({ $key: 'ignorePatterns', $value: JSON.stringify(next.ignorePatterns) });

        return next;
    }

    // Values the app keeps for itself (such as migration markers) in the settings table.
    getMeta(key: string): string | null {
        const row = this.db.query('SELECT value FROM settings WHERE key = $key').get({ $key: key }) as { value: string } | null;
        return row?.value ?? null;
    }

    setMeta(key: string, value: string): void {
        this.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)').run({ $key: key, $value: value });
    }

    // The top-level folders the retired Cloud only setting kept off this computer; read only by the migration.
    readLegacyExcludedFolders(): string[] {
        try {
            const parsed: unknown = JSON.parse(this.getMeta('excludedFolders') ?? '[]');
            return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
        } catch {
            return [];
        }
    }

    upsertItem(item: Omit<SyncedItemRecord, 'updatedAt'> & { updatedAt?: number }): void {
        const updatedAt = item.updatedAt ?? Date.now();
        this.db
            .query(`
                INSERT OR REPLACE INTO synced_items (
                    localRelPath, nodeUid, parentNodeUid, type,
                    localSha1, remoteSha1, localMtimeMs, remoteMtimeMs,
                    size, syncStatus, lastError, updatedAt
                ) VALUES (
                    $localRelPath, $nodeUid, $parentNodeUid, $type,
                    $localSha1, $remoteSha1, $localMtimeMs, $remoteMtimeMs,
                    $size, $syncStatus, $lastError, $updatedAt
                )
            `)
            .run({
                $localRelPath: item.localRelPath,
                $nodeUid: item.nodeUid,
                $parentNodeUid: item.parentNodeUid,
                $type: item.type,
                $localSha1: item.localSha1,
                $remoteSha1: item.remoteSha1,
                $localMtimeMs: Math.round(item.localMtimeMs),
                $remoteMtimeMs: Math.round(item.remoteMtimeMs),
                $size: item.size,
                $syncStatus: item.syncStatus,
                $lastError: item.lastError,
                $updatedAt: updatedAt,
            });
    }

    getItemByPath(localRelPath: string): SyncedItemRecord | null {
        const row = this.db
            .query('SELECT * FROM synced_items WHERE localRelPath = $localRelPath')
            .get({ $localRelPath: localRelPath }) as SyncedItemRecord | null;
        return row ?? null;
    }

    getItemByNodeUid(nodeUid: string): SyncedItemRecord | null {
        const row = this.db
            .query('SELECT * FROM synced_items WHERE nodeUid = $nodeUid')
            .get({ $nodeUid: nodeUid }) as SyncedItemRecord | null;
        return row ?? null;
    }

    getAllItems(): SyncedItemRecord[] {
        return this.db
            .query('SELECT * FROM synced_items ORDER BY localRelPath ASC')
            .all() as SyncedItemRecord[];
    }

    // The record at a path and every record under it.
    getItemsUnder(localRelPath: string): SyncedItemRecord[] {
        return this.db
            .query(`SELECT * FROM synced_items WHERE ${selfOrDescendantWhere('localRelPath')} ORDER BY localRelPath ASC`)
            .all(selfOrDescendant(localRelPath)) as SyncedItemRecord[];
    }

    removeItemByPath(localRelPath: string): void {
        this.db.query(`DELETE FROM synced_items WHERE ${selfOrDescendantWhere('localRelPath')}`).run(selfOrDescendant(localRelPath));
    }

    hasItemsUnder(localRelPath: string): boolean {
        return (
            this.db
                .query(`SELECT 1 FROM synced_items WHERE ${selfOrDescendantWhere('localRelPath')} LIMIT 1`)
                .get(selfOrDescendant(localRelPath)) !== null
        );
    }

    removeItemByNodeUid(nodeUid: string): void {
        const existing = this.getItemByNodeUid(nodeUid);
        if (existing) {
            this.removeItemByPath(existing.localRelPath);
        } else {
            this.db.query('DELETE FROM synced_items WHERE nodeUid = $nodeUid').run({ $nodeUid: nodeUid });
        }
    }

    setItemStatus(localRelPath: string, syncStatus: ItemSyncStatus, lastError: string | null = null): void {
        this.db
            .query(`
                UPDATE synced_items
                SET syncStatus = $syncStatus, lastError = $lastError, updatedAt = $updatedAt
                WHERE localRelPath = $localRelPath
            `)
            .run({
                $localRelPath: localRelPath,
                $syncStatus: syncStatus,
                $lastError: lastError,
                $updatedAt: Date.now(),
            });
    }

    recordConflict(conflict: {
        localRelPath: string;
        nodeUid: string;
        localSha1: string | null;
        remoteSha1: string | null;
        localMtimeMs: number;
        remoteMtimeMs: number;
        resolved?: boolean;
        resolution?: string | null;
        conflictCopyPath?: string | null;
    }): ConflictRecord {
        const detectedAt = Date.now();
        const res = this.db
            .query(`
                INSERT INTO conflicts (
                    localRelPath, nodeUid, localSha1, remoteSha1,
                    localMtimeMs, remoteMtimeMs, detectedAt, resolved,
                    resolution, conflictCopyPath
                ) VALUES (
                    $localRelPath, $nodeUid, $localSha1, $remoteSha1,
                    $localMtimeMs, $remoteMtimeMs, $detectedAt, $resolved,
                    $resolution, $conflictCopyPath
                )
            `)
            .run({
                $localRelPath: conflict.localRelPath,
                $nodeUid: conflict.nodeUid,
                $localSha1: conflict.localSha1,
                $remoteSha1: conflict.remoteSha1,
                $localMtimeMs: Math.round(conflict.localMtimeMs),
                $remoteMtimeMs: Math.round(conflict.remoteMtimeMs),
                $detectedAt: detectedAt,
                $resolved: conflict.resolved ? 1 : 0,
                $resolution: conflict.resolution ?? null,
                $conflictCopyPath: conflict.conflictCopyPath ?? null,
            });

        return this.getConflictById(Number(res.lastInsertRowid))!;
    }

    getConflictById(id: number): ConflictRecord | null {
        const row = this.db.query('SELECT * FROM conflicts WHERE id = $id').get({ $id: id }) as ConflictRecord | null;
        return row ?? null;
    }

    listConflicts(includeResolved = false): ConflictRecord[] {
        if (includeResolved) {
            return this.db.query('SELECT * FROM conflicts ORDER BY detectedAt DESC LIMIT 200').all() as ConflictRecord[];
        }
        return this.db
            .query('SELECT * FROM conflicts WHERE resolved = 0 ORDER BY detectedAt DESC')
            .all() as ConflictRecord[];
    }

    markConflictResolved(id: number, resolution: string, conflictCopyPath?: string | null): void {
        this.db
            .query(`
                UPDATE conflicts
                SET resolved = 1, resolution = $resolution, conflictCopyPath = COALESCE($conflictCopyPath, conflictCopyPath)
                WHERE id = $id
            `)
            .run({
                $id: id,
                $resolution: resolution,
                $conflictCopyPath: conflictCopyPath ?? null,
            });
    }

    logActivity(entry: {
        action: ActivityRecord['action'];
        localRelPath: string;
        details: string;
        bytesTransferred?: number;
    }): void {
        this.db
            .query(`
                INSERT INTO activity_log (timestamp, action, localRelPath, details, bytesTransferred)
                VALUES ($timestamp, $action, $localRelPath, $details, $bytesTransferred)
            `)
            .run({
                $timestamp: Date.now(),
                $action: entry.action,
                $localRelPath: entry.localRelPath,
                $details: entry.details,
                $bytesTransferred: entry.bytesTransferred ?? 0,
            });

        // Keep last 500 activity log entries
        this.db.run(`
            DELETE FROM activity_log
            WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 500)
        `);
    }

    listActivity(limit = 50): ActivityRecord[] {
        return this.db
            .query('SELECT * FROM activity_log ORDER BY id DESC LIMIT $limit')
            .all({ $limit: limit }) as ActivityRecord[];
    }

    getSummaryStats(): {
        totalFiles: number;
        totalFolders: number;
        totalBytes: number;
        unresolvedConflicts: number;
        errorItems: number;
    } {
        const filesRow = this.db
            .query("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM synced_items WHERE type = 'file'")
            .get() as { count: number; bytes: number };
        const foldersRow = this.db
            .query("SELECT COUNT(*) as count FROM synced_items WHERE type = 'folder'")
            .get() as { count: number };
        const conflictsRow = this.db
            .query('SELECT COUNT(*) as count FROM conflicts WHERE resolved = 0')
            .get() as { count: number };
        const errorsRow = this.db
            .query("SELECT COUNT(*) as count FROM synced_items WHERE syncStatus = 'error'")
            .get() as { count: number };

        return {
            totalFiles: filesRow?.count ?? 0,
            totalFolders: foldersRow?.count ?? 0,
            totalBytes: filesRow?.bytes ?? 0,
            unresolvedConflicts: conflictsRow?.count ?? 0,
            errorItems: errorsRow?.count ?? 0,
        };
    }

    close(): void {
        this.db.close();
    }
}
