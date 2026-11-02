import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sendActionNotification } from '../src/linux/notifications';
import { DownloadWatch, MASS_DOWNLOAD_COUNT } from '../src/sync/downloadWatch';

function clocked() {
    let now = 1_000_000;
    const watch = new DownloadWatch(() => now);
    return { watch, advance: (ms: number) => (now += ms) };
}

describe('DownloadWatch', () => {
    test('the 21st download within a minute by one app says so, once', () => {
        const { watch, advance } = clocked();
        const answers = Array.from({ length: 30 }, () => {
            advance(1000);
            return watch.record('rg');
        });
        expect(answers.slice(0, MASS_DOWNLOAD_COUNT).every((a) => a === null)).toBe(true);
        expect(answers[MASS_DOWNLOAD_COUNT]).toBe(21);
        expect(answers.slice(MASS_DOWNLOAD_COUNT + 1).every((a) => a === null)).toBe(true);
    });

    test('downloads spread over more than a minute never add up', () => {
        const { watch, advance } = clocked();
        for (let i = 0; i < 100; i++) {
            advance(3100);
            expect(watch.record('backup')).toBeNull();
        }
    });

    test('quiet for ten minutes after a notice, then it can say so again', () => {
        const { watch, advance } = clocked();
        const burst = () => {
            let said: number | null = null;
            for (let i = 0; i < 25; i++) said ??= watch.record('rg');
            return said;
        };
        expect(burst()).toBe(21);
        advance(5 * 60_000);
        expect(burst()).toBeNull();
        advance(5 * 60_000 + 1);
        expect(burst()).toBe(21);
    });

    test('apps are counted apart; Files and unknown openers never count', () => {
        const { watch } = clocked();
        for (let i = 0; i < 15; i++) {
            expect(watch.record('rg')).toBeNull();
            expect(watch.record('code')).toBeNull();
        }
        for (let i = 0; i < 50; i++) {
            expect(watch.record('nautilus')).toBeNull();
            expect(watch.record(undefined)).toBeNull();
        }
    });
});

describe('sendActionNotification', () => {
    const dirs: string[] = [];
    afterEach(() => {
        while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    });
    // A stand-in notify-send: writes its arguments to a file and runs `script`
    const fake = (script: string) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-notify-'));
        dirs.push(dir);
        const command = path.join(dir, 'notify-send');
        writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n${script}\n`);
        chmodSync(command, 0o755);
        return { command, args: () => Bun.file(path.join(dir, 'args')).text() };
    };
    const ask = (command: string, enabled = true) =>
        sendActionNotification({ title: 'rg is downloading', body: 'Many', actions: [{ key: 'block', label: 'Block this app' }], enabled, command });

    test('answers the button chosen, and asks with --wait and the action', async () => {
        const n = fake('echo block');
        expect(await ask(n.command)).toBe('block');
        const args = (await n.args()).split('\n');
        expect(args).toContain('--wait');
        expect(args).toContain('--action=block=Block this app');
        expect(args.slice(-3, -1)).toEqual(['rg is downloading', 'Many']);
    });

    test('a dismissed notification, or an answer it did not offer, is null', async () => {
        expect(await ask(fake('exit 0').command)).toBeNull();
        expect(await ask(fake('echo other').command)).toBeNull();
    });

    test('a notify-send that fails at once can not show buttons', async () => {
        expect(await ask(fake('echo "Unknown option --action" >&2; exit 1').command)).toBe('unsupported');
    });

    test('with notifications off, or no notify-send, nothing is shown and the answer is null', async () => {
        const n = fake('echo block');
        expect(await ask(n.command, false)).toBeNull();
        expect(await Bun.file(n.command + '-never').exists()).toBe(false);
        expect(await ask('/nonexistent/notify-send')).toBeNull();
    });
});
