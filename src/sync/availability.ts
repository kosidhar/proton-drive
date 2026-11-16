import type { Database } from "bun:sqlite";

import { type RemoteIndex, type RemoteIndexEntry } from "./remoteIndex";
import { selfOrDescendant, selfOrDescendantWhere } from "./pathRange";

export type PinFlag = "pinned" | "unpinned";
export type HideFlag = "pending" | "hidden";
// partial: a folder with some of its files on this computer and some not (#183); never a file
export type ItemAvailability =
  "pinned" | "downloaded" | "partial" | "online-only" | "hidden" | "hiding";

// Pin and hide flags per remote node uid, so they follow a node when it moves. A flag applies to everything below its
// node until a nearer flag overrides it; hide wins over pin. Paths that are not indexed yet (local items waiting for
// their upload) resolve through their nearest indexed ancestor.
export class AvailabilityPolicy {
  // Told of every subtree whose state may have changed, for the file manager's emblems (see StateEvents)
  onChange: ((relPath: string, subtree: boolean) => void) | null = null;

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
    this.changedBelow(uid);
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
    this.changedBelow(uid);
  }

  private changedBelow(uid: string): void {
    const node = this.index.getByUid(uid);
    if (node) {
      this.onChange?.(node.relPath, true);
    }
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

  // How many items in Proton Drive below the top level carry their own Always keep mark, and whether the top level
  // itself does (by its own flag: the engine adds the pin a fresh install's first sync is still to make). An item hidden
  // or being hidden keeps its own pin row, but nothing of it is kept here, so it isn't counted; the top level is never
  // hidden. Reads only.
  pinnedSummary(): { items: number; wholeDrive: boolean } {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS items FROM availability a JOIN remote_nodes n ON n.uid = a.nodeUid
                 WHERE a.pin = 'pinned' AND a.hide IS NULL AND n.relPath != ''`,
      )
      .get() as { items: number };
    return { items: row.items, wholeDrive: this.isPinned("") };
  }

  stateOf(relPath: string): ItemAvailability {
    const hidden = this.hiddenBy(relPath);
    if (hidden) {
      return hidden.hide === "pending" ? "hiding" : "hidden";
    }
    // Always keep means it and everything inside it stay here, new arrivals included: a pinned folder with something
    // freed inside it isn't that any more, and reads by its contents like any other folder (#175). Its pin still
    // applies to the rest of it (isPinned).
    if (this.isPinned(relPath) && !this.unpinnedBelow(relPath)) {
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
      // Downloaded: nothing below it is missing here, and it is here at all (it, or something in it, is recorded). A
      // folder whose contents aren't indexed yet has nothing below it to be missing, and may have nothing here (#17)
      if (missing === null) {
        return this.anythingHere(relPath) ? "downloaded" : "online-only";
      }
      // Partly here: something is missing, and some file below it is on this computer (#183). A folder of its own
      // doesn't count: an online-only folder can still have its folders here
      return this.filesHereBelow(relPath) ? "partial" : "online-only";
    }
    return this.hasLocalCopy(relPath) ? "downloaded" : "online-only";
  }

  // The state of every indexed child of a folder, by name, as stateOf gives it, in a fixed number of queries (a folder
  // of thousands of files is listed at once in the file manager). Empty for a path that isn't an indexed folder.
  childStates(folderRel: string): Map<string, ItemAvailability> {
    const out = new Map<string, ItemAvailability>();
    const folder = this.index.getByPath(folderRel);
    if (!folder || folder.type !== "folder") {
      return out;
    }
    const children = this.db
      .query(
        `SELECT n.name, n.type, a.pin, a.hide FROM remote_nodes n LEFT JOIN availability a ON a.nodeUid = n.uid
                 WHERE n.parentUid = $uid`,
      )
      .all({ $uid: folder.uid }) as {
      name: string;
      type: string;
      pin: string | null;
      hide: string | null;
    }[];
    const hiddenAbove = this.hiddenBy(folderRel);
    const pinnedAbove = this.isPinned(folderRel);
    const missing = this.childrenMissingFiles(folderRel);
    const here = this.childrenWithAnythingHere(folderRel);
    const freedInside = this.childrenWithUnpinnedBelow(folderRel);
    const filesBelow = this.childrenWithFilesBelow(folderRel);
    for (const child of children) {
      // The nearest hide flag wins, the child's own first, as stateOf has it
      if (child.hide) {
        out.set(child.name, child.hide === "pending" ? "hiding" : "hidden");
      } else if (hiddenAbove) {
        out.set(child.name, hiddenAbove.hide === "pending" ? "hiding" : "hidden");
      } else if ((child.pin ? child.pin === "pinned" : pinnedAbove) && !freedInside.has(child.name)) {
        out.set(child.name, "pinned");
      } else {
        out.set(child.name, this.contentsState(child.type, missing.has(child.name), here.has(child.name), filesBelow.has(child.name)));
      }
    }
    return out;
  }

  // An unpinned item's state from what of it is here, as stateOf has it: a folder with something missing is partial
  // when some file below it is here
  private contentsState(type: string, missing: boolean, here: boolean, filesBelow: boolean): ItemAvailability {
    if (!missing) {
      return here ? "downloaded" : "online-only";
    }
    return type === "folder" && filesBelow ? "partial" : "online-only";
  }

  // Whether a file below a path (not the path itself) is recorded as being on this computer
  private filesHereBelow(relPath: string): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM synced_items s WHERE s.type = 'file' AND s.localRelPath != $path
                     AND ${this.range("s.localRelPath", relPath)} LIMIT 1`,
        )
        .get(this.rangeParams(relPath)) !== null
    );
  }

  // The names of a folder's children with a file below them (not the child itself) recorded as being here
  private childrenWithFilesBelow(folderRel: string): Set<string> {
    const prefix = folderRel === "" ? "" : `${folderRel}/`;
    const below =
      folderRel === ""
        ? "s.localRelPath != ''"
        : "(s.localRelPath >= $lo AND s.localRelPath < $hi)";
    const rows = this.db
      .query(
        `SELECT DISTINCT substr(rest, 1, instr(rest, '/') - 1) AS name
                 FROM (SELECT substr(s.localRelPath, length($prefix) + 1) AS rest FROM synced_items s
                       WHERE s.type = 'file' AND ${below})
                 WHERE instr(rest, '/') > 0`,
      )
      .all({
        // SQLite measures the prefix in characters, as substr counts them (a JS length counts UTF-16 units)
        $prefix: prefix,
        ...(folderRel === "" ? {} : { $lo: prefix, $hi: `${folderRel}0` }),
      }) as { name: string }[];
    return new Set(rows.map((row) => row.name));
  }

  // Whether any indexed descendant (not the item itself) is explicitly unpinned: freed inside a pinned folder
  private unpinnedBelow(relPath: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM remote_nodes n JOIN availability a ON a.nodeUid = n.uid
                 WHERE a.pin = 'unpinned' AND n.relPath != $path AND ${this.range("n.relPath", relPath)} LIMIT 1`,
      )
      .get(this.rangeParams(relPath));
    return row !== null;
  }

  // The names of a folder's children with an explicitly unpinned descendant (below the child, not the child itself)
  private childrenWithUnpinnedBelow(folderRel: string): Set<string> {
    const prefix = folderRel === "" ? "" : `${folderRel}/`;
    const below =
      folderRel === ""
        ? "n.relPath != ''"
        : "(n.relPath >= $lo AND n.relPath < $hi)";
    const rows = this.db
      .query(
        `SELECT DISTINCT substr(rest, 1, instr(rest, '/') - 1) AS name
                 FROM (SELECT substr(n.relPath, length($prefix) + 1) AS rest FROM remote_nodes n
                       JOIN availability a ON a.nodeUid = n.uid
                       WHERE a.pin = 'unpinned' AND ${below})
                 WHERE instr(rest, '/') > 0`,
      )
      .all({
        // SQLite measures the prefix in characters, as substr counts them (a JS length counts UTF-16 units)
        $prefix: prefix,
        ...(folderRel === "" ? {} : { $lo: prefix, $hi: `${folderRel}0` }),
      }) as { name: string }[];
    return new Set(rows.map((row) => row.name));
  }

  // Whether anything at or below a path is recorded as being on this computer
  private anythingHere(relPath: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM synced_items s WHERE ${this.range("s.localRelPath", relPath)} LIMIT 1`)
        .get(this.rangeParams(relPath)) !== null
    );
  }

  // The names of a folder's children that are, or hold, something recorded as being on this computer
  private childrenWithAnythingHere(folderRel: string): Set<string> {
    const prefix = folderRel === "" ? "" : `${folderRel}/`;
    const below =
      folderRel === ""
        ? "s.localRelPath != ''"
        : "(s.localRelPath >= $lo AND s.localRelPath < $hi)";
    const rows = this.db
      .query(
        `SELECT DISTINCT CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS name
                 FROM (SELECT substr(s.localRelPath, length($prefix) + 1) AS rest FROM synced_items s WHERE ${below})`,
      )
      .all({
        // SQLite measures the prefix in characters, as substr counts them (a JS length counts UTF-16 units)
        $prefix: prefix,
        ...(folderRel === "" ? {} : { $lo: prefix, $hi: `${folderRel}0` }),
      }) as { name: string }[];
    return new Set(rows.map((row) => row.name));
  }

  // The names of a folder's children that are, or hold, a file with no local copy
  private childrenMissingFiles(folderRel: string): Set<string> {
    const prefix = folderRel === "" ? "" : `${folderRel}/`;
    const below =
      folderRel === ""
        ? "n.relPath != ''"
        : "(n.relPath >= $lo AND n.relPath < $hi)";
    const rows = this.db
      .query(
        `SELECT DISTINCT CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS name
                 FROM (SELECT substr(n.relPath, length($prefix) + 1) AS rest FROM remote_nodes n
                       WHERE n.type = 'file' AND ${below}
                         AND NOT EXISTS (SELECT 1 FROM synced_items s WHERE s.localRelPath = n.relPath))`,
      )
      .all({
        // SQLite measures the prefix in characters, as substr counts them (a JS length counts UTF-16 units)
        $prefix: prefix,
        ...(folderRel === "" ? {} : { $lo: prefix, $hi: `${folderRel}0` }),
      }) as { name: string }[];
    return new Set(rows.map((row) => row.name));
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

  // Every item hidden or being hidden, by its own flag (a hide supersedes the flags below it, so none is listed twice),
  // sorted by path.
  hiddenItems(): { relPath: string; hide: HideFlag }[] {
    return this.db
      .query(
        `SELECT n.relPath AS relPath, a.hide AS hide FROM availability a JOIN remote_nodes n ON n.uid = a.nodeUid
                 WHERE a.hide IS NOT NULL ORDER BY n.relPath ASC`,
      )
      .all() as { relPath: string; hide: HideFlag }[];
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
