import { MemberRole, type ProtonDriveClient } from '@protontech/drive-sdk';

export type ShareRole = 'viewer' | 'editor';

export interface ShareInfo {
    link: { url: string; hasPassword: boolean; expiresAt: number | null; role: ShareRole } | null;
    people: Array<{ email: string; role: ShareRole; state: 'member' | 'invited' | 'invited-not-proton' }>;
}

// The message is shown to the user as is
export class ShareError extends Error {}

export interface ShareService {
    info(path: string): Promise<ShareInfo>;
    password(path: string): Promise<string | null>;
    ensureLink(path: string): Promise<{ url: string; created: boolean }>;
    setLinkSettings(path: string, change: { password?: string | null; expiresAt?: number | null }): Promise<ShareInfo>;
    removeLink(path: string): Promise<ShareInfo>;
    invite(path: string, emails: string[], role: ShareRole): Promise<ShareInfo>;
    setRole(path: string, email: string, role: ShareRole): Promise<ShareInfo>;
    removePerson(path: string, email: string): Promise<ShareInfo>;
}

export interface ShareServiceDeps {
    sdk: Pick<ProtonDriveClient, 'getSharingInfo' | 'shareNode' | 'unshareNode'>;
    nodeFor(path: string): { uid: string; name: string } | { refused: string };
    logActivity(entry: { action: 'share'; localRelPath: string; details: string }): void;
    now(): number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sdkRole = (role: ShareRole): MemberRole => (role === 'editor' ? MemberRole.Editor : MemberRole.Viewer);

const toRole = (sdkRole: string): ShareRole => (sdkRole === 'editor' || sdkRole === 'admin' ? 'editor' : 'viewer');

function isOffline(e: unknown): boolean {
    const err = e as { name?: string; message?: string; code?: string } | null;
    const text = `${err?.name ?? ''} ${err?.code ?? ''} ${err?.message ?? ''}`;
    return (
        (e instanceof TypeError && /fetch failed|network/i.test(text)) ||
        /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|NetworkError|offline/i.test(text)
    );
}

function plainError(e: unknown): ShareError {
    if (e instanceof ShareError) return e;
    if (isOffline(e)) return new ShareError('Proton Drive is offline: try again when you are connected');
    const message = e instanceof Error ? e.message : String(e);
    return new ShareError(`Proton Drive refused: ${message}`);
}

export function createShareService(deps: ShareServiceDeps): ShareService {
    const { sdk } = deps;

    const resolve = (path: string) => {
        const node = deps.nodeFor(path);
        if ('refused' in node) throw new ShareError(node.refused);
        return node;
    };

    // Runs one operation on one item: a refusal or an SDK failure becomes a ShareError, and nothing is logged for it
    async function run<T>(path: string, op: (node: { uid: string; name: string }) => Promise<T>): Promise<T> {
        const node = resolve(path);
        try {
            return await op(node);
        } catch (e) {
            throw plainError(e);
        }
    }

    const log = (path: string, details: string) => deps.logActivity({ action: 'share', localRelPath: path, details });

    function toInfo(result: Awaited<ReturnType<typeof sdk.getSharingInfo>>): ShareInfo {
        if (!result) return { link: null, people: [] };
        const u = result.urlAccess;
        return {
            link: u
                ? {
                      url: u.url,
                      hasPassword: !!u.customPassword,
                      expiresAt: u.expirationTime ? u.expirationTime.getTime() : null,
                      role: toRole(u.role),
                  }
                : null,
            people: [
                ...result.members.map((m) => ({ email: m.inviteeEmail, role: toRole(m.role), state: 'member' as const })),
                ...result.protonInvitations.map((m) => ({ email: m.inviteeEmail, role: toRole(m.role), state: 'invited' as const })),
                ...result.nonProtonInvitations.map((m) => ({
                    email: m.inviteeEmail,
                    role: toRole(m.role),
                    state: 'invited-not-proton' as const,
                })),
            ],
        };
    }

    const infoOf = (uid: string) => sdk.getSharingInfo(uid).then(toInfo);

    return {
        info: (path) => run(path, (n) => infoOf(n.uid)),

        password: (path) =>
            run(path, async (n) => (await sdk.getSharingInfo(n.uid))?.urlAccess?.customPassword ?? null),

        async ensureLink(path) {
            return run(path, async (n) => {
                const existing = (await sdk.getSharingInfo(n.uid))?.urlAccess;
                if (existing) return { url: existing.url, created: false };
                const made = await sdk.shareNode(n.uid, { urlAccess: { role: MemberRole.Viewer } });
                if (!made.urlAccess) throw new Error('no link was made');
                log(path, `Shared ${n.name} with a link`);
                return { url: made.urlAccess.url, created: true };
            });
        },

        async setLinkSettings(path, change) {
            return run(path, async (n) => {
                const current = (await sdk.getSharingInfo(n.uid))?.urlAccess;
                if (!current) throw new ShareError('Turn the link on first');
                // The SDK's updateSharedLink REPLACES the link's settings with what it is given: a customPassword or
                // expiration left out is cleared (it re-encrypts with only the generated password, and sends no expiry).
                // So an unchanged value has to be sent again explicitly, from the link as it is now; null clears.
                const customPassword = change.password === undefined ? current.customPassword : (change.password ?? undefined);
                const expiration =
                    change.expiresAt === undefined ? current.expirationTime : change.expiresAt === null ? undefined : new Date(change.expiresAt);
                const result = await sdk.shareNode(n.uid, { urlAccess: { role: current.role, customPassword, expiration } });
                log(path, `Changed the link to ${n.name}`);
                return toInfo(result);
            });
        },

        async removeLink(path) {
            return run(path, async (n) => {
                await sdk.unshareNode(n.uid, { urlAccess: 'remove' });
                log(path, `Stopped sharing the link to ${n.name}`);
                return infoOf(n.uid);
            });
        },

        async invite(path, emails, role) {
            const bad = emails.find((e) => !EMAIL.test(e));
            if (bad !== undefined) throw new ShareError(`Not a valid email address: ${bad}`);
            return run(path, async (n) => {
                const result = await sdk.shareNode(n.uid, { users: emails.map((email) => ({ email, role: sdkRole(role) })) });
                log(path, `Invited ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to ${n.name}`);
                return toInfo(result);
            });
        },

        async setRole(path, email, role) {
            return run(path, async (n) => {
                const result = await sdk.shareNode(n.uid, { users: [{ email, role: sdkRole(role) }] });
                log(path, `Changed someone's access to ${n.name}`);
                return toInfo(result);
            });
        },

        async removePerson(path, email) {
            return run(path, async (n) => {
                await sdk.unshareNode(n.uid, { users: [email] });
                log(path, `Removed someone's access to ${n.name}`);
                return infoOf(n.uid);
            });
        },
    };
}
