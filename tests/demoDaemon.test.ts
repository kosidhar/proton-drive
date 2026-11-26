import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { demoActivity, demoStatus, startDemoDaemon } from '../scripts/demo-daemon';

// The demo daemon feeds the README screenshots (#520): it must answer what the app asks, stay on this computer, never
// take the real daemon's port, and carry no address but example.com.

const unknown: string[] = [];
let server: ReturnType<typeof startDemoDaemon>;
let base: string;

beforeAll(() => {
    server = startDemoDaemon(0, 'idle', (line) => unknown.push(line));
    base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test('it answers the requests the app makes, in the shapes it reads', async () => {
    const status = (await (await fetch(`${base}/api/status`)).json()) as ReturnType<typeof demoStatus>;
    expect(status.loggedIn).toBe(true);
    expect(status.state).toBe('idle');
    expect(status.account.email).toBe('alex@example.com');
    expect(status.account.maxSpace).toBeGreaterThan(status.account.usedSpace);
    expect(Array.isArray(status.activeTransfers)).toBe(true);
    expect(status.stats.totalFiles).toBeGreaterThan(0);

    const activity = (await (await fetch(`${base}/api/activity?limit=200`)).json()) as ReturnType<typeof demoActivity>;
    expect(activity.length).toBeGreaterThan(5);
    for (const a of activity) {
        expect(typeof a.timestamp).toBe('number');
        expect(typeof a.action).toBe('string');
        expect(typeof a.localRelPath).toBe('string');
        expect(typeof a.details).toBe('string');
    }

    expect(await (await fetch(`${base}/api/conflicts`)).json()).toEqual([]);
    expect((await fetch(`${base}/api/sync`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/api/pause`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(unknown).toEqual([]);
});

test('it logs and refuses what it does not know', async () => {
    const res = await fetch(`${base}/api/remote/list?path=/my-files`);
    expect(res.status).toBe(404);
    expect(unknown.some((l) => l.includes('GET /api/remote/list'))).toBe(true);
    unknown.length = 0;
});

test('it listens on 127.0.0.1 only', () => {
    expect(server.hostname).toBe('127.0.0.1');
});

test("it refuses the real daemon's port", () => {
    expect(() => startDemoDaemon(49152)).toThrow(/49152/);
});

test('its data holds no address outside example.com', () => {
    const everything = JSON.stringify([demoStatus(Date.now(), 'syncing'), demoActivity(Date.now())]);
    const source = readFileSync(path.join(import.meta.dir, '..', 'scripts', 'demo-daemon.ts'), 'utf8');
    for (const text of [everything, source]) {
        const emails = text.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
        expect(emails.length).toBeGreaterThan(0);
        for (const email of emails) expect(email.endsWith('@example.com')).toBe(true);
    }
});
