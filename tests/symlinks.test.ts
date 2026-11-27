import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeType } from '@protontech/drive-sdk';

import { ensureNoSymlinkDir, findSymlinkInPath, SymlinkPathError } from '../src/sync/localPath';
import { LocalFolderWatcher } from '../src/sync/localWatcher';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { roomyDisk, uploadAtOnce } from './helpers/engineOptions';
import { makeMockDrive, type MockNode } from './helpers/mockDrive';
import { makeMockNode } from './helpers/mockNodes';

describe('symlink path guards (#540)', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'protondrive-symlink-guard-'));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('findSymlinkInPath detects a symlink at the leaf or any ancestor, while allowing a symlinked root', async () => {
        const realRoot = path.join(tempDir, 'real-root');
        const linkRoot = path.join(tempDir, 'link-root');
        const outside = path.join(tempDir, 'outside');
        await mkdir(path.join(realRoot, 'Shared'), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(path.join(outside, 'secret.txt'), 'secret');
        await symlink(realRoot, linkRoot);
        await symlink(outside, path.join(realRoot, 'Shared', 'cfg'));
        await symlink(path.join(outside, 'secret.txt'), path.join(realRoot, 'Shared', 'filelink.txt'));
        await symlink(path.join(tempDir, 'does-not-exist'), path.join(realRoot, 'Shared', 'dangling'));
        await symlink(path.join(realRoot, 'Shared'), path.join(realRoot, 'Shared', 'loop'));
        await writeFile(path.join(realRoot, 'Shared', 'plain.txt'), 'not a dir');

        for (const root of [realRoot, linkRoot]) {
            expect(findSymlinkInPath(root, '')).toBeNull();
            expect(findSymlinkInPath(root, 'Shared')).toBeNull();
            expect(findSymlinkInPath(root, 'Shared/new/sub/a.txt')).toBeNull();
            // Ancestor is a regular file: must return null instead of throwing ENOTDIR
            expect(findSymlinkInPath(root, 'Shared/plain.txt/nested/child.txt')).toBeNull();
            expect(findSymlinkInPath(root, 'Shared/cfg')).toBe('Shared/cfg');
            expect(findSymlinkInPath(root, 'Shared/cfg/autostart/x.desktop')).toBe('Shared/cfg');
            expect(findSymlinkInPath(root, 'Shared/filelink.txt')).toBe('Shared/filelink.txt');
            expect(findSymlinkInPath(root, 'Shared/dangling')).toBe('Shared/dangling');
            expect(findSymlinkInPath(root, 'Shared/loop/a.txt')).toBe('Shared/loop');
        }
    });

    test('ensureNoSymlinkDir creates regular directories and refuses to traverse a symlink', async () => {
        const root = path.join(tempDir, 'root');
        const outside = path.join(tempDir, 'outside');
        await mkdir(path.join(root, 'Shared'), { recursive: true });
        await mkdir(outside, { recursive: true });
        await symlink(outside, path.join(root, 'Shared', 'cfg'));

        const created = await ensureNoSymlinkDir(root, 'Shared/real/nested');
        expect(created).toBe(path.join(root, 'Shared', 'real', 'nested'));
        expect(lstatSync(created).isDirectory()).toBe(true);

        await expect(ensureNoSymlinkDir(root, 'Shared/cfg')).rejects.toThrow(SymlinkPathError);
        await expect(ensureNoSymlinkDir(root, 'Shared/cfg/autostart')).rejects.toThrow(SymlinkPathError);
        expect(readdirSync(outside)).toEqual([]);
    });
});

describe('symlinks inside the sync folder are never followed (#540)', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'protondrive-symlinks-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
        stateDb.updateSettings({ syncDir: path.join(tempDir, 'ProtonDrive'), notificationsEnabled: false });
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    const snapshotDir = (dir: string): string[] => {
        const out: string[] = [];
        const walk = (cur: string) => {
            for (const name of readdirSync(cur).sort()) {
                const full = path.join(cur, name);
                const st = lstatSync(full);
                const rel = path.relative(dir, full);
                if (st.isDirectory()) {
                    out.push(`${rel}/`);
                    walk(full);
                } else if (st.isSymbolicLink()) {
                    out.push(`${rel} -> ${readlinkSync(full)}`);
                } else {
                    out.push(`${rel}: ${readFileSync(full, 'utf8')}`);
                }
            }
        };
        walk(dir);
        return out;
    };

    for (const layout of ['plain', 'virtual'] as const) {
        describe(`${layout} layout`, () => {
            const setup = async () => {
                if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
                const backingDir = path.join(tempDir, 'files');
                const root = layout === 'virtual' ? backingDir : stateDb.getSettings().syncDir;
                const outsideCfg = path.join(tempDir, 'outside-cfg');
                const outsideFile = path.join(tempDir, 'outside-file.txt');
                await mkdir(path.join(root, 'Shared'), { recursive: true });
                await mkdir(outsideCfg, { recursive: true });
                await writeFile(path.join(outsideCfg, 'secret.txt'), 'top-secret');
                await writeFile(outsideFile, 'private-file');

                const drive = makeMockDrive({ slashFreeUids: true });
                const warnings: string[] = [];
                const origWarn = drive.logger.warn.bind(drive.logger);
                drive.logger.warn = (msg: string) => {
                    warnings.push(msg);
                    return origWarn(msg);
                };
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    ...uploadAtOnce,
                    ...roomyDisk,
                    ...(layout === 'virtual' ? { backingDir } : {}),
                    moveToDesktopTrash: async () => false,
                    forgetFailedThumbnail: async () => {},
                });
                const addNode = (uid: string, parentUid: string, name: string, content?: string): MockNode => {
                    const node = makeMockNode({
                        uid,
                        parentUid,
                        nameStr: name,
                        type: content === undefined ? NodeType.Folder : NodeType.File,
                        content,
                    }) as MockNode;
                    drive.nodes.set(uid, node);
                    return node;
                };
                return { ...drive, engine, root, outsideCfg, outsideFile, warnings, addNode };
            };

            test('a linked folder outside the root is never uploaded, never written through by a collaborator, and reports as skipped', async () => {
                const d = await setup();
                await writeFile(path.join(d.root, 'Shared', 'ok.txt'), 'ok');
                await symlink(d.outsideCfg, path.join(d.root, 'Shared', 'cfg'));
                const beforeOutside = snapshotDir(d.outsideCfg);

                await d.engine.reconcileNow();

                // Regular file uploaded; symlinked folder and its contents never uploaded
                expect(d.calls.uploads).toEqual(['Shared/ok.txt']);
                expect(Array.from(d.nodes.values()).some((n) => n.name.ok && (n.name.value === 'cfg' || n.name.value === 'secret.txt'))).toBe(false);
                expect(snapshotDir(d.outsideCfg)).toEqual(beforeOutside);
                expect(d.engine.itemStates('Shared')!.children.cfg).toBeNull();

                // App reports that the link was skipped (in warnings and activity), once
                expect(d.warnings.some((w) => w.includes('Shared/cfg') && w.toLowerCase().includes('symbolic link'))).toBe(true);
                const activityBefore = stateDb.listActivity(50).filter((a) => a.localRelPath === 'Shared/cfg');
                expect(activityBefore.length).toBe(1);
                expect(activityBefore[0]!.details.toLowerCase()).toContain('symbolic link');

                // Now a collaborator adds Shared/cfg/autostart/x.desktop in Proton Drive and Shared is pinned
                const sharedUid = d.engine.remoteIndex.getByPath('Shared')!.uid;
                d.engine.availability.setPin(sharedUid, 'pinned', false);
                d.addNode('vol~cfg', sharedUid, 'cfg');
                d.addNode('vol~autostart', 'vol~cfg', 'autostart');
                d.addNode('vol~desktop', 'vol~autostart', 'x.desktop', '[Desktop Entry]\nExec=evil');

                await d.engine.reconcileNow();

                // Collaborator's file MUST NOT be written into outside-cfg, symlink stays intact, activity does not flood
                expect(snapshotDir(d.outsideCfg)).toEqual(beforeOutside);
                expect(lstatSync(path.join(d.root, 'Shared', 'cfg')).isSymbolicLink()).toBe(true);
                expect(d.calls.downloads).toEqual([]);
                expect(stateDb.listActivity(50).filter((a) => a.localRelPath === 'Shared/cfg').length).toBe(1);

                // In virtual layout, hydrating, deleting, renaming, truncating, freeing or hiding under a symlinked
                // folder must never touch or delete anything outside the sync root
                if (layout === 'virtual') {
                    await writeFile(path.join(d.outsideCfg, 'secret.txt'), 'top-secret');
                    await mkdir(path.join(d.outsideCfg, 'autostart'), { recursive: true });
                    await writeFile(path.join(d.outsideCfg, 'autostart', 'x.desktop'), 'keep-me');
                    const outsideWithAutostart = snapshotDir(d.outsideCfg);

                    await expect(d.engine.hydrate('Shared/cfg/autostart/x.desktop')).rejects.toThrow();
                    await expect(d.engine.deleteItem('Shared/cfg/autostart/x.desktop', { trash: true })).rejects.toThrow();
                    await expect(d.engine.deleteItem('Shared/cfg/autostart', { trash: true })).rejects.toThrow();
                    await expect(d.engine.renameItem('Shared/ok.txt', 'Shared/cfg/autostart/moved.txt')).rejects.toThrow();
                    await expect(d.engine.renameItem('Shared/cfg/secret.txt', 'Shared/stolen.txt')).rejects.toThrow();
                    await expect(d.engine.truncateItem('Shared/cfg/autostart/x.desktop')).rejects.toThrow();
                    await d.engine.setAvailability('Shared/cfg/autostart/x.desktop', 'free').catch(() => {});
                    await d.engine.setAvailability('Shared/cfg/autostart', 'hide').catch(() => {});

                    expect(snapshotDir(d.outsideCfg)).toEqual(outsideWithAutostart);
                    expect(lstatSync(path.join(d.root, 'Shared', 'cfg')).isSymbolicLink()).toBe(true);
                }

                await d.engine.stop();
            });

            test('replacing an already-synced file or folder with a symlink neither trashes the cloud item nor overwrites the link', async () => {
                const d = await setup();
                await writeFile(path.join(d.root, 'Shared', 'keep.txt'), 'original');
                await mkdir(path.join(d.root, 'Shared', 'Sub'), { recursive: true });
                await writeFile(path.join(d.root, 'Shared', 'Sub', 'inner.txt'), 'inner');
                await d.engine.reconcileNow();

                // Replace the synced file and folder with symlinks pointing outside
                await rm(path.join(d.root, 'Shared', 'keep.txt'));
                await symlink(d.outsideFile, path.join(d.root, 'Shared', 'keep.txt'));
                await rm(path.join(d.root, 'Shared', 'Sub'), { recursive: true });
                await symlink(d.outsideCfg, path.join(d.root, 'Shared', 'Sub'));

                await d.engine.reconcileNow();

                expect(d.calls.trashed).toEqual([]);
                expect(await readFile(d.outsideFile, 'utf8')).toBe('private-file');
                expect(lstatSync(path.join(d.root, 'Shared', 'keep.txt')).isSymbolicLink()).toBe(true);
                expect(lstatSync(path.join(d.root, 'Shared', 'Sub')).isSymbolicLink()).toBe(true);
                await d.engine.stop();
            });

            test('conflict resolution refuses a file or parent replaced with a symlink and leaves outside files untouched', async () => {
                const d = await setup();
                await writeFile(path.join(d.root, 'Shared', 'doc.txt'), 'v1');
                await d.engine.reconcileNow();
                const docUid = d.engine.remoteIndex.getByPath('Shared/doc.txt')!.uid;
                const conflict = stateDb.recordConflict({
                    localRelPath: 'Shared/doc.txt',
                    nodeUid: docUid,
                    localSha1: 'a',
                    remoteSha1: 'b',
                    localMtimeMs: 1,
                    remoteMtimeMs: 2,
                });
                await rm(path.join(d.root, 'Shared', 'doc.txt'));
                await symlink(d.outsideFile, path.join(d.root, 'Shared', 'doc.txt'));

                const uploadsBefore = d.calls.uploads.length;
                await expect(d.engine.resolveConflictManually(conflict.id, 'keep-both')).rejects.toThrow();
                await expect(d.engine.resolveConflictManually(conflict.id, 'keep-local')).rejects.toThrow();
                await expect(d.engine.resolveConflictManually(conflict.id, 'keep-remote')).rejects.toThrow();

                expect(d.calls.uploads.length).toBe(uploadsBefore);
                expect(await readFile(d.outsideFile, 'utf8')).toBe('private-file');
                expect(lstatSync(path.join(d.root, 'Shared', 'doc.txt')).isSymbolicLink()).toBe(true);
                await d.engine.stop();
            });

            test('a linked file outside the root is never uploaded and never overwritten by a remote file of the same name', async () => {
                const d = await setup();
                await writeFile(path.join(d.root, 'Shared', 'ok.txt'), 'ok');
                await symlink(d.outsideFile, path.join(d.root, 'Shared', 'link.txt'));

                await d.engine.reconcileNow();

                expect(d.calls.uploads).toEqual(['Shared/ok.txt']);
                expect(await readFile(d.outsideFile, 'utf8')).toBe('private-file');
                expect(lstatSync(path.join(d.root, 'Shared', 'link.txt')).isSymbolicLink()).toBe(true);
                expect(d.engine.itemStates('Shared')!.children['link.txt']).toBeNull();

                // Collaborator creates Shared/link.txt while Shared is pinned -> outside target and symlink stay untouched
                const sharedUid = d.engine.remoteIndex.getByPath('Shared')!.uid;
                d.engine.availability.setPin(sharedUid, 'pinned', false);
                d.addNode('vol~link', sharedUid, 'link.txt', 'collaborator-content');

                await d.engine.reconcileNow();

                expect(await readFile(d.outsideFile, 'utf8')).toBe('private-file');
                expect(lstatSync(path.join(d.root, 'Shared', 'link.txt')).isSymbolicLink()).toBe(true);
                expect(d.calls.downloads).toEqual([]);
                await d.engine.stop();
            });

            test('handleLocalFileChange and LocalFolderWatcher never follow symlinks', async () => {
                const d = await setup();
                await symlink(d.outsideCfg, path.join(d.root, 'Shared', 'cfg'));
                await symlink(d.outsideFile, path.join(d.root, 'Shared', 'link.txt'));
                await d.engine.reconcileNow();

                const handleLocal = (d.engine as unknown as { handleLocalFileChange(rel: string): Promise<void> }).handleLocalFileChange.bind(d.engine);
                await handleLocal('Shared/cfg');
                await handleLocal('Shared/cfg/secret.txt');
                await handleLocal('Shared/link.txt');

                expect(d.calls.uploads).toEqual([]);
                expect(await readFile(d.outsideFile, 'utf8')).toBe('private-file');

                // LocalFolderWatcher must not attach a watcher inside a symlinked folder
                const reported: string[] = [];
                const watcher = new LocalFolderWatcher(
                    () => d.root,
                    () => false,
                    (ev) => {
                        reported.push(ev.relPath);
                    },
                    25,
                );
                await watcher.start();
                try {
                    await writeFile(path.join(d.outsideCfg, 'added-outside.txt'), 'nope');
                    await new Promise((r) => setTimeout(r, 100));
                    expect(reported).toEqual([]);
                } finally {
                    watcher.stop();
                }
                await d.engine.stop();
            });
        });
    }
});
