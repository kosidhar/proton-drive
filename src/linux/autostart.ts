import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Starting Proton Drive at login (#92): an XDG autostart entry that runs `protondrive autostart`, which starts the
// daemon (and with it the drive) and the tray. The daemon writes it while the startAtLogin setting is on and removes it
// when it is off, and only ever touches an entry it wrote (marked X-ProtonDrive-Autostart).

const ENTRY_NAME = 'proton-drive.desktop';
const OURS = 'X-ProtonDrive-Autostart=true';

type Env = { XDG_CONFIG_HOME?: string; HOME?: string; [name: string]: string | undefined };

export function autostartEntryPath(env: Env = process.env): string {
    const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config');
    return path.join(configHome, 'autostart', ENTRY_NAME);
}

// The command that starts Proton Drive at login, from how this process was started: the installed binary, or bun and
// the script when run from the source tree
export function autostartCommand(execPath: string = process.execPath, argv: string[] = process.argv): string[] {
    const runtime = path.basename(execPath);
    if ((runtime === 'bun' || runtime === 'node') && argv[1]) {
        return [execPath, argv[1], 'autostart'];
    }
    return [execPath, 'autostart'];
}

// A desktop entry's Exec argument, quoted as the spec asks when it holds anything but plain characters
function execArg(arg: string): string {
    return /^[\w./:=+-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function desktopEntry(command: string[]): string {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Proton Drive',
        'Comment=Sync your Proton Drive folder and mount the drive',
        `Exec=${command.map(execArg).join(' ')}`,
        'Icon=ch.proton.drive',
        'Terminal=false',
        'NoDisplay=true',
        'X-GNOME-Autostart-enabled=true',
        OURS,
        '',
    ].join('\n');
}

function isOurs(file: string): boolean {
    try {
        return readFileSync(file, 'utf8').split('\n').includes(OURS);
    } catch {
        return false;
    }
}

// Puts the entry in place (or brings it up to date) when on, and removes it when off: never one it didn't write
export function applyStartAtLogin(enabled: boolean, command: string[] = autostartCommand(), env: Env = process.env): void {
    const file = autostartEntryPath(env);
    const there = existsSync(file);
    if (there && !isOurs(file)) {
        return;
    }
    if (!enabled) {
        if (there) unlinkSync(file);
        return;
    }
    const entry = desktopEntry(command);
    if (there && readFileSync(file, 'utf8') === entry) {
        return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, entry, { mode: 0o644 });
    renameSync(tmp, file);
}

// What `protondrive autostart` starts at login: the daemon (which refuses to run twice) and the tray (which does too),
// the tray script found beside the binary, in the user install, system wide, or in the source tree
export function loginCommands(execPath: string, argv: string[], home: string = process.env.HOME ?? ''): string[][] {
    const self = autostartCommand(execPath, argv).slice(0, -1);
    const binDir = path.dirname(execPath);
    const scriptDir = argv[1] ? path.dirname(argv[1]) : binDir;
    const trays = [
        path.join(binDir, '../share/protondrive/proton_drive_tray.py'),
        path.join(binDir, '../linux/tray/proton_drive_tray.py'),
        path.join(scriptDir, '../../linux/tray/proton_drive_tray.py'),
        path.join(home, '.local/share/protondrive/proton_drive_tray.py'),
        '/usr/share/protondrive/proton_drive_tray.py',
    ].map((p) => path.resolve(p));
    const tray = trays.find((p) => existsSync(p));
    return tray ? [[...self, 'daemon'], ['python3', tray]] : [[...self, 'daemon']];
}
