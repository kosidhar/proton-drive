import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { isTrustedLocalRequest } from '../src/daemon/requestGuard';

const PORT = 49152;

function request(headers: Record<string, string>): Request {
    return new Request(`http://127.0.0.1:${PORT}/api/status`, { headers });
}

describe('isTrustedLocalRequest', () => {
    test('accepts the loopback hosts local clients use', () => {
        for (const host of ['127.0.0.1:49152', 'localhost:49152', 'LOCALHOST:49152', '[::1]:49152']) {
            expect(isTrustedLocalRequest(request({ host }), PORT)).toBe(true);
        }
    });

    test('rejects other hosts (DNS rebinding) and a missing or mismatched port', () => {
        for (const host of ['attacker.example:49152', '127.0.0.1', '127.0.0.1:8080', 'localhost', '127.0.0.1.attacker.example:49152']) {
            expect(isTrustedLocalRequest(request({ host }), PORT)).toBe(false);
        }
        expect(isTrustedLocalRequest(request({}), PORT)).toBe(false);
    });

    test('rejects requests carrying browser-only headers', () => {
        const host = '127.0.0.1:49152';
        expect(isTrustedLocalRequest(request({ host, origin: 'https://attacker.example' }), PORT)).toBe(false);
        expect(isTrustedLocalRequest(request({ host, origin: 'null' }), PORT)).toBe(false);
        expect(isTrustedLocalRequest(request({ host, 'sec-fetch-site': 'cross-site' }), PORT)).toBe(false);
        expect(isTrustedLocalRequest(request({ host, 'sec-fetch-site': 'none' }), PORT)).toBe(false);
    });
});

describe('isTrustedLocalRequest behind a real server', () => {
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
        server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch(req, srv) {
                return new Response(null, { status: isTrustedLocalRequest(req, srv.port ?? 0) ? 204 : 403 });
            },
        });
    });

    afterAll(() => {
        server.stop(true);
    });

    test('a plain local client such as the CLI is let through', async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/sync`, { method: 'POST' });
        expect(res.status).toBe(204);
    });

    test('a forged Host is refused', async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
            headers: { host: `attacker.example:${server.port}` },
        });
        expect(res.status).toBe(403);
    });
});
