import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AvailabilityPolicy } from "../src/sync/availability";
import { RemoteIndex, type RemoteIndexEntry } from "../src/sync/remoteIndex";
import { SyncStateDatabase } from "../src/sync/syncStateDb";

function folder(
  uid: string,
  parentUid: string,
  relPath: string,
): RemoteIndexEntry {
  return {
    uid,
    parentUid,
    relPath,
    name: relPath.split("/").pop()!,
    type: "folder",
    size: 0,
    mtimeMs: 0,
    sha1: null,
  };
}

function file(
  uid: string,
  parentUid: string,
  relPath: string,
): RemoteIndexEntry {
  return {
    ...folder(uid, parentUid, relPath),
    type: "file",
    size: 1,
    sha1: "abc",
  };
}

describe("AvailabilityPolicy", () => {
  let tempDir: string;
  let stateDb: SyncStateDatabase;
  let index: RemoteIndex;
  let policy: AvailabilityPolicy;

  function addLocalRecord(relPath: string): void {
    stateDb.upsertItem({
      localRelPath: relPath,
      nodeUid: `uid-${relPath}`,
      parentNodeUid: null,
      type: "file",
      localSha1: "abc",
      remoteSha1: "abc",
      localMtimeMs: 0,
      remoteMtimeMs: 0,
      size: 1,
      syncStatus: "synced",
      lastError: null,
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "proton-drive-availability-"));
    stateDb = new SyncStateDatabase(path.join(tempDir, "state.sqlite"));
    index = new RemoteIndex(stateDb.connection);
    index.setRoot("root");
    index.replaceChildren("root", "", [
      folder("docs", "root", "Docs"),
      folder("music", "root", "Music"),
      folder("photos", "root", "Photos"),
      folder("photos-lc", "root", "photos"),
    ]);
    index.replaceChildren("docs", "Docs", [
      file("a", "docs", "Docs/a.txt"),
      file("b", "docs", "Docs/b.txt"),
      folder("deep", "docs", "Docs/Deep"),
    ]);
    index.replaceChildren("deep", "Docs/Deep", [
      file("c", "deep", "Docs/Deep/c.txt"),
    ]);
    index.replaceChildren("music", "Music", [
      file("s", "music", "Music/s.mp3"),
    ]);
    index.replaceChildren("photos-lc", "photos", [
      file("x", "photos-lc", "photos/x"),
    ]);
    policy = new AvailabilityPolicy(stateDb.connection, index);
  });

  afterEach(async () => {
    stateDb.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("pin inherits and the nearest flag wins", () => {
    policy.setPin("docs", "pinned", false);
    policy.setPin("deep", "unpinned", false);
    expect(policy.isPinned("Docs/a.txt")).toBe(true);
    expect(policy.isPinned("Docs/Deep/c.txt")).toBe(false);
    expect(policy.isPinned("Music/s.mp3")).toBe(false);
  });

  test("clearBelow drops descendant flags", () => {
    policy.setPin("docs", "pinned", false);
    policy.setPin("deep", "unpinned", false);
    policy.setPin("docs", "pinned", true);
    expect(policy.isPinned("Docs/Deep/c.txt")).toBe(true);
    expect(policy.hasPinnedBelow("Docs")).toBe(false);
  });

  test("hasPinnedBelow sees a pin on a descendant but not on the item itself", () => {
    policy.setPin("deep", "pinned", false);
    expect(policy.hasPinnedBelow("Docs")).toBe(true);
    expect(policy.hasPinnedBelow("Docs/Deep")).toBe(false);
  });

  test("folder state follows its contents", () => {
    addLocalRecord("Docs/a.txt");
    addLocalRecord("Docs/b.txt");
    expect(policy.stateOf("Docs")).toBe("online-only");
    addLocalRecord("Docs/Deep/c.txt");
    expect(policy.stateOf("Docs")).toBe("downloaded");
    expect(policy.stateOf("Docs/a.txt")).toBe("downloaded");
    expect(policy.stateOf("Music/s.mp3")).toBe("online-only");
  });

  test("a pinned item reports pinned", () => {
    policy.setPin("docs", "pinned", false);
    expect(policy.stateOf("Docs")).toBe("pinned");
    expect(policy.stateOf("Docs/a.txt")).toBe("pinned");
  });

  test("hide wins over pin and is inherited", () => {
    policy.setPin("deep", "pinned", false);
    policy.setHide("docs", "pending");
    expect(policy.stateOf("Docs/Deep/c.txt")).toBe("hiding");
    expect(policy.hiddenBy("Docs/Deep/c.txt")).toEqual({
      relPath: "Docs",
      hide: "pending",
    });
    expect(policy.pendingHides()).toEqual(["Docs"]);
    expect(policy.isPinned("Docs/Deep/c.txt")).toBe(false);
    policy.setHide("docs", "hidden");
    expect(policy.stateOf("Docs/a.txt")).toBe("hidden");
    expect(policy.pendingHides()).toEqual([]);
    policy.setHide("docs", null);
    expect(policy.hiddenBy("Docs/a.txt")).toBeNull();
  });

  test("flags follow a moved uid", () => {
    policy.setPin("docs", "pinned", false);
    index.upsert(folder("docs", "root", "Archive/Docs"));
    expect(policy.isPinned("Archive/Docs/a.txt")).toBe(true);
    expect(policy.isPinned("Docs/a.txt")).toBe(false);
  });

  test("case-only sibling is unaffected", () => {
    policy.setPin("photos", "pinned", false);
    expect(policy.isPinned("Photos")).toBe(true);
    expect(policy.isPinned("photos/x")).toBe(false);
    expect(policy.stateOf("photos/x")).toBe("online-only");
  });

  test("a path that is not indexed resolves through its nearest indexed ancestor", () => {
    policy.setPin("docs", "pinned", false);
    expect(policy.isPinned("Docs/Deep/new/file.txt")).toBe(true);
    policy.setHide("music", "hidden");
    expect(policy.hiddenBy("Music/new.mp3")).toEqual({
      relPath: "Music",
      hide: "hidden",
    });
    addLocalRecord("Other/local.txt");
    expect(policy.stateOf("Other/local.txt")).toBe("downloaded");
    expect(policy.stateOf("Other/none.txt")).toBe("online-only");
  });

  test("the root covers the whole tree", () => {
    policy.setPin("deep", "pinned", false);
    expect(policy.hasPinnedBelow("")).toBe(true);
    expect(policy.stateOf("")).toBe("online-only");
    policy.setPin("root", "pinned", true);
    expect(policy.hasPinnedBelow("")).toBe(false);
    expect(policy.isPinned("Docs/Deep/c.txt")).toBe(true);
  });
});

describe("AvailabilityPolicy.childStates", () => {
  let tempDir: string;
  let stateDb: SyncStateDatabase;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "proton-drive-childstates-"));
    stateDb = new SyncStateDatabase(path.join(tempDir, "state.sqlite"));
  });

  afterEach(async () => {
    stateDb.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  // A small deterministic generator, so a failure can be replayed by its seed
  function rng(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
  }

  function record(relPath: string): void {
    stateDb.upsertItem({
      localRelPath: relPath,
      nodeUid: `uid-${relPath}`,
      parentNodeUid: null,
      type: "file",
      localSha1: null,
      remoteSha1: null,
      localMtimeMs: 0,
      remoteMtimeMs: 0,
      size: 1,
      syncStatus: "synced",
      lastError: null,
    });
  }

  // Names that sort and slice awkwardly: a prefix of a sibling, a character after '/', an emoji (two UTF-16 units)
  const NAMES = ["a", "a b", "a0", "ab", "é", "😀", "Z", "a.txt", "-"];

  function randomTree(seed: number) {
    const next = rng(seed);
    const index = new RemoteIndex(stateDb.connection);
    const policy = new AvailabilityPolicy(stateDb.connection, index);
    index.setRoot("root");
    const folders: { uid: string; relPath: string }[] = [{ uid: "root", relPath: "" }];
    let n = 0;
    const grow = (parentUid: string, parentRel: string, depth: number) => {
      const names = NAMES.filter(() => next() < 0.5);
      const children: RemoteIndexEntry[] = [];
      for (const name of names) {
        const relPath = parentRel === "" ? name : `${parentRel}/${name}`;
        const uid = `u${n++}`;
        const isFolder = depth < 3 && next() < 0.4;
        children.push(isFolder ? folder(uid, parentUid, relPath) : file(uid, parentUid, relPath));
      }
      index.replaceChildren(parentUid, parentRel, children);
      for (const child of children) {
        if (child.type === "folder") {
          folders.push({ uid: child.uid, relPath: child.relPath });
          grow(child.uid, child.relPath, depth + 1);
        } else if (next() < 0.5) {
          record(child.relPath);
        }
      }
    };
    grow("root", "", 0);
    for (const node of index.listSubtree("")) {
      const roll = next();
      if (roll < 0.1) policy.setPin(node.uid, "pinned", false);
      else if (roll < 0.2) policy.setPin(node.uid, "unpinned", false);
      else if (roll < 0.25 && node.relPath !== "") policy.setHide(node.uid, "hidden");
      else if (roll < 0.28 && node.relPath !== "") policy.setHide(node.uid, "pending");
    }
    return { index, policy, folders };
  }

  test("equals stateOf for every child of every folder, on random trees", () => {
    for (let seed = 1; seed <= 60; seed++) {
      new AvailabilityPolicy(stateDb.connection, new RemoteIndex(stateDb.connection)); // makes the tables
      stateDb.connection.run("DELETE FROM remote_nodes");
      stateDb.connection.run("DELETE FROM availability");
      stateDb.connection.run("DELETE FROM synced_items");
      const { index, policy, folders } = randomTree(seed);
      for (const f of folders) {
        const batched = policy.childStates(f.relPath);
        const children = index.listChildren(f.relPath);
        expect(batched.size).toBe(children.length);
        for (const child of children) {
          const one = policy.stateOf(child.relPath);
          if (batched.get(child.name) !== one) {
            throw new Error(`seed ${seed}: ${child.relPath} is ${one}, batched ${batched.get(child.name)}`);
          }
        }
      }
    }
  });

  test("is empty for a file or a path not in the index", () => {
    const { policy } = randomTree(7);
    expect(policy.childStates("no such folder").size).toBe(0);
    const index = new RemoteIndex(stateDb.connection);
    index.replaceChildren("root", "", [file("f", "root", "only.txt")]);
    expect(policy.childStates("only.txt").size).toBe(0);
  });

  // A fixed number of queries, whatever the size of the folder: counted, not timed, so a busy machine can't fail it (#69)
  test("answers a folder of 5,000 children in as many queries as a folder of 10", () => {
    const index = new RemoteIndex(stateDb.connection);
    const policy = new AvailabilityPolicy(stateDb.connection, index);
    index.setRoot("root");
    index.replaceChildren("root", "", [folder("big", "root", "Big"), folder("small", "root", "Small")]);
    const fill = (uid: string, rel: string, n: number) => {
      const children: RemoteIndexEntry[] = [];
      for (let i = 0; i < n; i++) {
        children.push(i % 10 === 0 ? folder(`${uid}-d${i}`, uid, `${rel}/d${i}`) : file(`${uid}-f${i}`, uid, `${rel}/f${i}.jpg`));
      }
      index.replaceChildren(uid, rel, children);
      for (let i = 0; i < n; i += 3) {
        if (i % 10 !== 0) record(`${rel}/f${i}.jpg`);
      }
    };
    fill("big", "Big", 5000);
    fill("small", "Small", 10);
    // Every way to run SQL on the connection is counted, so a query per child can't slip in through another one
    const queriesFor = (rel: string) => {
      const spies = (["query", "prepare", "run", "exec"] as const).map((method) => spyOn(stateDb.connection, method));
      try {
        const states = policy.childStates(rel);
        return { states, queries: spies.reduce((n, spy) => n + spy.mock.calls.length, 0) };
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    };
    const big = queriesFor("Big");
    const small = queriesFor("Small");
    expect(big.states.size).toBe(5000);
    expect(big.states.get("f3.jpg")).toBe("downloaded");
    expect(big.states.get("f1.jpg")).toBe("online-only");
    expect(small.states.size).toBe(10);
    expect(big.queries).toBe(small.queries);
    expect(big.queries).toBeLessThan(20);
  });
});
