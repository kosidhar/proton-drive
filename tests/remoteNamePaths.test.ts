// #536: names come from Proton Drive decrypted, and Proton's servers can't check them (the SDK checks only their
// length). Someone with edit rights on a folder the user shares can name an item `../../.config/autostart/x.desktop`, or
// a folder `..`. Nothing may ever turn such a name into a path: the item isn't synced, listed in the drive or downloaded,
// nothing is written, moved or deleted outside the sync folder or the backing store, a local copy is never deleted
// for it, and nothing in Proton Drive is trashed. Nor may a bad path a past sync left in the records be acted on.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type DriveEvent, DriveEventType, NodeType } from '@protontech/drive-sdk';

import { quotedName, remoteNameProblem } from '../src/sdk/node';
import { AvailabilityPolicy } from '../src/sync/availability';
import { migrateExcludedFolders } from '../src/sync/availabilityMigration';
import { docRecordOf } from '../src/sync/docNodes';
import { relocateFiles } from '../src/sync/layoutMigration';
import { removeScannedEntries, scanLocalCopies } from '../src/sync/localCopies';
import { localPathIn, relPathProblem, UnsafeLocalPathError } from '../src/sync/localPath';
import { entryFromNode, RemoteIndex } from '../src/sync/remoteIndex';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { roomyDisk, uploadAtOnce } from './helpers/engineOptions';
import { makeMockDrive, type MockNode } from './helpers/mockDrive';
import { makeMockNode } from './helpers/mockNodes';

describe('remoteNameProblem (#536)', () => {
    test('a name that is empty, . or .., or holds a / or a NUL is refused', () => {
        for (const name of ['', '.', '..', 'a/b.txt', '/', '../../evil.txt', '..\0', 'a\0b', 'dir/']) {
            expect([name, remoteNameProblem(name)]).toEqual([name, expect.any(String)]);
        }
    });

    test('a name longer than 255 bytes, the most a name can be on Linux, is refused; 255 bytes is fine', () => {
        expect(remoteNameProblem('é'.repeat(128))).toEqual(expect.any(String)); // 256 bytes, 128 characters
        expect(remoteNameProblem('é'.repeat(200))).toEqual(expect.any(String)); // the SDK allows 255 characters
        expect(remoteNameProblem(`${'é'.repeat(127)}a`)).toBeNull(); // 255 bytes
        expect(remoteNameProblem('a'.repeat(255))).toBeNull();
    });

    test('any other name is fine, dots and odd characters included', () => {
        for (const name of ['a.txt', '...', '.hidden', '..a', 'a..', ' spaced ', 'é', '\\', 'a\\..\\b', 'C:', '\n']) {
            expect([name, remoteNameProblem(name)]).toEqual([name, null]);
        }
    });

    test('quotedName writes a name as JSON, with the marks that reorder text escaped too', () => {
        expect(quotedName('a\nb"c')).toBe('"a\\nb\\"c"');
        expect(quotedName('\0')).toBe('"\\u0000"');
        expect(quotedName('evil\u202Etxt.exe')).toBe('"evil\\u202etxt.exe"');
        expect(quotedName('line\u2028sep')).toBe('"line\\u2028sep"');
    });

    test('the remote index and the Docs records leave out a node with such a name', () => {
        const file = (name: string) => makeMockNode({ uid: 'vol~x', parentUid: 'vol~root', nameStr: name, type: NodeType.File, content: 'x' });
        const doc = (name: string) => ({ ...file(name), mediaType: 'application/vnd.proton.doc' });
        for (const bad of ['..', '.', 'a/b', 'a\0b', '../../evil.txt']) {
            expect(entryFromNode(file(bad), 'Docs')).toBeNull();
            expect(docRecordOf(doc(bad), 'vol~root')).toBeNull();
        }
        expect(entryFromNode(file('ok.txt'), 'Docs')?.relPath).toBe('Docs/ok.txt');
        expect(docRecordOf(doc('Plan'), 'vol~root')?.name).toBe('Plan');
    });
});

describe('localPathIn (#536)', () => {
    const root = '/home/u/ProtonDrive';

    test('a relative path inside the root is joined to it, and the empty path is the root', () => {
        expect(localPathIn(root, '')).toBe(root);
        expect(localPathIn(root, 'a')).toBe(`${root}/a`);
        expect(localPathIn(root, 'Docs/a b/c.txt')).toBe(`${root}/Docs/a b/c.txt`);
        expect(localPathIn(root, '...')).toBe(`${root}/...`);
        expect(localPathIn(`${root}/`, '.hidden/x')).toBe(`${root}/.hidden/x`);
    });

    test('anything that could leave the root, or names no item, is refused with UnsafeLocalPathError', () => {
        for (const rel of ['/etc/passwd', '..', '.', '../x', 'a/../../x', 'a/..', 'a/./b', 'a//b', 'a/', '/', 'a\0b', '\0']) {
            expect(() => localPathIn(root, rel)).toThrow(UnsafeLocalPathError);
            expect([rel, relPathProblem(rel)]).toEqual([rel, expect.any(String)]);
        }
        expect(relPathProblem('')).toBeNull();
        expect(relPathProblem('a/b')).toBeNull();
    });
});

describe('what keeps a bad path from the disk (#536)', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'protondrive-paths-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    const item = (localRelPath: string) => ({
        localRelPath,
        nodeUid: `uid-${localRelPath}`,
        parentNodeUid: null,
        type: 'file' as const,
        localSha1: null,
        remoteSha1: null,
        localMtimeMs: 0,
        remoteMtimeMs: 0,
        size: 0,
        syncStatus: 'synced' as const,
        lastError: null,
    });
    const insertRecord = (rel: string) =>
        stateDb.connection
            .query(
                `INSERT INTO synced_items (localRelPath, nodeUid, parentNodeUid, type, localSha1, remoteSha1, localMtimeMs,
                     remoteMtimeMs, size, syncStatus, lastError, updatedAt) VALUES (?, ?, NULL, 'file', NULL, NULL, 0, 0, 0, 'synced', NULL, 0)`,
            )
            .run(rel, `uid-${rel}`);

    test('a record is never written, nor moved, to a path that could lead out of the folder', () => {
        for (const rel of ['../x', 'a/../../x', '..', '.', '/etc/passwd', 'a//b', 'a\0b', '']) {
            expect(() => stateDb.upsertItem(item(rel))).toThrow(UnsafeLocalPathError);
        }
        stateDb.upsertItem(item('Docs/a.txt'));
        expect(() => stateDb.renameItemPath('Docs/a.txt', '../a.txt')).toThrow(UnsafeLocalPathError);
        expect(stateDb.getItemByPath('Docs/a.txt')).not.toBeNull();
        expect(stateDb.getAllItems().map((i) => i.localRelPath)).toEqual(['Docs/a.txt']);
    });

    test('dropUnsafeItems takes out exactly the records whose path could lead out of the folder', () => {
        const bad = ['..', '../x', 'Docs/../../x', 'Docs/..', 'Docs/.', './a', 'a//b', '/abs', 'a/'];
        const good = ['Docs/a.txt', '...', 'Docs/..a', 'Docs/a..', '.hidden/x'];
        for (const rel of [...bad, ...good]) insertRecord(rel);
        expect(stateDb.dropUnsafeItems().map((i) => i.localRelPath).sort()).toEqual([...bad].sort());
        expect(stateDb.getAllItems().map((i) => i.localRelPath).sort()).toEqual([...good].sort());
    });

    // #543: conflicts table refuses unsafe paths on write and dropUnsafeConflicts cleans any pre-#536 rows
    test('conflicts refuse unsafe paths and dropUnsafeConflicts removes bad rows while keeping good ones', () => {
        const newConflict = (rel: string) => ({
            localRelPath: rel,
            nodeUid: `uid-${rel}`,
            localSha1: 'a',
            remoteSha1: 'b',
            localMtimeMs: 1,
            remoteMtimeMs: 2,
        });
        for (const rel of ['../x', 'Shared/../../.bashrc', '..', '.', '/etc/passwd', 'a//b', 'a\0b', '']) {
            expect(() => stateDb.recordConflict(newConflict(rel))).toThrow(UnsafeLocalPathError);
            expect(() => stateDb.recordConflict({ ...newConflict(rel), resolved: true })).toThrow(UnsafeLocalPathError);
            expect(() => stateDb.queueConflict(newConflict(rel))).toThrow(UnsafeLocalPathError);
            expect(() => stateDb.settleConflict({ ...newConflict(rel), resolution: 'keep-both' })).toThrow(UnsafeLocalPathError);
        }

        const insertConflict = stateDb.connection.query(
            `INSERT INTO conflicts (localRelPath, nodeUid, localSha1, remoteSha1, localMtimeMs, remoteMtimeMs, detectedAt, resolved)
             VALUES (?, ?, 'a', 'b', 1, 2, 1000, ?)`,
        );
        const tooLong = `Docs/${'x'.repeat(256)}`;
        const bad = ['Shared/../../.bashrc', '..', '../x', 'Docs/.', '/etc/passwd', 'a//b', 'a/', 'a\0b', tooLong, ''];
        const good = ['Docs/a.txt', 'Shared/..notes.txt'];
        for (const rel of bad) insertConflict.run(rel, `uid-${rel}`, 0);
        insertConflict.run('Shared/../../old-resolved', 'uid-old-res', 1);
        for (const rel of good) insertConflict.run(rel, `uid-${rel}`, 0);

        const dropped = stateDb.dropUnsafeConflicts();
        expect(dropped.map((c) => c.localRelPath).sort()).toEqual([...bad, 'Shared/../../old-resolved'].sort());
        expect(stateDb.listConflicts(true).map((c) => c.localRelPath).sort()).toEqual([...good].sort());
    });

    test('the remote index refuses an entry whose path or name would lead elsewhere, and drops one a past listing left', () => {
        const index = new RemoteIndex(stateDb.connection);
        index.setRoot('root');
        const entry = (uid: string, relPath: string, name: string) => ({
            uid,
            parentUid: 'root',
            relPath,
            name,
            type: 'folder' as const,
            size: 0,
            mtimeMs: 0,
            sha1: null,
        });
        expect(() => index.upsert(entry('a', '..', '..'))).toThrow(UnsafeLocalPathError);
        expect(() => index.upsert(entry('b', 'a/b', 'a/b'))).toThrow(UnsafeLocalPathError);
        index.upsert(entry('ok', 'Docs', 'Docs'));
        const insert = stateDb.connection.query(
            `INSERT INTO remote_nodes (uid, parentUid, relPath, name, type, size, mtimeMs, sha1) VALUES (?, ?, ?, ?, 'folder', 0, 0, NULL)`,
        );
        insert.run('dotdot', 'root', '..', '..');
        insert.run('under-dotdot', 'dotdot', '../x', 'x');
        insert.run('slash', 'root', 'a/b', 'a/b');
        insert.run('under-slash', 'slash', 'a/b/c', 'c');
        expect(index.dropUnsafe().map((e) => e.uid).sort()).toEqual(['dotdot', 'slash']);
        for (const uid of ['dotdot', 'under-dotdot', 'slash', 'under-slash']) expect(index.getByUid(uid)).toBeNull();
        expect(index.getByPath('Docs')?.uid).toBe('ok');
        expect(index.getByPath('')?.uid).toBe('root');
    });

    test('a scan or removal of local copies refuses a path out of the folder before touching anything', async () => {
        const syncDir = path.join(tempDir, 'ProtonDrive');
        await mkdir(syncDir);
        await writeFile(path.join(tempDir, 'victim.txt'), 'mine');
        const scan = (relPath: string) =>
            scanLocalCopies({ syncDir, relPath, ignorePatterns: [], stopAtFirst: false, isUnchangedSyncedCopy: async () => true });
        await expect(scan('../victim.txt')).rejects.toThrow(UnsafeLocalPathError);
        await expect(scan('Docs/../../victim.txt')).rejects.toThrow(UnsafeLocalPathError);
        const dropped: string[] = [];
        await expect(
            removeScannedEntries({
                syncDir,
                entries: [{ relPath: '../victim.txt', signature: 'file:4:0' }],
                keep: new Set(),
                mode: 'keep-changed',
                dropRecord: (rel) => dropped.push(rel),
                shouldContinue: () => true,
            }),
        ).rejects.toThrow(UnsafeLocalPathError);
        expect(dropped).toEqual([]);
        expect(await readFile(path.join(tempDir, 'victim.txt'), 'utf8')).toBe('mine');
    });

    test('moving the sync folder, and the availability migration, leave a bad record alone and look nothing up for it', async () => {
        const from = path.join(tempDir, 'Old');
        const to = path.join(tempDir, 'New');
        await mkdir(path.join(from, 'Docs'), { recursive: true });
        await writeFile(path.join(from, 'Docs', 'a.txt'), 'a');
        stateDb.updateSettings({ syncDir: from });
        stateDb.upsertItem(item('Docs/a.txt'));
        insertRecord('../Old/Docs/a.txt'); // Would be "there" from the new folder's side, and kept for it
        insertRecord('../gone.txt');
        const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
        await relocateFiles({ stateDb, from, to, logger });
        expect(await readFile(path.join(to, 'Docs', 'a.txt'), 'utf8')).toBe('a');
        expect(stateDb.getAllItems().map((i) => i.localRelPath).sort()).toEqual(['../Old/Docs/a.txt', '../gone.txt', 'Docs/a.txt']);

        stateDb.setMeta('excludedFolders', JSON.stringify(['..']));
        const policy = new AvailabilityPolicy(stateDb.connection, new RemoteIndex(stateDb.connection));
        expect(await migrateExcludedFolders(stateDb, policy, path.join(tempDir, 'state.sqlite'), to)).toBe('migrated');
        expect(stateDb.getAllItems().map((i) => i.localRelPath).sort()).toEqual(['../Old/Docs/a.txt', '../gone.txt', 'Docs/a.txt']);
    });
});

describe('names from Proton Drive that would leave the sync folder (#536)', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'protondrive-names-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
        stateDb.updateSettings({ syncDir: path.join(tempDir, 'ProtonDrive'), notificationsEnabled: false });
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    // Everything in tempDir that isn't the engine's root nor the database, with each file's content: what a sync must
    // never change. A sibling folder of the root, with a file of the user's in it, is there from the start.
    const outsideRoot = (root: string): string[] => {
        const out: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir).sort()) {
                const full = path.join(dir, name);
                if (full === root || (dir === tempDir && name.startsWith('state.sqlite'))) continue;
                const st = lstatSync(full);
                const rel = path.relative(tempDir, full);
                if (st.isDirectory()) {
                    out.push(`${rel}/`);
                    walk(full);
                } else {
                    out.push(`${rel}: ${readFileSync(full, 'utf8')}`);
                }
            }
        };
        walk(tempDir);
        return out;
    };

    for (const layout of ['plain', 'virtual'] as const) {
        describe(`${layout} layout`, () => {
            const setup = async () => {
                if (layout === 'virtual') stateDb.setMeta('driveLayout', 'virtual');
                const backingDir = path.join(tempDir, 'files');
                const root = layout === 'virtual' ? backingDir : stateDb.getSettings().syncDir;
                await mkdir(path.join(tempDir, 'sibling'), { recursive: true });
                await writeFile(path.join(tempDir, 'sibling', 'mine.txt'), "the user's own file");
                await writeFile(path.join(tempDir, 'victim.txt'), 'mine');
                const drive = makeMockDrive({ slashFreeUids: true });
                const desktopTrash: string[] = [];
                const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, {
                    ...uploadAtOnce,
                    ...roomyDisk,
                    ...(layout === 'virtual' ? { backingDir } : {}),
                    moveToDesktopTrash: async (fullPath: string) => {
                        desktopTrash.push(fullPath);
                        return false;
                    },
                    forgetFailedThumbnail: async () => {},
                });
                // A node added as Proton Drive would hand it over, whatever its name
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
                const rename = (uid: string, name: string) => {
                    const node = drive.nodes.get(uid)!;
                    drive.nodes.set(uid, { ...node, name: { ok: true as const, value: name } });
                };
                const local = (rel: string) => path.join(root, rel);
                const before = outsideRoot(root);
                return { ...drive, engine, rootDir: root, backingDir, addNode, rename, local, desktopTrash, before };
            };

            test('a file or folder with such a name is never synced, nothing leaves the root, and the rest syncs', async () => {
                const d = await setup();
                d.add('Shared/ok.txt', 'ok');
                d.add('top.txt', 'top');
                const shared = d.nodes.get(d.uid('Shared'))!;
                d.addNode('vol~evil-up', shared.uid, '../../evil.txt', 'pwned');
                d.addNode('vol~evil-slash', shared.uid, 'a/b.txt', 'slash');
                d.addNode('vol~evil-nul', shared.uid, 'nul\0.txt', 'nul');
                d.addNode('vol~dotdot', d.root.uid, '..');
                d.addNode('vol~dotdot-file', 'vol~dotdot', 'escaped.txt', 'escaped');
                d.addNode('vol~dot', d.root.uid, '.');
                d.addNode('vol~dot-file', 'vol~dot', 'dot.txt', 'dot');
                d.engine.availability.setPin(d.root.uid, 'pinned', false);

                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(await readFile(d.local('Shared/ok.txt'), 'utf8')).toBe('ok');
                expect(await readFile(d.local('top.txt'), 'utf8')).toBe('top');
                expect(readdirSync(d.rootDir).sort()).toEqual(['Shared', 'top.txt']);
                expect(readdirSync(d.local('Shared')).sort()).toEqual(['ok.txt']);
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.downloads.sort()).toEqual(['Shared/ok.txt', 'top.txt']);
                expect(d.desktopTrash).toEqual([]);
                // Skipped, not failed: nothing is wrong with the rest of the sync
                expect(d.engine.getStatus().lastError).toBeNull();
                for (const uid of ['vol~evil-up', 'vol~evil-slash', 'vol~evil-nul', 'vol~dotdot', 'vol~dot', 'vol~dotdot-file', 'vol~dot-file']) {
                    expect([uid, d.engine.remoteIndex.getByUid(uid)]).toEqual([uid, null]);
                    expect(d.nodes.has(uid)).toBe(true);
                }
                // Told once per node, by its uid, the name only as JSON
                for (const uid of ['vol~evil-up', 'vol~evil-slash', 'vol~evil-nul', 'vol~dotdot', 'vol~dot']) {
                    expect([uid, d.warnings.filter((w) => w.includes(`(${uid})`)).length]).toEqual([uid, 1]);
                }
                expect(d.warnings.some((w) => w.includes('"../../evil.txt"'))).toBe(true);
                expect(d.warnings.some((w) => w.includes('\0'))).toBe(false);
                expect(stateDb.listActivity(100).some((a) => a.details.includes('"a/b.txt"'))).toBe(true);
                // The drive lists none of them, nor any placeholder for one
                if (layout === 'virtual') {
                    expect(d.engine.vfsChildren('').map((e) => e.name)).toEqual(['Shared', 'top.txt']);
                    expect(d.engine.vfsChildren('Shared').map((e) => e.name)).toEqual(['ok.txt']);
                }
                await d.engine.stop();
            });

            test('an online-only file with such a name is never listed in the drive nor downloaded by an open', async () => {
                const d = await setup();
                d.add('Shared/ok.txt', 'ok');
                const shared = d.nodes.get(d.uid('Shared'))!;
                d.addNode('vol~evil-slash', shared.uid, 'a/b.txt', 'slash');
                d.addNode('vol~evil-up', shared.uid, '../../evil.txt', 'pwned');
                d.addNode('vol~evil-doc', shared.uid, '../../plan', 'doc');
                d.nodes.set('vol~evil-doc', { ...d.nodes.get('vol~evil-doc')!, mediaType: 'application/vnd.proton.doc' });
                await d.engine.reconcileNow(); // Nothing pinned: all online-only, Shared crawled for the index

                expect(d.engine.remoteIndex.getByPath('Shared/ok.txt')).not.toBeNull();
                expect(d.engine.docNodes.listChildren(shared.uid)).toEqual([]);
                if (layout === 'virtual') {
                    expect(d.engine.vfsChildren('Shared').map((e) => e.name)).toEqual(['ok.txt']);
                    await expect(d.engine.hydrate('Shared/a/b.txt')).rejects.toMatchObject({ code: 'ENOENT' });
                    await expect(d.engine.hydrate('Shared/../../evil.txt')).rejects.toThrow('Invalid path');
                    await d.engine.hydrate('Shared/ok.txt');
                    expect(await readFile(d.local('Shared/ok.txt'), 'utf8')).toBe('ok');
                }
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(d.calls.downloads).toEqual(layout === 'virtual' ? ['Shared/ok.txt'] : []);
                expect(d.calls.trashed).toEqual([]);
                await d.engine.stop();
            });

            test('a synced file or folder renamed to such a name keeps its local copy, moves nothing and trashes nothing', async () => {
                const d = await setup();
                d.add('Docs/a.txt', 'a');
                d.add('Folder/f.txt', 'f');
                d.add('Other/o.txt', 'o');
                d.add('Long/l.txt', 'l');
                d.engine.availability.setPin(d.root.uid, 'pinned', false);
                await d.engine.reconcileNow();
                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
                expect(await readFile(d.local('Folder/f.txt'), 'utf8')).toBe('f');

                d.rename(d.uid('Docs/a.txt'), '../../evil.txt');
                d.rename(d.uid('Folder'), '..');
                d.rename(d.uid('Other/o.txt'), 'x/o.txt');
                // 400 bytes: within the SDK's 255 characters, but too long for a name here, so following it would fail
                d.rename(d.uid('Long/l.txt'), 'é'.repeat(200));
                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
                expect(await readFile(d.local('Folder/f.txt'), 'utf8')).toBe('f');
                expect(await readFile(d.local('Other/o.txt'), 'utf8')).toBe('o');
                expect(await readFile(d.local('Long/l.txt'), 'utf8')).toBe('l');
                expect(d.calls.trashed).toEqual([]);
                expect(d.desktopTrash).toEqual([]);
                for (const uid of [d.uid('Docs/a.txt'), d.uid('Folder'), d.uid('Folder/f.txt'), d.uid('Other/o.txt'), d.uid('Long/l.txt')]) {
                    expect(d.nodes.has(uid)).toBe(true);
                }
                // Both copies are kept: the local ones are no longer the renamed nodes', so they upload as new items
                expect(d.calls.uploads.sort()).toEqual(['Docs/a.txt', 'Folder/f.txt', 'Long/l.txt', 'Other/o.txt']);
                expect(d.engine.getStatus().lastError).toBeNull();
                await d.engine.stop();
            });

            test('a synced file moved into a folder with such a name, at any depth, keeps its local copy', async () => {
                const d = await setup();
                d.add('Docs/a.txt', 'a');
                d.add('Docs/b.txt', 'b');
                d.add('top.txt', 'top');
                d.engine.availability.setPin(d.root.uid, 'pinned', false);
                await d.engine.reconcileNow();
                // A folder named `..` with a plain folder in it, which the index never holds, nor anything below it
                d.addNode('vol~bad', d.root.uid, '..');
                d.addNode('vol~bad-inner', 'vol~bad', 'Inner');
                const move = (rel: string, parentUid: string) => d.nodes.set(d.uid(rel), { ...d.nodes.get(d.uid(rel))!, parentUid });
                move('Docs/a.txt', 'vol~bad');
                move('Docs/b.txt', 'vol~bad-inner');

                await d.engine.reconcileNow();
                await d.engine.reconcileNow();

                expect(await readFile(d.local('Docs/a.txt'), 'utf8')).toBe('a');
                expect(await readFile(d.local('Docs/b.txt'), 'utf8')).toBe('b');
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(d.calls.trashed).toEqual([]);
                expect(d.desktopTrash).toEqual([]);
                expect(d.calls.uploads.sort()).toEqual(['Docs/a.txt', 'Docs/b.txt']);
                await d.engine.stop();
            });

            test('a folder deleted here keeps in Proton Drive what in it has such a name', async () => {
                const d = await setup();
                d.add('Proj/a.txt', 'a');
                d.add('top.txt', 'top'); // Not everything gone: that is the files missing, never a delete
                const proj = d.nodes.get(d.uid('Proj'))!;
                d.engine.availability.setPin(d.root.uid, 'pinned', false);
                await d.engine.reconcileNow();
                d.addNode('vol~proj-evil', proj.uid, '../x', 'never here');

                await rm(d.local('Proj'), { recursive: true });
                await d.engine.reconcileNow();

                expect(d.calls.trashed).toEqual([[d.uid('Proj/a.txt')]]);
                expect(d.nodes.has(proj.uid)).toBe(true);
                expect(d.nodes.has('vol~proj-evil')).toBe(true);
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                await d.engine.stop();
            });

            test('a bad path a past sync left in the records is never acted on, by a sync pass or a cloud change', async () => {
                const d = await setup();
                d.add('Docs/ok.txt', 'ok');
                const docs = d.nodes.get(d.uid('Docs'))!;
                d.engine.availability.setPin(d.root.uid, 'pinned', false);
                await d.engine.reconcileNow();
                expect(await readFile(d.local('Docs/ok.txt'), 'utf8')).toBe('ok');
                // Proton Drive has the nodes under good names now: a pass would follow them here from the bad paths
                d.addNode('vol~outside', d.root.uid, 'outside');
                d.addNode('vol~outside-keep', 'vol~outside', 'keep.txt', 'cloud keep');
                d.addNode('vol~victim', 'vol~nowhere', 'victim.txt', 'cloud victim');
                await mkdir(path.join(tempDir, 'outside'), { recursive: true });
                await writeFile(path.join(tempDir, 'outside', 'keep.txt'), 'keep');
                const before = outsideRoot(d.rootDir);
                // As a sync before #536 recorded what it wrote outside the root (unchanged since, by its hashes)
                const record = (rel: string, uid: string, parentUid: string | null, file: string | null) => {
                    const st = file === null ? null : lstatSync(file);
                    const sha1 = file === null ? null : createHash('sha1').update(readFileSync(file)).digest('hex');
                    stateDb.connection
                        .query(
                            `INSERT INTO synced_items (localRelPath, nodeUid, parentNodeUid, type, localSha1, remoteSha1,
                                 localMtimeMs, remoteMtimeMs, size, syncStatus, lastError, updatedAt, contentReadAt)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL, ?, ?)`,
                        )
                        .run(rel, uid, parentUid, file === null ? 'folder' : 'file', sha1, sha1, st ? Math.round(st.mtimeMs) : 0, 0, st ? st.size : 0, Date.now(), Date.now() + 1000);
                };
                record('Docs/../../victim.txt', 'vol~victim', docs.uid, path.join(tempDir, 'victim.txt'));
                record('../outside', 'vol~outside', d.root.uid, null);
                record('../outside/keep.txt', 'vol~outside-keep', 'vol~outside', path.join(tempDir, 'outside', 'keep.txt'));
                record('Docs/../../sibling/mine.txt', 'vol~mine', docs.uid, path.join(tempDir, 'sibling', 'mine.txt'));

                await d.engine.start({ backgroundInitialReconcile: false });
                const event = (type: DriveEventType, nodeUid: string, parentNodeUid: string, isTrashed?: boolean) =>
                    d.fire({ type, nodeUid, parentNodeUid, isTrashed, isShared: false, treeEventScopeId: 'scope-main', eventId: `e-${nodeUid}` } as DriveEvent);
                await event(DriveEventType.NodeUpdated, 'vol~victim', docs.uid, true);
                await event(DriveEventType.NodeUpdated, 'vol~outside', d.root.uid, true);
                await event(DriveEventType.NodeDeleted, 'vol~outside-keep', 'vol~outside');
                await event(DriveEventType.NodeDeleted, 'vol~mine', docs.uid);
                await d.engine.reconcileNow();

                expect(outsideRoot(d.rootDir)).toEqual(before);
                expect(await readFile(path.join(tempDir, 'victim.txt'), 'utf8')).toBe('mine');
                expect(await readFile(path.join(tempDir, 'outside', 'keep.txt'), 'utf8')).toBe('keep');
                expect(await readFile(path.join(tempDir, 'sibling', 'mine.txt'), 'utf8')).toBe("the user's own file");
                expect(d.calls.trashed).toEqual([]);
                expect(d.calls.uploads).toEqual([]);
                expect(d.desktopTrash).toEqual([]);
                expect(await readFile(d.local('Docs/ok.txt'), 'utf8')).toBe('ok');
                // Not acted on, nor kept: no record is left with a path out of the root
                expect(stateDb.getAllItems().filter((i) => relPathProblem(i.localRelPath) !== null)).toEqual([]);
                await d.engine.stop();
            });

            // #543: conflict rows with bad paths left by a sync before #536 are dropped and logged on start/reconcile
            test('a conflict row with a bad path from a past sync is dropped with a warning while good conflicts stay', async () => {
                const d = await setup();
                const warnings: string[] = [];
                const origWarn = d.logger.warn.bind(d.logger);
                d.logger.warn = (msg: string) => {
                    warnings.push(msg);
                    return origWarn(msg);
                };
                d.add('Docs/ok.txt', 'ok');
                await d.engine.reconcileNow();
                stateDb.connection
                    .query(
                        `INSERT INTO conflicts (localRelPath, nodeUid, localSha1, remoteSha1, localMtimeMs, remoteMtimeMs, detectedAt, resolved)
                         VALUES (?, ?, 'a', 'b', 1, 2, 1000, 0)`,
                    )
                    .run('Shared/../../.bashrc', 'vol~bad-conflict');
                stateDb.recordConflict({
                    localRelPath: 'Docs/ok.txt',
                    nodeUid: d.uid('Docs/ok.txt'),
                    localSha1: 'a',
                    remoteSha1: 'b',
                    localMtimeMs: 1,
                    remoteMtimeMs: 2,
                });

                await d.engine.reconcileNow();

                expect(stateDb.listConflicts(true).map((c) => c.localRelPath)).toEqual(['Docs/ok.txt']);
                expect(warnings.some((m) => m.includes('Dropped the conflict for') && m.includes('Shared/../../.bashrc'))).toBe(true);
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                await d.engine.stop();
            });

            // #557: standalone conflict resolution (e.g. CLI `protondrive conflicts resolve`) refuses empty or unsafe
            // conflict rows directly, even when start()/reconcileNow() has not run dropUnsafePaths() first
            test('resolveConflictManually refuses empty or unsafe conflict paths before touching disk', async () => {
                const d = await setup();
                d.add('Docs/ok.txt', 'ok');
                const insertConflict = stateDb.connection.query(
                    `INSERT INTO conflicts (localRelPath, nodeUid, localSha1, remoteSha1, localMtimeMs, remoteMtimeMs, detectedAt, resolved)
                     VALUES (?, ?, 'a', 'b', 1, 2, 1000, 0)`,
                );
                const emptyId = Number(insertConflict.run('', d.uid('Docs/ok.txt')).lastInsertRowid);
                const escapeId = Number(insertConflict.run('Shared/../../.bashrc', d.uid('Docs/ok.txt')).lastInsertRowid);

                for (const id of [emptyId, escapeId]) {
                    for (const choice of ['keep-both', 'keep-local', 'keep-remote'] as const) {
                        await expect(d.engine.resolveConflictManually(id, choice)).rejects.toMatchObject({
                            name: 'ConflictRefusedError',
                            status: 409,
                            message: expect.stringMatching(/unsafe path/i),
                        });
                    }
                    expect(stateDb.getConflictById(id)?.resolved).toBe(0);
                }
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(d.calls.uploads).toEqual([]);
                expect(d.calls.downloads).toEqual([]);
                await d.engine.stop();
            });

            // The second line: should a bad path reach the engine past the drop at the start of a pass, every way it could
            // reach the disk refuses it, and none takes the refusal for the item being gone
            test('a bad path that gets past the drop is refused wherever it would reach the disk, deleting nothing', async () => {
                const d = await setup();
                d.add('Docs/ok.txt', 'ok');
                d.engine.availability.setPin(d.root.uid, 'pinned', false);
                await d.engine.reconcileNow();
                const st = lstatSync(path.join(tempDir, 'victim.txt'));
                const sha1 = createHash('sha1').update('mine').digest('hex');
                stateDb.connection
                    .query(
                        `INSERT INTO synced_items (localRelPath, nodeUid, parentNodeUid, type, localSha1, remoteSha1, localMtimeMs,
                             remoteMtimeMs, size, syncStatus, lastError, updatedAt, contentReadAt)
                         VALUES ('Docs/../../victim.txt', 'vol~victim', NULL, 'file', ?, ?, ?, 0, 4, 'synced', NULL, 0, ?)`,
                    )
                    .run(sha1, sha1, Math.round(st.mtimeMs), Date.now() + 1000);
                const engine = d.engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
                await expect(engine.removeAfterCloudDelete!('Docs/../../victim.txt', 'trashed')).rejects.toThrow(UnsafeLocalPathError);
                await expect(engine.followRemoteMove!('vol~victim', 'Docs/../../victim.txt', 'Docs/victim.txt')).rejects.toThrow(
                    UnsafeLocalPathError,
                );
                await expect(engine.afterGoneFromCloudPath!('Docs/../../victim.txt')).rejects.toThrow(UnsafeLocalPathError);
                expect(() => engine.existsLocally!('Docs/../../victim.txt')).toThrow(UnsafeLocalPathError);
                await expect(d.engine.setAvailability('Docs/../../victim.txt', 'free')).rejects.toThrow();
                await expect(d.engine.deleteItem('Docs/../../victim.txt')).rejects.toThrow('Invalid path');
                await expect(d.engine.renameItem('Docs/../../victim.txt', 'Docs/v.txt')).rejects.toThrow('Invalid path');
                expect(await d.engine.availabilityOf('Docs/ok.txt')).toBeDefined();
                await expect(d.engine.availabilityOf('../victim.txt')).rejects.toThrow('Not in Proton Drive');
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(d.calls.trashed).toEqual([]);
                expect(d.desktopTrash).toEqual([]);
                await d.engine.stop();
            });

            test('a bad path in the remote index or the Docs records from a past sync is never listed or opened', async () => {
                const d = await setup();
                d.add('Docs/ok.txt', 'ok');
                await d.engine.reconcileNow();
                const docs = d.engine.remoteIndex.getByPath('Docs')!;
                // As a listing before #536 recorded them
                const insert = stateDb.connection.query(
                    `INSERT INTO remote_nodes (uid, parentUid, relPath, name, type, size, mtimeMs, sha1) VALUES (?, ?, ?, ?, 'file', 5, 0, NULL)`,
                );
                insert.run('vol~old-up', docs.uid, 'Docs/../../victim.txt', '../../victim.txt');
                insert.run('vol~old-slash', docs.uid, 'Docs/a/b.txt', 'a/b.txt');
                stateDb.connection
                    .query(`INSERT INTO doc_nodes (uid, parentUid, name, kind, mtimeMs) VALUES (?, ?, ?, 'doc', 0)`)
                    .run('vol~old-doc', docs.uid, '../../plan');

                await d.engine.reconcileNow();

                expect(d.engine.remoteIndex.getByUid('vol~old-up')).toBeNull();
                expect(d.engine.remoteIndex.getByUid('vol~old-slash')).toBeNull();
                expect(d.engine.docNodes.listChildren(docs.uid)).toEqual([]);
                if (layout === 'virtual') {
                    expect(d.engine.vfsChildren('Docs').map((e) => e.name)).toEqual(['ok.txt']);
                    await expect(d.engine.hydrate('Docs/a/b.txt')).rejects.toMatchObject({ code: 'ENOENT' });
                }
                expect(outsideRoot(d.rootDir)).toEqual(d.before);
                expect(await stat(path.join(tempDir, 'victim.txt')).then((s) => s.size)).toBe(4);
                await d.engine.stop();
            });
        });
    }
});
