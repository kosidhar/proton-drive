import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';

import { selfOrDescendant, selfOrDescendantWhere } from './pathRange';
import { type ConflictStrategy, isConflictStrategy, problemWithBlockedApps, RETIRED_CONFLICT_STRATEGIES, usableIgnorePatterns } from './settingsRules';

export type ItemSyncStatus = 'synced' | 'uploading' | 'downloading' | 'conflict' | 'error' | 'ignored';
export { CONFLICT_STRATEGIES, type ConflictStrategy } from './settingsRules';

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
    // When the content the record says it holds was read (just before the stat and hash of an upload or a comparison,
    // or before a download was placed): a file whose ctime is older was not written since (see notWrittenSince). Null
    // when not known, which counts as written. Unlike updatedAt, which says when the record was written (#109)
    contentReadAt?: number | null;
}

// What the virtual drive showed of an online-only file when it turned it into a local one (POST /vfs/truncate): the
// local file's content is an edit of that version of that node. Kept apart from the records, so a file that goes away
// never reads as the user deleting something synced.
export interface EditBaseline {
    relPath: string;
    nodeUid: string;
    parentUid: string | null;
    sha1: string | null;
    mtimeMs: number;
    size: number;
    createdAt: number;
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

export interface NewConflict {
    localRelPath: string;
    nodeUid: string;
    localSha1: string | null;
    remoteSha1: string | null;
    localMtimeMs: number;
    remoteMtimeMs: number;
    resolved?: boolean;
    resolution?: string | null;
    conflictCopyPath?: string | null;
}

export interface ActivityRecord {
    id: number;
    timestamp: number;
    // free-up and hide take local copies away and keep the items in Proton Drive: never a delete-local, which reads
    // as one (#94)
    action:
        | 'upload'
        | 'download'
        | 'delete-local'
        | 'free-up'
        | 'hide'
        | 'trash-remote'
        | 'mkdir'
        | 'conflict'
        | 'error'
        | 'auth'
        | 'sync';
    localRelPath: string;
    details: string;
    bytesTransferred: number;
}

export interface SyncSettings {
    syncDir: string;
    conflictStrategy: ConflictStrategy;
    notificationsEnabled: boolean;
    // Proton Drive starts at login (see linux/autostart.ts), on unless turned off (#92)
    startAtLogin: boolean;
    reconcileIntervalSec: number;
    paused: boolean;
    // When a timed pause ends (epoch ms), the engine resuming by itself then; null when it lasts until resumed (#205)
    pausedUntil: number | null;
    ignorePatterns: string[];
    // Apps (by process name) that may not download online-only files from the virtual drive
    blockedApps: string[];
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

// Meta keys whose change changes where the files are, so every emblem may be stale
const RESET_META_KEYS: readonly string[] = ['driveLayout', 'virtualDriveWanted'];

// A stored time (epoch ms), or null when there is none or it is not one
function storedTime(raw: string | undefined): number | null {
    const value = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class SyncStateDatabase {
    private db: Database;

    // Told of every path whose state may have changed (subtree: everything below it too), for the file manager's
    // emblems (see StateEvents)
    onChange: ((relPath: string, subtree: boolean) => void) | null = null;
    // Told when every state may have changed at once: the sync folder moved, the ignore patterns or the layout changed
    onReset: (() => void) | null = null;
    // Told of each activity entry as it is logged: the daemon writes them to its log file too (#180)
    onActivity: ((entry: { action: ActivityRecord['action']; localRelPath: string; details: string }) => void) | null = null;

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
        this.retireOverwritingStrategies();
    }

    // keep-local or keep-remote, stored before #91, is rewritten as keep-both once: read as keep-both already (see
    // getSettings), it would turn overwriting back on for an older version run after this one. A write, so tried once:
    // while the daemon holds the write lock (a CLI's own open), it is left for the daemon's open
    private retireOverwritingStrategies(): void {
        const stored = this.db.query("SELECT value FROM settings WHERE key = 'conflictStrategy'").get() as { value: string } | null;
        if (!stored || !RETIRED_CONFLICT_STRATEGIES.includes(stored.value)) {
            return; // Nothing to write: an open never waits on the write lock for it
        }
        try {
            const changed = this.db
                .query(`UPDATE settings SET value = 'keep-both' WHERE key = 'conflictStrategy' AND value IN ('keep-local', 'keep-remote')`)
                .run().changes;
            if (changed > 0) {
                console.warn('The stored conflict strategy, which replaced one version with the other, is now keep-both (#91)');
            }
        } catch {
            // Read as keep-both meanwhile
        }
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
        // Records from before #109 have no read time: their updatedAt may hide a write made while they synced, so each
        // file is hashed once (the next pass, or the watcher, which then finds it identical and uploads nothing), and is
        // given one then. Only when missing, as an open that writes needs the write lock, which the daemon may hold
        const columns = this.db.query('PRAGMA table_info(synced_items)').all() as Array<{ name: string }>;
        if (!columns.some((c) => c.name === 'contentReadAt')) {
            this.db.run('ALTER TABLE synced_items ADD COLUMN contentReadAt REAL');
        }

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
        // At most one unresolved conflict per path (#66): duplicates earlier versions queued, pass after pass, fold into
        // the latest of them, once. Only then, as an open that writes needs the write lock, which the daemon may hold.
        const indexed = this.db
            .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_conflicts_one_unresolved_per_path'")
            .get();
        if (!indexed) {
            this.db.transaction(() => {
                this.db.run(`
                    DELETE FROM conflicts
                    WHERE resolved = 0 AND id NOT IN (SELECT MAX(id) FROM conflicts WHERE resolved = 0 GROUP BY localRelPath)
                `);
                this.db.run(
                    'CREATE UNIQUE INDEX IF NOT EXISTS idx_conflicts_one_unresolved_per_path ON conflicts(localRelPath) WHERE resolved = 0',
                );
            })();
        }

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

        this.db.run(`
            CREATE TABLE IF NOT EXISTS drive_edit_baselines (
                relPath TEXT PRIMARY KEY,
                nodeUid TEXT NOT NULL,
                parentUid TEXT,
                sha1 TEXT,
                mtimeMs INTEGER NOT NULL,
                size INTEGER NOT NULL,
                createdAt INTEGER NOT NULL
            )
        `);
    }

    // A stored value that fails the settings rules (saved before they existed) is never used as it is: it would stop
    // syncing (not a list of strings) or hide the drive (matches everything). Its usable part, or the default, stands in
    // while it is read; what is stored is never rewritten by that (updateSettings writes only what it is given).
    // Checked once per stored value.
    private checkedIgnorePatterns: { raw: string | undefined; value: string[] } | null = null;
    // recordedTopLevelNames, until the records change
    private topLevelNames: string[] | null = null;
    private readonly warnedBadSettings = new Set<string>();

    private warnBadSetting(key: string, raw: string, what = 'not a valid value; using the default'): void {
        if (this.warnedBadSettings.has(`${key}=${raw}`)) return;
        this.warnedBadSettings.add(`${key}=${raw}`);
        console.warn(`The stored ${key} (${raw.slice(0, 80)}) is ${what === 'not a valid value; using the default' ? what : `used ${what}`}; the stored value is kept as it is`);
    }

    private storedIgnorePatterns(raw: string | undefined): string[] {
        const cached = this.checkedIgnorePatterns;
        if (cached && cached.raw === raw) return [...cached.value];
        let value = [...DEFAULT_IGNORE_PATTERNS];
        if (raw !== undefined) {
            let usable: ReturnType<typeof usableIgnorePatterns> = null;
            try {
                usable = usableIgnorePatterns(JSON.parse(raw));
            } catch {
                // not JSON
            }
            if (usable === null) {
                this.warnBadSetting('ignorePatterns', raw);
            } else {
                value = usable.patterns;
                if (usable.dropped > 0) this.warnBadSetting('ignorePatterns', raw, `leaving out ${usable.dropped} unusable pattern(s)`);
            }
        }
        this.checkedIgnorePatterns = { raw, value };
        return [...value];
    }

    // A stored list that can't be used reads as none blocked, with a warning: a bad value must never stop the drive
    private storedBlockedApps(raw: string | undefined): string[] {
        if (raw === undefined) return [];
        try {
            const apps: unknown = JSON.parse(raw);
            if (problemWithBlockedApps(apps) === null) return apps as string[];
        } catch {
            // not JSON
        }
        this.warnBadSetting('blockedApps', raw);
        return [];
    }

    getSettings(): SyncSettings {
        const defaultSyncDir = process.env.PROTON_DRIVE_SYNC_DIR || path.join(homedir(), 'ProtonDrive');
        const rows = this.db.query('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
        const map = new Map(rows.map((r) => [r.key, r.value]));

        const ignorePatterns = this.storedIgnorePatterns(map.get('ignorePatterns'));
        const storedStrategy = map.get('conflictStrategy');
        let conflictStrategy: ConflictStrategy = 'keep-both';
        if (isConflictStrategy(storedStrategy)) {
            conflictStrategy = storedStrategy;
        } else if (storedStrategy && RETIRED_CONFLICT_STRATEGIES.includes(storedStrategy)) {
            // Saved before #91: it replaced one side with the other. Read as keep-both, never acted on
            this.warnBadSetting('conflictStrategy', storedStrategy, 'as keep-both (keep-local and keep-remote are no longer offered)');
        } else if (storedStrategy) {
            this.warnBadSetting('conflictStrategy', storedStrategy);
        }

        return {
            syncDir: map.get('syncDir') || defaultSyncDir,
            conflictStrategy,
            notificationsEnabled: map.has('notificationsEnabled') ? map.get('notificationsEnabled') === 'true' : true,
            startAtLogin: map.has('startAtLogin') ? map.get('startAtLogin') === 'true' : true,
            reconcileIntervalSec: Number(map.get('reconcileIntervalSec') || 120),
            paused: map.get('paused') === 'true',
            pausedUntil: storedTime(map.get('pausedUntil')),
            ignorePatterns,
            blockedApps: this.storedBlockedApps(map.get('blockedApps')),
        };
    }

    // Writes only the settings given, so a value stored as it is (see getSettings) is never rewritten by a save of another;
    // answers all of them
    updateSettings(partial: Partial<SyncSettings>): SyncSettings {
        const current = this.getSettings();
        const next: SyncSettings = { ...current, ...partial };
        const upsert = this.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)');
        const store = (key: keyof SyncSettings, value: string) => {
            if (partial[key] !== undefined) upsert.run({ $key: key, $value: value });
        };

        store('syncDir', next.syncDir);
        store('conflictStrategy', next.conflictStrategy);
        store('notificationsEnabled', String(next.notificationsEnabled));
        store('startAtLogin', String(next.startAtLogin));
        store('reconcileIntervalSec', String(next.reconcileIntervalSec));
        store('paused', String(next.paused));
        if (partial.pausedUntil === null) {
            this.db.query("DELETE FROM settings WHERE key = 'pausedUntil'").run();
        } else if (partial.pausedUntil !== undefined) {
            store('pausedUntil', String(partial.pausedUntil));
        }
        store('ignorePatterns', JSON.stringify(next.ignorePatterns));
        store('blockedApps', JSON.stringify(next.blockedApps));

        if (
            (partial.syncDir !== undefined && partial.syncDir !== current.syncDir) ||
            (partial.ignorePatterns !== undefined && JSON.stringify(partial.ignorePatterns) !== JSON.stringify(current.ignorePatterns))
        ) {
            this.onReset?.();
        }
        return next;
    }

    // Values the app keeps for itself (such as migration markers) in the settings table.
    getMeta(key: string): string | null {
        const row = this.db.query('SELECT value FROM settings WHERE key = $key').get({ $key: key }) as { value: string } | null;
        return row?.value ?? null;
    }

    setMeta(key: string, value: string): void {
        const before = RESET_META_KEYS.includes(key) ? this.getMeta(key) : value;
        this.db.query('INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)').run({ $key: key, $value: value });
        if (before !== value) {
            this.onReset?.();
        }
    }

    deleteMeta(key: string): void {
        this.db.query('DELETE FROM settings WHERE key = $key').run({ $key: key });
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

    // A record written for a path consumes the edit baseline there: the record is what it syncs by from then on
    upsertItem(item: Omit<SyncedItemRecord, 'updatedAt'> & { updatedAt?: number }): void {
        this.topLevelNames = null;
        const updatedAt = item.updatedAt ?? Date.now();
        this.db.query('DELETE FROM drive_edit_baselines WHERE relPath = $relPath').run({ $relPath: item.localRelPath });
        this.db
            .query(`
                INSERT OR REPLACE INTO synced_items (
                    localRelPath, nodeUid, parentNodeUid, type,
                    localSha1, remoteSha1, localMtimeMs, remoteMtimeMs,
                    size, syncStatus, lastError, updatedAt, contentReadAt
                ) VALUES (
                    $localRelPath, $nodeUid, $parentNodeUid, $type,
                    $localSha1, $remoteSha1, $localMtimeMs, $remoteMtimeMs,
                    $size, $syncStatus, $lastError, $updatedAt, $contentReadAt
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
                $contentReadAt: item.contentReadAt ?? null,
            });
        this.onChange?.(item.localRelPath, false);
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

    // The top-level names the records are under (the first segment of each path), each once, sorted. Kept until a record
    // is added, removed or moved (every such write goes through this class).
    recordedTopLevelNames(): string[] {
        if (this.topLevelNames === null) {
            const rows = this.db
                .query(
                    `SELECT DISTINCT CASE WHEN instr(localRelPath, '/') > 0 THEN substr(localRelPath, 1, instr(localRelPath, '/') - 1)
                         ELSE localRelPath END AS name FROM synced_items ORDER BY name`,
                )
                .all() as Array<{ name: string }>;
            this.topLevelNames = rows.map((row) => row.name);
        }
        return [...this.topLevelNames];
    }

    // How many records are at a path and under it
    countItemsUnder(localRelPath: string): number {
        const row = this.db
            .query(`SELECT COUNT(*) AS n FROM synced_items WHERE ${selfOrDescendantWhere('localRelPath')}`)
            .get(selfOrDescendant(localRelPath)) as { n: number };
        return row.n;
    }

    // The record at a path and every record under it.
    getItemsUnder(localRelPath: string): SyncedItemRecord[] {
        return this.db
            .query(`SELECT * FROM synced_items WHERE ${selfOrDescendantWhere('localRelPath')} ORDER BY localRelPath ASC`)
            .all(selfOrDescendant(localRelPath)) as SyncedItemRecord[];
    }

    removeItemByPath(localRelPath: string): void {
        this.topLevelNames = null;
        this.db.query(`DELETE FROM synced_items WHERE ${selfOrDescendantWhere('localRelPath')}`).run(selfOrDescendant(localRelPath));
        this.onChange?.(localRelPath, true);
    }

    // Moves the record at a path, and every record under it, to another path, in one transaction (a local copy moved to
    // follow a rename in the cloud). The root never moves, nor does a path into itself, and records already at the
    // target are never merged into or overwritten: each of these throws, changing nothing.
    // newParentUid, when given, is the cloud folder the moved item is now in: its record's parentNodeUid follows the move
    // (#80). The records below it keep theirs: their parent didn't change.
    renameItemPath(fromRel: string, toRel: string, newParentUid?: string): void {
        if (fromRel === '' || toRel === '') {
            throw new Error("The root of the sync folder can't be moved");
        }
        if (toRel === fromRel) {
            return;
        }
        if (toRel.startsWith(`${fromRel}/`)) {
            throw new Error(`Can't move ${fromRel} into itself`);
        }
        this.topLevelNames = null;
        this.db.transaction(() => {
            if (this.hasItemsUnder(toRel)) {
                throw new Error(`Already recorded: ${toRel}`);
            }
            this.db
                .query(
                    `UPDATE synced_items SET localRelPath = $toRel || substr(localRelPath, length($fromRel) + 1),
                         updatedAt = $updatedAt
                     WHERE ${selfOrDescendantWhere('localRelPath')}`,
                )
                .run({ $toRel: toRel, $fromRel: fromRel, $updatedAt: Date.now(), ...selfOrDescendant(fromRel) });
            if (newParentUid !== undefined) {
                this.db
                    .query('UPDATE synced_items SET parentNodeUid = $parent WHERE localRelPath = $toRel')
                    .run({ $parent: newParentUid, $toRel: toRel });
            }
        })();
        this.onChange?.(fromRel, true);
        this.onChange?.(toRel, true);
    }

    // The records of the items directly in a folder name it as their cloud parent: a folder recorded with its node (one
    // made here, say, that items were moved into before Proton Drive had it) is where they are now (#103). Leaves
    // updatedAt as it was: it says when an item's own record was written, and is trusted as such (a file whose ctime is
    // no newer counts as not written since, #89/#105; a record written meanwhile stops a conflict pass, #77).
    setParentOfChildren(folderRel: string, folderUid: string): void {
        if (folderRel === '') {
            return;
        }
        this.db
            .query(
                `UPDATE synced_items SET parentNodeUid = $uid
                 WHERE localRelPath > $lo AND localRelPath < $hi
                   AND instr(substr(localRelPath, length($lo) + 1), '/') = 0
                   AND parentNodeUid IS NOT $uid`,
            )
            // '0' follows '/': the range is exactly the paths under the folder, found by the primary key
            // (SQLite counts the offset in characters, as substr does: a JS length would be off for emoji, #103 review)
            .run({ $uid: folderUid, $lo: `${folderRel}/`, $hi: `${folderRel}0` });
    }

    recordEditBaseline(baseline: Omit<EditBaseline, 'createdAt'>): void {
        this.db
            .query(
                `INSERT OR REPLACE INTO drive_edit_baselines (relPath, nodeUid, parentUid, sha1, mtimeMs, size, createdAt)
                 VALUES ($relPath, $nodeUid, $parentUid, $sha1, $mtimeMs, $size, $createdAt)`,
            )
            .run({
                $relPath: baseline.relPath,
                $nodeUid: baseline.nodeUid,
                $parentUid: baseline.parentUid,
                $sha1: baseline.sha1,
                $mtimeMs: Math.round(baseline.mtimeMs),
                $size: baseline.size,
                $createdAt: Date.now(),
            });
    }

    getEditBaseline(relPath: string): EditBaseline | null {
        const row = this.db.query('SELECT * FROM drive_edit_baselines WHERE relPath = $relPath').get({ $relPath: relPath });
        return (row as EditBaseline | null) ?? null;
    }

    listEditBaselines(): EditBaseline[] {
        return this.db.query('SELECT * FROM drive_edit_baselines ORDER BY relPath ASC').all() as EditBaseline[];
    }

    // The baselines at a path and under it
    dropEditBaselines(relPath: string): void {
        this.db.query(`DELETE FROM drive_edit_baselines WHERE ${selfOrDescendantWhere('relPath')}`).run(selfOrDescendant(relPath));
    }

    // The baselines at a path and under it now go with what is at toRel; any that were there go
    moveEditBaselines(fromRel: string, toRel: string): void {
        if (fromRel === toRel) {
            return;
        }
        this.db.transaction(() => {
            this.dropEditBaselines(toRel);
            this.db
                .query(
                    `UPDATE drive_edit_baselines SET relPath = $toRel || substr(relPath, length($fromRel) + 1)
                     WHERE ${selfOrDescendantWhere('relPath')}`,
                )
                .run({ $toRel: toRel, $fromRel: fromRel, ...selfOrDescendant(fromRel) });
        })();
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
            this.topLevelNames = null;
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
        this.onChange?.(localRelPath, false);
    }

    // A conflict, as decided (resolved), or waiting for the user; one waiting at a path where another already waits
    // refreshes that one (see queueConflict)
    recordConflict(conflict: NewConflict): ConflictRecord {
        return conflict.resolved ? this.insertConflict(conflict) : this.queueConflict(conflict).conflict;
    }

    // A conflict waiting for the user, kept once per path (#66): queued again while it waits, it is the same conflict as
    // it now stands, with the same id (what the GUI resolves it by) and the time it was first found. `queued` says
    // whether it is new.
    queueConflict(conflict: Omit<NewConflict, 'resolved' | 'resolution'>): { conflict: ConflictRecord; queued: boolean } {
        return this.db.transaction(() => {
            const waiting = this.db
                .query('SELECT id FROM conflicts WHERE localRelPath = $localRelPath AND resolved = 0')
                .get({ $localRelPath: conflict.localRelPath }) as { id: number } | null;
            if (!waiting) {
                return { conflict: this.insertConflict({ ...conflict, resolved: false }), queued: true };
            }
            this.db
                .query(`
                    UPDATE conflicts
                    SET nodeUid = $nodeUid, localSha1 = $localSha1, remoteSha1 = $remoteSha1,
                        localMtimeMs = $localMtimeMs, remoteMtimeMs = $remoteMtimeMs,
                        conflictCopyPath = COALESCE($conflictCopyPath, conflictCopyPath)
                    WHERE id = $id
                `)
                .run({
                    $id: waiting.id,
                    $nodeUid: conflict.nodeUid,
                    $localSha1: conflict.localSha1,
                    $remoteSha1: conflict.remoteSha1,
                    $localMtimeMs: Math.round(conflict.localMtimeMs),
                    $remoteMtimeMs: Math.round(conflict.remoteMtimeMs),
                    $conflictCopyPath: conflict.conflictCopyPath ?? null,
                });
            this.onChange?.(conflict.localRelPath, false);
            return { conflict: this.getConflictById(waiting.id)!, queued: false };
        })();
    }

    // A conflict a strategy has just resolved. The one waiting at the path for the user, if any (queued under the
    // prompt strategy before it changed: #68), is this one: it is resolved, as the conflict now stands, rather than left
    // waiting beside a new row. With none waiting, it is recorded as a new, resolved one.
    settleConflict(conflict: Omit<NewConflict, 'resolved'> & { resolution: string }): ConflictRecord {
        return this.db.transaction(() => {
            const waiting = this.db
                .query('SELECT id FROM conflicts WHERE localRelPath = $localRelPath AND resolved = 0')
                .get({ $localRelPath: conflict.localRelPath }) as { id: number } | null;
            if (!waiting) {
                return this.insertConflict({ ...conflict, resolved: true });
            }
            this.db
                .query(`
                    UPDATE conflicts
                    SET nodeUid = $nodeUid, localSha1 = $localSha1, remoteSha1 = $remoteSha1,
                        localMtimeMs = $localMtimeMs, remoteMtimeMs = $remoteMtimeMs, resolved = 1,
                        resolution = $resolution, conflictCopyPath = COALESCE($conflictCopyPath, conflictCopyPath)
                    WHERE id = $id
                `)
                .run({
                    $id: waiting.id,
                    $nodeUid: conflict.nodeUid,
                    $localSha1: conflict.localSha1,
                    $remoteSha1: conflict.remoteSha1,
                    $localMtimeMs: Math.round(conflict.localMtimeMs),
                    $remoteMtimeMs: Math.round(conflict.remoteMtimeMs),
                    $resolution: conflict.resolution,
                    $conflictCopyPath: conflict.conflictCopyPath ?? null,
                });
            this.onChange?.(conflict.localRelPath, false);
            return this.getConflictById(waiting.id)!;
        })();
    }

    // Whether a conflict waits for the user at a path (one query on the index of waiting conflicts, for every file a pass
    // looks at)
    hasWaitingConflict(localRelPath: string): boolean {
        return (
            this.db.query('SELECT 1 FROM conflicts WHERE localRelPath = $localRelPath AND resolved = 0 LIMIT 1').get({
                $localRelPath: localRelPath,
            }) !== null
        );
    }

    // Marks a record as current as of `at` (when its file was last read whole), without changing what it says
    touchItem(localRelPath: string, at: number): void {
        this.db
            .query(
                `UPDATE synced_items SET updatedAt = MAX(updatedAt, $at), contentReadAt = MAX(COALESCE(contentReadAt, 0), $at)
                 WHERE localRelPath = $localRelPath`,
            )
            .run({ $at: at, $localRelPath: localRelPath });
    }

    // Closes the conflict waiting at a path, if any, as `resolution` (a sync pass found both sides holding the same
    // content: 'in-sync'). True when one was waiting.
    closeWaitingConflict(localRelPath: string, resolution: string): boolean {
        const waiting = this.db
            .query('SELECT id FROM conflicts WHERE localRelPath = $localRelPath AND resolved = 0')
            .get({ $localRelPath: localRelPath }) as { id: number } | null;
        if (!waiting) {
            return false;
        }
        this.markConflictResolved(waiting.id, resolution);
        return true;
    }

    private insertConflict(conflict: NewConflict): ConflictRecord {
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

        this.onChange?.(conflict.localRelPath, false);
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

    // Only a conflict still waiting is resolved: one resolved already keeps what it says happened (#77)
    markConflictResolved(id: number, resolution: string, conflictCopyPath?: string | null): void {
        this.db
            .query(`
                UPDATE conflicts
                SET resolved = 1, resolution = $resolution, conflictCopyPath = COALESCE($conflictCopyPath, conflictCopyPath)
                WHERE id = $id AND resolved = 0
            `)
            .run({
                $id: id,
                $resolution: resolution,
                $conflictCopyPath: conflictCopyPath ?? null,
            });
        const resolved = this.getConflictById(id);
        if (resolved) {
            this.onChange?.(resolved.localRelPath, false);
        }
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

        // Best effort: a log handler failing never fails what logged the entry
        try {
            this.onActivity?.({ action: entry.action, localRelPath: entry.localRelPath, details: entry.details });
        } catch {
            // the entry is in the activity log all the same
        }
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
