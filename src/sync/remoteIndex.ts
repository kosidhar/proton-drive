import type { Database } from 'bun:sqlite';

import { type NodeEntity, NodeType } from '@protontech/drive-sdk';

import { isUnsupportedRemoteNode } from '../sdk/fileOps';
import { getClaimedSize, getName } from '../sdk/node';
import { selfOrDescendant, selfOrDescendantWhere } from './pathRange';

export interface RemoteIndexEntry {
    uid: string;
    parentUid: string | null;
    relPath: string;
    name: string;
    type: 'file' | 'folder';
    size: number;
    mtimeMs: number;
    sha1: string | null;
}

// Null for nodes the client does not sync (Proton Docs and Sheets).
export function entryFromNode(node: NodeEntity, parentRelPath: string): RemoteIndexEntry | null {
    if (isUnsupportedRemoteNode(node)) {
        return null;
    }
    const name = getName(node);
    const mtime = node.activeRevision?.claimedModificationTime ?? node.modificationTime;
    return {
        uid: node.uid,
        parentUid: node.parentUid ?? null,
        relPath: parentRelPath === '' ? name : `${parentRelPath}/${name}`,
        name,
        type: node.type === NodeType.Folder ? 'folder' : 'file',
        size: getClaimedSize(node) ?? 0,
        mtimeMs: mtime.getTime(),
        sha1: node.activeRevision?.claimedDigests?.sha1 ?? null,
    };
}

// A persistent copy of the remote My files tree, keyed by node uid with a unique relative path ('' for the root).
export class RemoteIndex {
    constructor(private db: Database) {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS remote_nodes (
                uid TEXT PRIMARY KEY,
                parentUid TEXT,
                relPath TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtimeMs INTEGER NOT NULL,
                sha1 TEXT
            )
        `);
        this.db.run('CREATE INDEX IF NOT EXISTS idx_remote_nodes_parent ON remote_nodes(parentUid)');
    }

    setRoot(uid: string): void {
        this.upsert({ uid, parentUid: null, relPath: '', name: '', type: 'folder', size: 0, mtimeMs: 0, sha1: null });
    }

    // Makes `children` the exact child set of the parent; children that are gone lose their whole subtree.
    replaceChildren(parentUid: string, parentRelPath: string, children: RemoteIndexEntry[]): void {
        this.db.transaction(() => {
            const keep = new Set(children.map((child) => child.uid));
            const existing = this.db
                .query('SELECT uid FROM remote_nodes WHERE parentUid = $parentUid')
                .all({ $parentUid: parentUid }) as { uid: string }[];
            for (const row of existing) {
                if (!keep.has(row.uid)) {
                    this.removeSubtree(row.uid);
                }
            }
            for (const child of children) {
                this.upsert({ ...child, parentUid, relPath: parentRelPath === '' ? child.name : `${parentRelPath}/${child.name}` });
            }
        })();
    }

    // A node that already exists at another path takes its whole subtree along.
    upsert(entry: RemoteIndexEntry): void {
        this.db.transaction(() => {
            const previous = this.getByUid(entry.uid);
            // Whatever else sits at the target path is stale: the tree has just told us this node is there.
            const occupant = this.getByPath(entry.relPath);
            if (occupant && occupant.uid !== entry.uid) {
                this.removeSubtree(occupant.uid);
            }
            if (previous && previous.relPath !== entry.relPath) {
                this.db
                    .query(
                        `UPDATE remote_nodes SET relPath = $newPath || substr(relPath, length($oldPath) + 1)
                         WHERE relPath >= $lo AND relPath < $hi`,
                    )
                    .run({ $newPath: entry.relPath, $oldPath: previous.relPath, ...rangeBelow(previous.relPath) });
            }
            this.db
                .query(
                    `INSERT INTO remote_nodes (uid, parentUid, relPath, name, type, size, mtimeMs, sha1)
                     VALUES ($uid, $parentUid, $relPath, $name, $type, $size, $mtimeMs, $sha1)
                     ON CONFLICT(uid) DO UPDATE SET parentUid = $parentUid, relPath = $relPath, name = $name,
                         type = $type, size = $size, mtimeMs = $mtimeMs, sha1 = $sha1`,
                )
                .run({
                    $uid: entry.uid,
                    $parentUid: entry.parentUid,
                    $relPath: entry.relPath,
                    $name: entry.name,
                    $type: entry.type,
                    $size: entry.size,
                    $mtimeMs: entry.mtimeMs,
                    $sha1: entry.sha1,
                });
        })();
    }

    removeSubtree(uid: string): void {
        const node = this.getByUid(uid);
        if (!node) {
            return;
        }
        this.db
            .query(`DELETE FROM remote_nodes WHERE ${selfOrDescendantWhere('relPath')}`)
            .run(selfOrDescendant(node.relPath));
    }

    getByUid(uid: string): RemoteIndexEntry | null {
        return (this.db.query('SELECT * FROM remote_nodes WHERE uid = $uid').get({ $uid: uid }) as RemoteIndexEntry | null) ?? null;
    }

    getByPath(relPath: string): RemoteIndexEntry | null {
        return (
            (this.db.query('SELECT * FROM remote_nodes WHERE relPath = $relPath').get({ $relPath: relPath }) as RemoteIndexEntry | null) ??
            null
        );
    }

    listChildren(relPath: string): RemoteIndexEntry[] {
        const parent = this.getByPath(relPath);
        if (!parent) {
            return [];
        }
        return this.db
            .query('SELECT * FROM remote_nodes WHERE parentUid = $parentUid ORDER BY relPath ASC')
            .all({ $parentUid: parent.uid }) as RemoteIndexEntry[];
    }
}

// Strict descendants of a path (not the path itself).
function rangeBelow(relPath: string) {
    return { $lo: `${relPath}/`, $hi: `${relPath}0` };
}
