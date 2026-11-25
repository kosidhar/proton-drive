import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CREDENTIALS_SERVICE } from '../src/sdk/credentials/constants';
import { SecretsSessionStore } from '../src/sdk/credentials/secretCredentialsStore';
import { sendActionNotification } from '../src/linux/notifications';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const APP_ID = 'io.github.kosidhar.ProtonDrive';

describe('the app ID', () => {
    test('names the keyring entry', () => {
        expect(CREDENTIALS_SERVICE).toBe(`${APP_ID}/drive-sdk-cli`);
    });

    describe('in the keyring', () => {
        afterEach(() => mock.restore());

        test('the store reads, writes and deletes under that service', async () => {
            const seen: string[] = [];
            spyOn(Bun.secrets, 'get').mockImplementation((async (o: { service: string }) => (seen.push(o.service), null)) as never);
            spyOn(Bun.secrets, 'set').mockImplementation((async (o: { service: string }) => void seen.push(o.service)) as never);
            spyOn(Bun.secrets, 'delete').mockImplementation((async (o: { service: string }) => (seen.push(o.service), true)) as never);
            const store = new SecretsSessionStore(logger);
            await store.save({ sessionId: 's' } as never);
            await store.load();
            await store.remove();
            expect(seen).toEqual([CREDENTIALS_SERVICE, CREDENTIALS_SERVICE, CREDENTIALS_SERVICE]);
        });
    });

    test('notifications with buttons carry it as the icon by default', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'appid-'));
        const script = `${dir}/fake-notify`;
        writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n`, { mode: 0o755 });
        await sendActionNotification({ title: 't', body: 'b', actions: [{ key: 'k', label: 'L' }], command: script });
        expect(readFileSync(`${dir}/args`, 'utf8').split('\n')).toContain(`--icon=${APP_ID}`);
        rmSync(dir, { recursive: true });
    });
});
