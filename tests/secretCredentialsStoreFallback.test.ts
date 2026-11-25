import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { SecretsSessionStore } from '../src/sdk/credentials/secretCredentialsStore';
import type { Credentials, CredentialsStore } from '../src/sdk/credentials/interface';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const snapshot = { userKeyPassword: 'p', session: { sessionId: 's' } } as unknown as Credentials;

// A fallback store held in memory that counts its calls.
function fakeFallback(initial: Credentials | null, opts: { removeThrows?: boolean } = {}) {
    let held = initial;
    const calls = { save: 0, remove: 0 };
    const store: CredentialsStore = {
        load: async () => held,
        save: async (s) => {
            calls.save++;
            held = s;
        },
        remove: async () => {
            calls.remove++;
            if (opts.removeThrows) throw new Error('EACCES');
            held = null;
        },
    };
    return { store, calls };
}

describe('SecretsSessionStore save and the plaintext fallback', () => {
    afterEach(() => mock.restore());

    test('a successful keyring save removes the stale fallback session', async () => {
        spyOn(Bun.secrets, 'set').mockImplementation((async () => {}) as never);
        const { store: fallback, calls } = fakeFallback(snapshot);
        const store = new SecretsSessionStore(logger, fallback);
        await store.save(snapshot);
        expect(calls.remove).toBe(1);
        expect(await fallback.load()).toBeNull();
    });

    test('a keyring save that throws writes the fallback and does not remove it', async () => {
        spyOn(Bun.secrets, 'set').mockImplementation((async () => {
            throw new Error('no secret service');
        }) as never);
        const { store: fallback, calls } = fakeFallback(null);
        const store = new SecretsSessionStore(logger, fallback);
        await store.save(snapshot);
        expect(calls.save).toBe(1);
        expect(calls.remove).toBe(0);
        expect(await fallback.load()).toEqual(snapshot);
    });

    test('a fallback removal that throws never fails the save', async () => {
        spyOn(Bun.secrets, 'set').mockImplementation((async () => {}) as never);
        const { store: fallback, calls } = fakeFallback(snapshot, { removeThrows: true });
        const store = new SecretsSessionStore(logger, fallback);
        await expect(store.save(snapshot)).resolves.toBeUndefined();
        expect(calls.remove).toBe(1);
    });
});
