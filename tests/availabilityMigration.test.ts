import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AvailabilityPolicy } from '../src/sync/availability';
import { migrateExcludedFolders } from '../src/sync/availabilityMigration';
import { RemoteIndex, type RemoteIndexEntry } from '../src/sync/remoteIndex';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { localFiles } from './helpers/localFiles';
import { makeMockDrive } from './helpers/mockDrive';
import { uploadAtOnce } from './helpers/engineOptions';

describe('availability migration', () => {
    let tempDir: string;
    let dbFile: string;
    let stateDb: SyncStateDatabase;
    let index: RemoteIndex;
    let policy: AvailabilityPolicy;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-migration-test-'));
        dbFile = path.join(tempDir, 'state.sqlite');
        stateDb = new SyncStateDatabase(dbFile);
        stateDb.updateSettings({ syncDir: path.join(tempDir, 'ProtonDrive'), notificationsEnabled: false });
        index = new RemoteIndex(stateDb.connection);
        policy = new AvailabilityPolicy(stateDb.connection, index);
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    const entry = (relPath: string, type: 'file' | 'folder'): RemoteIndexEntry => ({
        uid: `uid-${relPath}`,
        parentUid: null,
        relPath,
        name: path.posix.basename(relPath),
        type,
        size: 0,
        mtimeMs: 0,
        sha1: null,
    });
    const record = (localRelPath: string, type: 'file' | 'folder') => ({
        localRelPath,
        nodeUid: `uid-${localRelPath}`,
        parentNodeUid: null,
        type,
        localSha1: null,
        remoteSha1: null,
        localMtimeMs: 0,
        remoteMtimeMs: 0,
        size: 0,
        syncStatus: 'synced' as const,
        lastError: null,
    });
    // The remote tree: Docs/a.txt and notes.txt are synced today, Archive is Cloud only
    const indexTree = () => {
        index.setRoot('root');
        index.replaceChildren('root', '', [entry('Docs', 'folder'), entry('notes.txt', 'file'), entry('Archive', 'folder')]);
        index.replaceChildren('uid-Docs', 'Docs', [entry('Docs/a.txt', 'file')]);
        index.replaceChildren('uid-Archive', 'Archive', [entry('Archive/old.txt', 'file')]);
    };

    test("migration pins today's synced top-level items, leaves Cloud only folders unpinned and is idempotent", async () => {
        indexTree();
        for (const [rel, type] of [['Docs/a.txt', 'file'], ['Docs', 'folder'], ['notes.txt', 'file']] as const) {
            stateDb.upsertItem(record(rel, type));
        }
        stateDb.setMeta('excludedFolders', JSON.stringify(['Archive']));

        expect(await migrateExcludedFolders(stateDb, policy, dbFile)).toBe('migrated');

        expect(policy.isPinned('Docs/a.txt')).toBe(true);
        expect(policy.isPinned('notes.txt')).toBe(true);
        // Explicit flags on the top-level items only; what is inside inherits
        const flagged = stateDb.connection.query('SELECT nodeUid, pin FROM availability ORDER BY nodeUid').all();
        expect(flagged).toEqual([
            { nodeUid: 'uid-Docs', pin: 'pinned' },
            { nodeUid: 'uid-notes.txt', pin: 'pinned' },
        ]);
        expect(policy.isPinned('Archive')).toBe(false);
        expect(policy.stateOf('Archive')).not.toBe('hidden');
        expect(policy.stateOf('Archive')).toBe('online-only');
        expect(existsSync(`${dbFile}.pre-availability.bak`)).toBe(true);
        expect(stateDb.readLegacyExcludedFolders()).toEqual([]);
        expect(stateDb.getMeta('availabilityMigrated')).toBe('1');

        expect(await migrateExcludedFolders(stateDb, policy, dbFile)).toBe('already-done');
    });

    test('a re-run after a crash keeps the backup the first run made, and completes', async () => {
        indexTree();
        stateDb.upsertItem(record('notes.txt', 'file'));
        // SQLite would refuse to VACUUM INTO this file, and the first backup is the one worth keeping
        writeFileSync(`${dbFile}.pre-availability.bak`, 'backup from the first run');

        expect(await migrateExcludedFolders(stateDb, policy, dbFile)).toBe('migrated');
        expect(policy.isPinned('notes.txt')).toBe(true);
        expect(readFileSync(`${dbFile}.pre-availability.bak`, 'utf8')).toBe('backup from the first run');
    });

    test('records a Cloud only folder left behind are dropped when their files are gone, and never pinned', async () => {
        indexTree();
        const files = localFiles(stateDb);
        // A Cloud only removal that stopped part way: one file still here, one gone, and the folder's own record
        await files.writeSynced('Archive/kept.txt', 'still here');
        stateDb.upsertItem(record('Archive/old.txt', 'file'));
        stateDb.upsertItem(record('Archive', 'folder'));
        stateDb.setMeta('excludedFolders', JSON.stringify(['Archive']));

        await migrateExcludedFolders(stateDb, policy, dbFile);

        // Without its file, a record would read as the user deleting it, and the cloud copy would be trashed
        expect(stateDb.getItemByPath('Archive/old.txt')).toBeNull();
        expect(stateDb.getItemByPath('Archive/kept.txt')).not.toBeNull();
        expect(stateDb.getItemByPath('Archive')).not.toBeNull();
        expect(policy.isPinned('Archive')).toBe(false);
    });

    // A fresh install keeps today's default of syncing everything: the root gets pinned once its uid is known
    const engineOnDrive = () => {
        const drive = makeMockDrive();
        drive.add('welcome.txt', 'hello');
        const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => true }, stateDb, drive.logger, uploadAtOnce);
        return { ...drive, engine };
    };

    test('a fresh install pins the root on its first sync, once', async () => {
        const { engine, calls } = engineOnDrive();

        await migrateExcludedFolders(stateDb, engine.availability, dbFile);
        expect(stateDb.getMeta('pinRootOnFirstSync')).toBe('1');
        await engine.start();
        await engine.stop();

        expect(calls.downloads).toEqual(['welcome.txt']);
        expect(engine.availability.stateOf('')).toBe('pinned');
        expect(stateDb.getMeta('pinRootOnFirstSync')).toBeNull();
    });

    test('an install with synced items gets no root pin', async () => {
        const { engine, calls } = engineOnDrive();
        await localFiles(stateDb).writeSynced('notes.txt', 'synced today');

        await migrateExcludedFolders(stateDb, engine.availability, dbFile);
        expect(stateDb.getMeta('pinRootOnFirstSync')).toBeNull();
        await engine.start();
        await engine.stop();

        expect(calls.downloads).toEqual([]);
        expect(engine.availability.isPinned('welcome.txt')).toBe(false);
    });

    test('an install with only Cloud only folders gets no root pin', async () => {
        const { engine } = engineOnDrive();
        stateDb.setMeta('excludedFolders', JSON.stringify(['Archive']));

        await migrateExcludedFolders(stateDb, engine.availability, dbFile);

        expect(stateDb.getMeta('pinRootOnFirstSync')).toBeNull();
    });
});
