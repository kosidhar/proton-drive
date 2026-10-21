import { spawn } from 'node:child_process';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

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
    const icon = options.icon ?? 'ch.proton.drive';

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

export async function getSystemdServiceStatus(serviceName = 'proton-drive-ubuntu.service'): Promise<{
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
