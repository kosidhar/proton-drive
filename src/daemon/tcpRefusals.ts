// What the unauthenticated TCP API (127.0.0.1) no longer does: any local user can call it, so the routes that sign the
// user in or out, or overwrite files, are reachable only through the user-only control socket (controlServer.ts). The
// Proton Drive app calls them there.

const REFUSED: ReadonlyMap<string, string> = new Map([
    ['/api/auth/login', 'Sign in and out from the Proton Drive app'],
    ['/api/auth/logout', 'Sign in and out from the Proton Drive app'],
    ['/api/conflicts/resolve', 'Resolve conflicts from the Proton Drive app'],
]);

// 403 { error, code: 'EACCES' } for a POST to a route that moved to the control socket, null for anything else
export function refuseOnTcp(req: Request): Response | null {
    if (req.method !== 'POST') return null;
    const error = REFUSED.get(new URL(req.url).pathname);
    return error === undefined ? null : Response.json({ error, code: 'EACCES' }, { status: 403 });
}
