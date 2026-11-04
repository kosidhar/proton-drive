import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_PAUSE_MS, pauseRoute } from '../src/daemon/pauseRoute';
import { ProtonDriveSyncEngine } from '../src/sync/syncEngine';
import { SyncStateDatabase } from '../src/sync/syncStateDb';
import { uploadAtOnce } from './helpers/engineOptions';
import { makeMockDrive } from './helpers/mockDrive';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

// A fake clock and timer for the engine's pause: what was scheduled, for how long, and whether it was cancelled
function fakeClock() {
    let now = T0;
    const timers: Array<{ run: () => Promise<void>; delayMs: number; cancelled: boolean }> = [];
    return {
        timers,
        live: () => timers.filter((t) => !t.cancelled),
        advance: (ms: number) => void (now += ms),
        options: {
            now: () => now,
            schedule: (run: () => Promise<void>, delayMs: number) => {
                const timer = { run, delayMs, cancelled: false };
                timers.push(timer);
                return () => void (timer.cancelled = true);
            },
        },
    };
}

function setup(opts: { loggedIn?: boolean; stateDir?: string } = {}) {
    const dir = opts.stateDir ?? mkdtempSync(path.join(os.tmpdir(), 'pd-pause-'));
    if (!opts.stateDir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
    cleanups.push(() => stateDb.close());
    stateDb.updateSettings({ syncDir: path.join(dir, 'ProtonDrive') });
    const clock = fakeClock();
    const drive = makeMockDrive();
    const engine = new ProtonDriveSyncEngine(drive.sdk, drive.eventsManager, { isLoggedIn: () => opts.loggedIn ?? false }, stateDb, drive.logger, {
        ...uploadAtOnce,
        backingDir: path.join(dir, 'files'),
        pauseClock: clock.options,
    });
    cleanups.push(() => void engine.stop());
    const activity = () => stateDb.listActivity(50).map((a) => a.details);
    return { dir, stateDb, engine, clock, activity };
}

describe('POST /api/pause with an end time (#205)', () => {
    const call = async (body: unknown, now = T0) => {
        const seen: Array<[boolean, number | null | undefined]> = [];
        const engine = {
            setPaused: async (paused: boolean, until?: number | null) => void seen.push([paused, until]),
            getStatus: () => ({ state: 'paused' }),
        };
        const res = await pauseRoute(body, engine, now);
        return { status: res.status, json: (await res.json()) as Record<string, unknown>, seen };
    };

    test('{paused: true} pauses until resumed, with no time', async () => {
        const r = await call({ paused: true });
        expect([r.status, r.seen]).toEqual([200, [[true, null]]]);
        expect(r.json.ok).toBe(true);
    });

    test('{paused: false} resumes', async () => {
        expect((await call({ paused: false })).seen).toEqual([[false, null]]);
    });

    test('a time in the future, up to 7 days ahead, pauses until then', async () => {
        expect((await call({ paused: true, until: T0 + HOUR })).seen).toEqual([[true, T0 + HOUR]]);
        expect((await call({ paused: true, until: T0 + MAX_PAUSE_MS })).seen).toEqual([[true, T0 + MAX_PAUSE_MS]]);
        expect(MAX_PAUSE_MS).toBe(7 * 24 * HOUR);
    });

    test('a bad time is refused with 400, and nothing changes', async () => {
        const bad: unknown[] = [
            { paused: true, until: T0 },
            { paused: true, until: T0 - 1 },
            { paused: true, until: T0 + MAX_PAUSE_MS + 1 },
            { paused: true, until: '1700000000000' },
            { paused: true, until: Number.NaN },
            { paused: true, until: Number.POSITIVE_INFINITY },
            { paused: true, until: T0 + 0.5 + HOUR },
            { paused: false, until: T0 + HOUR },
        ];
        for (const body of bad) {
            const r = await call(body);
            expect([body, r.status, typeof r.json.error, r.seen]).toEqual([body, 400, 'string', []]);
        }
    });

    test('{until: null} is the same as no time', async () => {
        expect((await call({ paused: true, until: null })).seen).toEqual([[true, null]]);
    });
});

describe('The engine resumes by itself when a timed pause ends (#205)', () => {
    test('a pause with a time is stored, logged and timed; the timer resumes it', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        expect(t.stateDb.getSettings()).toMatchObject({ paused: true, pausedUntil: T0 + HOUR });
        expect(t.engine.getStatus().settings.pausedUntil).toBe(T0 + HOUR);
        expect(t.activity()[0]).toBe(`Synchronization paused until ${new Date(T0 + HOUR).toISOString()}`);
        expect(t.clock.live().map((x) => x.delayMs)).toEqual([HOUR]);

        t.clock.advance(HOUR);
        await t.clock.live()[0].run();
        expect(t.stateDb.getSettings()).toMatchObject({ paused: false, pausedUntil: null });
        expect(t.activity()[0]).toBe('Synchronization resumed (pause ended)');
    });

    test('a timer that fires early waits again for the rest, and stays paused', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        t.clock.advance(HOUR - 5);
        await t.clock.live()[0].run();
        expect(t.stateDb.getSettings().paused).toBe(true);
        expect(t.clock.timers.map((x) => x.delayMs)).toEqual([HOUR, 5]);
        t.clock.advance(5);
        await t.clock.timers[1].run();
        expect(t.stateDb.getSettings()).toMatchObject({ paused: false, pausedUntil: null });
    });

    test('a pause with no time stores none and sets no timer, and clears an earlier time', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        await t.engine.setPaused(true);
        expect(t.stateDb.getSettings()).toMatchObject({ paused: true, pausedUntil: null });
        expect(t.clock.live()).toEqual([]);
        expect(t.activity()[0]).toBe('Synchronization paused by user');
    });

    test('a manual resume cancels the timer and clears the time', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        await t.engine.setPaused(false);
        expect(t.clock.live()).toEqual([]);
        expect(t.stateDb.getSettings()).toMatchObject({ paused: false, pausedUntil: null });
        expect(t.activity()[0]).toBe('Synchronization resumed by user');
    });

    test('a new pause replaces the old timer', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        await t.engine.setPaused(true, T0 + 2 * HOUR);
        expect(t.clock.live().map((x) => x.delayMs)).toEqual([2 * HOUR]);
        expect(t.stateDb.getSettings().pausedUntil).toBe(T0 + 2 * HOUR);
    });

    test('a stale timer never resumes a pause that was changed since', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        const stale = t.clock.timers[0];
        await t.engine.setPaused(true);
        t.clock.advance(HOUR);
        await stale.run();
        expect(t.stateDb.getSettings()).toMatchObject({ paused: true, pausedUntil: null });
    });

    test('stopping the engine clears the timer', async () => {
        const t = setup();
        await t.engine.setPaused(true, T0 + HOUR);
        await t.engine.stop();
        expect(t.clock.live()).toEqual([]);
        expect(t.stateDb.getSettings()).toMatchObject({ paused: true, pausedUntil: T0 + HOUR }); // kept for the next start
    });
});

describe('A timed pause survives a restart (#205)', () => {
    test('a start after the time has passed resumes at once', async () => {
        const t = setup();
        t.stateDb.updateSettings({ paused: true, pausedUntil: T0 - 1 });
        await t.engine.start();
        expect(t.stateDb.getSettings()).toMatchObject({ paused: false, pausedUntil: null });
        expect(t.activity()[0]).toBe('Synchronization resumed (pause ended)');
        expect(t.clock.live()).toEqual([]);
    });

    test('a start before the time sets the timer again for what is left', async () => {
        const t = setup();
        t.stateDb.updateSettings({ paused: true, pausedUntil: T0 + 10 * 60_000 });
        await t.engine.start();
        expect(t.stateDb.getSettings()).toMatchObject({ paused: true, pausedUntil: T0 + 10 * 60_000 });
        expect(t.clock.live().map((x) => x.delayMs)).toEqual([10 * 60_000]);
        await t.engine.start(); // started again (as after a sign-in): still one timer
        expect(t.clock.live().map((x) => x.delayMs)).toEqual([10 * 60_000]);
    });

    test('signed in, a start after the time resumes and syncs', async () => {
        const t = setup({ loggedIn: true });
        t.stateDb.updateSettings({ paused: true, pausedUntil: T0 - 1 });
        await t.engine.start();
        expect(t.stateDb.getSettings().paused).toBe(false);
        expect(t.engine.getStatus().state).not.toBe('paused');
    });

    test('a time stored without a pause is ignored and sets no timer', async () => {
        const t = setup();
        t.stateDb.updateSettings({ paused: false, pausedUntil: T0 + HOUR });
        await t.engine.start();
        expect(t.clock.live()).toEqual([]);
        expect(t.stateDb.getSettings().paused).toBe(false);
    });
});

describe('pausedUntil in the settings (#205)', () => {
    test('absent reads as null; a number is stored and read back; null removes it', () => {
        const t = setup();
        expect(t.stateDb.getSettings().pausedUntil).toBeNull();
        t.stateDb.updateSettings({ pausedUntil: T0 });
        expect(t.stateDb.getSettings().pausedUntil).toBe(T0);
        t.stateDb.updateSettings({ notificationsEnabled: false });
        expect(t.stateDb.getSettings().pausedUntil).toBe(T0);
        t.stateDb.updateSettings({ pausedUntil: null });
        expect(t.stateDb.getSettings().pausedUntil).toBeNull();
        expect(t.stateDb.getMeta('pausedUntil')).toBeNull();
    });

    test('a stored value that is not a time reads as null', () => {
        const t = setup();
        for (const raw of ['', 'soon', '-5', 'NaN', 'Infinity']) {
            t.stateDb.setMeta('pausedUntil', raw);
            expect([raw, t.stateDb.getSettings().pausedUntil]).toEqual([raw, null]);
        }
    });
});
