import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyStartAtLogin, autostartEntryPath, autostartCommand, desktopEntry } from '../src/linux/autostart';
import { parseSettings } from '../src/daemon/settingsValidation';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

// #92: Proton Drive starts at login (the daemon, and with it the drive, and the tray), unless the user turns it off
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const configHome = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-autostart-'));
    dirs.push(dir);
    return dir;
};

describe('the login entry', () => {
    test('lives in $XDG_CONFIG_HOME/autostart, or ~/.config/autostart', () => {
        expect(autostartEntryPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' })).toBe('/x/cfg/autostart/proton-drive.desktop');
        expect(autostartEntryPath({ HOME: '/home/u' })).toBe('/home/u/.config/autostart/proton-drive.desktop');
    });

    test('runs the autostart command of the installed binary; under bun, the script', () => {
        expect(autostartCommand('/usr/bin/protondrive', ['/usr/bin/protondrive', 'daemon'])).toEqual(['/usr/bin/protondrive', 'autostart']);
        expect(autostartCommand('/home/u/.bun/bin/bun', ['/home/u/.bun/bin/bun', '/src/cli/main.ts', 'daemon'])).toEqual([
            '/home/u/.bun/bin/bun',
            '/src/cli/main.ts',
            'autostart',
        ]);
    });

    test('is a desktop entry quoting its command, marked as ours', () => {
        const entry = desktopEntry(['/opt/Proton Drive/protondrive', 'autostart']);
        expect(entry).toContain('[Desktop Entry]\nType=Application\n');
        expect(entry).toContain('Exec="/opt/Proton Drive/protondrive" autostart\n');
        expect(entry).toContain('X-ProtonDrive-Autostart=true\n');
        expect(entry).toContain('X-GNOME-Autostart-enabled=true\n');
    });

    test('is written when on, kept up to date, and removed when off; never one that is not ours', () => {
        const env = { XDG_CONFIG_HOME: configHome() };
        const file = autostartEntryPath(env);
        applyStartAtLogin(true, ['/usr/bin/protondrive', 'autostart'], env);
        expect(readFileSync(file, 'utf8')).toContain('Exec=/usr/bin/protondrive autostart');
        applyStartAtLogin(true, ['/opt/protondrive', 'autostart'], env);
        expect(readFileSync(file, 'utf8')).toContain('Exec=/opt/protondrive autostart');
        applyStartAtLogin(false, ['/opt/protondrive', 'autostart'], env);
        expect(existsSync(file)).toBe(false);
        // The user's own entry of that name is left alone
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '[Desktop Entry]\nExec=my-own\n');
        applyStartAtLogin(false, ['/opt/protondrive', 'autostart'], env);
        expect(readFileSync(file, 'utf8')).toBe('[Desktop Entry]\nExec=my-own\n');
        applyStartAtLogin(true, ['/opt/protondrive', 'autostart'], env);
        expect(readFileSync(file, 'utf8')).toBe('[Desktop Entry]\nExec=my-own\n');
    });
});

describe('the startAtLogin setting', () => {
    test('is on unless turned off, and only true or false is accepted', () => {
        const dir = configHome();
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        expect(stateDb.getSettings().startAtLogin).toBe(true);
        stateDb.updateSettings({ startAtLogin: false });
        expect(stateDb.getSettings().startAtLogin).toBe(false);
        stateDb.close();
        expect(parseSettings({ startAtLogin: false })).toEqual({ ok: true, value: { startAtLogin: false } });
        expect(parseSettings({ startAtLogin: 'yes' }).ok).toBe(false);
    });
});

describe('saving startAtLogin', () => {
    const { driveSettings } = require('../src/daemon/settingsRoute');
    const deps = (applied: boolean[], fail = false) => {
        const dir = configHome();
        const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
        return {
            stateDb,
            drive: { relocate: async (to: string) => to, setVirtualDriveWanted: async () => {}, status: () => ({}) as never },
            engine: { reconcileNow: async () => {} },
            applyStartAtLogin: (on: boolean) => {
                if (fail) throw new Error('read-only home');
                applied.push(on);
            },
        };
    };

    test('applies the login entry as it is saved, and only then', async () => {
        const applied: boolean[] = [];
        const d = deps(applied);
        await driveSettings({ settings: { notificationsEnabled: false } }, d);
        expect(applied).toEqual([]);
        const res = await driveSettings({ settings: { startAtLogin: false } }, d);
        expect(res.status).toBe(200);
        expect(applied).toEqual([false]);
        expect(d.stateDb.getSettings().startAtLogin).toBe(false);
        d.stateDb.close();
    });

    test('an entry that cannot be written leaves the setting as it was, and says why', async () => {
        const d = deps([], true);
        const res = await driveSettings({ settings: { startAtLogin: false } }, d);
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: string }).error).toContain('read-only home');
        expect(d.stateDb.getSettings().startAtLogin).toBe(true);
        d.stateDb.close();
    });
});

describe('protondrive autostart', () => {
    const { loginCommands } = require('../src/linux/autostart');

    test('starts the daemon and the tray, found beside the binary, in the user install, or system wide', () => {
        const dir = configHome();
        const tray = path.join(dir, 'share/protondrive/proton_drive_tray.py');
        mkdirSync(path.dirname(tray), { recursive: true });
        writeFileSync(tray, '');
        expect(loginCommands(path.join(dir, 'bin/protondrive'), [path.join(dir, 'bin/protondrive'), 'autostart'], '/nowhere')).toEqual([
            [path.join(dir, 'bin/protondrive'), 'daemon'],
            ['python3', tray],
        ]);
    });

    test('from the source tree, the daemon through bun and the tray from linux/tray', () => {
        const repo = path.resolve(__dirname, '..');
        expect(loginCommands('/u/.bun/bin/bun', ['/u/.bun/bin/bun', path.join(repo, 'src/cli/main.ts'), 'autostart'], '/nowhere')).toEqual([
            ['/u/.bun/bin/bun', path.join(repo, 'src/cli/main.ts'), 'daemon'],
            ['python3', path.join(repo, 'linux/tray/proton_drive_tray.py')],
        ]);
    });

    test('without a tray anywhere, only the daemon', () => {
        expect(loginCommands('/nowhere/bin/protondrive', ['/nowhere/bin/protondrive', 'autostart'], '/nowhere')).toEqual([
            ['/nowhere/bin/protondrive', 'daemon'],
        ]);
    });
});
