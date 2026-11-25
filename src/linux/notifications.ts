import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

export function ensureSystemTrayIndicator(): void {
    try {
        const candidates = [
            path.join(os.homedir(), '.local/share/protondrive/proton_drive_tray.py'),
            '/usr/share/protondrive/proton_drive_tray.py',
            path.resolve(process.cwd(), 'linux/tray/proton_drive_tray.py'),
            path.resolve(path.dirname(process.execPath), '../linux/tray/proton_drive_tray.py'),
            path.resolve(path.dirname(process.execPath), '../share/protondrive/proton_drive_tray.py'),
        ];
        const script = candidates.find((p) => existsSync(p));
        if (!script) {
            return;
        }
        const child = spawn('python3', [script], {
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                DISPLAY: process.env.DISPLAY || ':0',
            },
        });
        child.on('error', () => {});
        child.unref();
    } catch {
        // Ignore on headless systems
    }
}

export function sendDesktopNotification(options: {
    title: string;
    body: string;
    urgency?: NotificationUrgency;
    icon?: string;
    enabled?: boolean;
}): void {
    if (options.enabled === false) {
        return;
    }

    const urgency = options.urgency ?? 'normal';
    const icon = options.icon ?? 'io.github.kosidhar.ProtonDrive';

    try {
        const child = spawn(
            'notify-send',
            ['--app-name=Proton Drive', `--urgency=${urgency}`, `--icon=${icon}`, options.title, options.body],
            {
                detached: true,
                stdio: 'ignore',
            },
        );
        child.on('error', () => {});
        child.unref();
    } catch {
        // Ignore if notify-send or DBus session is unavailable (e.g., headless server)
    }
}

export interface NotificationAction {
    key: string;
    label: string;
}

// How long a notification with buttons is waited on before it is taken as ignored
const ACTION_WAIT_MS = 30 * 60_000;
// A notify-send that fails this fast didn't show anything: too old for --action (libnotify before 0.7.10)
const UNSUPPORTED_WITHIN_MS = 2_000;

// A desktop notification with buttons. Resolves the key of the button the user chose; null when they dismissed it,
// ignored it for 30 minutes, notifications are off, or notify-send is missing; 'unsupported' when notify-send can't
// show buttons, so the caller can say the same thing another way.
export async function sendActionNotification(options: {
    title: string;
    body: string;
    actions: NotificationAction[];
    urgency?: NotificationUrgency;
    icon?: string;
    enabled?: boolean;
    command?: string; // for tests
}): Promise<string | 'unsupported' | null> {
    if (options.enabled === false) {
        return null;
    }
    const argv = [
        options.command ?? 'notify-send',
        '--app-name=Proton Drive',
        `--urgency=${options.urgency ?? 'normal'}`,
        `--icon=${options.icon ?? 'io.github.kosidhar.ProtonDrive'}`,
        '--wait',
        ...options.actions.map((action) => `--action=${action.key}=${action.label}`),
        options.title,
        options.body,
    ];
    const started = Date.now();
    try {
        const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: ACTION_WAIT_MS });
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        if (code !== 0) {
            return Date.now() - started < UNSUPPORTED_WITHIN_MS && out.trim() === '' ? 'unsupported' : null;
        }
        const chosen = out.trim().split('\n').pop() ?? '';
        return options.actions.some((action) => action.key === chosen) ? chosen : null;
    } catch {
        return null; // notify-send missing, or no session bus
    }
}

export async function getSystemdServiceStatus(serviceName = 'protondrive.service'): Promise<{
    installed: boolean;
    enabled: boolean;
    active: boolean;
}> {
    try {
        const isEnabledProc = Bun.spawn(['systemctl', '--user', 'is-enabled', serviceName], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const enabledOut = (await new Response(isEnabledProc.stdout).text()).trim();
        const enabledCode = await isEnabledProc.exited;

        const isActiveProc = Bun.spawn(['systemctl', '--user', 'is-active', serviceName], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const activeOut = (await new Response(isActiveProc.stdout).text()).trim();
        await isActiveProc.exited;

        return {
            installed: enabledCode === 0 || enabledOut === 'disabled' || enabledOut === 'enabled',
            enabled: enabledOut === 'enabled',
            active: activeOut === 'active',
        };
    } catch {
        return { installed: false, enabled: false, active: false };
    }
}
