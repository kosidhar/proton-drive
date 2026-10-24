import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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

import type { Manager as EventsManager } from '../src/sdk/events/manager';
import { computeLocalFileSha1, detectMediaType, THIRD_PARTY_DISCLOSURE } from '../src/sdk/fileOps';
import { PIN_ROOT_ON_FIRST_SYNC } from '../src/sync/availabilityMigration';
import { entryFromNode } from '../src/sync/remoteIndex';
import { createLocalConflictCopy, formatConflictFileName } from '../src/sync/conflictResolver';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { type AvailabilityResult, ProtonDriveSyncEngine } from '../src/sync/syncEngine';
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

        test('deleting a file that was replaced in the cloud by another of the same name trashes nothing when the recorded one is gone', async () => {
            const { engine, add, root, nodes, calls, files } = setup();
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
            const { engine, nodes, calls, files } = await downloaded({ 'Old/a.txt': 'a', 'Old/sub/b.txt': 'b' }, 'vol~Old');
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
});
