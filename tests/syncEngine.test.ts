import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    type DriveEvent,
    DriveEventType,
    type NodeEntity,
    NodeType,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import type { Manager as EventsManager } from '../src/sdk/events/manager';
import { computeLocalFileSha1, detectMediaType, THIRD_PARTY_DISCLOSURE } from '../src/sdk/fileOps';
import { entryFromNode } from '../src/sync/remoteIndex';
import { createLocalConflictCopy, formatConflictFileName } from '../src/sync/conflictResolver';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
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
                if (!found) throw new Error(`Node ${uid} not found`);
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
                    if (!found) throw new Error(`Node ${uid} not found`);
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
            engine.availability.setPin(rootNode.uid, 'pinned', false);
            await engine.start();

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
            expect(engine.remoteIndex.getByPath('Other/x.txt')).not.toBeNull();
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
            const { engine, nodes, calls, files } = await partlyDownloaded();

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
            const { engine, nodes, calls, files } = await partlyDownloaded();

            await rm(local('Photos'), { recursive: true });
            await (engine as any).handleLocalFileChange('Photos');

            expect(calls.trashed).toEqual([['vol~Photos/a.jpg']]);
            expect(nodes.has('vol~Photos')).toBe(true);
            expect(files.recordCount('Photos')).toBe(0);
        });

        test('a deleted pinned folder holding something never downloaded is left online-only, not brought back', async () => {
            const { engine, add, nodes, calls, files } = setup();
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

        test('a deleted folder is not trashed while its cloud contents cannot all be listed', async () => {
            const { engine, calls, failListing, warnings, files } = await partlyDownloaded();
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
});
