import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Credentials } from '../src/sdk/credentials/credentials';
import { PlaintextFileSessionStore } from '../src/sdk/credentials/fileCredentialsStore';
import type { Credentials as Snapshot } from '../src/sdk/credentials/interface';
import { describeSessionLocation } from '../src/sdk/credentials/sessionLocation';
import { SecretsSessionStore } from '../src/sdk/credentials/secretCredentialsStore';
import { getConfig } from '../src/sdk/config';

const snapshot = { userKeyPassword: 'p', session: { uid: 'u', accessToken: 'a', refreshToken: 'r' } } as unknown as Snapshot;

function recordingLogger() {
    const lines: Record<'debug' | 'info' | 'warn' | 'error', string[]> = { debug: [], info: [], warn: [], error: [] };
    const logger = {
        debug: (m: string) => lines.debug.push(m),
        info: (m: string) => lines.info.push(m),
        warn: (m: string) => lines.warn.push(m),
        error: (m: string) => lines.error.push(m),
    } as never;
    return { logger, lines };
}

const dirs: string[] = [];
function tmp() {
    const d = mkdtempSync(path.join(os.tmpdir(), 'pd-loc-'));
    dirs.push(d);
    return d;
}

afterEach(() => {
    mock.restore();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const keyringDown = () =>
    spyOn(Bun.secrets, 'set').mockImplementation((async () => {
        throw new Error('no secret service');
    }) as never);

describe('Where the session lives (#537)', () => {
    test('a file store warns, once, naming the file, on save and on load', async () => {
        const dir = tmp();
        const { logger, lines } = recordingLogger();
        const store = new PlaintextFileSessionStore(dir, logger);
        await store.save(snapshot);
        await store.save(snapshot);
        await store.load();
        expect(lines.warn).toHaveLength(1);
        expect(lines.warn[0]).toContain(path.join(dir, 'auth-session.json'));
        expect(store.location()).toEqual({ storage: 'file', path: path.join(dir, 'auth-session.json') });
    });

    test('a file store with nothing in it does not warn on load', async () => {
        const { logger, lines } = recordingLogger();
        await new PlaintextFileSessionStore(tmp(), logger).load();
        expect(lines.warn).toHaveLength(0);
    });

    test('with the keyring down, the session is reported in the file; with it up, in the keyring', async () => {
        const { logger } = recordingLogger();
        const file = new PlaintextFileSessionStore(tmp(), logger);
        const store = new SecretsSessionStore(logger, file);
        expect(store.location()).toBeNull();
        keyringDown();
        await store.save(snapshot);
        expect(store.location()).toMatchObject({ storage: 'file' });
        mock.restore();
        spyOn(Bun.secrets, 'set').mockImplementation((async () => {}) as never);
        await store.save(snapshot);
        expect(store.location()).toEqual({ storage: 'keyring' });
    });

    test('loading from the file when the keyring throws reports the file', async () => {
        const { logger } = recordingLogger();
        const file = new PlaintextFileSessionStore(tmp(), logger);
        await file.save(snapshot);
        spyOn(Bun.secrets, 'get').mockImplementation((async () => {
            throw new Error('no secret service');
        }) as never);
        const store = new SecretsSessionStore(logger, file);
        expect(await store.load()).toEqual(snapshot);
        expect(store.location()).toMatchObject({ storage: 'file' });
    });

    test('Credentials exposes the store location, keyring when the store does not say', async () => {
        const { logger } = recordingLogger();
        const bare = { load: async () => null, save: async () => {}, remove: async () => {} };
        expect(new Credentials(bare, logger).sessionLocation()).toEqual({ storage: 'keyring' });
        const file = new PlaintextFileSessionStore(tmp(), logger);
        expect(new Credentials(file, logger).sessionLocation()).toMatchObject({ storage: 'file' });
    });

    test('describeSessionLocation words each place', () => {
        expect(describeSessionLocation({ storage: 'keyring' })).toMatch(/keyring/i);
        const text = describeSessionLocation({ storage: 'file', path: '/x/auth-session.json' });
        expect(text).toContain('/x/auth-session.json');
        expect(text).toMatch(/no keyring/i);
        expect(text).toMatch(/GNOME Keyring/);
        expect(text).toMatch(/KWallet/);
    });
});

describe('PROTONDRIVE_NO_FILE_SESSION (#537)', () => {
    test('with the opt-out, a keyring that fails refuses the file and writes nothing', async () => {
        const dir = tmp();
        const { logger } = recordingLogger();
        const file = new PlaintextFileSessionStore(dir, logger);
        const store = new SecretsSessionStore(logger, file, { refuseFile: true });
        keyringDown();
        await expect(store.save(snapshot)).rejects.toThrow(/PROTONDRIVE_NO_FILE_SESSION/);
        expect(await Bun.file(path.join(dir, 'auth-session.json')).exists()).toBe(false);
    });

    test('with the opt-out and a working keyring, saving is unchanged', async () => {
        const { logger } = recordingLogger();
        const store = new SecretsSessionStore(logger, new PlaintextFileSessionStore(tmp(), logger), { refuseFile: true });
        spyOn(Bun.secrets, 'set').mockImplementation((async () => {}) as never);
        await store.save(snapshot);
        expect(store.location()).toEqual({ storage: 'keyring' });
    });

    test('the config reads the variable', () => {
        const before = process.env.PROTONDRIVE_NO_FILE_SESSION;
        try {
            process.env.PROTONDRIVE_NO_FILE_SESSION = '1';
            expect(getConfig({ appVersion: 'x' } as never).noFileSession).toBe(true);
            delete process.env.PROTONDRIVE_NO_FILE_SESSION;
            expect(getConfig({ appVersion: 'x' } as never).noFileSession).toBe(false);
        } finally {
            if (before === undefined) delete process.env.PROTONDRIVE_NO_FILE_SESSION;
            else process.env.PROTONDRIVE_NO_FILE_SESSION = before;
        }
    });
});
