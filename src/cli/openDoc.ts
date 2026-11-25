import { readFile, stat } from 'node:fs/promises';

import type { DocKind } from '../sync/docNodes';

// A placeholder is a few hundred bytes; anything bigger is not one.
const MAX_PLACEHOLDER_BYTES = 64 * 1024;

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
    const type = url.searchParams.get('type');
    if (type !== 'doc' && type !== 'sheet') {
        return null;
    }
    if (!url.searchParams.get('volumeId') || !url.searchParams.get('linkId')) {
        return null;
    }
    return { url: url.href, kind: type };
}

/** Opens the placeholder's document in the browser. Returns the exit code: 0 opened, 1 refused. */
export async function openDoc(
    file: string,
    deps: { open: (url: string) => void; notify: (title: string, body: string) => void },
): Promise<number> {
    let link: { url: string; kind: DocKind } | null = null;
    try {
        const info = await stat(file);
        if (info.isFile() && info.size <= MAX_PLACEHOLDER_BYTES) {
            link = parseDocLink(await readFile(file, 'utf8'));
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
