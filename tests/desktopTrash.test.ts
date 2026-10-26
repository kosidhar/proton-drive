import { describe, expect, test } from 'bun:test';

import { trashCommand } from '../src/sync/desktopTrash';

// The real `gio trash` is never run here: these use stand-in commands to check how the outcome is read
describe('desktop Trash command', () => {
    test('counts as moved only when the command exits 0', async () => {
        expect(await trashCommand(['true'])('/nowhere')).toBe(true);
        expect(await trashCommand(['false'])('/nowhere')).toBe(false);
    });

    test('a command that cannot be started counts as not moved', async () => {
        expect(await trashCommand(['/nonexistent/proton-drive-no-such-command'])('/nowhere')).toBe(false);
    });

    test('the path is passed whole as the last argument, even with spaces or a leading dash', async () => {
        expect(await trashCommand(['sh', '-c', '[ "$#" = 1 ] && [ "$1" = "-x y" ]', 'sh'])('-x y')).toBe(true);
    });

    test('a command that hangs is stopped and counts as not moved', async () => {
        const started = Date.now();
        expect(await trashCommand(['sh', '-c', 'sleep 5', 'sh'], 100)('/nowhere')).toBe(false);
        expect(Date.now() - started).toBeLessThan(3000);
    });
});
