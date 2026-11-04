import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LogLevel } from '@protontech/drive-sdk/telemetry';

import { activityLogLine, wireSyncLogging } from '../src/daemon/daemonServer';
import { getConfig } from '../src/sdk/config';
import { initTelemetry } from '../src/sdk/telemetry/telemetry';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

// #180: the daemon's log file holds what the sync engine decides, and isn't flooded by the SDK's lines
const dirs: string[] = [];
const envBefore = process.env.PROTON_DRIVE_LOG_LEVEL;
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.PROTON_DRIVE_LOG_LEVEL;
    else process.env.PROTON_DRIVE_LOG_LEVEL = envBefore;
});
const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-log-'));
    dirs.push(dir);
    return dir;
};

describe('the daemon log file', () => {
    test("the app logs at INFO and the SDK at WARNING by default; PROTON_DRIVE_LOG_LEVEL sets both, and -v asks for DEBUG", () => {
        delete process.env.PROTON_DRIVE_LOG_LEVEL;
        expect(getConfig({ appVersion: 'x' } as never)).toMatchObject({ logLevel: LogLevel.INFO, sdkLogLevel: LogLevel.WARNING });
        expect(getConfig({ appVersion: 'x', enableConsoleLog: true } as never)).toMatchObject({
            logLevel: LogLevel.DEBUG,
            sdkLogLevel: LogLevel.DEBUG,
        });
        process.env.PROTON_DRIVE_LOG_LEVEL = 'debug';
        expect(getConfig({ appVersion: 'x' } as never)).toMatchObject({ logLevel: LogLevel.DEBUG, sdkLogLevel: LogLevel.DEBUG });
        process.env.PROTON_DRIVE_LOG_LEVEL = 'error';
        expect(getConfig({ appVersion: 'x', enableConsoleLog: true } as never)).toMatchObject({ logLevel: LogLevel.ERROR });
    });

    test("the engine's decisions reach it under [sync]; the SDK's INFO lines (a line per block) don't, its warnings do", async () => {
        const dir = tempDir();
        const t = initTelemetry({ logDir: dir, logLevel: LogLevel.INFO, sdkLogLevel: LogLevel.WARNING, enableConsoleLog: false, enableMetrics: false } as never);
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        wireSyncLogging({ getLogger: (name) => t.telemetry.getLogger(name) as never }, stateDb);
        stateDb.logActivity({ action: 'delete-local', localRelPath: 'Docs/a.txt', details: 'Deleted on this computer' });
        t.telemetry.getLogger('download').info('block 3: Downloaded');
        t.telemetry.getLogger('api').debug('GET /drive/shares');
        t.telemetry.getLogger('upload').warn('Upload failed: quota');
        await t.flush();
        stateDb.close();
        const text = readFileSync(path.join(dir, 'proton-drive.log'), 'utf8');
        expect(text).toContain('INFO [sync] delete-local Docs/a.txt: Deleted on this computer');
        expect(text).toContain('WARNING [upload] Upload failed: quota');
        expect(text).not.toContain('block 3');
        expect(text).not.toContain('GET /drive/shares');
    });

    test('a log handler failing never fails the activity entry, nor what logged it', async () => {
        const dir = tempDir();
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        const logger = wireSyncLogging({ getLogger: () => ({ info: () => { throw new Error('disk full'); } }) as never }, stateDb);
        expect(logger).toBeDefined();
        expect(() => stateDb.logActivity({ action: 'sync', localRelPath: 'a', details: 'x' })).not.toThrow();
        expect(stateDb.listActivity().map((a) => a.details)).toEqual(['x']);
        stateDb.close();
    });

    test('activityLogLine', () => {
        expect(activityLogLine({ action: 'download', localRelPath: 'a b/c', details: 'Downloaded' })).toBe('download a b/c: Downloaded');
    });
});
