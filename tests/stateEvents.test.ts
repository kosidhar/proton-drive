import { describe, expect, test } from 'bun:test';

import { type StateChange, StateEvents } from '../src/sync/stateEvents';

// A scheduler run by hand: fire() runs what is due
function manualClock() {
    let pending: { run: () => void; delayMs: number } | null = null;
    return {
        schedule: (run: () => void, delayMs: number) => {
            const entry = { run, delayMs };
            pending = entry;
            return () => {
                if (pending === entry) pending = null;
            };
        },
        get armed() {
            return pending;
        },
        fire() {
            const due = pending;
            pending = null;
            due?.run();
        },
    };
}

function setup(opts: { maxPaths?: number } = {}) {
    const clock = manualClock();
    const events = new StateEvents({ schedule: clock.schedule, ...opts });
    const seen: Array<StateChange | 'reset'> = [];
    events.subscribe((change) => seen.push(change));
    return { clock, events, seen };
}

describe('StateEvents', () => {
    test('a path goes out with its ancestors, once, after the delay', () => {
        const { clock, events, seen } = setup();
        events.touch('a/b/c.txt');
        expect(clock.armed?.delayMs).toBe(250);
        expect(seen).toEqual([]);
        clock.fire();
        expect(seen).toEqual([{ paths: ['', 'a', 'a/b', 'a/b/c.txt'], subtrees: [] }]);
    });

    test('touches within the delay are coalesced into one change', () => {
        const { clock, events, seen } = setup();
        events.touch('a/x');
        events.touch('b');
        events.touch('a/x');
        clock.fire();
        expect(seen).toEqual([{ paths: ['', 'a', 'a/x', 'b'], subtrees: [] }]);
        clock.fire();
        expect(seen.length).toBe(1);
    });

    test('a subtree swallows what is below it, but keeps its ancestors', () => {
        const { clock, events, seen } = setup();
        events.touchSubtree('a');
        events.touch('a/x');
        events.touchSubtree('a/deep');
        events.touch('b');
        clock.fire();
        expect(seen).toEqual([{ paths: ['', 'a', 'b'], subtrees: ['a'] }]);
    });

    test('too many paths at once go out as a reset', () => {
        const { clock, events, seen } = setup({ maxPaths: 10 });
        for (let i = 0; i < 20; i++) events.touch(`f${i}`);
        clock.fire();
        expect(seen).toEqual(['reset']);
    });

    test('reset() sends a reset', () => {
        const { clock, events, seen } = setup();
        events.touch('a');
        events.reset();
        clock.fire();
        expect(seen).toEqual(['reset']);
    });

    test('paths the index parks nodes at are never sent', () => {
        const { clock, events, seen } = setup();
        events.touch('\u0001moving/uid');
        events.touchSubtree('\u0001detached/uid');
        expect(clock.armed).toBeNull();
        clock.fire();
        expect(seen).toEqual([]);
    });

    test('a listener that throws is removed, and the others still hear', () => {
        const { clock, events, seen } = setup();
        events.subscribe(() => {
            throw new Error('boom');
        });
        expect(events.listenerCount).toBe(2);
        events.touch('a');
        clock.fire();
        expect(events.listenerCount).toBe(1);
        expect(seen.length).toBe(1);
    });

    test('stop() cancels the pending change', () => {
        const { clock, events, seen } = setup();
        events.touch('a');
        events.stop();
        expect(clock.armed).toBeNull();
        expect(seen).toEqual([]);
    });

    test('with nobody listening nothing is kept or scheduled', () => {
        const clock = manualClock();
        const events = new StateEvents({ schedule: clock.schedule });
        events.touch('a');
        expect(clock.armed).toBeNull();
        const seen: unknown[] = [];
        events.subscribe((c) => seen.push(c));
        events.touch('b');
        clock.fire();
        expect(seen).toEqual([{ paths: ['', 'b'], subtrees: [] }]);
    });

    test('unsubscribing stops the changes', () => {
        const clock = manualClock();
        const events = new StateEvents({ schedule: clock.schedule });
        const seen: unknown[] = [];
        const off = events.subscribe((c) => seen.push(c));
        off();
        events.touch('a');
        clock.fire();
        expect(seen).toEqual([]);
    });
});
