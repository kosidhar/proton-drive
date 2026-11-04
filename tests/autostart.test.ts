import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSettings } from '../src/daemon/settingsValidation';
import { autostartCommand, autostartEntryPath, desktopEntry, syncLoginEntry } from '../src/linux/autostart';
import { SyncStateDatabase } from '../src/sync/syncStateDb';

// #92: Proton Drive starts at login (the daemon, which brings the drive and the tray), unless the user turns it off,
// in Settings or with the desktop's own controls
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-autostart-'));
    dirs.push(dir);
    return dir;
};
const setup = () => {
    const dir = tempDir();
    const stateDb = new SyncStateDatabase(path.join(dir, 'state.sqlite'));
    const env = { XDG_CONFIG_HOME: path.join(dir, 'cfg'), HOME: dir };
    const file = autostartEntryPath(env);
    const sync = (explicit = false, command = ['/usr/bin/protondrive', 'daemon']) => syncLoginEntry(stateDb, { command, env, explicit });
    return { stateDb, env, file, sync, dir };
};

describe('the login entry', () => {
    test('lives in $XDG_CONFIG_HOME/autostart, or ~/.config/autostart', () => {
        expect(autostartEntryPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' })).toBe('/x/cfg/autostart/proton-drive.desktop');
        expect(autostartEntryPath({ HOME: '/home/u' })).toBe('/home/u/.config/autostart/proton-drive.desktop');
    });

    test('runs the daemon itself, a process that stays: the installed binary, the AppImage, or bun and the script', () => {
        expect(autostartCommand('/usr/bin/protondrive', ['/usr/bin/protondrive', 'daemon'], {})).toEqual(['/usr/bin/protondrive', 'daemon']);
        // An AppImage runs from a mount that changes at every launch: the entry names the AppImage
        expect(autostartCommand('/tmp/.mount_ProtX1/usr/bin/protondrive', ['/tmp/.mount_ProtX1/usr/bin/protondrive', 'daemon'], {
            APPIMAGE: '/home/u/Apps/Proton Drive.AppImage',
        })).toEqual(['/home/u/Apps/Proton Drive.AppImage', 'daemon']);
        expect(autostartCommand('/u/.bun/bin/bun', ['/u/.bun/bin/bun', '/src/cli/main.ts', 'daemon'], {})).toEqual([
            '/u/.bun/bin/bun',
            '/src/cli/main.ts',
            'daemon',
        ]);
        // A compiled bun binary's script is inside it, not a file to run
        expect(autostartCommand('/usr/bin/protondrive', ['/usr/bin/protondrive', '/$bunfs/root/protondrive', 'daemon'], {})).toEqual([
            '/usr/bin/protondrive',
            'daemon',
        ]);
    });

    test('is a desktop entry escaped as the spec says, skipped when its program is gone, and marked as ours', () => {
        const entry = desktopEntry(['/opt/Proton Drive/100%/pro"ton$', 'daemon']);
        expect(entry).toContain('[Desktop Entry]\nType=Application\n');
        // Quoted for the space; ", $ and \ escaped inside the quotes, then each backslash doubled as a string value; % doubled
        expect(entry).toContain('Exec="/opt/Proton Drive/100%%/pro\\\\"ton\\\\$" daemon\n');
        expect(entry).toContain('TryExec=/opt/Proton Drive/100%/pro"ton$\n');
        expect(entry).toContain('X-ProtonDrive-Autostart=true\n');
        expect(desktopEntry(['/usr/bin/protondrive', 'daemon'])).toContain('Exec=/usr/bin/protondrive daemon\n');
    });
});

describe('the login entry follows the setting', () => {
    test('written when on, kept up to date, removed when off', () => {
        const { stateDb, file, sync } = setup();
        expect(sync()).toBe('written');
        expect(readFileSync(file, 'utf8')).toContain('Exec=/usr/bin/protondrive daemon');
        expect(sync(false, ['/opt/protondrive', 'daemon'])).toBe('written');
        expect(readFileSync(file, 'utf8')).toContain('Exec=/opt/protondrive daemon');
        expect(sync(false, ['/opt/protondrive', 'daemon'])).toBe('unchanged');
        stateDb.updateSettings({ startAtLogin: false });
        expect(sync(true)).toBe('removed');
        expect(existsSync(file)).toBe(false);
        stateDb.close();
    });

    test("turned off with the desktop's own controls, or deleted by hand, the setting follows: it is never written back", () => {
        for (const how of ['Hidden=true', 'X-GNOME-Autostart-enabled=false', 'deleted']) {
            const { stateDb, file, sync } = setup();
            sync();
            if (how === 'deleted') rmSync(file);
            else writeFileSync(file, `${readFileSync(file, 'utf8').replace('X-GNOME-Autostart-enabled=true\n', '')}${how}\n`);
            expect(sync()).toBe('turned-off-by-user');
            expect(stateDb.getSettings().startAtLogin).toBe(false);
            if (how !== 'deleted') expect(readFileSync(file, 'utf8')).toContain(how);
            // Turned on again in Settings: written as it should be
            stateDb.updateSettings({ startAtLogin: true });
            expect(sync(true)).toBe('written');
            expect(readFileSync(file, 'utf8')).not.toContain('Hidden=true');
            stateDb.close();
        }
    });

    test("a user's own entry of that name is never touched", () => {
        const { stateDb, file, sync } = setup();
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '[Desktop Entry]\nExec=my-own\n');
        expect(sync()).toBe('not-ours');
        stateDb.updateSettings({ startAtLogin: false });
        expect(sync(true)).toBe('not-ours');
        expect(readFileSync(file, 'utf8')).toBe('[Desktop Entry]\nExec=my-own\n');
        stateDb.close();
    });

    test('with the systemd unit enabled, it starts Proton Drive: no entry, so nothing starts twice', () => {
        const { stateDb, file, sync, env } = setup();
        sync();
        const wants = path.join(env.XDG_CONFIG_HOME, 'systemd/user/default.target.wants');
        mkdirSync(wants, { recursive: true });
        writeFileSync(path.join(wants, 'protondrive.service'), '');
        expect(sync()).toBe('systemd');
        expect(existsSync(file)).toBe(false);
        stateDb.close();
    });

    test('inside Flatpak nothing is written: the session never reads the sandbox', () => {
        const { stateDb, file } = setup();
        const env = { XDG_CONFIG_HOME: path.dirname(path.dirname(file)), FLATPAK_ID: 'ch.proton.drive' };
        expect(syncLoginEntry(stateDb, { command: ['/app/bin/protondrive', 'daemon'], env, explicit: false })).toBe('unsupported');
        expect(existsSync(file)).toBe(false);
        stateDb.close();
    });
});

describe('the startAtLogin setting', () => {
    test('is on unless turned off, and only true or false is accepted', () => {
        const { stateDb } = setup();
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
        const { stateDb } = setup();
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
