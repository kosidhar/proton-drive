import { spawn } from 'node:child_process';

export type OpenResult = { ok: true } | { ok: false; reason: string };

/**
 * Opens `url` in the system default browser. Only http(s) URLs are opened. Resolves ok once the opener has started, or
 * with the reason it could not (a URL it won't open, or an opener that is missing: no xdg-open on a minimal system).
 * Whether the browser then shows the page is not known. `spawnFn` is for tests, so none ever starts a real opener.
 */
export function openBrowserUrl(rawUrl: string, spawnFn: typeof spawn = spawn): Promise<OpenResult> {
    const url = getAllowedBrowserUrl(rawUrl);
    if (!url) {
        return Promise.resolve({ ok: false, reason: 'not an http(s) link' });
    }

    return new Promise((resolve) => {
        const options = { detached: true, stdio: 'ignore' } as const;
        try {
            const child = spawnFn('xdg-open', [url], options);

            child.once('error', (err) => resolve({ ok: false, reason: err.message }));
            child.once('spawn', () => resolve({ ok: true }));
            child.unref();
        } catch (err) {
            resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
        }
    });
}

function getAllowedBrowserUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            return parsed.href;
        }
    } catch {}
}
