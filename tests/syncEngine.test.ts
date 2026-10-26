import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    ConnectionError,
    type DriveEvent,
    DriveEventType,
    type NodeEntity,
    NodeType,
    type ProtonDriveClient,
    ValidationError,
} from '@protontech/drive-sdk';

import * as notifications from '../src/linux/notifications';
import type { Manager as EventsManager } from '../src/sdk/events/manager';
import { computeLocalFileSha1, detectMediaType, THIRD_PARTY_DISCLOSURE } from '../src/sdk/fileOps';
import { PIN_ROOT_ON_FIRST_SYNC } from '../src/sync/availabilityMigration';
import { entryFromNode } from '../src/sync/remoteIndex';
import { startControlServer } from '../src/daemon/controlServer';
import { createLocalConflictCopy, formatConflictFileName } from '../src/sync/conflictResolver';
import { DriveOpError } from '../src/sync/driveOps';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { type AvailabilityResult, LOCAL_MOVE_IN_PROGRESS, ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { RemoteOpsJournal } from '../src/sync/remoteOps';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { localFiles } from './helpers/localFiles';
import { makeMockDrive } from './helpers/mockDrive';
import { makeMockNode } from './helpers/mockNodes';

describe('Proton Drive Ubuntu Sync Suite', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-ubuntu-test-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
        stateDb.updateSettings({
            syncDir: path.join(tempDir, 'ProtonDrive'),
            notificationsEnabled: false,
        });
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    test('includes required Proton third-party disclosure', () => {
        expect(THIRD_PARTY_DISCLOSURE).toBe('This is a third-party application not officially supported by Proton.');
    });

    test('computes SHA1 and detects media types accurately', async () => {
        const sampleFile = path.join(tempDir, 'hello.md');
        await writeFile(sampleFile, '# Hello Proton Drive Ubuntu\n');
        const sha1 = await computeLocalFileSha1(sampleFile);
        expect(sha1).toHaveLength(40);
        expect(detectMediaType(sampleFile)).toBe('text/markdown');
    });

    test('matches ignore patterns', () => {
        const patterns = ['.git', 'node_modules', '*.tmp'];

        expect(matchesIgnorePatterns('.git/config', patterns)).toBe(true);
        expect(matchesIgnorePatterns('project/node_modules/pkg/index.js', patterns)).toBe(true);
        expect(matchesIgnorePatterns('notes/draft.tmp', patterns)).toBe(true);
        expect(matchesIgnorePatterns('Documents/report.pdf', patterns)).toBe(false);
    });

    test('formats conflict filenames and creates conflict copies', async () => {
        const formatted = formatConflictFileName('budget.xlsx', new Date('2026-10-20T12:30:45Z'), 'ubuntu-laptop');
        expect(formatted).toContain('budget (conflict ');
        expect(formatted.endsWith('ubuntu-laptop).xlsx')).toBe(true);

        const origPath = path.join(tempDir, 'notes.txt');
        await writeFile(origPath, 'local version');
        const copyPath = await createLocalConflictCopy(origPath);
        expect(await readFile(copyPath, 'utf8')).toBe('local version');
    });

    test('performs two-way sync: downloads remote files, uploads local files, and handles remote delete events', async () => {
        const remoteNodes = new Map<string, NodeEntity & { content?: string }>();
        const rootNode = makeMockNode({
            uid: 'vol~root',
            nameStr: 'root',
            type: NodeType.Folder,
        });
        remoteNodes.set(rootNode.uid, rootNode);

        const remoteDoc = makeMockNode({
            uid: 'vol~file1',
            parentUid: rootNode.uid,
            nameStr: 'welcome.txt',
            type: NodeType.File,
            content: 'Hello from Proton Drive Cloud!',
        });
        remoteNodes.set(remoteDoc.uid, remoteDoc);

        let eventCallback: ((context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) | null = null;

        const mockEventsManager = {
            addEventListener: (cb: (context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) => {
                eventCallback = cb;
                return () => {
                    eventCallback = null;
                };
            },
            subscribeDriveScope: async () => {},
        } as unknown as EventsManager;

        let nextId = 2;
        const mockSdk = {
            getMyFilesRootFolder: async () => rootNode,
            getNode: async (uid: string) => {
                const found = remoteNodes.get(uid);
                if (!found) throw new ValidationError('Item not found');
                return found;
            },
            iterateFolderChildren: async function* (parent: NodeEntity | string) {
                const parentUid = typeof parent === 'string' ? parent : parent.uid;
                for (const node of remoteNodes.values()) {
                    if (node.uid !== rootNode.uid && node.parentUid === parentUid) {
                        yield node;
                    }
                }
            },
            createFolder: async (parent: NodeEntity | string, name: string) => {
                const parentUid = typeof parent === 'string' ? parent : parent.uid;
                const uid = `vol~folder${nextId++}`;
                const folder = makeMockNode({ uid, parentUid, nameStr: name, type: NodeType.Folder });
                remoteNodes.set(uid, folder);
                return folder;
            },
            getFileRevisionDownloader: async (revisionUid: string) => {
                const nodeUid = revisionUid.replace(/~rev\d+$/, '');
                const node = remoteNodes.get(nodeUid);
                const bytes = Buffer.from(node?.content ?? '');
                return {
                    downloadToStream: (writable: WritableStream, onProgress?: (b: number) => void) => {
                        const writer = writable.getWriter();
                        const promise = (async () => {
                            await writer.write(bytes);
                            onProgress?.(bytes.length);
                        })();
                        return {
                            completion: () => promise,
                        };
                    },
                };
            },
            getFileUploader: async (parent: NodeEntity | string, name: string, metadata: { expectedSha1: string }) => {
                const parentUid = typeof parent === 'string' ? parent : parent.uid;
                return {
                    uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                        const buf = Buffer.from(await new Response(stream).arrayBuffer());
                        const uid = `vol~file${nextId++}`;
                        const created = makeMockNode({
                            uid,
                            parentUid,
                            nameStr: name,
                            type: NodeType.File,
                            sha1: metadata.expectedSha1,
                            content: buf.toString('utf8'),
                        });
                        remoteNodes.set(uid, created);
                        return {
                            completion: async () => ({ nodeUid: uid }),
                        };
                    },
                };
            },
            trashNodes: async function* (nodes: NodeEntity[]) {
                for (const n of nodes) {
                    remoteNodes.delete(n.uid);
                    yield { uid: n.uid, ok: true as const };
                }
            },
        } as unknown as ProtonDriveClient;

        const mockLogger = {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        };

        const syncDir = stateDb.getSettings().syncDir;
        const engine = new ProtonDriveSyncEngine(
            mockSdk,
            mockEventsManager,
            { isLoggedIn: () => true },
            stateDb,
            mockLogger,
        );

        // Only pinned items come to this computer; pinning the root brings everything
        engine.availability.setPin(rootNode.uid, 'pinned', false);
        await engine.start();

        // 1. Verify remote `welcome.txt` was downloaded to local syncDir
        const localWelcomePath = path.join(syncDir, 'welcome.txt');
        expect(await readFile(localWelcomePath, 'utf8')).toBe('Hello from Proton Drive Cloud!');

        // 2. Create a new local file and reconcile -> verify it uploads to remote
        const localNotesPath = path.join(syncDir, 'ubuntu-notes.txt');
        await writeFile(localNotesPath, 'Created on Ubuntu Linux');
        await engine.reconcileNow();

        const uploadedNode = Array.from(remoteNodes.values()).find(
            (n) => n.name.ok && n.name.value === 'ubuntu-notes.txt',
        );
        expect(uploadedNode).toBeDefined();
        expect(uploadedNode?.content).toBe('Created on Ubuntu Linux');

        // 3. Simulate real-time remote NodeDeleted event from Proton Drive SDK
        expect(eventCallback).not.toBeNull();
        await eventCallback!('drive', {
            type: DriveEventType.NodeDeleted,
            nodeUid: remoteDoc.uid,
            parentNodeUid: rootNode.uid,
            treeEventScopeId: 'scope-main',
            eventId: 'evt-100',
        });

        const welcomeExistsAfterDelete = await stat(localWelcomePath)
            .then(() => true)
            .catch(() => false);
        expect(welcomeExistsAfterDelete).toBe(false);

        await engine.stop();
    });

    // #45: once every recorded top-level item is gone from the folder, that reads as the files missing, never as
    // deletes. A test of a genuine delete keeps another synced top-level file, so that what it deletes is a partial loss.
    const keepAnotherSyncedFile = async (add: (rel: string, content?: string) => NodeEntity) => {
        const node = add('Kept.txt', 'kept');
        const full = path.join(stateDb.getSettings().syncDir, 'Kept.txt');
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, 'kept');
        const st = await stat(full);
        const sha1 = await computeLocalFileSha1(full);
        stateDb.upsertItem({
            localRelPath: 'Kept.txt',
            nodeUid: node.uid,
            parentNodeUid: node.parentUid ?? null,
            type: 'file',
            localSha1: sha1,
            remoteSha1: sha1,
            localMtimeMs: st.mtimeMs,
            remoteMtimeMs: node.modificationTime.getTime(),
            size: st.size,
            syncStatus: 'synced',
            lastError: null,
        });
    };

    describe('remote index', () => {
        const setup = () => {
            const remoteNodes = new Map<string, NodeEntity & { content?: string }>();
            const rootNode = makeMockNode({ uid: 'vol~root', nameStr: 'root', type: NodeType.Folder });
            const archive = makeMockNode({ uid: 'vol~archive', parentUid: rootNode.uid, nameStr: 'Archive', type: NodeType.Folder });
            const year = makeMockNode({ uid: 'vol~year', parentUid: archive.uid, nameStr: '2025', type: NodeType.Folder });
            const tax = makeMockNode({ uid: 'vol~tax', parentUid: year.uid, nameStr: 'tax.pdf', type: NodeType.File, content: 'tax' });
            for (const n of [rootNode, archive, year, tax]) remoteNodes.set(n.uid, n);

            let eventCallback: ((context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) | null = null;
            const mockEventsManager = {
                addEventListener: (cb: (context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) => {
                    eventCallback = cb;
                    return () => {
                        eventCallback = null;
                    };
                },
                subscribeDriveScope: async () => {},
            } as unknown as EventsManager;
            const mockSdk = {
                getMyFilesRootFolder: async () => rootNode,
                getNode: async (uid: string) => {
                    const found = remoteNodes.get(uid);
                    if (!found) throw new ValidationError('Item not found');
                    return found;
                },
                iterateFolderChildren: async function* (parent: NodeEntity | string) {
                    const parentUid = typeof parent === 'string' ? parent : parent.uid;
                    for (const node of remoteNodes.values()) {
                        if (node.uid !== rootNode.uid && node.parentUid === parentUid) yield node;
                    }
                },
                getFileRevisionDownloader: async (revisionUid: string) => {
                    const node = remoteNodes.get(revisionUid.replace(/~rev\d+$/, ''));
                    const bytes = Buffer.from(node?.content ?? '');
                    return {
                        downloadToStream: (writable: WritableStream, onProgress?: (b: number) => void) => {
                            const writer = writable.getWriter();
                            const promise = (async () => {
                                await writer.write(bytes);
                                onProgress?.(bytes.length);
                            })();
                            return { completion: () => promise };
                        },
                    };
                },
                trashNodes: async function* (nodes: NodeEntity[]) {
                    for (const n of nodes) {
                        remoteNodes.delete(n.uid);
                        yield { uid: n.uid, ok: true as const };
                    }
                },
            } as unknown as ProtonDriveClient;
            const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
            const engine = new ProtonDriveSyncEngine(mockSdk, mockEventsManager, { isLoggedIn: () => true }, stateDb, logger);
            return { engine, remoteNodes, rootNode, archive, fire: (e: DriveEvent) => eventCallback!('drive', e) };
        };

        test('indexRemoteSubtree records a subtree without touching disk', async () => {
            const { engine, rootNode, archive } = setup();
            engine.remoteIndex.setRoot(rootNode.uid);
            engine.remoteIndex.replaceChildren(rootNode.uid, '', [entryFromNode(archive, '')!]);
            await (engine as any).indexRemoteSubtree(archive, 'Archive');

            expect(engine.remoteIndex.getByPath('Archive/2025/tax.pdf')).not.toBeNull();
            const archiveExists = await stat(path.join(stateDb.getSettings().syncDir, 'Archive'))
                .then(() => true)
                .catch(() => false);
            expect(archiveExists).toBe(false);
        });

        test('a remote rename moves the subtree in the index', async () => {
            const { engine, remoteNodes, archive } = setup();
            await engine.start();
            expect(engine.remoteIndex.getByPath('Archive/2025/tax.pdf')).not.toBeNull();

            remoteNodes.set(archive.uid, { ...archive, name: { ok: true, value: 'Old' } });
            await engine.reconcileNow();

            expect(engine.remoteIndex.getByPath('Old/2025/tax.pdf')).not.toBeNull();
            expect(engine.remoteIndex.getByPath('Archive')).toBeNull();
            await engine.stop();
        });

        test('a NodeDeleted event removes the subtree', async () => {
            const { engine, rootNode, archive, fire } = setup();
            await engine.start();
            expect(engine.remoteIndex.getByPath('Archive/2025/tax.pdf')).not.toBeNull();

            await fire({
                type: DriveEventType.NodeDeleted,
                nodeUid: archive.uid,
                parentNodeUid: rootNode.uid,
                treeEventScopeId: 'scope-main',
                eventId: 'evt-200',
            });

            expect(engine.remoteIndex.getByPath('Archive/2025/tax.pdf')).toBeNull();
            expect(engine.remoteIndex.getByPath('Archive')).toBeNull();
            await engine.stop();
        });

        test('orphan rows followed by a rename onto their path do not break the reconcile', async () => {
            const { engine, remoteNodes, archive } = setup();
            await engine.start();
            // Orphans: rows whose parent folder row is missing, sitting where the renamed Archive will land
            for (const [uid, parentUid, relPath, type] of [
                ['orphan-dir', 'gone', 'Moved/2025', 'folder'],
                ['orphan-file', 'orphan-dir', 'Moved/2025/x', 'file'],
            ] as const) {
                engine.remoteIndex.upsert({ uid, parentUid, relPath, name: path.posix.basename(relPath), type, size: 0, mtimeMs: 0, sha1: null });
            }

            remoteNodes.set(archive.uid, { ...archive, name: { ok: true, value: 'Moved' } });
            await engine.reconcileNow();

            expect(engine.getStatus().state).not.toBe('error');
            await engine.stop();
        });

        test('a locally deleted synced folder leaves no index entries once it is trashed', async () => {
            const { engine, remoteNodes, rootNode, archive } = setup();
            // Another top-level item stays, so the delete is a partial loss, never the files missing (#45)
            const kept = makeMockNode({ uid: 'vol~kept', parentUid: rootNode.uid, nameStr: 'Kept.txt', type: NodeType.File, content: 'kept' });
            remoteNodes.set(kept.uid, kept);
            engine.availability.setPin(rootNode.uid, 'pinned', false);
            await engine.start();
            expect(await readFile(path.join(stateDb.getSettings().syncDir, 'Kept.txt'), 'utf8')).toBe('kept');

            await rm(path.join(stateDb.getSettings().syncDir, 'Archive'), { recursive: true, force: true });
            await engine.reconcileNow();

            expect(remoteNodes.has(archive.uid)).toBe(false);
            expect(engine.remoteIndex.getByPath('Archive')).toBeNull();
            expect(engine.remoteIndex.getByPath('Archive/2025/tax.pdf')).toBeNull();
            await engine.stop();
        });
    });

    describe('availability', () => {
        const setup = () => {
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger);
            return { ...drive, engine, files: localFiles(stateDb) };
        };
        const local = (rel: string) => path.join(stateDb.getSettings().syncDir, rel);

        test('new remote files download only under a pin', async () => {
            const { engine, add, calls, files } = setup();
            const docs = add('Docs');
            add('Other');
            engine.availability.setPin(docs.uid, 'pinned', false);
            await engine.reconcileNow();
            add('Docs/new.txt', 'new');
            add('Other/x.txt', 'x');

            await engine.reconcileNow();

            expect(await readFile(local('Docs/new.txt'), 'utf8')).toBe('new');
            expect(await files.exists('Other')).toBe(false);
            expect(calls.downloads).toEqual(['Docs/new.txt']);
            expect(engine.remoteIndex.getByPath('Other')).not.toBeNull();
            // What is inside an online-only folder reaches the index on the next crawl, not on every pass (see
            // 'online-only crawl')
            expect(engine.remoteIndex.getByPath('Other/x.txt')).toBeNull();
        });

        test('pinning a deep folder creates online-only ancestors but not siblings', async () => {
            const { engine, add, calls, files } = setup();
            add('A/B/C/f.txt', 'deep');
            add('A/sibling.txt', 'beside');
            add('A/B/cousin.txt', 'beside too');
            await engine.reconcileNow();
            expect(calls.downloads).toEqual([]);

            engine.availability.setPin('vol~A/B/C', 'pinned', false);
            await engine.reconcileNow();

            expect(await readFile(local('A/B/C/f.txt'), 'utf8')).toBe('deep');
            expect(await files.exists('A/sibling.txt')).toBe(false);
            expect(await files.exists('A/B/cousin.txt')).toBe(false);
            expect(calls.downloads).toEqual(['A/B/C/f.txt']);
            expect(engine.availability.stateOf('A')).toBe('online-only');
            expect(engine.availability.stateOf('A/B/C')).toBe('pinned');
        });

        test('hidden items are never downloaded or uploaded', async () => {
            const { engine, add, root, calls, files } = setup();
            add('welcome.txt', 'hello');
            add('Secret/s.txt', 'remote secret');
            engine.availability.setPin(root.uid, 'pinned', false);
            engine.availability.setHide('vol~Secret', 'hidden');
            await engine.start();

            await files.writeLocal('Secret/x.txt', 'local secret');
            await Bun.sleep(700); // past the watcher's debounce
            // The watcher neither watches the hidden folder nor reports changes in it
            const watcher = (engine as any).watcher;
            expect(watcher.watchers.has(local('Secret'))).toBe(false);
            expect(watcher.shouldIgnore('Secret/x.txt')).toBe(true);
            expect(watcher.shouldIgnore('welcome.txt')).toBe(false);
            await engine.reconcileNow();
            await (engine as any).handleLocalFileChange('Secret/x.txt');
            await engine.stop();

            expect(calls.downloads).toEqual(['welcome.txt']);
            expect(calls.uploads).toEqual([]);
            expect(await files.exists('Secret/s.txt')).toBe(false);
            expect(files.recordCount('Secret')).toBe(0);
        });

        // Photos with a.jpg downloaded (pinned on its own) and b.jpg … z.jpg online-only
        const partlyDownloaded = async () => {
            const drive = setup();
            for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
                drive.add(`Photos/${letter}.jpg`, letter);
            }
            await drive.engine.reconcileNow();
            drive.engine.availability.setPin('vol~Photos/a.jpg', 'pinned', false);
            await drive.engine.reconcileNow();
            expect(drive.calls.downloads).toEqual(['Photos/a.jpg']);
            expect(drive.files.recordCount('Photos')).toBe(2); // the folder and a.jpg
            return drive;
        };

        test('deleting a partly downloaded folder trashes only what was local', async () => {
            const { engine, add, nodes, calls, files } = await partlyDownloaded();
            await keepAnotherSyncedFile(add);

            await rm(local('Photos'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([['vol~Photos/a.jpg']]);
            expect(nodes.has('vol~Photos')).toBe(true);
            expect(nodes.has('vol~Photos/b.jpg')).toBe(true);
            expect(files.recordCount('Photos')).toBe(0);
            // Left online-only: the next pass does not bring it back or trash anything more
            await engine.reconcileNow();
            expect(await files.exists('Photos')).toBe(false);
            expect(engine.availability.stateOf('Photos')).toBe('online-only');
            expect(calls.trashed).toHaveLength(1);
        });

        test('a partly downloaded folder deleted under the watcher also trashes only what was local', async () => {
            const { engine, add, nodes, calls, files } = await partlyDownloaded();
            await keepAnotherSyncedFile(add);

            await rm(local('Photos'), { recursive: true });
            await (engine as any).handleLocalFileChange('Photos');

            expect(calls.trashed).toEqual([['vol~Photos/a.jpg']]);
            expect(nodes.has('vol~Photos')).toBe(true);
            expect(files.recordCount('Photos')).toBe(0);
        });

        test('a deleted pinned folder holding something never downloaded is left online-only, not brought back', async () => {
            const { engine, add, nodes, calls, files } = setup();
            await keepAnotherSyncedFile(add);
            const aJpg = add('Photos/a.jpg', 'a');
            add('Photos/.DS_Store', 'matches an ignore pattern, so never downloaded');
            engine.availability.setPin('vol~Photos', 'pinned', false);
            await engine.reconcileNow();
            expect(calls.downloads).toEqual(['Photos/a.jpg']);

            await rm(local('Photos'), { recursive: true });
            await engine.reconcileNow();
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([[aJpg.uid]]);
            expect(nodes.has('vol~Photos/.DS_Store')).toBe(true);
            expect(await files.exists('Photos')).toBe(false);
            expect(engine.availability.stateOf('Photos')).toBe('online-only');
        });

        test('deleting a folder never trashes a hidden or hiding folder inside it', async () => {
            const { engine, add, root, nodes, calls, files } = setup();
            await keepAnotherSyncedFile(add);
            add('Work/plan.txt', 'plan');
            add('Work/Secret/s.txt', 'secret');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            // Hiding, still waiting on uploads: its local copy and records are all still here
            engine.availability.setHide('vol~Work/Secret', 'pending');

            await rm(local('Work'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([['vol~Work/plan.txt']]);
            expect(nodes.has('vol~Work/Secret/s.txt')).toBe(true);
            expect(files.recordCount('Work')).toBe(0);
        });

        test('deleting a folder that was replaced in the cloud by another of the same name trashes nothing', async () => {
            const { engine, add, root, nodes, calls, files } = setup();
            await keepAnotherSyncedFile(add);
            add('Photos/a.jpg', 'old');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            // Another device replaces Photos with a new folder holding a new a.jpg
            nodes.delete('vol~Photos');
            nodes.delete('vol~Photos/a.jpg');
            const newer = makeMockNode({ uid: 'vol~newer', parentUid: root.uid, nameStr: 'Photos', type: NodeType.Folder });
            const newerA = makeMockNode({ uid: 'vol~newer-a', parentUid: newer.uid, nameStr: 'a.jpg', type: NodeType.File, content: 'new' });
            nodes.set(newer.uid, newer);
            nodes.set(newerA.uid, newerA);

            await rm(local('Photos'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([]);
            expect(nodes.has(newerA.uid)).toBe(true);
            expect(files.recordCount('Photos')).toBe(0);
        });

        test('deleting a file that was replaced in the cloud by another of the same name trashes nothing when the recorded one is gone', async () => {
            const { engine, add, root, nodes, calls, files } = setup();
            await keepAnotherSyncedFile(add);
            add('Report', 'v1');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            await rm(local('Report'));
            // The recorded file is still in the cloud, but a Proton Doc of the same name now sits beside it
            const doc = makeMockNode({ uid: 'vol~ReportDoc', parentUid: root.uid, nameStr: 'Report', type: NodeType.File, content: 'doc' });
            Object.assign(doc, { mediaType: 'application/vnd.proton.doc' });
            nodes.delete('vol~Report');
            nodes.set(doc.uid, doc);

            await engine.reconcileNow();

            expect(calls.trashed).toEqual([]);
            expect(nodes.has(doc.uid)).toBe(true);
            expect(files.recordCount('Report')).toBe(0);
        });

        test('deleting a file replaced by a new upload trashes the recorded file when it is still there', async () => {
            const { engine, add, root, nodes, calls, files } = setup();
            await keepAnotherSyncedFile(add);
            add('Report', 'v1');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            await rm(local('Report'));
            // Listed by name: only the newer upload; the recorded node is still reachable by its uid
            const newer = makeMockNode({ uid: 'vol~newer', parentUid: root.uid, nameStr: 'Report', type: NodeType.File, content: 'v2' });
            const old = nodes.get('vol~Report')!;
            nodes.set(newer.uid, newer);
            const realGet = (engine as any).sdk.getNode;
            (engine as any).sdk.getNode = async (uid: string) => (uid === 'vol~Report' ? old : realGet(uid));
            nodes.delete('vol~Report');

            await engine.reconcileNow();

            expect(calls.trashed).toEqual([['vol~Report']]);
            expect(nodes.has(newer.uid)).toBe(true);
            expect(files.recordCount('Report')).toBe(0);
        });

        test('a deleted folder is not trashed while its cloud contents cannot all be listed', async () => {
            const { engine, add, calls, failListing, warnings, files } = await partlyDownloaded();
            await keepAnotherSyncedFile(add);
            failListing.add('vol~Photos');

            await rm(local('Photos'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([]);
            expect(files.recordCount('Photos')).toBe(2); // kept, so the next pass tries again
            expect(engine.getStatus().state).not.toBe('error');
            expect(warnings.some((w) => w.includes('Not trashing Photos yet'))).toBe(true);

            failListing.clear();
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([['vol~Photos/a.jpg']]);
        });

        test('a folder that fails to list is logged and skipped, and the rest still syncs', async () => {
            const { engine, add, calls, failListing, warnings } = setup();
            add('Docs/d.txt', 'd');
            add('Other/deep/o.txt', 'o');
            add('Other/later/l.txt', 'l');
            add('Zebra/z.txt', 'z');
            engine.availability.setPin('vol~Docs', 'pinned', false);
            engine.availability.setPin('vol~Zebra', 'pinned', false);
            failListing.add('vol~Other/deep');

            await engine.reconcileNow();

            expect(engine.getStatus().state).not.toBe('error');
            expect(calls.downloads.sort()).toEqual(['Docs/d.txt', 'Zebra/z.txt']);
            expect(engine.remoteIndex.getByPath('Other/deep')).not.toBeNull();
            expect(engine.remoteIndex.getByPath('Other/later/l.txt')).not.toBeNull();
            expect(warnings.some((w) => w.includes('Could not list Other/deep'))).toBe(true);
        });

        test('an item whose record is dropped while a deletion is being worked out is not trashed', async () => {
            const { engine, calls } = await partlyDownloaded();
            await rm(local('Photos'), { recursive: true });
            // Free up space (say) drops a.jpg's record just after the deletion has read the records
            const getItemsUnder = stateDb.getItemsUnder.bind(stateDb);
            stateDb.getItemsUnder = (rel: string) => {
                const items = getItemsUnder(rel);
                stateDb.removeItemByPath('Photos/a.jpg');
                return items;
            };

            await engine.reconcileNow();

            expect(calls.trashed).toEqual([]);
        });

        test('the remote index crawl lists nothing while paused', async () => {
            const { engine, add, nodes } = setup();
            add('Other/x.txt', 'x');
            await engine.reconcileNow();
            engine.remoteIndex.replaceChildren('vol~Other', 'Other', []); // forget what the first crawl found
            stateDb.updateSettings({ paused: true });

            expect(await (engine as any).indexRemoteSubtree(nodes.get('vol~Other'), 'Other')).toBe(false);
            expect(engine.remoteIndex.getByPath('Other/x.txt')).toBeNull();
        });

        test('what was local in a partly downloaded folder goes to the trash in one call', async () => {
            const { engine, add, calls } = await partlyDownloaded();
            await keepAnotherSyncedFile(add);
            add('Photos/2024/x.jpg', 'x');
            add('Photos/2024/y.jpg', 'y');
            engine.availability.setPin('vol~Photos/c.jpg', 'pinned', false);
            engine.availability.setPin('vol~Photos/2024', 'pinned', false);
            await engine.reconcileNow();

            await rm(local('Photos'), { recursive: true });
            await engine.reconcileNow();

            // A subfolder that was wholly local goes as one item, with what is in it
            expect(calls.trashed).toEqual([['vol~Photos/2024', 'vol~Photos/a.jpg', 'vol~Photos/c.jpg']]);
        });

        test('a deleted folder that comes back while its cloud contents are listed is not trashed', async () => {
            const { engine, add, root, sdk, calls, files } = setup();
            add('Done/a.txt', 'a');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            await rm(local('Done'), { recursive: true });
            // The user restores the folder just as the engine lists it to decide what to trash
            const iterate = sdk.iterateFolderChildren.bind(sdk);
            (sdk as any).iterateFolderChildren = async function* (parent: NodeEntity) {
                if (parent.uid === 'vol~Done') await files.writeLocal('Done/a.txt', 'a');
                yield* iterate(parent);
            };

            await engine.reconcileNow();

            expect(calls.trashed).toEqual([]);
        });

        test('a deleted file whose record is dropped while its cloud node is looked up is not trashed', async () => {
            const { engine, add, root, sdk, calls } = setup();
            add('note.txt', 'n');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            await rm(local('note.txt'));
            // Free up space (say) drops the record while the watcher's handler waits on the network
            const getNode = sdk.getNode.bind(sdk);
            (sdk as any).getNode = async (uid: string) => {
                stateDb.removeItemByPath('note.txt');
                return getNode(uid);
            };

            await (engine as any).handleLocalFileChange('note.txt');

            expect(calls.trashed).toEqual([]);
        });

        // Proton Docs and Sheets are never downloaded and not in the remote index, but trashing a folder takes them along
        test('a deleted folder holding a Proton Doc keeps the doc in the cloud', async () => {
            const { engine, add, root, nodes, calls } = setup();
            await keepAnotherSyncedFile(add);
            add('Done/a.txt', 'a');
            Object.assign(add('Done/plan', 'doc'), { mediaType: 'application/vnd.proton.doc' });
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();
            expect(calls.downloads).toEqual(['Done/a.txt']);

            await rm(local('Done'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([['vol~Done/a.txt']]);
            expect(nodes.has('vol~Done/plan')).toBe(true);
        });

        test('a wholly downloaded subfolder holding a Proton Sheet is not trashed as one item', async () => {
            const { engine, add, nodes, calls } = setup();
            await keepAnotherSyncedFile(add);
            add('Photos/a.jpg', 'a');
            add('Photos/b.jpg', 'b');
            add('Photos/Work/w.txt', 'w');
            Object.assign(add('Photos/Work/budget', 'sheet'), { mediaType: 'application/vnd.proton.sheet' });
            await engine.reconcileNow();
            engine.availability.setPin('vol~Photos/a.jpg', 'pinned', false);
            engine.availability.setPin('vol~Photos/Work', 'pinned', false);
            await engine.reconcileNow();

            await rm(local('Photos'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([['vol~Photos/Work/w.txt', 'vol~Photos/a.jpg']]);
            expect(nodes.has('vol~Photos/Work/budget')).toBe(true);
        });

        test('a deleted folder whose every item was local is trashed whole, as before', async () => {
            const { engine, add, root, nodes, calls } = setup();
            await keepAnotherSyncedFile(add);
            add('Done/a.txt', 'a');
            add('Done/sub/b.txt', 'b');
            engine.availability.setPin(root.uid, 'pinned', false);
            await engine.reconcileNow();

            await rm(local('Done'), { recursive: true });
            await engine.reconcileNow();

            expect(calls.trashed).toEqual([['vol~Done']]);
            expect(nodes.has('vol~Done/sub/b.txt')).toBe(false);
        });
    });

    // Folders absent here are listed for the index only now and then (ruling R17), and after the local pass
    describe('online-only crawl', () => {
        // Stopped even when a test fails, so no watcher outlives the database
        const engines: ProtonDriveSyncEngine[] = [];
        afterEach(async () => {
            while (engines.length) await engines.pop()!.stop();
        });
        const setup = () => {
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger);
            engines.push(engine);
            // Every listing and download, in order, by path ('' is the root)
            const log: string[] = [];
            const pathOfUid = (uid: string) => (uid === drive.root.uid ? '' : uid.replace(/^vol~/, ''));
            const iterate = (drive.sdk as any).iterateFolderChildren;
            (drive.sdk as any).iterateFolderChildren = (parent: NodeEntity | string) => {
                log.push(`list:${pathOfUid(typeof parent === 'string' ? parent : parent.uid)}`);
                return iterate(parent);
            };
            const downloader = drive.sdk.getFileRevisionDownloader.bind(drive.sdk);
            (drive.sdk as any).getFileRevisionDownloader = async (revisionUid: string) => {
                log.push(`download:${pathOfUid(revisionUid.replace(/~rev\d+$/, ''))}`);
                return downloader(revisionUid);
            };
            const listings = () => log.filter((entry) => entry.startsWith('list:')).map((entry) => entry.slice(5));
            return { ...drive, engine, log, listings };
        };

        test('online-only folders are crawled on the first pass, not on passes 2 to 9, and again on the 10th', async () => {
            const { engine, add, log, listings } = setup();
            const docs = add('Docs');
            engine.availability.setPin(docs.uid, 'pinned', false);
            add('Other/Deep/x.txt', 'x');

            await engine.reconcileNow(); // pass 1
            expect(listings()).toEqual(expect.arrayContaining(['', 'Docs', 'Other', 'Other/Deep']));
            expect(engine.remoteIndex.getByPath('Other/Deep/x.txt')).not.toBeNull();

            add('Other/Deep/y.txt', 'y');
            for (let pass = 2; pass <= 9; pass++) {
                log.length = 0;
                await engine.reconcileNow();
                expect({ pass, listed: listings().sort() }).toEqual({ pass, listed: ['', 'Docs'] });
            }
            expect(engine.remoteIndex.getByPath('Other/Deep/y.txt')).toBeNull();

            log.length = 0;
            await engine.reconcileNow(); // pass 10
            expect(listings()).toEqual(expect.arrayContaining(['Other', 'Other/Deep']));
            expect(engine.remoteIndex.getByPath('Other/Deep/y.txt')).not.toBeNull();
        });

        for (const type of [DriveEventType.TreeRefresh, DriveEventType.FastForward] as const) {
            test(`a ${type} event forces a crawl of online-only folders`, async () => {
                const { engine, add, log, listings, fire } = setup();
                add('Other/x.txt', 'x');
                await engine.start(); // pass 1 crawls
                await engine.reconcileNow(); // pass 2 doesn't
                add('Other/new.txt', 'new');
                log.length = 0;
                await engine.reconcileNow(); // nor does pass 3
                expect(listings()).toEqual(['']);
                expect(engine.remoteIndex.getByPath('Other/new.txt')).toBeNull();

                log.length = 0;
                await fire({ type, treeEventScopeId: 'scope-main', eventId: 'evt-r17' } as DriveEvent);

                expect(listings()).toEqual(['', 'Other']);
                expect(engine.remoteIndex.getByPath('Other/new.txt')).not.toBeNull();
            });
        }

        test('a pinned folder is synced, and a new file in it downloaded, before online-only folders are crawled', async () => {
            const { engine, add, log } = setup();
            add('Archive/Old/x.txt', 'x'); // online-only, and listed before Docs among the root's children
            const docs = add('Docs');
            engine.availability.setPin(docs.uid, 'pinned', false);
            add('Docs/new.txt', 'new');

            await engine.reconcileNow(); // the first pass crawls

            expect(log).toEqual(['list:', 'list:Docs', 'download:Docs/new.txt', 'list:Archive', 'list:Archive/Old']);
        });

        test('a change event inside an online-only folder updates the index without waiting for the crawl', async () => {
            const { engine, add, listings, log, fire } = setup();
            add('Other/Deep/x.txt', 'x');
            await engine.start(); // pass 1 crawls
            const created = add('Other/Deep/new.txt', 'new');
            log.length = 0;

            await fire({
                type: DriveEventType.NodeCreated,
                nodeUid: created.uid,
                parentNodeUid: 'vol~Other/Deep',
                isTrashed: false,
                isShared: false,
                treeEventScopeId: 'scope-main',
                eventId: 'evt-created',
            });

            expect(engine.remoteIndex.getByPath('Other/Deep/new.txt')).not.toBeNull();
            // Just that folder, not a crawl of the rest
            expect(listings().sort()).toEqual(['', 'Other/Deep']);
        });
    });

    describe('availability actions', () => {
        const setup = () => {
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger);
            return { ...drive, engine, files: localFiles(stateDb) };
        };
        const local = (rel: string) => path.join(stateDb.getSettings().syncDir, rel);
        const activity = () => stateDb.listActivity(500).map((a) => a.details);
        // Downloaded through the engine, so the records are real
        const downloaded = async (paths: Record<string, string>, pin: string) => {
            const drive = setup();
            for (const [rel, content] of Object.entries(paths)) {
                drive.add(rel, content);
            }
            drive.engine.availability.setPin(pin, 'pinned', false);
            await drive.engine.reconcileNow();
            expect(drive.calls.downloads.sort()).toEqual(Object.keys(paths).sort());
            return drive;
        };

        test('an unknown path is rejected', async () => {
            const { engine } = setup();
            await engine.reconcileNow();

            const error = await engine.setAvailability('Nope', 'pin').then(
                () => null,
                (e: Error) => e.message,
            );

            expect(error).toBe('Not in Proton Drive: Nope');
            const unknown = await engine.setAvailability('', 'delete' as never).then(() => null, (e: Error) => e.message);
            expect(unknown).toBe('Unknown availability action: delete');
        });

        test('the state of a path the cloud holds, or of a new local item through its folder, and never of a missing path', async () => {
            const { engine, add, files } = setup();
            const docs = add('Docs');
            add('Docs/a.txt', 'a');
            add('Other/b.txt', 'b');
            engine.availability.setPin(docs.uid, 'pinned', false);
            await engine.reconcileNow();
            await files.writeLocal('Docs/new.txt', 'not uploaded yet'); // on disk, not in the index (ruling R3)
            const stateOf = (relPath: string) =>
                engine.availabilityOf(relPath).then(
                    (state) => state,
                    (e: Error) => e.message,
                );

            expect(await stateOf('Docs')).toBe('pinned');
            expect(await stateOf('Other/b.txt')).toBe('online-only');
            expect(await stateOf('Docs/new.txt')).toBe('pinned');
            expect(await stateOf('')).toBe('online-only');
            expect(await stateOf('typo.txt')).toBe('Not in Proton Drive: typo.txt');
            expect(await stateOf('Docs/typo.txt')).toBe('Not in Proton Drive: Docs/typo.txt');
            // The state database sits next to the sync folder: a path climbing out of it is not in Proton Drive
            expect(await stateOf('../state.sqlite')).toBe('Not in Proton Drive: ../state.sqlite');
        });

        test('hide and unhide do not apply to the whole drive, and asking for them does not stop a free of it', async () => {
            const { engine, files } = await downloaded({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }, 'vol~root');
            const refusals: Array<Promise<string | null>> = [];
            files.onRemoval(1, () => {
                for (const action of ['hide', 'unhide'] as const) {
                    refusals.push(engine.setAvailability('', action).then(() => null, (e: Error) => e.message));
                }
            });

            await engine.setAvailability('', 'free');

            for (const refusal of await Promise.all(refusals)) {
                expect(refusal).not.toBeNull();
            }
            expect(await readdir(local(''))).toEqual([]);
            expect(['hidden', 'hiding']).not.toContain(engine.availability.stateOf(''));
            expect(engine.availability.pendingHides()).toEqual([]);
        });

        test('pin downloads a whole online-only subtree', async () => {
            const { engine, add, sdk, calls, files } = setup();
            add('Photos/a.jpg', 'a');
            add('Photos/2024/b.jpg', 'b');
            add('Photos/2024/deep/c.jpg', 'c');
            add('Other/x.txt', 'x');
            await engine.reconcileNow();
            expect(calls.downloads).toEqual([]);
            const syncingDuring: string[][] = [];
            const downloader = sdk.getFileRevisionDownloader.bind(sdk);
            (sdk as any).getFileRevisionDownloader = async (uid: string) => {
                syncingDuring.push(engine.getStatus().syncingFolders);
                return downloader(uid);
            };

            const result = await engine.setAvailability('Photos', 'pin');

            expect(result).toEqual({ state: 'pinned', kept: [], refused: null });
            expect(calls.downloads.sort()).toEqual(['Photos/2024/b.jpg', 'Photos/2024/deep/c.jpg', 'Photos/a.jpg']);
            expect(await readFile(local('Photos/2024/deep/c.jpg'), 'utf8')).toBe('c');
            expect(await files.exists('Other')).toBe(false);
            expect(engine.availability.stateOf('Photos')).toBe('pinned');
            expect(engine.availability.stateOf('Photos/2024/deep/c.jpg')).toBe('pinned');
            // Marked as syncing while it downloads, and only then
            expect(syncingDuring).toEqual([['Photos'], ['Photos'], ['Photos']]);
            expect(engine.getStatus().syncingFolders).toEqual([]);
            expect(engine.getStatus().state).toBe('idle');
        });

        test('pin clears the syncing mark when its subtree fails to sync, and the next sync finishes it', async () => {
            const { engine, add, calls, failListing, warnings } = setup();
            add('Photos/a.jpg', 'a');
            await engine.reconcileNow();
            failListing.add('vol~Photos');

            const result = await engine.setAvailability('Photos', 'pin');

            expect(result.state).toBe('pinned');
            expect(engine.getStatus().syncingFolders).toEqual([]);
            expect(engine.getStatus().state).not.toBe('syncing');
            expect(warnings.some((w) => w.includes('Photos'))).toBe(true);
            failListing.clear();
            await engine.reconcileNow();
            expect(calls.downloads).toEqual(['Photos/a.jpg']);
        });

        test('pin on a file downloads just that file', async () => {
            const { engine, add, calls } = setup();
            add('Docs/a.txt', 'a');
            add('Docs/b.txt', 'b');
            await engine.reconcileNow();

            const result = await engine.setAvailability('Docs/a.txt', 'pin');

            expect(result.state).toBe('pinned');
            expect(calls.downloads).toEqual(['Docs/a.txt']);
            expect(await readFile(local('Docs/a.txt'), 'utf8')).toBe('a');
            expect(engine.availability.stateOf('Docs')).toBe('online-only');
        });

        test('free keeps ignored and edited files and drops only unchanged copies', async () => {
            const { engine, calls, files } = await downloaded(
                { 'Code/main.ts': 'main', 'Code/app/index.ts': 'index', 'Notes/todo.txt': 'synced version' },
                'vol~root',
            );
            await files.writeLocal('Code/app/.git/HEAD', 'ref: refs/heads/main'); // ignored, so never uploaded
            await writeFile(local('Notes/todo.txt'), 'edited after the last sync');

            const result = await engine.setAvailability('', 'free');

            expect(await readFile(local('Code/app/.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
            expect(await readFile(local('Notes/todo.txt'), 'utf8')).toBe('edited after the last sync');
            expect(await files.exists('Code/main.ts')).toBe(false);
            expect(stateDb.getItemByPath('Code/main.ts')).toBeNull();
            expect(await files.exists('Code/app/index.ts')).toBe(false);
            expect(result.kept).toEqual(expect.arrayContaining(['Code/app/.git', 'Notes/todo.txt']));
            expect(result.refused).toBeNull();
            expect(engine.availability.stateOf('Code/main.ts')).toBe('online-only');
            expect(engine.availability.stateOf('Notes/todo.txt')).toBe('downloaded');
            expect(engine.availability.isPinned('')).toBe(false);
            await files.expectNoRecordWithoutFile('Code');
            await files.expectNoRecordWithoutFile('Notes');

            // Freed, not deleted: nothing is trashed or brought back, and the kept edit uploads as an edit
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(calls.uploads).toEqual(['Notes/todo.txt']);
            expect(calls.downloads).toHaveLength(3);
            expect(await files.exists('Code/main.ts')).toBe(false);
        });

        test('a free asked while a pin is being applied stops its download', async () => {
            const { engine, add, calls, files } = setup();
            add('Work/Docs/a.txt', 'a');
            await engine.reconcileNow();
            let free: Promise<AvailabilityResult> | undefined;
            const setPin = engine.availability.setPin.bind(engine.availability);
            engine.availability.setPin = (uid, pin, clearBelow) => {
                setPin(uid, pin, clearBelow);
                if (pin === 'pinned') {
                    free ??= engine.setAvailability('Work/Docs', 'free');
                }
            };

            await engine.setAvailability('Work/Docs', 'pin');
            expect((await free!).state).toBe('online-only');

            expect(calls.downloads).toEqual([]);
            expect(await files.exists('Work')).toBe(false); // not even its folders were made
        });

        test('a file edited just as free drops its record stays, keeps its record and uploads as an edit', async () => {
            const { engine, nodes, calls, files } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~Docs');
            // keep-remote settles a conflict by overwriting the local file, so a lost record would lose the edit
            stateDb.updateSettings({ conflictStrategy: 'keep-remote' });
            let edited = '';
            files.onRemoval(1, (rel) => {
                edited = rel;
                appendFileSync(local(rel), ' edited at the last moment');
            });

            const result = await engine.setAvailability('Docs', 'free');

            expect(result.kept).toContain(edited);
            expect(stateDb.getItemByPath(edited)).not.toBeNull();
            await engine.reconcileNow();
            const expected = `${path.posix.basename(edited, '.txt')} edited at the last moment`;
            expect(await readFile(local(edited), 'utf8')).toBe(expected);
            expect(calls.uploads).toEqual([edited]);
            expect(nodes.get(`vol~${edited}`)?.content).toBe(expected);
            expect(stateDb.listConflicts(true)).toEqual([]);
        });

        test('free says once which items stayed on this computer', async () => {
            const { engine, files } = await downloaded({ 'Notes/a.txt': 'a', 'Notes/b.txt': 'b' }, 'vol~Notes');
            await writeFile(local('Notes/b.txt'), 'edited');
            await files.writeLocal('Notes/new.txt', 'not uploaded yet');

            const result = await engine.setAvailability('Notes', 'free');

            expect([...result.kept].sort()).toEqual(['Notes', 'Notes/b.txt', 'Notes/new.txt']);
            const told = activity().filter((d) => d.includes('stayed on this computer'));
            expect(told).toEqual([
                "2 item(s) in Notes stayed on this computer because they aren't in Proton Drive yet (e.g. Notes/b.txt)",
            ]);
            expect(engine.availability.stateOf('Notes/b.txt')).toBe('downloaded');
            expect(engine.availability.stateOf('Notes/a.txt')).toBe('online-only');
        });

        test('free during an in-flight download keeps the growing temp file and leaves no record without a file', async () => {
            const { engine, files } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~Docs');
            const temp = 'Docs/.proton-drive-tmp-1-2-x';
            await files.writeLocal(temp, 'partial');
            // The download writing it keeps going while space is freed, and another one finishes and records its file
            files.onRemoval(1, () => {
                appendFileSync(local(temp), ' and more');
                writeFileSync(local('Docs/c.txt'), 'c');
                stateDb.upsertItem({
                    localRelPath: 'Docs/c.txt',
                    nodeUid: 'vol~Docs/c.txt',
                    parentNodeUid: 'vol~Docs',
                    type: 'file',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: Date.now(),
                    remoteMtimeMs: Date.now(),
                    size: 1,
                    syncStatus: 'synced',
                    lastError: null,
                });
            });

            const result = await engine.setAvailability('Docs', 'free');

            expect(await readFile(local(temp), 'utf8')).toBe('partial and more');
            expect(result.kept).toContain(temp);
            expect(await files.exists('Docs/a.txt')).toBe(false);
            expect(await files.exists('Docs/b.txt')).toBe(false);
            expect(stateDb.getItemByPath('Docs/c.txt')).not.toBeNull();
            await files.expectNoRecordWithoutFile('Docs');
            // The engine's own download is not something to tell the user about
            expect(activity().filter((d) => d.includes('stayed on this computer'))).toEqual([]);
        });

        test('hide is refused for never-uploaded content with the exact message', async () => {
            const { engine, files } = await downloaded({ 'Code/app/main.ts': 'main', 'Mixed/a.txt': 'a' }, 'vol~root');
            await files.writeLocal('Code/app/.git/HEAD', 'ref: refs/heads/main');
            await symlink(tempDir, local('Mixed/link'));

            const result = await engine.setAvailability('Code', 'hide');
            const mixed = await engine.setAvailability('Mixed', 'hide');

            expect(result.refused).toBe("Can't hide Code: Code/app/.git exists only on this computer");
            expect(mixed.refused).toBe("Can't hide Mixed: Mixed/link exists only on this computer");
            expect(['hidden', 'hiding']).not.toContain(engine.availability.stateOf('Code'));
            expect(['hidden', 'hiding']).not.toContain(engine.availability.stateOf('Mixed'));
            expect(engine.availability.pendingHides()).toEqual([]);
            expect(await readFile(local('Code/app/main.ts'), 'utf8')).toBe('main');
            expect(stateDb.getItemByPath('Code/app/main.ts')).not.toBeNull();
        });

        test('hide waits for uploads, then completes', async () => {
            const { engine, nodes, calls, files } = await downloaded({ 'Drafts/old.txt': 'old' }, 'vol~root');
            await files.writeLocal('Drafts/new.txt', 'not uploaded yet');

            const result = await engine.setAvailability('Drafts', 'hide');

            expect(result).toEqual({ state: 'hiding', kept: [], refused: null });
            expect(await files.exists('Drafts/new.txt')).toBe(true);
            expect(await files.exists('Drafts/old.txt')).toBe(true);

            // The next sync uploads it through the usual path, then finishes the hide
            await engine.reconcileNow();
            expect(calls.uploads).toEqual(['Drafts/new.txt']);
            expect(engine.availability.stateOf('Drafts')).toBe('hidden');
            expect(await files.exists('Drafts')).toBe(false);
            expect(files.recordCount('Drafts')).toBe(0);
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Drafts/old.txt')).toBe(true);

            // Hidden stays hidden: nothing comes back
            await engine.reconcileNow();
            expect(await files.exists('Drafts')).toBe(false);
            expect(calls.downloads).toEqual(['Drafts/old.txt']);
        });

        test('hiding a folder already deleted here leaves no records behind and trashes nothing', async () => {
            const { engine, add, nodes, calls, files } = await downloaded({ 'Old/a.txt': 'a', 'Old/sub/b.txt': 'b' }, 'vol~Old');
            await keepAnotherSyncedFile(add);
            await rm(local('Old'), { recursive: true }); // before any sync has seen the deletion

            const result = await engine.setAvailability('Old', 'hide');

            expect(result.state).toBe('hidden');
            expect(files.recordCount('Old')).toBe(0);
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Old/sub/b.txt')).toBe(true);
        });

        test('a hide whose removal meets an edited file waits as hiding and finishes after the upload', async () => {
            const names = ['a', 'b', 'c'].map((n) => `Docs/${n}.txt`);
            const { engine, nodes, calls, files } = await downloaded(Object.fromEntries(names.map((n) => [n, n])), 'vol~Docs');
            // Everything but the file being removed right now gets edited
            files.onRemoval(1, (rel) => {
                for (const f of names.filter((f) => f !== rel)) {
                    writeFileSync(local(f), 'edited while hiding');
                }
            });

            const result = await engine.setAvailability('Docs', 'hide');

            expect(result.state).toBe('hiding');
            await files.expectNoRecordWithoutFile('Docs');
            await engine.reconcileNow();
            expect(calls.uploads).toHaveLength(2);
            expect(engine.availability.stateOf('Docs')).toBe('hidden');
            expect(await files.exists('Docs')).toBe(false);
            expect(calls.trashed).toEqual([]);
            expect(names.filter((n) => nodes.get(`vol~${n}`)?.content === 'edited while hiding')).toHaveLength(2);
        });

        test("pin during a free's removal stops it and brings back only what went", async () => {
            const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `Docs/${n}.txt`);
            const { engine, calls, files } = await downloaded(Object.fromEntries(names.map((n) => [n, n])), 'vol~Docs');
            let pin: Promise<AvailabilityResult> | undefined;
            files.onRemoval(2, () => {
                pin = engine.setAvailability('Docs', 'pin');
            });

            await engine.setAvailability('Docs', 'free');
            expect((await pin!).state).toBe('pinned');

            expect((await readdir(local('Docs'))).sort()).toEqual(names.map((n) => path.posix.basename(n)));
            expect(calls.downloads).toHaveLength(5 + 2);
            await files.expectNoRecordWithoutFile('Docs');
            expect(calls.trashed).toEqual([]);
        });

        test('a hiding folder keeps syncing local changes, deletes included, but downloads nothing new', async () => {
            const { engine, add, nodes, calls, files } = await downloaded(
                { 'Work/a.txt': 'a', 'Work/b.txt': 'b', 'Work/c.txt': 'c', 'Work/d.txt': 'd' },
                'vol~root',
            );
            // An unresolved conflict keeps the hide waiting
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(local('Work/a.txt'), 'local edit');
            nodes.set(
                'vol~Work/a.txt',
                makeMockNode({ uid: 'vol~Work/a.txt', parentUid: 'vol~Work', nameStr: 'a.txt', type: NodeType.File, content: 'remote edit' }),
            );
            expect((await engine.setAvailability('Work', 'hide')).state).toBe('hiding');

            add('Work/remote-new.txt', 'from another device');
            await files.writeLocal('Work/local-new.txt', 'made here');
            await engine.reconcileNow();

            expect(calls.uploads).toEqual(['Work/local-new.txt']);
            expect(calls.downloads).not.toContain('Work/remote-new.txt');
            expect(engine.availability.stateOf('Work')).toBe('hiding');
            // The watcher still reports changes in it, and they upload
            const watcher = (engine as any).watcher;
            expect(watcher.shouldIgnore('Work/b.txt')).toBe(false);
            await writeFile(local('Work/b.txt'), 'b edited');
            await (engine as any).handleLocalFileChange('Work/b.txt');
            expect(calls.uploads).toEqual(['Work/local-new.txt', 'Work/b.txt']);
            // A local deletion goes to the cloud as it would for a visible folder, and only once, whether the watcher
            // or the sync sees it
            await rm(local('Work/c.txt'));
            await (engine as any).handleLocalFileChange('Work/c.txt');
            await rm(local('Work/d.txt'));
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([['vol~Work/c.txt'], ['vol~Work/d.txt']]);
            expect(nodes.has('vol~Work/b.txt')).toBe(true);
        });

        test('a delete in a hiding folder is trashed in the cloud at once, and a later refusal trashes nothing more', async () => {
            const { engine, nodes, calls, files } = await downloaded({ 'Drafts/old.txt': 'old', 'Drafts/gone.txt': 'g' }, 'vol~root');
            await files.writeLocal('Drafts/new.txt', 'not uploaded yet');
            expect((await engine.setAvailability('Drafts', 'hide')).state).toBe('hiding');

            await rm(local('Drafts/gone.txt'));
            await (engine as any).handleLocalFileChange('Drafts/gone.txt');

            expect(calls.trashed).toEqual([['vol~Drafts/gone.txt']]);
            expect(stateDb.getItemByPath('Drafts/gone.txt')).toBeNull();
            // The hide is then refused on its next try, and nothing else goes to the trash
            await files.writeLocal('Drafts/node_modules/x/index.js', 'ignored, so never uploaded');
            await engine.reconcileNow();
            expect(['hidden', 'hiding']).not.toContain(engine.availability.stateOf('Drafts'));
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([['vol~Drafts/gone.txt']]);
            expect(nodes.has('vol~Drafts/old.txt')).toBe(true);
        });

        test('a hiding folder that gains never-uploaded content stops hiding and says why', async () => {
            const { engine, files } = await downloaded({ 'Drafts/old.txt': 'old' }, 'vol~root');
            await files.writeLocal('Drafts/new.txt', 'not uploaded yet');
            expect((await engine.setAvailability('Drafts', 'hide')).state).toBe('hiding');
            await files.writeLocal('Drafts/node_modules/x/index.js', 'ignored, so never uploaded');

            await engine.reconcileNow();

            expect(['hidden', 'hiding']).not.toContain(engine.availability.stateOf('Drafts'));
            expect(await files.exists('Drafts/node_modules/x/index.js')).toBe(true);
            expect(await files.exists('Drafts/old.txt')).toBe(true);
            expect(activity()).toContain("Can't hide Drafts: Drafts/node_modules exists only on this computer");
        });

        test("unhide during a hide's removal stops it with no record left without its file", async () => {
            const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `Docs/${n}.txt`);
            const { engine, calls, files } = await downloaded(Object.fromEntries(names.map((n) => [n, n])), 'vol~Docs');
            let unhide: Promise<AvailabilityResult> | undefined;
            files.onRemoval(2, () => {
                unhide = engine.setAvailability('Docs', 'unhide');
            });

            await engine.setAvailability('Docs', 'hide');
            const shown = await unhide!;

            const left = (await readdir(local('Docs'))).sort();
            expect(left).toHaveLength(3); // two went before the unhide, then it stopped
            await files.expectNoRecordWithoutFile('Docs');
            expect(shown.state).toBe('online-only');
            expect(engine.availability.stateOf('Docs')).toBe('online-only');
            // Online-only now: the next sync trashes nothing and brings nothing back
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(calls.downloads).toHaveLength(5);
            expect((await readdir(local('Docs'))).sort()).toEqual(left);
        });

        test('a hiding folder unhidden while it is being checked again is left alone', async () => {
            const { engine, calls, files } = await downloaded({ 'Music/song.mp3': 'la la' }, 'vol~Music');
            await files.writeLocal('Music/demo.mp3', 'not uploaded yet');
            expect((await engine.setAvailability('Music', 'hide')).state).toBe('hiding');
            const hides: unknown[] = [];
            const setHide = engine.availability.setHide.bind(engine.availability);
            engine.availability.setHide = (uid, hide) => {
                hides.push(hide);
                setHide(uid, hide);
            };
            // The user unhides once the upload is done and the pending hide is looking at the files again
            let unhide: Promise<AvailabilityResult> | undefined;
            const getItemByPath = stateDb.getItemByPath.bind(stateDb);
            stateDb.getItemByPath = (rel: string) => {
                if (!unhide && rel.startsWith('Music/') && calls.uploads.includes('Music/demo.mp3')) {
                    unhide = engine.setAvailability('Music', 'unhide');
                }
                return getItemByPath(rel);
            };

            await engine.reconcileNow();
            await unhide;

            expect(unhide).toBeDefined();
            expect(hides).toEqual([null]); // never set to hidden, just cleared by the unhide
            expect(await readFile(local('Music/song.mp3'), 'utf8')).toBe('la la');
            expect(await readFile(local('Music/demo.mp3'), 'utf8')).toBe('not uploaded yet');
            expect(files.recordCount('Music')).toBe(3);
            expect(engine.availability.stateOf('Music')).toBe('downloaded');
            expect(calls.trashed).toEqual([]);
        });

        test('unhide drops records whose files are gone, re-reads the cloud folder and leaves it online-only', async () => {
            const { engine, add, nodes, calls } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~root');
            // Hidden by a run that stopped before removing anything (a crash, say): local copies and records are still here
            engine.availability.setHide('vol~Docs', 'hidden');
            await rm(local('Docs/a.txt')); // deleted while hidden, so never taken to the cloud
            add('Docs/c.txt', 'c'); // arrives in the cloud while hidden; nothing lists hidden folders
            await engine.reconcileNow();
            expect(engine.remoteIndex.getByPath('Docs/c.txt')).toBeNull();

            const result = await engine.setAvailability('Docs', 'unhide');

            expect(result).toEqual({ state: 'online-only', kept: [], refused: null });
            expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
            expect(stateDb.getItemByPath('Docs/b.txt')).not.toBeNull();
            expect(engine.remoteIndex.getByPath('Docs/c.txt')).not.toBeNull();
            // The deletion while hidden reaches nothing, and online-only holds even under the pinned root
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Docs/a.txt')).toBe(true);
            expect(calls.downloads.sort()).toEqual(['Docs/a.txt', 'Docs/b.txt']);
            expect(engine.availability.stateOf('Docs')).toBe('online-only');
        });

        test('an explicit choice for the root wins over the fresh-install root pin', async () => {
            const { engine, add, root, calls } = setup();
            add('welcome.txt', 'hello');
            stateDb.setMeta(PIN_ROOT_ON_FIRST_SYNC, '1');
            engine.remoteIndex.setRoot(root.uid); // known, but the first sync has not run yet

            await engine.setAvailability('', 'free');
            await engine.reconcileNow();

            expect(stateDb.getMeta(PIN_ROOT_ON_FIRST_SYNC)).toBeNull();
            expect(calls.downloads).toEqual([]);
            expect(engine.availability.stateOf('')).not.toBe('pinned');
        });

        // A change handler for Docs/a.txt that is already past its wait for availability changes, held on the network
        // round trip its upload makes to see whether the cloud copy is identical
        const handlerHeldOnTheNetwork = async (drive: Awaited<ReturnType<typeof downloaded>>, rel: string) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const getNode = drive.sdk.getNode.bind(drive.sdk);
            (drive.sdk as any).getNode = async (uid: string) => {
                if (uid === `vol~${rel}`) {
                    (drive.sdk as any).getNode = getNode;
                    entered();
                    await gate;
                }
                return getNode(uid);
            };
            const handler: Promise<void> = (drive.engine as any).handleLocalFileChange(rel);
            await inside;
            return { release, handler };
        };

        test('a change handler already under way when Free removes a file does not record it again', async () => {
            const drive = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~Docs');
            const { engine, nodes, calls, files } = drive;
            await writeFile(local('Docs/b.txt'), 'edited, so Free keeps it and the folder');
            // Touched, not changed: Free still sees an unchanged synced copy
            await utimes(local('Docs/a.txt'), new Date(), new Date(Date.now() + 60_000));
            const { release, handler } = await handlerHeldOnTheNetwork(drive, 'Docs/a.txt');

            await engine.setAvailability('Docs', 'free');
            expect(await files.exists('Docs/a.txt')).toBe(false);
            release();
            await handler; // finishes after the removal

            await files.expectNoRecordWithoutFile('Docs');
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Docs/a.txt')).toBe(true);
        });

        test('a change handler finishing after Free emptied the folder leaves nothing that a later pin trashes', async () => {
            const drive = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~Docs');
            const { engine, nodes, calls, files } = drive;
            await utimes(local('Docs/a.txt'), new Date(), new Date(Date.now() + 60_000));
            const { release, handler } = await handlerHeldOnTheNetwork(drive, 'Docs/a.txt');

            await engine.setAvailability('Docs', 'free');
            expect(await files.exists('Docs')).toBe(false);
            release();
            await handler;

            expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
            await engine.reconcileNow();
            await engine.setAvailability('Docs', 'pin');
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Docs/a.txt')).toBe(true);
            expect(await readFile(local('Docs/a.txt'), 'utf8')).toBe('a');
        });

        test('a sync that hashed a file before Free removed it does not record it afterwards', async () => {
            const { engine, nodes, calls, files } = await downloaded({ 'Docs/a.txt': 'a' }, 'vol~Docs');
            await files.writeLocal('Docs/.DS_Store', 'ignored, so Free keeps it and the folder');
            await utimes(local('Docs/a.txt'), new Date(), new Date(Date.now() + 60_000));
            // The sync's hash of a.txt reads the file as it is now, then is held until Free has run
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const realFile = Bun.file.bind(Bun);
            const spy = spyOn(Bun, 'file').mockImplementation(((p: string, ...rest: unknown[]) => {
                const file = (realFile as any)(p, ...rest);
                if (p !== local('Docs/a.txt')) {
                    return file;
                }
                spy.mockRestore(); // only the sync's hash; Free's own look reads the file normally
                const bytes = file.arrayBuffer();
                return {
                    stream: () =>
                        new ReadableStream({
                            async start(controller) {
                                const data = new Uint8Array(await bytes);
                                entered();
                                await gate;
                                controller.enqueue(data);
                                controller.close();
                            },
                        }),
                };
            }) as any);
            const sync = engine.reconcileNow();
            await inside;

            await engine.setAvailability('Docs', 'free');
            expect(await files.exists('Docs/a.txt')).toBe(false);
            release();
            await sync;

            await files.expectNoRecordWithoutFile('Docs');
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Docs/a.txt')).toBe(true);
        });

        test('a record written in the instant between Free dropping it and removing the file does not stay', async () => {
            const { engine, nodes, calls, files } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~Docs');
            await writeFile(local('Docs/b.txt'), 'edited, so Free keeps it and the folder');
            // An upload or download of a.txt finishing right then: its record is gone, its file not yet
            const record = stateDb.getItemByPath('Docs/a.txt')!;
            const removeItemByPath = stateDb.removeItemByPath.bind(stateDb);
            let written = false;
            stateDb.removeItemByPath = (rel: string) => {
                removeItemByPath(rel);
                if (rel === 'Docs/a.txt' && !written) {
                    written = true;
                    (engine as any).recordSynced(record, 0);
                }
            };

            await engine.setAvailability('Docs', 'free');

            expect(written).toBe(true);
            expect(await files.exists('Docs/a.txt')).toBe(false);
            await files.expectNoRecordWithoutFile('Docs');
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Docs/a.txt')).toBe(true);
        });

        test('a record written in the instant between a hide dropping it and removing the file does not stay', async () => {
            const names = ['a', 'b', 'c'].map((n) => `Docs/${n}.txt`);
            const { engine, files } = await downloaded(Object.fromEntries(names.map((n) => [n, n])), 'vol~Docs');
            const records = new Map(names.map((n) => [n, stateDb.getItemByPath(n)!]));
            // The first file's record is written again right after it is dropped (an upload finishing then), and the
            // others are edited, so the hide stops after that file and waits as hiding
            const removeItemByPath = stateDb.removeItemByPath.bind(stateDb);
            let first = '';
            stateDb.removeItemByPath = (rel: string) => {
                removeItemByPath(rel);
                if (!first && records.has(rel)) {
                    first = rel;
                    (engine as any).recordSynced(records.get(rel), 0);
                    for (const other of names.filter((n) => n !== rel)) {
                        writeFileSync(local(other), 'edited while hiding');
                    }
                }
            };

            expect((await engine.setAvailability('Docs', 'hide')).state).toBe('hiding');

            expect(await files.exists(first)).toBe(false);
            await files.expectNoRecordWithoutFile('Docs');
        });

        // Lets the upload of `rel` send its bytes, then runs `during` (the user acting on the file) before it completes
        const duringUpload = (sdk: ProtonDriveClient, rel: string, during: () => Promise<void>) => {
            const getFileUploader = sdk.getFileUploader.bind(sdk);
            (sdk as any).getFileUploader = async (parent: NodeEntity, name: string, metadata: any) => {
                const uploader = await getFileUploader(parent, name, metadata);
                if (name !== path.posix.basename(rel)) {
                    return uploader;
                }
                return {
                    uploadFromStream: async (...args: Parameters<typeof uploader.uploadFromStream>) => {
                        const result = await uploader.uploadFromStream(...args);
                        await during();
                        return result;
                    },
                };
            };
        };
        const namesIn = (nodes: Map<string, NodeEntity>, parentUid: string) =>
            [...nodes.values()]
                .filter((n) => n.uid !== 'vol~root' && n.parentUid === parentUid)
                .map((n) => (n.name.ok ? n.name.value : ''))
                .sort();

        test('a new file deleted while it uploads is trashed in the cloud, not brought back', async () => {
            const { engine, sdk, nodes, calls, files } = await downloaded({ 'Docs/a.txt': 'a' }, 'vol~root');
            await files.writeLocal('Docs/big.bin', 'big');
            let deleted: Promise<void> | undefined;
            duringUpload(sdk, 'Docs/big.bin', async () => {
                await rm(local('Docs/big.bin'));
                deleted = (engine as any).handleLocalFileChange('Docs/big.bin'); // the watcher's delete event
            });

            await (engine as any).handleLocalFileChange('Docs/big.bin');
            await deleted;
            await engine.reconcileNow();

            expect(calls.trashed).toHaveLength(1);
            expect(namesIn(nodes, 'vol~Docs')).toEqual(['a.txt']);
            expect(await files.exists('Docs/big.bin')).toBe(false);
            expect(stateDb.getItemByPath('Docs/big.bin')).toBeNull();
        });

        test('a new file renamed while it uploads ends up once, under its new name', async () => {
            const { engine, sdk, nodes, files } = await downloaded({ 'Docs/a.txt': 'a' }, 'vol~root');
            await files.writeLocal('Docs/draft.txt', 'text');
            let handlers: Promise<void>[] = [];
            duringUpload(sdk, 'Docs/draft.txt', async () => {
                await rename(local('Docs/draft.txt'), local('Docs/final.txt'));
                handlers = ['Docs/draft.txt', 'Docs/final.txt'].map((rel) => (engine as any).handleLocalFileChange(rel));
            });

            await (engine as any).handleLocalFileChange('Docs/draft.txt');
            await Promise.all(handlers);
            await engine.reconcileNow();

            expect(namesIn(nodes, 'vol~Docs')).toEqual(['a.txt', 'final.txt']);
            expect((await readdir(local('Docs'))).sort()).toEqual(['a.txt', 'final.txt']);
        });

        test('a new folder renamed while it is created in the cloud ends up once, under its new name', async () => {
            const { engine, sdk, nodes } = await downloaded({ 'Docs/a.txt': 'a' }, 'vol~root');
            await mkdir(local('Untitled Folder'));
            const createFolder = sdk.createFolder.bind(sdk);
            let handlers: Promise<void>[] = [];
            (sdk as any).createFolder = async (parent: NodeEntity, name: string) => {
                const folder = await createFolder(parent, name);
                if (name === 'Untitled Folder') {
                    await rename(local('Untitled Folder'), local('Projects'));
                    handlers = ['Untitled Folder', 'Projects'].map((rel) => (engine as any).handleLocalFileChange(rel));
                }
                return folder;
            };

            await (engine as any).handleLocalFileChange('Untitled Folder');
            await Promise.all(handlers);
            await engine.reconcileNow();

            expect(namesIn(nodes, 'vol~root')).toEqual(['Docs', 'Projects']);
            expect((await readdir(local(''))).sort()).toEqual(['Docs', 'Projects']);
        });

        test('a new file Free keeps gets its record when its upload finishes during the removal', async () => {
            const { engine, sdk, calls, files } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~Docs');
            await files.writeLocal('Docs/n.txt', 'new');
            // The upload completes only once Free has started removing
            let removalStarted!: () => void;
            const removing = new Promise<void>((resolve) => (removalStarted = resolve));
            files.onRemoval(1, () => removalStarted());
            let uploading!: () => void;
            const uploaded = new Promise<void>((resolve) => (uploading = resolve));
            duringUpload(sdk, 'Docs/n.txt', async () => {
                uploading();
                await removing;
            });
            const handler = (engine as any).handleLocalFileChange('Docs/n.txt');
            await uploaded;

            const result = await engine.setAvailability('Docs', 'free');
            await handler;

            expect(result.kept).toContain('Docs/n.txt');
            expect(stateDb.getItemByPath('Docs/n.txt')).not.toBeNull();
            // So a later edit uploads as an edit, not as a conflict
            await writeFile(local('Docs/n.txt'), 'new, edited again');
            await engine.reconcileNow();
            expect((await readdir(local('Docs'))).sort()).toEqual(['n.txt']);
            expect(calls.uploads).toEqual(['Docs/n.txt', 'Docs/n.txt']);
        });

        test('a sync about to hash a file that Free then removes carries on', async () => {
            const { engine, calls, files } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/z.txt': 'z' }, 'vol~Docs');
            await files.writeLocal('Docs/.DS_Store', 'ignored, so Free keeps it and the folder');
            await utimes(local('Docs/a.txt'), new Date(), new Date(Date.now() + 60_000));
            // The sync's hash of a.txt opens the file only once Free has removed it
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const realFile = Bun.file.bind(Bun);
            const spy = spyOn(Bun, 'file').mockImplementation(((p: string, ...rest: unknown[]) => {
                if (p !== local('Docs/a.txt')) {
                    return (realFile as any)(p, ...rest);
                }
                spy.mockRestore();
                return {
                    stream: () =>
                        new ReadableStream({
                            async start(controller) {
                                entered();
                                await gate;
                                try {
                                    controller.enqueue(new Uint8Array(await (realFile as any)(p).arrayBuffer()));
                                    controller.close();
                                } catch (error) {
                                    controller.error(error);
                                }
                            },
                        }),
                };
            }) as any);
            const sync = engine.reconcileNow();
            await inside;

            await engine.setAvailability('Docs', 'free');
            release();
            await sync;

            expect(engine.getStatus().state).toBe('idle');
            expect(engine.getStatus().lastError).toBeNull();
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
        });

        test('a record check that cannot look at the path counts it as gone instead of failing', async () => {
            const { engine, files } = await downloaded({ 'Docs/sub/f.txt': 'f', 'Docs/keep.txt': 'k' }, 'vol~Docs');
            await writeFile(local('Docs/keep.txt'), 'edited, so Free keeps it and the folder');
            const record = stateDb.getItemByPath('Docs/sub/f.txt')!;
            // Work that began before the free, finishing after it
            await (engine as any).observingLocal(async (since: number) => {
                await engine.setAvailability('Docs', 'free');
                await writeFile(local('Docs/sub'), 'now a file, so looking at Docs/sub/f.txt fails with ENOTDIR');

                expect(() => (engine as any).recordSynced(record, since)).not.toThrow();
            });

            expect(stateDb.getItemByPath('Docs/sub/f.txt')).toBeNull();
            expect(await files.exists('Docs/sub')).toBe(true);
        });

        test('pinning a folder whose name ends in a space clears its syncing mark', async () => {
            const { engine, add, calls } = setup();
            add('Photos /a.jpg', 'a');
            await engine.reconcileNow();

            await engine.setAvailability('Photos ', 'pin');

            expect(calls.downloads).toEqual(['Photos /a.jpg']);
            expect(engine.getStatus().syncingFolders).toEqual([]);
            expect(engine.getStatus().state).toBe('idle');
        });

        test('an unhide asked while a pending hide waits its turn stops it', async () => {
            const { engine, files } = await downloaded({ 'Music/song.mp3': 'la la' }, 'vol~Music');
            await files.writeLocal('Music/demo.mp3', 'not uploaded yet');
            expect((await engine.setAvailability('Music', 'hide')).state).toBe('hiding');
            // Something else holds the queue when the sync finishes, and the user unhides Music meanwhile
            const p = engine as any;
            const completePendingHides = p.completePendingHides.bind(engine);
            let unhide: Promise<AvailabilityResult> | undefined;
            p.completePendingHides = async () => {
                let releaseHold!: () => void;
                const hold = new Promise<void>((resolve) => (releaseHold = resolve));
                const held = p.inAvailabilityRun(() => hold);
                const done = completePendingHides(); // waits behind the hold
                unhide = engine.setAvailability('Music', 'unhide');
                releaseHold();
                await held;
                await done;
            };

            await engine.reconcileNow();
            await unhide;

            expect(await readFile(local('Music/song.mp3'), 'utf8')).toBe('la la');
            expect(await readFile(local('Music/demo.mp3'), 'utf8')).toBe('not uploaded yet');
            expect(engine.availability.stateOf('Music')).toBe('downloaded');
        });
    });

    // Issue #30: moving the plain sync folder to a new place must never replace anything already there
    describe('relocating the plain sync folder', () => {
        const setup = (loggedIn = true) => {
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => loggedIn }, stateDb, drive.logger);
            return { ...drive, engine, oldDir: stateDb.getSettings().syncDir, newDir: path.join(tempDir, 'Elsewhere') };
        };

        // S30: a folder that already holds files is refused, so nothing unrelated is pulled into the drive, and a move
        // that stops part way can be undone exactly
        test('a new folder that already holds files is refused before anything moves', async () => {
            const d = setup(false);
            await mkdir(d.oldDir, { recursive: true });
            await writeFile(path.join(d.oldDir, 'a.txt'), 'synced a');
            await mkdir(d.newDir, { recursive: true });
            await writeFile(path.join(d.newDir, 'a.txt'), 'the user\'s own a.txt');
            await expect(d.engine.relocateSyncFolder(d.oldDir, d.newDir)).rejects.toThrow(/Choose an empty folder, or a new one/);
            expect(await readFile(path.join(d.oldDir, 'a.txt'), 'utf8')).toBe('synced a');
            expect(await readFile(path.join(d.newDir, 'a.txt'), 'utf8')).toBe('the user\'s own a.txt');
            expect(stateDb.getSettings().syncDir).toBe(d.oldDir);
        });

        test('synced files moved to an empty folder keep their records: nothing is trashed, uploaded or downloaded again', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'synced a');
            d.add('top.txt', 'synced top');
            d.engine.availability.setPin(d.root.uid, 'pinned', false);
            await d.engine.start({ backgroundInitialReconcile: false });
            await d.engine.reconcileNow();
            await mkdir(d.newDir, { recursive: true }); // there, and empty
            const records = stateDb.getAllItems();
            const downloads = [...d.calls.downloads];

            expect(await d.engine.relocateSyncFolder(d.oldDir, d.newDir)).toBe(d.newDir);

            expect(await readFile(path.join(d.newDir, 'Docs/a.txt'), 'utf8')).toBe('synced a');
            expect(await readFile(path.join(d.newDir, 'top.txt'), 'utf8')).toBe('synced top');
            expect(await readdir(d.oldDir)).toEqual([]);
            expect(stateDb.getSettings().syncDir).toBe(d.newDir);
            // The next pass (started by the relocation) finds every synced file where its record says
            await d.engine.holdForMove(); // waits for that pass
            d.engine.releaseHold();
            expect(records.map((r) => stateDb.getItemByPath(r.localRelPath)?.nodeUid)).toEqual(records.map((r) => r.nodeUid));
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.downloads).toEqual(downloads);
            await d.engine.stop();
        });

        test('a new folder inside the old one, or holding it, is refused and nothing moves', async () => {
            const d = setup(false);
            await mkdir(d.oldDir, { recursive: true });
            await writeFile(path.join(d.oldDir, 'a.txt'), 'a');
            await expect(d.engine.relocateSyncFolder(d.oldDir, path.join(d.oldDir, 'Sub'))).rejects.toThrow(/inside/);
            await expect(d.engine.relocateSyncFolder(d.oldDir, tempDir)).rejects.toThrow(/inside/);
            expect(await readdir(d.oldDir)).toEqual(['a.txt']);
            expect(stateDb.getSettings().syncDir).toBe(d.oldDir);
        });
    });

    describe('virtual layout', () => {
        test('the engine works entirely in the backing dir and never creates anything in the sync folder', async () => {
            const backingDir = path.join(tempDir, 'files');
            const syncDir = stateDb.getSettings().syncDir;
            stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                backingDir,
            });
            const files = localFiles(stateDb, () => backingDir);
            expect(engine.localRoot()).toBe(backingDir);
            expect(engine.getStatus().syncDir).toBe(syncDir);

            drive.add('Docs/a.txt', 'a');
            engine.availability.setPin(drive.add('Docs').uid, 'pinned', false);
            await engine.reconcileNow();
            expect(await readFile(path.join(backingDir, 'Docs/a.txt'), 'utf8')).toBe('a');

            await files.writeLocal('Docs/new.txt', 'new');
            await engine.reconcileNow();
            expect(drive.calls.uploads).toEqual(['Docs/new.txt']);

            await engine.setAvailability('Docs', 'free');
            expect(await files.exists('Docs/a.txt')).toBe(false);
            expect(drive.calls.trashed).toEqual([]);

            expect(await stat(syncDir).then(() => true, () => false)).toBe(false);
            await engine.stop();
        });
        test('relocating the sync folder only changes the setting, leaving the backing dir alone', async () => {
            const backingDir = path.join(tempDir, 'files');
            stateDb.setMeta('driveLayout', 'virtual');
            await mkdir(backingDir, { recursive: true });
            await writeFile(path.join(backingDir, 'a.txt'), 'a');
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                backingDir,
            });
            const target = path.join(tempDir, 'Elsewhere');

            const result = await engine.relocateSyncFolder(stateDb.getSettings().syncDir, target);

            expect(result).toBe(target);
            expect(stateDb.getSettings().syncDir).toBe(target);
            expect(await readFile(path.join(backingDir, 'a.txt'), 'utf8')).toBe('a');
            expect(await stat(target).then(() => true, () => false)).toBe(false);
        });
    });

    // While files move between the sync folder and the backing store, nothing in the engine may look at them: a half-moved
    // tree reads as files deleted here, which trashes them in the cloud
    describe('holding the engine for a layout move', () => {
        const setup = () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            const backingDir = path.join(tempDir, 'files');
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                backingDir,
            });
            // Cloud listings, counted, and held up while `gate` is set
            const listing = { calls: 0, gate: null as Promise<void> | null };
            const iterate = drive.sdk.iterateFolderChildren.bind(drive.sdk);
            (drive.sdk as { iterateFolderChildren: unknown }).iterateFolderChildren = async function* (
                parent: Parameters<typeof iterate>[0],
            ) {
                listing.calls += 1;
                if (listing.gate) await listing.gate;
                yield* iterate(parent);
            };
            // The engine's listener for cloud events, kept after it unsubscribes: an event already on its way still arrives
            type Listener = Parameters<EventsManager['addEventListener']>[0];
            const events = { listener: null as Listener | null };
            const addEventListener = drive.eventsManager.addEventListener.bind(drive.eventsManager);
            (drive.eventsManager as { addEventListener: unknown }).addEventListener = (cb: Listener) => {
                events.listener = cb;
                return addEventListener(cb);
            };
            const holdUpListings = () => {
                let release!: () => void;
                listing.gate = new Promise<void>((resolve) => (release = resolve));
                return () => {
                    listing.gate = null;
                    release();
                };
            };
            return { ...drive, engine, listing, events, holdUpListings, files: localFiles(stateDb, () => backingDir) };
        };
        const busy = { code: 'EIO', message: 'Proton Drive is busy moving files' };

        test('waits for a running pass; while held, passes, starts and drive changes do nothing and are refused', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
            await d.engine.start({ backgroundInitialReconcile: false });
            await d.engine.reconcileNow();
            const release = d.holdUpListings();
            const pass = d.engine.reconcileNow();
            let held = false;
            const hold = d.engine.holdForMove().then(() => (held = true));
            await Bun.sleep(50);
            expect(held).toBe(false);
            release();
            await pass;
            await hold;

            const callsWhenHeld = d.listing.calls;
            await d.engine.reconcileNow();
            await d.engine.start({ backgroundInitialReconcile: false });
            await d.engine.replayRemoteOps();
            expect(d.listing.calls).toBe(callsWhenHeld);
            await expect(d.engine.renameItem('Docs/a.txt', 'Docs/b.txt')).rejects.toMatchObject(busy);
            await expect(d.engine.deleteItem('Docs/a.txt')).rejects.toMatchObject(busy);
            await expect(d.engine.truncateItem('Docs/new.txt')).rejects.toMatchObject(busy);
            await expect(d.engine.hydrate('Docs/a.txt')).rejects.toMatchObject(busy);
            expect(() => d.engine.vfsChildren('Docs')).toThrow(busy.message);
            await expect(d.engine.setAvailability('Docs', 'free')).rejects.toThrow(busy.message);
            await d.events.listener!('drive', {
                type: DriveEventType.NodeDeleted,
                nodeUid: 'vol~Docs/a.txt',
                parentNodeUid: 'vol~Docs',
                treeEventScopeId: 's',
                eventId: 'e1',
            });
            expect(await d.files.exists('Docs/a.txt')).toBe(true);
            expect(stateDb.getItemByPath('Docs/a.txt')).not.toBeNull();

            d.engine.releaseHold();
            await d.engine.start({ backgroundInitialReconcile: false });
            expect(d.listing.calls).toBeGreaterThan(callsWhenHeld);
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            expect(await d.files.exists('Docs/b.txt')).toBe(true);
            await d.engine.stop();
        });

        // Final review I-1: an engine that was never held (the CLI's own, with the daemon stopped) finds the files half
        // moved. Nothing in it may look at them while a move marker is set: the half not yet moved reads as deleted.
        for (const marker of ['layoutMoving', 'syncDirMoving'] as const) {
            test(`an engine never held does nothing while ${marker} is set, and logs it once`, async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
                await d.engine.reconcileNow();
                expect(await d.files.exists('Docs/a.txt')).toBe(true);
                // A move out of the backing store cut short: a.txt is in the sync folder already, b.txt isn't yet
                const syncDir = stateDb.getSettings().syncDir;
                stateDb.setMeta(marker, marker === 'layoutMoving' ? 'plain' : JSON.stringify({ from: syncDir, to: path.join(tempDir, 'New') }));
                await mkdir(path.join(syncDir, 'Docs'), { recursive: true });
                await rename(path.join(tempDir, 'files', 'Docs/a.txt'), path.join(syncDir, 'Docs/a.txt'));
                const records = stateDb.getAllItems().length;
                const listings = d.listing.calls;

                // A fresh engine on the same database, as `protondrive sync` or `conflicts resolve` builds one
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    backingDir: path.join(tempDir, 'files'),
                });
                try {
                    const warnings = d.warnings.length;
                    await engine.reconcileNow();
                    await engine.start({ backgroundInitialReconcile: false });
                    await engine.replayRemoteOps();
                    await (engine as any).handleLocalFileChange('Docs/a.txt');
                    await d.events.listener?.('drive', {
                        type: DriveEventType.NodeDeleted,
                        nodeUid: 'vol~Docs/b.txt',
                        parentNodeUid: 'vol~Docs',
                        treeEventScopeId: 's',
                        eventId: 'e1',
                    });
                    const refusal = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
                    const refusals = [
                        await refusal(engine.resolveConflictManually(1, 'keep-local')),
                        await refusal(engine.deleteItem('Docs/b.txt')),
                        await refusal(engine.setAvailability('Docs', 'free')),
                    ];

                    expect(d.calls.trashed).toEqual([]);
                    expect(d.calls.uploads).toEqual([]);
                    expect(d.listing.calls).toBe(listings);
                    expect(stateDb.getAllItems()).toHaveLength(records);
                    expect(await d.files.exists('Docs/b.txt')).toBe(true);
                    expect(refusals).toEqual([busy.message, busy.message, busy.message]);
                    expect(d.warnings.slice(warnings).filter((w) => /moving files/.test(w))).toHaveLength(1);

                    // Once the move is done (the daemon finishes it), the engine works again
                    stateDb.deleteMeta(marker);
                    await rename(path.join(syncDir, 'Docs/a.txt'), path.join(tempDir, 'files', 'Docs/a.txt'));
                    await engine.reconcileNow();
                    expect(d.listing.calls).toBeGreaterThan(listings);
                    expect(d.calls.trashed).toEqual([]);
                } finally {
                    await engine.stop();
                }
            });
        }

        test('a hold that waits too long gives up, leaving the engine as it was', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            const release = d.holdUpListings();
            const pass = d.engine.reconcileNow();
            await expect(d.engine.holdForMove({ timeoutMs: 50 })).rejects.toThrow(/still busy/);
            release();
            await pass;
            const calls = d.listing.calls;
            await d.engine.reconcileNow();
            expect(d.listing.calls).toBeGreaterThan(calls);
        });
    });

    // #45 (S38): a sync folder deleted or moved away, or an emptied backing store, leaves records whose files are all
    // gone. That is never taken for the user deleting everything: the engine holds, says so, and goes on once the files
    // are back. A partial loss is still the user deleting those items.
    describe('a missing or emptied local root (#45)', () => {
        const missing = (root: string) => `Proton Drive's files are missing from ${root}. Nothing was deleted in Proton Drive.`;
        const exists = (p: string) => stat(p).then(() => true, () => false);
        const setup = (layout: 'plain' | 'virtual' = 'plain') => {
            if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            const backingDir = path.join(tempDir, 'files');
            const localRoot = layout === 'virtual' ? backingDir : stateDb.getSettings().syncDir;
            // A new engine on the same database and drive is what a restart of the daemon gives
            const restart = () =>
                new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    backingDir,
                });
            return { ...drive, engine: restart(), restart, localRoot, files: localFiles(stateDb, () => localRoot) };
        };
        // Two top-level folders, synced and downloaded, and one online-only
        const synced = async (d: ReturnType<typeof setup>) => {
            d.add('Docs/a.txt', 'a');
            d.add('Docs/b.txt', 'b');
            d.add('Photos/p.jpg', 'p');
            d.add('Notes/n.txt', 'n');
            d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
            d.engine.availability.setPin(d.add('Photos').uid, 'pinned', false);
            await d.engine.reconcileNow();
            expect(d.engine.availability.stateOf('Notes/n.txt')).toBe('online-only');
            expect(await d.files.exists('Docs/a.txt')).toBe(true);
            expect(await d.files.exists('Photos/p.jpg')).toBe(true);
            expect(d.engine.getStatus().state).toBe('idle');
            return stateDb.getAllItems().length;
        };
        const missingWarnings = (d: ReturnType<typeof setup>) => d.warnings.filter((w) => w.includes('missing from'));

        test('a deleted sync folder: a start trashes nothing, never makes the folder again, and the status says so', async () => {
            const d = setup();
            const records = await synced(d);
            await rm(d.localRoot, { recursive: true, force: true });

            const engine = d.restart();
            try {
                await engine.start({ backgroundInitialReconcile: false });
                await engine.reconcileNow(); // the timer's next pass
                expect(d.calls.trashed).toEqual([]);
                expect(await exists(d.localRoot)).toBe(false);
                expect(engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.localRoot) });
                expect(stateDb.getAllItems()).toHaveLength(records);
                expect(missingWarnings(d)).toHaveLength(1);
                expect(stateDb.listActivity(50).filter((a) => a.details === missing(d.localRoot))).toHaveLength(1);
            } finally {
                await engine.stop();
            }
        });

        test('an emptied sync folder: passes, local deletes and cloud events trash nothing and drop no record', async () => {
            const d = setup();
            const records = await synced(d);
            await rm(path.join(d.localRoot, 'Docs'), { recursive: true });
            await rm(path.join(d.localRoot, 'Photos'), { recursive: true });

            await d.engine.reconcileNow();
            await (d.engine as any).handleLocalFileChange('Docs/a.txt');
            await (d.engine as any).handleLocalFileChange('Docs');
            await (d.engine as any).handleRemoteDriveEvent({
                type: DriveEventType.NodeUpdated,
                nodeUid: 'vol~Photos/p.jpg',
                parentNodeUid: 'vol~Photos',
                treeEventScopeId: 's',
                eventId: 'e1',
            });
            await expect(d.engine.setAvailability('Docs', 'pin')).rejects.toThrow(missing(d.localRoot));

            expect(d.calls.trashed).toEqual([]);
            expect(stateDb.getAllItems()).toHaveLength(records);
            expect(await readdir(d.localRoot)).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.localRoot) });
        });

        test('the virtual layout with an emptied store trashes nothing, and an open of an online-only file is refused', async () => {
            const d = setup('virtual');
            const records = await synced(d);
            await rm(d.localRoot, { recursive: true, force: true });
            await mkdir(d.localRoot);

            await d.engine.reconcileNow();
            await expect(d.engine.hydrate('Notes/n.txt')).rejects.toMatchObject({ code: 'EIO', message: missing(d.localRoot) });

            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.downloads.filter((p) => p.startsWith('Notes'))).toEqual([]);
            expect(stateDb.getAllItems()).toHaveLength(records);
            expect(await readdir(d.localRoot)).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.localRoot) });
        });

        test('once the files are back, the next pass syncs as usual, and a genuine delete then reaches Proton Drive', async () => {
            const d = setup();
            await synced(d);
            const away = path.join(tempDir, 'Moved away');
            await rename(d.localRoot, away);
            await d.engine.reconcileNow();
            expect(d.engine.getStatus().state).toBe('error');

            await rename(away, d.localRoot);
            await d.engine.reconcileNow();
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null });
            expect(d.calls.trashed).toEqual([]);

            await rm(path.join(d.localRoot, 'Docs/a.txt'));
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
        });

        test('a sync folder deleted and made again is watched afresh once the files are back', async () => {
            const d = setup();
            await synced(d);
            const backup = path.join(tempDir, 'backup');
            await cp(d.localRoot, backup, { recursive: true, preserveTimestamps: true });
            const engine = d.restart();
            try {
                await engine.start({ backgroundInitialReconcile: false });
                await rm(d.localRoot, { recursive: true, force: true });
                await engine.reconcileNow();
                expect(engine.getStatus().state).toBe('error');

                await cp(backup, d.localRoot, { recursive: true, preserveTimestamps: true });
                await engine.reconcileNow();
                expect(engine.getStatus()).toMatchObject({ state: 'idle', lastError: null });
                await writeFile(path.join(d.localRoot, 'Docs/new.txt'), 'new');
                for (let i = 0; i < 300 && !d.calls.uploads.includes('Docs/new.txt'); i++) await Bun.sleep(10);
                expect(d.calls.uploads).toEqual(['Docs/new.txt']);
                expect(d.calls.trashed).toEqual([]);
            } finally {
                await engine.stop();
            }
        });

        test('a partial loss (one top-level folder still there) is the user deleting the rest, as before', async () => {
            const d = setup();
            await synced(d);
            await rm(path.join(d.localRoot, 'Docs'), { recursive: true });

            await d.engine.reconcileNow();

            expect(d.calls.trashed.flat()).toContain('vol~Docs');
            expect(d.engine.getStatus().lastError).toBeNull();
        });

        test('a fresh install (no records) makes the sync folder at start, as before', async () => {
            const d = setup();
            expect(await exists(d.localRoot)).toBe(false);
            await d.engine.start({ backgroundInitialReconcile: false });
            try {
                expect(await exists(d.localRoot)).toBe(true);
                expect(d.engine.getStatus().lastError).toBeNull();
            } finally {
                await d.engine.stop();
            }
        });
    });

    // Projects is deleted or trashed in the cloud (on the web, or on another device) while this computer holds things
    // in it that exist nowhere else: they must survive, in the desktop Trash or where they are (issue #16)
    describe('cloud-side deletes', () => {
        const activity = () => stateDb.listActivity(500).map((a) => a.details);
        // Projects downloaded through the engine, so the records are real. The desktop Trash is a fake that records
        // what it is handed and, when it works, moves it into tempDir/Trash.
        const downloadedProjects = async (layout: 'plain' | 'virtual', trashWorks = true) => {
            if (layout === 'virtual') {
                stateDb.setMeta('driveLayout', 'virtual');
            }
            const drive = makeMockDrive();
            const trashDir = path.join(tempDir, 'Trash');
            const handedToTrash: string[] = [];
            const moveToDesktopTrash = async (fullPath: string) => {
                handedToTrash.push(fullPath);
                if (!trashWorks) {
                    return false;
                }
                await mkdir(trashDir, { recursive: true });
                await rename(fullPath, path.join(trashDir, path.basename(fullPath)));
                return true;
            };
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash,
            });
            drive.add('Projects/readme.txt', 'readme');
            drive.add('Projects/app/index.ts', 'index');
            drive.add('Projects/notes.txt', 'synced version');
            engine.availability.setPin(drive.root.uid, 'pinned', false);
            await engine.reconcileNow();
            expect(drive.calls.downloads.sort()).toEqual(['Projects/app/index.ts', 'Projects/notes.txt', 'Projects/readme.txt']);
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            const trashed = () => handedToTrash.map((p) => path.relative(engine.localRoot(), p)).sort();
            return { ...drive, engine, files: localFiles(stateDb, () => engine.localRoot()), local, trashDir, trashed };
        };
        type Drive = Awaited<ReturnType<typeof downloadedProjects>>;
        // An ignored .git, which is never uploaded, and an edit that hasn't uploaded yet
        const addLocalOnly = async (d: Drive) => {
            await d.files.writeLocal('Projects/app/.git/HEAD', 'ref: refs/heads/main');
            await writeFile(d.local('Projects/notes.txt'), 'edited, not uploaded yet');
        };
        const goneFromCloud = (d: Drive, relPath: string) => {
            for (const uid of [...d.nodes.keys()]) {
                if (uid === `vol~${relPath}` || uid.startsWith(`vol~${relPath}/`)) {
                    d.nodes.delete(uid);
                }
            }
        };
        const event = (d: Drive, e: DriveEvent): Promise<void> => (d.engine as any).handleRemoteDriveEvent(e);
        // The three ways the engine learns of it, each after the cloud stopped listing Projects
        const cloudDeletes: Array<[string, (d: Drive) => Promise<void>]> = [
            ['a sync pass that no longer finds it', (d) => d.engine.reconcileNow()],
            [
                'a NodeDeleted event',
                (d) =>
                    event(d, {
                        type: DriveEventType.NodeDeleted,
                        nodeUid: 'vol~Projects',
                        parentNodeUid: d.root.uid,
                        treeEventScopeId: 'scope-main',
                        eventId: 'evt-deleted',
                    }),
            ],
            [
                'a NodeUpdated event saying it was trashed',
                (d) =>
                    event(d, {
                        type: DriveEventType.NodeUpdated,
                        nodeUid: 'vol~Projects',
                        parentNodeUid: d.root.uid,
                        isTrashed: true,
                        isShared: false,
                        treeEventScopeId: 'scope-main',
                        eventId: 'evt-trashed',
                    }),
            ],
        ];

        for (const layout of ['plain', 'virtual'] as const) {
            for (const [how, deleteInCloud] of cloudDeletes) {
                test(`${layout}, ${how}: an ignored .git and an unsynced edit go to the desktop Trash, the rest is removed`, async () => {
                    const d = await downloadedProjects(layout);
                    await addLocalOnly(d);
                    goneFromCloud(d, 'Projects');

                    await deleteInCloud(d);

                    // The topmost local-only things, not the folders holding them
                    expect(d.trashed()).toEqual(['Projects/app/.git', 'Projects/notes.txt']);
                    expect(await readFile(path.join(d.trashDir, '.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
                    expect(await readFile(path.join(d.trashDir, 'notes.txt'), 'utf8')).toBe('edited, not uploaded yet');
                    expect(await d.files.exists('Projects')).toBe(false); // emptied, so removed
                    expect(d.files.recordCount('Projects')).toBe(0);
                    expect(activity()).toContain(
                        'Projects was removed from Proton Drive. 2 item(s) that existed only on this computer were moved to your Trash.',
                    );
                    // Nothing is trashed in the cloud or uploaded again afterwards
                    await d.engine.reconcileNow();
                    expect(d.calls.trashed).toEqual([]);
                    expect(d.calls.uploads).toEqual([]);
                    expect(await d.files.exists('Projects')).toBe(false);
                    if (layout === 'virtual') {
                        expect(await stat(stateDb.getSettings().syncDir).then(() => true, () => false)).toBe(false);
                    }
                });

                test(`${layout}, ${how}: a fully synced folder is removed and the desktop Trash is never called`, async () => {
                    const d = await downloadedProjects(layout);
                    goneFromCloud(d, 'Projects');

                    await deleteInCloud(d);

                    expect(d.trashed()).toEqual([]);
                    expect(await d.files.exists('Projects')).toBe(false);
                    expect(d.files.recordCount('Projects')).toBe(0);
                    expect(activity().filter((a) => a.includes('was removed from Proton Drive'))).toEqual([]);
                    await d.engine.reconcileNow();
                    expect(d.calls.trashed).toEqual([]);
                    expect(d.calls.uploads).toEqual([]);
                });

                test(`${layout}, ${how}: what the desktop Trash can't take stays in place, unrecorded, and uploads again`, async () => {
                    const d = await downloadedProjects(layout, false);
                    await addLocalOnly(d);
                    goneFromCloud(d, 'Projects');

                    await deleteInCloud(d);

                    expect(d.trashed()).toEqual(['Projects/app/.git', 'Projects/notes.txt']);
                    expect(await readFile(d.local('Projects/app/.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
                    expect(await readFile(d.local('Projects/notes.txt'), 'utf8')).toBe('edited, not uploaded yet');
                    expect(await d.files.exists('Projects/readme.txt')).toBe(false);
                    expect(await d.files.exists('Projects/app/index.ts')).toBe(false);
                    expect(d.files.recordCount('Projects')).toBe(0);
                    // Where the user sees it: the sync folder, also when the files are in the backing store
                    const where = path.join(stateDb.getSettings().syncDir, 'Projects');
                    expect(activity()).toContain(
                        `Projects was removed from Proton Drive. 2 item(s) that existed only on this computer were kept at ${where} and will upload again.`,
                    );
                    // A new local item from now on: the edit uploads (the ignored .git never does), nothing is trashed
                    await d.engine.reconcileNow();
                    expect(d.calls.trashed).toEqual([]);
                    expect(d.calls.uploads).toEqual(['Projects/notes.txt']);
                    expect(await readFile(d.local('Projects/app/.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
                });
            }
        }

        test('a folder made here and never uploaded goes to the desktop Trash as one item', async () => {
            const d = await downloadedProjects('plain');
            await d.files.writeLocal('Projects/drafts/a.txt', 'a');
            await d.files.writeLocal('Projects/drafts/b.txt', 'b');
            goneFromCloud(d, 'Projects');

            await event(d, {
                type: DriveEventType.NodeDeleted,
                nodeUid: 'vol~Projects',
                parentNodeUid: d.root.uid,
                treeEventScopeId: 'scope-main',
                eventId: 'evt-deleted',
            });

            expect(d.trashed()).toEqual(['Projects/drafts']);
            expect((await readdir(path.join(d.trashDir, 'drafts'))).sort()).toEqual(['a.txt', 'b.txt']);
            expect(await d.files.exists('Projects')).toBe(false);
            expect(d.files.recordCount('Projects')).toBe(0);
            expect(activity()).toContain(
                'Projects was removed from Proton Drive. 1 item(s) that existed only on this computer were moved to your Trash.',
            );
        });

        test('a single edited file deleted in the cloud goes to the desktop Trash', async () => {
            const d = await downloadedProjects('plain');
            await writeFile(d.local('Projects/notes.txt'), 'edited, not uploaded yet');
            goneFromCloud(d, 'Projects/notes.txt');

            await event(d, {
                type: DriveEventType.NodeDeleted,
                nodeUid: 'vol~Projects/notes.txt',
                parentNodeUid: 'vol~Projects',
                treeEventScopeId: 'scope-main',
                eventId: 'evt-deleted',
            });

            expect(d.trashed()).toEqual(['Projects/notes.txt']);
            expect(await readFile(path.join(d.trashDir, 'notes.txt'), 'utf8')).toBe('edited, not uploaded yet');
            expect(stateDb.getItemByPath('Projects/notes.txt')).toBeNull();
            expect(await d.files.exists('Projects/readme.txt')).toBe(true); // the rest of the folder is untouched
            expect(stateDb.getItemByPath('Projects/readme.txt')).not.toBeNull();
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
        });

        // A new item still uploading when its folder is deleted in the cloud is moved to the desktop Trash: the upload
        // finishing afterwards must not record it, or the next sync takes the missing item for a local delete
        for (const what of ['file', 'folder'] as const) {
            test(`a new ${what} still uploading when its folder is deleted in the cloud is not recorded once it went to the desktop Trash`, async () => {
                const d = await downloadedProjects('plain');
                const made = what === 'file' ? 'Projects/new.txt' : 'Projects/newdir';
                let release!: () => void;
                const answer = new Promise<void>((resolve) => (release = resolve));
                let started!: () => void;
                const uploading = new Promise<void>((resolve) => (started = resolve));
                // The cloud has taken the new item, but its answer is still on the way back
                const sdk = d.sdk as any;
                if (what === 'file') {
                    const getFileUploader = sdk.getFileUploader;
                    sdk.getFileUploader = async (...args: unknown[]) => {
                        const uploader = await getFileUploader(...args);
                        return {
                            uploadFromStream: async (stream: unknown) => {
                                const result = await uploader.uploadFromStream(stream);
                                started();
                                await answer;
                                return result;
                            },
                        };
                    };
                } else {
                    const createFolder = sdk.createFolder;
                    sdk.createFolder = async (parent: unknown, name: string) => {
                        const folder = await createFolder(parent, name);
                        if (name === 'newdir') {
                            started();
                            await answer;
                        }
                        return folder;
                    };
                }
                goneFromCloud(d, 'Projects');
                await d.files.writeLocal(what === 'file' ? made : `${made}/a.txt`, 'only here');
                const localChange: Promise<void> = (d.engine as any).handleLocalFileChange(made);
                await uploading;

                await event(d, {
                    type: DriveEventType.NodeDeleted,
                    nodeUid: 'vol~Projects',
                    parentNodeUid: d.root.uid,
                    treeEventScopeId: 'scope-main',
                    eventId: 'evt-deleted',
                });
                release();
                await localChange;

                expect(d.trashed()).toEqual([made]);
                expect(stateDb.getItemByPath(made)).toBeNull();
                await d.files.expectNoRecordWithoutFile('Projects');
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
            });
        }

        // Interleaved, Free's putBack could bring back a record that the cloud delete then leaves without its file
        test('a cloud delete arriving while Free up space runs on the folder waits for it, then leaves no records', async () => {
            const d = await downloadedProjects('plain');
            await addLocalOnly(d);
            let cloudDelete: Promise<void> | undefined;
            let trashedWhileFreeRan: string[] | undefined;
            const freeUpSpace = (d.engine as any).freeUpSpace.bind(d.engine);
            (d.engine as any).freeUpSpace = async (...args: unknown[]) => {
                goneFromCloud(d, 'Projects');
                cloudDelete = event(d, {
                    type: DriveEventType.NodeUpdated,
                    nodeUid: 'vol~Projects',
                    parentNodeUid: d.root.uid,
                    isTrashed: true,
                    isShared: false,
                    treeEventScopeId: 'scope-main',
                    eventId: 'evt-trashed',
                });
                await Bun.sleep(50); // time enough for the cloud delete to run, were it not waiting its turn
                trashedWhileFreeRan = d.trashed();
                return freeUpSpace(...args);
            };

            await d.engine.setAvailability('Projects', 'free');
            await cloudDelete;

            expect(trashedWhileFreeRan).toEqual([]);
            expect(d.trashed()).toEqual(['Projects/app/.git', 'Projects/notes.txt']);
            expect(await d.files.exists('Projects')).toBe(false);
            expect(d.files.recordCount('Projects')).toBe(0);
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
        });
    });

    // Something synced here is renamed or moved in the cloud (on the web, or on another device): its local copy moves
    // to match, keeping what exists only on this computer, rather than being removed and downloaded again (issue #16)
    describe('cloud-side renames', () => {
        const activity = () => stateDb.listActivity(500).map((a) => a.details);
        const setup = (layout: 'plain' | 'virtual' = 'plain') => {
            if (layout === 'virtual') {
                stateDb.setMeta('driveLayout', 'virtual');
            }
            const drive = makeMockDrive();
            const trashDir = path.join(tempDir, 'Trash');
            const handedToTrash: string[] = [];
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async (fullPath: string) => {
                    handedToTrash.push(fullPath);
                    await mkdir(trashDir, { recursive: true });
                    await rename(fullPath, path.join(trashDir, path.basename(fullPath)));
                    return true;
                },
            });
            // A rename or move in the cloud keeps the node's uid and changes its name or its parent
            const moveInCloud = (uid: string, change: { name?: string; parentUid?: string }) => {
                const node = drive.nodes.get(uid)!;
                drive.nodes.set(uid, {
                    ...node,
                    ...(change.name === undefined ? {} : { name: { ok: true as const, value: change.name } }),
                    ...(change.parentUid === undefined ? {} : { parentUid: change.parentUid }),
                });
            };
            const files = localFiles(stateDb, () => engine.localRoot());
            // A record whose file is gone reads as the user deleting it, which trashes the cloud copy
            const expectEveryRecordHasItsFile = async () => {
                for (const item of stateDb.getAllItems()) {
                    expect({ path: item.localRelPath, exists: await files.exists(item.localRelPath) }).toEqual({
                        path: item.localRelPath,
                        exists: true,
                    });
                }
            };
            // Nothing came down, went up, or went to either trash
            const expectNoTransfers = () => {
                expect(drive.calls.downloads).toEqual([]);
                expect(drive.calls.uploads).toEqual([]);
                expect(drive.calls.trashed).toEqual([]);
                expect(handedToTrash).toEqual([]);
            };
            return {
                ...drive,
                engine,
                files,
                moveInCloud,
                expectEveryRecordHasItsFile,
                expectNoTransfers,
                local: (rel: string) => path.join(engine.localRoot(), rel),
                trashed: () => handedToTrash.map((p) => path.relative(engine.localRoot(), p)).sort(),
                recordedUnder: (rel: string) => stateDb.getItemsUnder(rel).map((item) => item.localRelPath),
            };
        };

        // Work sorts after Projects, so the sync pass meets the old path first; Archive sorts before it, so the new one
        for (const layout of ['plain', 'virtual'] as const) {
            for (const target of ['Work', 'Archive']) {
                test(`${layout}: a pinned folder renamed to ${target} in the cloud is moved here with its ignored .git, and nothing is downloaded, uploaded or trashed`, async () => {
                    const d = setup(layout);
                    d.add('Projects/readme.txt', 'readme');
                    d.add('Projects/app/index.ts', 'index');
                    d.engine.availability.setPin(d.add('Projects').uid, 'pinned', false);
                    await d.engine.reconcileNow();
                    expect(d.calls.downloads.sort()).toEqual(['Projects/app/index.ts', 'Projects/readme.txt']);
                    d.calls.downloads.length = 0;
                    await d.files.writeLocal('Projects/app/.git/HEAD', 'ref: refs/heads/main');

                    d.moveInCloud('vol~Projects', { name: target });
                    await d.engine.reconcileNow();

                    expect(await readFile(d.local(`${target}/app/.git/HEAD`), 'utf8')).toBe('ref: refs/heads/main');
                    expect(await readFile(d.local(`${target}/readme.txt`), 'utf8')).toBe('readme');
                    expect(await d.files.exists('Projects')).toBe(false);
                    d.expectNoTransfers();
                    expect(d.recordedUnder(target)).toEqual([target, `${target}/app`, `${target}/app/index.ts`, `${target}/readme.txt`]);
                    expect(d.files.recordCount('Projects')).toBe(0);
                    expect(stateDb.getItemByPath(`${target}/readme.txt`)?.nodeUid).toBe('vol~Projects/readme.txt');
                    await d.expectEveryRecordHasItsFile();
                    expect(d.engine.availability.stateOf(target)).toBe('pinned'); // the pin follows the node
                    expect(activity()).toContain(`Moved locally to follow a rename in Proton Drive: Projects → ${target}`);
                    // The next sync finds everything in place
                    await d.engine.reconcileNow();
                    d.expectNoTransfers();
                    expect(await readFile(d.local(`${target}/app/.git/HEAD`), 'utf8')).toBe('ref: refs/heads/main');
                    if (layout === 'virtual') {
                        expect(await stat(stateDb.getSettings().syncDir).then(() => true, () => false)).toBe(false);
                    }
                });
            }
        }

        // Renamed where it is: x-notes.txt sorts after notes.txt, so the pass meets the old name first, and a-notes.txt
        // before it, so the new name first; either way the folder's listing, read before the move, is out of date
        for (const name of ['x-notes.txt', 'a-notes.txt']) {
            test(`a pinned file renamed to ${name} in the cloud is moved here with its unsynced edit, which then uploads to the same file`, async () => {
                const d = setup();
                d.add('Docs/notes.txt', 'synced version');
                d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
                await d.engine.reconcileNow();
                d.calls.downloads.length = 0;
                await writeFile(d.local('Docs/notes.txt'), 'edited, not uploaded yet');

                d.moveInCloud('vol~Docs/notes.txt', { name });
                await d.engine.reconcileNow();

                expect(await readFile(d.local(`Docs/${name}`), 'utf8')).toBe('edited, not uploaded yet');
                expect(await d.files.exists('Docs/notes.txt')).toBe(false);
                expect(stateDb.getItemByPath(`Docs/${name}`)?.nodeUid).toBe('vol~Docs/notes.txt');
                d.expectNoTransfers();
                await d.expectEveryRecordHasItsFile();
                expect(activity()).toContain(`Moved locally to follow a rename in Proton Drive: Docs/notes.txt → Docs/${name}`);
                // The edit goes up as a new revision of the renamed file, not as a new one
                await d.engine.reconcileNow();
                expect(d.calls.uploads).toEqual([`Docs/${name}`]);
                expect(d.nodes.get('vol~Docs/notes.txt')?.content).toBe('edited, not uploaded yet');
                expect(d.calls.downloads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
            });
        }

        // Docs is synced before Other: a move into Other meets the old path first, a move into Docs the new one
        for (const [from, to] of [
            ['Docs/a.txt', 'Other/a.txt'],
            ['Other/b.txt', 'Docs/b.txt'],
        ] as const) {
            test(`a downloaded but unpinned file moved from ${from} to ${to} in the cloud stays downloaded at its new path`, async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Other/b.txt', 'b');
                d.engine.availability.setPin(d.root.uid, 'pinned', false);
                await d.engine.reconcileNow();
                d.engine.availability.setPin(d.root.uid, 'unpinned', false); // still on this computer, no longer pinned
                expect(d.engine.availability.stateOf(from)).toBe('downloaded');
                d.calls.downloads.length = 0;

                d.moveInCloud(`vol~${from}`, { parentUid: `vol~${path.posix.dirname(to)}` });
                await d.engine.reconcileNow();

                expect(await readFile(d.local(to), 'utf8')).toBe(path.posix.basename(from, '.txt'));
                expect(await d.files.exists(from)).toBe(false);
                expect(d.engine.availability.stateOf(to)).toBe('downloaded');
                expect(stateDb.getItemByPath(to)?.nodeUid).toBe(`vol~${from}`);
                expect(stateDb.getItemByPath(from)).toBeNull();
                d.expectNoTransfers();
                await d.expectEveryRecordHasItsFile();
                expect(activity()).toContain(`Moved locally to follow a rename in Proton Drive: ${from} → ${to}`);
                await d.engine.reconcileNow();
                d.expectNoTransfers();
                expect(d.engine.availability.stateOf(to)).toBe('downloaded');
            });
        }

        // The folder's own copy can't go where something else already is: the old one goes as after a cloud delete
        for (const target of ['Work', 'Archive']) {
            test(`a folder renamed in the cloud to ${target}, which already exists here, goes as a cloud delete and leaves ${target} alone`, async () => {
                const d = setup();
                d.add('Projects/readme.txt', 'readme');
                d.add('Projects/app/index.ts', 'index');
                d.add('Projects/notes.txt', 'synced version');
                d.engine.availability.setPin(d.add('Projects').uid, 'pinned', false);
                await d.engine.reconcileNow();
                await d.files.writeLocal('Projects/app/.git/HEAD', 'ref: refs/heads/main');
                await writeFile(d.local('Projects/notes.txt'), 'edited, not uploaded yet');
                await d.files.writeLocal(`${target}/mine.txt`, 'made here, not uploaded yet');

                d.moveInCloud('vol~Projects', { name: target });
                await d.engine.reconcileNow();

                // What exists only on this computer goes to the desktop Trash, the unchanged copies are removed
                expect(d.trashed()).toEqual(['Projects/app/.git', 'Projects/notes.txt']);
                expect(await readFile(path.join(tempDir, 'Trash/.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
                expect(await d.files.exists('Projects')).toBe(false);
                expect(d.files.recordCount('Projects')).toBe(0);
                // Nothing was moved onto the folder already there, and what it held is as it was
                expect(activity().filter((a) => a.startsWith('Moved locally'))).toEqual([]);
                expect(await readFile(d.local(`${target}/mine.txt`), 'utf8')).toBe('made here, not uploaded yet');
                expect(d.calls.trashed).toEqual([]);
                await d.expectEveryRecordHasItsFile();
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual([`${target}/mine.txt`]); // a new local file, as before
                expect(await readFile(d.local(`${target}/mine.txt`), 'utf8')).toBe('made here, not uploaded yet');
            });
        }

        // A pass alone finds the file gone from Docs before Archive is listed again, so it asks the cloud where it went;
        // the event lists Archive first, so the remote index already knows
        for (const how of ['a sync pass', 'a NodeUpdated event'] as const) {
            test(`a downloaded file moved into an online-only folder in the cloud, found by ${how}, keeps its local copy there`, async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Archive/old.txt', 'old');
                d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
                await d.engine.reconcileNow();
                expect(await d.files.exists('Archive')).toBe(false);
                expect(d.engine.remoteIndex.getByPath('Archive/old.txt')).not.toBeNull(); // crawled on the first pass
                d.calls.downloads.length = 0;

                d.moveInCloud('vol~Docs/a.txt', { parentUid: 'vol~Archive' });
                if (how === 'a sync pass') {
                    await d.engine.reconcileNow();
                } else {
                    await (d.engine as any).handleRemoteDriveEvent({
                        type: DriveEventType.NodeUpdated,
                        nodeUid: 'vol~Docs/a.txt',
                        parentNodeUid: 'vol~Archive',
                        isTrashed: false,
                        isShared: false,
                        treeEventScopeId: 'scope-main',
                        eventId: 'evt-moved',
                    });
                }

                expect(await readFile(d.local('Archive/a.txt'), 'utf8')).toBe('a');
                expect(await d.files.exists('Docs/a.txt')).toBe(false);
                expect(await d.files.exists('Archive/old.txt')).toBe(false); // the rest of Archive stays online-only
                expect(stateDb.getItemByPath('Archive/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
                expect(d.engine.availability.stateOf('Archive/a.txt')).toBe('downloaded');
                d.expectNoTransfers();
                await d.expectEveryRecordHasItsFile();
                expect(activity()).toContain('Moved locally to follow a rename in Proton Drive: Docs/a.txt → Archive/a.txt');
                // The folder made to hold it is recorded by the next pass, and nothing else in it comes down
                await d.engine.reconcileNow();
                expect(stateDb.getItemByPath('Archive')?.nodeUid).toBe('vol~Archive');
                expect(await d.files.exists('Archive/old.txt')).toBe(false);
                d.expectNoTransfers();
                await d.expectEveryRecordHasItsFile();
            });
        }

        // The upload of a new file in the folder finishes after the folder moved: a record at the old path would have no
        // file, and once that path is in use again it reads as the user deleting the file, which trashes the cloud copy
        test('a new file still uploading when its folder follows a cloud rename is not recorded at the old path, and renaming back trashes nothing', async () => {
            const d = setup();
            d.add('Projects/readme.txt', 'readme');
            d.engine.availability.setPin(d.add('Projects').uid, 'pinned', false);
            await d.engine.reconcileNow();
            // The cloud has taken the new file, but its answer is still on the way back
            let release!: () => void;
            const answer = new Promise<void>((resolve) => (release = resolve));
            let started!: () => void;
            const uploading = new Promise<void>((resolve) => (started = resolve));
            const sdk = d.sdk as any;
            const getFileUploader = sdk.getFileUploader;
            sdk.getFileUploader = async (...args: unknown[]) => {
                const uploader = await getFileUploader(...args);
                return {
                    uploadFromStream: async (stream: unknown) => {
                        const result = await uploader.uploadFromStream(stream);
                        started();
                        await answer;
                        return result;
                    },
                };
            };
            await d.files.writeLocal('Projects/video.mp4', 'only here so far');
            const localChange: Promise<void> = (d.engine as any).handleLocalFileChange('Projects/video.mp4');
            await uploading;

            d.moveInCloud('vol~Projects', { name: 'Work' });
            await d.engine.reconcileNow();
            expect(await readFile(d.local('Work/video.mp4'), 'utf8')).toBe('only here so far');
            release();
            await localChange;

            expect(stateDb.getItemByPath('Projects/video.mp4')).toBeNull();
            await d.expectEveryRecordHasItsFile();
            // Renamed back: the folder follows again, and nothing goes to either trash
            d.moveInCloud('vol~Projects', { name: 'Projects' });
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.trashed()).toEqual([]);
            expect(await readFile(d.local('Projects/video.mp4'), 'utf8')).toBe('only here so far');
            expect(await readFile(d.local('Projects/readme.txt'), 'utf8')).toBe('readme');
            await d.expectEveryRecordHasItsFile();
        });

        // Only the cloud saying the item isn't there makes it gone: offline, rate limited or unreadable, it may as well
        // have moved, and removing it would lose what a later look would have followed
        test('a move whose cloud lookup fails for another reason than not found is still followed, and nothing is removed', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Other/b.txt', 'b');
            d.engine.availability.setPin(d.root.uid, 'pinned', false);
            await d.engine.reconcileNow();
            d.calls.downloads.length = 0;
            const getNode = d.sdk.getNode.bind(d.sdk);
            (d.sdk as any).getNode = async (uid: string) => {
                if (uid === 'vol~Docs/a.txt') throw new ConnectionError('Network unreachable');
                return getNode(uid);
            };

            d.moveInCloud('vol~Docs/a.txt', { parentUid: 'vol~Other' });
            await d.engine.reconcileNow();

            // Left alone where it was, the copy is found from its new path later in the same pass
            expect(await readFile(d.local('Other/a.txt'), 'utf8')).toBe('a');
            expect(await d.files.exists('Docs/a.txt')).toBe(false);
            d.expectNoTransfers();
            await d.expectEveryRecordHasItsFile();
            expect(activity()).toContain('Moved locally to follow a rename in Proton Drive: Docs/a.txt → Other/a.txt');
        });

        test('an item gone from the cloud listing stays while the cloud cannot say where it is, and goes once it says not found', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
            await d.engine.reconcileNow();
            const getNode = d.sdk.getNode.bind(d.sdk);
            (d.sdk as any).getNode = async (uid: string) => {
                if (uid === 'vol~Docs/a.txt') throw new ConnectionError('Network unreachable');
                return getNode(uid);
            };
            d.nodes.delete('vol~Docs/a.txt');

            await d.engine.reconcileNow();
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
            expect(stateDb.getItemByPath('Docs/a.txt')).not.toBeNull();

            (d.sdk as any).getNode = getNode; // says not found, as the SDK does
            await d.engine.reconcileNow();
            expect(await d.files.exists('Docs/a.txt')).toBe(false);
            expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
            expect(d.calls.trashed).toEqual([]);
            expect(d.trashed()).toEqual([]);
        });

        // Something made at the new path in the instant before the move must survive it, and the move is refused:
        // a-notes.txt sorts before notes.txt, so the pass meets the new name first, x-notes.txt after, so the old one
        for (const name of ['a-notes.txt', 'x-notes.txt']) {
            test(`a file made at ${name} just before a cloud rename moves notes.txt there is never replaced`, async () => {
                const d = setup();
                d.add('Docs/notes.txt', 'synced version');
                d.engine.availability.setPin(d.add('Docs').uid, 'pinned', false);
                await d.engine.reconcileNow();
                // Made after every look at the new path, just as the move starts
                const engine = d.engine as any;
                const whileRemoving = engine.whileRemoving.bind(engine);
                let madeOnce = false;
                engine.whileRemoving = (removal: unknown) => {
                    if (!madeOnce) {
                        madeOnce = true;
                        writeFileSync(d.local(`Docs/${name}`), 'made here meanwhile');
                    }
                    return whileRemoving(removal);
                };

                d.moveInCloud('vol~Docs/notes.txt', { name });
                await d.engine.reconcileNow();

                expect(madeOnce).toBe(true);
                expect(await readFile(d.local(`Docs/${name}`), 'utf8')).toBe('made here meanwhile');
                expect(activity().filter((a) => a.startsWith('Moved locally'))).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                await d.expectEveryRecordHasItsFile();
                // The next pass meets it as a clash with the cloud file, and keeps it as a conflict copy
                await d.engine.reconcileNow();
                const kept: string[] = [];
                for (const entry of await readdir(d.local('Docs'))) {
                    if ((await readFile(d.local(`Docs/${entry}`), 'utf8')) === 'made here meanwhile') {
                        kept.push(entry);
                    }
                }
                expect(kept.length).toBe(1);
                expect(d.calls.trashed).toEqual([]);
            });
        }
    });

    // Renames, moves and deletes made through the virtual drive: done here at once, and in Proton Drive from a persistent,
    // ordered journal, so they also work offline (spec §5.2)
    describe('drive operations', () => {
        const activity = () => stateDb.listActivity(500).map((a) => a.details);
        const setup = () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            const backingDir = path.join(tempDir, 'files');
            const handedToTrash: string[] = [];
            // A new engine on the same database and drive is what a restart of the daemon gives
            const start = () =>
                new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    backingDir,
                    moveToDesktopTrash: async (fullPath: string) => {
                        handedToTrash.push(fullPath);
                        return false;
                    },
                });
            const engine = start();
            const files = localFiles(stateDb, () => backingDir);
            // A record whose file is gone reads as the user deleting it, which trashes the cloud copy
            const expectEveryRecordHasItsFile = async () => {
                for (const item of stateDb.getAllItems()) {
                    expect({ path: item.localRelPath, exists: await files.exists(item.localRelPath) }).toEqual({
                        path: item.localRelPath,
                        exists: true,
                    });
                }
            };
            const named = (parentUid: string, name: string) =>
                [...drive.nodes.values()].filter((n) => n.parentUid === parentUid && drive.nameOf(n) === name && n.uid !== drive.root.uid);
            return {
                ...drive,
                engine,
                restart: start,
                files,
                handedToTrash,
                expectEveryRecordHasItsFile,
                named,
                journal: () => new RemoteOpsJournal(stateDb.connection).pending(),
                local: (rel: string) => path.join(backingDir, rel),
            };
        };
        // Downloaded through the engine, so the records are real
        const pinnedAndSynced = async (d: ReturnType<typeof setup>, uid: string) => {
            d.engine.availability.setPin(uid, 'pinned', false);
            await d.engine.reconcileNow();
            await d.engine.reconcileNow(); // records the folders made to hold what came down
        };

        test('renaming a folder holding online-only items offline shows at once, survives a restart, and renames once in the cloud when back online', async () => {
            const d = setup();
            d.add('Projects/a.txt', 'a');
            d.add('Projects/b.txt', 'b');
            await d.engine.reconcileNow();
            await d.engine.setAvailability('Projects/a.txt', 'pin');
            await d.engine.reconcileNow();
            expect(d.calls.downloads).toEqual(['Projects/a.txt']);
            d.down.add('renameNode');

            await d.engine.renameItem('Projects', 'Work');
            await d.engine.replayRemoteOps();

            // This computer and the listings show the new name already
            expect(await readFile(d.local('Work/a.txt'), 'utf8')).toBe('a');
            expect(await d.files.exists('Projects')).toBe(false);
            expect(stateDb.getItemByPath('Work/a.txt')?.nodeUid).toBe('vol~Projects/a.txt');
            expect(d.files.recordCount('Projects')).toBe(0);
            expect(d.engine.remoteIndex.getByPath('Work')?.uid).toBe('vol~Projects');
            expect(d.engine.remoteIndex.getByPath('Work/b.txt')?.uid).toBe('vol~Projects/b.txt');
            expect(d.engine.remoteIndex.getByPath('Projects')).toBeNull();
            expect(d.engine.availability.stateOf('Work/a.txt')).toBe('pinned');
            expect(d.engine.availability.stateOf('Work/b.txt')).toBe('online-only');
            expect(d.journal()).toMatchObject([{ kind: 'rename', nodeUid: 'vol~Projects', toPath: 'Work' }]);
            expect(d.calls.renamed).toEqual([]);
            // A sync pass meanwhile (listings work, the rename doesn't) leaves it alone: nothing is moved back
            await d.engine.reconcileNow();
            expect(await readFile(d.local('Work/a.txt'), 'utf8')).toBe('a');
            expect(await d.files.exists('Projects')).toBe(false);
            await d.expectEveryRecordHasItsFile();

            const restarted = d.restart();
            expect(d.journal()).toMatchObject([{ kind: 'rename', nodeUid: 'vol~Projects', toPath: 'Work' }]);
            d.down.clear();
            await restarted.replayRemoteOps();

            expect(d.calls.renamed).toEqual([{ uid: 'vol~Projects', name: 'Work' }]);
            expect(d.nameOf(d.nodes.get('vol~Projects')!)).toBe('Work');
            expect(d.journal()).toEqual([]);
            await restarted.reconcileNow();
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Projects', name: 'Work' }]);
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.downloads).toEqual(['Projects/a.txt']);
            expect(d.calls.trashed).toEqual([]);
            expect(await readFile(d.local('Work/a.txt'), 'utf8')).toBe('a');
            expect(restarted.availability.stateOf('Work/b.txt')).toBe('online-only');
            await d.expectEveryRecordHasItsFile();
        });

        test('a move into another folder uses moveNodes with that folder, then a rename when the name changes too', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Other/x.txt', 'x');
            await pinnedAndSynced(d, d.root.uid);

            await d.engine.renameItem('Docs/a.txt', 'Other/a.txt');
            await d.engine.replayRemoteOps();

            expect(d.calls.moved).toEqual([{ uid: 'vol~Docs/a.txt', parentUid: 'vol~Other' }]);
            expect(d.calls.renamed).toEqual([]);
            expect(d.nodes.get('vol~Docs/a.txt')?.parentUid).toBe('vol~Other');
            expect(await readFile(d.local('Other/a.txt'), 'utf8')).toBe('a');
            expect(await d.files.exists('Docs/a.txt')).toBe(false);
            expect(stateDb.getItemByPath('Other/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
            expect(d.engine.remoteIndex.getByPath('Other/a.txt')?.uid).toBe('vol~Docs/a.txt');

            await d.engine.renameItem('Other/a.txt', 'Docs/b.txt');
            await d.engine.replayRemoteOps();

            expect(d.calls.moved).toEqual([
                { uid: 'vol~Docs/a.txt', parentUid: 'vol~Other' },
                { uid: 'vol~Docs/a.txt', parentUid: 'vol~Docs' },
            ]);
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/a.txt', name: 'b.txt' }]);
            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            expect(d.journal()).toEqual([]);
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.downloads.sort()).toEqual(['Docs/a.txt', 'Other/x.txt']);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('a downloaded file moved into an online-only folder keeps its local copy there, and nothing else comes down', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Archive/old.txt', 'old');
            await pinnedAndSynced(d, d.add('Docs').uid);
            expect(await d.files.exists('Archive')).toBe(false);

            await d.engine.renameItem('Docs/a.txt', 'Archive/a.txt');
            await d.engine.replayRemoteOps();
            await d.engine.reconcileNow();

            expect(d.calls.moved).toEqual([{ uid: 'vol~Docs/a.txt', parentUid: 'vol~Archive' }]);
            expect(await readFile(d.local('Archive/a.txt'), 'utf8')).toBe('a');
            expect(await d.files.exists('Archive/old.txt')).toBe(false);
            expect(d.engine.availability.stateOf('Archive/a.txt')).toBe('downloaded');
            expect(d.calls.downloads).toEqual(['Docs/a.txt']);
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test("an editor's atomic save (a temp file renamed over the file) is a new revision of the same file, and the temp file goes to the trash", async () => {
            const d = setup();
            d.add('report.txt', 'v1');
            await pinnedAndSynced(d, d.root.uid);
            await d.files.writeLocal('.report.txt.tmp', 'v2');
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual(['.report.txt.tmp']);
            const tempUid = stateDb.getItemByPath('.report.txt.tmp')!.nodeUid;

            await d.engine.renameItem('.report.txt.tmp', 'report.txt');

            expect(await readFile(d.local('report.txt'), 'utf8')).toBe('v2');
            expect(await d.files.exists('.report.txt.tmp')).toBe(false);
            expect(stateDb.getItemByPath('report.txt')?.nodeUid).toBe('vol~report.txt');
            expect(stateDb.getItemByPath('.report.txt.tmp')).toBeNull();
            expect(d.engine.remoteIndex.getByPath('report.txt')?.uid).toBe('vol~report.txt');
            expect(d.engine.remoteIndex.getByUid(tempUid)).toBeNull();
            await d.engine.reconcileNow();

            expect(d.calls.trashed).toEqual([[tempUid]]);
            expect(d.calls.uploads).toEqual(['.report.txt.tmp', 'report.txt']);
            expect(d.nodes.get('vol~report.txt')?.content).toBe('v2');
            expect(d.named(d.root.uid, 'report.txt').map((n) => n.uid)).toEqual(['vol~report.txt']);
            expect(d.named(d.root.uid, '.report.txt.tmp')).toEqual([]);
            expect(d.journal()).toEqual([]);
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual(['.report.txt.tmp', 'report.txt']);
            expect(d.calls.trashed).toEqual([[tempUid]]);
            await d.expectEveryRecordHasItsFile();
        });

        test('a name taken in the cloud while offline gives the moved item a conflict name, the same here and there', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'mine');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.engine.replayRemoteOps();
            d.add('Docs/b.txt', 'theirs'); // made on the web meanwhile
            d.down.clear();

            await d.engine.reconcileNow();

            const name = d.nameOf(d.nodes.get('vol~Docs/a.txt')!);
            expect(name).toMatch(/^b \(conflict .+\)\.txt$/);
            expect(await readFile(d.local(`Docs/${name}`), 'utf8')).toBe('mine');
            expect(stateDb.getItemByPath(`Docs/${name}`)?.nodeUid).toBe('vol~Docs/a.txt');
            expect(d.engine.remoteIndex.getByPath(`Docs/${name}`)?.uid).toBe('vol~Docs/a.txt');
            expect(d.nodes.get('vol~Docs/b.txt')?.content).toBe('theirs');
            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('theirs'); // theirs comes down as Docs is pinned
            expect(activity().some((a) => a.includes(name))).toBe(true);
            expect(d.journal()).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('deleting an online-only file trashes it in the cloud and downloads nothing', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Docs/keep.txt', 'keep');
            await d.engine.reconcileNow();
            expect(d.engine.remoteIndex.getByPath('Docs/a.txt')).not.toBeNull();

            await d.engine.deleteItem('Docs/a.txt');
            expect(d.engine.remoteIndex.getByPath('Docs/a.txt')).toBeNull(); // gone from listings at once
            await d.engine.replayRemoteOps();

            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
            expect(d.calls.downloads).toEqual([]);
            expect(d.nodes.has('vol~Docs/a.txt')).toBe(false);
            expect(d.nodes.has('vol~Docs/keep.txt')).toBe(true);
            expect(d.journal()).toEqual([]);
            await d.engine.reconcileNow();
            expect(d.calls.downloads).toEqual([]);
            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
        });

        test('deleting a downloaded folder removes everything in it here, ignored things included, and trashes the folder once', async () => {
            const d = setup();
            d.add('Projects/readme.txt', 'readme');
            await pinnedAndSynced(d, d.add('Projects').uid);
            await d.files.writeLocal('Projects/app/.git/HEAD', 'ref: refs/heads/main');

            await d.engine.deleteItem('Projects');

            expect(await d.files.exists('Projects')).toBe(false);
            expect(d.files.recordCount('Projects')).toBe(0);
            expect(d.engine.remoteIndex.getByPath('Projects')).toBeNull();
            expect(d.handedToTrash).toEqual([]);
            await d.engine.replayRemoteOps();
            expect(d.calls.trashed).toEqual([['vol~Projects']]);
            await d.engine.reconcileNow();
            expect(await d.files.exists('Projects')).toBe(false);
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.downloads).toEqual(['Projects/readme.txt']);
            expect(d.calls.trashed).toEqual([['vol~Projects']]);
        });

        test('a new file made at the old name while a rename waits is not uploaded onto the renamed item, and uploads as new once the rename lands', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'original');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.files.writeLocal('Docs/a.txt', 'a new file');

            await (d.engine as any).handleLocalFileChange('Docs/a.txt'); // as the watcher reports it
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('original');

            d.down.clear();
            await d.engine.reconcileNow();
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/a.txt', name: 'b.txt' }]);
            expect(d.calls.uploads).toEqual(['Docs/a.txt']);
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('original');
            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('original');
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a new file');
            expect(stateDb.getItemByPath('Docs/a.txt')?.nodeUid).not.toBe('vol~Docs/a.txt');
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('a move into a new folder made here makes that folder in Proton Drive, records it, and moves into it', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await mkdir(d.local('Docs/New'));

            await d.engine.renameItem('Docs/a.txt', 'Docs/New/a.txt');
            await d.engine.replayRemoteOps();

            const created = d.named('vol~Docs', 'New');
            expect(created.length).toBe(1);
            expect(d.calls.moved).toEqual([{ uid: 'vol~Docs/a.txt', parentUid: created[0]!.uid }]);
            expect(d.journal()).toEqual([]);
            expect(stateDb.getItemByPath('Docs/New')?.nodeUid).toBe(created[0]!.uid);
            expect(stateDb.getItemByPath('Docs/New/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
            expect(d.engine.remoteIndex.getByPath('Docs/New/a.txt')?.uid).toBe('vol~Docs/a.txt');
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            expect(d.named('vol~Docs', 'New').length).toBe(1);
            await d.expectEveryRecordHasItsFile();
        });

        test('a move into a new folder that is then renamed here still lands in that folder once it is uploaded', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await mkdir(d.local('Docs/New'));
            d.down.add('getNode'); // offline while both renames happen

            await d.engine.renameItem('Docs/a.txt', 'Docs/New/a.txt');
            await d.engine.renameItem('Docs/New', 'Docs/Renamed');
            expect(d.journal()).toMatchObject([{ kind: 'move', nodeUid: 'vol~Docs/a.txt', toPath: 'Docs/Renamed/a.txt' }]);
            d.down.clear();
            await d.engine.reconcileNow();
            await d.engine.replayRemoteOps();

            const created = d.named('vol~Docs', 'Renamed');
            expect(created.length).toBe(1);
            expect(d.named('vol~Docs', 'New')).toEqual([]);
            expect(d.calls.moved).toEqual([{ uid: 'vol~Docs/a.txt', parentUid: created[0]!.uid }]);
            expect(stateDb.getItemByPath('Docs/Renamed/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
            await d.engine.reconcileNow();
            expect(await readFile(d.local('Docs/Renamed/a.txt'), 'utf8')).toBe('a');
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        // The replay asks the cloud about the item first; a rename here meanwhile changes where its move leads
        test('a rename here while the replay is asking the cloud about a waiting move is taken into account, and the move is kept', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await mkdir(d.local('Docs/New'));
            let release!: () => void;
            const answer = new Promise<void>((resolve) => (release = resolve));
            const getNode = d.sdk.getNode.bind(d.sdk);
            let held = false;
            (d.sdk as any).getNode = async (uid: string) => {
                if (!held && uid === 'vol~Docs/a.txt') {
                    held = true;
                    await answer;
                }
                return getNode(uid);
            };

            await d.engine.renameItem('Docs/a.txt', 'Docs/New/a.txt'); // its replay now waits for the cloud's answer
            expect(held).toBe(true);
            await d.engine.renameItem('Docs/New', 'Docs/Renamed');
            release();
            await d.engine.replayRemoteOps();

            // It goes into the folder by its new name, made in Proton Drive for it; nothing under the old name
            const renamed = d.named('vol~Docs', 'Renamed');
            expect(renamed.length).toBe(1);
            expect(d.calls.moved).toEqual([{ uid: 'vol~Docs/a.txt', parentUid: renamed[0]!.uid }]);
            expect(d.named('vol~Docs', 'New')).toEqual([]);
            expect(d.journal()).toEqual([]);
            await d.engine.reconcileNow();
            expect(d.calls.moved.length).toBe(1);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('a move still waiting for its folder is skipped once the item is deleted, and the delete reaches the cloud at once', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await mkdir(d.local('Docs/New'));
            d.down.add('getNode'); // offline: the move waits

            await d.engine.renameItem('Docs/a.txt', 'Docs/New/a.txt');
            await d.engine.deleteItem('Docs/New/a.txt');
            d.down.clear();
            await d.engine.replayRemoteOps();

            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
            expect(d.calls.moved).toEqual([]);
            expect(d.named('vol~Docs', 'New')).toEqual([]); // nothing was made for it
            expect(d.journal()).toEqual([]);
            expect(await d.files.exists('Docs/New/a.txt')).toBe(false);
            expect(await d.files.exists('Docs/New')).toBe(true);
        });

        test('a cloud trash of an item whose rename is still on its way keeps its local copy, which uploads again as new', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.engine.replayRemoteOps();
            d.nodes.delete('vol~Docs/a.txt');

            await (d.engine as any).handleRemoteDriveEvent({
                type: DriveEventType.NodeUpdated,
                nodeUid: 'vol~Docs/a.txt',
                parentNodeUid: 'vol~Docs',
                isTrashed: true,
                isShared: false,
                treeEventScopeId: 'scope-main',
                eventId: 'evt-trashed',
            });
            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            d.down.clear();
            await d.engine.reconcileNow();

            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            expect(d.calls.uploads).toEqual(['Docs/b.txt']);
            expect(d.calls.trashed).toEqual([]);
            expect(d.handedToTrash).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('an item trashed in the cloud before its rename lands uploads again as new from its local copy; an online-only one is dropped', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Other/c.txt', 'c');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.engine.renameItem('Other/c.txt', 'Other/d.txt');
            await d.engine.replayRemoteOps();
            d.nodes.delete('vol~Docs/a.txt'); // both trashed on the web meanwhile
            d.nodes.delete('vol~Other/c.txt');
            d.down.clear();

            await d.engine.reconcileNow();

            expect(d.journal()).toEqual([]);
            expect(d.calls.renamed).toEqual([]);
            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            expect(d.calls.uploads).toEqual(['Docs/b.txt']);
            expect(stateDb.getItemByPath('Docs/b.txt')?.nodeUid).not.toBe('vol~Docs/a.txt');
            expect(d.engine.remoteIndex.getByPath('Other/d.txt')).toBeNull();
            expect(d.calls.downloads).toEqual(['Docs/a.txt']);
            expect(d.calls.trashed).toEqual([]);
            expect(activity().some((a) => a.includes('Other/d.txt'))).toBe(true);
            await d.expectEveryRecordHasItsFile();
        });

        test('while paused, renames still happen here but wait to reach the cloud until resumed', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await d.engine.setPaused(true);

            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.engine.replayRemoteOps();

            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            expect(d.calls.renamed).toEqual([]);
            expect(d.journal().length).toBe(1);
            await d.engine.setPaused(false);
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/a.txt', name: 'b.txt' }]);
            expect(d.journal()).toEqual([]);
        });

        test('an atomic save whose temp file never reached the cloud uploads a new revision and trashes nothing', async () => {
            const d = setup();
            d.add('report.txt', 'v1');
            await pinnedAndSynced(d, d.root.uid);
            await d.files.writeLocal('.report.txt.tmp', 'v2');

            await d.engine.renameItem('.report.txt.tmp', 'report.txt');
            expect(d.journal()).toEqual([]);
            await d.engine.reconcileNow();

            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual(['report.txt']);
            expect(d.nodes.get('vol~report.txt')?.content).toBe('v2');
            expect(d.named(d.root.uid, 'report.txt').length).toBe(1);
            await d.expectEveryRecordHasItsFile();
        });

        test('a synced file renamed over a file that exists only here keeps its own identity: renamed in the cloud, nothing trashed', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await d.files.writeLocal('Docs/b.txt', 'only here');

            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.engine.reconcileNow();

            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/a.txt', name: 'b.txt' }]);
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
            expect(stateDb.getItemByPath('Docs/b.txt')?.nodeUid).toBe('vol~Docs/a.txt');
            await d.expectEveryRecordHasItsFile();
        });

        // Some editors keep a backup by renaming the file to an ignored name (report.txt~) before writing it anew
        test('a rename into an ignored name takes the item out of what is synced, and Proton Drive keeps it as it was', async () => {
            const d = setup();
            d.add('report.txt', 'v1');
            await pinnedAndSynced(d, d.root.uid);

            await d.engine.renameItem('report.txt', 'report.txt~');
            await d.engine.replayRemoteOps();

            expect(await readFile(d.local('report.txt~'), 'utf8')).toBe('v1');
            expect(d.journal()).toEqual([]);
            expect(stateDb.getItemByPath('report.txt')).toBeNull();
            expect(stateDb.getItemByPath('report.txt~')).toBeNull();
            expect(d.calls.renamed).toEqual([]);
            expect(d.nameOf(d.nodes.get('vol~report.txt')!)).toBe('report.txt');
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('when the move on disk fails, the records, the journal and the index are put back as they were', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            // Something takes the new name after every look at it, just as the move starts
            const engine = d.engine as any;
            const snapshot = engine.snapshotLocalStep.bind(engine);
            engine.snapshotLocalStep = (...args: unknown[]) => {
                const taken = snapshot(...args);
                writeFileSync(d.local('Docs/b.txt'), 'made here meanwhile');
                return taken;
            };

            const error = await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt').then(
                () => null,
                (e: Error) => e.message,
            );

            expect(error).toBe('Already exists: Docs/b.txt');
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('made here meanwhile');
            expect(stateDb.getItemByPath('Docs/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
            expect(stateDb.getItemByPath('Docs/b.txt')).toBeNull();
            expect(d.journal()).toEqual([]);
            expect(d.engine.remoteIndex.getByPath('Docs/a.txt')?.uid).toBe('vol~Docs/a.txt');
            expect(d.engine.remoteIndex.getByPath('Docs/b.txt')).toBeNull();
            expect(stateDb.getMeta(LOCAL_MOVE_IN_PROGRESS)).toBeNull();
            await d.engine.replayRemoteOps();
            expect(d.calls.renamed).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
        });

        // Review C1: a listing puts the cloud's view back into the index; the old name must not come back as something
        // that can be deleted (it is the renamed folder)
        test('a sync pass while a rename waits keeps the new name in the index, and deleting the old name finds nothing to trash', async () => {
            const d = setup();
            d.add('Projects/a.txt', 'a');
            d.add('Projects/b.txt', 'b');
            await d.engine.reconcileNow();
            await d.engine.setAvailability('Projects/a.txt', 'pin');
            await d.engine.reconcileNow();
            d.down.add('renameNode');
            await d.engine.renameItem('Projects', 'Work');

            await d.engine.reconcileNow(); // listings work, the rename doesn't

            expect(d.engine.remoteIndex.getByPath('Work')?.uid).toBe('vol~Projects');
            expect(d.engine.remoteIndex.getByPath('Work/b.txt')?.uid).toBe('vol~Projects/b.txt');
            expect(d.engine.remoteIndex.getByPath('Projects')).toBeNull();
            const error = await d.engine.deleteItem('Projects').then(() => null, (e: Error) => e.message);
            expect(error).toBe('Not found: Projects');
            d.down.clear();
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Projects', name: 'Work' }]);
            expect(await readFile(d.local('Work/a.txt'), 'utf8')).toBe('a');
            await d.expectEveryRecordHasItsFile();
        });

        test('while a rename waits for a name taken in the cloud, the old name left in the index is not deletable', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'mine');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            d.add('Docs/b.txt', 'theirs');
            await d.engine.reconcileNow(); // the index keeps the cloud's b.txt, and mine where the cloud has it

            const error = await d.engine.deleteItem('Docs/a.txt').then(() => null, (e: Error) => e.message);
            expect(error).toBe('Not found: Docs/a.txt');
            await d.engine.replayRemoteOps();
            expect(d.calls.trashed).toEqual([]);
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('mine');
        });

        // Review C2: the earlier rename is superseded, but the cloud still has the item under its first name
        test('renamed twice while offline, a new file at the first name is not uploaded onto the renamed item', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'original');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await d.engine.renameItem('Docs/b.txt', 'Docs/c.txt');
            await d.engine.replayRemoteOps();
            await d.files.writeLocal('Docs/a.txt', 'a new file');

            await (d.engine as any).handleLocalFileChange('Docs/a.txt');
            expect(d.calls.uploads).toEqual([]);
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('original');
            d.down.clear();
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();

            expect(d.nameOf(d.nodes.get('vol~Docs/a.txt')!)).toBe('c.txt');
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('original');
            expect(await readFile(d.local('Docs/c.txt'), 'utf8')).toBe('original');
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a new file');
            expect(d.named('vol~Docs', 'a.txt').map((n) => n.content)).toEqual(['a new file']);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('renamed to a backup name, saved anew, then the backup deleted: the new save is neither uploaded onto the old item nor trashed with it', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'original');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            d.down.add('trashNodes');
            await d.engine.renameItem('Docs/a.txt', 'Docs/a.txt.bak');
            await d.files.writeLocal('Docs/a.txt', 'new save');
            await d.engine.deleteItem('Docs/a.txt.bak');
            await d.engine.replayRemoteOps();

            await (d.engine as any).handleLocalFileChange('Docs/a.txt');
            expect(d.calls.uploads).toEqual([]);
            d.down.clear();
            await d.engine.replayRemoteOps();
            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
            await (d.engine as any).handleRemoteDriveEvent({
                type: DriveEventType.NodeUpdated,
                nodeUid: 'vol~Docs/a.txt',
                parentNodeUid: 'vol~Docs',
                isTrashed: true,
                isShared: false,
                treeEventScopeId: 'scope-main',
                eventId: 'evt-trashed',
            });
            await d.engine.reconcileNow();

            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('new save');
            expect(d.named('vol~Docs', 'a.txt').map((n) => n.content)).toEqual(['new save']);
            expect(d.handedToTrash).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        // Review C3: the move waits for its folder, which sits under a folder whose rename waits behind the move
        test('a move into a new folder, then a rename of the folder above it, both reach the cloud', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await mkdir(d.local('Docs/New'));
            await d.engine.renameItem('Docs/a.txt', 'Docs/New/a.txt');
            await d.engine.renameItem('Docs', 'Docs2');

            for (let round = 0; round < 2; round++) {
                await d.engine.reconcileNow();
                await d.engine.replayRemoteOps();
            }

            expect(d.journal()).toEqual([]);
            expect(d.nameOf(d.nodes.get('vol~Docs')!)).toBe('Docs2');
            const created = d.named('vol~Docs', 'New');
            expect(created.length).toBe(1);
            expect(d.nodes.get('vol~Docs/a.txt')?.parentUid).toBe(created[0]!.uid);
            expect(await readFile(d.local('Docs2/New/a.txt'), 'utf8')).toBe('a');
            expect(stateDb.getItemByPath('Docs2/New/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        // Review I1: the node made by an upload that was still running when the item was deleted or renamed
        const holdUploadAnswer = (d: ReturnType<typeof setup>) => {
            let release!: () => void;
            const answer = new Promise<void>((resolve) => (release = resolve));
            let started!: () => void;
            const sent = new Promise<void>((resolve) => (started = resolve));
            const getFileUploader = (d.sdk as any).getFileUploader.bind(d.sdk);
            (d.sdk as any).getFileUploader = async (...args: unknown[]) => {
                const uploader = await getFileUploader(...args);
                return {
                    uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                        const controller = await uploader.uploadFromStream(stream); // sent: the node exists
                        started();
                        return { completion: async () => (await answer, controller.completion()) };
                    },
                };
            };
            return { release: () => release(), sent };
        };
        for (const how of ['deleted', 'renamed over another file'] as const) {
            test(`a new file ${how} through the drive while its first upload runs leaves nothing behind in the cloud`, async () => {
                const d = setup();
                d.add('report.txt', 'v1');
                await pinnedAndSynced(d, d.root.uid);
                const name = how === 'deleted' ? 'tmp.txt' : '.report.txt.tmp';
                await d.files.writeLocal(name, 'v2');
                const held = holdUploadAnswer(d);
                const upload: Promise<void> = (d.engine as any).handleLocalFileChange(name);
                await held.sent;

                if (how === 'deleted') {
                    await d.engine.deleteItem(name);
                } else {
                    await d.engine.renameItem(name, 'report.txt');
                }
                held.release();
                await upload;
                await d.engine.replayRemoteOps();
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.named(d.root.uid, name)).toEqual([]);
                expect(await d.files.exists(name)).toBe(false);
                expect(d.engine.remoteIndex.getByPath(name)).toBeNull();
                expect(d.calls.trashed.length).toBe(1);
                if (how === 'renamed over another file') {
                    expect(d.nodes.get('vol~report.txt')?.content).toBe('v2');
                }
                await d.expectEveryRecordHasItsFile();
            });
        }

        test('a new folder renamed while it is being made in the cloud ends up there once, under its new name', async () => {
            const d = setup();
            d.add('keep.txt', 'k');
            await pinnedAndSynced(d, d.root.uid);
            await mkdir(d.local('New Folder'));
            let release!: () => void;
            const answer = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const making = new Promise<void>((resolve) => (entered = resolve));
            const createFolder = (d.sdk as any).createFolder.bind(d.sdk);
            (d.sdk as any).createFolder = async (...args: unknown[]) => {
                entered();
                await answer;
                return createFolder(...args);
            };
            const upload: Promise<void> = (d.engine as any).handleLocalFileChange('New Folder');
            await making;

            await d.engine.renameItem('New Folder', 'Photos');
            release();
            await upload;
            (d.sdk as any).createFolder = createFolder;
            await (d.engine as any).handleLocalFileChange('Photos'); // the watcher reports the renamed folder
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();

            const top = [...d.nodes.values()].filter((n) => n.parentUid === d.root.uid && n.uid !== d.root.uid).map((n) => d.nameOf(n));
            expect(top.sort()).toEqual(['Photos', 'keep.txt']);
            expect(d.engine.remoteIndex.getByPath('New Folder')).toBeNull();
            expect((await readdir(d.local(''))).sort()).toEqual(['Photos', 'keep.txt']);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        // Review I2
        test('an online-only file moved into a new folder made here stays in listings until it is in the cloud, and nothing downloads', async () => {
            const d = setup();
            d.add('Docs/x.txt', 'x');
            await d.engine.reconcileNow();
            await mkdir(d.local('New'));
            d.down.add('getNode'); // the replay can't run yet

            await d.engine.renameItem('Docs/x.txt', 'New/x.txt');
            await d.engine.replayRemoteOps();

            expect(d.engine.remoteIndex.getByPath('New/x.txt')?.uid).toBe('vol~Docs/x.txt');
            expect(d.engine.remoteIndex.getByPath('Docs/x.txt')).toBeNull();
            // The folder made here stands in the index for one Proton Drive doesn't have yet: never acted on as a node
            const pin = await d.engine.setAvailability('New', 'pin').then(() => null, (e: Error) => e.message);
            expect(pin).toBe('Not in Proton Drive: New');
            await d.engine.reconcileNow(); // lists Docs (x.txt still there in the cloud) and uploads New
            expect(d.engine.remoteIndex.getByPath('New/x.txt')?.uid).toBe('vol~Docs/x.txt');
            expect(d.engine.remoteIndex.getByPath('Docs/x.txt')).toBeNull();
            d.down.clear();
            await d.engine.replayRemoteOps();

            const created = d.named(d.root.uid, 'New');
            expect(created.length).toBe(1);
            expect(d.nodes.get('vol~Docs/x.txt')?.parentUid).toBe(created[0]!.uid);
            expect(d.engine.remoteIndex.getByPath('New/x.txt')?.uid).toBe('vol~Docs/x.txt');
            expect(d.engine.remoteIndex.getByPath('New')?.uid).toBe(created[0]!.uid);
            expect(d.calls.downloads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            expect(d.engine.availability.stateOf('New/x.txt')).toBe('online-only');
        });

        // Review I3: a folder that reached the cloud only through the upload of a file in it
        test('a folder made in the cloud for the upload of a file in it is renamed there with it, and nothing moves back', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await d.files.writeLocal('Docs/New/f.txt', 'f');
            await (d.engine as any).handleLocalFileChange('Docs/New/f.txt');

            await d.engine.renameItem('Docs/New', 'Docs/Renamed');
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();

            expect((await readdir(d.local('Docs'))).sort()).toEqual(['Renamed', 'a.txt']);
            expect(await readdir(d.local('Docs/Renamed'))).toEqual(['f.txt']);
            const renamed = d.named('vol~Docs', 'Renamed');
            expect(renamed.length).toBe(1);
            expect(d.named(renamed[0]!.uid, 'f.txt').length).toBe(1);
            expect(d.named('vol~Docs', 'New')).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('renaming a folder that has no record of its own, but holds recorded items, takes those items along in the cloud', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            await d.files.writeLocal('Docs/New/f.txt', 'f');
            await (d.engine as any).handleLocalFileChange('Docs/New/f.txt');
            const fRecord = stateDb.getItemByPath('Docs/New/f.txt')!;
            const f = fRecord.nodeUid;
            // As an earlier version left it: the folder itself neither recorded nor in the remote index
            stateDb.removeItemByPath('Docs/New');
            stateDb.upsertItem(fRecord);
            d.engine.remoteIndex.removeSubtree(d.named('vol~Docs', 'New')[0]!.uid);

            await d.engine.renameItem('Docs/New', 'Docs/Renamed');
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();

            // The emptied folder of the old name stays in Proton Drive (and so here): only a folder recorded as synced is
            // renamed there with it
            expect(await d.files.exists('Docs/New/f.txt')).toBe(false);
            expect(await readdir(d.local('Docs/Renamed'))).toEqual(['f.txt']);
            const renamed = d.named('vol~Docs', 'Renamed');
            expect(renamed.length).toBe(1);
            expect(d.nodes.get(f)?.parentUid).toBe(renamed[0]!.uid);
            expect(d.calls.trashed).toEqual([]);
            await d.expectEveryRecordHasItsFile();
        });

        test('a file can replace an online-only file in a folder that is not on this computer', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Archive/b.txt', 'b');
            await pinnedAndSynced(d, d.add('Docs').uid);

            await d.engine.renameItem('Docs/a.txt', 'Archive/b.txt');
            await d.engine.reconcileNow();

            expect(await readFile(d.local('Archive/b.txt'), 'utf8')).toBe('a');
            expect(d.nodes.get('vol~Archive/b.txt')?.content).toBe('a');
            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
            await d.expectEveryRecordHasItsFile();
        });

        // The remote index shows pending moves as done, so a folder's listing there can miss what the cloud still holds in
        // it: a local delete of the folder must not be judged from that
        test('a folder deleted on disk while a move out of it waits is not trashed until the move has reached the cloud', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Docs/b.txt', 'b');
            d.add('Other/x.txt', 'x');
            await pinnedAndSynced(d, d.root.uid);
            d.down.add('moveNodes');
            await d.engine.renameItem('Docs/a.txt', 'Other/a.txt');
            await rm(d.local('Docs'), { recursive: true }); // not through the drive

            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            d.down.clear();
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();

            expect(d.nodes.get('vol~Docs/a.txt')?.parentUid).toBe('vol~Other');
            expect(await readFile(d.local('Other/a.txt'), 'utf8')).toBe('a');
            expect(d.calls.trashed).toEqual([['vol~Docs']]); // the folder, with only b.txt in it by then
            await d.expectEveryRecordHasItsFile();
        });

        // Its records moved, and its rename went into the journal, but the item itself had not moved yet: its records would
        // read as the user deleting it once the rename reaches the cloud, which trashes it there
        test('a crash between journalling a rename and moving the item is finished on the next start, and nothing is trashed', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await pinnedAndSynced(d, d.add('Docs').uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
            await rename(d.local('Docs/b.txt'), d.local('Docs/a.txt'));
            stateDb.setMeta(LOCAL_MOVE_IN_PROGRESS, JSON.stringify({ from: 'Docs/a.txt', to: 'Docs/b.txt', replace: false }));
            d.down.clear();

            const restarted = d.restart();
            await restarted.reconcileNow();
            await restarted.reconcileNow();

            expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('a');
            expect(await d.files.exists('Docs/a.txt')).toBe(false);
            expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/a.txt', name: 'b.txt' }]);
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
            expect(stateDb.getMeta(LOCAL_MOVE_IN_PROGRESS)).toBeNull();
            await d.expectEveryRecordHasItsFile();
        });
    });
    describe('the virtual drive', () => {
        const setup = (mock: { slashFreeUids?: boolean } = {}) => {
            stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive(mock);
            const backingDir = path.join(tempDir, 'files');
            const forgotten: string[] = [];
            // A new engine on the same database and drive is what a restart of the daemon gives
            const start = () =>
                new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    backingDir,
                    moveToDesktopTrash: async () => false,
                    forgetFailedThumbnail: async (mountFullPath: string) => {
                        forgotten.push(mountFullPath);
                    },
                });
            return {
                ...drive,
                engine: start(),
                restart: start,
                files: localFiles(stateDb, () => backingDir),
                forgotten,
                local: (rel: string) => path.join(backingDir, rel),
                mountPath: (rel: string) => path.join(stateDb.getSettings().syncDir, rel),
                journal: () => new RemoteOpsJournal(stateDb.connection).pending(),
                named: (parentUid: string, name: string) =>
                    [...drive.nodes.values()].filter((n) => n.parentUid === parentUid && drive.nameOf(n) === name && n.uid !== drive.root.uid),
                tempFilesIn: async (rel: string) =>
                    (await readdir(path.join(backingDir, rel)).catch(() => [] as string[])).filter((n) => n.startsWith('.proton-drive-tmp-')),
                // A rename or move in the cloud keeps the node's uid and changes its name or its parent
                moveInCloud: (uid: string, name: string) => {
                    const node = drive.nodes.get(uid)!;
                    drive.nodes.set(uid, { ...node, name: { ok: true as const, value: name } });
                },
            };
        };
        // Whether a drive operation finished while a download was held, or was still waiting for it
        const withoutWaiting = (p: Promise<unknown>) =>
            Promise.race([p.then(() => 'done'), Bun.sleep(1000).then(() => 'waited for the download')]);
        // How a drive operation failed (its errno code and message), or null when it didn't
        const failure = (p: Promise<unknown>) =>
            p.then(
                () => null,
                (e: unknown) => ({
                    code: (e as { code?: string }).code,
                    message: (e as Error).message,
                    driveOpError: e instanceof DriveOpError,
                }),
            );
        const until = async (cond: () => boolean) => {
            for (let i = 0; i < 400 && !cond(); i++) {
                await Bun.sleep(5);
            }
            expect(cond()).toBe(true);
        };
        // Downloads that wait until released (those of the nodes `held` picks, or all), so a test can act while one runs
        const slowDownloads = (d: ReturnType<typeof setup>, held: (nodeUid: string) => boolean = () => true) => {
            const sdk = d.sdk as any;
            const real = sdk.getFileRevisionDownloader;
            let release!: () => void;
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            let started = 0;
            sdk.getFileRevisionDownloader = async (revisionUid: string) => {
                const downloader = await real(revisionUid);
                if (!held(revisionUid.replace(/~rev\d+$/, ''))) {
                    return downloader;
                }
                started += 1;
                return {
                    downloadToStream: (writable: WritableStream, onProgress?: (bytes: number) => void) => {
                        const inner = downloader.downloadToStream(writable, onProgress);
                        return {
                            completion: async () => {
                                await released;
                                await inner.completion();
                            },
                        };
                    },
                };
            };
            return { release, started: () => started, restore: () => (sdk.getFileRevisionDownloader = real) };
        };

        describe('vfsChildren', () => {
            test('lists online-only and downloaded items with their size and mtime, leaving out hidden items and a remote .git', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'aaa');
                d.add('Docs/b.txt', 'bb');
                d.add('Docs/.git/HEAD', 'ref: refs/heads/main');
                d.add('Docs/Private/secret.txt', 's');
                d.add('Docs/Sub/c.txt', 'c');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/b.txt', 'pin');
                expect((await d.engine.setAvailability('Docs/Private', 'hide')).state).toBe('hidden');
                // Proton Drive has the .git folder, and the remote index with it; this computer ignores it
                expect(d.engine.remoteIndex.getByPath('Docs/.git')).not.toBeNull();
                const mtimeOf = (rel: string) => d.engine.remoteIndex.getByPath(rel)!.mtimeMs;

                expect(d.engine.vfsChildren('Docs')).toEqual([
                    { name: 'Sub', type: 'folder', size: 0, mtimeMs: mtimeOf('Docs/Sub') },
                    {
                        name: 'a.txt',
                        type: 'file',
                        size: 3,
                        mtimeMs: d.nodes.get('vol~Docs/a.txt')!.activeRevision!.claimedModificationTime!.getTime(),
                    },
                    { name: 'b.txt', type: 'file', size: 2, mtimeMs: mtimeOf('Docs/b.txt') },
                ]);
                expect(d.engine.availability.stateOf('Docs/a.txt')).toBe('online-only');
                expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('bb');
                expect(d.engine.vfsChildren('')).toEqual([{ name: 'Docs', type: 'folder', size: 0, mtimeMs: mtimeOf('Docs') }]);
                expect(d.engine.vfsChildren('/Docs/Sub/')).toEqual([
                    { name: 'c.txt', type: 'file', size: 1, mtimeMs: mtimeOf('Docs/Sub/c.txt') },
                ]);
                // Nothing in a hidden folder, an ignored one, one Proton Drive doesn't have (or not yet), or a file
                expect(d.engine.vfsChildren('Docs/Private')).toEqual([]);
                expect(d.engine.vfsChildren('Docs/.git')).toEqual([]);
                expect(d.engine.vfsChildren('Nowhere')).toEqual([]);
                expect(d.engine.vfsChildren('Docs/a.txt')).toEqual([]);
                expect(d.calls.downloads).toEqual(['Docs/b.txt']);
            });

            test('an index entry that a pending rename left behind (its new name taken in the cloud) is neither listed nor downloaded', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'mine');
                d.add('Docs/keep.txt', 'keep');
                await d.engine.reconcileNow();
                d.down.add('renameNode');
                await d.engine.renameItem('Docs/a.txt', 'Docs/b.txt');
                expect(d.engine.vfsChildren('Docs').map((e) => e.name)).toEqual(['b.txt', 'keep.txt']);
                d.add('Docs/b.txt', 'theirs'); // made on the web meanwhile
                const engine = d.restart(); // its first pass lists the folders that aren't on this computer again
                await engine.reconcileNow();
                // The cloud's b.txt has that name in the index; mine is left where the cloud has it, as a ghost
                expect(engine.remoteIndex.getByPath('Docs/b.txt')?.uid).toBe('vol~Docs/b.txt');
                expect(engine.remoteIndex.getByPath('Docs/a.txt')?.uid).toBe('vol~Docs/a.txt');

                expect(engine.vfsChildren('Docs').map((e) => e.name)).toEqual(['b.txt', 'keep.txt']);
                expect(engine.vfsChildren('Docs').find((e) => e.name === 'b.txt')?.size).toBe('theirs'.length);
                expect(await failure(engine.hydrate('Docs/a.txt'))).toEqual({
                    code: 'ENOENT',
                    message: 'Not in Proton Drive: Docs/a.txt',
                    driveOpError: true,
                });
                expect(d.calls.downloads).toEqual([]);
                expect(await d.files.exists('Docs/a.txt')).toBe(false);
                expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
                expect(d.journal()).toMatchObject([{ kind: 'rename', nodeUid: 'vol~Docs/a.txt', toPath: 'Docs/b.txt' }]);
            });

            test('a folder made here that Proton Drive does not have yet is listed as a folder with what was moved into it, and its uid is never looked up', async () => {
                const d = setup();
                d.add('Docs/x.txt', 'x');
                await d.engine.reconcileNow();
                await mkdir(d.local('New'));
                d.down.add('getNode'); // the replay can't run yet
                await d.engine.renameItem('Docs/x.txt', 'New/x.txt');
                const provisional = d.engine.remoteIndex.getByPath('New')!;
                expect(provisional.uid.startsWith('provisional:')).toBe(true);
                const getNode = spyOn(d.sdk, 'getNode');

                expect(d.engine.vfsChildren('')).toEqual([
                    { name: 'Docs', type: 'folder', size: 0, mtimeMs: d.engine.remoteIndex.getByPath('Docs')!.mtimeMs },
                    { name: 'New', type: 'folder', size: 0, mtimeMs: provisional.mtimeMs },
                ]);
                expect(d.engine.vfsChildren('New')).toEqual([
                    { name: 'x.txt', type: 'file', size: 1, mtimeMs: d.engine.remoteIndex.getByPath('New/x.txt')!.mtimeMs },
                ]);
                expect(d.engine.vfsChildren('Docs')).toEqual([]);

                // The folder is here: nothing to download
                await d.engine.hydrate('New');
                // Not here (gone from disk, still in the index): a folder is never downloaded, and its provisional uid is
                // never asked about
                await rm(d.local('New'), { recursive: true });
                expect(await failure(d.engine.hydrate('New'))).toEqual({ code: 'EIO', message: 'Not a file: New', driveOpError: true });
                await mkdir(d.local('New'));
                // Offline: the download of what is in it fails, leaving nothing behind
                expect(await failure(d.engine.hydrate('New/x.txt'))).toMatchObject({ code: 'EIO', driveOpError: true });
                expect(await d.files.exists('New/x.txt')).toBe(false);
                expect(stateDb.getItemByPath('New/x.txt')).toBeNull();

                d.down.clear();
                await d.engine.hydrate('New/x.txt');

                expect(await readFile(d.local('New/x.txt'), 'utf8')).toBe('x');
                expect(stateDb.getItemByPath('New/x.txt')?.nodeUid).toBe('vol~Docs/x.txt');
                expect(d.engine.availability.stateOf('New/x.txt')).toBe('downloaded');
                expect(getNode.mock.calls.map(([uid]) => uid)).not.toContainEqual(expect.stringMatching(/^provisional:/));
                expect(getNode.mock.calls.length).toBeGreaterThan(0);
                getNode.mockRestore();
                // Then the folder reaches Proton Drive, and the file is moved into it there, not uploaded again
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();
                const created = d.named(d.root.uid, 'New');
                expect(created.length).toBe(1);
                expect(d.nodes.get('vol~Docs/x.txt')?.parentUid).toBe(created[0]!.uid);
                expect(d.calls.downloads).toEqual(['Docs/x.txt']);
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                expect(d.journal()).toEqual([]);
                expect(d.engine.availability.stateOf('New/x.txt')).toBe('downloaded');
            });
        });

        describe('hydrate', () => {
            test('downloads a file once for concurrent calls, records it, and forgets its failed thumbnail', async () => {
                const d = setup();
                d.add('Docs/été/a b.txt', 'hello');
                d.add('Docs/other.txt', 'other');
                await d.engine.reconcileNow();
                expect(d.engine.availability.stateOf('Docs/été/a b.txt')).toBe('online-only');

                const first = d.engine.hydrate('Docs/été/a b.txt');
                const second = d.engine.hydrate('Docs/été/a b.txt');
                expect(second).toBe(first); // the same download
                await Promise.all([first, second]);

                expect(d.calls.downloads).toEqual(['Docs/été/a b.txt']);
                expect(await readFile(d.local('Docs/été/a b.txt'), 'utf8')).toBe('hello');
                expect(stateDb.getItemByPath('Docs/été/a b.txt')?.nodeUid).toBe('vol~Docs/été/a b.txt');
                expect(d.engine.availability.stateOf('Docs/été/a b.txt')).toBe('downloaded');
                expect(d.forgotten).toEqual([d.mountPath('Docs/été/a b.txt')]);
                expect(await d.files.exists('Docs/other.txt')).toBe(false);
                expect(await d.tempFilesIn('Docs/été')).toEqual([]);
                expect(await d.tempFilesIn('')).toEqual([]);
                // Once it is here, asking again resolves at once
                const again = d.engine.hydrate('Docs/été/a b.txt');
                expect(again).not.toBe(first);
                await again;
                expect(d.calls.downloads).toEqual(['Docs/été/a b.txt']);
                expect(d.forgotten.length).toBe(1);
                // The next syncs take it as synced: nothing goes up, comes down or goes to the trash
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();
                expect(d.calls.downloads).toEqual(['Docs/été/a b.txt']);
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                expect(d.engine.availability.stateOf('Docs/été/a b.txt')).toBe('downloaded');
                expect(await d.files.exists('Docs/other.txt')).toBe(false);
            });

            test('refuses a hidden item (EACCES), and a path Proton Drive does not have or that is ignored (ENOENT), downloading nothing', async () => {
                const d = setup();
                d.add('Private/secret.txt', 's');
                d.add('Docs/a.txt', 'a');
                d.add('Docs/movie.part', 'p');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Private', 'hide');

                expect(await failure(d.engine.hydrate('Private/secret.txt'))).toEqual({
                    code: 'EACCES',
                    message: 'Hidden: Private/secret.txt',
                    driveOpError: true,
                });
                expect(await failure(d.engine.hydrate('Docs/nope.txt'))).toEqual({
                    code: 'ENOENT',
                    message: 'Not in Proton Drive: Docs/nope.txt',
                    driveOpError: true,
                });
                expect(await failure(d.engine.hydrate('Docs/movie.part'))).toEqual({
                    code: 'ENOENT',
                    message: 'Not in Proton Drive: Docs/movie.part',
                    driveOpError: true,
                });
                expect(d.calls.downloads).toEqual([]);
                expect(await d.files.exists('Private')).toBe(false);
                expect(await d.files.exists('Docs')).toBe(false);
                expect(d.forgotten).toEqual([]);
            });

            test('a failed download rejects with EIO and leaves no temp file, no record and no folder; a later try works', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'hello');
                d.add('Docs/keep.txt', 'keep');
                d.add('Other/b.txt', 'b');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/keep.txt', 'pin'); // so Docs is a folder on this computer
                const sdk = d.sdk as any;
                const real = sdk.getFileRevisionDownloader;

                // Offline before the download starts
                d.failNext('getFileRevisionDownloader');
                expect(await failure(d.engine.hydrate('Docs/a.txt'))).toEqual({
                    code: 'EIO',
                    message: 'Network unreachable',
                    driveOpError: true,
                });
                // Looked at after each failure: a later try could reuse the same temp name
                expect(await d.tempFilesIn('Docs')).toEqual([]);
                expect(await d.tempFilesIn('')).toEqual([]);
                // The connection drops half way through
                sdk.getFileRevisionDownloader = async () => ({
                    downloadToStream: (writable: WritableStream) => {
                        const writer = writable.getWriter() as unknown as { write(bytes: Uint8Array): unknown };
                        return {
                            completion: async () => {
                                writer.write(Buffer.from('hel'));
                                throw new ConnectionError('Connection dropped');
                            },
                        };
                    },
                });
                expect(await failure(d.engine.hydrate('Docs/a.txt'))).toEqual({
                    code: 'EIO',
                    message: 'Connection dropped',
                    driveOpError: true,
                });
                expect(await d.tempFilesIn('Docs')).toEqual([]);
                expect(await d.tempFilesIn('')).toEqual([]);
                // In a folder that isn't on this computer: the folder made to hold it goes too
                expect(await failure(d.engine.hydrate('Other/b.txt'))).toMatchObject({ code: 'EIO', driveOpError: true });
                sdk.getFileRevisionDownloader = real;
                // Proton Drive can't be asked about it
                d.failNext('getNode');
                expect(await failure(d.engine.hydrate('Docs/a.txt'))).toMatchObject({ code: 'EIO', driveOpError: true });

                expect(await d.tempFilesIn('Docs')).toEqual([]);
                expect(await d.files.exists('Docs/a.txt')).toBe(false);
                expect(await d.files.exists('Other')).toBe(false);
                expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
                expect(stateDb.getItemByPath('Other/b.txt')).toBeNull();
                expect(d.engine.availability.stateOf('Docs/a.txt')).toBe('online-only');
                expect(d.forgotten).toEqual([]);

                await d.engine.hydrate('Docs/a.txt');
                await d.engine.hydrate('Other/b.txt');

                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('hello');
                expect(await readFile(d.local('Other/b.txt'), 'utf8')).toBe('b');
                expect(await d.tempFilesIn('Docs')).toEqual([]);
                expect(await d.tempFilesIn('Other')).toEqual([]);
                expect(await d.tempFilesIn('')).toEqual([]);
                await d.engine.reconcileNow();
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
            });

            test('tells the user when a download takes a while, and when it fails', async () => {
                stateDb.updateSettings({ notificationsEnabled: true });
                const notices: string[] = [];
                const notify = spyOn(notifications, 'sendDesktopNotification').mockImplementation((n) => {
                    notices.push(n.title);
                });
                try {
                    const d = setup();
                    d.add('Docs/big.mov', 'big');
                    d.add('Docs/small.txt', 'small');
                    d.add('Docs/slow lookup.txt', 'slow');
                    d.add('Docs/lost.txt', 'lost');
                    d.add('Docs/Sub/x.txt', 'x');
                    await d.engine.reconcileNow();
                    (d.engine as any).slowDownloadNoticeMs = 40;

                    await d.engine.hydrate('Docs/small.txt'); // quick: no notice
                    await Bun.sleep(80);
                    expect(notices).toEqual([]);
                    // Only the download itself counts, not a slow look-up before it
                    const sdk = d.sdk as any;
                    const getNode = sdk.getNode;
                    sdk.getNode = async (uid: string) => {
                        await Bun.sleep(150);
                        return getNode(uid);
                    };
                    await d.engine.hydrate('Docs/slow lookup.txt');
                    sdk.getNode = getNode;
                    await Bun.sleep(80);
                    expect(notices).toEqual([]);

                    const slow = slowDownloads(d);
                    const big = d.engine.hydrate('Docs/big.mov');
                    await until(() => notices.length > 0);
                    expect(notices).toEqual(['Downloading big.mov…']);
                    slow.release();
                    await big;
                    await Bun.sleep(80);
                    expect(notices).toEqual(['Downloading big.mov…']);

                    d.failNext('getFileRevisionDownloader');
                    expect(await failure(d.engine.hydrate('Docs/lost.txt'))).toMatchObject({ code: 'EIO' });
                    expect(notices).toEqual(['Downloading big.mov…', "Couldn't open lost.txt"]);
                    // Refusals are not download failures: no notice
                    expect(await failure(d.engine.hydrate('Docs/nope.txt'))).toMatchObject({ code: 'ENOENT' });
                    expect(await failure(d.engine.hydrate('Docs/Sub'))).toMatchObject({ code: 'EIO', message: 'Not a file: Docs/Sub' });
                    expect(notices.length).toBe(2);
                } finally {
                    notify.mockRestore();
                }
            });

            for (const [what, from, to] of [
                ['the file', 'Docs/a.txt', 'Docs/b.txt'],
                ['the folder above it', 'Docs', 'Work'],
            ] as const) {
                test(`a rename of ${what} through the drive during the download goes ahead at once; the hydrate answers ENOENT and nothing comes back at the old name`, async () => {
                    const d = setup();
                    d.add('Docs/a.txt', 'hello');
                    d.add('Docs/keep.txt', 'keep');
                    await d.engine.reconcileNow();
                    await d.engine.setAvailability('Docs/keep.txt', 'pin');
                    await d.engine.reconcileNow(); // records Docs
                    const slow = slowDownloads(d);

                    const hydrating = failure(d.engine.hydrate('Docs/a.txt'));
                    await until(() => slow.started() === 1);
                    expect(await withoutWaiting(d.engine.renameItem(from, to))).toBe('done');
                    slow.release();

                    expect(await hydrating).toEqual({ code: 'ENOENT', message: 'Not in Proton Drive: Docs/a.txt', driveOpError: true });
                    const renamedTo = from === 'Docs' ? 'Work/a.txt' : 'Docs/b.txt';
                    expect(d.engine.remoteIndex.getByPath(renamedTo)?.uid).toBe('vol~Docs/a.txt');
                    expect(await d.files.exists('Docs/a.txt')).toBe(false);
                    expect(await d.files.exists(renamedTo)).toBe(false); // still online-only
                    expect(await d.files.exists('Docs')).toBe(from !== 'Docs');
                    expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
                    expect(stateDb.getItemByPath(renamedTo)).toBeNull();
                    expect(await d.tempFilesIn('')).toEqual([]);
                    expect(d.forgotten).toEqual([]);
                    await d.engine.replayRemoteOps();
                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual([]);
                    expect(d.calls.trashed).toEqual([]);
                    expect(await d.files.exists('Docs/a.txt')).toBe(false);
                    // Opened under its new name, it downloads there
                    await d.engine.hydrate(renamedTo);
                    expect(await readFile(d.local(renamedTo), 'utf8')).toBe('hello');
                    expect(stateDb.getItemByPath(renamedTo)?.nodeUid).toBe('vol~Docs/a.txt');
                });
            }

            test('nothing waits for a running download: other opens, pins and local changes go ahead', async () => {
                const d = setup();
                d.add('Docs/big.mov', 'big');
                d.add('Docs/small.txt', 'small');
                d.add('Docs/pinned.txt', 'pinned');
                d.add('Docs/keep.txt', 'keep');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/keep.txt', 'pin');
                const slow = slowDownloads(d, (uid) => uid === 'vol~Docs/big.mov');

                const big = d.engine.hydrate('Docs/big.mov');
                await until(() => slow.started() === 1);
                expect(await withoutWaiting(d.engine.hydrate('Docs/small.txt'))).toBe('done');
                expect(await withoutWaiting(d.engine.setAvailability('Docs/pinned.txt', 'pin'))).toBe('done');
                await d.files.writeLocal('Docs/new.txt', 'new');
                expect(await withoutWaiting((d.engine as any).handleLocalFileChange('Docs/new.txt'))).toBe('done');
                expect(await readFile(d.local('Docs/small.txt'), 'utf8')).toBe('small');
                expect(await readFile(d.local('Docs/pinned.txt'), 'utf8')).toBe('pinned');
                expect(d.calls.uploads).toEqual(['Docs/new.txt']);
                expect(await d.files.exists('Docs/big.mov')).toBe(false);
                slow.release();
                await big;
                expect(await readFile(d.local('Docs/big.mov'), 'utf8')).toBe('big');
                expect(d.engine.availability.stateOf('Docs/big.mov')).toBe('downloaded');
            });

            test('a delete through the drive during the download goes ahead at once; the hydrate answers ENOENT and leaves nothing behind', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'hello');
                d.add('Docs/keep.txt', 'keep');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/keep.txt', 'pin');
                const slow = slowDownloads(d);

                const hydrating = failure(d.engine.hydrate('Docs/a.txt'));
                await until(() => slow.started() === 1);
                expect(await withoutWaiting(d.engine.deleteItem('Docs/a.txt'))).toBe('done');
                slow.release();

                expect(await hydrating).toEqual({ code: 'ENOENT', message: 'Not in Proton Drive: Docs/a.txt', driveOpError: true });
                expect(await d.files.exists('Docs/a.txt')).toBe(false);
                expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
                expect(await d.tempFilesIn('')).toEqual([]);
                await d.engine.replayRemoteOps();
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
                expect(d.calls.uploads).toEqual([]);
                expect(await d.files.exists('Docs/a.txt')).toBe(false);
                expect(await readFile(d.local('Docs/keep.txt'), 'utf8')).toBe('keep');
            });

            test('a cloud rename of the folder above, followed here during the download: the hydrate answers ENOENT and the old folder does not come back', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'hello');
                d.add('Docs/keep.txt', 'keep');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/keep.txt', 'pin');
                await d.engine.reconcileNow(); // records Docs
                const slow = slowDownloads(d);

                const hydrating = failure(d.engine.hydrate('Docs/a.txt'));
                await until(() => slow.started() === 1);
                d.moveInCloud('vol~Docs', 'Work');
                expect(await withoutWaiting(d.engine.reconcileNow())).toBe('done'); // follows it here
                expect(await readFile(d.local('Work/keep.txt'), 'utf8')).toBe('keep');
                expect(await d.files.exists('Docs')).toBe(false);
                slow.release();

                expect(await hydrating).toEqual({ code: 'ENOENT', message: 'Not in Proton Drive: Docs/a.txt', driveOpError: true });
                expect(await d.files.exists('Docs')).toBe(false);
                expect(await d.files.exists('Work/a.txt')).toBe(false);
                expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
                expect(stateDb.getItemByPath('Work/a.txt')).toBeNull();
                expect(await d.tempFilesIn('')).toEqual([]);
                await d.engine.reconcileNow();
                expect(await d.files.exists('Docs')).toBe(false);
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                expect(d.engine.remoteIndex.getByPath('Work/a.txt')?.uid).toBe('vol~Docs/a.txt');
            });

            // Review I2: an app writes the file (an open with O_TRUNC doesn't hydrate) while its hydrate downloads
            test('a file written at the path during the download is kept, not replaced by the download and recorded as synced', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'cloud');
                d.add('Docs/keep.txt', 'k');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/keep.txt', 'pin');
                const slow = slowDownloads(d);

                const hydrating = d.engine.hydrate('Docs/a.txt');
                await until(() => slow.started() === 1);
                await writeFile(d.local('Docs/a.txt'), 'NEW WORK');
                slow.release();
                await hydrating; // there is a local copy to open: this one

                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('NEW WORK');
                expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull(); // not taken for the cloud's copy
                expect(await d.tempFilesIn('')).toEqual([]);
                expect(d.forgotten).toEqual([]);
                await d.engine.reconcileNow();
                // The new content is not lost: it reaches Proton Drive (as a conflict copy, the default strategy)
                expect([...d.nodes.values()].some((n) => n.content === 'NEW WORK')).toBe(true);
                expect(d.calls.trashed).toEqual([]);
            });

            test('staging files left by an interrupted hydrate are swept from the backing store on start', async () => {
                const d = setup();
                await mkdir(d.local(''), { recursive: true });
                await writeFile(d.local('.proton-drive-tmp-hydrate-0b1d'), 'half a download');
                await writeFile(d.local('.proton-drive-tmp-hydrate-77aa'), 'another');

                await d.engine.start();
                await d.engine.stop();

                expect(await d.tempFilesIn('')).toEqual([]);
            });
        });

        describe('deleting only if empty', () => {
            // Review I3: the drive maps rmdir onto this; git rm calls rmdir on each parent until one fails
            test('POST /vfs/delete with onlyIfEmpty refuses a folder holding anything, here or only in Proton Drive (ENOTEMPTY), and deletes an empty one', async () => {
                const d = setup();
                d.add('Repo/src/main.c', 'int main;');
                d.add('Repo/docs/readme.md', 'r');
                d.add('Repo/empty');
                d.add('Repo/moved/x.c', 'x');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Repo/docs/readme.md', 'pin');
                await d.files.writeLocal('Repo/local/notes.txt', 'mine');
                await mkdir(d.local('Repo/made here'));
                const socketPath = path.join(tempDir, 'sock', 'control.sock');
                const server = await startControlServer({ socketPath, engine: d.engine });
                const rmdir = (rel: string) =>
                    fetch('http://localhost/vfs/delete', {
                        unix: socketPath,
                        method: 'POST',
                        body: JSON.stringify({ path: rel, onlyIfEmpty: true }),
                    } as RequestInit);
                try {
                    for (const rel of ['Repo/local', 'Repo/src', 'Repo/docs', 'Repo']) {
                        const res = await rmdir(rel);
                        expect({ rel, status: res.status, body: await res.json() }).toEqual({
                            rel,
                            status: 400,
                            body: { error: `Not empty: ${rel}`, code: 'ENOTEMPTY' },
                        });
                    }
                    expect(await readFile(d.local('Repo/local/notes.txt'), 'utf8')).toBe('mine');
                    expect(await readFile(d.local('Repo/docs/readme.md'), 'utf8')).toBe('r');
                    expect(d.engine.remoteIndex.getByPath('Repo/src/main.c')).not.toBeNull();
                    expect(d.journal()).toEqual([]);

                    // Empty: in Proton Drive only, or made here only
                    expect((await rmdir('Repo/empty')).status).toBe(200);
                    expect((await rmdir('Repo/made here')).status).toBe(200);
                    expect(d.engine.remoteIndex.getByPath('Repo/empty')).toBeNull();
                    expect(await d.files.exists('Repo/made here')).toBe(false);
                    // Empty once what was in it has been moved out, though Proton Drive still has it there until the
                    // move reaches it: the move goes first
                    await d.engine.renameItem('Repo/moved/x.c', 'Repo/x.c');
                    expect((await rmdir('Repo/moved')).status).toBe(200);
                } finally {
                    server.stop();
                }
                await d.engine.replayRemoteOps();
                expect(d.nodes.get('vol~Repo/moved/x.c')?.parentUid).toBe('vol~Repo');
                expect(d.calls.trashed.flat().sort()).toEqual(['vol~Repo/empty', 'vol~Repo/moved']);
                expect(d.nodes.has('vol~Repo/src/main.c')).toBe(true);
                expect(d.calls.downloads).toEqual(['Repo/docs/readme.md']);
            });
        });

        describe('saving into an online-only folder', () => {
            // The drive makes the folder in the backing store to hold a file saved into it: that folder is the cloud's
            // own, never a new one, and the rest of what is in it stays online-only
            const saveInto = async (reported: (d: ReturnType<typeof setup>) => Promise<void>) => {
                const d = setup();
                d.add('A/x.txt', 'x');
                d.add('A/y.txt', 'y');
                d.add('A/Sub/z.txt', 'z');
                await d.engine.reconcileNow();
                expect(d.engine.availability.stateOf('A')).toBe('online-only');
                expect(await d.files.exists('A')).toBe(false);

                await d.files.writeLocal('A/new.txt', 'new');
                await reported(d);
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.named(d.root.uid, 'A').map((n) => n.uid)).toEqual(['vol~A']);
                const inA = [...d.nodes.values()].filter((n) => n.parentUid === 'vol~A').map((n) => d.nameOf(n));
                expect(inA.sort()).toEqual(['Sub', 'new.txt', 'x.txt', 'y.txt']);
                expect(d.named('vol~A', 'new.txt')[0]?.content).toBe('new');
                expect(d.calls.uploads).toEqual(['A/new.txt']);
                expect(stateDb.getItemByPath('A')?.nodeUid).toBe('vol~A');
                expect(d.engine.remoteIndex.getByPath('A')?.uid).toBe('vol~A');
                expect(d.engine.vfsChildren('A').map((e) => e.name)).toEqual(['Sub', 'new.txt', 'x.txt', 'y.txt']);
                expect((await readdir(d.local('A'))).sort()).toEqual(['new.txt']);
                expect(d.engine.availability.stateOf('A/x.txt')).toBe('online-only');
                expect(d.engine.availability.stateOf('A/Sub')).toBe('online-only');
                expect(d.calls.downloads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.renamed).toEqual([]);
                expect(d.calls.moved).toEqual([]);
            };

            test('a file saved into a folder only Proton Drive has uploads into that folder after a sync pass', async () => {
                await saveInto(async () => {});
            });

            for (const via of ['pass', 'watcher'] as const) {
                test(`a file saved two online-only folders down goes into those very folders (${via})`, async () => {
                    const d = setup();
                    d.add('A/B/x.txt', 'x');
                    d.add('A/y.txt', 'y');
                    await d.engine.reconcileNow();
                    expect(await d.files.exists('A')).toBe(false);

                    await d.files.writeLocal('A/B/new.txt', 'new'); // the drive makes A and B to hold it
                    if (via === 'watcher') {
                        for (const rel of ['A', 'A/B', 'A/B/new.txt']) {
                            await (d.engine as any).handleLocalFileChange(rel);
                        }
                    }
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(d.named(d.root.uid, 'A').map((n) => n.uid)).toEqual(['vol~A']);
                    expect(d.named('vol~A', 'B').map((n) => n.uid)).toEqual(['vol~A/B']);
                    expect(d.named('vol~A/B', 'new.txt')[0]?.content).toBe('new');
                    expect(d.calls.uploads).toEqual(['A/B/new.txt']);
                    expect(await readdir(d.local('A'))).toEqual(['B']);
                    expect(await readdir(d.local('A/B'))).toEqual(['new.txt']);
                    expect(d.engine.availability.stateOf('A/B/x.txt')).toBe('online-only');
                    expect(d.calls.downloads).toEqual([]);
                    expect(d.calls.trashed).toEqual([]);
                });
            }

            test('the watcher reporting the folder made for it, then the file, adopts the cloud folder too', async () => {
                await saveInto(async (d) => {
                    await (d.engine as any).handleLocalFileChange('A');
                    await (d.engine as any).handleLocalFileChange('A/new.txt');
                });
            });
        });

        describe('editing an online-only file through the drive', () => {
            // The drive turns an online-only file into an empty local one (an O_TRUNC open, a truncate) through POST
            // /vfs/truncate, which keeps what the drive showed then as the baseline the new content is an edit of
            const changeInCloud = (d: ReturnType<typeof setup>, uid: string, content: string) => {
                const node = d.nodes.get(uid)!;
                d.nodes.set(uid, makeMockNode({ uid, parentUid: node.parentUid, nameStr: d.nameOf(node), type: NodeType.File, content }));
            };
            const truncatedAndWritten = async (d: ReturnType<typeof setup>, rel: string, content: string) => {
                await d.engine.truncateItem(rel);
                expect(await readFile(d.local(rel), 'utf8')).toBe('');
                await writeFile(d.local(rel), content);
            };
            const editThroughTheDrive = async (via: 'pass' | 'watcher', cloudChangedMeanwhile: boolean) => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                d.add('Docs/other.txt', 'o');
                await d.engine.reconcileNow();
                expect(d.engine.remoteIndex.getByPath('Docs/doc.txt')?.uid).toBe('vol~Docs/doc.txt');
                expect(d.engine.availability.stateOf('Docs/doc.txt')).toBe('online-only');
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                if (cloudChangedMeanwhile) {
                    changeInCloud(d, 'vol~Docs/doc.txt', 'theirs'); // another device, after the drive showed it
                }
                if (via === 'watcher') {
                    await (d.engine as any).handleLocalFileChange('Docs');
                    await (d.engine as any).handleLocalFileChange('Docs/doc.txt');
                }
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();
                return d;
            };
            const cloudNamesIn = (d: ReturnType<typeof setup>, parentUid: string) =>
                [...d.nodes.values()].filter((n) => n.parentUid === parentUid).map((n) => d.nameOf(n)).sort();
            const expectConflictKeptTheirs = async (d: ReturnType<typeof setup>) => {
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                const copies = cloudNamesIn(d, 'vol~Docs').filter((n) => n.startsWith('doc (conflict '));
                expect(copies.length).toBeGreaterThan(0);
                for (const copy of copies) {
                    expect(d.named('vol~Docs', copy)[0]?.content).toBe('mine');
                }
                expect(d.calls.trashed).toEqual([]);
            };

            for (const via of ['pass', 'watcher'] as const) {
                const first = via === 'pass' ? 'a sync pass' : 'the watcher';
                test(`seen by ${first} first, it uploads as a new revision of that file, with no conflict copy and nothing downloaded`, async () => {
                    const d = await editThroughTheDrive(via, false);

                    expect(d.named('vol~Docs', 'doc.txt').map((n) => n.uid)).toEqual(['vol~Docs/doc.txt']);
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('mine');
                    expect(cloudNamesIn(d, 'vol~Docs')).toEqual(['doc.txt', 'other.txt']);
                    expect(d.calls.uploads.filter((u) => u === 'Docs/doc.txt').length).toBeGreaterThan(0);
                    expect(d.calls.uploads.every((u) => u === 'Docs/doc.txt')).toBe(true);
                    expect(d.calls.downloads).toEqual([]);
                    expect(d.calls.trashed).toEqual([]);
                    expect((await readdir(d.local('Docs'))).sort()).toEqual(['doc.txt']);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine');
                    expect(stateDb.getItemByPath('Docs/doc.txt')?.nodeUid).toBe('vol~Docs/doc.txt');
                    expect(stateDb.getEditBaseline('Docs/doc.txt')).toBeNull(); // consumed by the record
                    expect(d.engine.availability.stateOf('Docs/other.txt')).toBe('online-only');
                });

                test(`seen by ${first} first after another device changed the file, it meets the conflict handling, never overwriting that change`, async () => {
                    const d = await editThroughTheDrive(via, true);

                    await expectConflictKeptTheirs(d);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                });

                // Review C1: with the prompt strategy no record is made, and a later pass must still not take the
                // changed cloud for what the drive showed
                test(`seen by ${first} first after another device changed the file, with conflicts left to the user, no later pass overwrites that change`, async () => {
                    stateDb.updateSettings({ conflictStrategy: 'prompt' });
                    const d = await editThroughTheDrive(via, true);

                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                    expect(d.calls.uploads).toEqual([]);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine');
                    expect(stateDb.listConflicts().map((c) => c.localRelPath)).toContain('Docs/doc.txt');
                });
            }

            test('a keep-both cut short after the conflict copy is made still never overwrites the cloud change', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                changeInCloud(d, 'vol~Docs/doc.txt', 'theirs');
                d.failNext('getFileRevisionDownloader'); // the conflict copy is made, then the download fails

                await d.engine.reconcileNow();
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                await expectConflictKeptTheirs(d);
            });

            test('with no checksum in the cloud, what the drive showed is compared by size and time', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                d.add('Docs/same.txt', 'same');
                for (const uid of ['vol~Docs/doc.txt', 'vol~Docs/same.txt']) {
                    const node = d.nodes.get(uid)!;
                    d.nodes.set(uid, { ...node, activeRevision: { ...node.activeRevision!, claimedDigests: undefined } } as any);
                }
                await d.engine.reconcileNow();
                expect(d.engine.remoteIndex.getByPath('Docs/doc.txt')?.sha1).toBeNull();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                await truncatedAndWritten(d, 'Docs/same.txt', 'edited');
                // Another device writes doc.txt again, still with no checksum: only its size and time changed
                const node = d.nodes.get('vol~Docs/doc.txt')!;
                const later = new Date(node.modificationTime.getTime() + 60_000);
                d.nodes.set('vol~Docs/doc.txt', {
                    ...node,
                    content: 'theirs!',
                    modificationTime: later,
                    activeRevision: { ...node.activeRevision!, claimedDigests: undefined, claimedModificationTime: later, claimedSize: 7 },
                } as any);
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs!');
                expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                expect(cloudNamesIn(d, 'vol~Docs').some((n) => n.startsWith('doc (conflict '))).toBe(true);
                // Unchanged by size and time: an edit, as with a checksum
                expect(d.named('vol~Docs', 'same.txt').map((n) => n.uid)).toEqual(['vol~Docs/same.txt']);
                expect(d.nodes.get('vol~Docs/same.txt')?.content).toBe('edited');
            });

            test('with no baseline, a local file where the drive shows an online-only file is a new file: a conflict', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/doc.txt', 'mine'); // made while the daemon was down, say, or a stray merge

                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('old');
                expect(cloudNamesIn(d, 'vol~Docs').some((n) => n.startsWith('doc (conflict '))).toBe(true);
                expect(d.calls.uploads).not.toContain('Docs/doc.txt');
            });

            test('the baseline follows renames through the drive, goes with deletes, and outlives a restart', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                d.add('Docs/c.txt', 'c');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/a.txt', 'A');
                await truncatedAndWritten(d, 'Docs/b.txt', 'B');
                await truncatedAndWritten(d, 'Docs/c.txt', 'C');

                await d.engine.renameItem('Docs/a.txt', 'Docs/a2.txt');
                await d.engine.replayRemoteOps();
                expect(stateDb.getEditBaseline('Docs/a.txt')).toBeNull();
                expect(stateDb.getEditBaseline('Docs/a2.txt')?.nodeUid).toBe('vol~Docs/a.txt');
                await d.engine.renameItem('Docs', 'Work');
                await d.engine.replayRemoteOps();
                expect(stateDb.getEditBaseline('Work/a2.txt')?.nodeUid).toBe('vol~Docs/a.txt');
                expect(stateDb.getEditBaseline('Work/b.txt')?.nodeUid).toBe('vol~Docs/b.txt');
                await d.engine.deleteItem('Work/c.txt');
                expect(stateDb.getEditBaseline('Work/c.txt')).toBeNull();

                const restarted = d.restart();
                await restarted.replayRemoteOps();
                await restarted.reconcileNow();
                await restarted.reconcileNow();
                expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('A');
                expect(d.nameOf(d.nodes.get('vol~Docs/a.txt')!)).toBe('a2.txt');
                expect(d.nodes.get('vol~Docs/b.txt')?.content).toBe('B');
                expect(cloudNamesIn(d, 'vol~Docs').sort()).toEqual(['a2.txt', 'b.txt']);
                expect(d.calls.downloads).toEqual([]);
            });

            // Review N1: an editor's atomic save over a file whose edit is still unsettled keeps judging by the baseline
            test('an atomic save over an edit still in conflict (prompt) never overwrites the cloud change', async () => {
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                changeInCloud(d, 'vol~Docs/doc.txt', 'theirs');
                await d.engine.reconcileNow(); // the conflict is queued, with no record; the index now has 'theirs'
                // The editor saves again: a temp file renamed over the file, through the drive
                await writeFile(d.local('Docs/doc.txt.new'), 'mine again');
                await d.engine.renameItem('Docs/doc.txt.new', 'Docs/doc.txt');
                await d.engine.replayRemoteOps();
                expect(stateDb.getEditBaseline('Docs/doc.txt')?.sha1).toBe(new Bun.CryptoHasher('sha1').update('old').digest('hex'));
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(d.calls.uploads).toEqual([]);
                expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine again');
            });

            test('an atomic save after a keep-both cut short never overwrites the cloud change', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                changeInCloud(d, 'vol~Docs/doc.txt', 'theirs');
                d.failNext('getFileRevisionDownloader'); // the conflict copy is made, then the download fails
                await d.engine.reconcileNow();
                await writeFile(d.local('Docs/doc.txt.new'), 'mine again');
                await d.engine.renameItem('Docs/doc.txt.new', 'Docs/doc.txt');
                await d.engine.replayRemoteOps();
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                const copies = cloudNamesIn(d, 'vol~Docs').filter((n) => n.startsWith('doc (conflict '));
                expect(copies.map((c) => d.named('vol~Docs', c)[0]?.content)).toContain('mine again');
            });

            // Review R1: the cloud's file was replaced by another node meanwhile; the save must not land on it unseen
            test('an atomic save over an edit still in conflict, whose cloud file became another node, never overwrites that node', async () => {
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                // Another device replaces the file with a new node of the same name
                d.nodes.delete('vol~Docs/doc.txt');
                d.nodes.set('vol~other', makeMockNode({ uid: 'vol~other', parentUid: 'vol~Docs', nameStr: 'doc.txt', type: NodeType.File, content: 'theirs' }));
                await d.engine.reconcileNow(); // the conflict is queued, with no record; the index now has vol~other
                await writeFile(d.local('Docs/doc.txt.new'), 'mine again');
                await d.engine.renameItem('Docs/doc.txt.new', 'Docs/doc.txt');
                await d.engine.replayRemoteOps();
                expect(stateDb.getEditBaseline('Docs/doc.txt')?.nodeUid).toBe('vol~Docs/doc.txt');
                expect(stateDb.getItemByPath('Docs/doc.txt')).toBeNull();
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~other')?.content).toBe('theirs');
                expect(d.calls.uploads).toEqual([]);
                expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine again');
            });

            // Review N5: deleted outside the drive and reported by the watcher
            test('the watcher reporting the file gone drops its baseline', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await d.engine.truncateItem('Docs/doc.txt');
                await rm(d.local('Docs/doc.txt'));

                await (d.engine as any).handleLocalFileChange('Docs/doc.txt');

                expect(stateDb.getEditBaseline('Docs/doc.txt')).toBeNull();
                expect(d.calls.trashed).toEqual([]);
            });

            // S24: the helper gives up after its own limit; what it gave up on mustn't happen later
            test('a truncate, rename or delete whose turn comes after its deadline changes nothing', async () => {
                const d = setup();
                d.add('Docs/online.txt', 'o');
                d.add('Docs/keep.txt', 'k');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/keep.txt', 'pin');
                let release!: () => void;
                const held = (d.engine as any).inAvailabilityRun(() => new Promise<void>((resolve) => (release = resolve)));
                const deadlineMs = Date.now() + 20;
                const late = [
                    failure(d.engine.truncateItem('Docs/online.txt', { deadlineMs })),
                    failure(d.engine.renameItem('Docs/keep.txt', 'Docs/moved.txt', { deadlineMs })),
                    failure(d.engine.deleteItem('Docs/keep.txt', { deadlineMs })),
                ];
                await Bun.sleep(200);
                release();
                await held;

                expect(await Promise.all(late)).toEqual([
                    { code: 'EIO', message: 'Timed out waiting: Docs/online.txt', driveOpError: true },
                    { code: 'EIO', message: 'Timed out waiting: Docs/keep.txt', driveOpError: true },
                    { code: 'EIO', message: 'Timed out waiting: Docs/keep.txt', driveOpError: true },
                ]);
                expect(await d.files.exists('Docs/online.txt')).toBe(false);
                expect(stateDb.getEditBaseline('Docs/online.txt')).toBeNull();
                expect(await readFile(d.local('Docs/keep.txt'), 'utf8')).toBe('k');
                expect(await d.files.exists('Docs/moved.txt')).toBe(false);
                expect(d.journal()).toEqual([]);
                // In time, as before
                await d.engine.truncateItem('Docs/online.txt', { deadlineMs: Date.now() + 60_000 });
                expect(await readFile(d.local('Docs/online.txt'), 'utf8')).toBe('');
            });

            test('a baseline whose file is gone is dropped at the next pass', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await d.engine.truncateItem('Docs/doc.txt');
                await rm(d.local('Docs/doc.txt'));

                await d.engine.reconcileNow();

                expect(stateDb.getEditBaseline('Docs/doc.txt')).toBeNull();
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('old');
                expect(d.calls.trashed).toEqual([]);
            });

            test('POST /vfs/truncate makes an empty local file of an online-only file only, keeping its baseline', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                d.add('Docs/pinned.txt', 'p');
                d.add('Docs/Sub/x.txt', 'x');
                d.add('Private/s.txt', 's');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/pinned.txt', 'pin');
                await d.engine.setAvailability('Private', 'hide');
                const socketPath = path.join(tempDir, 'sock', 'control.sock');
                const server = await startControlServer({ socketPath, engine: d.engine });
                const truncate = async (rel: string) => {
                    const res = await fetch('http://localhost/vfs/truncate', {
                        unix: socketPath,
                        method: 'POST',
                        body: JSON.stringify({ path: rel }),
                    } as RequestInit);
                    return { status: res.status, body: await res.json() };
                };
                try {
                    expect(await truncate('Docs/doc.txt')).toEqual({ status: 200, body: { ok: true } });
                    expect(await truncate('Docs/doc.txt')).toEqual({
                        status: 400,
                        body: { error: 'Already exists: Docs/doc.txt', code: 'EEXIST' },
                    });
                    expect(await truncate('Docs/pinned.txt')).toEqual({
                        status: 400,
                        body: { error: 'Already exists: Docs/pinned.txt', code: 'EEXIST' },
                    });
                    expect(await truncate('Private/s.txt')).toEqual({ status: 400, body: { error: 'Hidden: Private/s.txt', code: 'EACCES' } });
                    expect(await truncate('Docs/Sub')).toEqual({ status: 400, body: { error: 'Not found: Docs/Sub', code: 'ENOENT' } });
                    expect(await truncate('Docs/nope.txt')).toEqual({ status: 400, body: { error: 'Not found: Docs/nope.txt', code: 'ENOENT' } });
                } finally {
                    server.stop();
                }
                expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('');
                expect(await readFile(d.local('Docs/pinned.txt'), 'utf8')).toBe('p');
                expect(await d.files.exists('Docs/Sub')).toBe(false);
                expect(stateDb.getEditBaseline('Docs/doc.txt')).toMatchObject({
                    nodeUid: 'vol~Docs/doc.txt',
                    sha1: d.engine.remoteIndex.getByPath('Docs/doc.txt')!.sha1,
                    size: 3,
                });
                expect(stateDb.getEditBaseline('Docs/pinned.txt')).toBeNull();
                expect(stateDb.getItemByPath('Docs/doc.txt')).toBeNull(); // not a record: gone, it reads as nothing
                expect(d.calls.downloads).toEqual(['Docs/pinned.txt']);
            });

            test('in the plain layout, where the online-only file never showed, a file of that name stays a conflict', async () => {
                const drive = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger);
                const files = localFiles(stateDb);
                drive.add('Docs/doc.txt', 'old');
                await engine.reconcileNow();
                expect(engine.availability.stateOf('Docs/doc.txt')).toBe('online-only');
                await files.writeLocal('Docs/doc.txt', 'mine');
                await engine.reconcileNow();
                await engine.reconcileNow();

                expect(drive.nodes.get('vol~Docs/doc.txt')?.content).toBe('old');
                const names = [...drive.nodes.values()].filter((n) => n.parentUid === 'vol~Docs').map((n) => drive.nameOf(n));
                expect(names.length).toBe(2);
                expect(names.some((n) => n.startsWith('doc (conflict '))).toBe(true);
                expect(await readFile(path.join(files.syncDir(), 'Docs/doc.txt'), 'utf8')).toBe('old');
            });

            // Final review M-3 (deferred L157): a file being edited through the drive with no record yet is an edit of
            // its baseline's node. Another device may have put a node of its own at that path since, which the index then
            // holds: deleting or renaming the file here acts on the baseline's node, never on that one.
            const replacedByAnotherDevice = async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                d.nodes.delete('vol~Docs/doc.txt');
                const theirs = makeMockNode({ uid: 'vol~theirs', parentUid: 'vol~Docs', nameStr: 'doc.txt', type: NodeType.File, content: 'theirs' });
                d.nodes.set(theirs.uid, theirs);
                d.engine.remoteIndex.upsert(entryFromNode(theirs, 'Docs')!); // as a listing of Docs would
                expect(stateDb.getItemByPath('Docs/doc.txt')).toBeNull();
                expect(stateDb.getEditBaseline('Docs/doc.txt')?.nodeUid).toBe('vol~Docs/doc.txt');
                expect(d.engine.remoteIndex.getByPath('Docs/doc.txt')?.uid).toBe('vol~theirs');
                return d;
            };

            test('deleting it through the drive trashes the node it is an edit of, never the one another device put there', async () => {
                const d = await replacedByAnotherDevice();

                await d.engine.deleteItem('Docs/doc.txt');
                expect(d.journal().map((op) => [op.kind, op.nodeUid])).toEqual([['trash', 'vol~Docs/doc.txt']]);
                await d.engine.replayRemoteOps();

                expect(d.calls.trashed.flat()).not.toContain('vol~theirs');
                expect(d.nodes.get('vol~theirs')?.content).toBe('theirs');
            });

            test('renaming it through the drive renames the node it is an edit of, never the one another device put there', async () => {
                const d = await replacedByAnotherDevice();

                await d.engine.renameItem('Docs/doc.txt', 'Docs/renamed.txt');
                expect(d.journal().map((op) => [op.kind, op.nodeUid])).toEqual([['rename', 'vol~Docs/doc.txt']]);
                await d.engine.replayRemoteOps();

                expect(d.calls.renamed.map((r) => r.uid)).not.toContain('vol~theirs');
                expect(d.nameOf(d.nodes.get('vol~theirs')!)).toBe('doc.txt');
                expect(await readFile(d.local('Docs/renamed.txt'), 'utf8')).toBe('mine');
            });
        });

        // #21: the watcher used to upload such a file as a new revision of the cloud's, overwriting it unseen
        describe('a new local file where Proton Drive has a file of that name', () => {
            const conflictNames = (nodes: Map<string, { parentUid?: string }>, nameOf: (n: any) => string, parentUid: string) =>
                [...nodes.values()].filter((n) => n.parentUid === parentUid).map((n) => nameOf(n)).filter((n) => n.includes(' (conflict '));

            for (const strategy of ['keep-both', 'prompt'] as const) {
                test(`reported by the watcher, it meets the conflict handling (${strategy}) as a pass would, never a new revision`, async () => {
                    stateDb.updateSettings({ conflictStrategy: strategy });
                    const d = setup();
                    d.add('Docs/doc.txt', 'old');
                    await d.engine.reconcileNow();
                    await d.files.writeLocal('Docs/doc.txt', 'mine'); // no baseline: made while the daemon was down, say

                    await (d.engine as any).handleLocalFileChange('Docs');
                    await (d.engine as any).handleLocalFileChange('Docs/doc.txt');
                    await d.engine.reconcileNow();

                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('old');
                    expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                    if (strategy === 'keep-both') {
                        expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs').length).toBe(1);
                    } else {
                        expect(stateDb.listConflicts().map((c) => c.localRelPath)).toContain('Docs/doc.txt');
                        expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine');
                    }
                });
            }

            test('one the index has yet to hear of, found by the upload being refused, meets the conflict handling too', async () => {
                const d = setup();
                d.add('Docs/keep.txt', 'k');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs', 'pin');
                await d.engine.reconcileNow();
                d.add('Docs/late.txt', 'cloud'); // since the last listing
                await d.files.writeLocal('Docs/late.txt', 'mine');

                await (d.engine as any).handleLocalFileChange('Docs/late.txt');

                expect(d.nodes.get('vol~Docs/late.txt')?.content).toBe('cloud');
                expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs').length).toBe(1);
                expect(await readFile(d.local('Docs/late.txt'), 'utf8')).toBe('cloud');
            });

            test('the same content is simply recorded, and a name nobody has uploads as a new file', async () => {
                const d = setup();
                d.add('Docs/same.txt', 'same');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/same.txt', 'same');
                await d.files.writeLocal('Docs/new.txt', 'new');

                await (d.engine as any).handleLocalFileChange('Docs/same.txt');
                await (d.engine as any).handleLocalFileChange('Docs/new.txt');

                expect(stateDb.getItemByPath('Docs/same.txt')?.nodeUid).toBe('vol~Docs/same.txt');
                expect(d.calls.uploads).toEqual(['Docs/new.txt']);
                expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs')).toEqual([]);
            });

            test('in the plain layout too', async () => {
                const drive = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger);
                const files = localFiles(stateDb);
                drive.add('Docs/doc.txt', 'old');
                await engine.reconcileNow();
                await files.writeLocal('Docs/doc.txt', 'mine');

                await (engine as any).handleLocalFileChange('Docs');
                await (engine as any).handleLocalFileChange('Docs/doc.txt');

                expect(drive.nodes.get('vol~Docs/doc.txt')?.content).toBe('old');
                expect(drive.calls.uploads).not.toContain('Docs/doc.txt');
                expect(conflictNames(drive.nodes, drive.nameOf, 'vol~Docs').length).toBe(1);
            });

            // #23: a sync pass whose listing of the folder came before another device uploaded a file of that name used
            // to upload over that file, as the API's same-name refusal turned the upload into a new revision of it.
            // `appear` puts the cloud file there as the pass starts uploading (its listing is older).
            const appearsAsItUploads = (sdk: ProtonDriveClient, name: string, appear: () => void) => {
                const getFileUploader = (sdk as any).getFileUploader.bind(sdk);
                let appeared = false;
                (sdk as any).getFileUploader = async (parent: unknown, uploading: string, ...rest: unknown[]) => {
                    if (!appeared && uploading === name) {
                        appeared = true;
                        appear();
                    }
                    return getFileUploader(parent, uploading, ...rest);
                };
            };
            const pinnedDocs = async (d: ReturnType<typeof setup>) => {
                d.add('Docs/keep.txt', 'k');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs', 'pin');
                await d.engine.reconcileNow();
            };

            for (const strategy of ['keep-both', 'prompt'] as const) {
                test(`found by a pass's upload, after its listing, it meets the conflict handling (${strategy}), never a new revision`, async () => {
                    stateDb.updateSettings({ conflictStrategy: strategy });
                    const d = setup();
                    await pinnedDocs(d);
                    await d.files.writeLocal('Docs/late.txt', 'mine');
                    appearsAsItUploads(d.sdk, 'late.txt', () => d.add('Docs/late.txt', 'theirs'));

                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(d.nodes.get('vol~Docs/late.txt')?.content).toBe('theirs');
                    expect(d.calls.uploads).not.toContain('Docs/late.txt');
                    const copies = conflictNames(d.nodes, d.nameOf, 'vol~Docs');
                    if (strategy === 'keep-both') {
                        // Both kept: theirs at the name, mine as a conflict copy, here and in Proton Drive
                        expect(copies.length).toBe(1);
                        expect(d.named('vol~Docs', copies[0]!)[0]?.content).toBe('mine');
                        expect(await readFile(d.local('Docs/late.txt'), 'utf8')).toBe('theirs');
                        expect(await readFile(d.local(`Docs/${copies[0]}`), 'utf8')).toBe('mine');
                    } else {
                        expect(copies).toEqual([]);
                        expect(stateDb.listConflicts().map((c) => c.localRelPath)).toContain('Docs/late.txt');
                        expect(await readFile(d.local('Docs/late.txt'), 'utf8')).toBe('mine');
                    }
                    expect(d.calls.trashed).toEqual([]);
                });
            }

            test("found by a pass's upload in the plain layout too", async () => {
                const drive = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger);
                const files = localFiles(stateDb);
                drive.add('Docs/keep.txt', 'k');
                await engine.reconcileNow();
                await files.writeLocal('Docs/late.txt', 'mine');
                appearsAsItUploads(drive.sdk, 'late.txt', () => drive.add('Docs/late.txt', 'theirs'));

                await engine.reconcileNow();

                expect(drive.nodes.get('vol~Docs/late.txt')?.content).toBe('theirs');
                expect(drive.calls.uploads).not.toContain('Docs/late.txt');
                expect(conflictNames(drive.nodes, drive.nameOf, 'vol~Docs').length).toBe(1);
            });

            // Recorded meanwhile (uploaded from here by the watcher while the pass waited, or the other way round), the
            // file the refusal names is the recorded file: a later change to it is an edit, not a conflict
            for (const via of ['a pass', 'the watcher'] as const) {
                test(`found by ${via}'s upload, a file recorded meanwhile at that name takes the change as an edit of it`, async () => {
                    stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                    const d = setup();
                    await pinnedDocs(d);
                    await d.files.writeLocal('Docs/late.txt', 'v2');
                    appearsAsItUploads(d.sdk, 'late.txt', () => {
                        const sha1 = d.add('Docs/late.txt', 'v1').activeRevision!.claimedDigests!.sha1!;
                        stateDb.upsertItem({
                            localRelPath: 'Docs/late.txt',
                            nodeUid: 'vol~Docs/late.txt',
                            parentNodeUid: 'vol~Docs',
                            type: 'file',
                            localSha1: sha1,
                            remoteSha1: sha1,
                            localMtimeMs: 0,
                            remoteMtimeMs: 0,
                            size: 2,
                            syncStatus: 'synced',
                            lastError: null,
                        });
                    });

                    if (via === 'a pass') {
                        await d.engine.reconcileNow();
                    } else {
                        await (d.engine as any).handleLocalFileChange('Docs/late.txt');
                    }

                    expect(d.nodes.get('vol~Docs/late.txt')?.content).toBe('v2');
                    expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs')).toEqual([]);
                    expect(await readFile(d.local('Docs/late.txt'), 'utf8')).toBe('v2');
                });
            }

            // A file whose name the upload was refused for, but that is trashed or gone by the time it is read, holds
            // nothing at that name: never a conflict with it, or a download of it
            for (const via of ['a pass', 'the watcher'] as const) {
                for (const how of ['trashed', 'deleted'] as const) {
                    test(`found by ${via}'s upload but ${how} when read, a cloud file is no conflict: the local file uploads as new`, async () => {
                        stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                        const d = setup();
                        await pinnedDocs(d);
                        await d.files.writeLocal('Docs/late.txt', 'mine');
                        appearsAsItUploads(d.sdk, 'late.txt', () => d.add('Docs/late.txt', 'theirs'));
                        const getNode = d.sdk.getNode.bind(d.sdk);
                        let gone: NodeEntity | null = null;
                        (d.sdk as any).getNode = async (uid: string) => {
                            if (uid !== 'vol~Docs/late.txt') {
                                return getNode(uid);
                            }
                            if (!gone) {
                                // Read once as it refused the name, then out of the folder
                                gone = d.nodes.get(uid)!;
                                d.nodes.delete(uid);
                                return gone;
                            }
                            if (how === 'deleted') {
                                throw new ValidationError('Item not found');
                            }
                            return { ...gone, trashTime: new Date() };
                        };

                        if (via === 'a pass') {
                            await d.engine.reconcileNow();
                        } else {
                            await (d.engine as any).handleLocalFileChange('Docs/late.txt');
                        }

                        const record = stateDb.getItemByPath('Docs/late.txt');
                        expect(record?.nodeUid).toStartWith('vol~uploaded');
                        expect(d.nodes.get(record!.nodeUid)?.content).toBe('mine');
                        expect(await readFile(d.local('Docs/late.txt'), 'utf8')).toBe('mine');
                        expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs')).toEqual([]);
                        expect(d.calls.downloads).toEqual(['Docs/keep.txt']);
                    });
                }
            }

            // A conflict copy is a new file too: never uploaded over a cloud file that already has its name
            for (const when of ['by a pass (keep-both)', 'by hand (keep both)'] as const) {
                test(`a conflict copy whose name Proton Drive already has takes the next free name, made ${when}`, async () => {
                    stateDb.updateSettings({ conflictStrategy: when === 'by hand (keep both)' ? 'prompt' : 'keep-both' });
                    const d = setup();
                    d.add('Docs/doc.txt', 'old');
                    await d.engine.reconcileNow();
                    await d.files.writeLocal('Docs/doc.txt', 'mine');
                    let taken = '';
                    const getFileUploader = (d.sdk as any).getFileUploader.bind(d.sdk);
                    (d.sdk as any).getFileUploader = async (parent: unknown, name: string, ...rest: unknown[]) => {
                        if (!taken && name.startsWith('doc (conflict ')) {
                            taken = name;
                            d.add(`Docs/${name}`, 'another device'); // made by another device with the same name
                        }
                        return getFileUploader(parent, name, ...rest);
                    };

                    await d.engine.reconcileNow();
                    if (when === 'by hand (keep both)') {
                        await d.engine.resolveConflictManually(stateDb.listConflicts()[0]!.id, 'keep-both');
                    }

                    expect(taken).not.toBe('');
                    const next = taken.replace(/\.txt$/, '-1.txt');
                    expect(d.named('vol~Docs', taken).map((n) => n.content)).toEqual(['another device']);
                    expect(d.named('vol~Docs', next).map((n) => n.content)).toEqual(['mine']);
                    expect(await readFile(d.local(`Docs/${next}`), 'utf8')).toBe('mine');
                    expect(await d.files.exists(`Docs/${taken}`)).toBe(false);
                    expect(stateDb.getItemByPath(`Docs/${next}`)?.nodeUid).toBe(d.named('vol~Docs', next)[0]!.uid);
                    expect(stateDb.listConflicts(true).map((c) => c.conflictCopyPath)).toEqual([`Docs/${next}`]);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('old');
                });
            }

            test('a pass still uploads an edit of a recorded file as a new revision of it', async () => {
                const d = setup();
                await pinnedDocs(d);
                await writeFile(d.local('Docs/keep.txt'), 'edited');

                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~Docs/keep.txt')?.content).toBe('edited');
                expect(d.calls.uploads).toEqual(['Docs/keep.txt']);
                expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs')).toEqual([]);
            });

            // A file with an edit baseline (made from an online-only file through the drive) whose cloud file the pass
            // didn't list: the file found by the upload is judged by the baseline, as when listed
            for (const found of ['the one the drive showed, moved back', 'a new one from another device'] as const) {
                test(`with an edit baseline, the file a pass's upload finds after its listing is judged by it (${found})`, async () => {
                    stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                    const d = setup();
                    d.add('Docs/doc.txt', 'old');
                    d.add('Docs/other.txt', 'o');
                    await d.engine.reconcileNow();
                    await d.engine.truncateItem('Docs/doc.txt');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    const shown = d.nodes.get('vol~Docs/doc.txt')!;
                    if (found === 'a new one from another device') {
                        d.nodes.delete(shown.uid);
                        appearsAsItUploads(d.sdk, 'doc.txt', () =>
                            d.nodes.set(
                                'vol~theirs',
                                makeMockNode({ uid: 'vol~theirs', parentUid: 'vol~Docs', nameStr: 'doc.txt', type: NodeType.File, content: 'theirs' }),
                            ),
                        );
                    } else {
                        d.nodes.set(shown.uid, { ...shown, parentUid: d.root.uid }); // moved out, and back once listed
                        appearsAsItUploads(d.sdk, 'doc.txt', () => d.nodes.set(shown.uid, shown));
                    }

                    await d.engine.reconcileNow();

                    if (found === 'a new one from another device') {
                        expect(d.nodes.get('vol~theirs')?.content).toBe('theirs');
                        expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                        const copies = conflictNames(d.nodes, d.nameOf, 'vol~Docs');
                        expect(copies.length).toBe(1);
                        expect(d.named('vol~Docs', copies[0]!)[0]?.content).toBe('mine');
                    } else {
                        expect(d.nodes.get(shown.uid)?.content).toBe('mine'); // a new revision of it
                        expect(d.calls.uploads).toEqual(['Docs/doc.txt']);
                        expect(conflictNames(d.nodes, d.nameOf, 'vol~Docs')).toEqual([]);
                    }
                    expect(d.calls.trashed).toEqual([]);
                });
            }
        });

        // S22: Move to Trash through the drive keeps what exists only on this computer, as a cloud delete does (#16)
        describe('a delete through the drive that is a Move to Trash', () => {
            const withDesktopTrash = () => {
                stateDb.setMeta('driveLayout', 'virtual');
                const drive = makeMockDrive();
                const backingDir = path.join(tempDir, 'files');
                const desktopTrash = path.join(tempDir, 'desktop-trash');
                const handed: string[] = [];
                // Stands in for gio trash: never the real one in tests
                const moveToDesktopTrash = async (fullPath: string) => {
                    handed.push(path.relative(backingDir, fullPath));
                    await mkdir(desktopTrash, { recursive: true });
                    await rename(fullPath, path.join(desktopTrash, path.basename(fullPath)));
                    return true;
                };
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    backingDir,
                    moveToDesktopTrash,
                });
                return { ...drive, engine, handed, desktopTrash, local: (rel: string) => path.join(backingDir, rel), files: localFiles(stateDb, () => backingDir) };
            };

            test('content only on this computer goes to the desktop Trash, synced content goes, and the cloud copy goes to its trash', async () => {
                const d = withDesktopTrash();
                d.add('Folder/a.txt', 'a');
                d.add('Folder/edited.txt', 'e');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Folder', 'pin');
                await d.engine.reconcileNow();
                await writeFile(d.local('Folder/new.txt'), 'never uploaded');
                await writeFile(d.local('Folder/edited.txt'), 'changed since');

                await d.engine.deleteItem('Folder', { trash: true });

                expect(d.handed.sort()).toEqual(['Folder/edited.txt', 'Folder/new.txt']);
                expect(await readFile(path.join(d.desktopTrash, 'new.txt'), 'utf8')).toBe('never uploaded');
                expect(await readFile(path.join(d.desktopTrash, 'edited.txt'), 'utf8')).toBe('changed since');
                expect(await d.files.exists('Folder')).toBe(false);
                expect(d.files.recordCount('Folder')).toBe(0);
                expect(stateDb.listActivity(5).map((a) => a.details).join('\n')).toContain('moved to your Trash');
                await d.engine.replayRemoteOps();
                expect(d.calls.trashed).toEqual([['vol~Folder']]);
            });

            test('a plain delete still removes everything, as the user asked', async () => {
                const d = withDesktopTrash();
                d.add('Folder/a.txt', 'a');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Folder', 'pin');
                await d.engine.reconcileNow();
                await writeFile(d.local('Folder/new.txt'), 'never uploaded');

                await d.engine.deleteItem('Folder');

                expect(d.handed).toEqual([]);
                expect(await d.files.exists('Folder')).toBe(false);
            });
        });

        describe('drive operation errors', () => {
            test('renameItem with noReplace refuses an existing target (EEXIST), here or only in Proton Drive, and changes nothing', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/online.txt', 'o');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/a.txt', 'pin');
                await d.files.writeLocal('Docs/local.txt', 'l');

                for (const [from, to] of [
                    ['Docs/a.txt', 'Docs/local.txt'],
                    ['Docs/a.txt', 'Docs/online.txt'],
                    ['Docs/online.txt', 'Docs/local.txt'],
                ] as const) {
                    expect(await failure(d.engine.renameItem(from, to, { noReplace: true }))).toEqual({
                        code: 'EEXIST',
                        message: `Already exists: ${to}`,
                        driveOpError: true,
                    });
                }
                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
                expect(await readFile(d.local('Docs/local.txt'), 'utf8')).toBe('l');
                expect(stateDb.getItemByPath('Docs/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
                expect(d.engine.remoteIndex.getByPath('Docs/online.txt')?.uid).toBe('vol~Docs/online.txt');
                expect(d.journal()).toEqual([]);

                // Nothing in the way: renamed as usual
                await d.engine.renameItem('Docs/a.txt', 'Docs/c.txt', { noReplace: true });
                expect(await readFile(d.local('Docs/c.txt'), 'utf8')).toBe('a');
                // Without noReplace a file still replaces another
                await d.engine.renameItem('Docs/c.txt', 'Docs/local.txt');
                expect(await readFile(d.local('Docs/local.txt'), 'utf8')).toBe('a');
            });

            test('an online-only file renamed over an existing file is refused with EXDEV (mv then copies it), and nothing changes', async () => {
                const d = setup();
                d.add('Docs/online.txt', 'o');
                d.add('Docs/other.txt', 'x');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/local.txt', 'l');

                expect(await failure(d.engine.renameItem('Docs/online.txt', 'Docs/local.txt'))).toMatchObject({
                    code: 'EXDEV',
                    driveOpError: true,
                });
                expect(await failure(d.engine.renameItem('Docs/online.txt', 'Docs/other.txt'))).toMatchObject({
                    code: 'EXDEV',
                    driveOpError: true,
                });

                expect(await readFile(d.local('Docs/local.txt'), 'utf8')).toBe('l');
                expect(d.engine.remoteIndex.getByPath('Docs/online.txt')?.uid).toBe('vol~Docs/online.txt');
                expect(d.engine.remoteIndex.getByPath('Docs/other.txt')?.uid).toBe('vol~Docs/other.txt');
                expect(stateDb.getItemByPath('Docs/other.txt')).toBeNull();
                expect(d.journal()).toEqual([]);
                await d.engine.replayRemoteOps();
                await d.engine.reconcileNow();
                expect(d.calls.renamed).toEqual([]);
                expect(d.calls.moved).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.downloads).toEqual([]);
            });

            test('drive operations fail with errno codes: ENOENT for an unknown path, EACCES for a hidden one, EEXIST for a folder in the way', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/Sub/b.txt', 'b');
                d.add('Private/s.txt', 's');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/a.txt', 'pin');
                await d.engine.setAvailability('Private', 'hide');
                const expectCode = async (p: Promise<unknown>, code: string, message: string) =>
                    expect(await failure(p)).toEqual({ code, message, driveOpError: true });

                await expectCode(d.engine.renameItem('Docs/nope.txt', 'Docs/x.txt'), 'ENOENT', 'Not found: Docs/nope.txt');
                await expectCode(d.engine.renameItem('Docs/a.txt', 'Nowhere/a.txt'), 'ENOENT', 'Not found: Nowhere');
                await expectCode(d.engine.deleteItem('Docs/nope.txt'), 'ENOENT', 'Not found: Docs/nope.txt');
                await expectCode(d.engine.renameItem('Private/s.txt', 'Docs/s.txt'), 'EACCES', 'Hidden: Private/s.txt');
                await expectCode(d.engine.renameItem('Docs/a.txt', 'Private/a.txt'), 'EACCES', 'Hidden: Private/a.txt');
                await expectCode(d.engine.deleteItem('Private'), 'EACCES', 'Hidden: Private');
                await expectCode(d.engine.renameItem('Docs/a.txt', 'Docs/Sub'), 'EEXIST', 'Already exists: Docs/Sub');
                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
                expect(d.journal()).toEqual([]);
            });
        });

        // #22: the pending rename of a.txt, taken along to Work/a2.txt by the rename of its folder, used to be shown first,
        // in a folder made up for the name Work, which then kept the folder itself (and all else in it) at Docs
        describe('a folder renamed right after a rename in it', () => {
            // Docs holds a.txt, b.txt and c.txt on this computer with no records (as the issue found them) and online-only
            // d.txt and e.txt. a.txt is renamed, then Docs, while the first rename is on its way to Proton Drive (held as
            // the cloud renames it, or as the replay reads it back after), or offline.
            type When = 'as the cloud renames it' | 'as it is read back' | 'offline';
            const renamedTwice = async (when: When) => {
                const d = setup({ slashFreeUids: true });
                for (const name of ['a', 'b', 'c', 'd', 'e']) {
                    d.add(`Docs/${name}.txt`, name);
                }
                await d.engine.reconcileNow();
                for (const name of ['a', 'b', 'c']) {
                    await d.files.writeLocal(`Docs/${name}.txt`, name);
                }
                let release = () => {};
                let inFlight = Promise.resolve();
                if (when === 'offline') {
                    d.down.add('renameNode');
                } else {
                    const sdk = d.sdk as any;
                    const method = when === 'as the cloud renames it' ? 'renameNode' : 'getNode';
                    const real = sdk[method].bind(sdk);
                    const answer = new Promise<void>((resolve) => (release = resolve));
                    let entered!: () => void;
                    inFlight = new Promise<void>((resolve) => (entered = resolve));
                    let calls = 0;
                    sdk[method] = async (uid: string, ...rest: unknown[]) => {
                        // The replay reads the item before renaming it, and again after
                        if (uid === d.uid('Docs/a.txt') && ++calls === (method === 'getNode' ? 2 : 1)) {
                            entered();
                            await answer;
                        }
                        return real(uid, ...rest);
                    };
                }
                await d.engine.renameItem('Docs/a.txt', 'Docs/a2.txt');
                await inFlight;
                await d.engine.renameItem('Docs', 'Work');
                return {
                    ...d,
                    backOnline: async () => {
                        release();
                        d.down.clear();
                        await d.engine.replayRemoteOps();
                    },
                };
            };
            const cloudNamesInDocs = (d: ReturnType<typeof setup>) =>
                [...d.nodes.values()].filter((n) => n.parentUid === d.uid('Docs')).map((n) => d.nameOf(n)).sort();

            for (const when of ['as the cloud renames it', 'as it is read back', 'offline'] as const) {
                test(`all of the folder is at the new path at once (first rename held ${when}), and a delete there trashes the item in Proton Drive`, async () => {
                    const d = await renamedTwice(when);

                    const index = d.engine.remoteIndex;
                    expect(index.getByPath('Work')?.uid).toBe(d.uid('Docs'));
                    expect(index.listChildren('Work').map((e) => [e.name, e.uid])).toEqual([
                        ['a2.txt', d.uid('Docs/a.txt')],
                        ['b.txt', d.uid('Docs/b.txt')],
                        ['c.txt', d.uid('Docs/c.txt')],
                        ['d.txt', d.uid('Docs/d.txt')],
                        ['e.txt', d.uid('Docs/e.txt')],
                    ]);
                    expect(index.getByPath('Docs')).toBeNull();
                    expect(index.uidsWithPrefix('provisional:')).toEqual([]);
                    // Listings show the new paths only
                    expect(d.engine.vfsChildren('').map((e) => e.name)).toEqual(['Work']);
                    expect(d.engine.vfsChildren('Work').map((e) => e.name)).toEqual(['a2.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
                    expect(d.engine.vfsChildren('Docs')).toEqual([]);

                    await d.engine.deleteItem('Work/c.txt');

                    expect(await d.files.exists('Work/c.txt')).toBe(false);
                    expect(d.journal().filter((op) => op.kind === 'trash')).toMatchObject([{ nodeUid: d.uid('Docs/c.txt') }]);
                    await d.backOnline();
                    expect(d.journal()).toEqual([]);
                    expect(d.calls.trashed).toEqual([[d.uid('Docs/c.txt')]]);
                    expect(d.nameOf(d.nodes.get(d.uid('Docs'))!)).toBe('Work');
                    expect(cloudNamesInDocs(d)).toEqual(['a2.txt', 'b.txt', 'd.txt', 'e.txt']);
                    // Then this computer and Proton Drive agree: nothing uploads, and c.txt doesn't come back
                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual([]);
                    expect(d.calls.trashed).toEqual([[d.uid('Docs/c.txt')]]);
                    expect(index.getByPath('Work/c.txt')).toBeNull();
                    expect(await d.files.exists('Work/c.txt')).toBe(false);
                    expect(await readFile(d.local('Work/a2.txt'), 'utf8')).toBe('a');
                    expect(stateDb.getItemByPath('Work/b.txt')?.nodeUid).toBe(d.uid('Docs/b.txt'));
                });
            }

            test('a rename meanwhile finds an online-only source, and an online-only target in the way, at the new path', async () => {
                const d = await renamedTwice('as the cloud renames it');

                expect(await failure(d.engine.renameItem('Work/a2.txt', 'Work/e.txt', { noReplace: true }))).toEqual({
                    code: 'EEXIST',
                    message: 'Already exists: Work/e.txt',
                    driveOpError: true,
                });
                await d.engine.renameItem('Work/d.txt', 'Work/d2.txt');

                expect(d.engine.vfsChildren('Work').map((e) => e.name)).toEqual(['a2.txt', 'b.txt', 'c.txt', 'd2.txt', 'e.txt']);
                await d.backOnline();
                expect(d.journal()).toEqual([]);
                expect(cloudNamesInDocs(d)).toEqual(['a2.txt', 'b.txt', 'c.txt', 'd2.txt', 'e.txt']);
                expect(d.nameOf(d.nodes.get(d.uid('Docs/d.txt'))!)).toBe('d2.txt');
                expect(await readFile(d.local('Work/a2.txt'), 'utf8')).toBe('a');
                expect(d.calls.downloads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
            });

            test('a truncate meanwhile finds the online-only file at the new path, and its new content is an edit of that file', async () => {
                const d = await renamedTwice('as the cloud renames it');

                await d.engine.truncateItem('Work/d.txt');

                expect(await readFile(d.local('Work/d.txt'), 'utf8')).toBe('');
                expect(stateDb.getEditBaseline('Work/d.txt')?.nodeUid).toBe(d.uid('Docs/d.txt'));
                await writeFile(d.local('Work/d.txt'), 'mine');
                await d.backOnline();
                await d.engine.reconcileNow();
                expect(d.nodes.get(d.uid('Docs/d.txt'))?.content).toBe('mine');
                expect(d.calls.uploads).toEqual(['Work/d.txt']);
                expect(d.calls.trashed).toEqual([]);
            });

            test('opening an online-only file meanwhile downloads it to the new path', async () => {
                const d = await renamedTwice('as the cloud renames it');

                await d.engine.hydrate('Work/e.txt');

                expect(await readFile(d.local('Work/e.txt'), 'utf8')).toBe('e');
                expect(stateDb.getItemByPath('Work/e.txt')?.nodeUid).toBe(d.uid('Docs/e.txt'));
                expect(d.calls.downloads).toEqual(['Docs/e.txt']);
                await d.backOnline();
                await d.engine.reconcileNow();
                expect(await readFile(d.local('Work/e.txt'), 'utf8')).toBe('e');
                expect(d.calls.downloads).toEqual(['Docs/e.txt']);
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
            });

            // Deletes are shown first: here the name Work, freed by one, is what the renamed folder takes
            test('a folder deleted before another is renamed to its name is not where that one goes, even once a listing puts it back', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                d.add('Work/x.txt', 'x');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/a.txt', 'a');
                d.down.add('renameNode');
                d.down.add('trashNodes');

                await d.engine.renameItem('Docs/a.txt', 'Docs/a2.txt');
                await d.engine.deleteItem('Work');
                await d.engine.renameItem('Docs', 'Work');
                await d.engine.reconcileNow(); // lists the old Work, which Proton Drive still has, at its name

                const index = d.engine.remoteIndex;
                expect(index.getByPath('Work')?.uid).toBe(d.uid('Docs'));
                expect(index.listChildren('Work').map((e) => e.uid)).toEqual([d.uid('Docs/a.txt'), d.uid('Docs/b.txt')]);
                expect(index.getByUid(d.uid('Work'))).toBeNull();
                expect(d.engine.vfsChildren('Work').map((e) => e.name)).toEqual(['a2.txt', 'b.txt']);
                d.down.clear();
                await d.engine.replayRemoteOps();
                expect(d.journal()).toEqual([]);
                expect(d.calls.trashed).toEqual([[d.uid('Work')]]);
                expect(d.nameOf(d.nodes.get(d.uid('Docs'))!)).toBe('Work');
                expect(cloudNamesInDocs(d)).toEqual(['a2.txt', 'b.txt']);
            });
        });

        // S25: every pending move is shown at once, none in another's way, so a name one frees is free for another
        // whatever the order or depth (#26: a swap through a temporary name used to leave both files out of listings).
        // Here and for #22, uids hold no '/', as Proton's don't: the index takes nodes aside by uid while it places them.
        describe('pending moves that free names and take them', () => {
            // Offline, with a sync pass after: its listing puts every item back where Proton Drive still has it
            const offlineThenListed = async (d: ReturnType<typeof setup>, moves: Array<[string, string]>) => {
                await d.engine.reconcileNow();
                d.down.add('moveNodes');
                d.down.add('renameNode');
                for (const [from, to] of moves) {
                    await d.engine.renameItem(from, to);
                }
                await d.engine.reconcileNow();
            };
            const names = (d: ReturnType<typeof setup>, rel: string) => d.engine.vfsChildren(rel).map((e) => e.name);

            for (const variant of ['from another folder', 'in the same folder'] as const) {
                test(`a name freed by a move into a folder, then taken by a move up (${variant}), is the new item's after a listing`, async () => {
                    const d = setup({ slashFreeUids: true });
                    d.add('b.txt', 'B');
                    d.add('X/keep.txt', 'k');
                    const from = variant === 'from another folder' ? 'Y/a.txt' : 'a.txt';
                    const aUid = d.add(from, 'A').uid;

                    await offlineThenListed(d, [
                        ['b.txt', 'X/b.txt'],
                        [from, 'b.txt'],
                    ]);

                    const index = d.engine.remoteIndex;
                    expect(index.getByPath('b.txt')?.uid).toBe(aUid);
                    expect(index.getByPath('X/b.txt')?.uid).toBe(d.uid('b.txt'));
                    expect(names(d, '')).toEqual(variant === 'from another folder' ? ['X', 'Y', 'b.txt'] : ['X', 'b.txt']);
                    expect(names(d, 'X')).toEqual(['b.txt', 'keep.txt']);
                    await d.engine.deleteItem('b.txt');
                    expect(d.journal().filter((op) => op.kind === 'trash')).toMatchObject([{ nodeUid: aUid }]);
                    d.down.clear();
                    await d.engine.replayRemoteOps();
                    expect(d.journal()).toEqual([]);
                    expect(d.calls.trashed).toEqual([[aUid]]);
                    expect(d.nodes.get(d.uid('b.txt'))?.parentUid).toBe(d.uid('X'));
                });
            }

            test('two files swapped through a temporary name keep their swapped names after a listing, and each deletes as itself', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('a.txt', 'A');
                d.add('b.txt', 'B');
                d.add('X/k.txt', 'k');

                await offlineThenListed(d, [
                    ['a.txt', 'tmp.txt'],
                    ['b.txt', 'a.txt'],
                    ['tmp.txt', 'b.txt'],
                ]);

                const index = d.engine.remoteIndex;
                expect(index.getByPath('a.txt')?.uid).toBe(d.uid('b.txt'));
                expect(index.getByPath('b.txt')?.uid).toBe(d.uid('a.txt'));
                expect(index.getByPath('tmp.txt')).toBeNull();
                expect(names(d, '')).toEqual(['X', 'a.txt', 'b.txt']);
                await d.engine.deleteItem('a.txt');
                await d.engine.deleteItem('b.txt');
                expect(d.journal().filter((op) => op.kind === 'trash').map((op) => op.nodeUid)).toEqual([d.uid('b.txt'), d.uid('a.txt')]);
                d.down.clear();
                await d.engine.replayRemoteOps();
                expect(d.journal()).toEqual([]);
                expect(d.calls.trashed).toEqual([[d.uid('b.txt')], [d.uid('a.txt')]]);
                expect(d.calls.renamed).toEqual([]);
            });

            test('three files rotated through a temporary name each show, and open, as the file now at that name', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('a.txt', 'A');
                d.add('b.txt', 'B');
                d.add('c.txt', 'C');

                await offlineThenListed(d, [
                    ['a.txt', 'tmp.txt'],
                    ['b.txt', 'a.txt'],
                    ['c.txt', 'b.txt'],
                    ['tmp.txt', 'c.txt'],
                ]);

                const index = d.engine.remoteIndex;
                expect(['a.txt', 'b.txt', 'c.txt'].map((p) => index.getByPath(p)?.uid)).toEqual([d.uid('b.txt'), d.uid('c.txt'), d.uid('a.txt')]);
                expect(names(d, '')).toEqual(['a.txt', 'b.txt', 'c.txt']);
                await d.engine.hydrate('c.txt');
                expect(await readFile(d.local('c.txt'), 'utf8')).toBe('A');
                expect(stateDb.getItemByPath('c.txt')?.nodeUid).toBe(d.uid('a.txt'));
            });

            test('an item whose new name another device took meanwhile does not keep a file renamed to its old name out of listings', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('a.txt', 'A');
                d.add('b.txt', 'B');
                await d.engine.reconcileNow();
                d.down.add('renameNode');
                await d.engine.renameItem('a.txt', 'x.txt');
                await d.engine.renameItem('b.txt', 'a.txt');
                d.add('x.txt', 'X'); // another device, before the renames reach Proton Drive
                await d.engine.reconcileNow();

                const index = d.engine.remoteIndex;
                expect(index.getByPath('a.txt')?.uid).toBe(d.uid('b.txt'));
                expect(index.getByPath('x.txt')?.uid).toBe(d.uid('x.txt'));
                expect(names(d, '')).toEqual(['a.txt', 'x.txt']);
                d.down.clear();
                await d.engine.replayRemoteOps();
                expect(d.journal()).toEqual([]);
                expect(d.nameOf(d.nodes.get(d.uid('b.txt'))!)).toBe('a.txt');
                expect(d.nameOf(d.nodes.get(d.uid('a.txt'))!)).toStartWith('x (conflict ');
                expect(d.nodes.get(d.uid('x.txt'))?.content).toBe('X');
                expect(names(d, '').length).toBe(3);
                expect(d.calls.trashed).toEqual([]);
            });

            // #28: the delete used to trash the hidden item too, as its pending rename goes to that name
            test('deleting a file another device put where a pending rename goes trashes that file only', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('a.txt', 'A');
                await d.engine.reconcileNow();
                d.down.add('renameNode');
                await d.engine.renameItem('a.txt', 'x.txt');
                d.add('x.txt', 'X'); // another device, before the rename reaches Proton Drive
                await d.engine.reconcileNow();
                expect(d.engine.remoteIndex.getByPath('x.txt')?.uid).toBe(d.uid('x.txt'));

                await d.engine.deleteItem('x.txt');

                expect(d.journal().filter((op) => op.kind === 'trash').map((op) => op.nodeUid)).toEqual([d.uid('x.txt')]);
                d.down.clear();
                await d.engine.replayRemoteOps();
                expect(d.journal()).toEqual([]);
                expect(d.calls.trashed).toEqual([[d.uid('x.txt')]]);
                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('A'); // its rename lands as it can (#27)
            });

            // What was moved into a deleted folder is deleted with it, though Proton Drive doesn't have it in there yet
            test('deleting a folder made here that an online-only file was moved into trashes that file', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('Docs/a.txt', 'a');
                await d.engine.reconcileNow();
                await mkdir(d.local('New'));
                d.down.add('getNode'); // the move waits
                await d.engine.renameItem('Docs/a.txt', 'New/a.txt');

                await d.engine.deleteItem('New');

                expect(d.journal().filter((op) => op.kind === 'trash').map((op) => op.nodeUid)).toEqual([d.uid('Docs/a.txt')]);
                d.down.clear();
                await d.engine.replayRemoteOps();
                expect(d.journal()).toEqual([]);
                expect(d.calls.trashed).toEqual([[d.uid('Docs/a.txt')]]);
                expect(d.calls.moved).toEqual([]);
                expect(d.named(d.root.uid, 'New')).toEqual([]);
            });

            // Its folder's new name taken in the cloud too, a renamed file goes back into the folder where it was, both
            // where Proton Drive still has them (deep enough that the path of what was in a folder is no deeper)
            test('a renamed folder and a renamed file in it, both with their names taken in the cloud, stay where they were', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('a/b/c/keep.txt', 'k');
                d.add('a/b/c/P/c.txt', 'C');
                d.add('a/b/c/P/d.txt', 'D');
                await d.engine.reconcileNow();
                await d.files.writeLocal('a/b/c/P/c.txt', 'C');
                d.down.add('renameNode');
                await d.engine.renameItem('a/b/c/P', 'a/b/c/Q');
                await d.engine.renameItem('a/b/c/Q/c.txt', 'a/b/c/Q/c2.txt');
                d.add('a/b/c/Q', 'a file from another device');

                await d.engine.reconcileNow();

                const index = d.engine.remoteIndex;
                expect(index.getByUid(d.uid('a/b/c/P'))?.relPath).toBe('a/b/c/P');
                expect(index.getByUid(d.uid('a/b/c/P/c.txt'))?.parentUid).toBe(d.uid('a/b/c/P'));
                expect(index.getByUid(d.uid('a/b/c/P/c.txt'))?.relPath).toStartWith('a/b/c/P/');
                expect(index.getByUid(d.uid('a/b/c/P/d.txt'))?.relPath).toBe('a/b/c/P/d.txt');
                expect(index.getByPath('a/b/c/Q')?.uid).toBe(d.uid('a/b/c/Q'));
                expect(names(d, 'a/b/c')).toEqual(['Q', 'keep.txt']);
            });

            // An older version showed the first rename of #22 in a provisional folder made up for Work, which then kept
            // the renamed folder at Docs: the next change through the drive puts the folder in that stand-in's place
            test('a provisional folder left where a renamed folder goes gives way to it', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                d.add('other.txt', 'o');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/a.txt', 'a');
                d.down.add('renameNode');
                await d.engine.renameItem('Docs/a.txt', 'Docs/a2.txt');
                await d.engine.renameItem('Docs', 'Work');
                const index = d.engine.remoteIndex;
                const stale = 'provisional:left-by-an-older-version';
                index.upsert({ ...index.getByPath('Work')!, relPath: 'Docs', name: 'Docs' });
                index.upsert({ uid: stale, parentUid: d.root.uid, relPath: 'Work', name: 'Work', type: 'folder', size: 0, mtimeMs: 0, sha1: null });
                index.upsert({ ...index.getByUid(d.uid('Docs/a.txt'))!, parentUid: stale, relPath: 'Work/a2.txt' });

                await d.engine.deleteItem('other.txt');

                expect(index.getByPath('Work')?.uid).toBe(d.uid('Docs'));
                expect(index.listChildren('Work').map((e) => e.uid)).toEqual([d.uid('Docs/a.txt'), d.uid('Docs/b.txt')]);
                expect(index.getByUid(stale)).toBeNull();
                expect(index.getByPath('Docs')).toBeNull();
            });

            test('a folder deleted after a file was moved out of it trashes only the folder, and the file stays where it went', async () => {
                const d = setup({ slashFreeUids: true });
                d.add('F/c.txt', 'C');
                d.add('F/d.txt', 'D');
                d.add('G/g.txt', 'g');
                await d.engine.reconcileNow();
                d.down.add('moveNodes');
                d.down.add('trashNodes');

                await d.engine.renameItem('F/c.txt', 'G/c.txt');
                await d.engine.deleteItem('F');
                await d.engine.reconcileNow();

                const index = d.engine.remoteIndex;
                expect(index.getByPath('G/c.txt')?.uid).toBe(d.uid('F/c.txt'));
                expect(index.getByPath('F')).toBeNull();
                expect(names(d, '')).toEqual(['G']);
                expect(names(d, 'G')).toEqual(['c.txt', 'g.txt']);
                d.down.clear();
                await d.engine.replayRemoteOps();
                expect(d.journal()).toEqual([]);
                expect(d.calls.trashed).toEqual([[d.uid('F')]]);
                expect(d.nodes.get(d.uid('F/c.txt'))?.parentUid).toBe(d.uid('G'));
            });
        });
    });
});
