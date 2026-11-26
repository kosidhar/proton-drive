import { MemberRole, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import { isProtonDocument, isProtonSheet } from '@protontech/drive-sdk/internal/nodes/mediaTypes';

import { loadSharedWithMe } from '../sdk/paths';
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

        async download() {
            throw new ShareError('Not yet');
        },
    };
}
