import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
import { createLocalConflictCopy, formatConflictFileName } from '../src/sync/conflictResolver';
import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
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

    test('matches ignore patterns and selective sync exclusions', () => {
        const patterns = ['.git', 'node_modules', '*.tmp'];
        const excludedFolders = ['Archive'];

        expect(matchesIgnorePatterns('.git/config', patterns, excludedFolders)).toBe(true);
        expect(matchesIgnorePatterns('project/node_modules/pkg/index.js', patterns, excludedFolders)).toBe(true);
        expect(matchesIgnorePatterns('notes/draft.tmp', patterns, excludedFolders)).toBe(true);
        expect(matchesIgnorePatterns('Archive/2025/tax.pdf', patterns, excludedFolders)).toBe(true);
        expect(matchesIgnorePatterns('Documents/report.pdf', patterns, excludedFolders)).toBe(false);
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

    describe('Cloud only', () => {
        const syncDir = () => stateDb.getSettings().syncDir;
        const exists = (rel: string) =>
            stat(path.join(syncDir(), rel))
                .then(() => true)
                .catch(() => false);
        const recordCount = (dir: string) =>
            stateDb.getAllItems().filter((i) => i.localRelPath === dir || i.localRelPath.startsWith(`${dir}/`)).length;
        const writeLocal = async (rel: string, content: string) => {
            await mkdir(path.dirname(path.join(syncDir(), rel)), { recursive: true });
            await writeFile(path.join(syncDir(), rel), content);
        };
        // A file as the engine leaves it after a sync: on disk and recorded with matching hashes
        const writeSynced = async (rel: string, content: string) => {
            await writeLocal(rel, content);
            const fullPath = path.join(syncDir(), rel);
            const st = await stat(fullPath);
            const sha1 = await computeLocalFileSha1(fullPath);
            stateDb.upsertItem({
                localRelPath: rel,
                nodeUid: `uid-${rel}`,
                parentNodeUid: null,
                type: 'file',
                localSha1: sha1,
                remoteSha1: sha1,
                localMtimeMs: st.mtimeMs,
                remoteMtimeMs: st.mtimeMs,
                size: st.size,
                syncStatus: 'synced',
                lastError: null,
            });
        };
        const makeEngine = () =>
            new ProtonDriveSyncEngine(
                {} as ProtonDriveClient,
                {} as EventsManager,
                { isLoggedIn: () => true },
                stateDb,
                { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            );

        test('removes a folder whose every file is an unchanged synced copy', async () => {
            await writeSynced('Archive/2025/tax.pdf', 'tax');
            await writeSynced('Archive/touched.txt', 'same content');
            // Touched but not changed: size and mtime no longer match the record, so only the hash can tell
            await utimes(path.join(syncDir(), 'Archive/touched.txt'), new Date(), new Date(Date.now() + 60_000));
            stateDb.updateSettings({ excludedFolders: ['Archive'] });

            await makeEngine().applySelectiveSyncExclusions();

            expect(await exists('Archive')).toBe(false);
            expect(recordCount('Archive')).toBe(0);
            expect(stateDb.getSettings().excludedFolders).toEqual(['Archive']);
            const logged = stateDb.listActivity().filter((a) => a.localRelPath === 'Archive');
            expect(logged.map((a) => a.action)).toEqual(['delete-local']);
            expect((await readdir(syncDir())).filter((n) => n.startsWith('.proton-drive-tmp-'))).toEqual([]);
        });

        test('keeps a folder holding anything that exists only on this computer, and says why', async () => {
            await writeSynced('Code/app/main.ts', 'synced');
            await writeLocal('Code/app/.git/HEAD', 'ref: refs/heads/main'); // ignored, so never uploaded
            await writeSynced('Drafts/old.txt', 'synced');
            await writeLocal('Drafts/new.txt', 'not uploaded yet');
            await writeSynced('Notes/todo.txt', 'synced version');
            await writeFile(path.join(syncDir(), 'Notes/todo.txt'), 'edited after the last sync');
            await writeSynced('Photos/cat.jpg', 'meow');
            stateDb.updateSettings({ excludedFolders: ['Code', 'Drafts', 'Notes', 'Photos'] });

            await makeEngine().applySelectiveSyncExclusions();

            for (const kept of ['Code/app/main.ts', 'Code/app/.git/HEAD', 'Drafts/old.txt', 'Drafts/new.txt']) {
                expect(await exists(kept)).toBe(true);
            }
            expect(await readFile(path.join(syncDir(), 'Notes/todo.txt'), 'utf8')).toBe('edited after the last sync');
            expect([recordCount('Code'), recordCount('Drafts'), recordCount('Notes')]).toEqual([1, 1, 1]);
            expect(await exists('Photos')).toBe(false);
            expect(stateDb.getSettings().excludedFolders).toEqual(['Photos']);
            const refusals = stateDb.listActivity().filter((a) => a.action === 'error');
            expect(refusals.map((a) => a.localRelPath).sort()).toEqual(['Code', 'Drafts', 'Notes']);
            expect(refusals.find((a) => a.localRelPath === 'Code')!.details).toContain(
                'Code/app/.git matches an ignore pattern',
            );
            expect(refusals.find((a) => a.localRelPath === 'Drafts')!.details).toContain('Drafts/new.txt');
            expect(refusals.find((a) => a.localRelPath === 'Notes')!.details).toContain('Notes/todo.txt');
        });

        test('leaves the folder alone when it is switched back to Sync while being checked', async () => {
            await writeSynced('Music/song.mp3', 'la la');
            await writeSynced('Music/track.mp3', 'dum dum');
            await writeLocal('Music/demo.mp3', 'not uploaded yet');
            stateDb.updateSettings({ excludedFolders: ['Music'] });
            // The user switches back to Sync once the check has started looking at files
            const getItemByPath = stateDb.getItemByPath.bind(stateDb);
            stateDb.getItemByPath = (rel: string) => {
                if (rel.startsWith('Music/')) {
                    stateDb.updateSettings({ excludedFolders: [] });
                }
                return getItemByPath(rel);
            };

            await makeEngine().applySelectiveSyncExclusions();

            expect(await exists('Music/song.mp3')).toBe(true);
            expect(recordCount('Music')).toBe(2);
            // Nothing to refuse either: the folder is no longer on its way to Cloud only
            expect(stateDb.listActivity().filter((a) => a.localRelPath === 'Music')).toHaveLength(0);
        });

        test('never treats a name that is not a single top-level folder as something to delete', async () => {
            await writeSynced('Docs/a/b.txt', 'b');
            stateDb.updateSettings({ excludedFolders: ['..', '.', 'Docs/a', ''] });

            await makeEngine().applySelectiveSyncExclusions();

            expect(await exists('Docs/a/b.txt')).toBe(true);
            expect(recordCount('Docs')).toBe(1);
        });

        // A record whose file is gone reads as the user deleting it, and trashes the cloud copy on the next pass
        const expectNoRecordWithoutFile = async (dir: string) => {
            for (const item of stateDb.getAllItems().filter((i) => i.localRelPath.startsWith(`${dir}/`))) {
                expect({ path: item.localRelPath, exists: await exists(item.localRelPath) }).toEqual({
                    path: item.localRelPath,
                    exists: true,
                });
            }
        };
        // Runs `during` once, just before the n-th record removal (removal drops each record right before its file)
        const onRemoval = (n: number, during: (rel: string) => Promise<void> | void) => {
            const removeItemByPath = stateDb.removeItemByPath.bind(stateDb);
            let calls = 0;
            const pending: Promise<void>[] = [];
            stateDb.removeItemByPath = (rel: string) => {
                calls += 1;
                if (calls === n) {
                    const result = during(rel);
                    if (result) {
                        pending.push(result);
                    }
                }
                removeItemByPath(rel);
            };
            return () => Promise.all(pending);
        };

        test('stops when something new is saved into the folder while it is being removed', async () => {
            await writeSynced('Shots/2024/a.png', 'a');
            await writeSynced('Shots/2024/b.png', 'b');
            await writeSynced('Shots/2025/c.png', 'c');
            stateDb.updateSettings({ excludedFolders: ['Shots'] });
            // Another app saves into a folder the removal hasn't reached yet
            const written = onRemoval(1, () => writeFileSync(path.join(syncDir(), 'Shots/2024/new.png'), 'new'));

            await makeEngine().applySelectiveSyncExclusions();
            await written();

            expect(await readFile(path.join(syncDir(), 'Shots/2024/new.png'), 'utf8')).toBe('new');
            await expectNoRecordWithoutFile('Shots');
            expect(stateDb.listActivity().filter((a) => a.action === 'delete-local')).toHaveLength(0);
        });

        test('stops when a file it has not reached yet is edited while the folder is being removed', async () => {
            const files = ['Docs/a.txt', 'Docs/b.txt', 'Docs/sub/c.txt'];
            for (const f of files) {
                await writeSynced(f, 'synced');
            }
            stateDb.updateSettings({ excludedFolders: ['Docs'] });
            // Everything but the file being removed right now gets edited
            onRemoval(1, (rel) => {
                for (const f of files.filter((f) => f !== rel)) {
                    writeFileSync(path.join(syncDir(), f), 'edited while removing');
                }
            });

            await makeEngine().applySelectiveSyncExclusions();

            const left = [];
            for (const f of files) {
                if (await exists(f)) {
                    left.push(await readFile(path.join(syncDir(), f), 'utf8'));
                }
            }
            expect(left).toEqual(['edited while removing', 'edited while removing']);
            await expectNoRecordWithoutFile('Docs');
        });

        test('stops when the folder is switched back to Sync while it is being removed', async () => {
            await writeSynced('Books/a.epub', 'a');
            await writeSynced('Books/b.epub', 'b');
            await writeSynced('Books/c.epub', 'c');
            stateDb.updateSettings({ excludedFolders: ['Books'] });
            onRemoval(2, () => {
                stateDb.updateSettings({ excludedFolders: [] });
            });

            await makeEngine().applySelectiveSyncExclusions();

            await expectNoRecordWithoutFile('Books');
            expect(stateDb.getAllItems().filter((i) => i.localRelPath.startsWith('Books/')).length).toBeGreaterThan(0);
        });

        test('leaves alone a local folder that reappears after the folder went Cloud only, and says so once', async () => {
            await writeLocal('Downloads/invoice.pdf', 'saved by a browser');
            stateDb.updateSettings({ excludedFolders: ['Downloads'] });
            const engine = makeEngine();

            await engine.applySelectiveSyncExclusions();
            await engine.applySelectiveSyncExclusions();

            expect(await exists('Downloads/invoice.pdf')).toBe(true);
            expect(stateDb.getSettings().excludedFolders).toEqual(['Downloads']);
            expect(stateDb.listActivity().filter((a) => a.localRelPath === 'Downloads')).toHaveLength(1);
        });

        test('only unlinks a top-level folder that is a symlink, and a symlink inside a folder blocks it', async () => {
            const outside = path.join(tempDir, 'elsewhere');
            await mkdir(outside, { recursive: true });
            await writeFile(path.join(outside, 'keep.txt'), 'outside the sync folder');
            await mkdir(syncDir(), { recursive: true });
            await symlink(outside, path.join(syncDir(), 'Linked'));
            await writeSynced('Mixed/a.txt', 'a');
            await symlink(outside, path.join(syncDir(), 'Mixed/link'));
            stateDb.updateSettings({ excludedFolders: ['Linked', 'Mixed'] });

            await makeEngine().applySelectiveSyncExclusions();

            expect(await exists('Linked')).toBe(false);
            expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside the sync folder');
            expect(await exists('Mixed/a.txt')).toBe(true);
            expect(stateDb.listActivity().find((a) => a.localRelPath === 'Mixed')!.details).toContain(
                "Mixed/link isn't a regular file",
            );
        });

        test('drops records left for a folder that is already gone', async () => {
            await writeSynced('Gone/file.txt', 'x');
            await rm(path.join(syncDir(), 'Gone'), { recursive: true });
            stateDb.updateSettings({ excludedFolders: ['Gone'] });

            await makeEngine().applySelectiveSyncExclusions();

            expect(recordCount('Gone')).toBe(0);
        });
    });
});
