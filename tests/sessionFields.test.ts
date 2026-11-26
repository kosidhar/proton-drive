import { describe, expect, test } from 'bun:test';

import { describeSessionFields, sessionFields } from '../src/sdk/credentials/sessionLocation';

describe('the session fields the daemon and the CLI report (#537)', () => {
    test('sessionFields: none, keyring, file with its path', () => {
        expect(sessionFields(null)).toEqual({ sessionStorage: null, sessionPath: null });
        expect(sessionFields({ storage: 'keyring' })).toEqual({ sessionStorage: 'keyring', sessionPath: null });
        expect(sessionFields({ storage: 'file', path: '/p' })).toEqual({ sessionStorage: 'file', sessionPath: '/p' });
    });

    test('describeSessionFields says nothing when there is no session, and names the path for a file', () => {
        expect(describeSessionFields(null, null)).toBeNull();
        expect(describeSessionFields(undefined, undefined)).toBeNull();
        expect(describeSessionFields('file', '/p/auth-session.json')).toContain('/p/auth-session.json');
        expect(describeSessionFields('keyring', null)).toMatch(/keyring/);
    });
});
