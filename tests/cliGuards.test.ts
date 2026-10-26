import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { runAvailabilityCommand } from '../src/cli/availabilityCommands';
import { controlSocketAccepts, controlSocketDirProblem, daemonRunning, MOVING_FILES_MESSAGE, pendingMoveMarker } from '../src/cli/daemonProbe';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

// Final review I-1: the CLI runs an engine of its own only when no daemon runs, and never while files are moving
// between the sync folder and the backing store (the daemon finishes that move with its engine held)

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

// Short, so a socket path in it stays under the 108-byte limit
function tempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pdc-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function listenOn(socketPath: string): Promise<void> {
    const server = net.createServer((conn) => conn.end());
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return new Promise((resolve) => server.listen(socketPath, () => resolve()));
}

// A URL nothing answers on: a port just freed
async function deadUrl(): Promise<string> {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const url = `http://127.0.0.1:${server.port}/api/status`;
    await server.stop(true);
    return url;
}

describe('detecting a running daemon', () => {
    test('a control socket that accepts a connection is a running daemon, whatever the TCP API does', async () => {
        const socketPath = path.join(tempDir(), 'control.sock');
        await listenOn(socketPath);
        expect(await controlSocketAccepts(socketPath)).toBe(true);
        expect(await daemonRunning({ socketPath, statusUrl: await deadUrl() })).toBe(true);
    });

    test('no socket (missing, or nothing listening): the TCP API answering still counts, as a fallback', async () => {
        const dir = tempDir();
        const socketPath = path.join(dir, 'control.sock');
        expect(await controlSocketAccepts(socketPath)).toBe(false);
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ state: 'idle' }) });
        cleanups.push(() => server.stop(true));
        expect(await daemonRunning({ socketPath, statusUrl: `http://127.0.0.1:${server.port}/api/status` })).toBe(true);
    });

    test('neither the socket nor the TCP API: not running', async () => {
        const socketPath = path.join(tempDir(), 'control.sock');
        expect(await daemonRunning({ socketPath, statusUrl: await deadUrl() })).toBe(false);
    });
});

// Final review M-5 / addendum concern 4: in the /tmp fallback anyone can make the socket's folder first; the daemon's is
// the user's and 0700, and the CLI never sends a request through any other
describe("the control socket's folder", () => {
    const uid = process.getuid!();

    test('only a private folder of the user\'s is trusted; a missing one just means no daemon runs', () => {
        const dir = tempDir();
        chmodSync(dir, 0o700);
        const sock = path.join(dir, 'control.sock');
        expect(controlSocketDirProblem(sock, uid)).toBeNull();
        expect(controlSocketDirProblem(path.join(dir, 'missing', 'control.sock'), uid)).toBeNull();
        for (const mode of [0o755, 0o770, 0o701, 0o1777]) {
            chmodSync(dir, mode);
            expect(controlSocketDirProblem(sock, uid) ?? '').toContain(dir);
        }
        chmodSync(dir, 0o700);
        expect(controlSocketDirProblem('/control.sock', uid)).not.toBeNull(); // root's
        expect(controlSocketDirProblem(sock, uid + 1)).not.toBeNull();
        const link = `${dir}.link`;
        symlinkSync(dir, link);
        cleanups.push(() => rmSync(link, { force: true }));
        expect(controlSocketDirProblem(path.join(link, 'control.sock'), uid)).not.toBeNull();
    });

    test('pin, free, hide and unhide never reach a socket in a folder others can write', async () => {
        const dir = tempDir();
        const socketPath = path.join(dir, 'control.sock');
        const requests: string[] = [];
        const server = Bun.serve({
            unix: socketPath,
            fetch(req) {
                requests.push(new URL(req.url).pathname);
                return Response.json({ state: 'pinned', kept: [], refused: null });
            },
        });
        cleanups.push(() => server.stop(true));
        chmodSync(dir, 0o777);
        cleanups.push(() => chmodSync(dir, 0o700));
        expect(await runAvailabilityCommand('pin', '/my-files/Docs', '/home/u/ProtonDrive', socketPath)).toBe(1);
        expect(requests).toEqual([]);
        chmodSync(dir, 0o700);
        expect(await runAvailabilityCommand('pin', '/my-files/Docs', '/home/u/ProtonDrive', socketPath)).toBe(0);
        expect(requests).toEqual(['/availability']);
    });
});

describe('a move that the daemon has to finish', () => {
    test('either move marker is found; none, or no database yet, is null', () => {
        const dir = tempDir();
        const dbPath = path.join(dir, 'state.sqlite');
        expect(pendingMoveMarker(dbPath)).toBeNull();
        const db = new SyncStateDatabase(dbPath);
        expect(pendingMoveMarker(dbPath)).toBeNull();
        db.setMeta('layoutMoving', 'plain');
        expect(pendingMoveMarker(dbPath)).toBe('layoutMoving');
        db.deleteMeta('layoutMoving');
        db.setMeta('syncDirMoving', JSON.stringify({ from: '/a', to: '/b' }));
        expect(pendingMoveMarker(dbPath)).toBe('syncDirMoving');
        db.close();
    });

    // The CLI itself, in a sandbox: its own HOME, data dir, runtime dir and daemon port, credentials in a file there (so
    // it is signed out), and an API base URL that goes nowhere; it must refuse before any of that matters
    const runCli = async (args: string[], setup: (appDir: string, runtimeDir: string) => void) => {
        const root = tempDir();
        const appDir = path.join(root, 'app');
        const runtimeDir = path.join(root, 'run');
        mkdirSync(appDir, { recursive: true });
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        setup(appDir, runtimeDir);
        const port = Number(new URL(await deadUrl()).port);
        const env: Record<string, string> = {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: root,
            XDG_RUNTIME_DIR: runtimeDir,
            XDG_CONFIG_HOME: path.join(root, 'config'),
            XDG_DATA_HOME: path.join(root, 'data'),
            XDG_CACHE_HOME: path.join(root, 'cache'),
            XDG_STATE_HOME: path.join(root, 'state'),
            PROTON_DRIVE_CACHE_DIR: appDir,
            PROTON_DRIVE_DAEMON_PORT: String(port),
            PROTON_DRIVE_CREDENTIALS_STORE: 'unsafe_file',
            PROTON_DRIVE_BASE_URL: '127.0.0.1:1',
            PROTON_DRIVE_SYNC_DIR: path.join(root, 'ProtonDrive'),
        };
        const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'src/cli/main.ts'), ...args], {
            env,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        clearTimeout(timer);
        return { code, stdout, stderr };
    };
    const withMarker = (appDir: string) => {
        const db = new SyncStateDatabase(path.join(appDir, 'ubuntu-sync-state.sqlite'));
        db.setMeta('driveLayout', 'virtual');
        db.setMeta('layoutMoving', 'plain');
        db.close();
    };

    test('`protondrive sync` with no daemon refuses while a move marker is set', async () => {
        const out = await runCli(['sync'], withMarker);
        expect(out.stderr).toContain(MOVING_FILES_MESSAGE);
        expect(out.code).toBe(2);
    }, 30_000);

    test('`protondrive conflicts resolve` with no daemon refuses while a move marker is set', async () => {
        const out = await runCli(['conflicts', 'resolve', '1', 'keep-local'], withMarker);
        expect(out.stderr).toContain(MOVING_FILES_MESSAGE);
        expect(out.code).toBe(2);
    }, 30_000);

    test('`protondrive conflicts resolve` goes to a daemon found by its control socket, never to an engine of its own', async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const out = await runCli(['conflicts', 'resolve', '7', 'keep-local'], (appDir, runtimeDir) => {
            withMarker(appDir); // the daemon's business: it holds its engine while files move
            mkdirSync(path.join(runtimeDir, 'protondrive'), { mode: 0o700 });
            const server = Bun.serve({
                unix: path.join(runtimeDir, 'protondrive', 'control.sock'),
                async fetch(req) {
                    requests.push({ path: new URL(req.url).pathname, body: await req.json() });
                    return Response.json({ ok: true, conflict: { id: 7, localRelPath: 'Docs/a.txt' } });
                },
            });
            cleanups.push(() => server.stop(true));
        });
        expect(requests).toEqual([{ path: '/conflicts/resolve', body: { id: 7, choice: 'keep-local' } }]);
        expect(out.stdout).toContain('Conflict #7 (Docs/a.txt) resolved with keep-local.');
        expect(out.code).toBe(0);
    }, 30_000);

    test('`protondrive conflicts resolve` never sends it through a socket folder others can write', async () => {
        const requests: string[] = [];
        const out = await runCli(['conflicts', 'resolve', '7', 'keep-local'], (_appDir, runtimeDir) => {
            mkdirSync(path.join(runtimeDir, 'protondrive'), { mode: 0o700 });
            const server = Bun.serve({
                unix: path.join(runtimeDir, 'protondrive', 'control.sock'),
                fetch(req) {
                    requests.push(new URL(req.url).pathname);
                    return Response.json({ ok: true, conflict: { id: 7, localRelPath: 'Docs/a.txt' } });
                },
            });
            cleanups.push(() => server.stop(true));
            chmodSync(path.join(runtimeDir, 'protondrive'), 0o777);
        });
        expect(requests).toEqual([]);
        expect(out.stderr).toContain("isn't private to you");
        expect(out.code).toBe(1);
    }, 30_000);
});
