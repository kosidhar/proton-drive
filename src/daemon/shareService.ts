import {
    ConnectionError,
    MemberRole,
    RateLimitedError,
    type MaybeMissingNode,
    type ProtonDriveClient,
    type ShareResult,
    type URLAccess,
} from '@protontech/drive-sdk';

export type ShareRole = 'viewer' | 'editor';

export interface ShareInfo {
    link: { url: string; hasPassword: boolean; expiresAt: number | null; role: ShareRole } | null;
    people: Array<{ email: string; role: ShareRole; state: 'member' | 'invited' | 'invited-not-proton' }>;
}

// The message is shown to the user as is
export class ShareError extends Error {}

// The list was cancelled (the app gave up on it): there is no one left to read the message
export class ListCancelled extends ShareError {
    constructor() {
        super('Cancelled');
    }
}

export type SharedPlace = 'my-files' | 'hidden' | 'elsewhere';

export interface SharedItem {
    // The node uid the server listed: stopping sharing names it, so it acts on this item and not on whatever is at its path later
    uid: string;
    name: string;
    relPath: string | null;
    where: SharedPlace;
    link: ShareInfo['link'];
    people: number;
    unreadable?: string;
}

// How many items' sharing is read at once
export const LIST_CONCURRENCY = 4;

export interface ShareService {
    list(signal?: AbortSignal): Promise<SharedItem[]>;
    info(path: string): Promise<ShareInfo>;
    password(path: string): Promise<string | null>;
    ensureLink(path: string): Promise<{ url: string; created: boolean }>;
    setLinkSettings(path: string, change: { password?: string | null; expiresAt?: number | null }): Promise<ShareInfo>;
    removeLink(path: string): Promise<ShareInfo>;
    invite(path: string, emails: string[], role: ShareRole): Promise<ShareInfo>;
    setRole(path: string, email: string, role: ShareRole): Promise<ShareInfo>;
    removePerson(path: string, email: string): Promise<ShareInfo>;
    stopSharing(path: string, uid: string): Promise<ShareInfo>;
}

export interface ShareServiceDeps {
    sdk: Pick<ProtonDriveClient, 'getSharingInfo' | 'shareNode' | 'unshareNode' | 'iterateSharedNodeUids' | 'iterateNodes'>;
    nodeFor(path: string): { uid: string; name: string } | { refused: string };
    // The remote index's path for a node, and whether it is hidden from this computer; null when the index doesn't have it
    placeOf(uid: string): { relPath: string; hidden: boolean } | null;
    logActivity(entry: { action: 'share'; localRelPath: string; details: string }): void;
    now(): number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sdkRole = (role: ShareRole): MemberRole => (role === 'editor' ? MemberRole.Editor : MemberRole.Viewer);

const toRole = (sdkRole: string): ShareRole => (sdkRole === 'editor' || sdkRole === 'admin' ? 'editor' : 'viewer');

// A link made by an older Proton Drive has no generated password: the SDK puts its whole password, the user's own, after
// the '#' of the URL and leaves customPassword empty (cryptoService.ts, decryptShareUrlPassword: flags Legacy and
// CustomPassword). The SDK tells such a link by a fragment that isn't the 12 characters it generates
// (sharingManagement.ts, updateSharedLink: `generatedPassword.length !== PUBLIC_LINK_GENERATED_PASSWORD_LENGTH`), and
// so does this, and by a second '#'. An older link whose own password is exactly 12 characters can't be told apart.
const GENERATED_PASSWORD_LENGTH = 12;
function isOlderLink(url: string): boolean {
    const parts = url.split('#');
    return parts.length !== 2 || parts[1].length !== GENERATED_PASSWORD_LENGTH;
}

// The URL as it may be shown: an older link's without the password after its '#'
const shownUrl = (url: string) => (isOlderLink(url) ? url.split('#')[0] : url);

// Whether the error, or one wrapped in it, is one that `is` matches. The SDK wraps the failures it met while loading
// several things in one ProtonDriveError ('Some items could not be loaded'), with an ARRAY of them as its cause
// (batchLoading.ts loadRest, nodesAccess.ts, nodes/apiService.ts), and the node loader's BatchLoading wraps such an error
// from the API again. The depth cap ends a chain that loops back on itself.
const MAX_CAUSE_DEPTH = 4;
function inChain(e: unknown, is: (e: unknown) => boolean, depth = 0): boolean {
    if (e === null || e === undefined || depth > MAX_CAUSE_DEPTH) return false;
    if (is(e)) return true;
    const cause = (e as { cause?: unknown }).cause;
    const inner = [...(Array.isArray(cause) ? cause : [cause]), ...(e instanceof AggregateError ? e.errors : [])];
    return inner.some((c) => inChain(c, is, depth + 1));
}

// The network, not Proton Drive: the SDK's ConnectionError, a request that timed out (ky's TimeoutError, once the SDK's
// retries are spent) or found no network (OfflineError), or a fetch that couldn't connect. Not remoteErrors.isTransient,
// which counts every ServerError, refusals answered with an API code among them: those read as refused, not offline.
const OFFLINE_ERRORS = new Set(['ConnectionError', 'TimeoutError', 'OfflineError', 'NetworkError']);
function isNetworkFailure(e: unknown): boolean {
    const err = e as { name?: string; message?: string; code?: string } | null;
    if (e instanceof ConnectionError || OFFLINE_ERRORS.has(err?.name ?? '')) return true;
    const text = `${err?.name ?? ''} ${err?.code ?? ''} ${err?.message ?? ''}`;
    return (
        (e instanceof TypeError && /fetch failed|network/i.test(text)) ||
        /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|NetworkError|offline/i.test(text)
    );
}
const isOffline = (e: unknown) => inChain(e, isNetworkFailure);

// The SDK's own limits for the whole account: past too many 429s, or server errors, in a row it refuses every request
// for a while (internal/apiService/apiService.ts, fetch) with a RateLimitedError, or a plain ServerError "Too many
// server errors…". Only a plain ServerError: its subclasses carry the server's own message, which may start the same way
// for another reason. (The SDK's messages are English: the daemon sets no locale for them.)
function isSdkLimit(e: unknown): boolean {
    const err = e as { name?: string; message?: string } | null;
    if (e instanceof RateLimitedError || err?.name === 'RateLimitedError') return true;
    return err?.name === 'ServerError' && /^Too many/.test(err.message ?? '');
}
const isBusy = (e: unknown) => inChain(e, isSdkLimit);

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

    // One operation at a time on each item (by its node): an operation reads the item's sharing and then writes it whole
    // (setLinkSettings sends every setting of the link), so two at once would undo one another's change. Different items
    // run side by side, and an operation that fails lets the next one go.
    const queues = new Map<string, Promise<void>>();
    async function oneAtATime<T>(uid: string, op: () => Promise<T>): Promise<T> {
        const result = (queues.get(uid) ?? Promise.resolve()).then(op);
        const settled = result.then(
            () => undefined,
            () => undefined,
        );
        queues.set(uid, settled);
        try {
            return await result;
        } finally {
            if (queues.get(uid) === settled) queues.delete(uid);
        }
    }

    // Runs one operation on one item: a refusal or an SDK failure becomes a ShareError, and nothing is logged for it
    async function run<T>(path: string, op: (node: { uid: string; name: string }) => Promise<T>): Promise<T> {
        const node = resolve(path);
        return oneAtATime(node.uid, async () => {
            try {
                return await op(node);
            } catch (e) {
                throw plainError(e);
            }
        });
    }

    // Everyone on the item's list: its members, and the people invited
    const everyone = (r: ShareResult | undefined) => (r ? [...r.members, ...r.protonInvitations, ...r.nonProtonInvitations] : []);

    // The address as the item's list has it: acting on someone not on it would send a new invitation (or do nothing)
    async function listed(uid: string, email: string): Promise<string> {
        const found = everyone(await sdk.getSharingInfo(uid)).find((m) => m.inviteeEmail.toLowerCase() === email.toLowerCase());
        if (!found) throw new ShareError("That person doesn't have access to this item");
        return found.inviteeEmail;
    }

    // Best effort: the change is made by then, and a history entry that can't be written must not report it as failed
    const log = (path: string, details: string) => {
        try {
            deps.logActivity({ action: 'share', localRelPath: path, details });
        } catch {
            // The entry is lost; the change stands
        }
    };

    function toInfo(result: ShareResult | undefined): ShareInfo {
        if (!result) return { link: null, people: [] };
        const u = result.urlAccess;
        return {
            link: u
                ? {
                      url: shownUrl(u.url),
                      hasPassword: !!u.customPassword || isOlderLink(u.url),
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

    // Copy Link hands out a link only as it works, and never renews or rewrites one: that is for the Share window
    function refuseUnusable(link: URLAccess, name: string): void {
        if (isOlderLink(link.url)) {
            throw new ShareError('This link was made with an older Proton Drive: open it on drive.proton.me to copy it');
        }
        if (link.expirationTime && link.expirationTime.getTime() <= deps.now()) {
            throw new ShareError(`The link to ${name} has expired: set a new expiry in Share… to use it again`);
        }
    }

    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

    // What fails the whole list rather than one item: every other item would fail the same way
    const failsTheList = (e: unknown) => isOffline(e) || isBusy(e);

    // An item Proton Drive can't name: the name its path in My files ends with, when the remote index has it
    function indexedName(uid: string): string {
        let relPath = '';
        try {
            relPath = deps.placeOf(uid)?.relPath ?? '';
        } catch {
            // The index can't be read: the item stays unnamed
        }
        return relPath.split('/').pop() || 'An item';
    }

    return {
        // Everything the user has shared, as Proton Drive has it now: the uids come from the server (iterateSharedNodeUids),
        // not the SDK's cache, which may not know of a share made elsewhere. Nothing is logged: it only reads.
        // Once `signal` is aborted (the app gave up on the list), nothing more is asked of Proton Drive: the SDK's listing
        // and loading stop where they can, a sharing read under way finishes and is dropped, and the list is ListCancelled.
        async list(signal) {
            const stopIfCancelled = () => {
                if (signal?.aborted) throw new ListCancelled();
            };
            try {
                stopIfCancelled();
                const uids: string[] = [];
                // Each step may ask the server for the next page
                for await (const uid of sdk.iterateSharedNodeUids(signal)) {
                    uids.push(uid);
                    stopIfCancelled();
                }
                const nodes: MaybeMissingNode[] = [];
                let notLoaded: string[] = [];
                stopIfCancelled();
                try {
                    for await (const n of sdk.iterateNodes(uids, signal)) {
                        nodes.push(n);
                        stopIfCancelled();
                    }
                } catch (e) {
                    if (signal?.aborted || failsTheList(e)) throw e;
                    // The SDK's batch loader throws after the nodes it could load, for ones it couldn't (a parent's key, say),
                    // and reports no missing node then. The rest are loaded again one at a time, in the pool below
                    const loaded = new Set(nodes.map((n) => ('missingUid' in n ? n.missingUid : n.uid)));
                    notLoaded = uids.filter((u) => !loaded.has(u));
                }

                // A node the batch didn't load, loaded again alone: null when it still can't be
                async function loadAlone(uid: string): Promise<MaybeMissingNode | null> {
                    try {
                        for await (const n of sdk.iterateNodes([uid], signal)) return n;
                        return null;
                    } catch (e) {
                        if (signal?.aborted || failsTheList(e)) throw e;
                        return null;
                    }
                }

                async function readOne(n: MaybeMissingNode): Promise<SharedItem> {
                    if ('missingUid' in n) {
                        return {
                            uid: n.missingUid,
                            name: indexedName(n.missingUid),
                            relPath: null,
                            where: 'elsewhere',
                            link: null,
                            people: 0,
                            unreadable: "This item can't be found in Proton Drive",
                        };
                    }
                    const name = n.name.ok ? n.name.value : indexedName(n.uid);
                    let relPath: string | null = null;
                    let where: SharedPlace = 'elsewhere';
                    try {
                        const place = n.trashTime ? null : deps.placeOf(n.uid);
                        const here = place && place.relPath !== '' ? place : null;
                        where = !here ? 'elsewhere' : here.hidden ? 'hidden' : 'my-files';
                        relPath = here ? here.relPath : null;
                        let result: ShareResult | undefined;
                        try {
                            result = await sdk.getSharingInfo(n.uid);
                        } catch (e) {
                            if (failsTheList(e)) throw e;
                            return { uid: n.uid, name, relPath, where, link: null, people: 0, unreadable: "Proton Drive couldn't say how this item is shared" };
                        }
                        // The server just listed it as shared, but the SDK reads the node's share from its cache, which learns
                        // of a share made elsewhere only from its events: listed, never left out, as nothing public may be hidden
                        if (!result) {
                            return {
                                uid: n.uid,
                                name,
                                relPath,
                                where,
                                link: null,
                                people: 0,
                                unreadable: 'Proton Drive is still catching up with this item: refresh in a moment',
                            };
                        }
                        return { uid: n.uid, name, relPath, where, link: toInfo(result).link, people: everyone(result).length };
                    } catch (e) {
                        if (failsTheList(e)) throw e;
                        // An error on this computer (the index, say) with one item: that item alone is unreadable. The list has no
                        // logger, and nothing about the item (its link, the people on it) belongs in a log anyway
                        return { uid: n.uid, name, relPath, where, link: null, people: 0, unreadable: "Proton Drive couldn't read this item on this computer" };
                    }
                }

                // A small pool, for the nodes the batch loaded, then for the ones it didn't, each loaded again alone before its
                // sharing is read: never more than LIST_CONCURRENCY calls at once. The first failure of the whole list (offline,
                // busy), or the list cancelled, stops the rest from starting
                const work = [...nodes.map((node) => ({ node })), ...notLoaded.map((uid) => ({ uid }))];
                const items: Array<SharedItem | undefined> = [];
                const unreadable: Array<SharedItem | undefined> = [];
                let next = 0;
                let failed = false;
                const worker = async () => {
                    try {
                        while (!failed && next < work.length) {
                            stopIfCancelled();
                            const i = next++;
                            const w = work[i];
                            let node: MaybeMissingNode;
                            if ('node' in w) {
                                node = w.node;
                            } else {
                                const loaded = await loadAlone(w.uid);
                                if (!loaded) {
                                    unreadable[i] = {
                                        uid: w.uid,
                                        name: indexedName(w.uid),
                                        relPath: null,
                                        where: 'elsewhere',
                                        link: null,
                                        people: 0,
                                        unreadable: "Proton Drive couldn't read this item",
                                    };
                                    continue;
                                }
                                if (failed) return;
                                stopIfCancelled();
                                node = loaded;
                            }
                            items[i] = await readOne(node);
                        }
                    } catch (e) {
                        failed = true;
                        throw e;
                    }
                };
                await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, work.length) }, worker));
                stopIfCancelled();

                // The items read, in the order they were loaded, then the ones that couldn't be loaded at all
                const listed = [...items, ...unreadable].filter((i): i is SharedItem => i !== undefined);
                const inFiles = listed.filter((i) => i.where !== 'elsewhere').sort((a, b) => byText(a.relPath ?? '', b.relPath ?? ''));
                const elsewhere = listed.filter((i) => i.where === 'elsewhere').sort((a, b) => byText(a.name, b.name));
                return [...inFiles, ...elsewhere];
            } catch (e) {
                // Whatever stopped the list once it was cancelled (the SDK's AbortError, say), no one is waiting for it
                if (signal?.aborted) throw new ListCancelled();
                if (!isOffline(e) && isBusy(e)) throw new ShareError('Proton Drive is busy: try again in a minute');
                throw plainError(e);
            }
        },

        info: (path) => run(path, async (n) => toInfo(await sdk.getSharingInfo(n.uid))),

        password: (path) =>
            run(path, async (n) => {
                const link = (await sdk.getSharingInfo(n.uid))?.urlAccess;
                return link && !isOlderLink(link.url) ? (link.customPassword ?? null) : null;
            }),

        async ensureLink(path) {
            return run(path, async (n) => {
                // "No link" may be stale: the SDK keeps nodes in a cache on disk, and learns of a share made elsewhere (the web
                // app, another device) only from its events. Asked for a link then, shareNode finds that the share exists,
                // refreshes the node, and UPDATES the link it finds with the settings given, which replace the link's own
                // (updateSharedLink): the role alone would clear its password and expiry. So shareNode is asked first for
                // nothing at all: it finds the item's share the same way (or makes an empty one, which the link below then
                // uses) and answers its real state, without writing to a link. A link found then is returned as it is.
                const existing = (await sdk.getSharingInfo(n.uid))?.urlAccess ?? (await sdk.shareNode(n.uid, {})).urlAccess;
                if (existing) {
                    refuseUnusable(existing, n.name);
                    return { url: existing.url, created: false };
                }
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
                // The SDK refuses a past expiry, so an expired link can only change together with its expiry
                if (change.expiresAt === undefined && current.expirationTime && current.expirationTime.getTime() <= deps.now()) {
                    throw new ShareError('This link has expired: set a new expiry date, or remove the expiry, to change it');
                }
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
                // What is left, or nothing once the SDK has deleted the emptied share
                const result = await sdk.unshareNode(n.uid, { urlAccess: 'remove' });
                log(path, `Stopped sharing the link to ${n.name}`);
                return toInfo(result);
            });
        },

        async stopSharing(path, uid) {
            return run(path, async (n) => {
                // The path may hold another item now than the one that was listed (moved, replaced): nothing is touched then
                if (n.uid !== uid) throw new ShareError('This item changed since the list was loaded: refresh');
                let result: ShareResult | undefined;
                try {
                    // No settings: the SDK deletes the whole share, the link and everyone
                    result = await sdk.unshareNode(n.uid);
                } catch (e) {
                    // The share is gone already, stopped elsewhere while the SDK's cache still held it: reading or deleting
                    // it is answered 2501, "does not exist". Nothing was stopped here, so nothing is logged
                    if ((e as { name?: string } | null)?.name === 'NotFoundAPIError') return { link: null, people: [] };
                    throw e;
                }
                log(path, `Stopped sharing ${n.name}`);
                return toInfo(result);
            });
        },

        async invite(path, emails, role) {
            const bad = emails.find((e) => !EMAIL.test(e));
            if (bad !== undefined) throw new ShareError(`Not a valid email address: ${bad}`);
            return run(path, async (n) => {
                // The SDK matches an address already on the list exactly as written, and changes that person's role
                // instead of inviting them: a role changes only through setRole
                const listedNow = new Set(everyone(await sdk.getSharingInfo(n.uid)).map((m) => m.inviteeEmail.toLowerCase()));
                if (emails.some((e) => listedNow.has(e.toLowerCase()))) {
                    throw new ShareError('Already has access: change their role instead');
                }
                const result = await sdk.shareNode(n.uid, { users: emails.map((email) => ({ email, role: sdkRole(role) })) });
                log(path, `Invited ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to ${n.name}`);
                return toInfo(result);
            });
        },

        async setRole(path, email, role) {
            return run(path, async (n) => {
                const listedEmail = await listed(n.uid, email);
                const result = await sdk.shareNode(n.uid, { users: [{ email: listedEmail, role: sdkRole(role) }] });
                log(path, `Changed someone's access to ${n.name}`);
                return toInfo(result);
            });
        },

        async removePerson(path, email) {
            return run(path, async (n) => {
                const result = await sdk.unshareNode(n.uid, { users: [await listed(n.uid, email)] });
                log(path, `Removed someone's access to ${n.name}`);
                return toInfo(result);
            });
        },
    };
}
