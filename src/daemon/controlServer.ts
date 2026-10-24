import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { AvailabilityAction, ProtonDriveSyncEngine } from '../sync/syncEngine';

// Pin, free, hide and unhide change what is on disk, so they are reachable only through this user-only Unix socket and
// never through the unauthenticated TCP API.

const ACTIONS: readonly string[] = ['pin', 'free', 'hide', 'unhide'] satisfies AvailabilityAction[];

export function defaultControlSocketPath(): string {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir) {
        return path.join(runtimeDir, 'protondrive', 'control.sock');
    }
    const uid = process.getuid?.() ?? 'user';
    return path.join(os.tmpdir(), `protondrive-${uid}`, 'control.sock');
}

export interface ControlServerOptions {
    socketPath: string;
    engine: Pick<ProtonDriveSyncEngine, 'setAvailability' | 'availability'>;
}

// 'live' when something accepts connections on the socket, 'stale' when it refuses or is gone
function probeSocket(socketPath: string): Promise<'live' | 'stale'> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolve('live');
        });
        socket.once('error', (err: NodeJS.ErrnoException) => {
            socket.destroy();
            if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK') {
                resolve('stale');
            } else {
                reject(err);
            }
        });
    });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
    let stat;
    try {
        stat = lstatSync(socketPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
    }
    if (stat.isDirectory()) {
        throw new Error(`Control socket path is a directory: ${socketPath}`);
    }
    // Never unlink a socket that another daemon is serving; a plain file or a refused socket is safe to replace
    if (stat.isSocket() && (await probeSocket(socketPath)) === 'live') {
        throw new Error(`Another daemon is already running on ${socketPath}`);
    }
    unlinkSync(socketPath);
}

function jsonError(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
}

export async function startControlServer(opts: ControlServerOptions): Promise<{ stop(): void }> {
    const { socketPath, engine } = opts;
    const dir = path.dirname(socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    await removeStaleSocket(socketPath);

    const server = Bun.serve({
        unix: socketPath,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname !== '/availability') {
                return jsonError('Not found', 404);
            }
            if (req.method === 'GET') {
                const relPath = url.searchParams.get('path');
                if (relPath === null) return jsonError('Missing path');
                return Response.json({ path: relPath, state: engine.availability.stateOf(relPath) });
            }
            if (req.method === 'POST') {
                let body: { path?: unknown; action?: unknown };
                try {
                    body = (await req.json()) as typeof body;
                } catch {
                    return jsonError('Invalid JSON body');
                }
                if (typeof body?.path !== 'string') return jsonError('Missing path');
                if (typeof body.action !== 'string' || !ACTIONS.includes(body.action)) {
                    return jsonError(`Unknown action: ${String(body.action)}`);
                }
                try {
                    return Response.json(await engine.setAvailability(body.path, body.action as AvailabilityAction));
                } catch (err) {
                    return jsonError(err instanceof Error ? err.message : String(err));
                }
            }
            return jsonError('Method not allowed', 405);
        },
    });
    chmodSync(socketPath, 0o600);

    return {
        stop() {
            void server.stop(true);
            try {
                unlinkSync(socketPath);
            } catch {
                // already removed
            }
        },
    };
}
