import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { backingDirFor, readDriveLayout, virtualDriveWanted } from '../src/sync/driveMode';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

describe('driveMode', () => {
    let dir: string;
    let stateDb: SyncStateDatabase;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'proton-drive-mode-test-'));
        stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
    });
    afterEach(async () => {
        stateDb.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('the backing dir is <appDir>/files', () => {
        expect(backingDirFor('/x')).toBe('/x/files');
    });

    test('the layout defaults to plain and follows the meta', () => {
        expect(readDriveLayout(stateDb)).toBe('plain');
        stateDb.setMeta('driveLayout', 'virtual');
        expect(readDriveLayout(stateDb)).toBe('virtual');
    });

    test('the virtual drive is wanted unless switched off', () => {
        expect(virtualDriveWanted(stateDb)).toBe(true);
        stateDb.setMeta('virtualDriveWanted', '0');
        expect(virtualDriveWanted(stateDb)).toBe(false);
        stateDb.setMeta('virtualDriveWanted', '1');
        expect(virtualDriveWanted(stateDb)).toBe(true);
    });
});
