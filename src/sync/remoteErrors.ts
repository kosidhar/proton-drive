import { AbortError, ConnectionError, RateLimitedError, ServerError } from '@protontech/drive-sdk';

// How the errors of Proton Drive requests are told apart. The SDK turns any error response it has no class for into an
// APIHTTPError (no JSON body: it keeps the HTTP status) or an APICodeError (a JSON body with an API code: it keeps the
// code, not the HTTP status). Both are ServerErrors. Neither class is exported by the SDK, so they are told by name
// (tests/remoteErrors.test.ts builds the SDK's own classes, so a rename there fails).

// The network or the server, which a later try may get past (a rate limit is a ServerError too)
export function isTransient(error: unknown): boolean {
    return error instanceof ConnectionError || error instanceof AbortError || error instanceof ServerError;
}

// A refusal of this one request that no later try gets past: an HTTP 4xx other than 401 (an expired session), 408 (a
// timeout) or 429 (a rate limit), or an API code of the 2xxx validation family (the SDK maps the 2xxx codes it knows to
// ValidationErrors; others of the family come as APICodeErrors)
export function permanentRefusal(error: unknown): boolean {
    if (!(error instanceof ServerError) || error instanceof RateLimitedError) {
        return false;
    }
    if (error.name === 'APIHTTPError') {
        const status = (error as { statusCode?: unknown }).statusCode;
        return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
    }
    const code = apiCodeOf(error);
    return code !== null && code >= 2000 && code < 3000;
}

// An API code outside the 2xxx family: it may be a refusal, or what a 5xx outage or an expired session answered with
export function unmappedApiCode(error: unknown): boolean {
    const code = apiCodeOf(error);
    return code !== null && !(code >= 2000 && code < 3000);
}

function apiCodeOf(error: unknown): number | null {
    if (!(error instanceof ServerError) || error instanceof RateLimitedError || error.name !== 'APICodeError') {
        return null;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : null;
}
