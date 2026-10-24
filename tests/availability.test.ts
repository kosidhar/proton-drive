import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
