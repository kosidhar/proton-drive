// The daemon API only serves local, non-browser clients (GUI, tray, file manager extensions, CLI), all of which call
// http://127.0.0.1:<port>. Requiring a loopback Host blocks DNS rebinding, and refusing browser-only headers blocks
// cross-site requests that web pages can send without a CORS preflight.
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

export function isTrustedLocalRequest(req: Request, port: number): boolean {
    const host = req.headers.get('host')?.toLowerCase();
    if (!host || !LOOPBACK_HOSTNAMES.some((name) => host === `${name}:${port}`)) {
        return false;
    }
    return !req.headers.has('origin') && !req.headers.has('sec-fetch-site');
}
