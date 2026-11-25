import type { Database } from 'bun:sqlite';

import type { NodeEntity } from '@protontech/drive-sdk';
import { isProtonDocument, isProtonSheet } from '@protontech/drive-sdk/internal/nodes/mediaTypes';
import { splitNodeUid } from '@protontech/drive-sdk/internal/uids';

import { getName } from '../sdk/node';

// Proton Docs and Sheets are not synced files: the remote index leaves them out and they never reach the local store.
// They are only recorded here, so the virtual drive can show a read-only placeholder for each.
export type DocKind = 'doc' | 'sheet';

export interface DocRecord {
    uid: string;
    parentUid: string;
    name: string;
    kind: DocKind;
    mtimeMs: number;
}

export function docKindOf(node: NodeEntity): DocKind | null {
    if (isProtonDocument(node.mediaType)) {
        return 'doc';
    }
    if (isProtonSheet(node.mediaType)) {
        return 'sheet';
    }
    return null;
}

// The document's record, or null for anything else. The parent is the listing's folder when the node does not name it.
export function docRecordOf(node: NodeEntity, parentUid: string): DocRecord | null {
    const kind = docKindOf(node);
    if (!kind) {
        return null;
    }
    const mtime = node.activeRevision?.claimedModificationTime ?? node.modificationTime;
    return { uid: node.uid, parentUid, name: getName(node), kind, mtimeMs: mtime.getTime() };
}

// The same URL the SDK's getNodeUrl builds (a test pins the SDK's format), without a network call.
export function docUrl(uid: string, kind: DocKind): string {
    const { volumeId, nodeId } = splitNodeUid(uid);
    return `https://docs.proton.me/doc?type=${kind}&mode=open&volumeId=${volumeId}&linkId=${nodeId}`;
}

export function placeholderName(rec: DocRecord): string {
    return `${rec.name}.${rec.kind === 'doc' ? 'protondoc' : 'protonsheet'}`;
}

export function placeholderContent(rec: DocRecord): string {
    return JSON.stringify({ type: rec.kind, url: docUrl(rec.uid, rec.kind), name: rec.name }) + '\n';
}

// The account's Docs and Sheets, keyed by uid, so a document listed under a new folder leaves its old one.
export class DocNodes {
    constructor(private readonly db: Database) {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS doc_nodes (
                uid TEXT PRIMARY KEY,
                parentUid TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                mtimeMs INTEGER NOT NULL
            )
        `);
        this.db.run('CREATE INDEX IF NOT EXISTS idx_doc_nodes_parent ON doc_nodes(parentUid)');
    }

    // Makes `docs` the folder's documents. Each is keyed by uid, so one listed here leaves any other folder it was in.
    replaceChildren(parentUid: string, docs: DocRecord[]): void {
        this.db.transaction(() => {
            const keep = new Set(docs.map((d) => d.uid));
            for (const row of this.listChildren(parentUid)) {
                if (!keep.has(row.uid)) {
                    this.remove(row.uid);
                }
            }
            const upsert = this.db.query(
                `INSERT INTO doc_nodes (uid, parentUid, name, kind, mtimeMs) VALUES ($uid, $parentUid, $name, $kind, $mtimeMs)
                 ON CONFLICT(uid) DO UPDATE SET parentUid = $parentUid, name = $name, kind = $kind, mtimeMs = $mtimeMs`,
            );
            for (const d of docs) {
                upsert.run({ $uid: d.uid, $parentUid: parentUid, $name: d.name, $kind: d.kind, $mtimeMs: d.mtimeMs });
            }
        })();
    }

    remove(uid: string): void {
        this.db.query('DELETE FROM doc_nodes WHERE uid = $uid').run({ $uid: uid });
    }

    listChildren(parentUid: string): DocRecord[] {
        return this.db
            .query('SELECT uid, parentUid, name, kind, mtimeMs FROM doc_nodes WHERE parentUid = $parentUid ORDER BY name, uid')
            .all({ $parentUid: parentUid }) as DocRecord[];
    }

    anyChildren(parentUid: string): boolean {
        return this.db.query('SELECT 1 FROM doc_nodes WHERE parentUid = $parentUid LIMIT 1').get({ $parentUid: parentUid }) !== null;
    }
}
