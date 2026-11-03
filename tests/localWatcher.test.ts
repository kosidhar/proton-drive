import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalFolderWatcher } from '../src/sync/localWatcher';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await Bun.sleep(25);
    }
    return predicate();
}

describe('LocalFolderWatcher', () => {
    let base: string;
    let root: string;
    let changes: string[];
    let hidden: string[];
    let watcher: LocalFolderWatcher;

    const start = async (debounceMs = 50) => {
        watcher = new LocalFolderWatcher(
            () => root,
            (rel) => hidden.some((h) => rel === h || rel.startsWith(`${h}/`)),
            (event) => {
                changes.push(event.relPath);
            },
            debounceMs,
        );
        await watcher.start();
    };
    const watchedDirs = () => Array.from((watcher as unknown as { watchers: Map<string, unknown> }).watchers.keys());
    const isWatched = (rel: string) => watchedDirs().includes(path.join(root, rel));

    beforeEach(async () => {
        base = await mkdtemp(path.join(tmpdir(), 'proton-drive-watcher-test-'));
        root = path.join(base, 'root');
        await mkdir(root);
        changes = [];
        hidden = [];
    });

    afterEach(async () => {
        watcher.stop();
        await rm(base, { recursive: true, force: true });
    });

    // #12: a deleted folder's own watcher reports it under its own name, which joined onto its path made P/P
    test('deleting a watched folder reports the folder only, not a phantom path inside it', async () => {
        await mkdir(path.join(root, 'P'));
        await writeFile(path.join(root, 'P', 'a.txt'), 'a');
        await start();

        await rm(path.join(root, 'P'), { recursive: true });
        expect(await waitFor(() => changes.includes('P'))).toBe(true);
        await Bun.sleep(200); // past the debounce, for anything else to come
        expect(changes).not.toContain('P/P');
    });

    // The sync folder's own report of itself going is what tells the engine at once that its files are missing (#45)
    test('the sync folder itself moved away is still reported at once', async () => {
        await start();
        await rename(root, path.join(base, 'moved-away'));
        expect(await waitFor(() => changes.length > 0)).toBe(true);
    });

    test('a real child named like its folder is still reported', async () => {
        await mkdir(path.join(root, 'P'));
        await start();

        await writeFile(path.join(root, 'P', 'P'), 'same name as its folder');
        expect(await waitFor(() => changes.includes('P/P'))).toBe(true);
    });

    test('keeps watching a folder that is deleted and created again', async () => {
        await mkdir(path.join(root, 'Projects'));
        await start();

        await rm(path.join(root, 'Projects'), { recursive: true });
        expect(await waitFor(() => changes.includes('Projects'))).toBe(true);
        await mkdir(path.join(root, 'Projects'));
        expect(await waitFor(() => changes.filter((c) => c === 'Projects').length === 2 && isWatched('Projects'))).toBe(
            true,
        );
        await writeFile(path.join(root, 'Projects/new.txt'), 'x');

        expect(await waitFor(() => changes.includes('Projects/new.txt'))).toBe(true);
    });

    test('keeps watching when the folder is replaced faster than the debounce', async () => {
        await mkdir(path.join(root, 'Projects'));
        await start(300);

        await rm(path.join(root, 'Projects'), { recursive: true });
        await mkdir(path.join(root, 'Projects'));
        expect(await waitFor(() => changes.includes('Projects'))).toBe(true);
        await writeFile(path.join(root, 'Projects/new.txt'), 'x');

        expect(await waitFor(() => changes.includes('Projects/new.txt'))).toBe(true);
    });

    test('re-watches nested folders and forgets the deleted ones', async () => {
        await mkdir(path.join(root, 'A/B'), { recursive: true });
        await start();
        expect(isWatched('A/B')).toBe(true);

        await rm(path.join(root, 'A'), { recursive: true });
        expect(await waitFor(() => !isWatched('A') && !isWatched('A/B'))).toBe(true);
        await mkdir(path.join(root, 'A/B'), { recursive: true });
        expect(await waitFor(() => isWatched('A/B'))).toBe(true);
        await writeFile(path.join(root, 'A/B/f.txt'), 'x');

        expect(await waitFor(() => changes.includes('A/B/f.txt'))).toBe(true);
    });

    test('watches folders the sync engine replaces, though it suppresses their events', async () => {
        await mkdir(path.join(root, 'P'));
        await start();

        watcher.suppressPath('P', 600);
        await rm(path.join(root, 'P'), { recursive: true });
        await Bun.sleep(150);
        await mkdir(path.join(root, 'P'));
        expect(await waitFor(() => isWatched('P'))).toBe(true);
        await Bun.sleep(600); // past the suppression
        await writeFile(path.join(root, 'P/user.txt'), 'x');

        expect(await waitFor(() => changes.includes('P/user.txt'))).toBe(true);
        expect(changes).not.toContain('P');
    });

    test('watches a folder again after it was hidden, deleted and synced back', async () => {
        await mkdir(path.join(root, 'P'));
        await start();

        hidden = ['P'];
        await rm(path.join(root, 'P'), { recursive: true });
        await Bun.sleep(150);
        hidden = [];
        watcher.suppressPath('P');
        watcher.suppressPath('P/sub');
        await mkdir(path.join(root, 'P/sub'), { recursive: true });
        expect(await waitFor(() => isWatched('P/sub'))).toBe(true);
        await writeFile(path.join(root, 'P/sub/user.txt'), 'x');

        expect(await waitFor(() => changes.includes('P/sub/user.txt'))).toBe(true);
    });

    test('follows a rename and stops reporting under the old name', async () => {
        await mkdir(path.join(root, 'A'));
        await start();

        await rename(path.join(root, 'A'), path.join(root, 'B'));
        expect(await waitFor(() => isWatched('B') && !isWatched('A'))).toBe(true);
        await writeFile(path.join(root, 'B/f.txt'), 'x');

        expect(await waitFor(() => changes.includes('B/f.txt'))).toBe(true);
        expect(changes).not.toContain('A/f.txt');
    });

    test('stops watching a folder moved out of the root, nested folders included', async () => {
        await mkdir(path.join(root, 'M/deep/deeper'), { recursive: true });
        await start();

        // A move reports only the moved folder itself, nothing for the folders inside it
        await rename(path.join(root, 'M/deep'), path.join(base, 'deep'));
        expect(await waitFor(() => !isWatched('M/deep'))).toBe(true);
        expect(isWatched('M/deep/deeper')).toBe(false);
        await writeFile(path.join(base, 'deep/deeper/outside.txt'), 'x');
        await Bun.sleep(300);

        expect(changes).not.toContain('M/deep/deeper/outside.txt');
    });

    test('deleting a folder leaves a sibling whose name starts the same alone', async () => {
        await mkdir(path.join(root, 'A'));
        await mkdir(path.join(root, 'AB'));
        await start();

        await rm(path.join(root, 'A'), { recursive: true });
        expect(await waitFor(() => !isWatched('A'))).toBe(true);
        expect(isWatched('AB')).toBe(true);
        await writeFile(path.join(root, 'AB/f.txt'), 'x');

        expect(await waitFor(() => changes.includes('AB/f.txt'))).toBe(true);
    });
});
