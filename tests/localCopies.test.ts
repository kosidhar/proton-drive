import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProtonDriveClient } from '@protontech/drive-sdk';

import type { Manager as EventsManager } from '../src/sdk/events/manager';
import { removeScannedEntries, scanLocalCopies } from '../src/sync/localCopies';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { localFiles } from './helpers/localFiles';

describe('local copies', () => {
    let tempDir: string;
    let stateDb: SyncStateDatabase;
    let files: ReturnType<typeof localFiles>;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), 'proton-drive-local-copies-test-'));
        stateDb = new SyncStateDatabase(path.join(tempDir, 'state.sqlite'));
        stateDb.updateSettings({ syncDir: path.join(tempDir, 'ProtonDrive'), notificationsEnabled: false });
        files = localFiles(stateDb);
    });

    afterEach(async () => {
        stateDb.close();
        await rm(tempDir, { recursive: true, force: true });
    });

    // The engine's own check, so these tests cover what a real removal would decide
    const isUnchangedSyncedCopy = () => {
        const engine = new ProtonDriveSyncEngine(
            {} as ProtonDriveClient,
            {} as EventsManager,
            { isLoggedIn: () => true },
            stateDb,
            { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        );
        return (engine as any).isUnchangedSyncedCopy.bind(engine);
    };
    const scan = (relPath: string) =>
        scanLocalCopies({
            syncDir: files.syncDir(),
            relPath,
            ignorePatterns: stateDb.getSettings().ignorePatterns,
            isUnchangedSyncedCopy: isUnchangedSyncedCopy(),
        });
    const remove = (entries: Awaited<ReturnType<typeof scan>>['entries'], shouldContinue = () => true) =>
        removeScannedEntries({
            syncDir: files.syncDir(),
            entries,
            dropRecord: (rel) => stateDb.removeItemByPath(rel),
            shouldContinue,
        });

    test('removes a folder whose every file is an unchanged synced copy', async () => {
        await files.writeSynced('Archive/2025/tax.pdf', 'tax');
        await files.writeSynced('Archive/touched.txt', 'same content');
        // Touched but not changed: size and mtime no longer match the record, so only the hash can tell
        await utimes(path.join(files.syncDir(), 'Archive/touched.txt'), new Date(), new Date(Date.now() + 60_000));

        const scanned = await scan('Archive');
        expect(scanned.localOnly).toEqual([]);
        expect(await remove(scanned.entries)).toEqual({ complete: true });

        expect(await files.exists('Archive')).toBe(false);
        expect(files.recordCount('Archive')).toBe(0);
        expect((await readdir(files.syncDir())).filter((n) => n.startsWith('.proton-drive-tmp-'))).toEqual([]);
    });

    test('stops at the first item that exists only on this computer, and says why', async () => {
        await files.writeSynced('Code/app/main.ts', 'synced');
        await files.writeLocal('Code/app/.git/HEAD', 'ref: refs/heads/main'); // ignored, so never uploaded
        await files.writeSynced('Drafts/old.txt', 'synced');
        await files.writeLocal('Drafts/new.txt', 'not uploaded yet');
        await files.writeSynced('Notes/todo.txt', 'synced version');
        await writeFile(path.join(files.syncDir(), 'Notes/todo.txt'), 'edited after the last sync');
        await files.writeSynced('Photos/cat.jpg', 'meow');

        expect((await scan('Code')).localOnly).toEqual([{ relPath: 'Code/app/.git', reason: 'ignored' }]);
        expect((await scan('Drafts')).localOnly).toEqual([{ relPath: 'Drafts/new.txt', reason: 'not-in-cloud' }]);
        expect((await scan('Notes')).localOnly).toEqual([{ relPath: 'Notes/todo.txt', reason: 'not-in-cloud' }]);
        expect((await scan('Photos')).localOnly).toEqual([]);
        // Scanning deletes nothing and keeps every record
        expect(await readFile(path.join(files.syncDir(), 'Notes/todo.txt'), 'utf8')).toBe('edited after the last sync');
        expect([files.recordCount('Code'), files.recordCount('Drafts'), files.recordCount('Notes')]).toEqual([1, 1, 1]);
    });

    test('stops when something new is saved into the folder while it is being removed', async () => {
        await files.writeSynced('Shots/2024/a.png', 'a');
        await files.writeSynced('Shots/2024/b.png', 'b');
        await files.writeSynced('Shots/2025/c.png', 'c');
        const scanned = await scan('Shots');
        // Another app saves into a folder the removal hasn't reached yet
        const written = files.onRemoval(1, () => writeFileSync(path.join(files.syncDir(), 'Shots/2024/new.png'), 'new'));

        const result = await remove(scanned.entries);
        await written();

        expect(result).toEqual({ complete: false });
        expect(await readFile(path.join(files.syncDir(), 'Shots/2024/new.png'), 'utf8')).toBe('new');
        await files.expectNoRecordWithoutFile('Shots');
    });

    test('stops when a file it has not reached yet is edited while the folder is being removed', async () => {
        const paths = ['Docs/a.txt', 'Docs/b.txt', 'Docs/sub/c.txt'];
        for (const f of paths) {
            await files.writeSynced(f, 'synced');
        }
        const scanned = await scan('Docs');
        // Everything but the file being removed right now gets edited
        files.onRemoval(1, (rel) => {
            for (const f of paths.filter((f) => f !== rel)) {
                writeFileSync(path.join(files.syncDir(), f), 'edited while removing');
            }
        });

        expect(await remove(scanned.entries)).toEqual({ complete: false });

        const left = [];
        for (const f of paths) {
            if (await files.exists(f)) {
                left.push(await readFile(path.join(files.syncDir(), f), 'utf8'));
            }
        }
        expect(left).toEqual(['edited while removing', 'edited while removing']);
        await files.expectNoRecordWithoutFile('Docs');
    });

    test('stops when the removal is called off part way through', async () => {
        await files.writeSynced('Books/a.epub', 'a');
        await files.writeSynced('Books/b.epub', 'b');
        await files.writeSynced('Books/c.epub', 'c');
        const scanned = await scan('Books');
        let wanted = true;
        files.onRemoval(2, () => {
            wanted = false;
        });

        expect(await remove(scanned.entries, () => wanted)).toEqual({ complete: false });

        await files.expectNoRecordWithoutFile('Books');
        // The removal that was under way finishes; the next one never starts
        expect(files.recordCount('Books')).toBe(1);
    });

    test('a symlink inside the folder blocks it, and what it points to is never touched', async () => {
        const outside = path.join(tempDir, 'elsewhere');
        await mkdir(outside, { recursive: true });
        await writeFile(path.join(outside, 'keep.txt'), 'outside the sync folder');
        await files.writeSynced('Mixed/a.txt', 'a');
        await symlink(outside, path.join(files.syncDir(), 'Mixed/link'));

        expect((await scan('Mixed')).localOnly).toEqual([{ relPath: 'Mixed/link', reason: 'not-a-file' }]);
        expect(await files.exists('Mixed/a.txt')).toBe(true);
        expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside the sync folder');
    });
});
