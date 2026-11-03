import path from 'node:path';

import type { StateChange, StateEvents } from '../sync/stateEvents';
import type { FolderStates } from '../sync/syncEngine';

// The file manager extension's routes, on the user-only control socket. All of them only read: changing what is on
// this computer stays with POST /availability.
//
// GET /fm/root: { syncDir, mode, mounted }, where Files shows the drive.
// GET /fm/states?path=<absolute folder path>: { path, self, children } (see ProtonDriveSyncEngine.itemStates); 404
//   { error, code: 'ENOENT' } for a path outside the drive, or one that isn't a folder of it.
// GET /fm/events: newline-delimited JSON, one object a line: first { type: 'hello', syncDir, mode }, then
//   { type: 'changed', paths, subtrees } (absolute paths), { type: 'reset', syncDir, mode } when everything may have
//   changed, and { type: 'ping' } every 30 s. A reader that falls behind is sent a reset and dropped; it reconnects.

export interface FileManagerSource {
    root(): { syncDir: string; mode: 'virtual' | 'plain'; mounted: boolean };
    states(relPath: string): FolderStates | null;
    events: Pick<StateEvents, 'subscribe'>;
}

export const FM_ROUTES: readonly string[] = ['/fm/root', '/fm/states', '/fm/events'];

const MAX_STREAMS = 16;
const QUEUE_LINES = 64;
const PING_MS = 30_000;

let openStreams = 0;

export function openEventStreams(): number {
    return openStreams;
}

function notFound(message: string): Response {
    return Response.json({ error: message, code: 'ENOENT' }, { status: 404 });
}

// The path of a folder in the drive, from its path as Files shows it; null for one outside the drive. Symlinks are not
// resolved: the mount point is the path Files shows.
export function driveRelPath(syncDir: string, fullPath: string): string | null {
    const root = path.resolve(syncDir);
    const target = path.resolve(fullPath);
    if (target === root) {
        return '';
    }
    if (!target.startsWith(`${root}/`)) {
        return null;
    }
    return target.slice(root.length + 1);
}

function absolute(syncDir: string, relPath: string): string {
    return relPath === '' ? syncDir : `${syncDir}/${relPath}`;
}

// Where the lines of one event stream go, with a bound on how many may wait: past it, the reader is too slow to be
// worth keeping (its view would be stale anyway), so it gets a reset, if one more line fits, and the stream ends.
export interface LineSink {
    enqueue(line: string): void;
    close(): void;
    desiredSize: number | null;
}

export class EventFeed {
    private closed = false;
    private unsubscribe: (() => void) | null = null;
    private ping: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly sink: LineSink,
        private readonly source: FileManagerSource,
        opts: { pingMs?: number } = {},
    ) {
        const { syncDir, mode } = source.root();
        this.send({ type: 'hello', syncDir, mode });
        this.unsubscribe = source.events.subscribe((change) => this.onChange(change));
        const pingMs = opts.pingMs ?? PING_MS;
        if (pingMs > 0) {
            this.ping = setInterval(() => this.send({ type: 'ping' }), pingMs);
        }
    }

    get isClosed(): boolean {
        return this.closed;
    }

    stop(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.ping) {
            clearInterval(this.ping);
            this.ping = null;
        }
    }

    private onChange(change: StateChange | 'reset'): void {
        const { syncDir, mode } = this.source.root();
        if (change === 'reset') {
            this.send({ type: 'reset', syncDir, mode });
            return;
        }
        this.send({
            type: 'changed',
            paths: change.paths.map((p) => absolute(syncDir, p)),
            subtrees: change.subtrees.map((p) => absolute(syncDir, p)),
        });
    }

    private send(event: Record<string, unknown>): void {
        if (this.closed) {
            return;
        }
        try {
            if ((this.sink.desiredSize ?? 0) <= 0) {
                const { syncDir, mode } = this.source.root();
                this.sink.enqueue(`${JSON.stringify({ type: 'reset', syncDir, mode })}\n`);
                this.stop();
                this.sink.close();
                return;
            }
            this.sink.enqueue(`${JSON.stringify(event)}\n`);
        } catch {
            this.stop(); // the reader went away
        }
    }
}

export function fileManagerRoute(req: Request, url: URL, source: FileManagerSource | undefined): Response {
    if (req.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    if (!source) {
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (url.pathname === '/fm/root') {
        return Response.json(source.root());
    }
    if (url.pathname === '/fm/states') {
        const fullPath = url.searchParams.get('path');
        if (!fullPath || !path.isAbsolute(fullPath)) {
            return Response.json({ error: 'path must be an absolute folder path', code: 'EINVAL' }, { status: 400 });
        }
        const rel = driveRelPath(source.root().syncDir, fullPath);
        if (rel === null) {
            return notFound(`Not in Proton Drive: ${fullPath}`);
        }
        const states = source.states(rel);
        if (!states) {
            return notFound(`Not a folder in Proton Drive: ${fullPath}`);
        }
        return Response.json({ path: fullPath, ...states });
    }
    return eventStream(req, source);
}

function eventStream(req: Request, source: FileManagerSource): Response {
    if (openStreams >= MAX_STREAMS) {
        return Response.json({ error: 'Too many event streams' }, { status: 503 });
    }
    let feed: EventFeed | null = null;
    // Counted from before the feed is made to its end, released exactly once however it ends: closed, aborted,
    // cancelled, or never started because making the feed threw (#125)
    let counted = true;
    openStreams++;
    const done = () => {
        if (feed && !feed.isClosed) {
            feed.stop();
        }
        if (counted) {
            counted = false;
            openStreams--;
        }
    };
    const encoder = new TextEncoder();
    let stream: ReadableStream<Uint8Array>;
    try {
        stream = new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    const sink: LineSink = {
                        enqueue: (line) => controller.enqueue(encoder.encode(line)),
                        close: () => {
                            controller.close();
                            done();
                        },
                        get desiredSize() {
                            return controller.desiredSize;
                        },
                    };
                    feed = new EventFeed(sink, source);
                    req.signal.addEventListener('abort', done, { once: true });
                    if (req.signal.aborted) {
                        done(); // gone before the listener was there: it never fires, and the stream would stay counted
                    }
                },
                cancel() {
                    done();
                },
            },
            new CountQueuingStrategy({ highWaterMark: QUEUE_LINES }),
        );
    } catch (error: unknown) {
        // The feed couldn't start (asking for the root threw, say)
        done();
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: `Can't stream changes: ${message}` }, { status: 503 });
    }
    return new Response(stream, {
        headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
    });
}
