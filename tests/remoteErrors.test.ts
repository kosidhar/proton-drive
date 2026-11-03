import { describe, expect, test } from 'bun:test';

import { AbortError, ConnectionError, RateLimitedError, ServerError, ValidationError } from '@protontech/drive-sdk';
import { APICodeError, APIHTTPError } from '@protontech/drive-sdk/internal/apiService/errors';

import { isTransient, permanentRefusal, unmappedApiCode } from '../src/sync/remoteErrors';

// Built from the SDK's own error classes: the rules tell some of them by name, so a rename in the SDK fails here (#39)
describe('how Proton Drive errors are told apart', () => {
    test('an HTTP 4xx refusal is permanent, but not a 401 (an expired session), a 408 or a 429', () => {
        expect(permanentRefusal(new APIHTTPError('Unprocessable Entity', 422))).toBe(true);
        expect(permanentRefusal(new APIHTTPError('Forbidden', 403))).toBe(true);
        for (const status of [401, 408, 429, 500, 502, 503]) {
            expect(permanentRefusal(new APIHTTPError('status', status))).toBe(false);
        }
    });

    test('an API code of the 2xxx validation family is permanent; any other is unmapped, as an outage may answer', () => {
        expect(permanentRefusal(new APICodeError('Not allowed', 2061))).toBe(true);
        expect(unmappedApiCode(new APICodeError('Not allowed', 2061))).toBe(false);
        for (const code of [503, 500, 1999, 3000, 9001, 98765]) {
            expect(permanentRefusal(new APICodeError('Something', code))).toBe(false);
            expect(unmappedApiCode(new APICodeError('Something', code))).toBe(true);
        }
    });

    test('network and server trouble is transient and never a refusal', () => {
        for (const error of [
            new ConnectionError('offline'),
            new AbortError('aborted'),
            new ServerError('server'),
            new RateLimitedError('slow down'),
            new APIHTTPError('Bad Gateway', 502),
        ]) {
            expect(isTransient(error)).toBe(true);
            expect(permanentRefusal(error)).toBe(false);
            expect(unmappedApiCode(error)).toBe(false);
        }
    });

    test('a ValidationError or a plain Error is neither transient nor one of these refusals', () => {
        for (const error of [new ValidationError('bad'), new Error('boom')]) {
            expect(isTransient(error)).toBe(false);
            expect(permanentRefusal(error)).toBe(false);
            expect(unmappedApiCode(error)).toBe(false);
        }
    });
});
