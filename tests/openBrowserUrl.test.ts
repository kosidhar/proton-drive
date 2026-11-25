import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { openBrowserUrl } from '../src/sdk/openBrowserUrl';

// A stand-in for child_process.spawn: never starts anything
function fakeSpawn(outcome: 'spawn' | Error) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = ((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const child = new EventEmitter() as EventEmitter & { unref: () => void };
        child.unref = () => {};
        queueMicrotask(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', outcome)));
        return child;
    }) as never;
    return { calls, spawnFn };
}

test('a started opener resolves ok', async () => {
    const f = fakeSpawn('spawn');
    expect(await openBrowserUrl('https://example.com/a', f.spawnFn)).toEqual({ ok: true });
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].args).toContain('https://example.com/a');
});

test('a spawn error such as ENOENT is reported with its reason', async () => {
    const f = fakeSpawn(new Error('spawn xdg-open ENOENT'));
    const result = await openBrowserUrl('https://example.com/a', f.spawnFn);
    expect(result).toEqual({ ok: false, reason: 'spawn xdg-open ENOENT' });
});

test('a URL that is not http(s) is reported and nothing is spawned', async () => {
    const f = fakeSpawn('spawn');
    const result = await openBrowserUrl('file:///etc/passwd', f.spawnFn);
    expect(result.ok).toBe(false);
    expect(f.calls.length).toBe(0);
});
