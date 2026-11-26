import { randomBytes } from 'node:crypto';
import { link, mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import { MemberRole, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import { isProtonDocument, isProtonSheet } from '@protontech/drive-sdk/internal/nodes/mediaTypes';

import { loadSharedWithMe } from '../sdk/paths';
import { LOCAL_RESERVE_BYTES } from '../sync/syncEngine';
import { plainError, ShareError } from './shareService';

// What other people share with the owner: the invitations waiting for an answer, and the items already shared. The
// uids are the SDK's: the app acts on what it was listed, by uid.

export type SharedWithMeKind = 'file' | 'folder' | 'doc' | 'sheet';
type Role = 'viewer' | 'editor' | 'admin';

export interface Invitation {
    invitationUid: string;
    // null when the name can't be decrypted
    name: string | null;
    kind: SharedWithMeKind;
    // The sender's address; when it can't be verified, the one the invitation claims (null when it claims none)
    from: string | null;
    fromVerified: boolean;
    role: Role;
    invitedAt: number;
}

export interface SharedWithMeItem {
    uid: string;
    name: string | null;
    kind: SharedWithMeKind;
    sharedBy: string | null;
    sharedByVerified: boolean;
    sharedAt: number | null;
    role: Role;
    // Only an item shared with the user directly can be left: one inherited from a folder above can't
    canLeave: boolean;
    unreadable?: string;
}

export interface SharedWithMeService {
    list(signal?: AbortSignal): Promise<{ invitations: Invitation[]; items: SharedWithMeItem[] }>;
    accept(invitationUid: string): Promise<void>;
    decline(invitationUid: string): Promise<void>;
    leave(uid: string): Promise<void>;
    openUrl(uid: string): Promise<{ url: string }>;
    download(uid: string): Promise<{ path: string }>;
}

export interface SharedWithMeDeps {
    sdk: Pick<
        ProtonDriveClient,
        'iterateInvitations' | 'acceptInvitation' | 'rejectInvitation' | 'leaveSharedNode' | 'iterateSharedWithMeNodeUids' | 'iterateNodes' | 'experimental'
    >;
    logActivity(entry: { action: 'share'; localRelPath: string; details: string }): void;
    now(): number;
    // The folder a download goes to: the user's Downloads (the service creates it when it is missing)
    downloadsDir(): Promise<string>;
    freeBytes(dir: string): Promise<number>;
    // Downloads the file to toPath, a path nothing is at
    fetchFile(node: NodeEntity, toPath: string): Promise<void>;
}

const SHARED_WITH_ME_PAGE = 'https://drive.proton.me/shared-with-me';
const UNREADABLE = "Proton Drive couldn't load this item";
const EMAIL = /\S+@\S+\.\S+/g;

const toRole = (role: MemberRole): Role => (role === MemberRole.Admin ? 'admin' : role === MemberRole.Editor ? 'editor' : 'viewer');

function kindOf(node: { type: NodeType; mediaType?: string }): SharedWithMeKind {
    if (isProtonDocument(node.mediaType)) return 'doc';
    if (isProtonSheet(node.mediaType)) return 'sheet';
    return node.type === NodeType.Folder ? 'folder' : 'file';
}

// An SDK author: the address, whether it is verified; an unverified one gives the address it claims
function authorOf(author: { ok: true; value: string | null } | { ok: false; error: { claimedAuthor?: string | null } }): { who: string | null; verified: boolean } {
    return author.ok ? { who: author.value, verified: true } : { who: author.error.claimedAuthor ?? null, verified: false };
}

const nameOf = (name: { ok: boolean; value?: string }): string | null => (name.ok && name.value ? name.value : null);

// Names are the sender's text, and may hold an address: the activity log keeps none
const forLog = (name: string | null) => (name ?? 'a shared item').replace(EMAIL, 'an address');

const FALLBACK_NAME = 'Shared file';
// Room for " (n)" and the temp prefix inside the 255 bytes a file name may have
const MAX_NAME_BYTES = 150;
const MAX_NAME_TRIES = 10_000;
export const TEMP_PREFIX = '.proton-drive-tmp-';

function safeName(name: string): string {
    // A name is the sender's text: no folder, no control character, never . or ..
    let safe = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\//g, '_').trim();
    if (safe === '' || /^\.+$/.test(safe)) return FALLBACK_NAME;
    if (Buffer.byteLength(safe) > MAX_NAME_BYTES) {
        const ext = path.extname(safe);
        const keep = ext.length > 0 && Buffer.byteLength(ext) <= 20 ? ext : '';
        let stem = safe.slice(0, safe.length - keep.length);
        while (Buffer.byteLength(stem) + Buffer.byteLength(keep) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
        safe = (stem + keep).trim();
        if (safe === '' || /^\.+$/.test(safe)) return FALLBACK_NAME;
    }
    return safe;
}

// The names to try for a download: the safe name, then `name (1).ext`, `name (2).ext` and so on
export function* downloadNames(name: string): Generator<string> {
    const safe = safeName(name);
    yield safe;
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let n = 1; ; n++) yield `${stem} (${n})${ext}`;
}

const byDateThenName = (a: SharedWithMeItem, b: SharedWithMeItem) => {
    if (a.sharedAt !== b.sharedAt) {
        if (a.sharedAt === null) return 1;
        if (b.sharedAt === null) return -1;
        return b.sharedAt - a.sharedAt;
    }
    return (a.name ?? '').localeCompare(b.name ?? '');
};

export function createSharedWithMeService(deps: SharedWithMeDeps): SharedWithMeService {
    const { sdk } = deps;

    const log = (details: string) => {
        try {
            deps.logActivity({ action: 'share', localRelPath: '', details });
        } catch {
            // The entry is lost; the change stands
        }
    };

    async function invitations(signal?: AbortSignal): Promise<Invitation[]> {
        const out: Invitation[] = [];
        for await (const i of sdk.iterateInvitations(signal)) {
            const { who, verified } = authorOf(i.addedByEmail);
            out.push({
                invitationUid: i.uid,
                name: nameOf(i.node.name),
                kind: kindOf(i.node),
                from: who,
                fromVerified: verified,
                role: toRole(i.role),
                invitedAt: i.invitationTime.getTime(),
            });
        }
        return out.sort((a, b) => b.invitedAt - a.invitedAt);
    }

    function toItem(node: NodeEntity): SharedWithMeItem {
        const m = node.membership;
        const by = m ? authorOf(m.sharedBy) : { who: null, verified: false };
        return {
            uid: node.uid,
            name: nameOf(node.name),
            kind: kindOf(node),
            sharedBy: by.who,
            sharedByVerified: by.verified,
            sharedAt: m ? m.inviteTime.getTime() : null,
            role: toRole(m ? m.role : node.directRole),
            canLeave: m !== undefined,
        };
    }

    const unreadable = (uid: string): SharedWithMeItem => ({
        uid,
        name: null,
        kind: 'file',
        sharedBy: null,
        sharedByVerified: false,
        sharedAt: null,
        role: 'viewer',
        canLeave: false,
        unreadable: UNREADABLE,
    });

    async function items(): Promise<SharedWithMeItem[]> {
        const skipped: string[] = [];
        const nodes = await loadSharedWithMe(sdk, (uid) => skipped.push(uid));
        return [...nodes.map(toItem), ...skipped.map(unreadable)].sort(byDateThenName);
    }

    // One action on the SDK: its failure becomes a ShareError and nothing is logged for it
    async function act(op: () => Promise<void>, done: string): Promise<void> {
        try {
            await op();
        } catch (e) {
            throw plainError(e);
        }
        log(done);
    }

    // The name of an invitation, for the log; a lookup that fails leaves the entry unnamed
    async function invitationName(invitationUid: string): Promise<string | null> {
        try {
            for await (const i of sdk.iterateInvitations()) {
                if (i.uid === invitationUid) return nameOf(i.node.name);
            }
        } catch {
            // Unnamed
        }
        return null;
    }

    return {
        async list(signal) {
            try {
                const [inv, its] = await Promise.all([invitations(signal), items()]);
                return { invitations: inv, items: its };
            } catch (e) {
                throw plainError(e);
            }
        },

        async accept(invitationUid) {
            const name = await invitationName(invitationUid);
            await act(() => sdk.acceptInvitation(invitationUid), `Accepted an invitation to ${forLog(name)}`);
        },

        async decline(invitationUid) {
            const name = await invitationName(invitationUid);
            await act(() => sdk.rejectInvitation(invitationUid), `Declined an invitation to ${forLog(name)}`);
        },

        async leave(uid) {
            let item: SharedWithMeItem | undefined;
            try {
                item = (await items()).find((i) => i.uid === uid);
            } catch (e) {
                throw plainError(e);
            }
            if (!item?.canLeave) throw new ShareError("You can't leave this item: it is shared through a folder, or can't be read");
            await act(() => sdk.leaveSharedNode(uid), `Left ${forLog(item.name)}`);
        },

        async openUrl(uid) {
            try {
                return { url: await sdk.experimental.getNodeUrl(uid) };
            } catch {
                return { url: SHARED_WITH_ME_PAGE };
            }
        },

        async download(uid) {
            let node: NodeEntity;
            try {
                const [found] = await Array.fromAsync(sdk.iterateNodes([uid]));
                if (!found || 'missingUid' in found) throw new ShareError("This item isn't shared with you any more");
                node = found;
            } catch (e) {
                throw plainError(e);
            }
            if (kindOf(node) !== 'file') throw new ShareError('Only files can be downloaded: open this one on drive.proton.me');
            const name = nameOf(node.name);
            const size = node.activeRevision?.claimedSize ?? node.totalStorageSize ?? 0;

            let dir: string;
            try {
                dir = await deps.downloadsDir();
                await mkdir(dir, { recursive: true });
                if (size > (await deps.freeBytes(dir)) - LOCAL_RESERVE_BYTES) {
                    throw new ShareError("There isn't enough free space on this computer to download this file");
                }
            } catch (e) {
                throw e instanceof ShareError ? e : new ShareError("Your Downloads folder can't be used");
            }

            // A fresh name nothing is at, so the download's own rename can't replace anything; placed with link(), which
            // fails where a file exists instead of replacing it, so a file of the user's is never overwritten, even by
            // a second download racing for the same name
            const temp = path.join(dir, `${TEMP_PREFIX}${randomBytes(8).toString('hex')}-${safeName(name ?? FALLBACK_NAME)}`);
            let placed: string | undefined;
            try {
                await deps.fetchFile(node, temp);
                let tries = 0;
                for (const candidate of downloadNames(name ?? FALLBACK_NAME)) {
                    if (++tries > MAX_NAME_TRIES) throw new ShareError('Too many files with this name in Downloads');
                    const target = path.join(dir, candidate);
                    try {
                        await link(temp, target);
                        placed = target;
                        break;
                    } catch (e) {
                        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                    }
                }
            } catch (e) {
                await rm(temp, { force: true }).catch(() => {});
                throw plainError(e);
            }
            await unlink(temp).catch(() => {});
            log(`Downloaded ${forLog(name)} to Downloads`);
            return { path: placed! };
        },
    };
}
