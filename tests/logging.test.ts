import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LogLevel } from '@protontech/drive-sdk/telemetry';

import { activityLogLine } from '../src/daemon/daemonServer';
import { getConfig } from '../src/sdk/config';
import { initTelemetry } from '../src/sdk/telemetry/telemetry';

// #180: the daemon's log file holds what the sync engine decides, and isn't flooded by the SDK's debug lines
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.PROTON_DRIVE_LOG_LEVEL;
});

describe('the daemon log file', () => {
    test('is written at INFO and above by default; PROTON_DRIVE_LOG_LEVEL still asks for more', () => {
        delete process.env.PROTON_DRIVE_LOG_LEVEL;
        expect(getConfig({ appVersion: 'x' } as never).logLevel).toBe(LogLevel.INFO);
        process.env.PROTON_DRIVE_LOG_LEVEL = 'debug';
        expect(getConfig({ appVersion: 'x' } as never).logLevel).toBe(LogLevel.DEBUG);
    });

    test("the engine's lines reach it under [sync], and debug lines don't by default", async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-log-'));
        dirs.push(dir);
        const t = initTelemetry({ logDir: dir, logLevel: LogLevel.INFO, enableConsoleLog: false, enableMetrics: false } as never);
        const sync = t.telemetry.getLogger('sync');
        sync.info(activityLogLine({ action: 'delete-local', localRelPath: 'Docs/a.txt', details: 'Deleted on this computer' }));
        t.telemetry.getLogger('api').debug('GET /drive/shares');
        await t.flush();
        const text = readFileSync(path.join(dir, 'proton-drive.log'), 'utf8');
        expect(text).toContain('INFO [sync] delete-local Docs/a.txt: Deleted on this computer');
        expect(text).not.toContain('GET /drive/shares');
    });
});
