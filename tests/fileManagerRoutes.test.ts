import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startControlServer } from '../src/daemon/controlServer';
import { driveRelPath, EventFeed, fileManagerRoute, type FileManagerSource, type LineSink, openEventStreams } from '../src/daemon/fileManagerRoutes';
import { StateEvents } from '../src/sync/stateEvents';
import type { FolderStates } from '../src/sync/syncEngine';

const cleanups: Array<() => void | Promise<void>> = [];
// Waits for a stream to be let go of: closing one is seen by the server a moment later, a long one under the load of the
// whole suite (#118)
const until = async (done: () => boolean, ms = 2500) => {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await Bun.sleep(10);
};
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

const SYNC_DIR = '/home/u/ProtonDrive';

// StateEvents whose changes go out when the test says
function manualEvents() {
    let due: (() => void) | null = null;
    const events = new StateEvents({
        schedule: (run) => {
            due = run;
            return () => {
                due = null;
            };
        },
    });
    return {
        events,
        flush: () => {
            const run = due;
            due = null;
            run?.();
        },
    };
}

function makeSource(events: StateEvents, asked: string[] = []): FileManagerSource {
    return {
        root: () => ({ syncDir: SYNC_DIR, mode: 'virtual', mounted: true }),
        states: (relPath: string): FolderStates | null => {
            asked.push(relPath);
            if (relPath === 'a file.txt') return null;
            return {
                self: relPath === '' ? null : { availability: 'pinned', transfer: null },
                children: { 'résumé b.txt': { availability: 'online-only', transfer: null }, '.git': null },
            };
        },
        events,
    };
}

function fakeSink(room = 64) {
    const lines: unknown[] = [];
    let closed = false;
    const sink: LineSink = {
        enqueue: (line) => {
            lines.push(JSON.parse(line));
            room--;
        },
        close: () => {
            closed = true;
        },
        get desiredSize() {
            return room;
        },
    };
    return {
        sink,
        lines,
        get closed() {
            return closed;
        },
        setRoom: (n: number) => {
            room = n;
        },
    };
}

describe('driveRelPath', () => {
    test('maps paths inside the drive, and nothing else', () => {
        expect(driveRelPath(SYNC_DIR, SYNC_DIR)).toBe('');
        expect(driveRelPath(SYNC_DIR, `${SYNC_DIR}/`)).toBe('');
        expect(driveRelPath(SYNC_DIR, `${SYNC_DIR}/Docs/a b`)).toBe('Docs/a b');
        expect(driveRelPath(SYNC_DIR, `${SYNC_DIR}2/Docs`)).toBeNull();
        expect(driveRelPath(SYNC_DIR, `${SYNC_DIR}/../x`)).toBeNull();
        expect(driveRelPath(SYNC_DIR, '/tmp')).toBeNull();
        expect(driveRelPath(`${SYNC_DIR}/`, `${SYNC_DIR}/Docs`)).toBe('Docs');
    });
});

describe('EventFeed', () => {
    test('says hello, then sends changes with absolute paths, and resets', () => {
        const { events, flush } = manualEvents();
        const out = fakeSink();
        const feed = new EventFeed(out.sink, makeSource(events), { pingMs: 0 });
        events.touch('Docs/a.txt');
        events.touchSubtree('Music');
        flush();
        events.reset();
        flush();
        expect(out.lines).toEqual([
            { type: 'hello', syncDir: SYNC_DIR, mode: 'virtual' },
            {
                type: 'changed',
                paths: [SYNC_DIR, `${SYNC_DIR}/Docs`, `${SYNC_DIR}/Docs/a.txt`, `${SYNC_DIR}/Music`],
                subtrees: [`${SYNC_DIR}/Music`],
            },
            { type: 'reset', syncDir: SYNC_DIR, mode: 'virtual' },
        ]);
        feed.stop();
        expect(events.listenerCount).toBe(0);
    });

    test('a reader that falls behind gets a reset, and the stream ends and lets go of the events', () => {
        const { events, flush } = manualEvents();
        const out = fakeSink();
        new EventFeed(out.sink, makeSource(events), { pingMs: 0 });
        out.setRoom(0);
        events.touch('a');
        flush();
        expect(out.lines.at(-1)).toEqual({ type: 'reset', syncDir: SYNC_DIR, mode: 'virtual' });
        expect(out.closed).toBe(true);
        expect(events.listenerCount).toBe(0);
        events.touch('b');
        flush();
        expect(out.lines.length).toBe(2);
    });

    test('a sink that throws stops the feed', () => {
        const { events, flush } = manualEvents();
        let calls = 0;
        const sink: LineSink = {
            enqueue: () => {
                if (++calls > 1) throw new TypeError('closed');
            },
            close: () => {},
            desiredSize: 10,
        };
        const feed = new EventFeed(sink, makeSource(events), { pingMs: 0 });
        events.touch('a');
        flush();
        expect(feed.isClosed).toBe(true);
        expect(events.listenerCount).toBe(0);
    });
});

describe('file manager routes on the control socket', () => {
    async function start(withSource = true) {
        const root = mkdtempSync(path.join(os.tmpdir(), 'pd-fm-'));
        const socketPath = path.join(root, 'control.sock');
        const manual = manualEvents();
        const asked: string[] = [];
        const server = await startControlServer({
            socketPath,
            engine: {} as never,
            ...(withSource ? { fileManager: makeSource(manual.events, asked) } : {}),
        });
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        cleanups.push(() => server.stop());
        const call = (pathAndQuery: string, init: RequestInit = {}) =>
            fetch(`http://localhost${pathAndQuery}`, { unix: socketPath, ...init } as RequestInit);
        return { call, asked, ...manual };
    }

    test('GET /fm/root', async () => {
        const { call } = await start();
        expect(await (await call('/fm/root')).json()).toEqual({ syncDir: SYNC_DIR, mode: 'virtual', mounted: true });
    });

    test('GET /fm/states maps the folder into the drive, and refuses what is outside it', async () => {
        const { call, asked } = await start();
        const q = (p: string) => `/fm/states?path=${encodeURIComponent(p)}`;
        const res = await call(q(`${SYNC_DIR}/Docs/é x`));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            path: `${SYNC_DIR}/Docs/é x`,
            self: { availability: 'pinned', transfer: null },
            children: { 'résumé b.txt': { availability: 'online-only', transfer: null }, '.git': null },
        });
        expect((await call(q(SYNC_DIR))).status).toBe(200);
        expect(asked).toEqual(['Docs/é x', '']);
        expect((await call(q(`${SYNC_DIR}/a file.txt`))).status).toBe(404);
        expect((await call(q(`${SYNC_DIR}/../etc`))).status).toBe(404);
        expect((await call(q('/tmp'))).status).toBe(404);
        expect((await call(q('relative/path'))).status).toBe(400);
        expect((await call('/fm/states')).status).toBe(400);
        expect((await call('/fm/root', { method: 'POST' })).status).toBe(405);
    });

    test('without a source the routes are 404', async () => {
        const { call } = await start(false);
        expect((await call('/fm/root')).status).toBe(404);
    });

    test('GET /fm/events streams hello and changes, and a closed reader lets go', async () => {
        const { call, events, flush } = await start();
        const abort = new AbortController();
        const res = await call('/fm/events', { signal: abort.signal });
        expect(res.headers.get('content-type')).toBe('application/x-ndjson');
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        const nextLine = async () => {
            while (!buffered.includes('\n')) {
                const { value, done } = await reader.read();
                if (done) throw new Error('stream ended');
                buffered += decoder.decode(value);
            }
            const at = buffered.indexOf('\n');
            const line = buffered.slice(0, at);
            buffered = buffered.slice(at + 1);
            return JSON.parse(line);
        };
        expect(await nextLine()).toEqual({ type: 'hello', syncDir: SYNC_DIR, mode: 'virtual' });
        expect(events.listenerCount).toBe(1);
        events.touch('Docs');
        flush();
        expect(await nextLine()).toEqual({ type: 'changed', paths: [SYNC_DIR, `${SYNC_DIR}/Docs`], subtrees: [] });

        abort.abort();
        await until(() => events.listenerCount === 0);
        expect(events.listenerCount).toBe(0);
        expect(openEventStreams()).toBe(0);
    });

    test('a stream whose request was gone before it started is not left counted', () => {
        const { events } = manualEvents();
        const url = new URL('http://localhost/fm/events');
        const res = fileManagerRoute(new Request(url, { signal: AbortSignal.abort() }), url, makeSource(events, []));
        expect(res.status).toBe(200);
        expect(openEventStreams()).toBe(0);
    });

    // #125: the count went up before the feed existed, and stayed up when making it threw
    test('a stream whose feed cannot start is answered with an error and not left counted', async () => {
        await until(() => openEventStreams() === 0);
        const { events } = manualEvents();
        const url = new URL('http://localhost/fm/events');
        const noRoot = { ...makeSource(events, []), root: () => { throw new Error('no settings yet'); } } as FileManagerSource;
        expect(fileManagerRoute(new Request(url), url, noRoot).status).toBe(503);
        expect(openEventStreams()).toBe(0);
        // Failing after the hello was queued: no subscription is left either
        const noEvents = {
            ...makeSource(events, []),
            events: { subscribe: () => { throw new Error('closed'); } },
        } as unknown as FileManagerSource;
        expect(fileManagerRoute(new Request(url), url, noEvents).status).toBe(503);
        expect(openEventStreams()).toBe(0);
    });

    test('a 17th event stream is refused', async () => {
        // The cap counts every stream in this process: one another test closed may not be let go of yet (#118)
        await until(() => openEventStreams() === 0);
        expect(openEventStreams()).toBe(0);
        const { call } = await start();
        const aborts: AbortController[] = [];
        cleanups.push(() => aborts.forEach((a) => a.abort()));
        for (let i = 0; i < 16; i++) {
            const abort = new AbortController();
            aborts.push(abort);
            const res = await call('/fm/events', { signal: abort.signal });
            expect(res.status).toBe(200);
        }
        expect((await call('/fm/events')).status).toBe(503);
        aborts.forEach((a) => a.abort());
        await until(() => openEventStreams() === 0);
        expect(openEventStreams()).toBe(0);
    }, 15_000);
});

describe('controlServerOptions wires the file manager to the engine and the drive', () => {
    test('root from the settings and the drive status; states and events from the engine', async () => {
        const { controlServerOptions } = await import('../src/daemon/controlWiring');
        const { events } = manualEvents();
        const asked: string[] = [];
        const opts = controlServerOptions({
            socketPath: '/nowhere',
            engine: { itemStates: (rel: string) => (asked.push(rel), null), stateEvents: events } as never,
            drive: { status: () => ({ mode: 'plain', mounted: false, reason: null }) } as never,
            stateDb: { getSettings: () => ({ syncDir: '/home/u/Drive' }) } as never,
            signIn: (async () => ({ signInUrl: '' })) as never,
            signOut: async () => {},
            makeRemoteFolder: (async () => ({ uid: 'x', name: 'x' })) as never,
        });
        expect(opts.fileManager!.root()).toEqual({ syncDir: '/home/u/Drive', mode: 'plain', mounted: false });
        expect(opts.fileManager!.states('Docs')).toBeNull();
        expect(asked).toEqual(['Docs']);
        expect(opts.fileManager!.events).toBe(events);
    });
});
