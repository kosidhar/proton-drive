import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
import * as fileOpsModule from '../src/sdk/fileOps';
import { computeLocalFileSha1, detectMediaType, THIRD_PARTY_DISCLOSURE } from '../src/sdk/fileOps';
import { PIN_ROOT_ON_FIRST_SYNC } from '../src/sync/availabilityMigration';
import { entryFromNode } from '../src/sync/remoteIndex';
import { startControlServer } from '../src/daemon/controlServer';
import { createLocalConflictCopy, formatConflictFileName } from '../src/sync/conflictResolver';
import { DriveOpError } from '../src/sync/driveOps';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import {
    type AvailabilityResult,
    FILES_HOLD,
    filesMissingMessage,
    LOCAL_MOVE_IN_PROGRESS,
    missingPlace,
    ProtonDriveSyncEngine,
} from '../src/sync/syncEngine';
import { LAYOUT_MOVING } from '../src/sync/layoutMigration';
import { RemoteOpsJournal } from '../src/sync/remoteOps';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { APICodeError, APIHTTPError } from '@protontech/drive-sdk/internal/apiService/errors';
import { localFiles } from './helpers/localFiles';
import { makeMockDrive } from './helpers/mockDrive';
import { makeMockNode } from './helpers/mockNodes';
import { uploadAtOnce } from './helpers/engineOptions';

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
            mockLogger, uploadAtOnce,
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
            const engine = new ProtonDriveSyncEngine(mockSdk, mockEventsManager, { isLoggedIn: () => true }, stateDb, logger, uploadAtOnce);
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
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
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
            expect(engine.availability.stateOf('A')).toBe('partial'); // A/B/C/f.txt is here, the rest isn't (#183)
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
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
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
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
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
            expect(await stateOf('')).toBe('partial'); // Docs is here, Other isn't (#183)
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
            expect(engine.availability.stateOf('Docs')).toBe('partial'); // a.txt here, b.txt not (#183)
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
            // Three files stayed: the folder is partly here (#183)
            expect(shown.state).toBe('partial');
            expect(engine.availability.stateOf('Docs')).toBe('partial');
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

        test('unhide drops records whose files are gone, re-reads the cloud folder and leaves the rest as it is', async () => {
            const { engine, add, nodes, calls } = await downloaded({ 'Docs/a.txt': 'a', 'Docs/b.txt': 'b' }, 'vol~root');
            // Hidden by a run that stopped before removing anything (a crash, say): local copies and records are still here
            engine.availability.setHide('vol~Docs', 'hidden');
            await rm(local('Docs/a.txt')); // deleted while hidden, so never taken to the cloud
            add('Docs/c.txt', 'c'); // arrives in the cloud while hidden; nothing lists hidden folders
            await engine.reconcileNow();
            expect(engine.remoteIndex.getByPath('Docs/c.txt')).toBeNull();

            const result = await engine.setAvailability('Docs', 'unhide');

            // b.txt is still here, a.txt went and c.txt never came: partly here (#183)
            expect(result).toEqual({ state: 'partial', kept: [], refused: null });
            expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
            expect(stateDb.getItemByPath('Docs/b.txt')).not.toBeNull();
            expect(engine.remoteIndex.getByPath('Docs/c.txt')).not.toBeNull();
            // The deletion while hidden reaches nothing, and online-only holds even under the pinned root
            await engine.reconcileNow();
            expect(calls.trashed).toEqual([]);
            expect(nodes.has('vol~Docs/a.txt')).toBe(true);
            expect(calls.downloads.sort()).toEqual(['Docs/a.txt', 'Docs/b.txt']);
            expect(engine.availability.stateOf('Docs')).toBe('partial'); // nothing more downloads; b.txt stays (#183)
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
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => loggedIn }, stateDb, drive.logger, uploadAtOnce);
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
                ...uploadAtOnce,
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
                ...uploadAtOnce,
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
                ...uploadAtOnce,
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
                    ...uploadAtOnce,
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
        // Engines here look at what is missing afresh every time (filesMissingCacheMs 0), unless a test says otherwise
        const setup = (layout: 'plain' | 'virtual' = 'plain', opts: { cacheMs?: number } = {}) => {
            if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            const backingDir = path.join(tempDir, 'files');
            const localRoot = layout === 'virtual' ? backingDir : stateDb.getSettings().syncDir;
            // A new engine on the same database and drive is what a restart of the daemon gives
            const restart = () =>
                new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    ...uploadAtOnce,
                    backingDir,
                    filesMissingCacheMs: opts.cacheMs ?? 0,
                });
            // The status's root, which a confirmation names: the sync folder, also in the virtual layout (where the files
            // are kept in the backing store)
            const shown = stateDb.getSettings().syncDir;
            // Where the messages say the files are missing from, in the user's terms
            const place = layout === 'virtual' ? "the drive's storage" : shown;
            return { ...drive, engine: restart(), restart, localRoot, shown, place, files: localFiles(stateDb, () => localRoot) };
        };
        // Confirms what the status says is missing, as the app does
        const confirmShown = (d: ReturnType<typeof setup>, engine = d.engine) =>
            engine.confirmFilesMissingDeleted(engine.getStatus().filesMissing!);
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
                expect(engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.place) });
                expect(stateDb.getAllItems()).toHaveLength(records);
                expect(missingWarnings(d)).toHaveLength(1);
                expect(stateDb.listActivity(50).filter((a) => a.details === missing(d.place))).toHaveLength(1);
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
            await expect(d.engine.setAvailability('Docs', 'pin')).rejects.toThrow(missing(d.place));

            expect(d.calls.trashed).toEqual([]);
            expect(stateDb.getAllItems()).toHaveLength(records);
            expect(await readdir(d.localRoot)).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.place) });
        });

        test('the virtual layout with an emptied store trashes nothing, and an open of an online-only file is refused', async () => {
            const d = setup('virtual');
            const records = await synced(d);
            await rm(d.localRoot, { recursive: true, force: true });
            await mkdir(d.localRoot);

            await d.engine.reconcileNow();
            await expect(d.engine.hydrate('Notes/n.txt')).rejects.toMatchObject({ code: 'EIO', message: missing(d.place) });

            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.downloads.filter((p) => p.startsWith('Notes'))).toEqual([]);
            expect(stateDb.getAllItems()).toHaveLength(records);
            expect(await readdir(d.localRoot)).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.place) });
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

        // S39-a, the reviewer's probe: a new file saved into the emptied folder (an app saving into the bare folder of a
        // disk not mounted, or through the drive) used to be uploaded and recorded, which ended the hold, and the next
        // pass trashed everything missing
        for (const layout of ['plain', 'virtual'] as const) {
            test(`${layout}: a new file saved while the files are missing neither ends the hold nor uploads, until they are back`, async () => {
                const d = setup(layout);
                await synced(d);
                const away = path.join(tempDir, 'away');
                await rename(d.localRoot, away);
                await mkdir(d.localRoot);
                await d.engine.reconcileNow();
                expect(d.engine.getStatus().state).toBe('error');

                await writeFile(path.join(d.localRoot, 'New.txt'), 'new');
                await (d.engine as any).handleLocalFileChange('New.txt');
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual([]);
                expect(stateDb.getItemByPath('New.txt')).toBeNull();
                expect(d.engine.getStatus()).toMatchObject({ state: 'error', lastError: missing(d.place) });

                // The originals back (the new file stays beside them): everything goes on, the new file uploads
                for (const name of await readdir(away)) await rename(path.join(away, name), path.join(d.localRoot, name));
                await d.engine.reconcileNow();
                expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual(['New.txt']);
            });
        }

        test('the hold lasts until every original top-level item is back: one back of two still trashes nothing', async () => {
            const d = setup();
            await synced(d);
            const away = path.join(tempDir, 'away');
            await rename(d.localRoot, away);
            await d.engine.reconcileNow();
            await mkdir(d.localRoot);
            await rename(path.join(away, 'Docs'), path.join(d.localRoot, 'Docs'));

            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({
                state: 'error',
                filesMissing: { root: d.shown, names: ['Photos'], items: 2 },
            });

            await rename(path.join(away, 'Photos'), path.join(d.localRoot, 'Photos'));
            await d.engine.reconcileNow();
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
            expect(d.calls.trashed).toEqual([]);
        });

        test('the status says what is missing', async () => {
            const d = setup();
            await synced(d);
            await rm(d.localRoot, { recursive: true });
            await d.engine.reconcileNow();
            // Docs, Docs/a.txt, Docs/b.txt, Photos, Photos/p.jpg
            expect(d.engine.getStatus().filesMissing).toEqual({ root: d.shown, names: ['Docs', 'Photos'], items: 5, message: missing(d.place) });
        });

        test('confirming they were deleted on purpose trashes exactly the missing recorded items, once', async () => {
            const d = setup();
            await synced(d);
            const away = path.join(tempDir, 'away');
            await rename(d.localRoot, away);
            await mkdir(d.localRoot);
            await d.engine.reconcileNow(); // held
            await rename(path.join(away, 'Docs'), path.join(d.localRoot, 'Docs')); // Docs came back, Photos didn't
            await writeFile(path.join(d.localRoot, 'New.txt'), 'new');
            await d.engine.reconcileNow();
            expect(d.engine.getStatus().state).toBe('error');
            expect(d.calls.trashed).toEqual([]);

            expect(await confirmShown(d)).toMatchObject({ root: d.shown, names: ['Photos'], items: 2 });
            await d.engine.holdForMove(); // waits for the pass the confirmation started
            d.engine.releaseHold();

            expect(d.calls.trashed).toEqual([['vol~Photos']]);
            expect(d.nodes.has('vol~Docs/a.txt')).toBe(true);
            expect(d.nodes.has('vol~Notes/n.txt')).toBe(true);
            expect(d.calls.uploads).toEqual(['New.txt']);
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
            expect(stateDb.listActivity(50).some((a) => a.details.includes('deleted on purpose'))).toBe(true);
        });

        test('a confirmation is used up by one pass: files that go missing later are held again', async () => {
            const d = setup();
            await synced(d);
            await rm(path.join(d.localRoot, 'Docs'), { recursive: true });
            await rm(path.join(d.localRoot, 'Photos'), { recursive: true });
            await d.engine.reconcileNow();
            await confirmShown(d);
            await d.engine.holdForMove();
            d.engine.releaseHold();
            expect(d.calls.trashed.flat().sort()).toEqual(['vol~Docs', 'vol~Photos']);

            // Synced again, then gone again
            d.engine.availability.setPin(d.add('Notes').uid, 'pinned', false);
            await d.engine.reconcileNow();
            expect(await d.files.exists('Notes/n.txt')).toBe(true);
            await rm(path.join(d.localRoot, 'Notes'), { recursive: true });
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toHaveLength(2);
            expect(d.engine.getStatus().filesMissing).toMatchObject({ names: ['Notes'] });
        });

        test('confirming with nothing missing is refused, and the last top-level item deleted here is held until confirmed', async () => {
            const d = setup();
            await expect(d.engine.confirmFilesMissingDeleted({ root: d.shown, names: [] })).rejects.toMatchObject({ status: 409 });
            d.add('Only/x.txt', 'x');
            d.engine.availability.setPin(d.add('Only').uid, 'pinned', false);
            await d.engine.reconcileNow();
            await rm(path.join(d.localRoot, 'Only'), { recursive: true });
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);

            await confirmShown(d);
            await d.engine.holdForMove();
            d.engine.releaseHold();
            expect(d.calls.trashed).toEqual([['vol~Only']]);
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

        // #46: the hold ended once every top-level item it waited for was there again, so a restore by copy ended it as
        // soon as the last top-level folder was made, and the next pass trashed what wasn't copied yet. The first pass
        // after a hold now takes nothing missing for a delete: it holds again on whatever recorded item is still missing,
        // at any depth, until it is back or the user confirms it was deleted.
        // Docs (a.txt, b.txt) and Photos (p.jpg, p2.jpg) synced, Notes online-only; a backup of the folder, then it is gone
        const lost = async (d: ReturnType<typeof setup>) => {
            d.add('Photos/p2.jpg', 'p2');
            await synced(d);
            const backup = path.join(tempDir, 'backup');
            await cp(d.localRoot, backup, { recursive: true, preserveTimestamps: true });
            await rm(d.localRoot, { recursive: true, force: true });
            await d.engine.reconcileNow();
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', filesMissing: { names: ['Docs', 'Photos'] } });
            // Copies an item back from the backup, as a file manager or cp does (times kept)
            return async (rel: string, opts: { onlyTheFolder?: boolean } = {}) => {
                const to = path.join(d.localRoot, rel);
                await mkdir(path.dirname(to), { recursive: true });
                if (opts.onlyTheFolder) {
                    await mkdir(to);
                } else {
                    await cp(path.join(backup, rel), to, { recursive: true, preserveTimestamps: true });
                }
            };
        };
        // Some of the files missing, as the status and the messages say it: the one item, or how many
        const someMissing = (d: ReturnType<typeof setup>, names: string[], items: number) =>
            `${names.length === 1 ? `${names[0]} is` : `${items} items are`} missing from ${d.place}. Nothing was deleted in Proton Drive.`;
        const held = (d: ReturnType<typeof setup>, names: string[], items: number) => ({
            state: 'error',
            lastError: someMissing(d, names, items),
            filesMissing: { root: d.shown, names, items, message: someMissing(d, names, items) },
        });

        for (const layout of ['plain', 'virtual'] as const) {
            test(`${layout}: a restore by copy that has made Photos with one of its two files trashes nothing, and holds on the other`, async () => {
                const d = setup(layout);
                const copyBack = await lost(d);
                await copyBack('Docs');
                await copyBack('Photos', { onlyTheFolder: true });
                await copyBack('Photos/p.jpg'); // p2.jpg isn't copied yet

                await d.engine.reconcileNow(); // the timer's next pass
                await d.engine.reconcileNow();

                expect(d.calls.trashed).toEqual([]);
                expect(d.engine.getStatus()).toMatchObject(held(d, ['Photos/p2.jpg'], 1));

                // p2.jpg lands: everything goes on, with nothing uploaded again or trashed
                await copyBack('Photos/p2.jpg');
                await d.engine.reconcileNow();
                expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual([]);
                expect(d.nodes.has('vol~Photos/p2.jpg')).toBe(true);

                // A delete after that is the user's, as ever
                await rm(path.join(d.localRoot, 'Docs/a.txt'));
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
            });
        }

        test('a full restore ends the hold, and the pass after it syncs as usual', async () => {
            const d = setup();
            const copyBack = await lost(d);
            await copyBack('Docs');
            await copyBack('Photos');
            await d.files.writeLocal('Docs/new.txt', 'new');

            await d.engine.reconcileNow();

            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual(['Docs/new.txt']);
            expect(stateDb.getMeta(FILES_HOLD)).toBeNull(); // looked at: the hold is over
            await rm(path.join(d.localRoot, 'Photos/p.jpg'));
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([['vol~Photos/p.jpg']]);
        });

        test('the hold, and the look at what is missing after it, survive a restart of the daemon', async () => {
            const d = setup();
            const copyBack = await lost(d);
            await copyBack('Docs'); // Photos still missing

            let engine = d.restart();
            expect(engine.getStatus()).toMatchObject(held(d, ['Photos'], 3)); // before any pass
            await engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(engine.getStatus()).toMatchObject(held(d, ['Photos'], 3));

            // Photos made, with one of its files, and the daemon restarted before the pass that would look at it
            await copyBack('Photos', { onlyTheFolder: true });
            await copyBack('Photos/p.jpg');
            expect(engine.getStatus().filesMissing).toBeNull(); // every top-level item waited for is there
            engine = d.restart();
            await engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(engine.getStatus()).toMatchObject(held(d, ['Photos/p2.jpg'], 1));

            await copyBack('Photos/p2.jpg');
            engine = d.restart();
            await engine.reconcileNow();
            expect(engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
            expect(d.calls.trashed).toEqual([]);
        });

        test('the look at what is missing runs after a pass that fails too', async () => {
            const d = setup();
            const copyBack = await lost(d);
            await copyBack('Docs');
            await copyBack('Photos', { onlyTheFolder: true });
            await copyBack('Photos/p.jpg');

            d.failNext('iterateFolderChildren'); // the network drops as the pass starts listing
            await d.engine.reconcileNow();

            // Held again by that pass itself, with no pass after it
            expect(d.engine.getStatus()).toMatchObject(held(d, ['Photos/p2.jpg'], 1));
            expect(d.calls.trashed).toEqual([]);
        });

        test('until a look has run, every pass after a hold takes nothing missing for a delete', async () => {
            const d = setup();
            const copyBack = await lost(d);
            await copyBack('Docs');
            await copyBack('Photos', { onlyTheFolder: true });
            await copyBack('Photos/p.jpg');
            // The first pass fails, and so does its look (a disk error, say): no hold, but the look is still due
            d.failNext('iterateFolderChildren');
            const look = spyOn(d.engine as any, 'missingRecordedItems').mockImplementationOnce(() => {
                throw new Error('Input/output error');
            });
            try {
                await d.engine.reconcileNow();
            } finally {
                look.mockRestore();
            }
            expect(d.engine.getStatus().filesMissing).toBeNull();
            expect(stateDb.getMeta(FILES_HOLD)).not.toBeNull();

            // The next pass walks the folder, finds p2.jpg missing, and leaves it alone, then holds on it
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject(held(d, ['Photos/p2.jpg'], 1));
        });

        // I1: a local change seen after the hold ended, before a pass has looked: a copy cancelled part-way writes a file
        // and removes it again, which the watcher reports as a delete of that recorded file
        for (const layout of ['plain', 'virtual'] as const) {
            test(`${layout}: a file written and removed again by a cancelled copy after the hold ends isn't taken for a delete`, async () => {
                const d = setup(layout);
                const copyBack = await lost(d);
                await copyBack('Photos');
                await copyBack('Docs', { onlyTheFolder: true });
                await copyBack('Docs/a.txt');
                expect(d.engine.getStatus().filesMissing).toBeNull(); // every top-level item waited for is back

                await writeFile(path.join(d.localRoot, 'Docs/b.txt'), 'part of'); // the copy of b.txt, cancelled
                await rm(path.join(d.localRoot, 'Docs/b.txt'));
                await (d.engine as any).handleLocalFileChange('Docs/b.txt');

                expect(d.calls.trashed).toEqual([]);
                expect(stateDb.getItemByPath('Docs/b.txt')).not.toBeNull();
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
                expect(d.engine.getStatus()).toMatchObject(held(d, ['Docs/b.txt'], 1));
            });
        }

        test('while held, the status and local changes look at what is missing at most once a second; a pass looks afresh', async () => {
            const d = setup('plain', { cacheMs: 1000 });
            const copyBack = await lost(d);
            const looks = spyOn(stateDb, 'countItemsUnder'); // once for each item held, at each look
            const start = Date.now();
            try {
                setSystemTime(start);
                for (let i = 0; i < 5; i++) {
                    d.engine.getStatus();
                    await (d.engine as any).handleLocalFileChange(`New${i}.txt`);
                }
                expect(looks.mock.calls.length).toBeLessThanOrEqual(2); // Docs and Photos, once
                looks.mockClear();
                setSystemTime(start + 1500);
                d.engine.getStatus();
                d.engine.getStatus();
                expect(looks.mock.calls.length).toBe(2);

                // Back: the status may say so up to a second later, but the next pass looks afresh
                await copyBack('Docs');
                await copyBack('Photos');
                expect(d.engine.getStatus().filesMissing).not.toBeNull();
                await d.engine.reconcileNow();
                expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
                expect(d.calls.trashed).toEqual([]);
            } finally {
                setSystemTime();
                looks.mockRestore();
            }
        });

        test('while the files move between the folder and the store, a saved hold is neither taken up nor said', async () => {
            const d = setup();
            await lost(d);
            const said = d.warnings.filter((w) => w === missing(d.place)).length;
            stateDb.setMeta(LAYOUT_MOVING, 'virtual'); // a move cut short, which the daemon finishes before syncing

            const engine = d.restart();
            expect(engine.getStatus().filesMissing).toBeNull();
            await expect(engine.confirmFilesMissingDeleted({ root: d.shown, names: ['Docs', 'Photos'] })).rejects.toMatchObject({
                status: 409,
                message: 'Proton Drive is busy moving files',
            });
            expect(d.warnings.filter((w) => w === missing(d.place))).toHaveLength(said);

            stateDb.deleteMeta(LAYOUT_MOVING);
            expect(engine.getStatus()).toMatchObject({ state: 'error', filesMissing: { names: ['Docs', 'Photos'] } });
            expect(d.calls.trashed).toEqual([]);
        });

        test("the messages say what is missing, and where, in the user's terms", () => {
            expect(missingPlace('/home/u/ProtonDrive', false, '/home/u')).toBe('~/ProtonDrive');
            expect(missingPlace('/home/u', false, '/home/u/')).toBe('~');
            expect(missingPlace('/home/user/ProtonDrive', false, '/home/u')).toBe('/home/user/ProtonDrive');
            expect(missingPlace('/mnt/disk/ProtonDrive', false, '/home/u')).toBe('/mnt/disk/ProtonDrive');
            expect(missingPlace('/home/u/ProtonDrive', true, '/home/u')).toBe("the drive's storage");
            const where = '~/ProtonDrive';
            expect(filesMissingMessage(where)).toBe("Proton Drive's files are missing from ~/ProtonDrive. Nothing was deleted in Proton Drive.");
            expect(filesMissingMessage(where, { names: ['Docs', 'Photos'], items: 9, whole: true })).toBe(filesMissingMessage(where));
            expect(filesMissingMessage(where, { names: ['Photos'], items: 3, whole: false })).toBe(
                'Photos is missing from ~/ProtonDrive. Nothing was deleted in Proton Drive.',
            );
            expect(filesMissingMessage(where, { names: ['Docs/b.txt', 'Photos'], items: 4, whole: false })).toBe(
                '4 items are missing from ~/ProtonDrive. Nothing was deleted in Proton Drive.',
            );
        });

        test('confirming after a partial return trashes exactly what the dialog counted, and holds on anything else missing', async () => {
            const d = setup();
            const copyBack = await lost(d);
            await copyBack('Docs', { onlyTheFolder: true });
            await copyBack('Docs/a.txt'); // Docs/b.txt isn't back, and Photos isn't either
            await d.engine.reconcileNow();
            const shownBefore = d.engine.getStatus().filesMissing;
            expect(shownBefore).toEqual({ root: d.shown, names: ['Photos'], items: 3, message: someMissing(d, ['Photos'], 3) });

            expect(await confirmShown(d)).toEqual(shownBefore!);
            await d.engine.holdForMove(); // waits for the pass the confirmation started
            d.engine.releaseHold();

            expect(d.calls.trashed).toEqual([['vol~Photos']]); // the 3 items counted: Photos, p.jpg and p2.jpg
            expect(d.nodes.has('vol~Docs/b.txt')).toBe(true);
            expect(d.engine.getStatus()).toMatchObject(held(d, ['Docs/b.txt'], 1));

            // That one can be confirmed in turn
            await confirmShown(d);
            await d.engine.holdForMove();
            d.engine.releaseHold();
            expect(d.calls.trashed).toEqual([['vol~Photos'], ['vol~Docs/b.txt']]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
        });

        test('a confirmation must name exactly what is missing: anything else is refused (409) and deletes nothing', async () => {
            const d = setup();
            await synced(d);
            await rm(path.join(d.localRoot, 'Docs'), { recursive: true });
            await rm(path.join(d.localRoot, 'Photos'), { recursive: true });
            await d.engine.reconcileNow();

            for (const wrong of [
                { root: d.shown, names: ['Docs'] },
                { root: d.shown, names: ['Docs', 'Photos', 'Notes'] },
                { root: path.join(tempDir, 'Elsewhere'), names: ['Docs', 'Photos'] },
            ]) {
                await expect(d.engine.confirmFilesMissingDeleted(wrong)).rejects.toMatchObject({ status: 409 });
            }
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({
                state: 'error',
                lastError: missing(d.place), // all of them
                filesMissing: { names: ['Docs', 'Photos'], items: 5 },
            });

            // The same names in another order are the same confirmation
            expect(await d.engine.confirmFilesMissingDeleted({ root: d.shown, names: ['Photos', 'Docs'] })).toMatchObject({
                names: ['Docs', 'Photos'],
            });
            await d.engine.holdForMove();
            d.engine.releaseHold();
            expect(d.calls.trashed.flat().sort()).toEqual(['vol~Docs', 'vol~Photos']);
        });

        test('being held again after the files came back says what is still missing once, and a new loss is said anew', async () => {
            const notices: string[] = [];
            const notify = spyOn(notifications, 'sendDesktopNotification').mockImplementation((n) => {
                notices.push(`${n.title}: ${n.body}`);
            });
            try {
                await heldAgainSaid(notices);
            } finally {
                notify.mockRestore();
            }
        });
        const heldAgainSaid = async (notices: string[]) => {
            const d = setup();
            // Told as everything missing: the warning, the activity entry and the notification go together
            const saidMissing = () => d.warnings.filter((w) => w === missing(d.place));
            const copyBack = await lost(d);
            expect(saidMissing()).toHaveLength(1);
            expect(notices).toEqual([`Proton Drive: files missing: ${missing(d.place)}`]);
            await copyBack('Docs');
            await copyBack('Photos', { onlyTheFolder: true });
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();
            // Held again on Photos/p.jpg and p2.jpg: told once, as what is still missing, not as everything missing
            expect(saidMissing()).toHaveLength(1);
            const still = `Photos/p.jpg and Photos/p2.jpg are still missing from ${d.place} after the files came back. Nothing was deleted in Proton Drive; Proton Drive waits for them.`;
            const stillMissing = stateDb.listActivity(50).filter((a) => a.details.includes('still missing from'));
            expect(stillMissing.map((a) => a.details)).toEqual([still]);
            // And one notification for it, like the first
            expect(notices).toEqual([`Proton Drive: files missing: ${missing(d.place)}`, `Proton Drive: files still missing: ${still}`]);

            // Back, then the whole folder gone again before a pass looked: a new loss, said again
            await copyBack('Photos/p.jpg');
            await copyBack('Photos/p2.jpg');
            expect(d.engine.getStatus().filesMissing).toBeNull();
            await rename(d.localRoot, path.join(tempDir, 'away again'));
            await d.engine.reconcileNow();
            expect(saidMissing()).toHaveLength(2);
            expect(notices).toHaveLength(3);
            expect(d.calls.trashed).toEqual([]);
        };

        test("virtual: the messages say the drive's storage, and the status names the sync folder, never the store", async () => {
            const d = setup('virtual');
            await synced(d);
            await rm(d.localRoot, { recursive: true, force: true });
            await mkdir(d.localRoot);
            await d.engine.reconcileNow();

            const status = d.engine.getStatus();
            expect(status.filesMissing?.root).toBe(stateDb.getSettings().syncDir);
            expect(status.lastError).toBe("Proton Drive's files are missing from the drive's storage. Nothing was deleted in Proton Drive.");
            expect(status.filesMissing?.message).toBe(status.lastError!);
            expect(JSON.stringify(status.filesMissing)).not.toContain(d.localRoot);
            expect(stateDb.listActivity(50).map((a) => a.details).join('\n')).not.toContain(`missing from ${d.localRoot}`);
        });

        // #50: a file opened on demand is recorded without records for the folders above it. With the store emptied, the
        // hold is on its top-level folder, which has no record: a confirmation's pass never reached the file, trashed
        // nothing, and the next pass held again, for ever. A confirmation now trashes what it names by its recorded node
        // when the pass can't reach it; or the user keeps them in Proton Drive, online-only, which deletes nothing.
        // Photos/2024 holds p.jpg, opened once (so recorded alone), and q.jpg, never on this computer; then the files go
        const openedOnly = async (d: ReturnType<typeof setup>) => {
            d.add('Photos/2024/p.jpg', 'p');
            d.add('Photos/2024/q.jpg', 'q');
            await d.engine.reconcileNow();
            await d.engine.hydrate('Photos/2024/p.jpg');
            expect(stateDb.getAllItems().map((item) => item.localRelPath)).toEqual(['Photos/2024/p.jpg']);
            await rm(d.localRoot, { recursive: true, force: true });
            await mkdir(d.localRoot);
            await d.engine.reconcileNow();
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', filesMissing: { root: d.shown, names: ['Photos'], items: 1 } });
            expect(d.calls.trashed).toEqual([]);
        };
        // Keeps what the status says is missing in Proton Drive, online-only, as the app does
        const keepShown = (d: ReturnType<typeof setup>, engine = d.engine) =>
            engine.keepFilesMissingOnlineOnly(engine.getStatus().filesMissing!);
        // The pass a choice started has run
        const settled = async (d: ReturnType<typeof setup>) => {
            await d.engine.holdForMove();
            d.engine.releaseHold();
        };

        for (const layout of ['plain', 'virtual'] as const) {
            test(`${layout}: deleting a file opened on demand, recorded without its folders, trashes exactly that node, for good`, async () => {
                const d = setup(layout);
                await openedOnly(d);

                expect(await confirmShown(d)).toMatchObject({ names: ['Photos'], items: 1 });
                await settled(d);

                expect(d.calls.trashed).toEqual([['vol~Photos/2024/p.jpg']]);
                expect(d.nodes.has('vol~Photos/2024/q.jpg')).toBe(true); // never on this computer: it stays
                expect(d.nodes.has('vol~Photos/2024')).toBe(true);
                expect(stateDb.getAllItems()).toEqual([]);
                expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                expect(stateDb.getMeta(FILES_HOLD)).toBeNull();
                // For good: no hold again, nothing more trashed
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();
                expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                expect(d.calls.trashed).toEqual([['vol~Photos/2024/p.jpg']]);
            });

            test(`${layout}: keeping a file opened on demand online-only drops its record, leaves the cloud alone, and lists it`, async () => {
                const d = setup(layout);
                await openedOnly(d);

                expect(await keepShown(d)).toMatchObject({ root: d.shown, names: ['Photos'], items: 1 });
                // At once: the hold is over and the record gone (records before files: there are none)
                expect(d.engine.getStatus().filesMissing).toBeNull();
                expect(stateDb.getAllItems()).toEqual([]);
                await settled(d);
                await d.engine.reconcileNow();

                expect(d.calls.trashed).toEqual([]);
                expect([...d.nodes.keys()].filter((uid) => uid.startsWith('vol~Photos')).sort()).toEqual([
                    'vol~Photos',
                    'vol~Photos/2024',
                    'vol~Photos/2024/p.jpg',
                    'vol~Photos/2024/q.jpg',
                ]);
                expect(d.calls.downloads).toEqual(['Photos/2024/p.jpg']); // the one open, before: nothing comes down again
                expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                expect(stateDb.getMeta(FILES_HOLD)).toBeNull();
                // Online-only: the drive lists it, My files says so, and an open brings it back
                expect(d.engine.vfsChildren('').map((e) => e.name)).toEqual(['Photos']);
                expect(d.engine.vfsChildren('Photos/2024').map((e) => e.name)).toEqual(['p.jpg', 'q.jpg']);
                expect(d.engine.availability.stateOf('Photos/2024/p.jpg')).toBe('online-only');
                expect(d.engine.availability.stateOf('Photos')).toBe('online-only');
                expect(await d.files.exists('Photos/2024/p.jpg')).toBe(false);
                await d.engine.hydrate('Photos/2024/p.jpg');
                expect(await readFile(path.join(d.localRoot, 'Photos/2024/p.jpg'), 'utf8')).toBe('p');
                expect(stateDb.listActivity(50).some((a) => a.details.includes('online-only'))).toBe(true);
            });
        }

        // I1: a file moved or renamed on the web during the hold is not where the user deleted it: never trashed there
        for (const layout of ['plain', 'virtual'] as const) {
            for (const how of ['moved', 'renamed'] as const) {
                test(`${layout}: a file opened on demand and ${how} on the web during the hold is never trashed; its record goes`, async () => {
                    const d = setup(layout);
                    await openedOnly(d);
                    const file = d.nodes.get('vol~Photos/2024/p.jpg')!;
                    if (how === 'moved') {
                        d.nodes.set(file.uid, { ...file, parentUid: d.add('Archive').uid });
                    } else {
                        d.nodes.set(file.uid, { ...file, name: { ok: true as const, value: 'renamed.jpg' } });
                    }

                    await confirmShown(d);
                    await settled(d);

                    expect(d.calls.trashed).toEqual([]);
                    expect(d.nodes.get(file.uid)).toBeDefined();
                    expect(d.warnings).toContain('Not trashing Photos/2024/p.jpg: it moved in Proton Drive meanwhile, so it stays there');
                    expect(stateDb.getAllItems()).toEqual([]);
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                    // And for good: the next pass holds on nothing, and trashes nothing
                    await d.engine.reconcileNow();
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                    expect(stateDb.getMeta(FILES_HOLD)).toBeNull();
                    expect(d.calls.trashed).toEqual([]);
                });
            }
        }

        // I1, the rest: a folder above the file moved or renamed on the web during the hold leaves the file elsewhere too
        const aboveChanged: Record<string, (d: ReturnType<typeof setup>) => void> = {
            'Photos/2024 moved out of Photos': (d) => {
                const folder = d.nodes.get('vol~Photos/2024')!;
                d.nodes.set(folder.uid, { ...folder, parentUid: d.add('Elsewhere').uid });
            },
            'Photos renamed': (d) => {
                const folder = d.nodes.get('vol~Photos')!;
                d.nodes.set(folder.uid, { ...folder, name: { ok: true as const, value: 'Pictures' } });
            },
            'Photos/2024 renamed': (d) => {
                const folder = d.nodes.get('vol~Photos/2024')!;
                d.nodes.set(folder.uid, { ...folder, name: { ok: true as const, value: '2024-old' } });
            },
        };
        for (const layout of ['plain', 'virtual'] as const) {
            for (const [what, change] of Object.entries(aboveChanged)) {
                test(`${layout}: with ${what} on the web during the hold, a file opened on demand under it is never trashed`, async () => {
                    const d = setup(layout);
                    await openedOnly(d);
                    change(d);

                    await confirmShown(d);
                    await settled(d);

                    expect(d.calls.trashed).toEqual([]);
                    expect(d.nodes.has('vol~Photos/2024/p.jpg')).toBe(true);
                    expect(d.warnings).toContain('Not trashing Photos/2024/p.jpg: it moved in Proton Drive meanwhile, so it stays there');
                    expect(stateDb.getAllItems()).toEqual([]);
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                    await d.engine.reconcileNow();
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                    expect(stateDb.getMeta(FILES_HOLD)).toBeNull();
                    expect(d.calls.trashed).toEqual([]);
                });
            }
        }

        test('virtual: files opened on demand under the same folders are each trashed, the folders looked up once', async () => {
            const d = setup('virtual');
            d.add('Photos/2024/p.jpg', 'p');
            d.add('Photos/2024/q.jpg', 'q');
            d.add('Photos/2024/r.jpg', 'r');
            await d.engine.reconcileNow();
            await d.engine.hydrate('Photos/2024/p.jpg');
            await d.engine.hydrate('Photos/2024/q.jpg');
            await rm(d.localRoot, { recursive: true, force: true });
            await mkdir(d.localRoot);
            await d.engine.reconcileNow();
            const looked = spyOn(d.sdk, 'getNode');
            try {
                await confirmShown(d);
                await settled(d);
                const lookups = looked.mock.calls.map(([uid]) => uid as string);
                expect(lookups.filter((uid) => uid === 'vol~Photos/2024')).toHaveLength(1);
                expect(lookups.filter((uid) => uid === 'vol~Photos')).toHaveLength(1);
            } finally {
                looked.mockRestore();
            }
            expect(d.calls.trashed.flat().sort()).toEqual(['vol~Photos/2024/p.jpg', 'vol~Photos/2024/q.jpg']);
            expect(d.nodes.has('vol~Photos/2024/r.jpg')).toBe(true);
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
        });

        // P6: brought back while its node was being looked up: it keeps its record, so the next pass follows the move
        // rather than uploading it again
        test('virtual: a file restored while its node is looked up keeps its record, and nothing is trashed', async () => {
            const d = setup('virtual');
            await openedOnly(d);
            const file = d.nodes.get('vol~Photos/2024/p.jpg')!;
            d.nodes.set(file.uid, { ...file, parentUid: d.add('Archive').uid }); // moved on the web
            const getNode = d.sdk.getNode.bind(d.sdk);
            (d.sdk as any).getNode = async (uid: string) => {
                if (uid === file.uid) {
                    // The user copies it back from a backup just then
                    await mkdir(path.join(d.localRoot, 'Photos/2024'), { recursive: true });
                    await writeFile(path.join(d.localRoot, 'Photos/2024/p.jpg'), 'p');
                }
                return getNode(uid);
            };

            await confirmShown(d);
            await settled(d);

            expect(d.calls.trashed).toEqual([]);
            expect(stateDb.getItemByPath('Photos/2024/p.jpg')?.nodeUid).toBe(file.uid);
            expect(d.warnings.filter((w) => w.startsWith('Not trashing'))).toEqual([]);
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.uploads).toEqual([]);
        });

        for (const moved of [false, true]) {
            test(`virtual: a folder recorded without the folder above it goes by its node too${moved ? ', but not once moved on the web' : ''}`, async () => {
                const d = setup('virtual');
                await openedOnly(d);
                // Made through the drive, say: Photos/2024 has a record, Photos still has none
                const folder = d.nodes.get('vol~Photos/2024')!;
                stateDb.upsertItem({
                    localRelPath: 'Photos/2024',
                    nodeUid: folder.uid,
                    parentNodeUid: 'vol~Photos',
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: 0,
                    remoteMtimeMs: 0,
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                });
                if (moved) {
                    d.add('Elsewhere');
                    d.nodes.set(folder.uid, { ...folder, parentUid: 'vol~Elsewhere' });
                }
                await d.engine.reconcileNow();
                expect(d.engine.getStatus().filesMissing).toMatchObject({ names: ['Photos'], items: 2 });

                await confirmShown(d);
                await settled(d);

                if (moved) {
                    // Not where the user deleted it any more: it stays in Proton Drive where it went, its records go, and
                    // nothing holds again
                    expect(d.calls.trashed).toEqual([]);
                    expect(d.nodes.get(folder.uid)?.parentUid).toBe('vol~Elsewhere');
                    expect(d.nodes.has('vol~Photos/2024/p.jpg')).toBe(true);
                    expect(d.warnings).toContain('Not trashing Photos/2024: it moved in Proton Drive meanwhile, so it stays there');
                    expect(stateDb.getAllItems()).toEqual([]);
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
                    await d.engine.reconcileNow();
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
                    expect(stateDb.getMeta(FILES_HOLD)).toBeNull();
                    expect(d.calls.trashed).toEqual([]);
                } else {
                    // As a pass takes a folder deleted here: what was on this computer goes, q.jpg (never here) stays
                    expect(d.calls.trashed).toEqual([['vol~Photos/2024/p.jpg']]);
                    expect(d.nodes.has('vol~Photos/2024/q.jpg')).toBe(true);
                    expect(stateDb.getAllItems()).toEqual([]);
                    expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
                }
            });
        }

        test('virtual: kept online-only, a name with no uid known is unpinned through the records under it', async () => {
            const d = setup('virtual');
            d.add('Photos/2024/p.jpg', 'p');
            d.add('Photos/2024/q.jpg', 'q');
            await d.engine.reconcileNow();
            await d.engine.hydrate('Photos/2024/p.jpg');
            d.engine.availability.setPin(d.root.uid, 'pinned', false); // the whole drive kept on this device since
            d.engine.remoteIndex.removeSubtree('vol~Photos'); // and Photos no longer in the listing kept here
            await rm(d.localRoot, { recursive: true, force: true });
            await mkdir(d.localRoot);
            await d.engine.reconcileNow();
            expect(d.engine.getStatus().filesMissing).toMatchObject({ names: ['Photos'], items: 1 });

            await keepShown(d);
            await settled(d);
            await d.engine.reconcileNow();

            expect(d.calls.trashed).toEqual([]);
            // p.jpg, kept online-only, is not downloaded again, though everything around it is kept on this device
            expect(d.calls.downloads.filter((p) => p === 'Photos/2024/p.jpg')).toEqual(['Photos/2024/p.jpg']); // the open
            expect(await d.files.exists('Photos/2024/p.jpg')).toBe(false);
            expect(d.engine.availability.stateOf('Photos/2024/p.jpg')).toBe('online-only');
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
        });

        test('plain: kept online-only, what was kept on this device (here the whole drive) is not downloaded again', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Photos/p.jpg', 'p');
            d.engine.availability.setPin(d.root.uid, 'pinned', false); // as a fresh install has it
            await d.engine.reconcileNow();
            expect(await d.files.exists('Photos/p.jpg')).toBe(true);
            await rm(d.localRoot, { recursive: true, force: true });
            await d.engine.reconcileNow();
            expect(d.engine.getStatus().filesMissing).toMatchObject({ names: ['Docs', 'Photos'], items: 4 });

            await keepShown(d);
            await settled(d);
            await d.engine.reconcileNow();

            expect(d.calls.trashed).toEqual([]);
            expect(d.calls.downloads.sort()).toEqual(['Docs/a.txt', 'Photos/p.jpg']); // the first sync only
            expect(await readdir(d.localRoot)).toEqual([]);
            expect(stateDb.getAllItems()).toEqual([]);
            expect(d.engine.availability.stateOf('Docs')).toBe('online-only');
            expect(d.engine.availability.stateOf('Photos/p.jpg')).toBe('online-only');
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
            // Something new in the cloud still comes down, as the whole drive is still kept
            d.add('New.txt', 'n');
            await d.engine.reconcileNow();
            expect(await d.files.exists('New.txt')).toBe(true);
        });

        test('plain: a restore from an older backup without some files can keep those online-only', async () => {
            const d = setup();
            const copyBack = await lost(d);
            await copyBack('Docs');
            await copyBack('Photos', { onlyTheFolder: true });
            await copyBack('Photos/p.jpg'); // the backup predates p2.jpg
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();
            expect(d.engine.getStatus()).toMatchObject(held(d, ['Photos/p2.jpg'], 1));

            expect(await keepShown(d)).toMatchObject({ names: ['Photos/p2.jpg'], items: 1 });
            await settled(d);
            await d.engine.reconcileNow();

            expect(d.calls.trashed).toEqual([]);
            expect(d.nodes.has('vol~Photos/p2.jpg')).toBe(true);
            expect(await d.files.exists('Photos/p2.jpg')).toBe(false); // Photos is kept on this device, p2.jpg isn't
            expect(d.calls.downloads.filter((p) => p === 'Photos/p2.jpg')).toEqual(['Photos/p2.jpg']); // the first sync only
            expect(stateDb.getItemByPath('Photos/p2.jpg')).toBeNull();
            expect(stateDb.getItemByPath('Photos/p.jpg')).not.toBeNull();
            expect(d.engine.availability.stateOf('Photos/p2.jpg')).toBe('online-only');
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', lastError: null, filesMissing: null });
            // A delete after that is the user's, as ever
            await rm(path.join(d.localRoot, 'Photos/p.jpg'));
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([['vol~Photos/p.jpg']]);
        });

        test('keeping them online-only must name exactly what is missing: anything else is refused (409) and changes nothing', async () => {
            const d = setup();
            await synced(d);
            const records = stateDb.getAllItems();
            await rm(path.join(d.localRoot, 'Docs'), { recursive: true });
            await rm(path.join(d.localRoot, 'Photos'), { recursive: true });
            await d.engine.reconcileNow();

            for (const wrong of [
                { root: d.shown, names: ['Docs'] },
                { root: d.shown, names: ['Docs', 'Photos', 'Notes'] },
                { root: path.join(tempDir, 'Elsewhere'), names: ['Docs', 'Photos'] },
            ]) {
                await expect(d.engine.keepFilesMissingOnlineOnly(wrong)).rejects.toMatchObject({ status: 409 });
            }
            expect(stateDb.getAllItems()).toEqual(records);
            expect(d.engine.availability.stateOf('Docs')).toBe('pinned');
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'error', filesMissing: { names: ['Docs', 'Photos'], items: 5 } });

            // The same names in another order are the same choice
            expect(await d.engine.keepFilesMissingOnlineOnly({ root: d.shown, names: ['Photos', 'Docs'] })).toMatchObject({
                names: ['Docs', 'Photos'],
            });
            await settled(d);
            expect(d.calls.trashed).toEqual([]);
            expect(d.engine.getStatus()).toMatchObject({ state: 'idle', filesMissing: null });
        });

        test('keeping them online-only with nothing missing, or while the files move, is refused (409)', async () => {
            const d = setup();
            await expect(d.engine.keepFilesMissingOnlineOnly({ root: d.shown, names: ['Docs'] })).rejects.toMatchObject({ status: 409 });
            await lost(d);
            stateDb.setMeta(LAYOUT_MOVING, 'virtual');
            const engine = d.restart();
            await expect(engine.keepFilesMissingOnlineOnly({ root: d.shown, names: ['Docs', 'Photos'] })).rejects.toMatchObject({
                status: 409,
                message: 'Proton Drive is busy moving files',
            });
            stateDb.deleteMeta(LAYOUT_MOVING);
            expect(stateDb.getAllItems().length).toBeGreaterThan(0);
            expect(engine.getStatus().filesMissing).toMatchObject({ names: ['Docs', 'Photos'] });
        });
    });

    // #47: a file uploaded from this computer was recorded but left out of the remote index until a later pass listed its
    // folder, so freeing it right away hid it from the drive ("Not in Proton Drive"). An upload, a new node or a new
    // revision, now goes into the index at once, as a listing would put it there.
    describe('an upload is in the remote index at once (#47)', () => {
        const setup = (layout: 'plain' | 'virtual') => {
            if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            const backingDir = path.join(tempDir, 'files');
            const localRoot = layout === 'virtual' ? backingDir : stateDb.getSettings().syncDir;
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                ...uploadAtOnce,
                backingDir,
            });
            return { ...drive, engine, localRoot, files: localFiles(stateDb, () => localRoot), local: (rel: string) => path.join(localRoot, rel) };
        };
        const sha1Of = (content: string) => new Bun.CryptoHasher('sha1').update(content).digest('hex');
        // Freed right after its upload, a file is online-only: the drive lists it, status says so, and an open brings it back
        const freedRightAway = async (d: ReturnType<typeof setup>, folder: string, name: string, content: string) => {
            const rel = `${folder}/${name}`;
            const entry = d.engine.remoteIndex.getByPath(rel);
            expect(entry).toMatchObject({ type: 'file', name, size: Buffer.byteLength(content), sha1: sha1Of(content) });
            expect((await d.engine.setAvailability(folder, 'free')).state).toBe('online-only');
            expect(await d.files.exists(rel)).toBe(false);
            expect(d.engine.vfsChildren(folder)).toContainEqual({ name, type: 'file', size: Buffer.byteLength(content), mtimeMs: entry!.mtimeMs });
            expect(await d.engine.availabilityOf(rel)).toBe('online-only');
            await d.engine.hydrate(rel);
            expect(await readFile(d.local(rel), 'utf8')).toBe(content);
            expect(d.calls.trashed).toEqual([]);
        };

        for (const layout of ['plain', 'virtual'] as const) {
            test(`${layout}: a file the watcher uploads, freed right away, stays in the drive as online-only`, async () => {
                const d = setup(layout);
                await d.engine.reconcileNow(); // an empty drive
                const content = 'written through the drive, then freed';
                await d.files.writeLocal('fod2-test/a.txt', content);

                await (d.engine as any).handleLocalFileChange('fod2-test');
                await (d.engine as any).handleLocalFileChange('fod2-test/a.txt');

                expect(d.calls.uploads).toEqual(['fod2-test/a.txt']);
                await freedRightAway(d, 'fod2-test', 'a.txt', content);
            });

            test(`${layout}: a file a sync pass uploads, freed right away, stays in the drive as online-only`, async () => {
                const d = setup(layout);
                const content = 'new on this computer';
                await d.files.writeLocal('Docs/n.txt', content);

                await d.engine.reconcileNow();

                expect(d.calls.uploads).toEqual(['Docs/n.txt']);
                await freedRightAway(d, 'Docs', 'n.txt', content);
            });

            test(`${layout}: the folders made on the way for a file are in the index with it`, async () => {
                const d = setup(layout);
                await d.engine.reconcileNow();
                const content = 'deep';
                await d.files.writeLocal('A/B/c.txt', content);

                await (d.engine as any).handleLocalFileChange('A/B/c.txt'); // only the file: its folders are made for it

                expect(d.engine.vfsChildren('').map((e) => e.name)).toEqual(['A']);
                expect(d.engine.vfsChildren('A').map((e) => e.name)).toEqual(['B']);
                await freedRightAway(d, 'A/B', 'c.txt', content);
                expect(d.engine.vfsChildren('A').map((e) => e.name)).toEqual(['B']);
            });

            test(`${layout}: a new revision, from the watcher or a pass, updates the size, time and checksum in the index`, async () => {
                const d = setup(layout);
                await d.engine.reconcileNow();
                await d.files.writeLocal('a.txt', 'v1');
                await (d.engine as any).handleLocalFileChange('a.txt');
                const uid = d.engine.remoteIndex.getByPath('a.txt')!.uid;
                const edit = async (content: string, at: number) => {
                    await writeFile(d.local('a.txt'), content);
                    await utimes(d.local('a.txt'), at, at);
                    return { uid, size: Buffer.byteLength(content), sha1: sha1Of(content), mtimeMs: at * 1000 };
                };

                const second = await edit('the second version', 1_700_000_000);
                await (d.engine as any).handleLocalFileChange('a.txt');
                expect(d.engine.remoteIndex.getByPath('a.txt')).toMatchObject(second);

                const third = await edit('a third version, longer still', 1_700_000_100);
                await d.engine.reconcileNow(); // lists the root first, then uploads
                expect(d.engine.remoteIndex.getByPath('a.txt')).toMatchObject(third);
                expect(d.calls.uploads).toEqual(['a.txt', 'a.txt', 'a.txt']);
            });
        }

        test('a new revision of a node the index dropped meanwhile (a cloud delete event) does not put it back', async () => {
            const d = setup('virtual');
            await d.engine.reconcileNow();
            await d.files.writeLocal('a.txt', 'v1');
            await (d.engine as any).handleLocalFileChange('a.txt');
            d.engine.remoteIndex.removeSubtree(d.engine.remoteIndex.getByPath('a.txt')!.uid); // as a NodeDeleted event does

            await d.files.writeLocal('a.txt', 'v2, uploaded as the delete arrives');
            await (d.engine as any).handleLocalFileChange('a.txt');

            expect(d.calls.uploads).toEqual(['a.txt', 'a.txt']);
            expect(d.engine.remoteIndex.getByPath('a.txt')).toBeNull();
        });

        test('a conflict copy is in the index once uploaded', async () => {
            const d = setup('virtual');
            d.add('Docs/doc.txt', 'base');
            await d.engine.reconcileNow();
            await d.engine.setAvailability('Docs', 'pin');
            expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('base');
            // Both sides change: the cloud on another device, the local copy here
            const node = d.nodes.get('vol~Docs/doc.txt')!;
            d.nodes.set(node.uid, makeMockNode({ uid: node.uid, parentUid: node.parentUid, nameStr: 'doc.txt', type: NodeType.File, content: 'cloud edit' }));
            await d.files.writeLocal('Docs/doc.txt', 'my edit');

            await d.engine.reconcileNow();

            const copy = stateDb.getAllItems().find((i) => i.localRelPath.startsWith('Docs/doc (conflict '));
            expect(copy).toBeDefined();
            expect(d.engine.remoteIndex.getByPath(copy!.localRelPath)).toMatchObject({
                uid: copy!.nodeUid,
                type: 'file',
                size: Buffer.byteLength('my edit'),
                sha1: sha1Of('my edit'),
            });
            await freedRightAway(d, 'Docs', path.posix.basename(copy!.localRelPath), 'my edit');
        });
    });

    // #51: a copy that stalls longer than the watcher's debounce used to upload the half-written file as a new revision.
    // A changed file now uploads only once it has stayed as it is for a while (longer each time it is seen growing).
    describe('a file still being written (#51)', () => {
        for (const layout of ['plain', 'virtual'] as const) {
            describe(`in the ${layout} layout`, () => {
                // The engine's settle clock runs ahead of the real one by what advance() adds; the looks it schedules run
                // when advance() reaches them
                // quietMs: the wait (2 s by default here)
                const setup = (opts: { quietMs?: number } = {}) => {
                    const backingDir = path.join(tempDir, 'files');
                    if (layout === 'virtual') {
                        stateDb.setMeta('driveLayout', 'virtual');
                    }
                    const drive = makeMockDrive();
                    let offset = 0;
                    const now = () => Date.now() + offset;
                    let looks: Array<{ at: number; run: () => Promise<void> }> = [];
                    const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                        ...(layout === 'virtual' ? { backingDir, moveToDesktopTrash: async () => false } : {}),
                        settle: {
                            quietMs: opts.quietMs ?? 2000,
                            maxQuietMs: 16_000,
                            maxWaitMs: 120_000,
                            now,
                            schedule: (run, delayMs) => {
                                const look = { at: now() + delayMs, run };
                                looks.push(look);
                                return () => {
                                    looks = looks.filter((l) => l !== look);
                                };
                            },
                        },
                    });
                    const advance = async (ms: number) => {
                        offset += ms;
                        const due = looks.filter((l) => l.at <= now());
                        looks = looks.filter((l) => !due.includes(l));
                        await Promise.all(due.map((l) => l.run()));
                    };
                    const files = localFiles(stateDb, () => engine.localRoot());
                    const local = (rel: string) => path.join(engine.localRoot(), rel);
                    const changed = (rel: string) => (engine as any).handleLocalFileChange(rel) as Promise<void>;
                    return { ...drive, engine, advance, files, local, changed, pendingLooks: () => looks.length };
                };
                // Something on Proton Drive already, so that the folder never reads as missing its files (#45)
                const started = async (opts: { quietMs?: number } = {}) => {
                    const d = setup(opts);
                    d.add('Kept.txt', 'kept');
                    d.engine.availability.setPin(d.root.uid, 'pinned', false);
                    await d.engine.reconcileNow();
                    d.calls.uploads.length = 0;
                    return d;
                };

                test('a file that grows across several looks uploads once, when it is complete', async () => {
                    const d = await started();
                    await d.files.writeLocal('big.bin', 'part 1;');
                    await d.changed('big.bin'); // the watcher, once the copy stalls
                    expect(d.calls.uploads).toEqual([]);

                    await d.advance(1000);
                    appendFileSync(d.local('big.bin'), ' part 2;');
                    await d.changed('big.bin');
                    await d.engine.reconcileNow(); // a pass meanwhile leaves it alone too
                    expect(d.calls.uploads).toEqual([]);

                    await d.advance(3000); // stalled again, longer than the first wait
                    appendFileSync(d.local('big.bin'), ' part 3.');
                    await d.changed('big.bin');
                    await d.advance(4000);
                    expect(d.calls.uploads).toEqual([]); // seen growing twice: it waits longer each time

                    await d.advance(8000);
                    expect(d.calls.uploads).toEqual(['big.bin']);
                    expect([...d.nodes.values()].find((n) => n.parentUid === d.root.uid && d.nameOf(n) === 'big.bin')?.content).toBe(
                        'part 1; part 2; part 3.',
                    );
                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual(['big.bin']);
                    expect(d.pendingLooks()).toBe(0);
                });

                test('a file not in conflict that keeps changing still uploads once it has for 2 minutes', async () => {
                    const d = await started();
                    await d.files.writeLocal('busy.log', 'start\n');
                    for (let i = 1; i <= 130 && d.calls.uploads.length === 0; i++) {
                        appendFileSync(d.local('busy.log'), `line ${i}\n`);
                        await d.changed('busy.log');
                        await d.advance(1000);
                    }
                    expect(d.calls.uploads).toEqual(['busy.log']);
                });

                test('a file saved in one go uploads once, a couple of seconds after the save', async () => {
                    const d = await started();
                    await d.files.writeLocal('note.txt', 'saved');
                    await d.changed('note.txt');
                    expect(d.calls.uploads).toEqual([]);

                    await d.advance(2000);
                    expect(d.calls.uploads).toEqual(['note.txt']);
                    await d.changed('note.txt'); // a late watcher report changes nothing
                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual(['note.txt']);
                });

                const cloudNamed = (d: ReturnType<typeof setup>, name: string) =>
                    [...d.nodes.values()].filter((n) => n.parentUid === d.root.uid && d.nameOf(n) === name);
                const conflictCopies = (d: ReturnType<typeof setup>) =>
                    [...d.nodes.values()].filter((n) => n.parentUid === d.root.uid && d.nameOf(n).includes(' (conflict '));

                test('a new file where Proton Drive has another of that name meets the conflict handling once it settles', async () => {
                    const d = await started();
                    d.add('doc.txt', 'theirs'); // since the last listing: the root is pinned, and it would come down
                    await d.files.writeLocal('doc.txt', 'mine');
                    await d.changed('doc.txt');
                    await d.engine.reconcileNow();
                    expect(conflictCopies(d)).toEqual([]);

                    await d.advance(2000);
                    expect(conflictCopies(d).map((n) => n.content)).toEqual(['mine']);
                    expect(cloudNamed(d, 'doc.txt')[0]?.content).toBe('theirs');
                    expect(d.pendingLooks()).toBe(0);
                });

                // cp -a or rsync of files whose times are ahead (a camera's SD card, say): its own mtime never says it
                // settled, and the look that settles it must not schedule another
                test('a file with an mtime in the future settles, meets the conflict handling, and is not looked at again', async () => {
                    stateDb.updateSettings({ conflictStrategy: 'prompt' });
                    const d = await started();
                    d.add('extra.txt', 'theirs'); // since the last listing
                    await d.files.writeLocal('extra.txt', 'mine');
                    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
                    await utimes(d.local('extra.txt'), tomorrow, tomorrow);
                    await d.changed('extra.txt');

                    await d.advance(2000);
                    expect(stateDb.listConflicts().map((c) => c.localRelPath)).toEqual(['extra.txt']);
                    expect(d.pendingLooks()).toBe(0);
                    await d.engine.reconcileNow(); // a pass after: settled already, by its ctime
                    expect(d.pendingLooks()).toBe(0);
                    expect(d.calls.uploads).toEqual([]);
                });

                test('a file deleted while it waits uploads nothing, and is not looked at again', async () => {
                    const d = await started();
                    await d.files.writeLocal('gone.txt', 'half');
                    await d.changed('gone.txt');
                    await rm(d.local('gone.txt'));
                    await d.changed('gone.txt');
                    expect(d.pendingLooks()).toBe(0);

                    await d.advance(20_000);
                    expect(d.calls.uploads).toEqual([]);
                    expect(d.calls.trashed).toEqual([]);
                });

                test('a file renamed while it waits uploads once, under its new name', async () => {
                    const d = await started();
                    await d.files.writeLocal('draft.txt', 'text');
                    await d.changed('draft.txt');
                    await rename(d.local('draft.txt'), d.local('final.txt'));
                    await d.changed('draft.txt');
                    await d.changed('final.txt');

                    await d.advance(2000);
                    expect(d.calls.uploads).toEqual(['final.txt']);
                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual(['final.txt']);
                    expect(d.pendingLooks()).toBe(0);
                });

                test('after a restart, a file last changed longer ago than the wait uploads at the first look', async () => {
                    const d = await started({ quietMs: 50 });
                    await d.files.writeLocal('old.txt', 'written while the daemon was down');
                    await Bun.sleep(80); // by the system clock, as file times are; the settle clock is not moved

                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual(['old.txt']);
                    expect(d.pendingLooks()).toBe(0);
                });

                test('stop() calls off the looks, and waitForRunningLooks waits for one already running', async () => {
                    const d = await started();
                    await d.files.writeLocal('a.txt', 'a');
                    await d.changed('a.txt');
                    expect(d.pendingLooks()).toBe(1);
                    await d.engine.stop();
                    expect(d.pendingLooks()).toBe(0);

                    // A look whose upload is held: waitForRunningLooks returns only once it is done, or at its timeout
                    await d.engine.start({ backgroundInitialReconcile: false });
                    await d.files.writeLocal('b.txt', 'b');
                    await d.changed('b.txt');
                    const sdk = d.sdk as any;
                    const real = sdk.getFileUploader.bind(sdk);
                    let release!: () => void;
                    const held = new Promise<void>((resolve) => (release = resolve));
                    sdk.getFileUploader = async (...args: unknown[]) => {
                        await held;
                        return real(...args);
                    };
                    const looking = d.advance(2000);
                    await Bun.sleep(20);
                    await d.engine.stop(); // never waits for it (holdForMove does, within its timeout)
                    expect(await d.engine.waitForRunningLooks(20)).toBe(false);
                    let done = false;
                    const waiting = d.engine.waitForRunningLooks().then(() => (done = true));
                    await Bun.sleep(20);
                    expect(done).toBe(false);
                    release();
                    await Promise.all([looking, waiting]);
                    expect(done).toBe(true);
                    expect(d.calls.uploads).toContain('b.txt');
                });

                test('holdForMove still gives up after its timeout while a look is uploading', async () => {
                    const d = await started();
                    await d.files.writeLocal('big.bin', 'big');
                    await d.changed('big.bin');
                    const sdk = d.sdk as any;
                    const real = sdk.getFileUploader.bind(sdk);
                    let release!: () => void;
                    const held = new Promise<void>((resolve) => (release = resolve));
                    sdk.getFileUploader = async (...args: unknown[]) => {
                        await held;
                        return real(...args);
                    };
                    const looking = d.advance(2000);
                    await Bun.sleep(20);

                    const outcome = await Promise.race([
                        d.engine.holdForMove({ timeoutMs: 200 }).then(
                            () => 'held',
                            (e: Error) => e.message,
                        ),
                        Bun.sleep(1500).then(() => 'still waiting'),
                    ]);
                    expect(outcome).toBe('Proton Drive is still busy syncing; try again in a moment');
                    release();
                    await looking;
                    expect(d.calls.uploads).toEqual(['big.bin']);
                });

                test('waitForSettling (a one-off sync) waits for a file being written to upload, and says how many still wait', async () => {
                    const drive = makeMockDrive();
                    drive.add('Kept.txt', 'kept');
                    const backingDir = path.join(tempDir, 'files');
                    if (layout === 'virtual') {
                        stateDb.setMeta('driveLayout', 'virtual');
                    }
                    const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                        ...(layout === 'virtual' ? { backingDir, moveToDesktopTrash: async () => false } : {}),
                        settle: { quietMs: 100 }, // real timers
                    });
                    engine.availability.setPin(drive.root.uid, 'pinned', false);
                    await engine.reconcileNow();
                    await localFiles(stateDb, () => engine.localRoot()).writeLocal('new.txt', 'new');
                    await engine.reconcileNow();
                    expect(drive.calls.uploads).toEqual([]);

                    expect(await engine.waitForSettling(5000)).toBe(0);
                    expect(drive.calls.uploads).toEqual(['new.txt']);

                    // One that keeps changing outlasts a short wait: it is counted, and stop() calls its look off
                    appendFileSync(path.join(engine.localRoot(), 'new.txt'), ' more');
                    await (engine as any).handleLocalFileChange('new.txt');
                    expect(await engine.waitForSettling(10)).toBe(1);
                    await engine.stop();
                    expect(drive.calls.uploads).toEqual(['new.txt']);
                });

                test('a file that never stops changing still uploads after 2 minutes, and then at most every 2 minutes', async () => {
                    const d = await started();
                    await d.files.writeLocal('log.txt', 'line 0\n');
                    await d.changed('log.txt');
                    for (let second = 1; second <= 119; second++) {
                        await d.advance(1000);
                        appendFileSync(d.local('log.txt'), `line ${second}\n`);
                        await d.changed('log.txt');
                    }
                    expect(d.calls.uploads).toEqual([]);
                    await d.advance(1000);
                    appendFileSync(d.local('log.txt'), 'line 120\n');
                    await d.changed('log.txt');
                    expect(d.calls.uploads).toEqual(['log.txt']);

                    for (let second = 121; second <= 230; second++) {
                        await d.advance(1000);
                        appendFileSync(d.local('log.txt'), `line ${second}\n`);
                        await d.changed('log.txt');
                    }
                    expect(d.calls.uploads).toEqual(['log.txt']); // not again within 2 minutes
                    for (let second = 231; second <= 245; second++) {
                        await d.advance(1000);
                        appendFileSync(d.local('log.txt'), `line ${second}\n`);
                        await d.changed('log.txt');
                    }
                    expect(d.calls.uploads).toEqual(['log.txt', 'log.txt']);
                });

                test('an edit of a synced file waits the same way, and a file not changed since its sync never waits', async () => {
                    const d = await started();
                    expect(d.pendingLooks()).toBe(0); // Kept.txt, just downloaded, is as its record says
                    await d.files.writeLocal('Kept.txt', 'kept, half');
                    await d.engine.reconcileNow();
                    expect(d.calls.uploads).toEqual([]);
                    appendFileSync(d.local('Kept.txt'), ' and the rest');
                    await d.changed('Kept.txt');
                    expect(d.calls.uploads).toEqual([]);

                    await d.advance(4000);
                    expect(d.calls.uploads).toEqual(['Kept.txt']);
                    expect(d.nodes.get(d.uid('Kept.txt'))?.content).toBe('kept, half and the rest');
                    await d.engine.reconcileNow();
                    expect(d.pendingLooks()).toBe(0);
                });
            });
        }
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
            const shownToTrash: Array<string | undefined> = [];
            const moveToDesktopTrash = async (fullPath: string, shownPath?: string) => {
                handedToTrash.push(fullPath);
                shownToTrash.push(shownPath);
                if (!trashWorks) {
                    return false;
                }
                await mkdir(trashDir, { recursive: true });
                await rename(fullPath, path.join(trashDir, path.basename(fullPath)));
                return true;
            };
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                ...uploadAtOnce,
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
            // Where the Trash is told each came from: under the drive in the virtual layout (#40), nothing extra in the plain
            const shown = () => shownToTrash.map((p) => (p === undefined ? p : path.relative(stateDb.getSettings().syncDir, p))).sort();
            return { ...drive, engine, files: localFiles(stateDb, () => engine.localRoot()), local, trashDir, trashed, shown };
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
                    expect(d.shown()).toEqual(layout === 'virtual' ? ['Projects/app/.git', 'Projects/notes.txt'] : [undefined, undefined]);
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
                await d.files.writeLocal(what === 'file' ? made : `${made}/a.txt`, 'only here');
                const localChange: Promise<void> = (d.engine as any).handleLocalFileChange(made);
                await uploading;
                // Deleted in the cloud while the upload's answer is on its way (deleted before it starts, the folder isn't
                // made again for it: #161)
                goneFromCloud(d, 'Projects');

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
                ...uploadAtOnce,
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

    // A recorded file on both sides: whether the cloud changed since the record, and the keep-both conflict handling
    describe('a recorded file changed on both sides', () => {
        // Docs/doc.txt downloaded through the engine (pinned), so its record is real; withoutChecksum makes its cloud node
        // one another client uploaded with no claimed SHA1
        const synced = async (layout: 'plain' | 'virtual', withoutChecksum = false) => {
            if (layout === 'virtual') {
                stateDb.setMeta('driveLayout', 'virtual');
            }
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                ...uploadAtOnce,
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
            });
            drive.add('Docs/doc.txt', 'old');
            const stripChecksum = (uid: string) => {
                const node = drive.nodes.get(uid)!;
                drive.nodes.set(uid, { ...node, activeRevision: { ...node.activeRevision!, claimedDigests: undefined } } as any);
            };
            if (withoutChecksum) {
                stripChecksum('vol~Docs/doc.txt');
            }
            engine.availability.setPin(drive.root.uid, 'pinned', false);
            await engine.reconcileNow();
            expect(drive.calls.downloads).toEqual(['Docs/doc.txt']);
            drive.calls.downloads.length = 0;
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            // Another device's new revision: a later time, and a new size and content (with no claimed SHA1 if asked)
            const changeInCloud = (content: string, checksum = true) => {
                const node = drive.nodes.get('vol~Docs/doc.txt')!;
                const later = new Date(node.modificationTime.getTime() + 60_000);
                drive.nodes.set(
                    node.uid,
                    makeMockNode({ uid: node.uid, parentUid: node.parentUid, nameStr: 'doc.txt', type: NodeType.File, content, modificationTime: later }),
                );
                const changed = drive.nodes.get(node.uid)!;
                drive.nodes.set(node.uid, { ...changed, activeRevision: { ...changed.activeRevision!, claimedModificationTime: later } });
                if (!checksum) {
                    stripChecksum(node.uid);
                }
            };
            const copiesIn = async (dir: string) => (await readdir(local(dir))).filter((n) => n.startsWith('doc (conflict ')).sort();
            const cloudCopies = () =>
                [...drive.nodes.values()].filter((n) => n.parentUid === 'vol~Docs' && drive.nameOf(n).startsWith('doc (conflict '));
            return { ...drive, engine, local, changeInCloud, copiesIn, cloudCopies };
        };

        // #63: in the plain layout, a file deleted here while its conflict waits for the user (prompt) is this computer's
        // side going away: the other device's revision stays in the cloud, as through the drive (#29)
        describe('deleted here while its conflict waits for the user (#63)', () => {
            const queued = async () => {
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const d = await synced('plain');
                d.changeInCloud('theirs');
                await writeFile(d.local('Docs/doc.txt'), 'mine');
                await d.engine.reconcileNow();
                expect(stateDb.listConflicts().map((c) => c.localRelPath)).toEqual(['Docs/doc.txt']);
                expect(stateDb.getItemByPath('Docs/doc.txt')?.syncStatus).toBe('conflict');
                return d;
            };
            const expectTheirsKept = async (d: Awaited<ReturnType<typeof queued>>) => {
                expect(d.calls.trashed).toEqual([]);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(stateDb.listConflicts()).toEqual([]);
                expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-remote']);
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
                // The cloud's version comes down in its place (the root is pinned)
                expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
            };

            test('reported by the watcher, it keeps the cloud file and the conflict ends as keep-remote', async () => {
                const d = await queued();
                await rm(d.local('Docs/doc.txt'));
                await (d.engine as any).handleLocalFileChange('Docs/doc.txt');
                await expectTheirsKept(d);
            });

            test('found by a pass, the same', async () => {
                const d = await queued();
                await rm(d.local('Docs/doc.txt'));
                await d.engine.reconcileNow();
                await expectTheirsKept(d);
            });

            test('with its folder deleted, the rest of the folder goes to the Proton Drive trash, never that file', async () => {
                const d = await queued();
                d.add('Docs/other.txt', 'o');
                d.add('Kept.txt', 'k'); // so that Docs gone isn't every file missing from the folder (#45)
                await d.engine.reconcileNow();
                expect(await readFile(d.local('Docs/other.txt'), 'utf8')).toBe('o');
                await rm(d.local('Docs'), { recursive: true });
                await d.engine.reconcileNow();
                expect(d.calls.trashed.flat()).toEqual(['vol~Docs/other.txt']);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(stateDb.listConflicts()).toEqual([]);
            });
        });

        for (const layout of ['plain', 'virtual'] as const) {
            describe(`in the ${layout} layout`, () => {
                // #24: with no SHA1 on either side, the record and the cloud are compared by claimed time and size
                describe('with no checksum on either side (#24)', () => {
                    // As a record made from what the remote index knows of such a node (a file replaced through the
                    // drive) has it: no SHA1 for the cloud side
                    const withRecordWithoutChecksum = async () => {
                        const d = await synced(layout, true);
                        const record = stateDb.getItemByPath('Docs/doc.txt')!;
                        stateDb.upsertItem({ ...record, remoteSha1: null });
                        return d;
                    };

                    test("another device's edit comes down", async () => {
                        const d = await withRecordWithoutChecksum();
                        d.changeInCloud('theirs!', false);

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs!');
                        expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs!');
                        expect(d.calls.uploads).toEqual([]);
                        expect(d.calls.trashed).toEqual([]);
                    });

                    test('a local edit after it is a conflict, never uploaded over it', async () => {
                        const d = await withRecordWithoutChecksum();
                        d.changeInCloud('theirs!', false);
                        await writeFile(d.local('Docs/doc.txt'), 'mine');

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs!');
                        expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                        expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs!');
                        const copies = d.cloudCopies();
                        expect(copies.length).toBe(1);
                        expect(copies[0]?.content).toBe('mine');
                        expect(d.calls.trashed).toEqual([]);
                    });

                    test('unchanged in the cloud, nothing comes down, and a local edit uploads as a new revision', async () => {
                        const d = await withRecordWithoutChecksum();
                        await d.engine.reconcileNow();
                        expect(d.calls.downloads).toEqual([]);
                        expect(d.calls.uploads).toEqual([]);

                        await writeFile(d.local('Docs/doc.txt'), 'mine');
                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('mine');
                        expect(d.calls.uploads).toEqual(['Docs/doc.txt']);
                        expect(d.calls.downloads).toEqual([]);
                        expect(d.cloudCopies()).toEqual([]);
                    });
                });

                // A record keeps what the cloud claims, never a SHA1 computed here in place of one it doesn't claim: a
                // node with none then reads as unchanged until its time or size change (#24 follow-up)
                describe('downloaded from a cloud node with no checksum', () => {
                    test('the record keeps no SHA1 for the cloud side, and later passes bring nothing more down', async () => {
                        const d = await synced(layout, true);
                        expect(stateDb.getItemByPath('Docs/doc.txt')?.remoteSha1).toBeNull();
                        expect(stateDb.getItemByPath('Docs/doc.txt')?.localSha1).toHaveLength(40);

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(d.calls.downloads).toEqual([]);
                        expect(d.calls.uploads).toEqual([]);
                    });

                    test('a local edit uploads as a new revision, not a conflict', async () => {
                        const d = await synced(layout, true);
                        await writeFile(d.local('Docs/doc.txt'), 'mine');

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('mine');
                        expect(d.calls.uploads).toEqual(['Docs/doc.txt']);
                        expect(d.calls.downloads).toEqual([]);
                        expect(d.cloudCopies()).toEqual([]);
                    });

                    test("another device's edit (a new time and size, still with no checksum) comes down once", async () => {
                        const d = await synced(layout, true);
                        d.changeInCloud('theirs!', false);

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs!');
                        expect(d.calls.downloads).toEqual(['Docs/doc.txt']);
                        expect(d.calls.uploads).toEqual([]);
                    });

                    test('a new time alone in the cloud is a change too', async () => {
                        const d = await synced(layout, true);
                        const node = d.nodes.get('vol~Docs/doc.txt')!;
                        const later = new Date(node.modificationTime.getTime() + 60_000);
                        d.nodes.set(node.uid, {
                            ...node,
                            content: 'new',
                            modificationTime: later,
                            activeRevision: { ...node.activeRevision!, claimedModificationTime: later },
                        });

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('new');
                        expect(d.calls.downloads).toEqual(['Docs/doc.txt']);
                    });

                    test('with no claimed size either, later passes still bring nothing more down', async () => {
                        const d = await synced(layout, true);
                        const node = d.nodes.get('vol~Docs/doc.txt')!;
                        d.nodes.set(node.uid, { ...node, activeRevision: { ...node.activeRevision!, claimedSize: undefined } } as any);

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(d.calls.downloads).toEqual([]);
                        expect(d.calls.uploads).toEqual([]);
                    });

                    test('its unchanged local copy can still be freed', async () => {
                        const d = await synced(layout, true);

                        const result = await d.engine.setAvailability('Docs/doc.txt', 'free');

                        expect(result.kept).toEqual([]);
                        expect(await stat(d.local('Docs/doc.txt')).then(() => true, () => false)).toBe(false);
                        expect(d.calls.trashed).toEqual([]);
                    });
                });

                // The common case stays as it was: with a SHA1 on both sides, the SHA1 alone decides
                describe('with a checksum on both sides', () => {
                    test('a new time in the cloud for the same content brings nothing down, and a local edit uploads', async () => {
                        const d = await synced(layout);
                        const node = d.nodes.get('vol~Docs/doc.txt')!;
                        const later = new Date(node.modificationTime.getTime() + 60_000);
                        d.nodes.set(node.uid, {
                            ...node,
                            modificationTime: later,
                            activeRevision: { ...node.activeRevision!, claimedModificationTime: later },
                        });

                        await d.engine.reconcileNow();
                        expect(d.calls.downloads).toEqual([]);
                        expect(d.calls.uploads).toEqual([]);

                        await writeFile(d.local('Docs/doc.txt'), 'mine');
                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('mine');
                        expect(d.calls.uploads).toEqual(['Docs/doc.txt']);
                        expect(d.calls.downloads).toEqual([]);
                        expect(d.cloudCopies()).toEqual([]);
                    });

                    test("another device's edit comes down once", async () => {
                        const d = await synced(layout);
                        d.changeInCloud('theirs!');

                        await d.engine.reconcileNow();
                        await d.engine.reconcileNow();

                        expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs!');
                        expect(d.calls.downloads).toEqual(['Docs/doc.txt']);
                        expect(d.calls.uploads).toEqual([]);
                    });
                });

                // #67: what is written to the local file after keep-both took its copy (it was still being written) must
                // not be lost under the cloud's version
                test('keep-both never puts the cloud version over local content written after its copy (#67)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    // Written to again while the cloud version downloads
                    const sdk = d.sdk as any;
                    const real = sdk.getFileRevisionDownloader.bind(sdk);
                    sdk.getFileRevisionDownloader = async (revisionUid: string) => {
                        appendFileSync(d.local('Docs/doc.txt'), ' and more');
                        sdk.getFileRevisionDownloader = real;
                        return real(revisionUid);
                    };

                    await d.engine.reconcileNow();
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine and more');
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');

                    // The next pass keeps both again, from what the file holds now
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                    const copies = await d.copiesIn('Docs');
                    const contents = await Promise.all(copies.map((c) => readFile(d.local(`Docs/${c}`), 'utf8')));
                    expect(contents).toContain('mine and more');
                    expect(d.cloudCopies().map((n) => n.content)).toContain('mine and more');
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                });

                test('keep-both of a file that keeps changing leaves no pile of conflict copies, one per try (#67)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    // Written to again during every download of the cloud version, until it stops
                    const sdk = d.sdk as any;
                    const real = sdk.getFileRevisionDownloader.bind(sdk);
                    let writing = true;
                    let line = 0;
                    sdk.getFileRevisionDownloader = async (revisionUid: string) => {
                        if (writing) {
                            appendFileSync(d.local('Docs/doc.txt'), ` ${++line}`);
                        }
                        return real(revisionUid);
                    };

                    for (let pass = 0; pass < 5; pass++) {
                        await d.engine.reconcileNow();
                    }
                    expect(await d.copiesIn('Docs')).toEqual([]);
                    expect(d.cloudCopies()).toEqual([]);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine 1 2 3 4 5');

                    writing = false;
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                    expect(d.cloudCopies().map((n) => n.content)).toEqual(['mine 1 2 3 4 5']);
                    expect((await d.copiesIn('Docs')).length).toBe(1);
                });

                // #25: a keep-both whose download of the cloud version fails makes its conflict copy once
                test('keep-both makes one conflict copy while the cloud version fails to download, then brings it down (#25)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.down.add('getFileRevisionDownloader'); // offline for downloads, pass after pass

                    for (let pass = 0; pass < 3; pass++) {
                        await d.engine.reconcileNow();
                    }
                    expect(await d.copiesIn('Docs')).toHaveLength(1);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('mine');
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');

                    d.down.delete('getFileRevisionDownloader');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                    const copies = await d.copiesIn('Docs');
                    expect(copies).toHaveLength(1);
                    expect(await readFile(d.local(`Docs/${copies[0]}`), 'utf8')).toBe('mine');
                    expect(d.cloudCopies().map((n) => [d.nameOf(n), n.content])).toEqual([[copies[0], 'mine']]);
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                    expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                    expect(d.calls.trashed).toEqual([]);
                    const resolved = stateDb.listConflicts(true).filter((c) => c.localRelPath === 'Docs/doc.txt');
                    expect(resolved.map((c) => c.conflictCopyPath)).toEqual([`Docs/${copies[0]}`]);
                });

                test('a retry while fully offline uploads the copy it made, and makes no other (#25)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.down.add('getFileRevisionDownloader');
                    d.down.add('getFileUploader');

                    for (let pass = 0; pass < 3; pass++) {
                        await d.engine.reconcileNow();
                    }
                    expect(await d.copiesIn('Docs')).toHaveLength(1);
                    expect(d.cloudCopies()).toEqual([]);

                    d.down.clear();
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    const copies = await d.copiesIn('Docs');
                    expect(copies).toHaveLength(1);
                    expect(d.cloudCopies().map((n) => [d.nameOf(n), n.content])).toEqual([[copies[0], 'mine']]);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                    expect(d.calls.trashed).toEqual([]);
                });

                test('a copy edited in the cloud while the download fails is left as it is, and a new copy keeps the local version (#25)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.down.add('getFileRevisionDownloader');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    const [made] = d.cloudCopies();
                    expect(made?.content).toBe('mine'); // uploaded by a pass, as a new local file
                    d.nodes.set(made!.uid, makeMockNode({ uid: made!.uid, parentUid: 'vol~Docs', nameStr: d.nameOf(made!), type: NodeType.File, content: 'their edit' }));

                    d.down.clear();
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(d.calls.trashed).toEqual([]);
                    expect(d.nodes.get(made!.uid)?.content).toBe('their edit');
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                    const cloud = d.cloudCopies().map((n) => n.content);
                    expect(cloud.sort()).toEqual(['mine', 'their edit']);
                });

                test('a copy deleted in the cloud while the download fails is not taken for the copy: a new one keeps the local version (#25)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.down.add('getFileRevisionDownloader');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    const [made] = d.cloudCopies();
                    expect(made?.content).toBe('mine');
                    d.nodes.delete(made!.uid); // another device deletes it

                    d.down.clear();
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(d.calls.trashed).toEqual([]);
                    expect(d.nodes.has(made!.uid)).toBe(false);
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
                    const cloud = d.cloudCopies();
                    expect(cloud.map((n) => n.content)).toEqual(['mine']);
                    expect(cloud[0]?.uid).not.toBe(made!.uid);
                    expect(await d.copiesIn('Docs')).toEqual([d.nameOf(cloud[0]!)]);
                });

                test('a conflict resolved another way forgets its copy: a later conflict of the same content makes its own (#25)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.down.add('getFileRevisionDownloader');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    const [made] = d.cloudCopies();
                    expect(made?.content).toBe('mine'); // the keep-both's copy, uploaded by a pass, its download still to come

                    // Resolved by hand, keeping the local version, instead
                    stateDb.updateSettings({ conflictStrategy: 'prompt' });
                    d.down.clear();
                    await d.engine.reconcileNow();
                    const [conflict] = stateDb.listConflicts().filter((c) => c.localRelPath === 'Docs/doc.txt');
                    await d.engine.resolveConflictManually(conflict!.id, 'keep-local');
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('mine');
                    await writeFile(d.local('Docs/doc.txt'), 'other');
                    await d.engine.reconcileNow();

                    // A later conflict, with the same local content as the first
                    stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.changeInCloud('theirs again');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs again');
                    const mine = d.cloudCopies().filter((n) => n.content === 'mine');
                    expect(mine).toHaveLength(2);
                    const latest = stateDb.listConflicts(true).find((c) => c.resolution === 'keep-both');
                    expect(latest?.conflictCopyPath).toBeDefined();
                    expect(latest?.conflictCopyPath).not.toBe(`Docs/${d.nameOf(made!)}`);
                    expect(d.calls.trashed).toEqual([]);
                });

                // Review of #25: the copy an earlier, finished conflict made (synced, and since edited in the cloud by
                // another device) is never taken for this conflict's copy: nothing renames it, and nothing trashes it
                test('a later keep-both never takes the synced copy of an earlier conflict for its own (#25 review)', async () => {
                    const d = await synced(layout);
                    d.changeInCloud('theirs');
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    const [first] = await d.copiesIn('Docs');
                    expect(first).toBeDefined();
                    expect(d.cloudCopies().map((n) => d.nameOf(n))).toEqual([first!]);

                    // A second conflict, left to the user, with the same local content as the first
                    stateDb.updateSettings({ conflictStrategy: 'prompt' });
                    await writeFile(d.local('Docs/doc.txt'), 'mine');
                    d.changeInCloud('theirs again');
                    await d.engine.reconcileNow();
                    const [conflict] = stateDb.listConflicts().filter((c) => c.localRelPath === 'Docs/doc.txt');
                    expect(conflict).toBeDefined();

                    // Another device edits the first conflict's copy in the cloud
                    const firstCopy = d.cloudCopies()[0]!;
                    d.nodes.set(
                        firstCopy.uid,
                        makeMockNode({ uid: firstCopy.uid, parentUid: 'vol~Docs', nameStr: first!, type: NodeType.File, content: 'their edit of the copy' }),
                    );

                    await d.engine.resolveConflictManually(conflict!.id, 'keep-both');
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(d.calls.trashed).toEqual([]);
                    expect(d.nodes.get(firstCopy.uid)?.content).toBe('their edit of the copy');
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs again');
                    expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs again');
                    const cloud = d.cloudCopies().map((n) => [d.nameOf(n), n.content]);
                    expect(cloud).toHaveLength(2);
                    expect(cloud).toContainEqual([first!, 'their edit of the copy']);
                    expect(cloud.filter(([, content]) => content === 'mine')).toHaveLength(1);
                });
            });
        }
    });

    // #18: an item that fails is marked and retried next pass; the pass goes on with everything else
    describe('an item that fails in a sync pass (#18)', () => {
        const withFailingDownload = async (layout: 'plain' | 'virtual', failure: () => Error) => {
            if (layout === 'virtual') {
                stateDb.setMeta('driveLayout', 'virtual');
            }
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                ...uploadAtOnce,
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
            });
            const a = drive.add('A');
            drive.add('A/bad.txt', 'bad');
            drive.add('A/fine.txt', 'fine');
            const b = drive.add('B');
            drive.add('B/good.txt', 'good');
            drive.add('Z/Deep/x.txt', 'x'); // online-only
            engine.availability.setPin(a.uid, 'pinned', false);
            engine.availability.setPin(b.uid, 'pinned', false);
            let failing = true;
            let tries = 0;
            let currentFailure = failure;
            const real = (drive.sdk as any).getFileRevisionDownloader;
            (drive.sdk as any).getFileRevisionDownloader = async (revisionUid: string) => {
                if (failing && revisionUid.startsWith('vol~A/bad.txt')) {
                    tries += 1;
                    throw currentFailure();
                }
                return real(revisionUid);
            };
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            const exists = (rel: string) => stat(local(rel)).then(() => true, () => false);
            return {
                ...drive,
                engine,
                local,
                exists,
                heal: () => (failing = false),
                tries: () => tries,
                failWith: (next: () => Error) => (currentFailure = next),
            };
        };
        let now = Date.parse('2026-11-02T08:00:00Z');
        const later = (ms: number) => {
            now += ms;
            setSystemTime(now);
        };
        beforeEach(() => setSystemTime(now));
        afterEach(() => setSystemTime());
        const errorsFor = (rel: string) => stateDb.listActivity(500).filter((a) => a.action === 'error' && a.localRelPath === rel);

        for (const layout of ['plain', 'virtual'] as const) {
            describe(`in the ${layout} layout`, () => {
                test('a download that keeps failing is marked and retried, while the pass syncs everything else', async () => {
                    const d = await withFailingDownload(layout, () => new Error('Integrity check failed'));

                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(await readFile(d.local('A/fine.txt'), 'utf8')).toBe('fine');
                    expect(await readFile(d.local('B/good.txt'), 'utf8')).toBe('good');
                    expect(await d.exists('A/bad.txt')).toBe(false);
                    expect(d.engine.remoteIndex.getByPath('Z/Deep/x.txt')).not.toBeNull(); // the crawl still ran
                    const status = d.engine.getStatus();
                    expect(status.state).toBe('error');
                    expect(status.lastError).toContain('A/bad.txt');
                    const failures = stateDb.listActivity(100).filter((a) => a.action === 'error' && a.localRelPath === 'A/bad.txt');
                    expect(failures.length).toBeGreaterThan(0);
                    expect(d.calls.trashed).toEqual([]);

                    d.heal();
                    later(2 * 60_000); // past its backoff
                    await d.engine.reconcileNow();

                    expect(await readFile(d.local('A/bad.txt'), 'utf8')).toBe('bad');
                    expect(d.engine.getStatus().state).toBe('idle');
                    expect(d.engine.getStatus().lastError).toBeNull();
                    expect(d.calls.trashed).toEqual([]);
                });

                test('a request refused for that item alone (an HTTP 4xx) fails only that item', async () => {
                    const d = await withFailingDownload(layout, () => new APIHTTPError('Forbidden', 403));

                    await d.engine.reconcileNow();

                    expect(await readFile(d.local('B/good.txt'), 'utf8')).toBe('good');
                    expect(d.engine.getStatus().lastError).toContain('A/bad.txt');
                    expect(d.calls.trashed).toEqual([]);
                });

                test('an item that keeps failing is logged once, until its error changes', async () => {
                    const d = await withFailingDownload(layout, () => new Error('Integrity check failed'));
                    for (let pass = 0; pass < 4; pass++) {
                        await d.engine.reconcileNow();
                        later(2 * 60 * 60_000); // past any backoff
                    }
                    expect(d.tries()).toBe(4);
                    expect(errorsFor('A/bad.txt')).toHaveLength(1);

                    d.failWith(() => new Error('Decryption failed'));
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();

                    expect(errorsFor('A/bad.txt').map((a) => a.details.includes('Decryption failed'))).toEqual([true, false]);
                });

                test('an item that keeps failing backs off, 1 minute doubling up to an hour, and still shows as failing', async () => {
                    const d = await withFailingDownload(layout, () => new Error('Integrity check failed'));
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    expect(d.tries()).toBe(1);
                    expect(d.engine.getStatus().lastError).toContain('A/bad.txt');
                    expect(await readFile(d.local('B/good.txt'), 'utf8')).toBe('good');

                    later(61_000);
                    await d.engine.reconcileNow();
                    expect(d.tries()).toBe(2);
                    later(61_000); // its second failure waits 2 minutes
                    await d.engine.reconcileNow();
                    expect(d.tries()).toBe(2);
                    later(60_000);
                    await d.engine.reconcileNow();
                    expect(d.tries()).toBe(3);

                    for (let i = 0; i < 10; i++) {
                        later(61 * 60_000); // never more than an hour apart
                        await d.engine.reconcileNow();
                    }
                    expect(d.tries()).toBe(13);
                });

                test('a local change to an item backing off has it looked at again at once', async () => {
                    const d = await withFailingDownload(layout, () => new Error('Integrity check failed'));
                    await d.engine.reconcileNow();
                    expect(d.tries()).toBe(1);

                    await (d.engine as any).handleLocalFileChange('A/bad.txt');
                    await d.engine.reconcileNow();

                    expect(d.tries()).toBe(2);
                });

                // Review of #18: an unmapped API code can be that one item's (an outage ends the pass through the SDK's
                // plain ServerError once its requests keep failing)
                test('an unmapped API code for one item fails only that item', async () => {
                    const d = await withFailingDownload(layout, () => new APICodeError('Unknown', 98765));

                    await d.engine.reconcileNow();

                    expect(await readFile(d.local('A/fine.txt'), 'utf8')).toBe('fine');
                    expect(await readFile(d.local('B/good.txt'), 'utf8')).toBe('good');
                    expect(d.engine.getStatus().lastError).toContain('A/bad.txt');
                    expect(d.calls.trashed).toEqual([]);
                });

                test('a folder whose listing keeps failing backs off and is logged once', async () => {
                    const d = await withFailingDownload(layout, () => new Error('unused'));
                    d.heal();
                    let listingsOfA = 0;
                    const iterate = (d.sdk as any).iterateFolderChildren;
                    (d.sdk as any).iterateFolderChildren = (parent: NodeEntity | string) => {
                        if ((typeof parent === 'string' ? parent : parent.uid) === 'vol~A') {
                            listingsOfA += 1;
                        }
                        return iterate(parent);
                    };
                    d.failListing.add('vol~A');

                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    expect(listingsOfA).toBe(1);
                    expect(await readFile(d.local('B/good.txt'), 'utf8')).toBe('good');
                    expect(d.engine.getStatus().lastError).toContain('A');

                    for (let pass = 0; pass < 3; pass++) {
                        later(2 * 60 * 60_000);
                        await d.engine.reconcileNow();
                    }
                    expect(listingsOfA).toBe(4);
                    expect(errorsFor('A')).toHaveLength(1);
                });

                test('offline, the pass still stops at the first failure rather than fail every item', async () => {
                    const d = await withFailingDownload(layout, () => new ConnectionError('Network unreachable'));

                    await d.engine.reconcileNow();

                    expect(d.engine.getStatus().state).toBe('error');
                    expect(await d.exists('B/good.txt')).toBe(false);
                    expect(d.calls.downloads).not.toContain('B/good.txt');
                    expect(d.calls.trashed).toEqual([]);
                });
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
                    ...uploadAtOnce,
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

        // #39: a refusal the SDK doesn't map (an APICodeError, or an APIHTTPError with a 4xx) never stalls the journal
        describe('an operation Proton Drive keeps refusing (#39)', () => {
            const refusing = async (error: () => Error) => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                await d.engine.reconcileNow();
                const rename = (d.sdk as any).renameNode;
                let refusals = 0;
                (d.sdk as any).renameNode = async (uid: string, name: string) => {
                    if (uid === 'vol~Docs/a.txt') {
                        refusals += 1;
                        throw error();
                    }
                    return rename(uid, name);
                };
                await d.engine.renameItem('Docs/a.txt', 'Docs/a2.txt');
                await d.engine.renameItem('Docs/b.txt', 'Docs/b2.txt'); // later, and independent of it
                return { ...d, refusals: () => refusals };
            };

            for (const [kind, error, tries] of [
                ['an HTTP 4xx', () => new APIHTTPError('Unprocessable Entity', 422), 3],
                // The 2xxx family of API codes are validation refusals, which don't change
                ['an API code of the 2xxx validation family', () => new APICodeError('Operation not allowed', 2061), 3],
            ] as const) {
                test(`refused with ${kind}, it is given up on after ${tries} tries, the user told once, and later operations go on`, async () => {
                    const d = await refusing(error);

                    for (let i = 0; i < tries + 3; i++) {
                        await d.engine.replayRemoteOps();
                    }

                    expect(d.refusals()).toBe(tries);
                    expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/b.txt', name: 'b2.txt' }]);
                    expect(d.journal()).toEqual([]);
                    const told = activity().filter((a) => a.includes('Docs/a2.txt') && a.includes('given up on'));
                    expect(told).toHaveLength(1);

                    // The next sync follows what Proton Drive has: the item is back under its old name, nothing lost
                    await d.engine.reconcileNow();
                    expect(d.engine.remoteIndex.getByPath('Docs/a.txt')?.uid).toBe('vol~Docs/a.txt');
                    expect(d.engine.remoteIndex.getByPath('Docs/a2.txt')).toBeNull();
                    expect(d.engine.remoteIndex.getByPath('Docs/b2.txt')?.uid).toBe('vol~Docs/b.txt');
                    expect(d.nodes.has('vol~Docs/a.txt')).toBe(true);
                    expect(d.calls.trashed).toEqual([]);
                });
            }

            // An API code outside the 2xxx family may be what a 5xx outage or an expired session answers with (the SDK
            // keeps no HTTP status with it): only a day of failing gives it up
            describe('refused with an API code outside the 2xxx family, which a server outage can answer with', () => {
                afterEach(() => setSystemTime());

                test('it is still tried after many tries and over an hour, keeping the order', async () => {
                    let now = Date.parse('2026-11-02T08:00:00Z');
                    setSystemTime(now);
                    const d = await refusing(() => new APICodeError('Service unavailable', 503));

                    for (let i = 0; i < 30; i++) {
                        now += 3 * 60_000;
                        setSystemTime(now);
                        await d.engine.replayRemoteOps();
                    }

                    expect(d.refusals()).toBeGreaterThanOrEqual(5); // with backoff, never given up on
                    expect(d.journal().map((op) => (op.kind === 'trash' ? op.path : op.toPath))).toEqual(['Docs/a2.txt', 'Docs/b2.txt']);
                    expect(d.calls.renamed).toEqual([]);
                    expect(activity().filter((a) => a.includes('given up on'))).toEqual([]);
                });

                test('it is retried with backoff, not on every replay', async () => {
                    const now = Date.parse('2026-11-02T08:00:00Z');
                    setSystemTime(now);
                    const d = await refusing(() => new APICodeError('Service unavailable', 503));
                    for (let i = 0; i < 10; i++) {
                        await d.engine.replayRemoteOps(); // all at the same moment
                    }
                    expect(d.refusals()).toBeLessThanOrEqual(3);
                });

                test('it is given up on after a day of failing, the user told once, and later operations go on', async () => {
                    let now = Date.parse('2026-11-02T08:00:00Z');
                    setSystemTime(now);
                    const d = await refusing(() => new APICodeError('Unknown', 98765));

                    for (let hour = 0; hour < 23; hour++) {
                        now += 60 * 60_000;
                        setSystemTime(now);
                        await d.engine.replayRemoteOps();
                    }
                    expect(d.journal()).toHaveLength(2);
                    for (let i = 0; i < 3; i++) {
                        now += 60 * 60_000;
                        setSystemTime(now);
                        await d.engine.replayRemoteOps();
                    }

                    expect(d.journal()).toEqual([]);
                    expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/b.txt', name: 'b2.txt' }]);
                    expect(activity().filter((a) => a.includes('Docs/a2.txt') && a.includes('given up on'))).toHaveLength(1);
                    expect(d.calls.trashed).toEqual([]);
                });
            });

            // Review of #39: the day counts only unmapped-code failures in a row, never time spent offline
            describe('the day an unmapped API code is given', () => {
                afterEach(() => setSystemTime());
                const refusingWith = async () => {
                    let now = Date.parse('2026-11-02T08:00:00Z');
                    setSystemTime(now);
                    let next: () => Error = () => new ConnectionError('Network unreachable');
                    const d = await refusing(() => next());
                    return {
                        ...d,
                        answer: (error: () => Error) => (next = error),
                        at: (ms: number) => {
                            now += ms;
                            setSystemTime(now);
                        },
                    };
                };

                test('two days offline, then one unmapped-code blip, gives nothing up', async () => {
                    const d = await refusingWith();
                    for (let hour = 0; hour < 48; hour++) {
                        d.at(60 * 60_000);
                        await d.engine.replayRemoteOps();
                    }
                    d.answer(() => new APICodeError('Service unavailable', 503));
                    d.at(60_000);
                    await d.engine.replayRemoteOps();

                    expect(d.journal()).toHaveLength(2);
                    expect(activity().filter((a) => a.includes('given up on'))).toEqual([]);
                });

                test('an unmapped code after other failures starts its day afresh', async () => {
                    const d = await refusingWith();
                    d.answer(() => new APICodeError('Service unavailable', 503));
                    for (let hour = 0; hour < 20; hour++) {
                        d.at(60 * 60_000);
                        await d.engine.replayRemoteOps();
                    }
                    d.answer(() => new APIHTTPError('Bad Gateway', 502)); // a failure of another kind ends the run
                    d.at(60 * 60_000);
                    await d.engine.replayRemoteOps();
                    d.answer(() => new APICodeError('Service unavailable', 503));
                    for (let hour = 0; hour < 10; hour++) {
                        d.at(60 * 60_000);
                        await d.engine.replayRemoteOps();
                    }

                    expect(d.journal()).toHaveLength(2);
                    expect(activity().filter((a) => a.includes('given up on'))).toEqual([]);
                });

                test('a day with fewer than 5 unmapped-code tries gives nothing up yet; the 5th does', async () => {
                    const d = await refusingWith();
                    d.answer(() => new APICodeError('Unknown', 98765));
                    d.at(60_000);
                    await d.engine.replayRemoteOps(); // 1st
                    d.at(25 * 60 * 60_000); // asleep for a day
                    await d.engine.replayRemoteOps(); // 2nd
                    d.at(2 * 60 * 60_000);
                    await d.engine.replayRemoteOps(); // 3rd
                    d.at(2 * 60 * 60_000);
                    await d.engine.replayRemoteOps(); // 4th
                    expect(d.journal()).toHaveLength(2);

                    d.at(2 * 60 * 60_000);
                    await d.engine.replayRemoteOps(); // 5th

                    expect(d.journal()).toEqual([]);
                    expect(d.calls.renamed).toEqual([{ uid: 'vol~Docs/b.txt', name: 'b2.txt' }]);
                    expect(activity().filter((a) => a.includes('Docs/a2.txt') && a.includes('given up on'))).toHaveLength(1);
                });
            });

            test('refused with an HTTP 401 (a session that expired), it is never given up on quickly', async () => {
                const d = await refusing(() => new APIHTTPError('Unauthorized', 401));

                for (let i = 0; i < 12; i++) {
                    await d.engine.replayRemoteOps();
                }

                expect(d.journal()).toHaveLength(2);
                expect(d.calls.renamed).toEqual([]);
                expect(activity().filter((a) => a.includes('given up on'))).toEqual([]);
            });

            test('a rename of a file kept on this computer, given up on, puts its local copy back under the old name', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                await pinnedAndSynced(d, d.nodes.get('vol~Docs')!.uid);
                (d.sdk as any).renameNode = async () => {
                    throw new APICodeError('Operation not allowed', 2061);
                };
                await d.engine.renameItem('Docs/a.txt', 'Docs/a2.txt');
                for (let i = 0; i < 12; i++) {
                    await d.engine.replayRemoteOps();
                }
                expect(d.journal()).toEqual([]);

                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
                expect(await d.files.exists('Docs/a2.txt')).toBe(false);
                expect(stateDb.getItemByPath('Docs/a.txt')?.nodeUid).toBe('vol~Docs/a.txt');
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                await d.expectEveryRecordHasItsFile();
            });

            test('a delete given up on brings the item back, never losing it', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                await d.engine.reconcileNow();
                (d.sdk as any).trashNodes = async function* (uids: string[]) {
                    for (const uid of uids) yield { uid, ok: false as const, error: new APIHTTPError('Forbidden', 403) };
                };
                await d.engine.deleteItem('Docs/a.txt');
                expect(d.engine.remoteIndex.getByPath('Docs/a.txt')).toBeNull();
                for (let i = 0; i < 4; i++) {
                    await d.engine.replayRemoteOps();
                }

                expect(d.journal()).toEqual([]);
                expect(d.nodes.has('vol~Docs/a.txt')).toBe(true);
                expect(d.engine.remoteIndex.getByPath('Docs/a.txt')?.uid).toBe('vol~Docs/a.txt');
                expect(activity().filter((a) => a.includes('Docs/a.txt') && a.includes('given up on'))).toHaveLength(1);
            });

            test('refused with an HTTP 5xx, it stays pending and is tried again, keeping the order', async () => {
                const d = await refusing(() => new APIHTTPError('Bad Gateway', 502));

                for (let i = 0; i < 6; i++) {
                    await d.engine.replayRemoteOps();
                }

                expect(d.refusals()).toBeGreaterThanOrEqual(6); // never given up on
                expect(d.journal().map((op) => (op.kind === 'trash' ? op.path : op.toPath))).toEqual(['Docs/a2.txt', 'Docs/b2.txt']);
                expect(d.calls.renamed).toEqual([]);
            });
        });

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
            // Left for later on purpose, not by an error
            expect(stateDb.listActivity(50).filter((a) => a.action === 'error')).toEqual([]);
            d.down.clear();
            await d.engine.reconcileNow();
            await d.engine.reconcileNow();

            expect(d.nodes.get('vol~Docs/a.txt')?.parentUid).toBe('vol~Other');
            expect(await readFile(d.local('Other/a.txt'), 'utf8')).toBe('a');
            expect(d.calls.trashed).toEqual([['vol~Docs']]); // the folder, with only b.txt in it by then
            await d.expectEveryRecordHasItsFile();
        });

        // #62: with an unrelated change through the drive pending, a file deleted here (not through the drive) is trashed
        // in the cloud as usual; it used to throw in trashForDeletedLocal, and was left alone only by that error
        test('a synced file deleted on disk while an unrelated drive change waits is trashed as usual', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Other/x.txt', 'x');
            await pinnedAndSynced(d, d.root.uid);
            d.down.add('renameNode');
            await d.engine.renameItem('Other/x.txt', 'Other/y.txt');
            expect(d.journal()).toHaveLength(1);
            await rm(d.local('Docs/a.txt')); // not through the drive

            await d.engine.reconcileNow();

            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
            expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
            expect(stateDb.listActivity(50).filter((a) => a.action === 'error')).toEqual([]);
            expect(d.journal()).toHaveLength(1); // the rename still waits
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
                    ...uploadAtOnce,
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
            test('one app downloading more than 20 files in a minute is told about once, and Block this app blocks it', async () => {
                stateDb.updateSettings({ notificationsEnabled: true });
                const asked: Array<{ title: string; body: string }> = [];
                let answer!: (choice: string | null) => void;
                const d = setup();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    ...uploadAtOnce,
                    backingDir: path.join(tempDir, 'files'),
                    moveToDesktopTrash: async () => false,
                    askWithActions: (n) => {
                        asked.push({ title: n.title, body: n.body });
                        return new Promise((resolve) => (answer = resolve));
                    },
                });
                for (let i = 0; i < 25; i++) d.add(`Big/f${i}.txt`, `${i}`);
                d.add('Big/here.txt', 'here');
                await engine.reconcileNow();
                await engine.hydrate('Big/here.txt', { opener: 'rg' }); // already here afterwards: asking again counts nothing
                for (let i = 0; i < 19; i++) await engine.hydrate('Big/here.txt', { opener: 'rg' });
                const notify = spyOn(notifications, 'sendDesktopNotification').mockImplementation(() => {});
                try {
                    for (let i = 0; i < 19; i++) await engine.hydrate(`Big/f${i}.txt`, { opener: 'rg' });
                    expect(asked).toEqual([]); // 20 downloads so far
                    await engine.hydrate('Big/f19.txt', { opener: 'rg' });
                    expect(asked).toEqual([{ title: 'rg is downloading many files from Proton Drive', body: 'It has downloaded 21 files in the last minute.' }]);
                    await engine.hydrate('Big/f20.txt', { opener: 'rg' });
                    expect(asked.length).toBe(1);

                    answer('block');
                    await Bun.sleep(10);
                    expect(stateDb.getSettings().blockedApps).toEqual(['rg']);
                    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'rg is blocked' }));
                    await expect(engine.hydrate('Big/f21.txt', { opener: 'rg' })).rejects.toMatchObject({ code: 'EACCES' });
                    await engine.hydrate('Big/f22.txt', { opener: 'gedit' });
                } finally {
                    notify.mockRestore();
                }
            });

            test('without buttons the notice says where to block the app, and with notifications off nothing is said', async () => {
                const d = setup();
                let asked = 0;
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    ...uploadAtOnce,
                    backingDir: path.join(tempDir, 'files'),
                    moveToDesktopTrash: async () => false,
                    askWithActions: async () => {
                        asked += 1;
                        return 'unsupported';
                    },
                });
                for (let i = 0; i < 50; i++) d.add(`Big/f${i}.txt`, `${i}`);
                await engine.reconcileNow();
                const notify = spyOn(notifications, 'sendDesktopNotification').mockImplementation(() => {});
                try {
                    for (let i = 0; i < 25; i++) await engine.hydrate(`Big/f${i}.txt`, { opener: 'code' });
                    expect(asked).toBe(0); // notificationsEnabled is off in this suite
                    stateDb.updateSettings({ notificationsEnabled: true });
                    for (let i = 25; i < 50; i++) await engine.hydrate(`Big/f${i}.txt`, { opener: 'backup' });
                    await Bun.sleep(10);
                    expect(asked).toBe(1);
                    expect(notify).toHaveBeenCalledWith(
                        expect.objectContaining({ body: "It has downloaded 21 files in the last minute. You can block it in Proton Drive's Settings." }),
                    );
                    expect(stateDb.getSettings().blockedApps).toEqual([]);
                } finally {
                    notify.mockRestore();
                }
            });

            test('an app the user blocked is refused, quietly, and downloads nothing; others and unknown openers download', async () => {
                const d = setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                d.add('Docs/c.txt', 'c');
                await d.engine.reconcileNow();
                stateDb.updateSettings({ blockedApps: ['rg'] });
                const notify = spyOn(notifications, 'sendDesktopNotification');
                try {
                    await expect(d.engine.hydrate('Docs/a.txt', { opener: 'rg' })).rejects.toMatchObject({ code: 'EACCES', message: 'Blocked: rg' });
                    expect(d.calls.downloads).toEqual([]);
                    expect(notify).not.toHaveBeenCalled();
                    await d.engine.hydrate('Docs/b.txt', { opener: 'gedit' });
                    await d.engine.hydrate('Docs/c.txt'); // an older helper sends no opener
                    expect(d.calls.downloads.sort()).toEqual(['Docs/b.txt', 'Docs/c.txt']);
                } finally {
                    notify.mockRestore();
                }
            });

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
                expect(copies.length).toBe(1); // one conflict, one copy, even when a download failed after it was made (#25)
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
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
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

            // #65: another device changed the node since the drive showed it, and the remote index has heard (a listing,
            // an event): the file here is no longer an edit of what the cloud has, so a delete or rename through the
            // drive leaves the cloud node alone, as for a collision (#29), for the conflict handling to see
            const changedSinceShown = async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');
                changeInCloud(d, 'vol~Docs/doc.txt', 'theirs, longer');
                d.engine.remoteIndex.upsert(entryFromNode(d.nodes.get('vol~Docs/doc.txt')!, 'Docs')!); // as a listing would
                expect(stateDb.getEditBaseline('Docs/doc.txt')?.nodeUid).toBe('vol~Docs/doc.txt');
                return d;
            };
            const docEntry = (d: ReturnType<typeof setup>) => d.engine.vfsChildren('Docs').find((e) => e.name === 'doc.txt');

            test('changed in the cloud since the drive showed it, it lists as the local file, and a delete keeps the cloud node', async () => {
                const d = await changedSinceShown();
                expect(docEntry(d)?.size).toBe(4);

                await d.engine.deleteItem('Docs/doc.txt');
                await d.engine.replayRemoteOps();

                expect(d.journal()).toEqual([]);
                expect(d.calls.trashed).toEqual([]);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs, longer');
                expect(await d.files.exists('Docs/doc.txt')).toBe(false);
                expect(stateDb.getEditBaseline('Docs/doc.txt')).toBeNull();
                expect(docEntry(d)?.size).toBe('theirs, longer'.length);
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual([]);
            });

            test('changed in the cloud since the drive showed it, a rename moves only the local file', async () => {
                const d = await changedSinceShown();

                await d.engine.renameItem('Docs/doc.txt', 'Docs/mine.txt');
                await d.engine.replayRemoteOps();

                expect(d.calls.renamed).toEqual([]);
                expect(d.nameOf(d.nodes.get('vol~Docs/doc.txt')!)).toBe('doc.txt');
                expect(stateDb.getEditBaseline('Docs/mine.txt')).toBeNull();
                await d.engine.reconcileNow();
                expect(d.calls.uploads).toEqual(['Docs/mine.txt']);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs, longer');
                expect(d.calls.trashed).toEqual([]);
            });

            test('unchanged in the cloud since the drive showed it, a delete through the drive still trashes the node', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await truncatedAndWritten(d, 'Docs/doc.txt', 'mine');

                await d.engine.deleteItem('Docs/doc.txt');
                await d.engine.replayRemoteOps();

                expect(d.calls.trashed).toEqual([['vol~Docs/doc.txt']]);
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
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
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
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
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

        // #29: a local file and another device's different cloud file at one path, not resolved yet. The drive shows the
        // local file (what the user has), and a delete through it removes that, never the other device's file.
        describe('a path in an unresolved collision (#29)', () => {
            const docEntry = (d: ReturnType<typeof setup>) => d.engine.vfsChildren('Docs').find((e) => e.name === 'doc.txt');
            // Another device's 'theirs' (6 bytes) in the cloud, and 'mine' (4 bytes) made here, never uploaded
            const collided = async (strategy: 'keep-both' | 'prompt') => {
                stateDb.updateSettings({ conflictStrategy: strategy });
                const d = setup();
                d.add('Docs/doc.txt', 'theirs');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/doc.txt', 'mine');
                return d;
            };
            const expectCloudFileKept = async (d: ReturnType<typeof setup>) => {
                await d.engine.replayRemoteOps();
                expect(d.calls.trashed).toEqual([]);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(await d.files.exists('Docs/doc.txt')).toBe(false);
                await d.engine.reconcileNow();
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).not.toContain('Docs/doc.txt');
                // Back to what the cloud has, online-only
                expect(docEntry(d)?.size).toBe(6);
            };

            test('waiting for the conflict handling, the drive lists the local file, and a delete trashes nothing', async () => {
                const d = await collided('keep-both');
                const st = await stat(d.local('Docs/doc.txt'));

                expect(docEntry(d)).toEqual({ name: 'doc.txt', type: 'file', size: 4, mtimeMs: st.mtimeMs });
                await d.engine.deleteItem('Docs/doc.txt');

                await expectCloudFileKept(d);
            });

            test('queued for the user (prompt), the same, and the conflict is over once its local file is deleted', async () => {
                const d = await collided('prompt');
                await (d.engine as any).handleLocalFileChange('Docs/doc.txt');
                expect(stateDb.listConflicts().map((c) => c.localRelPath)).toEqual(['Docs/doc.txt']);

                expect(docEntry(d)?.size).toBe(4);
                await d.engine.deleteItem('Docs/doc.txt');

                await expectCloudFileKept(d);
                expect(stateDb.listConflicts()).toEqual([]);
            });

            test('a recorded file changed on both sides and queued for the user: a delete leaves the cloud revision', async () => {
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/doc.txt', 'pin');
                expect(stateDb.getItemByPath('Docs/doc.txt')).not.toBeNull();
                // Another device's revision (later, 6 bytes), and this computer's edit (4 bytes)
                const node = d.nodes.get('vol~Docs/doc.txt')!;
                const later = new Date(node.modificationTime.getTime() + 60_000);
                const changed = makeMockNode({ uid: node.uid, parentUid: node.parentUid, nameStr: 'doc.txt', type: NodeType.File, content: 'theirs', modificationTime: later });
                d.nodes.set(node.uid, { ...changed, activeRevision: { ...changed.activeRevision!, claimedModificationTime: later } });
                await d.files.writeLocal('Docs/doc.txt', 'mine');
                await d.engine.reconcileNow();
                expect(stateDb.listConflicts().map((c) => c.localRelPath)).toEqual(['Docs/doc.txt']);

                expect(docEntry(d)?.size).toBe(4);
                await d.engine.deleteItem('Docs/doc.txt');
                expect(stateDb.getItemByPath('Docs/doc.txt')).toBeNull();
                expect(stateDb.listConflicts()).toEqual([]);

                await expectCloudFileKept(d);
                // Still pinned: the other device's version comes down in its place
                expect(await readFile(d.local('Docs/doc.txt'), 'utf8')).toBe('theirs');
            });

            test('a local file with the very content of the cloud file, not recorded yet, is that file: a delete trashes it', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'theirs');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/doc.txt', 'theirs');

                await d.engine.deleteItem('Docs/doc.txt');
                await d.engine.replayRemoteOps();

                expect(d.calls.trashed).toEqual([['vol~Docs/doc.txt']]);
            });

            test('one whose cloud file claims no SHA1 can not be told apart: a delete keeps the cloud file', async () => {
                const d = setup();
                const node = d.add('Docs/doc.txt', 'theirs');
                d.nodes.set(node.uid, { ...node, activeRevision: { ...node.activeRevision!, claimedDigests: undefined } } as any);
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/doc.txt', 'theirs');

                await d.engine.deleteItem('Docs/doc.txt');

                await expectCloudFileKept(d);
            });

            // Docs holds the collision, another file and a folder, all in Proton Drive
            const collidedInFolder = async () => {
                stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                const d = setup();
                d.add('Docs/doc.txt', 'theirs');
                d.add('Docs/other.txt', 'o');
                d.add('Docs/Sub/x.txt', 'x');
                await d.engine.reconcileNow();
                await d.files.writeLocal('Docs/doc.txt', 'mine');
                return d;
            };
            const driveRoute = async (d: ReturnType<typeof setup>, route: string, body: object) => {
                const socketPath = path.join(tempDir, 'sock', 'control.sock');
                const server = await startControlServer({ socketPath, engine: d.engine });
                try {
                    const res = await fetch(`http://localhost${route}`, { unix: socketPath, method: 'POST', body: JSON.stringify(body) } as RequestInit);
                    return { status: res.status, body: await res.json() };
                } finally {
                    await server.stop();
                }
            };

            for (const trash of [false, true]) {
                test(`a folder ${trash ? 'moved to the Trash' : 'deleted'} through the drive trashes what else is in it, never the colliding cloud file`, async () => {
                    const d = await collidedInFolder();

                    expect(await driveRoute(d, '/vfs/delete', { path: 'Docs', trash })).toEqual({ status: 200, body: { ok: true } });
                    await d.engine.replayRemoteOps();

                    expect(d.calls.trashed.flat().sort()).toEqual(['vol~Docs/Sub', 'vol~Docs/other.txt']);
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                    expect(d.nodes.get('vol~Docs')).toBeDefined();
                    expect(d.engine.remoteIndex.getByPath('Docs/other.txt')).toBeNull();
                    expect(d.engine.vfsChildren('').map((e) => e.name)).toEqual(['Docs']);
                    expect(d.engine.vfsChildren('Docs').map((e) => e.name)).toEqual(['doc.txt']);
                    await d.engine.reconcileNow();
                    expect(d.calls.trashed.flat().sort()).toEqual(['vol~Docs/Sub', 'vol~Docs/other.txt']);
                    expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                });
            }

            test("an editor's save over a colliding file is no new revision of the cloud file: the conflict handling decides", async () => {
                const d = await collided('keep-both');
                await d.files.writeLocal('Docs/doc.txt.new', 'mine, saved again');

                await d.engine.renameItem('Docs/doc.txt.new', 'Docs/doc.txt');
                await d.engine.replayRemoteOps();
                await (d.engine as any).handleLocalFileChange('Docs/doc.txt');
                await d.engine.reconcileNow();

                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                const copies = [...d.nodes.values()].filter((n) => n.parentUid === 'vol~Docs' && d.nameOf(n).includes(' (conflict '));
                expect(copies.map((n) => n.content)).toEqual(['mine, saved again']);
                expect(d.calls.trashed).toEqual([]);
            });

            test('renaming a colliding file moves only the local file: the cloud file keeps its name', async () => {
                const d = await collided('keep-both');

                await d.engine.renameItem('Docs/doc.txt', 'Docs/mine.txt');
                await d.engine.replayRemoteOps();

                expect(d.calls.renamed).toEqual([]);
                expect(d.nameOf(d.nodes.get('vol~Docs/doc.txt')!)).toBe('doc.txt');
                expect(await readFile(d.local('Docs/mine.txt'), 'utf8')).toBe('mine');
                expect(docEntry(d)?.size).toBe(6);
                await d.engine.reconcileNow();
                expect(d.calls.uploads).toEqual(['Docs/mine.txt']);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
                expect(d.calls.trashed).toEqual([]);
            });

            test('renaming a file in a conflict queued for the user moves only the local file, and ends that conflict', async () => {
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const d = await collided('prompt');
                await (d.engine as any).handleLocalFileChange('Docs/doc.txt');
                expect(stateDb.listConflicts().map((c) => c.localRelPath)).toEqual(['Docs/doc.txt']);

                await d.engine.renameItem('Docs/doc.txt', 'Docs/mine.txt');
                await d.engine.replayRemoteOps();

                expect(d.calls.renamed).toEqual([]);
                expect(stateDb.listConflicts()).toEqual([]);
                await d.engine.reconcileNow();
                expect(d.calls.uploads).toEqual(['Docs/mine.txt']);
                expect(d.nodes.get('vol~Docs/doc.txt')?.content).toBe('theirs');
            });

            // #66: queued again by every pass, it used to fill the Conflicts tab with copies of itself
            test('queued for the user (prompt), it is queued once however many passes look at it, and refreshed', async () => {
                const d = await collided('prompt');
                const notified = spyOn(notifications, 'sendDesktopNotification');
                try {
                    await d.engine.reconcileNow();
                    const [first] = stateDb.listConflicts();
                    await d.engine.reconcileNow();
                    await d.engine.reconcileNow();
                    expect(stateDb.listConflicts().map((c) => c.id)).toEqual([first!.id]);
                    expect(notified.mock.calls.filter(([n]) => n.title === 'Proton Drive Sync Conflict').length).toBe(1);

                    // Another device changes it again: the same conflict, as it now stands
                    const node = d.nodes.get('vol~Docs/doc.txt')!;
                    const changed = makeMockNode({ uid: node.uid, parentUid: node.parentUid, nameStr: 'doc.txt', type: NodeType.File, content: 'theirs again' });
                    d.nodes.set(node.uid, changed);
                    await d.engine.reconcileNow();
                    expect(stateDb.listConflicts().map((c) => [c.id, c.remoteSha1])).toEqual([[first!.id, changed.activeRevision!.claimedDigests!.sha1!]]);
                } finally {
                    notified.mockRestore();
                }
            });

            test('a file synced as usual still goes to the Proton Drive trash when deleted through the drive', async () => {
                const d = setup();
                d.add('Docs/doc.txt', 'old');
                await d.engine.reconcileNow();
                await d.engine.setAvailability('Docs/doc.txt', 'pin');

                await d.engine.deleteItem('Docs/doc.txt');
                await d.engine.replayRemoteOps();

                expect(d.calls.trashed).toEqual([['vol~Docs/doc.txt']]);
            });
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
                    ...uploadAtOnce,
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
    describe('state events', () => {
        // Changes go out when the test says (flush), not on a timer
        const setup = (opts: { virtual?: boolean } = {}) => {
            if (opts.virtual) stateDb.setMeta('driveLayout', 'virtual');
            const drive = makeMockDrive();
            let due: (() => void) | null = null;
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                ...uploadAtOnce,
                ...(opts.virtual ? { backingDir: path.join(tempDir, 'files'), moveToDesktopTrash: async () => false } : {}),
                stateEventSchedule: (run) => {
                    due = run;
                    return () => {
                        due = null;
                    };
                },
            });
            const seen: unknown[] = [];
            engine.stateEvents.subscribe((change) => seen.push(change));
            const flush = () => {
                const run = due;
                due = null;
                run?.();
                const out = [...seen];
                seen.length = 0;
                return out;
            };
            return { ...drive, engine, flush };
        };

        test('Free up space on a folder sends its subtree, and a download sends the file and its folders', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await d.engine.reconcileNow();
            d.flush();
            await d.engine.setAvailability('Docs', 'pin');
            await d.engine.reconcileNow();
            const afterPin = d.flush() as Array<{ paths: string[]; subtrees: string[] }>;
            expect(afterPin.length).toBe(1);
            expect(afterPin[0].subtrees).toContain('Docs');

            await d.engine.setAvailability('Docs', 'free');
            const afterFree = d.flush() as Array<{ paths: string[]; subtrees: string[] }>;
            expect(afterFree[0].subtrees).toEqual(['Docs']);
            expect(afterFree[0].paths).toContain('');
        });

        test('a download recorded for a file sends the file, its folder and the root', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await d.engine.reconcileNow();
            d.flush();
            stateDb.upsertItem({
                localRelPath: 'Docs/a.txt', nodeUid: d.uid('Docs/a.txt'), parentNodeUid: d.uid('Docs'), type: 'file',
                localSha1: null, remoteSha1: null, localMtimeMs: 0, remoteMtimeMs: 0, size: 1, syncStatus: 'synced', lastError: null,
            });
            expect(d.flush()).toEqual([{ paths: ['', 'Docs', 'Docs/a.txt'], subtrees: [] }]);
        });

        test('a crawl that finds nothing new sends nothing', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            await d.engine.reconcileNow();
            d.flush();
            await d.engine.reconcileNow();
            expect(d.flush()).toEqual([]);
        });

        test('a rename through the drive sends both subtrees', async () => {
            const d = setup({ virtual: true });
            d.add('Projects/a.txt', 'a');
            await d.engine.reconcileNow();
            d.flush();
            await d.engine.renameItem('Projects', 'Work');
            const [change] = d.flush() as Array<{ paths: string[]; subtrees: string[] }>;
            expect(change.subtrees).toEqual(expect.arrayContaining(['Projects', 'Work']));
        });

        test('moving the sync folder, changing the ignore patterns or the layout sends a reset', () => {
            const d = setup();
            stateDb.updateSettings({ syncDir: path.join(tempDir, 'Elsewhere') });
            expect(d.flush()).toEqual(['reset']);
            stateDb.updateSettings({ ignorePatterns: ['*.bak'] });
            expect(d.flush()).toEqual(['reset']);
            stateDb.updateSettings({ ignorePatterns: ['*.bak'], notificationsEnabled: false });
            expect(d.flush()).toEqual([]);
            stateDb.setMeta('driveLayout', 'virtual');
            expect(d.flush()).toEqual(['reset']);
            stateDb.setMeta('driveLayout', 'virtual');
            expect(d.flush()).toEqual([]);
        });
    });
    describe('itemStates', () => {
        const setup = () => {
            const drive = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
            return { ...drive, engine, files: localFiles(stateDb) };
        };
        const record = (relPath: string, syncStatus: 'synced' | 'uploading' | 'error' = 'synced') =>
            stateDb.upsertItem({
                localRelPath: relPath, nodeUid: `vol~${relPath}`, parentNodeUid: null, type: 'file', localSha1: null,
                remoteSha1: null, localMtimeMs: 0, remoteMtimeMs: 0, size: 1, syncStatus, lastError: null,
            });

        test('a folder and its children: availability, local-only items, and nothing hidden', async () => {
            const d = setup();
            const docs = d.add('Docs');
            d.add('Docs/a.txt', 'a');
            d.add('Docs/b.txt', 'b');
            d.add('Docs/Secret/s.txt', 's');
            d.add('Other/c.txt', 'c');
            d.engine.availability.setPin(docs.uid, 'pinned', false);
            await d.engine.reconcileNow();
            await d.engine.setAvailability('Docs/b.txt', 'free');
            await d.engine.setAvailability('Docs/Secret', 'hide');
            await d.files.writeLocal('Docs/new.txt', 'not uploaded yet');
            await d.files.writeLocal('Docs/.git/HEAD', 'ref');

            const docsStates = d.engine.itemStates('Docs')!;
            // A file waiting to upload shows on itself; its folders sum up only what is recorded, the same from any view.
            // b.txt was freed inside it, so Docs isn't all kept here any more and reads by its contents (#175); a hidden
            // item inside doesn't count, it isn't shown at all
            expect(docsStates.self).toEqual({ availability: 'partial', transfer: null }); // a.txt here, b.txt not (#183)
            expect(docsStates.children).toEqual({
                'a.txt': { availability: 'pinned', transfer: null },
                'b.txt': { availability: 'online-only', transfer: null },
                'new.txt': { availability: 'downloaded', transfer: 'syncing' },
                '.git': null,
            });

            const root = d.engine.itemStates('')!;
            expect(root.self).toBeNull();
            expect(root.children.Other).toEqual({ availability: 'online-only', transfer: null });
            expect(root.children.Docs).toEqual(docsStates.self);
        });

        test('an error makes its folders show it, and a conflict wins over an error', async () => {
            const d = setup();
            d.add('A/B/x.txt', 'x');
            d.add('A/B/y.txt', 'y');
            await d.engine.reconcileNow();
            record('A/B/x.txt', 'error');
            expect(d.engine.itemStates('')!.children.A?.transfer).toBe('error');
            expect(d.engine.itemStates('A')!.children.B?.transfer).toBe('error');
            expect(d.engine.itemStates('A/B')!.children['x.txt']?.transfer).toBe('error');
            expect(d.engine.itemStates('A/B')!.children['y.txt']?.transfer).toBeNull();

            stateDb.recordConflict({
                localRelPath: 'A/B/y.txt', nodeUid: 'vol~A/B/y.txt', localSha1: null, remoteSha1: null, localMtimeMs: 0, remoteMtimeMs: 0,
            });
            expect(d.engine.itemStates('A')!.children.B?.transfer).toBe('conflict');
            expect(d.engine.itemStates('A')!.self?.transfer).toBe('conflict');
        });

        test('a file, a hidden folder or a path out of the drive answers null', async () => {
            const d = setup();
            d.add('Docs/a.txt', 'a');
            d.add('Hidden/h.txt', 'h');
            await d.engine.reconcileNow();
            await d.engine.setAvailability('Hidden', 'hide');
            expect(d.engine.itemStates('Docs/a.txt')).toBeNull();
            expect(d.engine.itemStates('Hidden')).toBeNull();
            expect(d.engine.itemStates('../x')).toBeNull();
            expect(d.engine.itemStates('Nope')).toBeNull();
        });

        test('a folder made here and not uploaded yet waits to upload, all of it', async () => {
            const d = setup();
            await d.engine.reconcileNow();
            await d.files.writeLocal('Fresh/one.txt', '1');
            await d.files.writeLocal('Fresh/node_modules/x.js', 'x');
            expect(d.engine.itemStates('Fresh')).toEqual({
                self: { availability: 'downloaded', transfer: 'syncing' },
                children: { 'one.txt': { availability: 'downloaded', transfer: 'syncing' }, node_modules: null },
            });
        });
    });
    describe('waiting prompt conflicts after the strategy changes or the sides agree (#68)', () => {
        // Docs/a.txt downloaded and pinned, then edited here and in the cloud while the strategy is prompt: one waits
        const queued = async (layout: 'plain' | 'virtual' = 'plain') => {
            if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 }, // edits count at once: these tests are about what happens after
            });
            d.add('Docs/a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(local('Docs/a.txt'), 'local edit');
            const cloudEdit = (content: string) =>
                d.nodes.set(
                    'vol~Docs/a.txt',
                    makeMockNode({ uid: 'vol~Docs/a.txt', parentUid: 'vol~Docs', nameStr: 'a.txt', type: NodeType.File, content }),
                );
            cloudEdit('remote edit');
            await engine.reconcileNow();
            expect(stateDb.listConflicts().map((c) => c.localRelPath)).toContain('Docs/a.txt');
            const waiting = () => stateDb.listConflicts().filter((c) => c.localRelPath === 'Docs/a.txt');
            const firstId = waiting()[0].id;
            return { ...d, engine, local, cloudEdit, waiting, first: () => stateDb.getConflictById(firstId)! };
        };

        test('still prompt and still different: the conflict keeps waiting, and neither side is touched', async () => {
            const d = await queued();
            await d.engine.reconcileNow();
            expect(d.waiting().length).toBe(1); // the same one, found again (#66)
            expect(d.first().resolved).toBe(0);
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('local edit');
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('remote edit');
            expect(d.calls.trashed).toEqual([]);
        });

        test('switched to keep-both: the next pass keeps both, and the waiting conflict is closed as keep-both', async () => {
            const d = await queued();
            stateDb.updateSettings({ conflictStrategy: 'keep-both' });
            await d.engine.reconcileNow();
            expect(d.waiting()).toEqual([]);
            expect(d.first()).toMatchObject({ resolved: 1, resolution: 'keep-both' });
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('remote edit');
            const copies = (await readdir(d.local('Docs'))).filter((n) => n !== 'a.txt');
            expect(copies.length).toBe(1);
            expect(await readFile(d.local(`Docs/${copies[0]}`), 'utf8')).toBe('local edit');
            expect(d.calls.trashed).toEqual([]);
        });

        test('switched to keep-local: the local edit becomes a new revision, and the waiting conflict is closed as keep-local', async () => {
            const d = await queued();
            stateDb.updateSettings({ conflictStrategy: 'keep-local' });
            await d.engine.reconcileNow();
            expect(d.waiting()).toEqual([]);
            expect(d.first()).toMatchObject({ resolved: 1, resolution: 'keep-local' });
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('local edit');
            expect(d.calls.trashed).toEqual([]);
        });

        test('both sides come to hold the same content: the conflict is closed as in-sync, and the file is synced', async () => {
            const d = await queued();
            await writeFile(d.local('Docs/a.txt'), 'remote edit');
            await d.engine.reconcileNow();
            expect(d.waiting()).toEqual([]);
            expect(d.first()).toMatchObject({ resolved: 1, resolution: 'in-sync' });
            expect(stateDb.getItemByPath('Docs/a.txt')?.syncStatus).toBe('synced');
        });

        test('virtual drive: once the sides agree, a delete through the drive trashes the cloud file, not kept as a collision', async () => {
            const d = await queued('virtual');
            await writeFile(d.local('Docs/a.txt'), 'remote edit');
            await d.engine.reconcileNow();
            expect(d.waiting()).toEqual([]);
            await d.engine.deleteItem('Docs/a.txt');
            await d.engine.replayRemoteOps();
            expect(d.calls.trashed).toEqual([['vol~Docs/a.txt']]);
        });
    
        test('saved again while it waits: the conflict keeps waiting, never closed as if the sides agreed', async () => {
            const d = await queued();
            await writeFile(d.local('Docs/a.txt'), 'local edit 2');
            await (d.engine as any).handleLocalFileChange('Docs/a.txt'); // the watcher: since #72 it hands a waiting conflict to the pass's handling
            await d.engine.reconcileNow();
            expect(d.first().resolved).toBe(0);
            expect(d.waiting().length).toBe(1);
        });

        test('keep-both by hand whose copy fails to upload leaves the conflict waiting, to try again', async () => {
            const d = await queued();
            d.failNext('getFileUploader');
            await expect(d.engine.resolveConflictManually(d.first().id, 'keep-both')).rejects.toThrow();
            expect(d.first().resolved).toBe(0);
            expect(d.first().resolution).toBeNull();
        });

        test('reverted here: the cloud version comes down, and the next pass closes the conflict as in-sync', async () => {
            const d = await queued();
            await writeFile(d.local('Docs/a.txt'), 'original'); // back to what was synced: only the cloud changed now
            await d.engine.reconcileNow();
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('remote edit');
            await d.engine.reconcileNow();
            expect(d.waiting()).toEqual([]);
            expect(d.first()).toMatchObject({ resolved: 1, resolution: 'in-sync' });
        });

        test('switched to keep-both whose copy fails to upload: both stay, and the next pass closes the conflict', async () => {
            const d = await queued();
            stateDb.updateSettings({ conflictStrategy: 'keep-both' });
            d.failNext('getFileUploader');
            await d.engine.reconcileNow();
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('remote edit');
            await d.engine.reconcileNow(); // the copy uploads as a new file; the file now matches the cloud
            expect(d.waiting()).toEqual([]);
            const copies = [...d.nodes.values()].filter((n) => n.parentUid === 'vol~Docs' && d.nameOf(n) !== 'a.txt');
            expect(copies.map((n) => n.content)).toEqual(['local edit']);
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('remote edit');
            expect(d.calls.trashed).toEqual([]);
        });

        test('keep-local by hand is labelled as the user chose', async () => {
            const d = await queued();
            await d.engine.resolveConflictManually(d.first().id, 'keep-local');
            expect(d.first()).toMatchObject({ resolved: 1, resolution: 'keep-local' });
            expect(d.nodes.get('vol~Docs/a.txt')?.content).toBe('local edit');
        });
    });

    describe('keep-both of a file that keeps changing (#70)', () => {
        // Only sync passes look at the file here: the looks the settle wait schedules (the watcher's way in) never run, so
        // what is tested is a pass meeting a file still being written. The settle clock is moved by hand.
        test('keep-both waits until the file goes quiet, then downloads the cloud version once', async () => {
            const d = makeMockDrive();
            let now = Date.now();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                settle: { quietMs: 2000, maxQuietMs: 16_000, maxWaitMs: 120_000, now: () => now, schedule: () => () => {} },
            });
            d.add('Kept.txt', 'kept');
            d.add('log.txt', 'line 0\n');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'keep-both' });
            d.nodes.set(
                d.uid('log.txt'),
                makeMockNode({ uid: d.uid('log.txt'), parentUid: d.root.uid, nameStr: 'log.txt', type: NodeType.File, content: 'cloud edit' }),
            );
            const downloadsBefore = d.calls.downloads.length;

            // Written to every second for well over the 2 minutes after which a changing file is let through anyway
            for (let i = 1; i <= 150; i++) {
                appendFileSync(local('log.txt'), `line ${i}\n`);
                await engine.reconcileNow();
                expect(d.calls.downloads.length).toBe(downloadsBefore); // nothing downloaded only to be thrown away
                now += 1000;
            }
            expect(d.nodes.get(d.uid('log.txt'))?.content).toBe('cloud edit');
            expect(stateDb.listConflicts(true)).toEqual([]);

            // Quiet now: the keep-both runs once, keeping all of the log as a conflict copy
            await engine.reconcileNow(); // seen as it is
            now += 20_000;
            await engine.reconcileNow();
            expect(d.calls.downloads.length).toBe(downloadsBefore + 1);
            expect(await readFile(local('log.txt'), 'utf8')).toBe('cloud edit');
            const copies = (await readdir(engine.localRoot())).filter((n) => n.startsWith('log') && n !== 'log.txt');
            expect(copies.length).toBe(1);
            expect(await readFile(local(copies[0]), 'utf8')).toContain('line 150');
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-both']);
            expect(d.calls.trashed).toEqual([]);
        });

        test('a file let through while changing that then stops keeps both once it has been quiet, without waiting for the minute-long purge', async () => {
            const d = makeMockDrive();
            let now = Date.now();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                settle: { quietMs: 2000, maxQuietMs: 16_000, maxWaitMs: 120_000, now: () => now, schedule: () => () => {} },
            });
            d.add('Kept.txt', 'kept');
            d.add('log.txt', 'line 0\n');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'keep-both' });
            d.nodes.set(
                d.uid('log.txt'),
                makeMockNode({ uid: d.uid('log.txt'), parentUid: d.root.uid, nameStr: 'log.txt', type: NodeType.File, content: 'cloud edit' }),
            );
            const downloadsBefore = d.calls.downloads.length;
            const forced = () => (engine as any).settlingFiles.get('log.txt')?.forced === true;
            // Written to every second until a pass lets it through only because it kept changing; then it stops
            for (let i = 1; i <= 200 && !forced(); i++) {
                appendFileSync(local('log.txt'), `line ${i}\n`);
                await engine.reconcileNow();
                now += 1000;
            }
            expect(forced()).toBe(true);
            expect(d.calls.downloads.length).toBe(downloadsBefore);

            now += 20_000; // quiet for longer than its wait, well before the 60 s after which a settled entry is forgotten
            await engine.reconcileNow();
            expect(d.calls.downloads.length).toBe(downloadsBefore + 1);
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-both']);
        });
    });
    describe('the watcher never uploads over a cloud version it has not seen (#72)', () => {
        for (const layout of ['plain', 'virtual'] as const) {
            const setup = async () => {
                if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
                const d = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    ...(layout === 'virtual' ? { backingDir: path.join(tempDir, 'files'), moveToDesktopTrash: async () => false } : {}),
                    settle: { quietMs: 0 },
                });
                d.add('Kept.txt', 'kept');
                d.add('a.txt', 'original');
                engine.availability.setPin(d.root.uid, 'pinned', false);
                await engine.reconcileNow();
                d.calls.uploads.length = 0;
                const local = (rel: string) => path.join(engine.localRoot(), rel);
                // Another device's edit, which no event has told this one about yet
                const cloudEdit = (content: string) =>
                    d.nodes.set(
                        d.uid('a.txt'),
                        makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content }),
                    );
                const watcherSees = (rel: string) => (engine as any).handleLocalFileChange(rel) as Promise<void>;
                return { ...d, engine, local, cloudEdit, watcherSees };
            };

            test(`${layout}, keep-both: both versions are kept, and the cloud's stays at the file's name`, async () => {
                stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                const d = await setup();
                d.cloudEdit('cloud edit');
                await writeFile(d.local('a.txt'), 'local edit');
                await d.watcherSees('a.txt');

                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit');
                expect(await readFile(d.local('a.txt'), 'utf8')).toBe('cloud edit');
                const copies = (await readdir(d.engine.localRoot())).filter((n) => n.startsWith('a') && n !== 'a.txt');
                expect(copies.length).toBe(1);
                expect(await readFile(d.local(copies[0]), 'utf8')).toBe('local edit');
                expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-both']);
                expect(d.calls.trashed).toEqual([]);
            });

            test(`${layout}, prompt: the conflict waits for the user, and neither side is touched`, async () => {
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const d = await setup();
                d.cloudEdit('cloud edit');
                await writeFile(d.local('a.txt'), 'local edit');
                await d.watcherSees('a.txt');

                expect(d.calls.uploads).toEqual([]);
                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit');
                expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
                expect(stateDb.listConflicts().map((c) => c.localRelPath)).toEqual(['a.txt']);
                // Saved again while it waits: still nothing goes up
                await writeFile(d.local('a.txt'), 'local edit 2');
                await d.watcherSees('a.txt');
                expect(d.calls.uploads).toEqual([]);
                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit');
                expect(stateDb.listConflicts().length).toBe(1);
            });

            test(`${layout}: a file another device moved and edited is left to the sync pass, not uploaded over`, async () => {
                stateDb.updateSettings({ conflictStrategy: 'keep-both' });
                const d = await setup();
                const folder = d.add('Elsewhere');
                d.nodes.set(
                    d.uid('a.txt'),
                    makeMockNode({ uid: d.uid('a.txt'), parentUid: folder.uid, nameStr: 'moved.txt', type: NodeType.File, content: 'cloud edit' }),
                );
                await writeFile(d.local('a.txt'), 'local edit');
                await d.watcherSees('a.txt');
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.downloads.filter((p) => p !== 'Kept.txt' && p !== 'a.txt')).toEqual([]);
                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit');
                expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            });

            test(`${layout}: after a move the sync followed, an edit here still uploads at once`, async () => {
                const d = await setup();
                const folder = d.add('Folder');
                const node = d.nodes.get(d.uid('a.txt'))!;
                d.nodes.set(d.uid('a.txt'), { ...node, parentUid: folder.uid }); // moved by another device
                await d.engine.reconcileNow(); // followed here
                expect(await readFile(d.local('Folder/a.txt'), 'utf8')).toBe('original');
                d.calls.uploads.length = 0;

                await writeFile(d.local('Folder/a.txt'), 'local edit');
                await d.watcherSees('Folder/a.txt');
                expect(d.calls.uploads).toEqual(['Folder/a.txt']);
                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
            });

            test(`${layout}: an edit inside a folder another device trashed is never uploaded into the trash`, async () => {
                const d = await setup();
                d.add('Folder/b.txt', 'b');
                await d.engine.reconcileNow();
                d.calls.uploads.length = 0;
                const folder = d.nodes.get(d.uid('Folder'))!;
                d.nodes.set(d.uid('Folder'), { ...folder, trashTime: new Date() }); // only the folder is marked trashed
                await writeFile(d.local('Folder/b.txt'), 'local edit');
                await d.watcherSees('Folder/b.txt');
                expect(d.calls.uploads).toEqual([]);
                expect(await readFile(d.local('Folder/b.txt'), 'utf8')).toBe('local edit');
            });

            test(`${layout}: a file deleted in Proton Drive and made anew there is never uploaded over by the watcher`, async () => {
                const d = await setup();
                d.nodes.delete(d.uid('a.txt'));
                d.nodes.set(
                    'vol~other-a',
                    makeMockNode({ uid: 'vol~other-a', parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'new from another device' }),
                );
                await writeFile(d.local('a.txt'), 'local edit');
                await d.watcherSees('a.txt');
                expect(d.calls.uploads).toEqual([]);
                expect(d.nodes.get('vol~other-a')?.content).toBe('new from another device');
                expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            });

            test(`${layout}: an edit here with the cloud unchanged still uploads as a new revision, at once`, async () => {
                const d = await setup();
                await writeFile(d.local('a.txt'), 'local edit');
                await d.watcherSees('a.txt');
                expect(d.calls.uploads).toEqual(['a.txt']);
                expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
                expect(stateDb.listConflicts(true)).toEqual([]);
            });
        }
    });

    describe('a manual resolution and a strategy pass never both act on one conflict (#77)', () => {
        const queued = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(local('a.txt'), 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            expect(conflict.localRelPath).toBe('a.txt');
            return { ...d, engine, local, conflict };
        };
        // Holds the next getNode of a uid until released
        const holdGetNode = (d: Awaited<ReturnType<typeof queued>>, uid: string) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const getNode = d.sdk.getNode.bind(d.sdk);
            (d.sdk as any).getNode = async (u: string) => {
                if (u === uid) {
                    (d.sdk as any).getNode = getNode;
                    entered();
                    await gate;
                }
                return getNode(u);
            };
            return { release, inside };
        };

        test('a pass under keep-remote leaves alone the conflict the user is keeping local by hand', async () => {
            const d = await queued();
            stateDb.updateSettings({ conflictStrategy: 'keep-remote' });
            const held = holdGetNode(d, d.uid('a.txt'));
            const manual = d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            await held.inside;
            await d.engine.reconcileNow(); // the pass, while the user's choice waits on the network
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            held.release();
            await manual;
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
            expect(stateDb.listConflicts(true).map((c) => [c.id, c.resolution])).toEqual([[d.conflict.id, 'keep-local']]);
        });

        test('a pass that read the file before the user resolved it by hand, and reaches it after, leaves it alone', async () => {
            const d = await queued();
            stateDb.updateSettings({ conflictStrategy: 'keep-remote' });
            d.add('0.txt', 'new from another device'); // sorts first: the pass is busy with it while the user resolves
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const download = (d.sdk as any).getFileRevisionDownloader.bind(d.sdk);
            (d.sdk as any).getFileRevisionDownloader = async (...args: unknown[]) => {
                (d.sdk as any).getFileRevisionDownloader = download;
                entered();
                await gate;
                return download(...args);
            };
            const pass = d.engine.reconcileNow();
            await inside; // the pass has read its listing and records, and waits on 0.txt
            await d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            // A real download serves the revision the pass saw: the cloud's version from before the user's choice
            const node = d.nodes.get(d.uid('a.txt'))!;
            (d.sdk as any).getFileRevisionDownloader = async (revision: string) => {
                if (!revision.startsWith(d.uid('a.txt'))) return download(revision);
                const kept = node.content;
                (node as any).content = 'cloud edit';
                try {
                    return await download(revision);
                } finally {
                    (node as any).content = kept;
                }
            };
            release();
            await pass;
            (d.sdk as any).getFileRevisionDownloader = download;
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
            expect(stateDb.listConflicts(true).map((c) => [c.id, c.resolution])).toEqual([[d.conflict.id, 'keep-local']]);
        });

        test('the user resolving by hand while a pass resolves the same conflict is told to try again, and nothing is relabelled', async () => {
            const d = await queued();
            stateDb.updateSettings({ conflictStrategy: 'keep-both' });
            // A keep-both pass starts on it and waits on the network, in its download
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const getFileDownloader = (d.sdk as any).getFileRevisionDownloader.bind(d.sdk);
            (d.sdk as any).getFileRevisionDownloader = async (...args: unknown[]) => {
                (d.sdk as any).getFileRevisionDownloader = getFileDownloader;
                entered();
                await gate;
                return (getFileDownloader as any)(...args);
            };
            const held = { release, inside };
            const pass = d.engine.reconcileNow();
            await held.inside;
            await expect(d.engine.resolveConflictManually(d.conflict.id, 'keep-local')).rejects.toMatchObject({ status: 409 });
            held.release();
            await pass;
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-both']);
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit');
            expect(d.calls.trashed).toEqual([]);
        });
    });

    describe("a record's parent follows a move (#80)", () => {
        for (const layout of ['plain', 'virtual'] as const) {
            const setup = async () => {
                if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
                const d = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    ...(layout === 'virtual' ? { backingDir: path.join(tempDir, 'files'), moveToDesktopTrash: async () => false } : { moveToDesktopTrash: async () => false }),
                    settle: { quietMs: 0 },
                });
                d.add('Kept.txt', 'kept');
                d.add('a.txt', 'a');
                const folder = d.add('Folder');
                engine.availability.setPin(d.root.uid, 'pinned', false);
                await engine.reconcileNow();
                expect(stateDb.getItemByPath('a.txt')?.parentNodeUid).toBe(d.root.uid);
                return { ...d, engine, folder };
            };

            test(`${layout}: a move in Proton Drive the sync follows`, async () => {
                const d = await setup();
                const node = d.nodes.get(d.uid('a.txt'))!;
                d.nodes.set(d.uid('a.txt'), { ...node, parentUid: d.folder.uid });
                await d.engine.reconcileNow();
                expect(stateDb.getItemByPath('Folder/a.txt')?.parentNodeUid).toBe(d.folder.uid);
            });

            if (layout === 'virtual') {
                test('virtual: a move through the drive', async () => {
                    const d = await setup();
                    await d.engine.renameItem('a.txt', 'Folder/a.txt');
                    await d.engine.replayRemoteOps();
                    expect(stateDb.getItemByPath('Folder/a.txt')?.parentNodeUid).toBe(d.folder.uid);
                });
            }
        }
    });

    describe('the watcher does nothing for a recorded file that has not changed (#89)', () => {
        // A container (VeraCrypt) or cp -p / touch -r writes new content and puts the old time back: only the ctime,
        // which the system sets, says it was written. Skipped, it would never upload, and a later cloud delete would
        // remove the only copy of the edit
        test('an edit that keeps the size and puts the old mtime back still uploads', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('vault.bin', 'AAAAAAAA');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            d.calls.uploads.length = 0;
            const file = path.join(engine.localRoot(), 'vault.bin');
            const before = await stat(file);
            await Bun.sleep(20); // so the write's ctime is after the record's
            await writeFile(file, 'BBBBBBBB');
            await utimes(file, before.atime, before.mtime);
            await (engine as any).handleLocalFileChange('vault.bin');
            expect(d.calls.uploads).toEqual(['vault.bin']);
            expect(d.nodes.get(d.uid('vault.bin'))?.content).toBe('BBBBBBBB');
        });

        for (const layout of ['plain', 'virtual'] as const) {
            test(`${layout}: no hash, no look-up, no upload; an edit still goes up`, async () => {
                if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
                const d = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    ...(layout === 'virtual' ? { backingDir: path.join(tempDir, 'files') } : {}),
                    moveToDesktopTrash: async () => false,
                    settle: { quietMs: 0 },
                });
                d.add('Kept.txt', 'kept');
                d.add('a.txt', 'a');
                engine.availability.setPin(d.root.uid, 'pinned', false);
                await engine.reconcileNow();
                d.calls.uploads.length = 0;
                const getNode = spyOn(d.sdk, 'getNode');
                try {
                    await (engine as any).handleLocalFileChange('a.txt'); // a spurious report: nothing changed
                    expect(getNode).not.toHaveBeenCalled();
                    expect(d.calls.uploads).toEqual([]);

                    await writeFile(path.join(engine.localRoot(), 'a.txt'), 'edited');
                    await (engine as any).handleLocalFileChange('a.txt');
                    expect(d.calls.uploads).toEqual(['a.txt']);
                } finally {
                    getNode.mockRestore();
                }
            });
        }
    });

    describe('local changes are handled a few at a time (#90)', () => {
        test('one file busy uploading never takes every turn from the others', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
                localChangeConcurrency: 2,
            });
            d.add('Kept.txt', 'kept');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('big.bin'), 'v1');
            await writeFile(local('other.txt'), 'other');
            // big.bin's upload waits on the network, inside its look (which then holds its turn and its place in the queue)
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const uploadNewFile = (engine as any).uploadNewFile.bind(engine);
            (engine as any).uploadNewFile = async (rel: string, ...rest: unknown[]) => {
                if (rel === 'big.bin') await gate;
                return uploadNewFile(rel, ...rest);
            };
            const first = (engine as any).handleLocalFileChange('big.bin');
            await Bun.sleep(5);
            const again = [1, 2, 3].map(() => (engine as any).handleLocalFileChange('big.bin')); // it keeps changing
            await Bun.sleep(5);
            const other = (engine as any).handleLocalFileChange('other.txt');
            const done = await Promise.race([other.then(() => 'done'), Bun.sleep(500).then(() => 'kept waiting')]);
            expect(done).toBe('done'); // not kept waiting behind big.bin
            expect(d.calls.uploads).toEqual(['other.txt']);
            release();
            await Promise.all([first, ...again]);
            expect(d.calls.uploads).toContain('big.bin');
        });

        test('thirty new files reported at once: never more than the limit at a time, and all of them upload', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
                localChangeConcurrency: 3,
            });
            d.add('Kept.txt', 'kept');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const names = Array.from({ length: 30 }, (_, i) => `new-${i}.txt`);
            for (const name of names) await writeFile(path.join(engine.localRoot(), name), name);
            let running = 0;
            let most = 0;
            const now = (engine as any).handleLocalFileChangeNow.bind(engine);
            (engine as any).handleLocalFileChangeNow = async (rel: string) => {
                running++;
                most = Math.max(most, running);
                try {
                    await Bun.sleep(2);
                    return await now(rel);
                } finally {
                    running--;
                }
            };
            await Promise.all(names.map((name) => (engine as any).handleLocalFileChange(name)));
            expect(most).toBe(3);
            expect(d.calls.uploads.sort()).toEqual([...names].sort());
        });
    });

    describe('an edit that keeps the size and puts the old mtime back is never taken for no change (#105)', () => {
        const written = async () => {
            const d = makeMockDrive();
            const trashed: string[] = [];
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async (fullPath: string) => (trashed.push(fullPath), false),
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('vault.bin', 'AAAAAAAA');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            d.calls.uploads.length = 0;
            const file = path.join(engine.localRoot(), 'vault.bin');
            const before = await stat(file);
            await Bun.sleep(20); // the write's ctime comes after the record
            await writeFile(file, 'BBBBBBBB'); // as a VeraCrypt container, cp -p or touch -r would: same size, old time back
            await utimes(file, before.atime, before.mtime);
            return { ...d, engine, file, trashed };
        };

        test('a file whose ctime moved but not its content (chmod) is hashed once, not on every pass', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            await Bun.sleep(20);
            await chmod(path.join(engine.localRoot(), 'a.txt'), 0o600);
            const hashes = spyOn(fileOpsModule, 'computeLocalFileSha1');
            try {
                await engine.reconcileNow();
                await engine.reconcileNow();
                expect(hashes.mock.calls.filter(([p]) => String(p).endsWith('a.txt')).length).toBe(1); // the first pass only
                expect(d.calls.uploads).toEqual([]);
            } finally {
                hashes.mockRestore();
            }
        });

        test('a cloud file that claims no sha1 is hashed once too after a chmod', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            const added = d.add('legacy.txt', 'from an older client');
            const node = d.nodes.get(added.uid)!;
            d.nodes.set(added.uid, { ...node, activeRevision: { ...node.activeRevision!, claimedDigests: { sha1: undefined } } } as any);
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            await Bun.sleep(20);
            await chmod(path.join(engine.localRoot(), 'legacy.txt'), 0o600);
            const hashes = spyOn(fileOpsModule, 'computeLocalFileSha1');
            try {
                for (let i = 0; i < 3; i++) await engine.reconcileNow();
                expect(hashes.mock.calls.filter(([p]) => String(p).endsWith('legacy.txt')).length).toBe(1);
                expect(d.calls.uploads).toEqual([]);
            } finally {
                hashes.mockRestore();
            }
        });

        test('a sync pass uploads it', async () => {
            const d = await written();
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual(['vault.bin']);
            expect(d.nodes.get(d.uid('vault.bin'))?.content).toBe('BBBBBBBB');
        });

        test('a cloud delete before it uploaded keeps it here', async () => {
            const d = await written();
            d.nodes.delete(d.uid('vault.bin'));
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            // Kept: as it was (the desktop Trash failed here) or as handed to it, never removed outright
            const kept = (await readFile(d.file, 'utf8').catch(() => null)) ?? (d.trashed.length ? 'handed to the Trash' : null);
            expect(kept === 'BBBBBBBB' || kept === 'handed to the Trash').toBe(true);
        });
    });

    describe('nothing else acts on a file while the user resolves its conflict by hand (#104)', () => {
        const queued = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(local('a.txt'), 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            return { ...d, engine, local, conflict, files: localFiles(stateDb, () => engine.localRoot()) };
        };
        // Holds the next call of an SDK method until released
        const hold = (d: Awaited<ReturnType<typeof queued>>, method: string) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const real = (d.sdk as any)[method].bind(d.sdk);
            (d.sdk as any)[method] = async (...args: unknown[]) => {
                (d.sdk as any)[method] = real;
                entered();
                await gate;
                return real(...args);
            };
            return { release, inside };
        };

        test('keep-remote by hand never replaces a save made while the cloud version downloads', async () => {
            const d = await queued();
            const held = hold(d, 'getFileRevisionDownloader');
            const manual = d.engine.resolveConflictManually(d.conflict.id, 'keep-remote');
            await held.inside;
            await writeFile(d.local('a.txt'), 'saved meanwhile');
            held.release();
            await expect(manual).rejects.toMatchObject({ status: 409 });
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('saved meanwhile');
            expect(stateDb.getConflictById(d.conflict.id)?.resolved).toBe(0);
        });

        test('a delete here seen while the user resolves by hand ends nothing and records nothing', async () => {
            const d = await queued();
            const held = hold(d, 'getNode');
            const manual = d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            await held.inside;
            await rm(d.local('a.txt'));
            await (d.engine as any).handleLocalFileChange('a.txt');
            expect(stateDb.getItemByPath('a.txt')).not.toBeNull();
            expect(stateDb.getConflictById(d.conflict.id)?.resolved).toBe(0);
            expect(d.calls.trashed).toEqual([]);
            held.release();
            await manual.catch(() => {});
        });

        test('a move in Proton Drive is not followed here while the user resolves by hand', async () => {
            const d = await queued();
            const folder = d.add('Moved');
            const held = hold(d, 'getNode');
            const manual = d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            await held.inside;
            const node = d.nodes.get(d.uid('a.txt'))!;
            d.nodes.set(d.uid('a.txt'), { ...node, parentUid: folder.uid });
            await d.engine.reconcileNow();
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            expect(await d.files.exists('Moved/a.txt')).toBe(false); // not downloaded again as a new file there
            expect(stateDb.getItemByPath('a.txt')?.nodeUid).toBe(d.uid('a.txt'));
            held.release();
            await manual.catch(() => {});
        });
    });

    describe('two looks at one file never run at once (#108)', () => {
        test('looks that found the same running one take turns after it, never together', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const file = path.join(engine.localRoot(), 'a.txt');
            await writeFile(file, 'v1');
            let running = 0;
            let most = 0;
            let uploads = 0;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const real = (engine as any).uploadLocalToRemote.bind(engine);
            (engine as any).uploadLocalToRemote = async (rel: string, ...rest: unknown[]) => {
                if (rel !== 'a.txt') return real(rel, ...rest);
                const nth = ++uploads;
                running++;
                most = Math.max(most, running);
                try {
                    const result = await real(rel, ...rest);
                    await Bun.sleep(5);
                    if (nth === 1) await gate; // the first look stays at work after its upload
                    return result;
                } finally {
                    running--;
                }
            };
            // Straight to the look, past the turns of #90: as looks resumed together after an availability change
            const look = (engine as any).handleLocalFileChangeNow.bind(engine);
            const first = look('a.txt');
            for (let i = 0; i < 100 && uploads === 0; i++) await Bun.sleep(5); // v1 is up, and the first look holds on
            await writeFile(file, 'v2 is longer'); // changed again: both later looks have something to upload
            const later = [look('a.txt'), look('a.txt')];
            await Bun.sleep(10);
            release();
            await Promise.all([first, ...later]);
            expect(most).toBe(1);
            const inCloud = [...d.nodes.values()].filter((n) => n.parentUid === d.root.uid && d.nameOf(n) === 'a.txt');
            expect(inCloud.map((n) => n.content)).toEqual(['v2 is longer']);
        });
    });

    describe('Keep Local by hand on a file another device trashed (#111)', () => {
        const trashedWhileWaiting = async (trashKeepsName: boolean, rel = 'a.txt') => {
            const d = makeMockDrive();
            // A desktop Trash that works: a file taken for deleted in the cloud would leave the sync folder
            const desktopTrashed: string[] = [];
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async (fullPath: string) => {
                    desktopTrashed.push(fullPath);
                    await rm(fullPath, { recursive: true, force: true });
                    return true;
                },
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add(rel, 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const file = path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(file, 'local edit');
            const node = d.nodes.get(d.uid(rel))!;
            d.nodes.set(d.uid(rel), makeMockNode({ uid: d.uid(rel), parentUid: node.parentUid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            if (rel === 'a.txt') {
                // Another device moves it to the Proton Drive trash; whether the trash still holds its name there is the API's
                const edited = d.nodes.get(d.uid(rel))!;
                d.nodes.set(d.uid(rel), { ...edited, trashTime: new Date(), ...(trashKeepsName ? {} : { parentUid: 'vol~trash' }) });
            }
            const liveCopies = () => [...d.nodes.values()].filter((n) => n.parentUid === d.root.uid && d.nameOf(n) === 'a.txt' && !n.trashTime);
            return { ...d, engine, file, conflict, liveCopies, desktopTrashed };
        };

        test('with its name free, the local version uploads as a new file, never into the trash', async () => {
            const d = await trashedWhileWaiting(false);
            await d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            expect(d.liveCopies().map((n) => n.content)).toEqual(['local edit']);
            expect(stateDb.getItemByPath('a.txt')?.nodeUid).toBe(d.liveCopies()[0].uid);
            expect(stateDb.getConflictById(d.conflict.id)?.resolution).toBe('keep-local');
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit'); // nothing landed in the trashed one
            await d.engine.reconcileNow();
            expect(await readFile(d.file, 'utf8')).toBe('local edit');
            expect(d.calls.trashed).toEqual([]);
        });

        test('with its name still held by the trashed file, nothing lands in the trash, and the file stays here', async () => {
            const d = await trashedWhileWaiting(true);
            await d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit');
            expect(stateDb.getConflictById(d.conflict.id)?.resolution).toBe('keep-local');
            expect(stateDb.getItemByPath('a.txt')).toBeNull(); // let go of the trashed node
            await d.engine.reconcileNow();
            // Never taken for deleted in the cloud: not removed, not moved to the desktop Trash
            expect(await readFile(d.file, 'utf8')).toBe('local edit');
            expect(d.desktopTrashed).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            // Once the trash lets go of the name, it uploads as a new file
            d.nodes.delete(d.uid('a.txt'));
            await d.engine.reconcileNow();
            expect(d.liveCopies().map((n) => n.content)).toEqual(['local edit']);
            expect(await readFile(d.file, 'utf8')).toBe('local edit');
        });

        test('in a folder another device trashed, nothing is put in that folder and nothing changes', async () => {
            const d = await trashedWhileWaiting(true, 'dir/a.txt');
            // Another device renames it, then trashes the folder: its old name there is free
            const node = d.nodes.get(d.uid('dir/a.txt'))!;
            d.nodes.set(d.uid('dir/a.txt'), { ...node, name: { ok: true, value: 'renamed.txt' } } as typeof node);
            const dir = d.nodes.get(d.uid('dir'))!;
            d.nodes.set(d.uid('dir'), { ...dir, trashTime: new Date() });
            const before = d.nodes.size;
            await expect(d.engine.resolveConflictManually(d.conflict.id, 'keep-local')).rejects.toMatchObject({ status: 409 });
            expect(d.nodes.size).toBe(before);
            expect(d.nodes.get(d.uid('dir/a.txt'))?.content).toBe('cloud edit');
            expect(stateDb.getConflictById(d.conflict.id)?.resolved).toBe(0);
            expect(await readFile(d.file, 'utf8')).toBe('local edit');
        });
    });

    describe('a waiting conflict on a cloud file that claims no sha1 closes too (#88)', () => {
        test('reverted here, the cloud version comes down, and the next pass closes the conflict, hashing once more at most', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            const noSha1 = (uid: string) => {
                const node = d.nodes.get(uid)!;
                d.nodes.set(uid, { ...node, activeRevision: { ...node.activeRevision!, claimedDigests: { sha1: undefined } } } as any);
            };
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            noSha1(d.uid('a.txt'));
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const file = path.join(engine.localRoot(), 'a.txt');
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(file, 'local edit');
            await Bun.sleep(5);
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'a cloud edit' }));
            noSha1(d.uid('a.txt'));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            expect(conflict.localRelPath).toBe('a.txt');

            await writeFile(file, 'original'); // back to what was synced: only the cloud changed now
            await engine.reconcileNow();
            expect(await readFile(file, 'utf8')).toBe('a cloud edit');
            await engine.reconcileNow();
            expect(stateDb.getConflictById(conflict.id)).toMatchObject({ resolved: 1, resolution: 'in-sync' });
        });
    });

    describe('a drive rename or delete and a resolution by hand of the same file never overlap (#112)', () => {
        const queued = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            await writeFile(local('a.txt'), 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            expect(conflict.localRelPath).toBe('a.txt');
            // Holds the resolution's first look at the node until released
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const getNode = d.sdk.getNode.bind(d.sdk);
            const holdResolution = () => {
                (d.sdk as any).getNode = async (u: string) => {
                    if (u === d.uid('a.txt')) {
                        (d.sdk as any).getNode = getNode;
                        entered();
                        await gate;
                    }
                    return getNode(u);
                };
                return { release, inside };
            };
            return { ...d, engine, local, conflict, holdResolution };
        };

        test('a rename through the drive waits for the resolution, then moves what it left', async () => {
            const d = await queued();
            const held = d.holdResolution();
            const manual = d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            await held.inside;
            let renamed = false;
            const rename = d.engine.renameItem('a.txt', 'b.txt').then(() => (renamed = true));
            await Bun.sleep(20);
            expect(renamed).toBe(false);
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            held.release();
            await manual;
            await rename;
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-local']);
            expect(await readFile(d.local('b.txt'), 'utf8')).toBe('local edit');
            expect(stateDb.getItemByPath('b.txt')?.nodeUid).toBe(d.uid('a.txt'));
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
        });

        test('a delete through the drive waits no longer than its deadline, and then changes nothing', async () => {
            const d = await queued();
            const held = d.holdResolution();
            const manual = d.engine.resolveConflictManually(d.conflict.id, 'keep-local');
            await held.inside;
            await expect(d.engine.deleteItem('a.txt', { deadlineMs: Date.now() + 30 })).rejects.toMatchObject({ code: 'EIO' });
            held.release();
            await manual;
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            expect(stateDb.getItemByPath('a.txt')?.nodeUid).toBe(d.uid('a.txt'));
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-local']);
        });

        test('a delete of the folder holding the file waits for a keep-remote, then deletes what it left', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('F/a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            const file = path.join(engine.localRoot(), 'F/a.txt');
            await writeFile(file, 'local edit');
            const node = d.nodes.get(d.uid('F/a.txt'))!;
            d.nodes.set(d.uid('F/a.txt'), makeMockNode({ uid: d.uid('F/a.txt'), parentUid: node.parentUid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const getNode = d.sdk.getNode.bind(d.sdk);
            (d.sdk as any).getNode = async (u: string) => {
                if (u === d.uid('F/a.txt')) {
                    (d.sdk as any).getNode = getNode;
                    entered();
                    await gate;
                }
                return getNode(u);
            };
            const manual = engine.resolveConflictManually(conflict.id, 'keep-remote');
            await inside;
            let deleted = false;
            const del = engine.deleteItem('F').then(() => (deleted = true));
            await Bun.sleep(20);
            expect(deleted).toBe(false);
            release();
            await manual;
            await del;
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-remote']);
            expect(await stat(path.join(engine.localRoot(), 'F')).catch(() => null)).toBeNull();
            expect(stateDb.getItemByPath('F/a.txt')).toBeNull();
        });

        test('a resolution asked for while a drive rename of the file runs is refused, and changes nothing', async () => {
            const d = await queued();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const renameLocally = (d.engine as any).renameLocally.bind(d.engine);
            (d.engine as any).renameLocally = async (...args: unknown[]) => {
                entered();
                await gate;
                return renameLocally(...args);
            };
            const rename = d.engine.renameItem('a.txt', 'b.txt');
            await inside;
            await expect(d.engine.resolveConflictManually(d.conflict.id, 'keep-local')).rejects.toMatchObject({ status: 409 });
            release();
            await rename;
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit'); // nothing uploaded by a resolution
            expect(await readFile(d.local('b.txt'), 'utf8')).toBe('local edit');
        });
    });

    describe("a record's parent once its folder is in Proton Drive, and after an adopted stray node (#103)", () => {
        test('virtual: a move through the drive into a folder made here gets that folder as its parent once it is created', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            await mkdir(path.join(engine.localRoot(), 'N'));
            await engine.renameItem('a.txt', 'N/a.txt');
            await engine.replayRemoteOps();
            await engine.reconcileNow();
            await engine.replayRemoteOps();
            await engine.reconcileNow();
            const folder = [...d.nodes.values()].find((n) => n.parentUid === d.root.uid && d.nameOf(n) === 'N')!;
            expect(folder).toBeDefined();
            expect(d.nodes.get(d.uid('a.txt'))?.parentUid).toBe(folder.uid);
            expect(stateDb.getItemByPath('N/a.txt')?.parentNodeUid).toBe(folder.uid);
        });

        test('virtual: a new file moved through the drive into another folder while it uploads names that folder', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            const folder = d.add('Folder');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            await writeFile(path.join(engine.localRoot(), 'new.txt'), 'new');
            const getFileUploader = d.sdk.getFileUploader.bind(d.sdk);
            (d.sdk as any).getFileUploader = async (parent: NodeEntity, name: string, metadata: any) => {
                const uploader = await getFileUploader(parent, name, metadata);
                if (name !== 'new.txt') return uploader;
                return {
                    uploadFromStream: async (...args: Parameters<typeof uploader.uploadFromStream>) => {
                        const result = await uploader.uploadFromStream(...args);
                        await engine.renameItem('new.txt', 'Folder/new.txt'); // the user moves it as it uploads
                        return result;
                    },
                };
            };
            await (engine as any).handleLocalFileChange('new.txt');
            await engine.replayRemoteOps();
            const record = stateDb.getItemByPath('Folder/new.txt');
            expect(record).not.toBeNull();
            expect(d.nodes.get(record!.nodeUid)?.parentUid).toBe(folder.uid);
            expect(record!.parentNodeUid).toBe(folder.uid);
        });
    });

    describe('keep-both by hand when the user deletes or moves its conflict copy meanwhile (#122)', () => {
        for (const what of ['deleted', 'moved'] as const) {
            test(`a conflict copy ${what} before its upload: kept both as asked, nothing recorded for the copy`, async () => {
                const d = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    moveToDesktopTrash: async () => false,
                    settle: { quietMs: 0 },
                });
                d.add('Kept.txt', 'kept');
                d.add('a.txt', 'original');
                engine.availability.setPin(d.root.uid, 'pinned', false);
                await engine.reconcileNow();
                stateDb.updateSettings({ conflictStrategy: 'prompt' });
                const local = (rel: string) => path.join(engine.localRoot(), rel);
                await writeFile(local('a.txt'), 'local edit');
                d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
                await engine.reconcileNow();
                const [conflict] = stateDb.listConflicts();
                const upload = (engine as any).uploadConflictCopy.bind(engine);
                let copy = '';
                (engine as any).uploadConflictCopy = async (rel: string, ...rest: unknown[]) => {
                    copy = rel;
                    if (what === 'deleted') await rm(local(rel));
                    else await rename(local(rel), local('elsewhere.txt'));
                    return upload(rel, ...rest);
                };
                const resolved = await engine.resolveConflictManually(conflict.id, 'keep-both');
                expect(resolved.resolution).toBe('keep-both');
                // #127: it names no copy that isn't there
                expect(resolved.conflictCopyPath).toBeNull();
                expect(await readFile(local('a.txt'), 'utf8')).toBe('cloud edit');
                expect(stateDb.getItemByPath(copy)).toBeNull();
                if (what === 'moved') expect(await readFile(local('elsewhere.txt'), 'utf8')).toBe('local edit');
                await engine.reconcileNow();
                expect(await readFile(local('a.txt'), 'utf8')).toBe('cloud edit');
                if (what === 'moved') {
                    const uploaded = [...d.nodes.values()].filter((n) => n.parentUid === d.root.uid && d.nameOf(n) === 'elsewhere.txt');
                    expect(uploaded.map((n) => n.content)).toEqual(['local edit']);
                } else {
                    expect([...d.nodes.values()].filter((n) => d.nameOf(n).includes('(conflict'))).toEqual([]);
                }
            });
        }

        test('a conflict copy deleted as its upload starts, under the keep-both setting: settled, nothing left in the cloud', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            stateDb.updateSettings({ conflictStrategy: 'keep-both' });
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('a.txt'), 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            // The copy goes as the upload is asked for, before anything of it is read
            const getFileUploader = d.sdk.getFileUploader.bind(d.sdk);
            (d.sdk as any).getFileUploader = async (parent: NodeEntity, name: string, metadata: any) => {
                if (name.includes('(conflict')) await rm(path.join(engine.localRoot(), name), { force: true });
                return getFileUploader(parent, name, metadata);
            };
            await engine.reconcileNow();
            expect(await readFile(local('a.txt'), 'utf8')).toBe('cloud edit');
            expect(stateDb.listConflicts()).toEqual([]);
            // #127: no copy is named, the log says what happened, and no upload is said to have failed
            expect(stateDb.listConflicts(true).map((c) => [c.resolution, c.conflictCopyPath])).toEqual([['keep-both', null]]);
            const activity = stateDb.listActivity().map((a) => a.details ?? '');
            expect(activity.filter((t) => t.startsWith('Upload failed'))).toEqual([]);
            expect(activity.some((t) => t.includes('was moved or deleted before it uploaded'))).toBe(true);
            expect([...d.nodes.values()].filter((n) => d.nameOf(n).includes('(conflict'))).toEqual([]);
            expect(stateDb.getAllItems().filter((i) => i.localRelPath.includes('(conflict'))).toEqual([]);
        });
    });

    describe('a drive rename or delete and a resolution by the conflict setting never overlap (#121)', () => {
        const conflicted = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('a.txt'), 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            stateDb.updateSettings({ conflictStrategy: 'keep-local' });
            return { ...d, engine, local };
        };

        test('a delete through the drive waits for a keep-local by the setting, then deletes what it left', async () => {
            const d = await conflicted();
            // Holds the keep-local's upload of a.txt until released
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            (d.sdk as any).getFileRevisionUploader = ((orig) => async (...args: unknown[]) => {
                entered();
                await gate;
                return orig(...args);
            })((d.sdk as any).getFileRevisionUploader.bind(d.sdk));
            const pass = d.engine.reconcileNow();
            await inside;
            let deleted = false;
            const del = d.engine.deleteItem('a.txt').then(() => (deleted = true));
            await Bun.sleep(20);
            expect(deleted).toBe(false);
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            release();
            await pass;
            await del;
            await d.engine.replayRemoteOps();
            // The keep-local landed first, then the user's delete took the file: what the delete said is what happened
            expect(stateDb.listConflicts(true).map((c) => c.resolution)).toEqual(['keep-local']);
            expect(await stat(d.local('a.txt')).catch(() => null)).toBeNull();
            expect(d.calls.trashed.flat()).toContain(d.uid('a.txt'));
        });

        test('a delete queued behind another drive change is refused if a resolution by the setting starts meanwhile', async () => {
            const d = await conflicted();
            // Another drive change holds the turn
            let releaseRename!: () => void;
            const renameGate = new Promise<void>((resolve) => (releaseRename = resolve));
            let renaming!: () => void;
            const renameInside = new Promise<void>((resolve) => (renaming = resolve));
            const renameLocally = (d.engine as any).renameLocally.bind(d.engine);
            (d.engine as any).renameLocally = async (...args: unknown[]) => {
                renaming();
                await renameGate;
                return renameLocally(...args);
            };
            const rename = d.engine.renameItem('Kept.txt', 'Kept2.txt');
            await renameInside;
            const del = d.engine.deleteItem('a.txt').then(
                () => null,
                (error: unknown) => error,
            );
            await Bun.sleep(10); // past its wait for resolutions: queued for its turn
            // A resolution by the setting starts on a.txt, its upload held
            let releaseUpload!: () => void;
            const uploadGate = new Promise<void>((resolve) => (releaseUpload = resolve));
            let uploading!: () => void;
            const uploadInside = new Promise<void>((resolve) => (uploading = resolve));
            (d.sdk as any).getFileRevisionUploader = ((orig) => async (...args: unknown[]) => {
                uploading();
                await uploadGate;
                return orig(...args);
            })((d.sdk as any).getFileRevisionUploader.bind(d.sdk));
            const record = stateDb.getItemByPath('a.txt')!;
            const resolving = (d.engine as any).handleFileConflict(
                'a.txt', d.local('a.txt'), d.nodes.get(d.uid('a.txt')), 'local-sha1', null, 0, 0, new Map(),
                stateDb.getSettings(), 0, record,
            );
            await uploadInside;
            releaseRename();
            await rename;
            expect(await del).toMatchObject({ code: 'EIO' });
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
            releaseUpload();
            await resolving;
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('local edit');
        });

        test('a pass reaching the conflict while a drive rename of the file runs leaves it to the next pass', async () => {
            const d = await conflicted();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const renameLocally = (d.engine as any).renameLocally.bind(d.engine);
            (d.engine as any).renameLocally = async (...args: unknown[]) => {
                entered();
                await gate;
                return renameLocally(...args);
            };
            const rename = d.engine.renameItem('a.txt', 'b.txt');
            await inside;
            await (d.engine as any).handleFileConflict(
                'a.txt',
                d.local('a.txt'),
                d.nodes.get(d.uid('a.txt')),
                'local-sha1',
                null,
                0,
                0,
                new Map(),
                stateDb.getSettings(),
                0,
                stateDb.getItemByPath('a.txt') ?? undefined,
            );
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('cloud edit'); // nothing uploaded under the rename
            release();
            await rename;
            expect(await readFile(d.local('b.txt'), 'utf8')).toBe('local edit');
        });
    });

    describe('keep-both again after an unfinished one, when the earlier copy goes as it uploads (#137)', () => {
        for (const what of ['deleted', 'moved'] as const) test(`a retry by hand after the earlier copy is ${what} makes a new copy from the file as it is, and no upload is said to have failed`, async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('a.txt'), 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            // The first keep-both by hand fails at the download: its copy stays, made but not uploaded
            const download = (d.sdk as any).getFileRevisionDownloader.bind(d.sdk);
            (d.sdk as any).getFileRevisionDownloader = async () => {
                (d.sdk as any).getFileRevisionDownloader = download;
                throw new Error('network down');
            };
            await expect(engine.resolveConflictManually(conflict.id, 'keep-both')).rejects.toThrow();
            const copies = () => readdir(engine.localRoot()).then((names) => names.filter((n) => n.includes('(conflict')));
            const [earlier] = await copies();
            expect(earlier).toBeDefined();
            // The user tries again at once; the earlier copy goes as it uploads
            const getFileUploader = d.sdk.getFileUploader.bind(d.sdk);
            (d.sdk as any).getFileUploader = async (parent: NodeEntity, name: string, metadata: any) => {
                if (name === earlier) {
                    (d.sdk as any).getFileUploader = getFileUploader;
                    if (what === 'deleted') await rm(local(name), { force: true });
                    else await rename(local(name), local('kept elsewhere.txt'));
                }
                return getFileUploader(parent, name, metadata);
            };
            const resolved = await engine.resolveConflictManually(conflict.id, 'keep-both');
            expect(resolved.resolution).toBe('keep-both');
            expect(await readFile(local('a.txt'), 'utf8')).toBe('cloud edit');
            const now = await copies();
            expect(now.length).toBe(1);
            expect(await readFile(local(now[0]), 'utf8')).toBe('local edit');
            const inCloud = [...d.nodes.values()].filter((n) => d.nameOf(n).includes('(conflict'));
            expect(inCloud.map((n) => n.content)).toEqual(['local edit']);
            expect(stateDb.listActivity().filter((a) => (a.details ?? '').startsWith('Upload failed'))).toEqual([]);
            if (what === 'moved') {
                // Kept where the user put it: a new local file, uploaded by a later pass. Two copies, nothing lost
                expect(await readFile(local('kept elsewhere.txt'), 'utf8')).toBe('local edit');
                await engine.reconcileNow();
                const elsewhere = [...d.nodes.values()].filter((n) => d.nameOf(n) === 'kept elsewhere.txt');
                expect(elsewhere.map((n) => n.content)).toEqual(['local edit']);
            }
        });
    });

    describe('other sync work holds off a file being resolved by the conflict setting, as for one resolved by hand (#140)', () => {
        const synced = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'a');
            const folder = d.add('Folder');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            // A resolution by the setting is working on a.txt
            (engine as any).strategyResolvingPaths.add('a.txt');
            return { ...d, engine, local, folder };
        };

        test('a second resolution by the setting never starts on a file one is resolving, nor ends its claim', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const file = path.join(engine.localRoot(), 'a.txt');
            await writeFile(file, 'local edit');
            d.nodes.set(d.uid('a.txt'), makeMockNode({ uid: d.uid('a.txt'), parentUid: d.root.uid, nameStr: 'a.txt', type: NodeType.File, content: 'cloud edit' }));
            stateDb.updateSettings({ conflictStrategy: 'keep-local' });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            let uploads = 0;
            (d.sdk as any).getFileRevisionUploader = ((orig) => async (...args: unknown[]) => {
                uploads++;
                if (uploads === 1) {
                    entered();
                    await gate;
                }
                return orig(...args);
            })((d.sdk as any).getFileRevisionUploader.bind(d.sdk));
            const record = stateDb.getItemByPath('a.txt')!;
            const resolve = () =>
                (engine as any).handleFileConflict('a.txt', file, d.nodes.get(d.uid('a.txt')), 'local-sha1', null, 0, 0, new Map(), stateDb.getSettings(), 0, record);
            const first = resolve();
            await inside;
            await resolve(); // a watcher look reaching the same conflict
            expect(uploads).toBe(1);
            expect((engine as any).strategyResolvingPaths.has('a.txt')).toBe(true); // the first still holds its claim
            release();
            await first;
            expect(d.nodes.get(d.uid('a.txt'))?.content).toBe('local edit');
        });

        test('a local delete is not taken to the cloud meanwhile', async () => {
            const d = await synced();
            await rm(d.local('a.txt'));
            await (d.engine as any).trashForDeletedLocal('a.txt', d.nodes.get(d.uid('a.txt')));
            expect(d.calls.trashed).toEqual([]);
        });

        test('a cloud move is not followed meanwhile', async () => {
            const d = await synced();
            const node = d.nodes.get(d.uid('a.txt'))!;
            d.nodes.set(d.uid('a.txt'), { ...node, parentUid: d.folder.uid });
            await (d.engine as any).afterGoneFromCloudPath('a.txt');
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('a');
            expect(stateDb.getItemByPath('a.txt')?.nodeUid).toBe(d.uid('a.txt'));
        });

        test('a cloud move found from its new path is not followed meanwhile', async () => {
            const d = await synced();
            const node = d.nodes.get(d.uid('a.txt'))!;
            const moved = { ...node, parentUid: d.folder.uid };
            d.nodes.set(d.uid('a.txt'), moved);
            await (d.engine as any).reconcileSinglePath('Folder/a.txt', moved, undefined, undefined, new Map(), stateDb.getSettings(), 0);
            expect(await readFile(d.local('a.txt'), 'utf8')).toBe('a');
            expect(stateDb.getItemByPath('a.txt')?.nodeUid).toBe(d.uid('a.txt'));
        });
    });

    describe('the conflict setting never acts on a file a drive change took since the pass read it (#139)', () => {
        test('virtual: keep-remote after a drive rename of a file with no record does not bring the cloud version back', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'cloud');
            await engine.reconcileNow(); // online-only: a.txt has no record
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('a.txt'), 'mine'); // made local through the drive, say
            expect(stateDb.getItemByPath('a.txt')).toBeNull();
            stateDb.updateSettings({ conflictStrategy: 'keep-remote' });
            // The pass read the file (since = the removals finished then); the user renames it through the drive meanwhile
            await (engine as any).observingLocal(async (since: number) => {
                await engine.renameItem('a.txt', 'b.txt');
                await (engine as any).handleFileConflict(
                    'a.txt', local('a.txt'), d.nodes.get(d.uid('a.txt')), 'mine-sha1', null, 0, 0, new Map(),
                    stateDb.getSettings(), since, undefined,
                );
            });
            expect(await stat(local('a.txt')).catch(() => null)).toBeNull(); // not brought back
            expect(await readFile(local('b.txt'), 'utf8')).toBe('mine');
        });

        test('virtual: keep-remote after a drive rename onto the file never replaces what the rename put there', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'cloud');
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('a.txt'), 'mine');
            await writeFile(local('x.txt'), 'precious'); // only on this computer
            stateDb.updateSettings({ conflictStrategy: 'keep-remote' });
            await (engine as any).observingLocal(async (since: number) => {
                await engine.renameItem('x.txt', 'a.txt'); // the user saves x.txt over a.txt, as an editor does
                await (engine as any).handleFileConflict(
                    'a.txt', local('a.txt'), d.nodes.get(d.uid('a.txt')), 'mine-sha1', null, 0, 0, new Map(),
                    stateDb.getSettings(), since, undefined,
                );
            });
            expect(await readFile(local('a.txt'), 'utf8')).toBe('precious');
        });
    });

    describe('a local folder delete holds off while a file in it is being resolved (#143)', () => {
        for (const how of ['by hand', 'by the setting'] as const) {
            test(`nothing in the folder is trashed in the cloud while a file in it is resolved ${how}`, async () => {
                const d = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    moveToDesktopTrash: async () => false,
                    settle: { quietMs: 0 },
                });
                d.add('Kept.txt', 'kept');
                d.add('Folder/a.txt', 'a');
                d.add('Folder/b.txt', 'b');
                d.add('Folder/Sub/x.txt', 'x');
                d.add('Folder2/a.txt', 'other'); // named alike, outside it
                engine.availability.setPin(d.root.uid, 'pinned', false);
                await engine.reconcileNow();
                const resolving = (engine as any)[how === 'by hand' ? 'manualResolvingPaths' : 'strategyResolvingPaths'];
                resolving.add('Folder/Sub/x.txt');
                await rm(path.join(engine.localRoot(), 'Folder'), { recursive: true });
                await (engine as any).trashForDeletedLocal('Folder', d.nodes.get(d.uid('Folder')));
                await engine.reconcileNow(); // a whole pass, too, while the resolution runs
                expect(d.calls.trashed).toEqual([]);
                expect(stateDb.getItemByPath('Folder/Sub/x.txt')).not.toBeNull();
                // A file being resolved in a folder only named alike holds nothing off
                resolving.delete('Folder/Sub/x.txt');
                resolving.add('Folder2/a.txt');
                await (engine as any).trashForDeletedLocal('Folder', d.nodes.get(d.uid('Folder')));
                expect(d.calls.trashed).toEqual([[d.uid('Folder')]]);
                resolving.delete('Folder2/a.txt');
                await engine.reconcileNow();
                expect(stateDb.getAllItems().filter((i) => i.localRelPath.startsWith('Folder/'))).toEqual([]);
            });
        }
    });

    describe('a drive rename stays visible to work under way even if a step after the move fails (#145)', () => {
        test('virtual: the rename is seen once its edit-baseline step threw after the move', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'cloud');
            await engine.reconcileNow();
            await writeFile(path.join(engine.localRoot(), 'a.txt'), 'mine');
            // Whichever way its baselines go, that step fails, after the move
            const moveEditBaselines = stateDb.moveEditBaselines.bind(stateDb);
            const dropEditBaselines = stateDb.dropEditBaselines.bind(stateDb);
            let failing = true;
            (stateDb as any).moveEditBaselines = (...args: [string, string]) => {
                if (failing) throw new Error('database is locked');
                return moveEditBaselines(...args);
            };
            (stateDb as any).dropEditBaselines = (rel: string) => {
                if (failing) throw new Error('database is locked');
                return dropEditBaselines(rel);
            };
            await (engine as any).observingLocal(async (since: number) => {
                await expect(engine.renameItem('a.txt', 'b.txt')).rejects.toThrow('database is locked');
                expect(await readFile(path.join(engine.localRoot(), 'b.txt'), 'utf8')).toBe('mine'); // moved, all the same
                expect((engine as any).driveTouched('a.txt', since)).toBe(true);
                expect((engine as any).driveDestination('a.txt', since)).toBe('b.txt');
            });
            failing = false;
        });

        test('virtual: the rename is seen once clearing its in-progress marker threw after the move', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'cloud');
            await engine.reconcileNow();
            await writeFile(path.join(engine.localRoot(), 'a.txt'), 'mine');
            const deleteMeta = stateDb.deleteMeta.bind(stateDb);
            let failing = true;
            (stateDb as any).deleteMeta = (key: string) => {
                if (failing && key === 'localMoveInProgress') throw new Error('database is locked');
                return deleteMeta(key);
            };
            try {
                await (engine as any).observingLocal(async (since: number) => {
                    await expect(engine.renameItem('a.txt', 'b.txt')).rejects.toThrow('database is locked');
                    expect(await readFile(path.join(engine.localRoot(), 'b.txt'), 'utf8')).toBe('mine');
                    expect((engine as any).driveTouched('a.txt', since)).toBe(true);
                    expect((engine as any).driveDestination('a.txt', since)).toBe('b.txt');
                });
            } finally {
                failing = false;
            }
        });
    });

    describe('a cloud delete of a folder holds off while a file in it is being resolved (#150)', () => {
        for (const how of ['by hand', 'by the setting'] as const) {
            for (const via of ['its event', 'a pass']) {
                test(`nothing in the folder is removed here while a file in it is resolved ${how}, found by ${via}`, async () => {
                    const d = makeMockDrive();
                    const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                        moveToDesktopTrash: async () => false,
                        settle: { quietMs: 0 },
                    });
                    d.add('Kept.txt', 'kept');
                    d.add('Folder/Sub/a.txt', 'a');
                    d.add('Folder/b.txt', 'b');
                    engine.availability.setPin(d.root.uid, 'pinned', false);
                    await engine.reconcileNow();
                    const local = (rel: string) => path.join(engine.localRoot(), rel);
                    const resolving = (engine as any)[how === 'by hand' ? 'manualResolvingPaths' : 'strategyResolvingPaths'];
                    resolving.add('Folder/Sub/a.txt');
                    // Another device trashes the folder
                    const folder = d.nodes.get(d.uid('Folder'))!;
                    d.nodes.set(d.uid('Folder'), { ...folder, trashTime: new Date(), parentUid: 'vol~trash' });
                    if (via === 'its event') await (engine as any).removeAfterCloudDelete('Folder', 'trashed');
                    else await engine.reconcileNow();
                    expect(await readFile(local('Folder/Sub/a.txt'), 'utf8')).toBe('a');
                    expect(await readFile(local('Folder/b.txt'), 'utf8')).toBe('b');
                    expect(stateDb.getItemByPath('Folder/Sub/a.txt')).not.toBeNull();
                    // Once it is resolved, the next pass takes the delete here
                    resolving.delete('Folder/Sub/a.txt');
                    await engine.reconcileNow();
                    expect(await stat(local('Folder')).catch(() => null)).toBeNull();
                    expect(stateDb.getAllItems().filter((i) => i.localRelPath.startsWith('Folder'))).toEqual([]);
                });
            }
        }

        test('through its real event, the index let go of first, nothing is removed here until the next pass after', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Folder/Sub/a.txt', 'a');
            d.add('Folder/b.txt', 'b');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            (engine as any).strategyResolvingPaths.add('Folder/Sub/a.txt');
            const folder = d.nodes.get(d.uid('Folder'))!;
            d.nodes.set(folder.uid, { ...folder, trashTime: new Date(), parentUid: 'vol~trash' });
            await (engine as any).handleRemoteDriveEventNow({
                type: DriveEventType.NodeUpdated, nodeUid: folder.uid, parentNodeUid: 'vol~trash', isTrashed: true, treeEventScopeId: 's', eventId: 'e1',
            });
            const uploads = d.calls.uploads.length;
            await engine.reconcileNow(); // a pass meanwhile: nothing uploaded, nothing removed
            expect(d.calls.uploads.length).toBe(uploads);
            expect(await readFile(local('Folder/b.txt'), 'utf8')).toBe('b');
            (engine as any).strategyResolvingPaths.delete('Folder/Sub/a.txt');
            await engine.reconcileNow();
            expect(await stat(local('Folder')).catch(() => null)).toBeNull();
        });

        test('keep-both on a file whose folder was trashed in the cloud never puts its copy in that trash', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Folder/a.txt', 'original');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            stateDb.updateSettings({ conflictStrategy: 'prompt' });
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('Folder/a.txt'), 'mine');
            const node = d.nodes.get(d.uid('Folder/a.txt'))!;
            d.nodes.set(d.uid('Folder/a.txt'), makeMockNode({ uid: d.uid('Folder/a.txt'), parentUid: node.parentUid, nameStr: 'a.txt', type: NodeType.File, content: 'theirs' }));
            await engine.reconcileNow();
            const [conflict] = stateDb.listConflicts();
            // Another device trashes the folder as the user keeps both
            const folder = d.nodes.get(d.uid('Folder'))!;
            d.nodes.set(d.uid('Folder'), { ...folder, trashTime: new Date() });
            await engine.resolveConflictManually(conflict.id, 'keep-both').catch(() => {});
            await engine.reconcileNow();
            // The user's version is still on this computer, never only in the Proton Drive trash
            const mine = [];
            for (const name of await readdir(local('Folder')).catch(() => [] as string[])) {
                if ((await readFile(local(`Folder/${name}`), 'utf8').catch(() => '')) === 'mine') mine.push(name);
            }
            expect(mine.length).toBe(1);
            const inTrashedFolder = [...d.nodes.values()].filter((n) => n.parentUid === folder.uid && n.content === 'mine');
            expect(inTrashedFolder).toEqual([]);
        });

        test('nor is a cloud move of the folder followed here meanwhile', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Folder/Sub/a.txt', 'a');
            const other = d.add('Other');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            (engine as any).strategyResolvingPaths.add('Folder/Sub/a.txt');
            const folder = d.nodes.get(d.uid('Folder'))!;
            d.nodes.set(d.uid('Folder'), { ...folder, parentUid: other.uid });
            await (engine as any).afterGoneFromCloudPath('Folder');
            expect(await readFile(local('Folder/Sub/a.txt'), 'utf8')).toBe('a');
            expect(stateDb.getItemByPath('Folder/Sub/a.txt')).not.toBeNull();
            (engine as any).strategyResolvingPaths.delete('Folder/Sub/a.txt');
            await engine.reconcileNow();
            expect(await readFile(local('Other/Folder/Sub/a.txt'), 'utf8')).toBe('a');
        });
    });

    describe('a drive delete that rolls back is never seen as having happened (#154)', () => {
        test('virtual: a delete whose transaction throws leaves records, files and no drive change behind', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const enqueue = (engine as any).journal.enqueue.bind((engine as any).journal);
            (engine as any).journal.enqueue = () => {
                throw new Error('database is locked');
            };
            try {
                await (engine as any).observingLocal(async (since: number) => {
                    await expect(engine.deleteItem('a.txt')).rejects.toThrow('database is locked');
                    expect((engine as any).driveTouched('a.txt', since)).toBe(false);
                    expect((engine as any).driveDestination('a.txt', since)).toBeUndefined();
                });
            } finally {
                (engine as any).journal.enqueue = enqueue;
            }
            expect(stateDb.getItemByPath('a.txt')?.nodeUid).toBe(d.uid('a.txt'));
            expect(await readFile(path.join(engine.localRoot(), 'a.txt'), 'utf8')).toBe('a');
        });

        test('virtual: a delete that happened is seen, and work under way records nothing in it', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Docs/a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const record = stateDb.getItemByPath('Docs/a.txt')!;
            await (engine as any).observingLocal(async (since: number) => {
                await engine.deleteItem('Docs');
                expect((engine as any).driveTouched('Docs/a.txt', since)).toBe(true);
                expect((engine as any).driveDestination('Docs/a.txt', since)).toBeNull();
                // An upload begun before the delete, finishing after it, records nothing
                expect((engine as any).recordSynced({ ...record, updatedAt: undefined }, since)).toBe(false);
            });
            expect(stateDb.getItemByPath('Docs/a.txt')).toBeNull();
        });
    });

    describe('a stale move marker never moves a new file over another on the next start (#153)', () => {
        test('virtual: a replacing rename whose marker outlived it leaves a new file at its source alone', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('a.txt', 'old');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('x.txt'), 'saved'); // an editor's temp file, saved over a.txt
            // Clearing the marker fails after the move: it outlives it
            const deleteMeta = stateDb.deleteMeta.bind(stateDb);
            let failing = true;
            (stateDb as any).deleteMeta = (key: string) => {
                if (failing && key === 'localMoveInProgress') throw new Error('database is locked');
                return deleteMeta(key);
            };
            try {
                await expect(engine.renameItem('x.txt', 'a.txt')).rejects.toThrow('database is locked');
            } finally {
                failing = false;
            }
            expect(stateDb.getMeta('localMoveInProgress')).not.toBeNull();
            expect(await readFile(local('a.txt'), 'utf8')).toBe('saved');
            // The editor's next temp file, before the daemon starts again
            await writeFile(local('x.txt'), 'next draft');
            engine.recoverLocalMove();
            expect(await readFile(local('a.txt'), 'utf8')).toBe('saved');
            expect(await readFile(local('x.txt'), 'utf8')).toBe('next draft');
            expect(stateDb.getMeta('localMoveInProgress')).toBeNull();
        });

        test('virtual: an identity that matches nothing (renumbered by a remount, say) leaves recovery as it was', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('x.txt'), 'saved');
            await writeFile(local('a.txt'), 'old');
            stateDb.setMeta('localMoveInProgress', JSON.stringify({ from: 'x.txt', to: 'a.txt', replace: true, ino: '1', born: '1' }));
            engine.recoverLocalMove();
            expect(await readFile(local('a.txt'), 'utf8')).toBe('saved'); // finished, as a move not done must be
            expect(await stat(local('x.txt')).catch(() => null)).toBeNull();
        });

        test('virtual: a move interrupted before it happened is still finished, its item being the one at the source', async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await writeFile(local('x.txt'), 'saved');
            await writeFile(local('a.txt'), 'old');
            // The marker as written just before the move, then a crash
            stateDb.setMeta('localMoveInProgress', (engine as any).moveIntent('x.txt', 'a.txt', true));
            engine.recoverLocalMove();
            expect(await readFile(local('a.txt'), 'utf8')).toBe('saved');
            expect(await stat(local('x.txt')).catch(() => null)).toBeNull();
        });
    });

    describe('a new local file is never uploaded into a folder in the Proton Drive trash (#160)', () => {
        test('it stays on this computer, unrecorded, and the folder removal keeps it', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Folder/a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            // Another device trashes the folder; before this computer removes it, the user saves a new file in it
            const folder = d.nodes.get(d.uid('Folder'))!;
            d.nodes.set(d.uid('Folder'), { ...folder, trashTime: new Date() });
            await writeFile(local('Folder/new.txt'), 'new');
            await (engine as any).handleLocalFileChange('Folder/new.txt');
            expect([...d.nodes.values()].filter((n) => n.parentUid === folder.uid && d.nameOf(n) === 'new.txt')).toEqual([]);
            expect(stateDb.getItemByPath('Folder/new.txt')).toBeNull();
            await engine.reconcileNow();
            expect(await readFile(local('Folder/new.txt'), 'utf8')).toBe('new'); // only on this computer: kept
        });

        for (const via of ['the watcher', 'a pass']) {
            test(`nor is a new local folder made in it, seen by ${via}`, async () => {
                const d = makeMockDrive();
                const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                    moveToDesktopTrash: async () => false,
                    settle: { quietMs: 0 },
                });
                d.add('Kept.txt', 'kept');
                d.add('Folder/a.txt', 'a');
                engine.availability.setPin(d.root.uid, 'pinned', false);
                await engine.reconcileNow();
                const local = (rel: string) => path.join(engine.localRoot(), rel);
                const folder = d.nodes.get(d.uid('Folder'))!;
                d.nodes.set(d.uid('Folder'), { ...folder, trashTime: new Date() });
                await mkdir(local('Folder/Empty'));
                if (via === 'the watcher') {
                    await (engine as any).handleLocalFileChange('Folder/Empty');
                } else {
                    const st = await stat(local('Folder/Empty'));
                    const info = { isDirectory: true, size: 0, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
                    await (engine as any).reconcileSinglePath('Folder/Empty', undefined, info, undefined, new Map(), stateDb.getSettings(), 0);
                }
                expect([...d.nodes.values()].filter((n) => n.parentUid === folder.uid && d.nameOf(n) === 'Empty')).toEqual([]);
                expect(stateDb.getItemByPath('Folder/Empty')).toBeNull();
                // The folder's removal here then takes the empty folder with it: it holds nothing, and nothing of it
                // was ever put in the Proton Drive trash
                await engine.reconcileNow();
                expect([...d.nodes.values()].filter((n) => d.nameOf(n) === 'Empty')).toEqual([]);
            });
        }
    });

    describe('an upload held back says whether its folder is in the trash or could not be checked (#166)', () => {
        const setup = async () => {
            const d = makeMockDrive();
            const warnings: string[] = [];
            const logger = { ...d.logger, warn: (m: string) => warnings.push(m) };
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Outer/Folder/a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            await writeFile(path.join(engine.localRoot(), 'Outer/Folder/new.txt'), 'new');
            return { ...d, engine, warnings };
        };

        test('a folder above that could not be looked at is said to be unchecked, not in the trash', async () => {
            const d = await setup();
            const getNode = d.sdk.getNode.bind(d.sdk);
            (d.sdk as any).getNode = async (uid: string) => {
                if (uid === d.uid('Outer')) throw new Error('network down');
                return getNode(uid);
            };
            await (d.engine as any).handleLocalFileChange('Outer/Folder/new.txt');
            const held = d.warnings.filter((w) => w.includes('new.txt'));
            expect(held).toEqual([expect.stringContaining("couldn't be checked")]);
            expect(held[0]).not.toContain('is in the Proton Drive trash');
        });

        test('a folder above in the trash is said to be in the trash', async () => {
            const d = await setup();
            const outer = d.nodes.get(d.uid('Outer'))!;
            d.nodes.set(d.uid('Outer'), { ...outer, trashTime: new Date() });
            await (d.engine as any).handleLocalFileChange('Outer/Folder/new.txt');
            expect(d.warnings.filter((w) => w.includes('new.txt'))).toEqual([expect.stringContaining('is in the Proton Drive trash')]);
        });
    });

    describe('a new local folder never takes a cloud file holding its name (#165)', () => {
        test('nothing is recorded for it, and deleting it here never trashes the cloud file', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('X', 'a file in the cloud'); // online-only here
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            await mkdir(local('X'));
            await (engine as any).handleLocalFileChange('X').catch(() => {});
            expect(stateDb.getItemByPath('X')).toBeNull();
            await rm(local('X'), { recursive: true });
            await (engine as any).handleLocalFileChange('X').catch(() => {});
            expect(d.calls.trashed).toEqual([]);
            expect(d.nodes.get(d.uid('X'))?.trashTime).toBeFalsy();
        });
    });

    describe('a new local file in a folder deleted for good in the cloud never brings the folder back (#161)', () => {
        test('it stays on this computer, unrecorded, and the folder removal keeps it', async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Folder/a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            // Another device deletes the folder for good; before this computer removes it, the user saves a file in it
            d.nodes.delete(d.uid('Folder/a.txt'));
            d.nodes.delete(d.uid('Folder'));
            await writeFile(local('Folder/new.txt'), 'new');
            await (engine as any).handleLocalFileChange('Folder/new.txt').catch(() => {});
            expect([...d.nodes.values()].filter((n) => d.nameOf(n) === 'Folder' || d.nameOf(n) === 'new.txt')).toEqual([]);
            expect(stateDb.getItemByPath('Folder/new.txt')).toBeNull();
            await engine.reconcileNow();
            expect(await readFile(local('Folder/new.txt'), 'utf8')).toBe('new');
        });

        const synced = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Folder/a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            return { ...d, engine, local: (rel: string) => path.join(engine.localRoot(), rel) };
        };

        test('nor does a file in a new subfolder of it', async () => {
            const d = await synced();
            d.nodes.delete(d.uid('Folder/a.txt'));
            d.nodes.delete(d.uid('Folder'));
            await mkdir(d.local('Folder/Sub'));
            await writeFile(d.local('Folder/Sub/new.txt'), 'new');
            await (d.engine as any).handleLocalFileChange('Folder/Sub').catch(() => {});
            await expect((d.engine as any).handleLocalFileChange('Folder/Sub/new.txt')).rejects.toThrow(/gone from Proton Drive/);
            expect([...d.nodes.values()].filter((n) => ['Folder', 'Sub', 'new.txt'].includes(d.nameOf(n)))).toEqual([]);
        });

        test('a folder of that name made again in the cloud since takes the file, so nothing is held up for good', async () => {
            const d = await synced();
            d.nodes.delete(d.uid('Folder/a.txt'));
            d.nodes.delete(d.uid('Folder'));
            // Another folder, made since where the old one was: a node of its own
            const again = makeMockNode({ uid: 'vol~Folder-again', parentUid: d.root.uid, nameStr: 'Folder', type: NodeType.Folder });
            d.nodes.set(again.uid, again);
            await writeFile(d.local('Folder/new.txt'), 'new');
            await (d.engine as any).handleLocalFileChange('Folder/new.txt');
            const uploaded = [...d.nodes.values()].filter((n) => d.nameOf(n) === 'new.txt');
            expect(uploaded.map((n) => n.parentUid)).toEqual([again.uid]);
            expect([...d.nodes.values()].filter((n) => d.nameOf(n) === 'Folder').length).toBe(1);
        });
    });

    describe('a file deleted while its folder downloads is never downloaded (#179)', () => {
        const pinning = async () => {
            stateDb.setMeta('driveLayout', 'virtual');
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                backingDir: path.join(tempDir, 'files'),
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Big/a.bin', 'a');
            d.add('Big/b.bin', 'b');
            await engine.reconcileNow(); // online-only
            const local = (rel: string) => path.join(engine.localRoot(), rel);
            return { ...d, engine, local };
        };

        test('deleted through the drive while the pin downloads its folder', async () => {
            const d = await pinning();
            // The pin's download of a.bin is held: b.bin is still to come when the user deletes it
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const download = (d.sdk as any).getFileRevisionDownloader.bind(d.sdk);
            (d.sdk as any).getFileRevisionDownloader = async (...args: unknown[]) => {
                (d.sdk as any).getFileRevisionDownloader = download;
                entered();
                await gate;
                return download(...args);
            };
            const pin = d.engine.setAvailability('Big', 'pin');
            await inside;
            await d.engine.deleteItem('Big/b.bin');
            await d.engine.replayRemoteOps(); // trashed in Proton Drive
            release();
            await pin;
            await d.engine.reconcileNow();
            expect(await stat(d.local('Big/b.bin')).catch(() => null)).toBeNull();
            expect(await readFile(d.local('Big/a.bin'), 'utf8')).toBe('a');
            expect(d.calls.downloads).toEqual(['Big/a.bin']); // b.bin was never even asked for
        });

        test('deleted through the drive while its own download runs, it is never put in place nor recorded', async () => {
            const d = await pinning();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const download = (d.sdk as any).getFileRevisionDownloader.bind(d.sdk);
            (d.sdk as any).getFileRevisionDownloader = async (...args: unknown[]) => {
                const downloader = await download(...args);
                if (!String(args[0]).includes('b.bin')) return downloader;
                return {
                    ...downloader,
                    downloadToStream: (...dl: unknown[]) => {
                        const running = downloader.downloadToStream(...dl);
                        return {
                            ...running,
                            completion: async () => {
                                await running.completion();
                                entered();
                                await gate; // the bytes are in; placing them waits
                            },
                        };
                    },
                };
            };
            const pin = d.engine.setAvailability('Big', 'pin');
            await inside;
            await d.engine.deleteItem('Big/b.bin');
            await d.engine.replayRemoteOps();
            release();
            await pin;
            expect(await stat(d.local('Big/b.bin')).catch(() => null)).toBeNull();
            expect(stateDb.getItemByPath('Big/b.bin')).toBeNull();
        });

        test('nor when what Proton Drive says of it still looks live (a cache behind), after a drive delete since', async () => {
            const d = await pinning();
            d.engine.availability.setPin(d.uid('Big'), 'pinned', false);
            const node = d.nodes.get(d.uid('Big/b.bin'))!;
            await (d.engine as any).observingLocal(async (since: number) => {
                await d.engine.deleteItem('Big/b.bin');
                await d.engine.replayRemoteOps();
                const getNode = d.sdk.getNode.bind(d.sdk);
                (d.sdk as any).getNode = async (uid: string) => (uid === node.uid ? node : getNode(uid)); // as it was
                await (d.engine as any).reconcileSinglePath('Big/b.bin', node, undefined, undefined, new Map(), stateDb.getSettings(), since);
            });
            expect(await stat(d.local('Big/b.bin')).catch(() => null)).toBeNull();
        });

        test('a trash refused for a node already in the trash is done, not a failure', async () => {
            const d = await pinning();
            const node = d.nodes.get(d.uid('Big/b.bin'))!;
            // Trashed already (by a trash sent before a restart, say): Proton Drive refuses another
            d.nodes.set(node.uid, { ...node, trashTime: new Date() });
            (d.sdk as any).trashNodes = async function* (uids: string[]) {
                for (const uid of uids) yield { uid, ok: false, error: new ValidationError('Active file/folder not found') };
            };
            await d.engine.deleteItem('Big/b.bin');
            await d.engine.replayRemoteOps();
            const details = stateDb.listActivity().map((a) => a.details);
            expect(details).toContain('Already in Proton Drive Trash');
            expect(details.filter((t) => t.startsWith('Not moved to Proton Drive Trash'))).toEqual([]);
        });

        test('a pass whose listing still has a file trashed meanwhile never downloads it', async () => {
            const d = await pinning();
            d.engine.availability.setPin(d.uid('Big'), 'pinned', false);
            // Trashed by this computer, but a listing read before still names it (as after a restart)
            const node = d.nodes.get(d.uid('Big/b.bin'))!;
            d.nodes.set(node.uid, { ...node, trashTime: new Date() });
            const st = undefined;
            await (d.engine as any).observingLocal((since: number) =>
                (d.engine as any).reconcileSinglePath('Big/b.bin', node, st, undefined, new Map(), stateDb.getSettings(), since),
            );
            expect(await stat(d.local('Big/b.bin')).catch(() => null)).toBeNull();
        });
    });

    describe('signing in to a different Proton account never reuses the last one\'s records (#35)', () => {
        const synced = async () => {
            const d = makeMockDrive();
            const engine = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
            d.add('Kept.txt', 'kept');
            d.add('Docs/a.txt', 'a');
            engine.availability.setPin(d.root.uid, 'pinned', false);
            await engine.reconcileNow();
            return { ...d, engine, local: (rel: string) => path.join(engine.localRoot(), rel) };
        };

        test('the account the records belong to is remembered, and the same account syncs on as before', async () => {
            const d = await synced();
            expect(stateDb.getMeta('accountRoot')).toBe(d.root.uid);
            await writeFile(d.local('Docs/new.txt'), 'new');
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toContain('Docs/new.txt');
            expect(d.engine.getStatus().accountMismatch).toBeNull();
        });

        test('records of another account: nothing is synced, deleted, trashed or uploaded, and the status says why', async () => {
            const d = await synced();
            stateDb.setMeta('accountRoot', 'other~root'); // the records are another account's
            await writeFile(d.local('Docs/new.txt'), 'new');
            await rm(d.local('Kept.txt'));
            d.calls.uploads.length = 0;
            await d.engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            expect(stateDb.getItemByPath('Docs/a.txt')).not.toBeNull();
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
            const status = d.engine.getStatus();
            expect(status.accountMismatch?.message).toMatch(/different Proton account/);
            expect(status.state).toBe('error');
            await expect(d.engine.setAvailability('Docs', 'free')).rejects.toThrow(/different Proton account/);
            await expect(d.engine.deleteItem('Docs/a.txt')).rejects.toThrow(/different Proton account/);
            await expect(d.engine.resolveConflictManually(1, 'keep-both')).rejects.toThrow(/different Proton account/);
            await d.engine.replayRemoteOps();
            expect(d.calls.trashed).toEqual([]);
        });

        test('starting fresh keeps every file here and syncs them as new to this account, trashing nothing', async () => {
            const d = await synced();
            stateDb.setMeta('accountRoot', 'other~root');
            await d.engine.reconcileNow();
            d.calls.uploads.length = 0;
            await d.engine.startFreshForThisAccount();
            expect(stateDb.getMeta('accountRoot')).toBe(d.root.uid);
            expect(d.engine.getStatus().accountMismatch).toBeNull();
            await d.engine.reconcileNow();
            expect(d.calls.trashed).toEqual([]);
            expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
            expect(await readFile(d.local('Kept.txt'), 'utf8')).toBe('kept');
            expect(stateDb.getItemByPath('Docs/a.txt')).not.toBeNull();
        });

        test('passes asked for together never run together (the account check sits inside the guard)', async () => {
            const d = await synced();
            let running = 0;
            let most = 0;
            const walk = (d.engine as any).reconcileDirectoryIncremental.bind(d.engine);
            (d.engine as any).reconcileDirectoryIncremental = async (...args: unknown[]) => {
                if (args[1] === '') {
                    running++;
                    most = Math.max(most, running);
                    try {
                        return await walk(...args);
                    } finally {
                        running--;
                    }
                }
                return walk(...args);
            };
            await Promise.all([d.engine.reconcileNow(), d.engine.reconcileNow(), d.engine.reconcileNow()]);
            for (let i = 0; i < 20 && (d.engine as any).reconcileRunning; i++) await Bun.sleep(5);
            expect(most).toBe(1);
        });

        const otherAccount = (d: Awaited<ReturnType<typeof synced>>) => {
            stateDb.setMeta('accountRoot', 'other~root');
            // Restarted, signed in to the other account: a new engine on the same records
            return new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
                settle: { quietMs: 0 },
            });
        };

        test('after a restart the account is checked at start, before anything watches: local changes act on nothing', async () => {
            const d = await synced();
            const engine = otherAccount(d);
            await engine.start();
            expect(engine.getStatus().accountMismatch).not.toBeNull();
            await writeFile(d.local('Docs/new.txt'), 'new');
            await rm(d.local('Kept.txt'));
            d.calls.uploads.length = 0;
            await (engine as any).handleLocalFileChange('Docs/new.txt');
            await (engine as any).handleLocalFileChange('Kept.txt');
            expect(d.calls.uploads).toEqual([]);
            expect(d.calls.trashed).toEqual([]);
            expect(stateDb.getItemByPath('Kept.txt')).not.toBeNull();
            await engine.stop();
        });

        test('a local change before any check looks the account up first, and acts on nothing for another', async () => {
            const d = await synced();
            const engine = otherAccount(d);
            await writeFile(d.local('Docs/new.txt'), 'new');
            d.calls.uploads.length = 0;
            await (engine as any).handleLocalFileChange('Docs/new.txt');
            expect(d.calls.uploads).toEqual([]);
            expect(engine.getStatus().accountMismatch).not.toBeNull();
        });

        test('a pass whose root lookup fails acts on nothing, and checks the account before it does', async () => {
            const d = await synced();
            const engine = otherAccount(d);
            const root = d.sdk.getMyFilesRootFolder.bind(d.sdk);
            let first = true;
            (d.sdk as any).getMyFilesRootFolder = async () => {
                if (first) {
                    first = false;
                    throw new Error('timeout');
                }
                return root();
            };
            await writeFile(d.local('Docs/new.txt'), 'new');
            d.calls.uploads.length = 0;
            await engine.reconcileNow();
            await engine.reconcileNow();
            expect(d.calls.uploads).toEqual([]);
            expect(engine.getStatus().accountMismatch).not.toBeNull();
        });

        test('records from before the account was remembered are adopted only if they are of the account signed in to', async () => {
            const d = await synced();
            stateDb.deleteMeta('accountRoot');
            const same = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
            });
            await same.reconcileNow();
            expect(stateDb.getMeta('accountRoot')).toBe(d.root.uid);
            // Another account's, from before an upgrade: their top items name another root
            stateDb.deleteMeta('accountRoot');
            for (const item of stateDb.getAllItems().filter((i) => !i.localRelPath.includes('/'))) {
                stateDb.upsertItem({ ...item, parentNodeUid: 'other~root' });
            }
            const other = new ProtonDriveSyncEngine(d.sdk, d.eventsManager, { isLoggedIn: () => true }, stateDb, d.logger, {
                moveToDesktopTrash: async () => false,
            });
            await other.reconcileNow();
            expect(other.getStatus().accountMismatch).not.toBeNull();
            expect(stateDb.getMeta('accountRoot')).toBeNull();
        });

        test('starting fresh is refused when there is no other account to start fresh from', async () => {
            const d = await synced();
            await expect(d.engine.startFreshForThisAccount()).rejects.toThrow(/same Proton account/);
        });
    });
});
