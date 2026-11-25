import { open } from 'node:fs/promises';

import type { DocKind } from '../sync/docNodes';

// A placeholder is a few hundred bytes; anything bigger is not one.
const MAX_PLACEHOLDER_BYTES = 64 * 1024;

// Proton's ids are base64url text; anything that would need escaping in the link is not one
const ID_CHARS = /^[A-Za-z0-9_=.~-]+$/;

const NOT_A_DOC_LINK = "This isn't a Proton Drive document link";

/**
 * The link a Docs or Sheets placeholder holds, or null unless it is a real Proton document link: https, docs.proton.me
 * with no port or credentials, the /doc path, a doc or sheet type, and a volume and link id. The file is a plain file
 * anyone could have edited, so nothing else is ever handed to the browser.
 */
export function parseDocLink(text: string): { url: string; kind: DocKind } | null {
    let raw: unknown;
    try {
        raw = (JSON.parse(text) as { url?: unknown } | null)?.url;
    } catch {
        return null;
    }
    if (typeof raw !== 'string') {
        return null;
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (
        url.protocol !== 'https:' ||
        url.hostname !== 'docs.proton.me' ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/doc'
    ) {
        return null;
    }
    // Each part once: a link that names one twice is not one the app made
    for (const key of ['type', 'volumeId', 'linkId']) {
        if (url.searchParams.getAll(key).length > 1) {
            return null;
        }
    }
    const type = url.searchParams.get('type');
    const volumeId = url.searchParams.get('volumeId');
    const linkId = url.searchParams.get('linkId');
    if ((type !== 'doc' && type !== 'sheet') || !volumeId || !linkId || !ID_CHARS.test(volumeId) || !ID_CHARS.test(linkId)) {
        return null;
    }
    // Rebuilt from the checked parts in the format docUrl makes, so nothing else in the file (a redirect) reaches the browser
    return { url: `https://docs.proton.me/doc?type=${type}&mode=open&volumeId=${volumeId}&linkId=${linkId}`, kind: type };
}

/** Opens the placeholder's document in the browser. Returns the exit code: 0 opened, 1 refused. */
export async function openDoc(
    file: string,
    deps: { open: (url: string) => void; notify: (title: string, body: string) => void },
): Promise<number> {
    let link: { url: string; kind: DocKind } | null = null;
    try {
        // One descriptor for the check and the read, so the file can't change between them
        const handle = await open(file, 'r');
        try {
            if ((await handle.stat()).isFile()) {
                const buffer = Buffer.alloc(MAX_PLACEHOLDER_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead <= MAX_PLACEHOLDER_BYTES) {
                    link = parseDocLink(buffer.toString('utf8', 0, bytesRead));
                }
            }
        } finally {
            await handle.close();
        }
    } catch {
        // Missing or unreadable: refused like any other file that is not a placeholder.
    }
    if (!link) {
        deps.notify('Proton Drive', NOT_A_DOC_LINK);
        return 1;
    }
    deps.open(link.url);
    return 0;
}
