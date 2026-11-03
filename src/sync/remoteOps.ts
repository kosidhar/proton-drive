import type { Database } from 'bun:sqlite';

import { selfOrDescendant, selfOrDescendantWhere } from './pathRange';

// A change made through the virtual drive that Proton Drive has yet to get. Renames and moves name the node and the path
// it now has here (the new folder and name are worked out from it when the operation runs); a trash names the node and
// the path Proton Drive has it at (where it was deleted here, unless renames or moves of it before were still pending).
export type RemoteOp =
    | { id: number; kind: 'rename'; nodeUid: string; toPath: string; attempts: number }
    | { id: number; kind: 'move'; nodeUid: string; toPath: string; attempts: number } // toPath gives the new parent and name
    | { id: number; kind: 'trash'; nodeUid: string; path: string; attempts: number };

// What enqueue takes: an operation without its id and attempts. A rename or move may also say where the node was here.
// Each operation keeps, in its `path`, where Proton Drive has the node: the path given, or, while earlier operations on
// the same node are pending, the one the earliest of them kept (those haven't run, so the cloud still has it there).
// The sync pass and local change handling leave that path alone too, even once an earlier operation is superseded.
export type NewRemoteOp =
    | { kind: 'rename' | 'move'; nodeUid: string; toPath: string; fromPath?: string }
    | { kind: 'trash'; nodeUid: string; path: string };

interface RemoteOpRow {
    id: number;
    kind: RemoteOp['kind'];
    nodeUid: string;
    path: string | null;
    toPath: string | null;
    attempts: number;
}

// The persistent, ordered journal of those changes, in the state database: it survives a crash or a restart, and its
// operations run in the order they were made (spec §5.2).
export class RemoteOpsJournal {
    constructor(private readonly db: Database) {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS remote_ops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                nodeUid TEXT NOT NULL,
                path TEXT,
                toPath TEXT,
                createdAt INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                lastError TEXT
            )
        `);
        this.db.run('CREATE INDEX IF NOT EXISTS remote_ops_node ON remote_ops (nodeUid, id)');
    }

    enqueue(op: NewRemoteOp): number {
        const earliest = this.db
            .query('SELECT path FROM remote_ops WHERE nodeUid = $nodeUid AND path IS NOT NULL ORDER BY id ASC LIMIT 1')
            .get({ $nodeUid: op.nodeUid }) as { path: string } | null;
        const given = op.kind === 'trash' ? op.path : (op.fromPath ?? null);
        const result = this.db
            .query(
                `INSERT INTO remote_ops (kind, nodeUid, path, toPath, createdAt)
                 VALUES ($kind, $nodeUid, $path, $toPath, $createdAt)`,
            )
            .run({
                $kind: op.kind,
                $nodeUid: op.nodeUid,
                $path: earliest?.path ?? given,
                $toPath: op.kind === 'trash' ? null : op.toPath,
                $createdAt: Date.now(),
            });
        return Number(result.lastInsertRowid);
    }

    // In the order they were journalled
    pending(): RemoteOp[] {
        const rows = this.db
            .query('SELECT id, kind, nodeUid, path, toPath, attempts FROM remote_ops ORDER BY id ASC')
            .all() as RemoteOpRow[];
        return rows.map(toOp);
    }

    get(id: number): RemoteOp | null {
        const row = this.db
            .query('SELECT id, kind, nodeUid, path, toPath, attempts FROM remote_ops WHERE id = $id')
            .get({ $id: id }) as RemoteOpRow | null;
        return row ? toOp(row) : null;
    }

    // Whether a later operation on the same node is pending: it decides where the node ends up, or trashes it
    hasLaterOn(id: number, nodeUid: string): boolean {
        return this.db.query('SELECT 1 FROM remote_ops WHERE nodeUid = $nodeUid AND id > $id LIMIT 1').get({ $nodeUid: nodeUid, $id: id }) !== null;
    }

    hasPending(): boolean {
        return this.db.query('SELECT 1 FROM remote_ops LIMIT 1').get() !== null;
    }

    complete(id: number): void {
        this.db.query('DELETE FROM remote_ops WHERE id = $id').run({ $id: id });
    }

    failed(id: number, error: string): void {
        this.db
            .query('UPDATE remote_ops SET attempts = attempts + 1, lastError = $error WHERE id = $id')
            .run({ $id: id, $error: error });
    }

    // A local rename of fromRel to toRel takes along the targets of pending renames and moves at or under it, so they
    // still lead to the same folder or item (say, a move into a folder that has since been renamed here). Returns what
    // they were, for putting back.
    retarget(fromRel: string, toRel: string): Array<{ id: number; toPath: string }> {
        const changed = this.db
            .query(
                `SELECT id, toPath FROM remote_ops WHERE kind != 'trash' AND toPath IS NOT NULL
                     AND (${selfOrDescendantWhere('toPath')})`,
            )
            .all(selfOrDescendant(fromRel)) as Array<{ id: number; toPath: string }>;
        this.db
            .query(
                `UPDATE remote_ops SET toPath = $toRel || substr(toPath, length($fromRel) + 1)
                 WHERE kind != 'trash' AND toPath IS NOT NULL AND (${selfOrDescendantWhere('toPath')})`,
            )
            .run({ $toRel: toRel, $fromRel: fromRel, ...selfOrDescendant(fromRel) });
        return changed;
    }

    setTarget(id: number, toPath: string): void {
        this.db.query("UPDATE remote_ops SET toPath = $toPath WHERE id = $id AND kind != 'trash'").run({ $id: id, $toPath: toPath });
    }

    // Every row as it is, and putting them all back exactly so: undoes journal changes made in one step whose local part
    // then failed.
    snapshot(): unknown[] {
        return this.db.query('SELECT * FROM remote_ops ORDER BY id ASC').all();
    }

    restore(rows: unknown[]): void {
        this.db.transaction(() => {
            this.db.run('DELETE FROM remote_ops');
            const insert = this.db.query(
                `INSERT INTO remote_ops (id, kind, nodeUid, path, toPath, createdAt, attempts, lastError)
                 VALUES ($id, $kind, $nodeUid, $path, $toPath, $createdAt, $attempts, $lastError)`,
            );
            for (const row of rows as Array<Record<string, unknown>>) {
                insert.run({
                    $id: row.id as number,
                    $kind: row.kind as string,
                    $nodeUid: row.nodeUid as string,
                    $path: row.path as string | null,
                    $toPath: row.toPath as string | null,
                    $createdAt: row.createdAt as number,
                    $attempts: row.attempts as number,
                    $lastError: row.lastError as string | null,
                });
            }
        })();
    }

    // The nodes pending operations are about, and the paths they touch: where a node is going, where Proton Drive has it,
    // and, for a move, where it is once moved but not yet renamed (an interrupted replay can leave it there). Until they
    // have run, the sync pass and local change handling leave these alone.
    guard(): { uids: Set<string>; paths: string[] } {
        const rows = this.db.query('SELECT kind, nodeUid, path, toPath FROM remote_ops').all() as Array<{
            kind: RemoteOp['kind'];
            nodeUid: string;
            path: string | null;
            toPath: string | null;
        }>;
        const uids = new Set<string>();
        const paths = new Set<string>();
        for (const row of rows) {
            uids.add(row.nodeUid);
            for (const p of [row.path, row.toPath]) {
                if (p !== null) {
                    paths.add(p);
                }
            }
            if (row.kind === 'move' && row.path !== null && row.toPath !== null) {
                const slash = row.toPath.lastIndexOf('/');
                const name = row.path.slice(row.path.lastIndexOf('/') + 1);
                paths.add(slash === -1 ? name : `${row.toPath.slice(0, slash)}/${name}`);
            }
        }
        return { uids, paths: [...paths] };
    }
}

function toOp(row: RemoteOpRow): RemoteOp {
    if (row.kind === 'trash') {
        return { id: row.id, kind: 'trash', nodeUid: row.nodeUid, path: row.path ?? '', attempts: row.attempts };
    }
    return { id: row.id, kind: row.kind, nodeUid: row.nodeUid, toPath: row.toPath ?? '', attempts: row.attempts };
}
