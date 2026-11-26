import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import { MemberRole, NodeType, type Logger, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
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
    // The uid of the item it shares: the item it becomes once accepted
    nodeUid: string;
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
    // The daemon's log, for the code of a local failure (never a name or a path)
    logError?(line: string): void;
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

// The SDK's logger for a download: it names the file in its messages and errors, and the name is the sender's text, so
// every message and error goes through with addresses taken out
export function redactingLogger(logger: Logger): Logger {
    const clean = (text: string) => text.replace(EMAIL, 'an address');
    const cleanArg = (arg: unknown): unknown => {
        if (arg instanceof Error) {
            const copy = new Error(clean(arg.message));
            copy.name = arg.name;
            const code = (arg as NodeJS.ErrnoException).code;
            if (code !== undefined) (copy as NodeJS.ErrnoException).code = code;
            return copy;
        }
        return typeof arg === 'string' ? clean(arg) : arg === undefined ? arg : clean(String(arg));
    };
    return {
        debug: (msg) => logger.debug(clean(msg)),
        info: (msg) => logger.info(clean(msg)),
        warn: (msg) => logger.warn(clean(msg)),
        error: (msg, error) => logger.error(clean(msg), cleanArg(error)),
    };
}

// What a failure of the user's own disk or folder says, in plain words (no Proton, no path); null for any other failure
const LOCAL_FAILURES: Record<string, string> = {
    ENOSPC: "there's no space left",
    EPERM: "it doesn't allow this",
    ENOTSUP: "it doesn't allow this",
    EOPNOTSUPP: "it doesn't allow this",
    ENOSYS: "it doesn't allow this",
    EACCES: "you don't have permission to write there",
    EROFS: "it is read-only",
};

function localFailure(e: unknown): { code: string; error: ShareError } | null {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    const why = typeof code === 'string' ? LOCAL_FAILURES[code] : undefined;
    return why === undefined || code === undefined ? null : { code, error: new ShareError(`Couldn't save to your Downloads folder: ${why}`) };
}

const FALLBACK_NAME = 'Shared file';
// Room for " (n)" and the temp prefix inside the 255 bytes a file name may have
const MAX_NAME_BYTES = 150;
const MAX_NAME_TRIES = 10_000;
export const TEMP_PREFIX = '.proton-drive-tmp-';
// A download's temp in Downloads: a prefix of its own (the sync's temps share TEMP_PREFIX), then 16 hex digits
export const DOWNLOAD_TEMP_PREFIX = `${TEMP_PREFIX}download-`;
const DOWNLOAD_TEMP = /^\.proton-drive-tmp-download-[0-9a-f]{16}-./;
// The temp downloadDriveNodeToLocal writes first, beside its target (src/sdk/fileOps.ts): its process's pid, then a uuid.
// The sync's downloads are named so too
const INNER_TEMP = /^\.proton-drive-tmp-([0-9]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Whether no process has this pid. Only "no such process" says so: a process of another user, or a pid that can't be
// asked about, keeps its files
function processGone(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

function safeName(name: string): string {
    // A name is the sender's text: no folder, no control character, never . or ..
    // (control characters of both ranges, and the marks that reverse the order text is shown in)
    let safe = name.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, '').replace(/\//g, '_').trim();
    if (safe === '' || /^\.+$/.test(safe)) return FALLBACK_NAME;
    if (Buffer.byteLength(safe) > MAX_NAME_BYTES) {
        const ext = path.extname(safe);
        const keep = ext.length > 0 && Buffer.byteLength(ext) <= 20 ? ext : '';
        // By code point: a cut inside a pair would leave half of a character
        const stem = Array.from(safe.slice(0, safe.length - keep.length));
        while (stem.length > 0 && Buffer.byteLength(stem.join('')) + Buffer.byteLength(keep) > MAX_NAME_BYTES) stem.pop();
        safe = (stem.join('') + keep).trim();
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
    // The temps of this daemon's downloads under way, by path, and their sizes added up
    const downloading = new Set<string>();
    let bytesToCome = 0;

    // The temps a daemon stopped mid-download left in Downloads (#492): in that folder only, never in one below it.
    // Downloads may be in the sync folder, where the sync's temps share the prefix: a download's own temp goes when no
    // download of this daemon is writing it, an inner one only when the process that wrote it is gone, and nothing else
    // ever does. A failure leaves the file for the next sweep
    async function sweepTemps(dir: string): Promise<void> {
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names) {
            const full = path.join(dir, name);
            const inner = INNER_TEMP.exec(name);
            const stale = DOWNLOAD_TEMP.test(name) ? !downloading.has(full) : inner !== null && processGone(Number(inner[1]));
            if (!stale) continue;
            try {
                if ((await lstat(full)).isFile()) await unlink(full);
            } catch {
                // Left for the next sweep
            }
        }
    }

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
                nodeUid: i.node.uid,
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
            // The claimed size is the sender's word, and the stored one a little over the file's: the larger counts.
            // Only the active revision's, which is what is downloaded (totalStorageSize counts every revision)
            const revision = node.activeRevision;
            const size = Math.max(revision?.claimedSize ?? 0, revision?.storageSize ?? 0);

            let dir: string;
            try {
                dir = await deps.downloadsDir();
                await mkdir(dir, { recursive: true });
                await sweepTemps(dir);
                // The other downloads under way count in full, as if none of them were written yet: once they have
                // begun, a little too much is counted, never too little
                if (size > (await deps.freeBytes(dir)) - LOCAL_RESERVE_BYTES - bytesToCome) {
                    throw new ShareError("There isn't enough free space on this computer to download this file");
                }
            } catch (e) {
                if (e instanceof ShareError) throw e;
                const local = localFailure(e);
                deps.logError?.(`Download: the Downloads folder can't be used (${(e as NodeJS.ErrnoException)?.code ?? 'unknown'})`);
                throw local?.error ?? new ShareError("Your Downloads folder can't be used");
            }

            // A fresh name nothing is at, so the download's own rename can't replace anything; placed with link(), which
            // fails where a file exists instead of replacing it, so a file of the user's is never overwritten, even by
            // a second download racing for the same name
            const temp = path.join(dir, `${DOWNLOAD_TEMP_PREFIX}${randomBytes(8).toString('hex')}-${safeName(name ?? FALLBACK_NAME)}`);
            let placed: string | undefined;
            // Taken with no wait since the check, so a download checked after this one counts it; given back once the
            // file is placed (then its bytes are on the disk) or its temp removed
            bytesToCome += size;
            downloading.add(temp);
            try {
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
                    const local = localFailure(e);
                    if (local) {
                        deps.logError?.(`Download: saving failed (${local.code})`);
                        throw local.error;
                    }
                    throw plainError(e);
                }
                await unlink(temp).catch(() => {});
            } finally {
                bytesToCome -= size;
                downloading.delete(temp);
            }
            log(`Downloaded ${forLog(name)} to Downloads`);
            return { path: placed! };
        },
    };
}
