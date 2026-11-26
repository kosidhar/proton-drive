// What the unauthenticated TCP API (127.0.0.1) no longer does: any local user can call it, so the routes that sign the
// user in or out, overwrite files, change settings or create cloud folders are reachable only through the user-only
// control socket (controlServer.ts). The Proton Drive app calls them there. The TCP API keeps what reads (status,
// conflicts, activity, remote listings, file status) and /api/sync, /api/pause and /api/quit.

export const REFUSED_ON_TCP: ReadonlyMap<string, string> = new Map([
    ['/api/auth/login', 'Sign in and out from the Proton Drive app'],
    ['/api/auth/logout', 'Sign in and out from the Proton Drive app'],
    ['/api/conflicts/resolve', 'Resolve conflicts from the Proton Drive app'],
    ['/api/settings', 'Change settings from the Proton Drive app'],
    ['/api/remote/mkdir', 'Create folders from the Proton Drive app'],
    // Accepting, declining and leaving change what the user shares: the app asks on the control socket
    ['/share/with-me/accept', 'Manage what is shared with you from the Proton Drive app'],
    ['/share/with-me/decline', 'Manage what is shared with you from the Proton Drive app'],
    ['/share/with-me/leave', 'Manage what is shared with you from the Proton Drive app'],
    ['/share/with-me/open-url', 'Manage what is shared with you from the Proton Drive app'],
]);

// 403 { error, code: 'EACCES' } for a POST to a route that moved to the control socket, null for anything else
export function refuseOnTcp(req: Request): Response | null {
    if (req.method !== 'POST') return null;
    const error = REFUSED_ON_TCP.get(new URL(req.url).pathname);
    return error === undefined ? null : Response.json({ error, code: 'EACCES' }, { status: 403 });
}
