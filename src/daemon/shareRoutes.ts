import { ShareError, type ShareRole, type ShareService } from './shareService';

// The share routes on the control socket (see ShareService). `path` is the item's path inside My files, as for
// /availability. A ShareError is a refusal in plain words: 400 with its message, which the clients show as is. Nothing
// here logs an error or a body: they can carry addresses and passwords.

const PATH_ERROR = 'path must be a path inside My files';
const MAX_EMAILS = 50;

class BadRequest extends Error {}

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

function pathOf(value: unknown): string {
    if (typeof value !== 'string' || value === '' || value.startsWith('/')) throw new BadRequest(PATH_ERROR);
    return value;
}

function roleOf(value: unknown): ShareRole {
    if (value !== 'viewer' && value !== 'editor') throw new BadRequest('role must be viewer or editor');
    return value;
}

function emailOf(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') throw new BadRequest('email must be an address');
    return value;
}

function emailsOf(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMAILS || !value.every((e) => typeof e === 'string')) {
        throw new BadRequest(`emails must be a list of 1 to ${MAX_EMAILS} addresses`);
    }
    return value as string[];
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        throw new BadRequest('The request body must be JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequest('The request body must be a JSON object');
    return body as Record<string, unknown>;
}

function linkChange(body: Record<string, unknown>, now: number): { password?: string | null; expiresAt?: number | null } {
    const change: { password?: string | null; expiresAt?: number | null } = {};
    if ('password' in body) {
        if (body.password !== null && typeof body.password !== 'string') throw new BadRequest('password must be text or null');
        change.password = body.password;
    }
    if ('expiresAt' in body) {
        const at = body.expiresAt;
        if (at !== null && !(typeof at === 'number' && Number.isInteger(at) && at > now)) {
            throw new BadRequest('expiresAt must be a whole number in the future, or null');
        }
        change.expiresAt = at;
    }
    return change;
}

type Handler = (share: ShareService, req: Request, url: URL) => Promise<unknown>;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
    '/share/info': { GET: (s, _r, url) => s.info(pathOf(url.searchParams.get('path'))) },
    '/share/password': {
        GET: async (s, _r, url) => ({ password: await s.password(pathOf(url.searchParams.get('path'))) }),
    },
    '/share/link': {
        POST: async (s, r) => s.ensureLink(pathOf((await bodyOf(r)).path)),
        DELETE: async (s, r) => s.removeLink(pathOf((await bodyOf(r)).path)),
    },
    '/share/link/settings': {
        POST: async (s, r) => {
            const body = await bodyOf(r);
            const path = pathOf(body.path);
            return s.setLinkSettings(path, linkChange(body, Date.now()));
        },
    },
    '/share/invite': {
        POST: async (s, r) => {
            const body = await bodyOf(r);
            const path = pathOf(body.path);
            return s.invite(path, emailsOf(body.emails), roleOf(body.role));
        },
    },
    '/share/role': {
        POST: async (s, r) => {
            const body = await bodyOf(r);
            const path = pathOf(body.path);
            return s.setRole(path, emailOf(body.email), roleOf(body.role));
        },
    },
    '/share/person': {
        DELETE: async (s, r) => {
            const body = await bodyOf(r);
            const path = pathOf(body.path);
            return s.removePerson(path, emailOf(body.email));
        },
    },
};

export async function shareRoute(req: Request, url: URL, share: ShareService | undefined, signedIn: () => boolean): Promise<Response> {
    if (!share) return bad('Not found', 404);
    const methods = ROUTES[url.pathname];
    if (!methods) return bad('Not found', 404);
    const handler = methods[req.method];
    if (!handler) return bad('Method not allowed', 405);
    if (!signedIn()) return bad('Sign in to share');
    try {
        return Response.json(await handler(share, req, url));
    } catch (e) {
        if (e instanceof BadRequest || e instanceof ShareError) return bad(e.message);
        return bad('Sharing failed', 500);
    }
}
