import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
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
    const scan = (relPath: string, stopAtFirst = true) =>
        scanLocalCopies({
            syncDir: files.syncDir(),
            relPath,
            ignorePatterns: stateDb.getSettings().ignorePatterns,
            stopAtFirst,
            isUnchangedSyncedCopy: isUnchangedSyncedCopy(),
        });
    const remove = (entries: Awaited<ReturnType<typeof scan>>['entries'], shouldContinue = () => true) =>
        removeScannedEntries({
            syncDir: files.syncDir(),
            entries,
            keep: new Set(),
            mode: 'all-or-nothing',
            dropRecord: (rel) => stateDb.removeItemByPath(rel),
            shouldContinue,
        });
    // Free up space's removal: what the scan found only on this computer stays, and so does anything that changed
    const removeKeepingChanged = (scanned: Awaited<ReturnType<typeof scan>>) =>
        removeScannedEntries({
            syncDir: files.syncDir(),
            entries: scanned.entries,
            keep: new Set(scanned.localOnly.map((item) => item.relPath)),
            mode: 'keep-changed',
            dropRecord: (rel) => stateDb.removeItemByPath(rel),
            shouldContinue: () => true,
        });

    // #41: a stalled download for the drive (an app waiting on it) is never removed under it; another temp file still is
    test('Free up space of the whole drive leaves a download for the drive in progress alone', async () => {
        await files.writeSynced('Docs/a.txt', 'a');
        // Staged at the root, beside the files
        await writeFile(path.join(files.syncDir(), '.proton-drive-tmp-hydrate-3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f'), 'partial');
        await writeFile(path.join(files.syncDir(), 'Docs/.proton-drive-tmp-999-c.txt'), 'stale');
        const scanned = await scan('', false);
        expect(scanned.entries.map((e) => e.relPath)).not.toContain('.proton-drive-tmp-hydrate-3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f');
        await removeKeepingChanged(scanned);
        expect(await readFile(path.join(files.syncDir(), '.proton-drive-tmp-hydrate-3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f'), 'utf8')).toBe('partial');
        expect(await readdir(path.join(files.syncDir(), 'Docs')).catch(() => null)).toBeNull(); // removed, its temp file too
    });

    test('a file named like a staged download inside a folder is not taken for one', async () => {
        await files.writeSynced('Docs/a.txt', 'a');
        await writeFile(path.join(files.syncDir(), 'Docs/.proton-drive-tmp-hydrate-x'), 'not ours');
        const scanned = await scan('Docs', false);
        expect(scanned.entries.map((e) => e.relPath)).toContain('Docs/.proton-drive-tmp-hydrate-x');
    });

    test('removes a folder whose every file is an unchanged synced copy', async () => {
        await files.writeSynced('Archive/2025/tax.pdf', 'tax');
        await files.writeSynced('Archive/touched.txt', 'same content');
        // Touched but not changed: size and mtime no longer match the record, so only the hash can tell
        await utimes(path.join(files.syncDir(), 'Archive/touched.txt'), new Date(), new Date(Date.now() + 60_000));

        const scanned = await scan('Archive');
        expect(scanned.localOnly).toEqual([]);
        expect(await remove(scanned.entries)).toEqual({ complete: true, kept: [] });

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

        expect(result).toEqual({ complete: false, kept: ['Shots/2024'] });
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

        const result = await remove(scanned.entries);
        expect(result.complete).toBe(false);
        expect(result.kept).toHaveLength(1); // the first edited file it reached, which stopped it

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

        expect(await remove(scanned.entries, () => wanted)).toEqual({ complete: false, kept: [] });

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

    test('with stopAtFirst off, the scan reports everything that exists only on this computer', async () => {
        await files.writeSynced('Proj/main.ts', 'synced');
        await files.writeSynced('Proj/app/lib.ts', 'synced');
        await files.writeLocal('Proj/app/.git/HEAD', 'ref: refs/heads/main');
        await files.writeLocal('Proj/app/.git/config', '[core]');
        await files.writeSynced('Proj/todo.txt', 'synced version');
        await writeFile(path.join(files.syncDir(), 'Proj/todo.txt'), 'edited after the last sync');
        await files.writeLocal('Proj/new.txt', 'not uploaded yet');
        await symlink(tempDir, path.join(files.syncDir(), 'Proj/link'));

        const scanned = await scan('Proj', false);

        const byPath = (a: { relPath: string }, b: { relPath: string }) => (a.relPath < b.relPath ? -1 : 1);
        expect([...scanned.localOnly].sort(byPath)).toEqual([
            { relPath: 'Proj/app/.git', reason: 'ignored' },
            { relPath: 'Proj/link', reason: 'not-a-file' },
            { relPath: 'Proj/new.txt', reason: 'not-in-cloud' },
            { relPath: 'Proj/todo.txt', reason: 'not-in-cloud' },
        ]);
        // An ignored folder is reported once, not walked into
        expect(scanned.entries.map((e) => e.relPath)).not.toContain('Proj/app/.git/HEAD');
    });

    test('keep-changed removes unchanged copies and keeps, with their records, what exists only on this computer', async () => {
        await files.writeSynced('Proj/main.ts', 'synced');
        await files.writeSynced('Proj/app/lib.ts', 'synced');
        await files.writeLocal('Proj/app/.git/HEAD', 'ref: refs/heads/main');
        await files.writeSynced('Proj/sub/deep/x.txt', 'synced');
        await files.writeSynced('Proj/todo.txt', 'synced version');
        await writeFile(path.join(files.syncDir(), 'Proj/todo.txt'), 'edited after the last sync');
        await files.writeLocal('Proj/new.txt', 'not uploaded yet');
        const outside = path.join(tempDir, 'elsewhere');
        await mkdir(outside, { recursive: true });
        await writeFile(path.join(outside, 'keep.txt'), 'outside the sync folder');
        await symlink(outside, path.join(files.syncDir(), 'Proj/link'));

        const result = await removeKeepingChanged(await scan('Proj', false));

        expect(result.complete).toBe(false);
        expect([...result.kept].sort()).toEqual([
            'Proj',
            'Proj/app',
            'Proj/app/.git',
            'Proj/link',
            'Proj/new.txt',
            'Proj/todo.txt',
        ]);
        for (const gone of ['Proj/main.ts', 'Proj/app/lib.ts', 'Proj/sub']) {
            expect({ gone, exists: await files.exists(gone) }).toEqual({ gone, exists: false });
        }
        expect(await readFile(path.join(files.syncDir(), 'Proj/app/.git/HEAD'), 'utf8')).toBe('ref: refs/heads/main');
        expect(await readFile(path.join(files.syncDir(), 'Proj/todo.txt'), 'utf8')).toBe('edited after the last sync');
        expect(await readFile(path.join(files.syncDir(), 'Proj/new.txt'), 'utf8')).toBe('not uploaded yet');
        expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside the sync folder');
        // The edit keeps its record, so it uploads as an edit rather than turning into a conflict
        expect(stateDb.getItemByPath('Proj/todo.txt')).not.toBeNull();
        expect(stateDb.getItemByPath('Proj/main.ts')).toBeNull();
        await files.expectNoRecordWithoutFile('Proj');
    });

    test('keep-changed keeps every file edited during the removal and carries on with the rest', async () => {
        const paths = ['Docs/a.txt', 'Docs/b.txt', 'Docs/sub/c.txt', 'Docs/sub/d.txt'];
        for (const f of paths) {
            await files.writeSynced(f, 'synced');
        }
        const scanned = await scan('Docs', false);
        let first = '';
        // Everything but the file being removed right now gets edited
        files.onRemoval(1, (rel) => {
            first = rel;
            for (const f of paths.filter((f) => f !== rel)) {
                writeFileSync(path.join(files.syncDir(), f), 'edited while removing');
            }
        });

        const result = await removeKeepingChanged(scanned);

        expect(result.complete).toBe(false);
        expect(await files.exists(first)).toBe(false);
        for (const f of paths.filter((f) => f !== first)) {
            expect(await readFile(path.join(files.syncDir(), f), 'utf8')).toBe('edited while removing');
            expect(result.kept).toContain(f);
        }
        await files.expectNoRecordWithoutFile('Docs');
    });

    test('keep-changed keeps a folder something new was saved into and removes the rest', async () => {
        await files.writeSynced('Shots/2024/a.png', 'a');
        await files.writeSynced('Shots/2025/c.png', 'c');
        const scanned = await scan('Shots', false);
        files.onRemoval(1, () => writeFileSync(path.join(files.syncDir(), 'Shots/2024/new.png'), 'new'));

        const result = await removeKeepingChanged(scanned);

        expect([...result.kept].sort()).toEqual(['Shots', 'Shots/2024']);
        expect(await readFile(path.join(files.syncDir(), 'Shots/2024/new.png'), 'utf8')).toBe('new');
        expect(await files.exists('Shots/2024/a.png')).toBe(false);
        expect(await files.exists('Shots/2025')).toBe(false);
        await files.expectNoRecordWithoutFile('Shots');
    });

    test('an engine temp file is removed while it is unchanged and kept once it grows', async () => {
        await files.writeSynced('Dl/a.txt', 'a');
        await files.writeLocal('Dl/.proton-drive-tmp-1-2-a.txt', 'abandoned');
        await files.writeSynced('Dl2/b.txt', 'b');
        await files.writeLocal('Dl2/.proton-drive-tmp-1-2-b.txt', 'partial');

        expect(await removeKeepingChanged(await scan('Dl', false))).toEqual({ complete: true, kept: [] });
        expect(await files.exists('Dl')).toBe(false);

        const scanned = await scan('Dl2', false);
        // The download writing it is still going: it grows as the removal starts, whichever entry goes first
        files.onRemoval(1, () => appendFileSync(path.join(files.syncDir(), 'Dl2/.proton-drive-tmp-1-2-b.txt'), ' and more'));
        const result = await removeKeepingChanged(scanned);

        expect([...result.kept].sort()).toEqual(['Dl2', 'Dl2/.proton-drive-tmp-1-2-b.txt']);
        expect(await readFile(path.join(files.syncDir(), 'Dl2/.proton-drive-tmp-1-2-b.txt'), 'utf8')).toBe('partial and more');
        await files.expectNoRecordWithoutFile('Dl2');
    });

    test('a file that changes just as its record is dropped stays', async () => {
        await files.writeSynced('Inbox/a.txt', 'a');
        await files.writeSynced('Inbox/b.txt', 'b');
        const scanned = await scan('Inbox', false);
        // Saved to between the last look and the removal: only a look after the record is gone can see it
        const removeItemByPath = stateDb.removeItemByPath.bind(stateDb);
        stateDb.removeItemByPath = (rel: string) => {
            removeItemByPath(rel);
            if (rel === 'Inbox/b.txt') {
                appendFileSync(path.join(files.syncDir(), rel), ' and an edit');
            }
        };

        const result = await removeKeepingChanged(scanned);

        expect([...result.kept].sort()).toEqual(['Inbox', 'Inbox/b.txt']);
        expect(await readFile(path.join(files.syncDir(), 'Inbox/b.txt'), 'utf8')).toBe('b and an edit');
        expect(await files.exists('Inbox/a.txt')).toBe(false);
        await files.expectNoRecordWithoutFile('Inbox');
    });

    test('the sync folder itself is never removed, and a single file can be scanned and removed', async () => {
        await files.writeSynced('a.txt', 'a');
        await files.writeSynced('Docs/b.txt', 'b');
        await files.writeSynced('Docs/c.txt', 'c');

        const single = await scan('Docs/b.txt', false);
        expect(single).toEqual({ localOnly: [], entries: [expect.objectContaining({ relPath: 'Docs/b.txt' })] });
        expect(await removeKeepingChanged(single)).toEqual({ complete: true, kept: [] });
        expect(await files.exists('Docs/b.txt')).toBe(false);
        expect(await files.exists('Docs/c.txt')).toBe(true);

        const whole = await scan('', false);
        expect(whole.entries.map((e) => e.relPath).sort()).toEqual(['Docs', 'Docs/c.txt', 'a.txt']);
        expect(await removeKeepingChanged(whole)).toEqual({ complete: true, kept: [] });
        expect(await readdir(files.syncDir())).toEqual([]);
        expect(stateDb.getAllItems()).toEqual([]);
    });
});
