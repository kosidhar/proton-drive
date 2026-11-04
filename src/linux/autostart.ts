import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { SyncStateDatabase } from '../sync/syncStateDb';

// Starting Proton Drive at login (#92): an XDG autostart entry that runs the daemon, which mounts the drive and starts
// the tray. While the startAtLogin setting is on the daemon keeps the entry in place, naming the binary it runs from; it
// removes it when the setting is turned off, and only ever touches an entry it wrote (marked X-ProtonDrive-Autostart).
// Turned off with the desktop's own controls (Hidden, X-GNOME-Autostart-enabled=false), or deleted by hand, the setting
// follows instead of the entry being written back.

const ENTRY_NAME = 'proton-drive.desktop';
const OURS = 'X-ProtonDrive-Autostart=true';
// Set once the daemon has written the entry: gone after that, the user deleted it
const WRITTEN = 'autostartWritten';
const SYSTEMD_UNITS = ['protondrive.service', 'proton-drive-ubuntu.service'];

type Env = { XDG_CONFIG_HOME?: string; HOME?: string; APPIMAGE?: string; FLATPAK_ID?: string; [name: string]: string | undefined };

function configHome(env: Env): string {
    return env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config');
}

export function autostartEntryPath(env: Env = process.env): string {
    return path.join(configHome(env), 'autostart', ENTRY_NAME);
}

// The daemon as it starts at login, from how this process was started: the AppImage (it runs from a mount that changes
// at every launch), the installed binary, or bun and the script from the source tree. The daemon itself, not a launcher
// that exits: an AppImage unmounts once its process is gone
export function autostartCommand(execPath: string = process.execPath, argv: string[] = process.argv, env: Env = process.env): string[] {
    if (env.APPIMAGE) {
        return [env.APPIMAGE, 'daemon'];
    }
    const runtime = path.basename(execPath);
    if ((runtime === 'bun' || runtime === 'node') && argv[1] && !argv[1].startsWith('/$bunfs/')) {
        return [execPath, argv[1], 'daemon'];
    }
    return [execPath, 'daemon'];
}

// An Exec argument as the Desktop Entry spec reads it: quoted when it holds a reserved character, with ", `, $ and \
// escaped inside the quotes; then, the value being a string, each backslash doubled; and % doubled (a field code)
function execArg(arg: string): string {
    const quoted = /[\s"'\\><~|&;$*?#()`]/.test(arg) ? `"${arg.replace(/(["`$\\])/g, '\\$1')}"` : arg;
    return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

export function desktopEntry(command: string[]): string {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Proton Drive',
        'Comment=Sync your Proton Drive folder and mount the drive',
        `Exec=${command.map(execArg).join(' ')}`,
        // Skipped quietly once that program is gone (Proton Drive uninstalled by a package manager)
        `TryExec=${command[0]}`,
        'Icon=ch.proton.drive',
        'Terminal=false',
        'NoDisplay=true',
        'X-GNOME-Autostart-enabled=true',
        OURS,
        '',
    ].join('\n');
}

function readEntry(file: string): string | null {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

const disabledInEntry = (text: string) =>
    text.split('\n').some((line) => line.trim() === 'Hidden=true' || line.trim() === 'X-GNOME-Autostart-enabled=false');

// The user's own systemd unit for Proton Drive, enabled: it starts the daemon, and an entry would start a second one
function systemdEnabled(env: Env): boolean {
    return SYSTEMD_UNITS.some((unit) => existsSync(path.join(configHome(env), 'systemd/user/default.target.wants', unit)));
}

export type LoginEntryResult = 'written' | 'unchanged' | 'removed' | 'turned-off-by-user' | 'not-ours' | 'systemd' | 'unsupported';

// Brings the entry in line with the setting. `explicit`: the user just changed the setting in the app, which wins over
// what the entry says (turned on again, it is written as it should be)
export function syncLoginEntry(
    stateDb: Pick<SyncStateDatabase, 'getSettings' | 'updateSettings' | 'getMeta' | 'setMeta' | 'deleteMeta'>,
    opts: { command?: string[]; env?: Env; explicit?: boolean } = {},
): LoginEntryResult {
    const env = opts.env ?? process.env;
    if (env.FLATPAK_ID) {
        return 'unsupported'; // the session reads the host's autostart folder, not the sandbox's
    }
    const file = autostartEntryPath(env);
    const text = readEntry(file);
    if (text !== null && !text.split('\n').includes(OURS)) {
        return 'not-ours';
    }
    const enabled = stateDb.getSettings().startAtLogin;
    if (!enabled || systemdEnabled(env)) {
        if (text !== null) unlinkSync(file);
        stateDb.deleteMeta(WRITTEN);
        return enabled ? 'systemd' : text !== null ? 'removed' : 'unchanged';
    }
    if (!opts.explicit && ((text !== null && disabledInEntry(text)) || (text === null && stateDb.getMeta(WRITTEN) !== null))) {
        stateDb.updateSettings({ startAtLogin: false });
        stateDb.deleteMeta(WRITTEN);
        return 'turned-off-by-user';
    }
    const entry = desktopEntry(opts.command ?? autostartCommand());
    if (text === entry) {
        return 'unchanged';
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, entry, { mode: 0o644 });
    renameSync(tmp, file);
    stateDb.setMeta(WRITTEN, '1');
    return 'written';
}
