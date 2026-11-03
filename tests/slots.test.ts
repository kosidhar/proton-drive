import { describe, expect, test } from 'bun:test';

import { Slots } from '../src/sync/slots';

describe('Slots', () => {
    test('never runs more than its size at once, and runs every task, in order of arrival', async () => {
        const slots = new Slots(3);
        let running = 0;
        let most = 0;
        const started: number[] = [];
        const tasks = Array.from({ length: 50 }, (_, i) =>
            slots.run(async () => {
                started.push(i);
                running++;
                most = Math.max(most, running);
                await Bun.sleep(i % 3);
                running--;
                return i;
            }),
        );
        expect(await Promise.all(tasks)).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(most).toBe(3);
        expect(started).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(slots.running).toBe(0);
        expect(slots.queued).toBe(0);
    });

    test('a task that throws frees its slot', async () => {
        const slots = new Slots(1);
        await expect(slots.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        expect(await slots.run(async () => 'next')).toBe('next');
        expect(slots.running).toBe(0);
    });

    test('a new task arriving as a slot is freed does not jump the queue past the limit', async () => {
        const slots = new Slots(1);
        let running = 0;
        let most = 0;
        const task = () =>
            slots.run(async () => {
                running++;
                most = Math.max(most, running);
                await Promise.resolve();
                running--;
            });
        const first = task();
        const second = task(); // waits
        await first;
        const third = task(); // arrives just as the first one's slot went to the second
        await Promise.all([second, third]);
        expect(most).toBe(1);
    });

    test('a size below 1 is refused', () => {
        expect(() => new Slots(0)).toThrow();
    });
});
