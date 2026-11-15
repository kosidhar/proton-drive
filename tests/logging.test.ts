import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LogLevel } from '@protontech/drive-sdk/telemetry';

import { activityLogLine, wireSyncLogging } from '../src/daemon/daemonServer';
import { getConfig } from '../src/sdk/config';
import { maskedLogRecord, maskEmails } from '../src/sdk/telemetry/logMasking';
import * as sentry from '../src/sdk/telemetry/sentry';
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

// #216: the SDKs log addresses (the drive SDK's sharing logger at INFO: "Inviting user …"; the account SDK at ERROR when an
// address's keys can't be loaded, with an error whose URL carries the address), and none may reach the log or Sentry
describe('addresses in the log', () => {
    test('maskEmails hides anything shaped like an address, and leaves the rest as it was', () => {
        expect(maskEmails('Inviting user sam@example.com with role viewer to node v~n')).toBe('Inviting user <email> with role viewer to node v~n');
        expect(maskEmails('Error loading public keys for email Alex.Doe+drive@mail.proton.me')).toBe('Error loading public keys for email <email>');
        expect(maskEmails('to <josé@exemple.fr>, "a@b.co" and (x_y@sub.example.co.uk).')).toBe('to <<email>>, "<email>" and (<email>).');
        const url = maskEmails('Request failed with status code 422: GET https://mail-api.proton.me/core/v4/keys/all?Email=sam%40example.com&InternalOnly=1');
        expect(url).not.toContain('sam');
        expect(url).not.toContain('example.com');
        expect(url).toContain('<email>');
        expect(maskEmails('Docs/me@home.pdf uploaded')).toBe('Docs/<email> uploaded');
        for (const kept of [
            'Version: CLI=external-drive-ubuntu_sync@0.1.0-alpha, SDK=js@0.0.1',
            'no address: user@localhost, @home, user@, node_modules/@protontech/drive-sdk/x.ts',
            'GET https://drive-api.proton.me/drive/shares/abc: 200 (12ms)',
        ]) {
            expect(maskEmails(kept)).toBe(kept);
        }
    });

    test('a long line costs little to mask', () => {
        const blob = 'x'.repeat(200_000);
        const started = performance.now();
        expect(maskEmails(`token ${blob} end`)).toBe(`token ${blob} end`);
        expect(maskEmails(`token ${blob}@host end, then sam@example.com`)).toBe(`token ${blob}@host end, then <email>`);
        const encoded = 'a%40'.repeat(50_000);
        expect(maskEmails(encoded)).toBe(encoded);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test('a record keeps its level and logger, its message and error are masked, and the error itself is left alone', () => {
        const error = new Error('Request failed: GET https://mail-api.proton.me/core/v4/keys/all?Email=sam%40example.com');
        const record = { time: new Date(0), level: LogLevel.ERROR, loggerName: 'cli', message: 'Error loading public keys for email sam@example.com', error };
        const masked = maskedLogRecord(record);
        expect(masked).toMatchObject({ time: new Date(0), level: LogLevel.ERROR, loggerName: 'cli', message: 'Error loading public keys for email <email>' });
        expect(masked.error).toBeInstanceOf(Error);
        expect((masked.error as Error).message).not.toContain('sam');
        expect((masked.error as Error).stack ?? '').not.toContain('sam');
        expect(error.message).toContain('sam%40example.com');
        expect(record.message).toContain('sam@example.com');
        expect(maskedLogRecord({ ...record, error: 'for sam@example.com' }).error).toBe('for <email>');
        expect(String(maskedLogRecord({ ...record, error: [new Error('a@b.co'), new Error('c@d.co')] }).error)).toBe('Error: <email>,Error: <email>');
        expect(maskedLogRecord({ ...record, error: undefined }).error).toBeUndefined();
    });

    test("an address in any logger's line reaches the log file masked", async () => {
        const dir = tempDir();
        const t = initTelemetry({ logDir: dir, logLevel: LogLevel.INFO, sdkLogLevel: LogLevel.INFO, enableConsoleLog: false, enableMetrics: false } as never);
        t.telemetry.getLogger('sharing').info('Inviting user sam@example.com with role viewer to node v~n');
        t.telemetry.getLogger('cli').error('Error loading public keys for email alex@proton.me', new Error('GET https://x/keys/all?Email=alex%40proton.me'));
        await t.flush();
        const text = readFileSync(path.join(dir, 'proton-drive.log'), 'utf8');
        expect(text).toContain('INFO [sharing] Inviting user <email> with role viewer to node v~n');
        expect(text).toContain('ERROR [cli] Error loading public keys for email <email>');
        expect(text).not.toContain('sam@');
        expect(text).not.toContain('alex');
    });

    test("and reaches Sentry's breadcrumbs masked", () => {
        const crumbs = spyOn(sentry, 'addBreadcrumb').mockImplementation(() => {});
        try {
            const t = initTelemetry({ logDir: tempDir(), logLevel: LogLevel.INFO, sdkLogLevel: LogLevel.INFO, enableConsoleLog: false, enableMetrics: false } as never);
            t.telemetry.getLogger('sharing').info('Inviting user sam@example.com with role viewer to node v~n');
            t.telemetry.getLogger('cli').error('Error loading public keys for email alex@proton.me', new Error('for alex@proton.me'));
            const sent = crumbs.mock.calls.map(([c]) => c);
            expect(sent.map((c) => c.message)).toEqual(['Inviting user <email> with role viewer to node v~n', 'Error loading public keys for email <email>']);
            expect(sent[1].data?.error.message).toBe('for <email>');
            expect(sent[1].data?.error.stack ?? '').not.toContain('alex');
        } finally {
            crumbs.mockRestore();
        }
    });
});
