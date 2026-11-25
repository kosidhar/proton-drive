import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { matchesIgnorePatterns } from '../src/sync/localWatcher';
import { problemWithIgnorePatterns } from '../src/sync/settingsRules';
import { BUILTIN_IGNORE_PATTERNS, DEFAULT_IGNORE_PATTERNS, SyncStateDatabase } from '../src/sync/syncStateDb';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

function freshDb(): SyncStateDatabase {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-builtin-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
    cleanups.push(() => db.close());
    return db;
}

// What an install made before the built-ins stopped being settings has stored
const OLD_DEFAULTS = ['.git', '.git/**', 'node_modules', 'node_modules/**', '.proton-drive-tmp-*', '*.part', '*.crdownload', '*~', '.DS_Store', '.Trash-*'];
const EDITABLE_DEFAULTS = ['.git', '.git/**', 'node_modules', 'node_modules/**', '*~'];

describe('the built-in ignore patterns (#425)', () => {
    test('the built-in patterns apply even when the user list is empty', () => {
        for (const p of ['a/.proton-drive-tmp-x', 'a/b.part', 'c.crdownload', 'd/.DS_Store', '.Trash-1000']) {
            expect([p, matchesIgnorePatterns(p, [])]).toEqual([p, true]);
        }
        // As ever, a file inside an ignored folder is hidden by the folder (the engine checks each folder above), not by this match
        expect(matchesIgnorePatterns('.Trash-1000/x', [])).toBe(false);
        expect(matchesIgnorePatterns('notes.txt', [])).toBe(false);
    });

    test('the built-ins are exactly the app\'s own temporary and junk files', () => {
        expect([...BUILTIN_IGNORE_PATTERNS]).toEqual(['.proton-drive-tmp-*', '*.part', '*.crdownload', '.DS_Store', '.Trash-*']);
    });

    test('a new install starts with the editable defaults only', () => {
        expect(freshDb().getSettings().ignorePatterns).toEqual(EDITABLE_DEFAULTS);
        expect(DEFAULT_IGNORE_PATTERNS).toEqual(EDITABLE_DEFAULTS);
    });

    test('a stored list with the old defaults reads without the built-ins, and ignores the same files', () => {
        const db = freshDb();
        db.setMeta('ignorePatterns', JSON.stringify(OLD_DEFAULTS));
        const now = db.getSettings().ignorePatterns;
        expect(now).toEqual(EDITABLE_DEFAULTS);
        const samples = [
            'a/.proton-drive-tmp-x', '.proton-drive-tmp-y', 'a/b.part', 'c.crdownload', 'd/.DS_Store', '.Trash-1000/x', '.Trash-1000',
            '.git/config', '.git', 'x/node_modules/y', 'node_modules', 'a~', 'a/b~', 'keep.txt', 'dir/keep.txt', 'part', 'a.parts', 'Trash/x',
        ];
        for (const p of samples) {
            expect([p, matchesIgnorePatterns(p, now)]).toEqual([p, matchesIgnorePatterns(p, OLD_DEFAULTS)]);
        }
    });

    test('a user list that held a built-in alongside their own patterns keeps only their own', () => {
        const db = freshDb();
        db.setMeta('ignorePatterns', JSON.stringify(['*.log', '*.part', 'build/']));
        expect(db.getSettings().ignorePatterns).toEqual(['*.log', 'build/']);
    });

    test("the user's own patterns are kept as typed, in order", () => {
        const db = freshDb();
        db.updateSettings({ ignorePatterns: ['*.log', 'build/'] });
        expect(db.getSettings().ignorePatterns).toEqual(['*.log', 'build/']);
    });

    test('validation judges the user list alone: a built-in never counts toward hiding the drive', () => {
        // The built-ins are not in the list being checked, so they can't tip it over
        expect(problemWithIgnorePatterns(['*.log', 'build/'])).toBeNull();
        expect(problemWithIgnorePatterns(['*'])).not.toBeNull();
    });
});

describe('a trailing slash in an ignore pattern (#425)', () => {
    test('build/ matches a folder named build and everything under it, as build does', () => {
        for (const p of ['a/build/x.o', 'build', 'build/x']) expect([p, matchesIgnorePatterns(p, ['build/'])]).toEqual([p, true]);
        expect(matchesIgnorePatterns('builder/x', ['build/'])).toBe(false);
        expect(matchesIgnorePatterns('a/b', ['build/'])).toBe(false);
    });

    test('a list that hides everything is still refused with a slash', () => {
        expect(problemWithIgnorePatterns(['*/'])).not.toBeNull();
        expect(problemWithIgnorePatterns(['build/', '*.log'])).toBeNull();
    });
});
