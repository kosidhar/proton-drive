import type { Database } from "bun:sqlite";

import { type RemoteIndex, type RemoteIndexEntry } from "./remoteIndex";
import { selfOrDescendant, selfOrDescendantWhere } from "./pathRange";

export type PinFlag = "pinned" | "unpinned";
export type HideFlag = "pending" | "hidden";
export type ItemAvailability =
  "pinned" | "downloaded" | "online-only" | "hidden" | "hiding";

// Pin and hide flags per remote node uid, so they follow a node when it moves. A flag applies to everything below its
// node until a nearer flag overrides it; hide wins over pin. Paths that are not indexed yet (local items waiting for
// their upload) resolve through their nearest indexed ancestor.
export class AvailabilityPolicy {
  constructor(
    private db: Database,
    private index: RemoteIndex,
  ) {
    this.db.run(`
            CREATE TABLE IF NOT EXISTS availability (
                nodeUid TEXT PRIMARY KEY,
                pin TEXT,
                hide TEXT
            )
        `);
  }

  // clearBelow also drops the pin flags of every indexed descendant, so the new flag applies to the whole subtree.
  setPin(uid: string, pin: PinFlag | null, clearBelow: boolean): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO availability (nodeUid, pin) VALUES ($uid, $pin)
                     ON CONFLICT(nodeUid) DO UPDATE SET pin = $pin`,
        )
        .run({ $uid: uid, $pin: pin });
      if (clearBelow) {
        this.clearBelow(uid, "pin = NULL");
      }
      this.dropEmptyRows();
    })();
  }

  // A hide supersedes everything beneath it, so the descendants' own flags are dropped.
  setHide(uid: string, hide: HideFlag | null): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO availability (nodeUid, hide) VALUES ($uid, $hide)
                     ON CONFLICT(nodeUid) DO UPDATE SET hide = $hide`,
        )
        .run({ $uid: uid, $hide: hide });
      if (hide !== null) {
        this.clearBelow(uid, "pin = NULL, hide = NULL");
      }
      this.dropEmptyRows();
    })();
  }

  isPinned(relPath: string): boolean {
    for (const node of this.chainOf(relPath)) {
      const pin = this.flags(node.uid)?.pin;
      if (pin) {
        return pin === "pinned";
      }
    }
    return false;
  }

  hiddenBy(relPath: string): { relPath: string; hide: HideFlag } | null {
    for (const node of this.chainOf(relPath)) {
      const hide = this.flags(node.uid)?.hide as HideFlag | null | undefined;
      if (hide) {
        return { relPath: node.relPath, hide };
      }
    }
    return null;
  }

  // Whether any indexed descendant (not the item itself) carries an explicit pin.
  hasPinnedBelow(relPath: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM remote_nodes n JOIN availability a ON a.nodeUid = n.uid
                 WHERE a.pin = 'pinned' AND n.relPath != $path AND ${this.range("n.relPath", relPath)}`,
      )
      .get(this.rangeParams(relPath));
    return row !== null;
  }

  stateOf(relPath: string): ItemAvailability {
    const hidden = this.hiddenBy(relPath);
    if (hidden) {
      return hidden.hide === "pending" ? "hiding" : "hidden";
    }
    if (this.isPinned(relPath)) {
      return "pinned";
    }
    if (this.index.getByPath(relPath)?.type === "folder") {
      const missing = this.db
        .query(
          `SELECT 1 FROM remote_nodes n
                     WHERE n.type = 'file' AND ${this.range("n.relPath", relPath)}
                       AND NOT EXISTS (SELECT 1 FROM synced_items s WHERE s.localRelPath = n.relPath)`,
        )
        .get(this.rangeParams(relPath));
      return missing === null ? "downloaded" : "online-only";
    }
    return this.hasLocalCopy(relPath) ? "downloaded" : "online-only";
  }

  // Nodes at or below relPath that are hidden or being hidden, as their paths.
  hiddenWithin(relPath: string): string[] {
    const rows = this.db
      .query(
        `SELECT n.relPath FROM availability a JOIN remote_nodes n ON n.uid = a.nodeUid
                 WHERE a.hide IS NOT NULL AND ${this.range("n.relPath", relPath)} ORDER BY n.relPath ASC`,
      )
      .all(this.rangeParams(relPath)) as { relPath: string }[];
    return rows.map((row) => row.relPath);
  }

  pendingHides(): string[] {
    const rows = this.db
      .query(
        `SELECT n.relPath FROM availability a JOIN remote_nodes n ON n.uid = a.nodeUid
                 WHERE a.hide = 'pending' ORDER BY n.relPath ASC`,
      )
      .all() as { relPath: string }[];
    return rows.map((row) => row.relPath);
  }

  // The item (or its nearest indexed ancestor) first, then up through the parents to the root.
  private chainOf(relPath: string): RemoteIndexEntry[] {
    let start: RemoteIndexEntry | null = null;
    let path = relPath;
    while (!(start = this.index.getByPath(path))) {
      if (path === "") {
        return [];
      }
      const slash = path.lastIndexOf("/");
      path = slash === -1 ? "" : path.slice(0, slash);
    }
    const chain: RemoteIndexEntry[] = [];
    const seen = new Set<string>();
    for (
      let node: RemoteIndexEntry | null = start;
      node && !seen.has(node.uid);
      node = node.parentUid ? this.index.getByUid(node.parentUid) : null
    ) {
      seen.add(node.uid);
      chain.push(node);
    }
    return chain;
  }

  private flags(
    uid: string,
  ): { pin: string | null; hide: string | null } | null {
    return this.db
      .query("SELECT pin, hide FROM availability WHERE nodeUid = $uid")
      .get({ $uid: uid }) as {
      pin: string | null;
      hide: string | null;
    } | null;
  }

  private hasLocalCopy(relPath: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM synced_items WHERE localRelPath = $relPath")
        .get({ $relPath: relPath }) !== null
    );
  }

  private clearBelow(uid: string, assignments: string): void {
    const node = this.index.getByUid(uid);
    if (!node) {
      return;
    }
    this.db
      .query(
        `UPDATE availability SET ${assignments} WHERE nodeUid != $uid AND nodeUid IN (
                     SELECT uid FROM remote_nodes WHERE ${this.range("relPath", node.relPath)})`,
      )
      .run({ $uid: uid, ...this.rangeParams(node.relPath) });
  }

  private dropEmptyRows(): void {
    this.db.run("DELETE FROM availability WHERE pin IS NULL AND hide IS NULL");
  }

  // The root has the empty path, which would make the byte range miss its children, so it matches every row.
  private range(column: string, relPath: string): string {
    return relPath === "" ? "1 = 1" : `(${selfOrDescendantWhere(column)})`;
  }

  private rangeParams(relPath: string) {
    return relPath === "" ? { $path: "" } : selfOrDescendant(relPath);
  }
}
