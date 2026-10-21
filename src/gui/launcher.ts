import { spawn } from 'node:child_process';

import { openBrowserUrl } from '../sdk/openBrowserUrl';

export function launchDesktopWindow(url: string): void {
    const candidates: Array<{ cmd: string; args: string[] }> = [
        { cmd: 'google-chrome', args: [`--app=${url}`, '--window-size=1080,740'] },
        { cmd: 'chromium-browser', args: [`--app=${url}`, '--window-size=1080,740'] },
        { cmd: 'chromium', args: [`--app=${url}`, '--window-size=1080,740'] },
        { cmd: 'brave-browser', args: [`--app=${url}`, '--window-size=1080,740'] },
    ];

    for (const candidate of candidates) {
        try {
            const which = Bun.which(candidate.cmd);
            if (which) {
                const child = spawn(which, candidate.args, {
                    detached: true,
                    stdio: 'ignore',
                });
                child.on('error', () => {});
                child.unref();
                return;
            }
        } catch {}
    }

    openBrowserUrl(url);
}
