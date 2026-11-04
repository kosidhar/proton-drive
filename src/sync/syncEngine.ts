import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, renameSync, type Stats, statSync, utimesSync } from 'node:fs';
import { lstat, mkdir, readdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    AbortError,
    ConnectionError,
    type DriveEvent,
    DriveEventType,
    type Logger,
    type NodeEntity,
    NodeType,
    NodeWithSameNameExistsValidationError,
    type ProtonDriveClient,
    ValidationError,
} from '@protontech/drive-sdk';

import { sendActionNotification, sendDesktopNotification } from '../linux/notifications';
import type { Manager as EventsManager } from '../sdk/events/manager';
import {
    computeLocalFileSha1,
    createRemoteFolder,
    downloadDriveNodeToLocal,
    downloadRevisionToFile,
    isUnsupportedRemoteNode,
    listFolderChildren,
    type UploadResult,
    uploadLocalFileToDrive,
} from '../sdk/fileOps';
import { getClaimedSize, getName } from '../sdk/node';
import { AvailabilityPolicy, type ItemAvailability } from './availability';
import { DownloadWatch } from './downloadWatch';
import { problemWithBlockedApps } from './settingsRules';
import { Slots } from './slots';
import { StateEvents } from './stateEvents';
import { PIN_ROOT_ON_FIRST_SYNC } from './availabilityMigration';
import { createLocalConflictCopy, formatConflictFileName } from './conflictResolver';
import { isTransient, permanentRefusal, unmappedApiCode } from './remoteErrors';
import { homeTrash, type MoveToDesktopTrash } from './desktopTrash';
import { readDriveLayout } from './driveMode';
import { LAYOUT_MOVING, type MoveSeams, relocateFiles, SYNC_DIR_MOVING } from './layoutMigration';
import { DriveOpError, type VfsEntry } from './driveOps';
import { HYDRATE_STAGING_PREFIX, isEngineTempName, removeScannedEntries, type ScanEntry, scanLocalCopies } from './localCopies';
import { moveWithoutReplacing } from './localMove';
import { LocalFolderWatcher, matchesIgnorePatterns } from './localWatcher';
import { pathsOverlap } from './mountPoint';
import { entryFromNode, RemoteIndex, type RemoteIndexEntry } from './remoteIndex';
import { type RemoteOp, RemoteOpsJournal } from './remoteOps';
import type { ConflictRecord, SyncedItemRecord, SyncSettings, SyncStateDatabase } from './syncStateDb';
import { forgetFailedThumbnail } from './thumbnailCache';

export { DriveOpError, type DriveOpErrorCode, type VfsEntry } from './driveOps';

// A sync folder path as the user typed it: '~' and '~/...' are the home folder
export function resolveSyncDirInput(raw: string): string {
    const home = os.homedir();
    const expanded = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw === '~' ? home : raw;
    return path.resolve(expanded);
}

export interface ActiveTransfer {
    id: string;
    direction: 'upload' | 'download';
    relPath: string;
    bytesTransferred: number;
    totalBytes: number;
    startedAt: number;
}

// Meta key for a local move whose records (and journalled cloud change) are in place but whose file system step may not
// have happened yet: { from, to, replace }. Set and cleared around that step; found set only after a crash, and then
// finished (see recoverLocalMove).
export const LOCAL_MOVE_IN_PROGRESS = 'localMoveInProgress';
// Meta key for the account the records are of: its My files root's uid (see recordsAreOf, #35)
export const ACCOUNT_ROOT = 'accountRoot';
// Set while the records are found to be of another account than the one signed in to, so a start that can't check
// (offline) still holds them (#35)
export const ACCOUNT_MISMATCH = 'accountMismatch';
const ACCOUNT_MISMATCH_MESSAGE =
    'You signed in to a different Proton account than the files on this computer were synced with. Nothing is synced, ' +
    'deleted or uploaded until you choose: sign back in to that account, or start fresh, keeping the files on ' +
    'this computer and syncing them to this account as new files.';
const ACCOUNT_NOT_CHECKED = "Can't check which Proton account the files on this computer are synced with: try again once online";
// How many times a journalled change may fail for a reason other than the network or the server before it is given up
// on, so that it can't hold up everything after it for ever
const MAX_UNEXPECTED_FAILURES = 10;
// How many times an operation Proton Drive refuses for good (see permanentRefusal) is tried before it is given up on:
// such a refusal doesn't change, and the journal waits behind it meanwhile (#39)
const MAX_PERMANENT_REFUSALS = 3;
// An operation refused with an API code outside the 2xxx family, which a server outage or an expired session can answer
// with too, is tried again with backoff (up to an hour between tries) and given up on only after failing that way, and
// no other, for this long and at least this many times in a row (time offline, say, never counts)
const GIVE_UP_UNMAPPED_AFTER_MS = 24 * 60 * 60_000;
const MIN_UNMAPPED_FAILURES = 5;
const MAX_REPLAY_BACKOFF_MS = 60 * 60_000;
// An item that keeps failing in sync passes is tried again after 1 minute, doubling each time, up to this (#18)
const MAX_ITEM_BACKOFF_MS = 60 * 60_000;
// A local file that changed uploads only once it has stayed as it is (size and times) this long, so that a copy that
// stalls (a slow disk, a network share, a paused cp) doesn't upload half a file (#51). One seen changing again waits
// twice as long each time, up to SETTLE_MAX_QUIET_MS.
const SETTLE_QUIET_MS = 2000;
// How many local changes are handled at once: enough to keep uploads going, few enough that a large folder copied in
// doesn't start thousands of hashes and uploads together (#90)
const LOCAL_CHANGE_CONCURRENCY = 6;
const SETTLE_MAX_QUIET_MS = 16_000;
// A file that never stops changing (a log, say) uploads anyway after this long, and then at most this often
const SETTLE_MAX_WAIT_MS = 2 * 60_000;
// How long a file let through is remembered as it was then (see stillBeingWritten)
const SETTLED_KEPT_MS = 60_000;
// Uid prefix of the remote index entries that stand for folders made here that Proton Drive doesn't have yet, holding
// what a pending move puts in them (see applyPendingOpsToIndex). Never a node: never resolved, moved or trashed.
const PROVISIONAL = 'provisional:';
// How long a download for the virtual drive (an app opening an online-only file) may take before the user is told
// (those downloads are staged at the root of the backing store: see HYDRATE_STAGING_PREFIX in localCopies)
const SLOW_DOWNLOAD_NOTICE_MS = 2000;
// What everything that would touch the files answers while they move between the sync folder and the backing store
const BUSY_MOVING = 'Proton Drive is busy moving files';
// How long a start waits to check the account signed in to before going on as if offline (#35)
const START_ACCOUNT_CHECK_MS = 10_000;
// Whether a relative path is base itself or inside it
function isSameOrUnder(relPath: string, base: string): boolean {
    return relPath === base || relPath.startsWith(`${base}/`);
}
// The status, and what everything that would make something in the folder answers, while the files are missing from it
// (see filesGone): that all of them are missing from `where` (see missingPlace), or, when only some are, the one item
// missing or how many items are
export function filesMissingMessage(where: string, missing?: { names: readonly string[]; items: number; whole: boolean }): string {
    const what =
        !missing || missing.whole
            ? "Proton Drive's files are"
            : missing.names.length === 1
              ? `${missing.names[0]} is`
              : `${missing.items} items are`;
    return `${what} missing from ${where}. Nothing was deleted in Proton Drive.`;
}

// Where the files are missing from, in the user's terms: the sync folder, with ~ for the home folder; or, in the virtual
// layout (the files are kept in the backing store, which the user never sees), the drive's storage
export function missingPlace(syncDir: string, virtual: boolean, home: string = os.homedir()): string {
    if (virtual) {
        return "the drive's storage";
    }
    const homeDir = home.replace(/\/+$/, '');
    if (homeDir !== '' && (syncDir === homeDir || syncDir.startsWith(`${homeDir}/`))) {
        return `~${syncDir.slice(homeDir.length)}`;
    }
    return syncDir;
}

// How long what is missing while held is taken as known by what asks often (the status, local changes, the drive): a
// sync pass and a confirmation look afresh
const FILES_MISSING_CACHE_MS = 1000;

// Meta key for the files-missing hold (see filesGone), as JSON { root, names }: set when a hold begins, and kept after it
// ends until a sync pass has looked at what is still missing (see lookAfterHold). So the hold, and that look, survive a
// restart of the daemon, and a pass that fails or is cut short leaves the look to the next one.
export const FILES_HOLD = 'filesHold';

// What the user can do about the files missing from the folder, besides waiting for them (POST /sync/files-missing):
// delete them from Proton Drive too (confirmFilesMissingDeleted), or keep them there, online-only
// (keepFilesMissingOnlineOnly)
export type FilesMissingAction = 'delete-in-cloud' | 'keep-online-only';
export const FILES_MISSING_ACTIONS: readonly string[] = ['delete-in-cloud', 'keep-online-only'] satisfies FilesMissingAction[];

// A choice about missing files (FilesMissingAction) with nothing missing, or not what the user was shown: 409
export class FilesMissingRefused extends Error {
    readonly status = 409;
    constructor(message: string) {
        super(message);
        this.name = 'FilesMissingRefused';
    }
}

// Whether a folder is there. Any failure to look counts as not there: this only ever holds back.
function isFolderAt(dir: string): boolean {
    try {
        return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
        return false;
    }
}

// Whether an item (a path relative to a folder that is there) is in it; a link counts as there. Any failure to look
// (ENOTDIR, EACCES, …) counts as not there: this only ever holds back.
function itemIn(root: string, relPath: string): boolean {
    try {
        return lstatSync(path.join(root, relPath), { throwIfNoEntry: false }) !== undefined;
    } catch {
        return false;
    }
}

// Names for a message: "a, b and c", "a, b, c and 2 more"
function listNames(names: readonly string[], shown = 3): string {
    if (names.length <= shown) {
        return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    }
    return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

// A hold saved in meta FILES_HOLD, or null for none (or one unreadable, which still makes the pass after it look)
function parseFilesHold(raw: string | null): { root: string; names: string[] } | null {
    try {
        const saved: unknown = JSON.parse(raw ?? 'null');
        const { root, names } = (saved ?? {}) as { root?: unknown; names?: unknown };
        if (typeof root === 'string' && Array.isArray(names) && names.every((name) => typeof name === 'string')) {
            return { root, names };
        }
    } catch {
        // Unreadable: no hold to take up
    }
    return null;
}

// A conflict that can't be resolved now: 404 when there is no such conflict, 409 when it is already resolved (or being
// resolved), so that resolving never acts twice
export class ConflictRefusedError extends Error {
    constructor(
        readonly status: 404 | 409,
        message: string,
    ) {
        super(message);
        this.name = 'ConflictRefusedError';
    }
}
// How long moving the sync folder waits for what the engine is doing (an upload, a download) before giving up
const RELOCATE_HOLD_TIMEOUT_MS = 60_000;

export type EngineState = 'idle' | 'syncing' | 'paused' | 'unauthenticated' | 'error';

export type AvailabilityAction = 'pin' | 'free' | 'hide' | 'unhide';
const AVAILABILITY_ACTIONS: readonly string[] = ['pin', 'free', 'hide', 'unhide'] satisfies AvailabilityAction[];
// How often a sync pass also crawls the folders that are online-only here (see reconcilePasses)
const ONLINE_ONLY_CRAWL_EVERY = 10;
// A remote folder absent from this computer, found by a sync pass
interface OnlineOnlyFolder {
    node: NodeEntity;
    relPath: string;
}

export interface AvailabilityResult {
    state: ItemAvailability;
    // What Free up space left on this computer (things not in Proton Drive yet, or the folders holding them)
    kept: string[];
    // Why a hide was refused, or null
    refused: string | null;
}

export class ProtonDriveSyncEngine {
    private state: EngineState = 'idle';
    private currentAction: string | null = null;
    private lastSyncAt: number | null = null;
    private lastError: string | null = null;
    private rootNode: NodeEntity | null = null;
    private activeTransfers = new Map<string, ActiveTransfer>();
    private watcher: LocalFolderWatcher;
    private unsubscribeDriveEvents: (() => void) | null = null;
    private reconcileRunning = false;
    private reconcileQueued = false;
    // Full sync passes since start(). Folders that aren't on this computer are listed for the remote index only on
    // some passes (ruling R17): the first after start, one after a TreeRefresh or FastForward event, and every
    // ONLINE_ONLY_CRAWL_EVERY-th pass. Between them, change events re-list just the folder they happen in.
    private reconcilePasses = 0;
    private onlineOnlyCrawlDue = true;
    private syncingFolders = new Set<string>();
    private localQueue = new Map<string, Promise<void>>();
    // Availability changes (setAvailability, and finishing pending hides) and removals after a cloud delete run one at a
    // time on this chain, and local change handling waits for them: a deletion seen while the records still exist would
    // read as the user deleting synced files.
    private availabilityRun: Promise<void> = Promise.resolve();
    // How many availability changes were asked for per node uid: a later one supersedes an earlier one on the same item
    // that is still waiting or running (an unhide stops a hide's removal, a pin stops a free's).
    private availabilityAsks = new Map<string, number>();
    // Local copies removed by Free up space, Hide or a cloud delete, or moved away to follow a cloud rename (see
    // recordSynced). While a removal runs, the paths it has dropped records for, and the subtrees it moved away, are in
    // runningRemovals; when it ends they become a batch numbered by localRemovals, the count of finished removals. A
    // batch is kept while some work that began before it is still running (workSince counts the running work by the
    // count it began at).
    private localRemovals = 0;
    private runningRemovals = new Set<TakenAway>();
    private removalBatches: Array<{ n: number; takenAway: TakenAway }> = [];
    private workSince = new Map<number, number>();
    private readonly index: RemoteIndex;
    private readonly policy: AvailabilityPolicy;
    // What changed, for the file manager's emblems (see StateEvents and the control socket's /fm/events)
    readonly stateEvents: StateEvents;
    // Renames, moves and deletes made through the virtual drive that Proton Drive has yet to get, and the replay of them:
    // one at a time (replayRun), again when asked meanwhile (replayAgain), and after the sync pass when asked during one
    // (replayAfterPass)
    private readonly journal: RemoteOpsJournal;
    private replayRun: Promise<void> | null = null;
    private replayAgain = false;
    private replayAfterPass = false;
    // Downloads for the virtual drive under way, by path: a second open of the same file waits for the same one
    private hydrations = new Map<string, Promise<void>>();
    // Local changes handled at once, and the look of each path waiting for its turn (see handleLocalFileChange)
    private readonly localChangeSlots: Slots;
    private readonly localWaiting = new Map<string, Promise<void>>();
    // Stopped: changes still waiting for their turn do nothing when it comes
    private stopped = false;
    // Downloads by app, to tell the user when one app downloads many files (see DownloadWatch)
    private readonly downloadWatch = new DownloadWatch();
    private hydrateStaging = new Set<string>(); // their staging files
    private slowDownloadNoticeMs = SLOW_DOWNLOAD_NOTICE_MS;
    // Held while the files move between the sync folder and the backing store (see holdForMove): nothing new starts, and
    // inFlight counts what started before, which the move waits for
    private held = false;
    private inFlight = 0;
    // The move marker last found set (see holding), so that it is logged once
    private markerSeen: string | null = null;
    // The files-missing hold (see filesGone): the local root, and the recorded items missing when it began (top-level
    // items, or, held again after a hold, the topmost missing items at any depth: see lookAfterHold). Saved in meta
    // FILES_HOLD too; a hold saved by an earlier run is looked at once (filesHoldResumed).
    private filesHold: { root: string; names: string[] } | null = null;
    private filesHoldResumed = false;
    private filesGoneSaid: string | null = null; // where the hold was last told about, so it is said once
    // Signed in to another account than the records are of (see recordsAreOf): nothing is synced until the user chooses
    private accountMismatch: { message: string } | null = null;
    // Whether the account signed in to was checked to be the records' since the engine started: until then, local and
    // cloud changes and the journal wait for a pass, which checks it first (#35)
    private accountVerified = false;
    // Moved on at every stop and start: a root lookup begun before one never fills the cache, nor checks the account,
    // after it (a sign-out and a sign-in to another account may lie between)
    private accountGeneration = 0;
    private filesGoneError: string | null = null; // the lastError the hold set, which ending it clears
    private missingKnown: { hold: object; at: number; missing: MissingItems } | null = null; // see stillMissing
    // Missing items the user said were deleted on purpose, for the next sync pass to take for deletes
    private missingConfirmed: { root: string; names: Set<string> } | null = null;
    // Conflicts being resolved by hand right now, so that a second request for the same one is refused
    private readonly resolvingConflicts = new Set<number>();
    // The paths of conflicts being resolved right now, by hand or by the strategy in a sync pass: never both at once,
    // or the strategy would act against the user's choice and the row would say what didn't happen (#77)
    private readonly manualResolvingPaths = new Set<string>();
    private readonly strategyResolvingPaths = new Set<string>();
    // When each resolution ends (by its path), by hand or by the conflict setting, for a drive rename or delete of it to
    // wait for; and the paths a drive rename or delete is working on right now, which a resolution doesn't start on
    // (#112, #121)
    private readonly resolutionEnds = new Map<string, Promise<void>>();
    private readonly drivingPaths = new Map<string, number>();
    // The conflict copy a keep-both made of a file (by its path), and of what content, until that keep-both finishes or
    // the file's conflict is over some other way (resolved by hand, or the file synced): a retry after its download failed
    // goes on from it rather than make another (#25)
    // Files whose keep-both waits for them to stop changing, already said in the log (see handleFileConflict)
    private readonly keepBothDeferred = new Set<string>();
    private readonly keepBothCopies = new Map<string, { copyRelPath: string; sha1: string }>();
    // Items that keep failing in sync passes (#18), by path: the error last logged for each (logged once until it
    // changes), and how many times in a row each failed and when a pass tries it again (backoff). Both go when the item
    // syncs, or changes here.
    private readonly loggedFailures = new Map<string, string>();
    private readonly failingItems = new Map<string, { message: string; failures: number; retryAt: number }>();
    // Local files waiting to stay as they are before they upload (see stillBeingWritten): what they were at the last look
    // (size and times), since when (by the settle clock), how long they must stay so, and the next look
    // A file let through (settled) is kept a while with what it was then, so that looking at it again doesn't wait
    private readonly settlingFiles = new Map<
        string,
        {
            seen: string;
            since: number;
            quietMs: number;
            changingSince: number;
            settled: boolean;
            // Let through only because it had changed for SETTLE_MAX_WAIT_MS, not because it went quiet: still being
            // written, as far as anyone knows (see stillChangingWhenLetThrough)
            forced?: boolean;
            cancel: () => void;
        }
    >();
    // Looks again at settling files that are running now (stop() waits for them)
    private readonly runningLooks = new Set<Promise<void>>();

    constructor(
        private readonly sdk: ProtonDriveClient,
        private readonly eventsManager: EventsManager,
        private readonly auth: { isLoggedIn(): boolean },
        private readonly stateDb: SyncStateDatabase,
        private readonly logger: Logger,
        private readonly options: {
            backingDir?: string;
            moveToDesktopTrash?: MoveToDesktopTrash;
            // Deletes GNOME's failed-thumbnail record of a file by its path under the mount (see thumbnailCache)
            forgetFailedThumbnail?: (mountFullPath: string) => Promise<void>;
            moveSeams?: MoveSeams; // for tests: moving the sync folder
            // How the user is asked about an app downloading many files (sendActionNotification; for tests)
            askWithActions?: typeof sendActionNotification;
            // How many local changes are handled at once (LOCAL_CHANGE_CONCURRENCY; for tests)
            localChangeConcurrency?: number;
            // For tests: when the coalesced state changes go out (see StateEvents)
            stateEventSchedule?: (run: () => void, delayMs: number) => () => void;
            // For tests: how long what is missing while held is taken as known (FILES_MISSING_CACHE_MS; see stillMissing)
            filesMissingCacheMs?: number;
            // How long a changed file must stay as it is before it uploads (see stillBeingWritten); quietMs 0 uploads
            // at once. For tests: the clock it is timed by, and how the look once it should have settled is scheduled.
            settle?: {
                quietMs?: number;
                maxQuietMs?: number;
                maxWaitMs?: number;
                now?: () => number;
                schedule?: (run: () => Promise<void>, delayMs: number) => () => void;
            };
        } = {},
    ) {
        this.index = new RemoteIndex(this.stateDb.connection);
        this.policy = new AvailabilityPolicy(this.stateDb.connection, this.index);
        this.localChangeSlots = new Slots(options.localChangeConcurrency ?? LOCAL_CHANGE_CONCURRENCY);
        this.stateEvents = new StateEvents(options.stateEventSchedule ? { schedule: options.stateEventSchedule } : {});
        const changed = (relPath: string, subtree: boolean) =>
            subtree ? this.stateEvents.touchSubtree(relPath) : this.stateEvents.touch(relPath);
        this.index.onChange = changed;
        this.policy.onChange = changed;
        this.stateDb.onChange = changed;
        this.stateDb.onReset = () => this.stateEvents.reset();
        this.journal = new RemoteOpsJournal(this.stateDb.connection);
        this.watcher = new LocalFolderWatcher(
            () => this.localRoot(),
            (relPath) =>
                matchesIgnorePatterns(relPath, this.stateDb.getSettings().ignorePatterns) ||
                this.policy.hiddenBy(relPath)?.hide === 'hidden', // a folder being hidden still uploads its changes
            async (ev) => {
                await this.handleLocalFileChange(ev.relPath);
            },
        );
    }

    // Where the engine keeps files: the backing store in the virtual layout, the sync folder otherwise.
    // User-facing code (status, GUI, CLI paths) keeps using the sync folder.
    localRoot(): string {
        return this.inBackingStore() && this.options.backingDir ? this.options.backingDir : this.stateDb.getSettings().syncDir;
    }

    // The file Proton Drive has at a path, as far as this computer knows: the node of its edit baseline, or else of its
    // index entry, if it is still there. A network failure isn't an answer: it throws.
    private async cloudFileAt(relPath: string): Promise<NodeEntity | null> {
        const edit = this.stateDb.getEditBaseline(relPath);
        const entry = this.liveIndexEntry(relPath);
        const known = [
            edit && { uid: edit.nodeUid, parentUid: edit.parentUid },
            entry?.type === 'file' && !isProvisional(entry.uid) && { uid: entry.uid, parentUid: entry.parentUid },
        ];
        for (const node of known) {
            const there = node ? await this.nodeStillAt(node.uid, node.parentUid, relPath) : null;
            if (there) {
                return there;
            }
        }
        return null;
    }

    // A file node, if Proton Drive still has it at that path; null when it doesn't (gone or moved).
    private async nodeStillAt(uid: string, parentUid: string | null, relPath: string): Promise<NodeEntity | null> {
        let node: NodeEntity;
        try {
            node = await this.sdk.getNode(uid);
        } catch (error: unknown) {
            if (isTransient(error)) {
                throw error;
            }
            return null;
        }
        const there = !node.trashTime && node.type === NodeType.File && node.parentUid === parentUid;
        return there && getName(node) === path.posix.basename(relPath) ? node : null;
    }

    getStatus() {
        const filesMissing = this.filesMissing(); // first: it can end the hold
        const settings = this.stateDb.getSettings();
        const stats = this.stateDb.getSummaryStats();
        const loggedIn = this.auth.isLoggedIn();
        return {
            state: !loggedIn
                ? ('unauthenticated' as EngineState)
                : settings.paused
                  ? ('paused' as EngineState)
                  : this.syncingFolders.size > 0
                    ? ('syncing' as EngineState)
                    : this.state,
            currentAction: this.currentAction,
            loggedIn,
            syncDir: settings.syncDir,
            lastSyncAt: this.lastSyncAt,
            lastError: this.lastError,
            activeTransfers: Array.from(this.activeTransfers.values()),
            syncingFolders: Array.from(this.syncingFolders),
            stats,
            settings,
            filesMissing,
            accountMismatch: this.accountMismatch,
        };
    }

    async start(options: { backgroundInitialReconcile?: boolean } = {}): Promise<void> {
        this.stopped = false;
        if (this.holding()) {
            return; // Started again once the files have moved
        }
        await this.tracked(() => this.startNow(options));
    }

    private async startNow(options: { backgroundInitialReconcile?: boolean }): Promise<void> {
        const settings = this.stateDb.getSettings();
        // Made only on a fresh install (no records): a missing folder with records is the files missing (see filesGone)
        if (!this.filesGone(true)) {
            await mkdir(this.localRoot(), { recursive: true });
        }
        this.recoverLocalMove();
        await this.sweepHydrateStaging();
        this.reconcilePasses = 0;
        this.onlineOnlyCrawlDue = true;

        if (!this.auth.isLoggedIn()) {
            this.state = 'unauthenticated';
            return;
        }

        // The account checked afresh at every start, as one may follow a sign-in to another (#35): another account's
        // records are never acted on. Not told (offline), nothing acts until it is checked (see verifyAccount), and a
        // mismatch found before still holds. The watcher and cloud events start either way: what they do waits for the
        // check (verifyAccount), and they are live once the user chooses (startFreshForThisAccount)
        this.forgetAccount();
        const generation = this.accountGeneration;
        // Bounded: the daemon waits for this start before it serves the app and the drive, and a connection that hangs
        // reads as offline (the first pass, or a change, checks once the lookup answers)
        let timer: ReturnType<typeof setTimeout> | undefined;
        const root = await Promise.race([
            this.getRootFolder().catch(() => null),
            new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), START_ACCOUNT_CHECK_MS))),
        ]).finally(() => clearTimeout(timer));
        let mismatched = false;
        if (generation !== this.accountGeneration) {
            return; // Stopped meanwhile
        } else if (root !== null) {
            mismatched = !this.recordsAreOf(root.uid);
            this.accountVerified = !mismatched;
        } else if (this.stateDb.getMeta(ACCOUNT_MISMATCH) !== null) {
            this.accountMismatch = { message: ACCOUNT_MISMATCH_MESSAGE };
            mismatched = true;
        }

        if (!this.unsubscribeDriveEvents) {
            this.unsubscribeDriveEvents = this.eventsManager.addEventListener(async (context, event) => {
                if (context === 'drive') {
                    await this.handleRemoteDriveEvent(event);
                }
            });
        }

        await this.watcher.start();
        void this.eventsManager.startSubscriptions?.()?.catch((err) => {
            this.logger.warn(`Failed starting event subscriptions: ${err}`);
        });

        if (mismatched) {
            this.state = 'error';
            this.lastError = this.accountMismatch!.message;
        } else if (!settings.paused) {
            if (options.backgroundInitialReconcile) {
                void this.reconcileNow();
            } else {
                await this.reconcileNow();
            }
        } else {
            this.state = 'paused';
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.forgetAccount(); // signed out, maybe to sign in to another account: looked up again (#35)
        this.watcher.stop();
        for (const settling of this.settlingFiles.values()) {
            settling.cancel(); // The pass at the next start looks at them again
        }
        this.settlingFiles.clear();
        // A look already running isn't waited for here: holdForMove waits for it (see idleForMove), as long as it
        // allows, and a caller about to close the database waits with waitForRunningLooks
        if (this.unsubscribeDriveEvents) {
            this.unsubscribeDriveEvents();
            this.unsubscribeDriveEvents = null;
        }
        this.state = 'idle';
    }

    // Stops the engine for a move of the files between the sync folder and the backing store, and waits until nothing
    // that touches them runs any more: a sync pass, a replay, a drive change or download, an availability change, a
    // local or cloud change being handled. Until releaseHold(), nothing new starts (start() does nothing, a pass or a
    // replay asked for doesn't run, a drive change or availability change is refused with BUSY_MOVING). Waiting longer
    // than timeoutMs gives up, throwing, with the hold released (the caller starts the engine again).
    async holdForMove(opts: { timeoutMs?: number } = {}): Promise<void> {
        this.held = true;
        const deadline = Date.now() + (opts.timeoutMs ?? Number.POSITIVE_INFINITY);
        for (;;) {
            await this.stop();
            const chainSettled = await settlesWithin(this.availabilityRun, Math.max(0, Math.min(deadline - Date.now(), 200)));
            if (chainSettled && this.idleForMove()) {
                await this.stop(); // A start that finished meanwhile started the watcher
                return;
            }
            if (Date.now() >= deadline) {
                this.held = false;
                throw new Error('Proton Drive is still busy syncing; try again in a moment');
            }
            await sleep(20);
        }
    }

    releaseHold(): void {
        this.held = false;
    }

    // Held for a move (holdForMove), or the files are moving now or a move was cut short (meta layoutMoving or
    // syncDirMoving): an engine that was never held, such as the CLI's own while the daemon is stopped, finds them half
    // moved, and the half not moved yet would read as deleted here. The daemon finishes such a move with its engine held
    // and starts it once the marker is gone. Said once per marker found.
    private holding(): boolean {
        if (this.held) {
            return true;
        }
        const marker = [LAYOUT_MOVING, SYNC_DIR_MOVING].find((key) => this.stateDb.getMeta(key) !== null) ?? null;
        if (marker !== null && marker !== this.markerSeen) {
            this.logger.warn(`Proton Drive is moving files (${marker} is set): not syncing until the Proton Drive app finishes the move`);
        }
        this.markerSeen = marker;
        return marker !== null;
    }

    // #45 / S39 / #46: records exist, but not one of their files is in the local root: the folder is missing (deleted,
    // moved away, a disk not mounted), or not one recorded top-level item is in it (an emptied store). That is never taken
    // for the user deleting everything. The engine holds: nothing that reads the folder runs (no sync pass, no local
    // change handling at all, so a file saved meanwhile waits rather than being uploaded and recorded; no cloud change
    // handling), nothing is made in it, and the status says what is missing. The hold is on the recorded top-level items
    // missing when it began (filesHold.names), so nothing new in the folder can end it. It ends when every one of them is
    // back (one whose records went meanwhile, deleted through the drive, no longer counts), when the local root changes,
    // or when the user confirms they were deleted on purpose (confirmFilesMissingDeleted). A top-level folder back is not
    // all of it back (a restore by copy makes the folder first): until a pass has looked at what is missing after a hold,
    // nothing missing is taken for a delete (see heldBack), and whatever recorded item is still missing then, at any
    // depth, is held again (see lookAfterHold). A partial loss with no hold before it (some recorded top-level item still
    // there) is the user deleting those items, as ever. The hold is saved (meta FILES_HOLD), so it outlives a restart.
    // Looked at each time, afresh with `fresh` (a sync pass), else at most once a second (see stillMissing); said once.
    private filesGone(fresh = false): boolean {
        const root = this.localRoot();
        this.resumeSavedHold(root);
        if (this.filesHold !== null && this.filesHold.root !== root) {
            this.endFilesHold();
        }
        if (this.filesHold !== null) {
            const missing = this.stillMissing(fresh);
            if (missing.names.length > 0) {
                this.noteFilesGone(root, missing);
                return true;
            }
            this.endFilesHold();
            return false;
        }
        const names = this.stateDb.recordedTopLevelNames();
        if (names.length === 0 || (isFolderAt(root) && names.some((name) => itemIn(root, name)))) {
            return false;
        }
        const confirmed = this.missingConfirmed;
        if (confirmed?.root === root && names.every((name) => confirmed.names.has(name))) {
            return false; // the user said these were deleted on purpose: the pass takes them for deletes
        }
        this.filesGoneSaid = null; // A new loss: said again, even before the look after the last hold
        this.holdFiles(root, names);
        return true;
    }

    private holdFiles(root: string, names: string[]): void {
        this.filesHold = { root, names };
        this.stateDb.setMeta(FILES_HOLD, JSON.stringify(this.filesHold));
        this.noteFilesGone(root, this.stillMissing(true));
    }

    // A hold saved by an earlier run (the daemon restarted, or the CLI's own engine runs while the daemon is stopped) is
    // taken up again, once, if it is on the same folder (filesGone then ends it if nothing is missing any more). One on
    // another folder isn't, but the pass after it still looks at what is missing (see lookAfterHold). Callers check
    // holding() first: while the files move, the folder is half moved.
    private resumeSavedHold(root: string): void {
        if (this.filesHoldResumed) {
            return;
        }
        this.filesHoldResumed = true;
        const saved = parseFilesHold(this.stateDb.getMeta(FILES_HOLD));
        if (this.filesHold === null && saved?.root === root) {
            this.filesHold = saved;
        }
    }

    // The hold's items still missing and still recorded, how many records are at and under them, and whether every
    // recorded item is missing (not one recorded top-level item is there). What asks often (the status, local changes,
    // the drive) takes what was found less than a second ago (filesMissingCacheMs); `fresh` looks again.
    private stillMissing(fresh = false): MissingItems {
        const hold = this.filesHold;
        if (hold === null) {
            return { names: [], items: 0, whole: false };
        }
        const cached = this.missingKnown;
        if (!fresh && cached?.hold === hold && Date.now() - cached.at < (this.options.filesMissingCacheMs ?? FILES_MISSING_CACHE_MS)) {
            return cached.missing;
        }
        const rootThere = isFolderAt(hold.root); // looked at once, not for every item
        const names: string[] = [];
        let items = 0;
        for (const name of hold.names) {
            const recorded = rootThere && itemIn(hold.root, name) ? 0 : this.stateDb.countItemsUnder(name);
            if (recorded > 0) {
                names.push(name);
                items += recorded;
            }
        }
        // All of them when not one recorded top-level item is there (those just found missing aren't looked at again)
        const known = new Set(names);
        const whole =
            !rootThere || !this.stateDb.recordedTopLevelNames().some((name) => !known.has(name) && itemIn(hold.root, name));
        const missing: MissingItems = { names, items, whole };
        this.missingKnown = { hold, at: Date.now(), missing };
        return missing;
    }

    // Whether the engine keeps the files in the backing store (the virtual layout), not in the sync folder
    private inBackingStore(): boolean {
        return readDriveLayout(this.stateDb) === 'virtual' && Boolean(this.options.backingDir);
    }

    // The status's root, which a confirmation names: the sync folder, in the virtual layout too
    private shownRoot(): string {
        return this.stateDb.getSettings().syncDir;
    }

    // Where the messages say the files are missing from, in the user's terms (see missingPlace)
    private shownPlace(): string {
        return missingPlace(this.stateDb.getSettings().syncDir, this.inBackingStore());
    }

    private noteFilesGone(root: string, missing: MissingItems): void {
        const message = filesMissingMessage(this.shownPlace(), missing);
        this.state = 'error';
        this.lastError = message;
        this.filesGoneError = message;
        this.currentAction = null;
        if (this.filesGoneSaid === root) {
            return;
        }
        this.filesGoneSaid = root;
        this.logger.warn(this.inBackingStore() ? `${message} (the virtual drive keeps them in ${root})` : message);
        this.stateDb.logActivity({ action: 'error', localRelPath: '/', details: message });
        sendDesktopNotification({
            title: 'Proton Drive: files missing',
            body: message,
            urgency: 'critical',
            enabled: this.stateDb.getSettings().notificationsEnabled,
        });
    }

    // Ends the hold, but not the look at what is missing after it (meta FILES_HOLD stays until a pass has looked)
    private endFilesHold(): void {
        const hold = this.filesHold;
        this.filesHold = null;
        this.missingKnown = null;
        if (hold === null) {
            return;
        }
        if (this.lastError !== null && this.lastError === this.filesGoneError) {
            this.lastError = null;
            if (this.state === 'error') {
                this.state = 'idle';
            }
        }
        this.filesGoneError = null;
        this.logger.info(`Proton Drive's files are back in ${hold.root}, or no longer waited for`);
        // A folder that went away leaves its watchers quiet: the one back is watched afresh
        if (this.unsubscribeDriveEvents) {
            this.watcher.stop();
            void this.watcher.start().catch(() => {});
        }
    }

    // Whether a recorded item missing here is left alone rather than taken for a delete, by a sync pass or by local
    // change handling: after a hold, until a pass has looked at what is missing (meta FILES_HOLD set, see lookAfterHold),
    // all but what the user confirmed are
    private heldBack(relPath: string): boolean {
        if (this.stateDb.getMeta(FILES_HOLD) === null) {
            return false;
        }
        const confirmed = this.missingConfirmed;
        return !(confirmed?.root === this.localRoot() && [...confirmed.names].some((name) => isWithin(relPath, name)));
    }

    // At the end of every sync pass after a hold (#46) until one has looked: whatever recorded item is still missing is
    // held again (the topmost of them, at any depth), for the user to bring back or confirm as deleted, and the user is
    // told, as for the first hold; with nothing missing, the hold is over. A restore by copy that has made a folder but not
    // yet copied all of it is held again on what it has yet to copy, however many passes that takes.
    private lookAfterHold(confirmation: { root: string; names: Set<string> } | null): void {
        if (this.filesHold !== null || this.stateDb.getMeta(FILES_HOLD) === null) {
            return; // No hold to look after, or held again meanwhile
        }
        const root = this.localRoot();
        const confirmed = confirmation?.root === root ? [...confirmation.names] : [];
        // What the user confirmed as deleted isn't held again, even if its trash failed: the next pass tries again
        const names = this.missingRecordedItems().filter((rel) => !confirmed.some((name) => isWithin(rel, name)));
        if (names.length === 0) {
            this.stateDb.deleteMeta(FILES_HOLD);
            this.filesGoneSaid = null;
            return;
        }
        const details = `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} still missing from ${this.shownPlace()} after the files came back. Nothing was deleted in Proton Drive; Proton Drive waits for them.`;
        this.logger.warn(details);
        this.stateDb.logActivity({ action: 'error', localRelPath: '/', details });
        sendDesktopNotification({
            title: 'Proton Drive: files still missing',
            body: details,
            urgency: 'critical',
            enabled: this.stateDb.getSettings().notificationsEnabled,
        });
        this.filesGoneSaid = root; // Told above: not as everything missing again
        this.holdFiles(root, names);
    }

    // The topmost recorded items missing from the local root, leaving out those a pass leaves alone: ignored, hidden, or
    // with a rename, move or delete through the drive on its way to Proton Drive
    private missingRecordedItems(): string[] {
        const root = this.localRoot();
        const rootThere = isFolderAt(root); // looked at once, not for every record
        const ignorePatterns = this.stateDb.getSettings().ignorePatterns;
        const { uids, paths } = this.journal.guard();
        const missing = new Set<string>();
        const underMissing = (rel: string) => {
            for (let p = parentOf(rel); p !== ''; p = parentOf(p)) {
                if (missing.has(p)) {
                    return true;
                }
            }
            return false;
        };
        for (const item of this.stateDb.getAllItems()) {
            const rel = item.localRelPath; // parents come before what is in them
            if (
                underMissing(rel) ||
                (rootThere && itemIn(root, rel)) ||
                matchesIgnorePatterns(rel, ignorePatterns) ||
                this.policy.hiddenBy(rel)?.hide === 'hidden' ||
                uids.has(item.nodeUid) ||
                paths.some((p) => isWithin(rel, p))
            ) {
                continue;
            }
            missing.add(rel);
        }
        return [...missing];
    }

    // What is missing while the files are held as missing (see filesGone), for the status: the sync folder (the root a
    // confirmation names), the recorded items still missing, how many records are at and under them, and what the
    // status says about it (lastError). None while the files move between the sync folder and the backing store: the
    // folder is half moved, and is looked at once they have.
    filesMissing(fresh = false): FilesMissingStatus | null {
        if (this.holding()) {
            return null;
        }
        this.resumeSavedHold(this.localRoot());
        if (this.filesHold === null || !this.filesGone(fresh)) {
            return null;
        }
        const missing = this.stillMissing();
        return {
            root: this.shownRoot(),
            names: missing.names,
            items: missing.items,
            message: filesMissingMessage(this.shownPlace(), missing),
        };
    }

    // The user says the missing files were deleted on purpose (the GUI's "Delete them from Proton Drive too", POST
    // /sync/files-missing {action: 'delete-in-cloud', root, names}): the hold ends, and the next sync pass takes those
    // items for deletes, moving them to the Proton Drive trash: through the tree, or by their recorded nodes where the
    // pass can't reach them (see trashConfirmedOutOfReach). That pass uses the confirmation up: anything else missing
    // after it is held again. `expected` is what the user was shown (filesMissing's root and names): it must still be
    // exactly what is missing, in any order, or the confirmation is refused, as what would be deleted is no longer what
    // the user agreed to. Answers what was confirmed. Throws FilesMissingRefused (409) when nothing is held, for a
    // mismatch, or while the files move between the sync folder and the backing store; DriveOpError (EIO) while the
    // account signed in to can't be checked to be the records' (offline), or is another's (#35).
    async confirmFilesMissingDeleted(expected: { root: string; names: string[] }): Promise<FilesMissingStatus> {
        await this.refuseUntilAccountChecked(); // about the records of the account they are of (#35)
        const { root, missing } = this.shownMissing(expected, 'nothing was deleted');
        this.missingConfirmed = { root, names: new Set(missing.names) };
        this.endFilesHold();
        const details = `The ${missing.items} item(s) missing from ${this.shownPlace()} (${listNames(missing.names)}) were deleted on purpose: they go to the Proton Drive trash`;
        this.logger.warn(details);
        this.stateDb.logActivity({ action: 'sync', localRelPath: '/', details });
        void this.reconcileNow();
        return missing;
    }

    // The user keeps the missing items in Proton Drive, online-only (the GUI's "Keep them online-only", POST
    // /sync/files-missing {action: 'keep-online-only', root, names}; #50): nothing is deleted, on this computer or in
    // Proton Drive. Their records go (records before files: there are no files), so nothing of them reads as deleted
    // later; and what of them was kept on this device stops being kept (an explicit unpin, as Free up space gives), so
    // nothing comes down again. They show as online-only, in the drive and in My files, and the hold ends. `expected` is
    // checked as for confirmFilesMissingDeleted. Answers what was kept. Throws FilesMissingRefused (409) when nothing is
    // held, for a mismatch, or while the files move between the sync folder and the backing store; DriveOpError (EIO)
    // while the account can't be checked to be the records', or is another's (#35).
    async keepFilesMissingOnlineOnly(expected: { root: string; names: string[] }): Promise<FilesMissingStatus> {
        await this.refuseUntilAccountChecked(); // about the records of the account they are of (#35)
        const { missing } = this.shownMissing(expected, 'nothing was changed');
        this.stateDb.connection.transaction(() => {
            for (const name of missing.names) {
                if (this.policy.isPinned(name) || this.policy.hasPinnedBelow(name)) {
                    const uid = this.stateDb.getItemByPath(name)?.nodeUid ?? this.index.getByPath(name)?.uid;
                    if (uid && !isProvisional(uid)) {
                        this.policy.setPin(uid, 'unpinned', true);
                    } else {
                        // Not in the listing kept here (nor recorded itself): each recorded item under it, by its own uid
                        for (const item of this.stateDb.getItemsUnder(name)) {
                            this.policy.setPin(item.nodeUid, 'unpinned', true);
                        }
                    }
                }
                this.stateDb.removeItemByPath(name);
            }
        })();
        this.endFilesHold();
        const details = `The ${missing.items} item(s) missing from ${this.shownPlace()} (${listNames(missing.names)}) stay in Proton Drive, online-only: nothing was deleted`;
        this.logger.info(details);
        this.stateDb.logActivity({ action: 'sync', localRelPath: '/', details });
        void this.reconcileNow();
        return missing;
    }

    // What is missing now, checked against what the user was shown (`expected`, filesMissing's root and names) before
    // acting on it: the folder held, and the hold's names, in any order. Throws FilesMissingRefused (409) when nothing is
    // held, for a mismatch (saying `nothingDone`), or while the files move between the sync folder and the backing store.
    private shownMissing(expected: { root: string; names: string[] }, nothingDone: string): { root: string; missing: FilesMissingStatus } {
        if (this.holding()) {
            throw new FilesMissingRefused(BUSY_MOVING);
        }
        this.resumeSavedHold(this.localRoot());
        const hold = this.filesGone(true) ? this.filesHold : null;
        const missing = hold === null ? null : this.filesMissing();
        if (hold === null || missing === null || missing.names.length === 0) {
            throw new FilesMissingRefused(`Nothing is missing from ${this.shownPlace()}`);
        }
        const sorted = (names: readonly string[]) => JSON.stringify([...names].sort());
        if (expected.root !== missing.root || sorted(expected.names) !== sorted(missing.names)) {
            throw new FilesMissingRefused(
                `What is missing from ${this.shownPlace()} has changed (now ${listNames(missing.names)}): ${nothingDone}; look again`,
            );
        }
        return { root: hold.root, missing };
    }

    // What would make something in the local root is refused while the files are missing from it
    private refuseWhileFilesGone(): void {
        if (this.filesGone()) {
            throw new DriveOpError('EIO', this.filesGoneError ?? filesMissingMessage(this.shownPlace()));
        }
    }

    private idleForMove(): boolean {
        return (
            this.inFlight === 0 &&
            !this.reconcileRunning &&
            this.replayRun === null &&
            this.localQueue.size === 0 &&
            this.hydrations.size === 0 &&
            this.runningLooks.size === 0
        );
    }

    // Work that touches the files, counted for holdForMove
    private async tracked<T>(work: () => Promise<T>): Promise<T> {
        this.inFlight += 1;
        try {
            return await work();
        } finally {
            this.inFlight -= 1;
        }
    }

    async setPaused(paused: boolean): Promise<void> {
        this.stateDb.updateSettings({ paused });
        if (paused) {
            this.state = 'paused';
            this.stateDb.logActivity({
                action: 'sync',
                localRelPath: '/',
                details: 'Synchronization paused by user',
            });
        } else {
            this.state = 'idle';
            this.stateDb.logActivity({
                action: 'sync',
                localRelPath: '/',
                details: 'Synchronization resumed by user',
            });
            await this.reconcileNow();
        }
    }

    async relocateSyncFolder(oldSyncDir: string, newSyncDirRaw: string): Promise<string> {
        const home = os.homedir();
        const resolvedNew = resolveSyncDirInput(newSyncDirRaw);
        const resolvedOld = path.resolve(oldSyncDir);

        if (resolvedNew === '/' || resolvedNew === home) {
            throw new Error('Cannot use root (/) or home (~) directory directly as the Proton Drive sync folder.');
        }

        if (resolvedNew === resolvedOld) {
            return resolvedNew;
        }

        // The files are in the backing store, not the sync folder: only the setting changes (the mount moves with it)
        if (readDriveLayout(this.stateDb) === 'virtual') {
            this.stateDb.updateSettings({ syncDir: resolvedNew });
            return resolvedNew;
        }
        if (pathsOverlap(resolvedNew, resolvedOld)) {
            throw new Error(`${resolvedNew} and ${resolvedOld} are inside one another; choose a folder outside the current Proton Drive folder`);
        }

        // Nothing may look at the files while they move: a half-moved folder reads as files deleted here. A move that
        // can't finish stays marked, with the engine held, for the next start to finish (see finishRelocation).
        try {
            await this.holdForMove({ timeoutMs: RELOCATE_HOLD_TIMEOUT_MS });
            this.recoverLocalMove();
            await relocateFiles({
                stateDb: this.stateDb,
                from: resolvedOld,
                to: resolvedNew,
                logger: this.logger,
                seams: this.options.moveSeams,
            });
        } catch (error: unknown) {
            if (this.stateDb.getMeta(SYNC_DIR_MOVING) === null) {
                this.releaseHold(); // Nothing moved
                await this.start({ backgroundInitialReconcile: true });
            }
            throw error;
        }
        this.releaseHold();
        this.stateDb.logActivity({
            action: 'sync',
            localRelPath: '/',
            details: `Relocated local sync folder from ${resolvedOld} to ${resolvedNew}`,
        });
        await this.start({ backgroundInitialReconcile: true });
        return resolvedNew;
    }

    // Whether a local file is exactly what Proton Drive holds, so removing its local copy loses nothing.
    private async isUnchangedSyncedCopy(
        relPath: string,
        fullPath: string,
        st: { size: number; mtimeMs: number; ctimeMs?: number },
    ): Promise<boolean> {
        const record = this.stateDb.getItemByPath(relPath);
        // What Proton Drive held when the record was made: the SHA1 it claims, or for a node that claims none, the SHA1
        // of what came down from it (a record with no SHA1 for the cloud side is only made by a download)
        const held = record?.remoteSha1 ?? record?.localSha1;
        if (!record || record.type !== 'file' || record.syncStatus !== 'synced' || !held) {
            return false;
        }
        // Size and mtime say unchanged only if nothing wrote to it since the record: the ctime, which the system sets on
        // every write, says so; an edit that keeps the size and puts the old mtime back (a container, cp -p) is hashed (#105)
        if (
            st.size === record.size &&
            Math.abs(st.mtimeMs - record.localMtimeMs) < 10 &&
            notWrittenSince(st, record) &&
            record.localSha1 === held
        ) {
            return true;
        }
        return (await computeLocalFileSha1(fullPath).catch(() => null)) === held;
    }

    markFoldersSyncing(folderNames: string[]): void {
        for (const name of folderNames) {
            const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
            if (trimmed) {
                this.syncingFolders.add(trimmed);
            }
        }
        if (this.syncingFolders.size > 0 && this.auth.isLoggedIn() && !this.stateDb.getSettings().paused) {
            this.state = 'syncing';
        }
    }

    async reconcileNow(): Promise<void> {
        if (this.holding()) {
            return; // The pass after the move, at start(), looks at everything
        }
        if (!this.auth.isLoggedIn()) {
            this.state = 'unauthenticated';
            return;
        }
        const settings = this.stateDb.getSettings();
        if (settings.paused) {
            this.state = 'paused';
            return;
        }
        if (this.reconcileRunning) {
            this.reconcileQueued = true;
            return;
        }
        if (this.filesGone(true)) {
            return; // Looked at again at the next pass
        }
        // This pass takes the items the user confirmed as deleted for deletes, and uses the confirmation up (unless an
        // item it touches failed: then the next pass does)
        const confirmation = this.missingConfirmed;
        let keepConfirmation = false;

        this.reconcileRunning = true;
        this.state = 'syncing';
        this.currentAction = 'Starting sync...';
        this.lastError = null;
        this.reconcilePasses += 1;
        // Taken now, so a crawl asked for while this pass runs is left to the next one
        const crawl = this.onlineOnlyCrawlDue || this.reconcilePasses % ONLINE_ONLY_CRAWL_EVERY === 0;
        this.onlineOnlyCrawlDue = false;

        try {
            this.recoverLocalMove();
            await mkdir(this.localRoot(), { recursive: true });
            const generation = this.accountGeneration;
            const root = await this.getRootFolder();
            if (generation !== this.accountGeneration) {
                // Stopped or started again meanwhile, maybe signed in to another account: this root checks nothing (#35)
                this.currentAction = null;
                return;
            }
            // Signed in to another account than the records are of: nothing of them is acted on (#35). The root the pass
            // works with is the one checked; one that can't be had (offline) fails the pass, as before, and checks nothing
            if (!this.recordsAreOf(root.uid)) {
                this.state = 'error';
                this.lastError = this.accountMismatch!.message;
                this.currentAction = null;
                return;
            }
            this.accountVerified = true;
            await this.eventsManager.subscribeDriveScope(root.treeEventScopeId);
            this.index.setRoot(root.uid);
            if (this.stateDb.getMeta(PIN_ROOT_ON_FIRST_SYNC) === '1') {
                // A fresh install syncs everything, as before
                this.stateDb.connection.transaction(() => {
                    this.policy.setPin(root.uid, 'pinned', false);
                    this.stateDb.deleteMeta(PIN_ROOT_ON_FIRST_SYNC);
                })();
            }
            await this.inAvailabilityRun(async () => this.dropStaleEditBaselines());
            // Changes made through the drive reach Proton Drive before the pass looks at it
            await this.runReplay();

            // Sync folder-by-folder incrementally so files & folders appear in ~/ProtonDrive
            // and in the GUI dashboard immediately instead of waiting for a full tree scan.
            const remoteMap = new Map<string, NodeEntity>();
            const onlineOnly: OnlineOnlyFolder[] = [];
            const failed: SyncFailure[] = [];
            await this.observingLocal((since) =>
                this.reconcileDirectoryIncremental(root, '', remoteMap, this.stateDb.getSettings(), since, onlineOnly, failed),
            );
            // The user's confirmed deletes wait for a pass that got through everything they touch
            const confirmedTouchFailed =
                confirmation !== null &&
                failed.some((f) => [...confirmation.names].some((name) => isWithin(f.relPath, name) || isWithin(name, f.relPath)));
            if (confirmation !== null && !confirmedTouchFailed) {
                await this.trashConfirmedOutOfReach(confirmation);
            } else if (confirmedTouchFailed) {
                keepConfirmation = true;
            }
            // Hides that were waiting for uploads finish once those are done
            await this.completePendingHides();
            // Last, so nothing on this computer waits behind it
            if (crawl) {
                await this.crawlOnlineOnly(onlineOnly);
            }

            this.lastSyncAt = Date.now();
            if (failed.length > 0) {
                // Everything else synced; these are tried again at the next pass
                const first = failed[0]!;
                this.lastError =
                    failed.length === 1
                        ? `Could not sync ${first.relPath}: ${first.message}`
                        : `Could not sync ${failed.length} items (${first.relPath}: ${first.message}, and others)`;
                this.currentAction = null;
                this.state = 'error';
            } else if (this.syncingFolders.size === 0) {
                this.currentAction = null;
                this.state = this.stateDb.getSettings().paused ? 'paused' : 'idle';
            }
        } catch (error: unknown) {
            if (crawl) {
                this.onlineOnlyCrawlDue = true; // The next pass crawls instead
            }
            const msg = error instanceof Error ? error.message : String(error);
            // A mismatch known is what the user needs to hear of, not that the pass couldn't reach Proton Drive (#35)
            this.lastError = this.accountMismatch?.message ?? msg;
            this.currentAction = null;
            this.state = 'error';
            this.logger.error('Reconcile failed', error);
            this.stateDb.logActivity({
                action: 'error',
                localRelPath: '/',
                details: `Sync error: ${msg}`,
            });
        } finally {
            this.reconcileRunning = false;
            // Also after a pass that failed or was cut short: what is missing is looked at here, not in the pass
            try {
                this.lookAfterHold(confirmation);
            } catch (error: unknown) {
                this.logger.warn(`Could not look at what is missing after the files came back; the next pass looks again: ${error}`);
            }
            if (confirmation !== null && this.missingConfirmed === confirmation && !keepConfirmation) {
                this.missingConfirmed = null;
            }
            if (this.replayAfterPass) {
                this.replayAfterPass = false;
                void this.runReplay();
            }
            if (this.reconcileQueued) {
                this.reconcileQueued = false;
                void this.reconcileNow();
            }
        }
    }

    private async reconcileSinglePath(
        relPath: string,
        remoteNode: NodeEntity | undefined,
        localInfo: { isDirectory: boolean; size: number; mtimeMs: number; ctimeMs?: number } | undefined,
        dbRecord: SyncedItemRecord | undefined,
        remoteMap: Map<string, NodeEntity>,
        settings: SyncSettings,
        since: number,
    ): Promise<void> {
        if (this.awaitsRemoteOp(relPath, remoteNode?.uid)) {
            return; // A rename, move or delete through the drive is on its way to Proton Drive: looked at once it is there
        }
        const localFullPath = path.join(this.localRoot(), relPath);
        const hiddenBy = this.policy.hiddenBy(relPath);
        if (hiddenBy?.hide === 'hidden') {
            return; // Hidden: never downloaded, uploaded or trashed from here
        }
        // Being hidden: its local changes (edits, new files, deletes) sync as for a visible item, so the hide can
        // finish, but nothing new comes down from the cloud
        const hiding = hiddenBy !== null;
        // A file still being written is left alone (not uploaded, nor downloaded over) until it stays as it is
        if (localInfo && !localInfo.isDirectory && changedSinceRecord(localInfo, dbRecord)) {
            const st = await stat(localFullPath).catch(() => null);
            if (st?.isFile() && this.stillBeingWritten(relPath, st)) {
                return;
            }
        }

        // Case 1: Present remotely, not present locally
        if (remoteNode && !localInfo) {
            if (dbRecord) {
                // Was previously synced, so user deleted it locally -> trash remotely. Look again first: the listing
                // can predate the record being dropped (e.g. by Free up space or Hide) or the item coming back; either
                // way the next pass, with a fresh listing, deals with it.
                const stillTracked = this.stateDb.getItemByPath(relPath) !== null;
                const backLocally = await stat(localFullPath).then(
                    () => true,
                    () => false,
                );
                // Not after a hold, until a pass has looked at what is missing (#46): it may not be back yet
                if (stillTracked && !backLocally && !this.heldBack(relPath)) {
                    await this.trashForDeletedLocal(relPath, remoteNode);
                }
                return;
            }
            // Renamed or moved in the cloud, with its local copy still at the old path: that copy moves here, rather
            // than a new one coming down
            const recorded = this.stateDb.getItemByNodeUid(remoteNode.uid);
            if (recorded?.localRelPath === relPath) {
                return; // Moved here earlier in this pass, after the listing was read: the next look at it syncs it
            }
            if (recorded && this.isResolving(recorded.localRelPath)) {
                return; // Moved in Proton Drive while its conflict is being resolved: the next pass follows it (#104, #140)
            }
            if (
                recorded &&
                (await this.existsLocally(recorded.localRelPath)) &&
                (await this.followRemoteMove(remoteNode.uid, recorded.localRelPath, relPath))
            ) {
                return;
            }
            if (hiding) {
                return;
            }
            // New remote item: it comes to this computer only when pinned, and a folder also to hold something pinned
            // further down (it stays online-only itself). Hidden items never get here (checked above, as isPinned can
            // be true below a hidden folder).
            if (remoteNode.type === NodeType.Folder) {
                if (!this.policy.isPinned(relPath) && !this.policy.hasPinnedBelow(relPath)) {
                    return;
                }
                this.watcher.suppressPath(relPath);
                await mkdir(localFullPath, { recursive: true });
                const st = await stat(localFullPath);
                this.recordSynced({
                    localRelPath: relPath,
                    nodeUid: remoteNode.uid,
                    parentNodeUid: remoteNode.parentUid ?? null,
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: st.mtimeMs,
                    remoteMtimeMs: remoteNode.modificationTime.getTime(),
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                }, since);
                this.stateDb.logActivity({
                    action: 'mkdir',
                    localRelPath: relPath,
                    details: 'Created local folder from Proton Drive',
                });
            } else if (
                remoteNode.type === NodeType.File &&
                !isUnsupportedRemoteNode(remoteNode) &&
                this.policy.isPinned(relPath)
            ) {
                // Looked at again, as the listing was read a while ago: a download would replace whatever was put here
                // since (such as what stopped a move here); the next pass syncs it as something on both sides
                if (await this.existsLocally(relPath)) {
                    return;
                }
                // Never one the user deleted (or renamed) through the drive since this work began, nor one in the
                // Proton Drive trash now: the listing it came from may predate its delete, and downloading it would
                // bring back what was deleted, gigabytes of it for nothing (#179)
                if (this.driveTouched(relPath, since)) {
                    return;
                }
                const live = await this.liveNode(remoteNode.uid);
                if (!live) {
                    return;
                }
                // And again once its bytes are in, before it is put in place: deleted while it downloaded, it stays gone
                const stillWanted = async () =>
                    !this.driveTouched(relPath, since) && (await this.liveNode(live.uid).catch(() => live)) !== null;
                await this.downloadRemoteToLocal(relPath, live, localFullPath, since, stillWanted);
            }
            return;
        }

        // Case 2: Present locally, not present remotely
        if (localInfo && !remoteNode) {
            if (dbRecord) {
                // Was previously synced, so it was renamed or moved on Proton Drive, or deleted or trashed there
                await this.afterGoneFromCloudPath(relPath);
                return;
            }
            // New local item -> upload/create on Proton Drive
            const parentNode = await this.ensureParentFolderNode(relPath, remoteMap, since);
            if (localInfo.isDirectory) {
                const held = await this.trashHold(parentNode);
                if (held) {
                    // Its folder is in the Proton Drive trash: made there, it would be recorded as synced, and the folder's
                    // removal here would take it for an unchanged copy. Left here unrecorded, which that removal keeps (#160)
                    this.logger.warn(`Not making ${relPath} in Proton Drive: ${held}`);
                    return;
                }
                const { node: createdFolder, created } = await createRemoteFolder(this.sdk, parentNode, path.basename(relPath));
                remoteMap.set(relPath, createdFolder);
                this.indexCreatedFolder(createdFolder, relPath);
                const item: Omit<SyncedItemRecord, 'updatedAt'> = {
                    localRelPath: relPath,
                    nodeUid: createdFolder.uid,
                    parentNodeUid: createdFolder.parentUid ?? parentNode.uid,
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: localInfo.mtimeMs,
                    remoteMtimeMs: createdFolder.modificationTime.getTime(),
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                };
                if (!this.recordSynced(item, since) && created) {
                    this.adoptStrayNode(relPath, item, since);
                }
                this.stateDb.logActivity({
                    action: 'mkdir',
                    localRelPath: relPath,
                    details: 'Created folder on Proton Drive',
                });
                if (this.journal.hasPending()) {
                    void this.replayRemoteOps(); // A move into it may have been waiting for it
                }
            } else {
                // A file of that name that Proton Drive got after the listing is found by the upload being refused, and
                // judged as if listed (the conflict handling, or its edit baseline), never uploaded over as a revision
                const there = await this.uploadNewFile(relPath, localFullPath, parentNode, since);
                if (there) {
                    const dbRecordNow = this.recordOf(relPath, there.uid);
                    await this.reconcileSinglePath(relPath, there, localInfo, dbRecordNow, remoteMap, settings, since);
                }
            }
            return;
        }

        // Case 3: Deleted both locally and remotely, cleanup stale DB record
        if (!localInfo && !remoteNode && dbRecord) {
            this.stateDb.removeItemByPath(relPath);
            return;
        }

        // Case 4: Present both locally and remotely
        if (localInfo && remoteNode) {
            if (localInfo.isDirectory && remoteNode.type === NodeType.Folder) {
                if (!dbRecord) {
                    this.recordSynced({
                        localRelPath: relPath,
                        nodeUid: remoteNode.uid,
                        parentNodeUid: remoteNode.parentUid ?? null,
                        type: 'folder',
                        localSha1: null,
                        remoteSha1: null,
                        localMtimeMs: localInfo.mtimeMs,
                        remoteMtimeMs: remoteNode.modificationTime.getTime(),
                        size: 0,
                        syncStatus: 'synced',
                        lastError: null,
                    }, since);
                }
                return;
            }

            if (!localInfo.isDirectory && remoteNode.type === NodeType.File) {
                if (isUnsupportedRemoteNode(remoteNode)) {
                    return;
                }
                const remoteSha1 = remoteNode.activeRevision?.claimedDigests?.sha1 ?? null;
                const remoteMtimeMs = (
                    remoteNode.activeRevision?.claimedModificationTime ?? remoteNode.modificationTime
                ).getTime();

                // What the record says the cloud held when it was made (its size is the local one, the same then)
                const remoteAtSync: CloudVersion | null = dbRecord
                    ? { sha1: dbRecord.remoteSha1, mtimeMs: dbRecord.remoteMtimeMs, size: dbRecord.size }
                    : null;
                // A node that claims no size has none to compare: against a record, its size is no change (its time and
                // SHA1 still count); an edit baseline kept it as 0, as the remote index does
                const remoteNow: CloudVersion = {
                    sha1: remoteSha1,
                    mtimeMs: remoteMtimeMs,
                    size: getClaimedSize(remoteNode) ?? remoteAtSync?.size ?? 0,
                };

                // Fast path: the local file's time and size match the record, and the cloud hasn't changed since it: no
                // SHA1 recomputation needed
                // A conflict still waiting here is looked at in full, so that once both sides hold the same content
                // (synced by a download, say) it is closed (#68)
                if (
                    dbRecord &&
                    remoteAtSync &&
                    dbRecord.syncStatus === 'synced' &&
                    !this.stateDb.hasWaitingConflict(relPath) &&
                    notWrittenSince(localInfo, dbRecord) &&
                    Math.abs(localInfo.mtimeMs - dbRecord.localMtimeMs) < 10 &&
                    localInfo.size === dbRecord.size &&
                    !cloudChangedSince(remoteAtSync, remoteNow)
                ) {
                    return;
                }

                const hashedFrom = Date.now(); // a write from here on is newer than what the hash below reads
                const localSha1 = await computeLocalFileSha1(localFullPath).catch((error: unknown) => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        this.logger.warn(`Could not read ${relPath} to compare it with Proton Drive: ${error}`);
                    }
                    return null;
                });
                if (localSha1 === null) {
                    return; // Gone (freed, say) or unreadable since it was listed: the next pass looks again
                }
                if (remoteSha1 && localSha1 === remoteSha1) {
                    const synced = this.recordSynced({
                        localRelPath: relPath,
                        nodeUid: remoteNode.uid,
                        parentNodeUid: remoteNode.parentUid ?? null,
                        type: 'file',
                        localSha1,
                        remoteSha1,
                        localMtimeMs: localInfo.mtimeMs,
                        remoteMtimeMs,
                        size: localInfo.size,
                        syncStatus: 'synced',
                        lastError: null,
                        contentReadAt: hashedFrom, // what the hash read: a write during it is newer (#109)
                    }, since);
                    // Both sides were just compared and hold the same content: a conflict waiting for the user here is
                    // over (#68). Only here: a record written as synced elsewhere (an upload by the watcher, say) says
                    // nothing about what the other side holds
                    if (synced && !this.manualResolvingPaths.has(relPath)) {
                        this.stateDb.closeWaitingConflict(relPath, 'in-sync');
                    }
                    return;
                }

                // With no record, a file the drive turned from online-only into local (POST /vfs/truncate) is an edit
                // of the version the drive showed then: a new revision of it if the cloud still has that, the conflict
                // handling if the cloud changed since or has another node there. Without a baseline it is a new file.
                const edit = dbRecord ? null : this.stateDb.getEditBaseline(relPath);
                const editOfThis = edit?.nodeUid === remoteNode.uid ? edit : null;
                const localChangedSinceSync = !dbRecord || localSha1 !== dbRecord.localSha1;
                const remoteChangedSinceSync = remoteAtSync
                    ? cloudChangedSince(remoteAtSync, remoteNow)
                    : !editOfThis || cloudChangedSince(editOfThis, remoteNow);

                if (localChangedSinceSync && !remoteChangedSinceSync) {
                    const parentNode = await this.ensureParentFolderNode(relPath, remoteMap, since);
                    await this.uploadLocalToRemote(relPath, localFullPath, parentNode, since, remoteNode.uid);
                } else if (!localChangedSinceSync && remoteChangedSinceSync) {
                    if (!hiding) {
                        await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath, since);
                    }
                } else if (localChangedSinceSync && remoteChangedSinceSync) {
                    await this.handleFileConflict(
                        relPath,
                        localFullPath,
                        remoteNode,
                        localSha1,
                        remoteSha1,
                        localInfo.mtimeMs,
                        remoteMtimeMs,
                        remoteMap,
                        settings,
                        since,
                        dbRecord,
                    );
                } else if (dbRecord && dbRecord.syncStatus === 'synced' && localSha1 === dbRecord.localSha1) {
                    // Neither side changed: only the ctime moved (a chmod, a rename, a layout move). The record is current
                    // as of before the hash, so the next pass's fast path applies again instead of hashing on every pass
                    // (a cloud file with no sha1 never reaches the equal-content branch that would re-record it, #105)
                    this.stateDb.touchItem(relPath, hashedFrom);
                    // And both sides hold what the record says, the cloud's version (synced by a download, say): a
                    // conflict still waiting here is over, as the equal-content branch closes one for a cloud with a
                    // sha1 (#68, #88)
                    if (!this.manualResolvingPaths.has(relPath)) {
                        this.stateDb.closeWaitingConflict(relPath, 'in-sync');
                    }
                }
            }
        }
    }

    private async handleFileConflict(
        relPath: string,
        localFullPath: string,
        remoteNode: NodeEntity,
        localSha1: string,
        remoteSha1: string | null,
        localMtimeMs: number,
        remoteMtimeMs: number,
        remoteMap: Map<string, NodeEntity>,
        settings: SyncSettings,
        since: number,
        // The record this conflict was found against: one written since (a resolution by hand, say) means the pass's view
        // of the file is out of date, and acting on it would undo what was done meanwhile (#77)
        recordSeen?: SyncedItemRecord,
    ): Promise<void> {
        const strategy = settings.conflictStrategy;
        if ((this.stateDb.getItemByPath(relPath)?.updatedAt ?? null) !== (recordSeen?.updatedAt ?? null)) {
            return; // The next pass decides, from what the file and its record are then
        }
        if (this.isResolving(relPath)) {
            // Being resolved right now: by the user by hand, whose choice is what happens to it (#77), or by the setting
            // in another look (a pass and a watcher look can reach one conflict at once), which holds the claim (#140)
            return;
        }
        if (this.driveTouched(relPath, since)) {
            // Renamed, deleted or replaced through the drive since this work read it: what was read is no longer what is
            // at this path, even with no record to say so (a file the drive made local has only an edit baseline; one a
            // rename put here, replacing it). The next pass decides, from what is there then (#139)
            return;
        }
        if (strategy === 'keep-both' && this.stillChangingWhenLetThrough(relPath)) {
            // Still being written: the cloud version would be downloaded only to be thrown away once the file changes
            // again (#67 keeps the newer local writes), every time it is let through. Nothing is touched; a pass once
            // it has gone quiet keeps both (#70). Said once in the log, so that a file that never stops is explained
            if (!this.keepBothDeferred.has(relPath)) {
                this.keepBothDeferred.add(relPath);
                this.logger.info(`Keeping both versions of ${relPath} once it stops changing: it is still being written`);
            }
            return;
        }
        this.keepBothDeferred.delete(relPath);
        const notify = () =>
            sendDesktopNotification({
                title: 'Proton Drive Sync Conflict',
                body: `Conflict detected on ${relPath} (strategy: ${strategy})`,
                urgency: 'normal',
                enabled: settings.notificationsEnabled,
            });

        if (strategy === 'prompt') {
            this.stateDb.setItemStatus(relPath, 'conflict', 'Both local and remote files were modified');
            // One already waiting there (each pass finds it again) is refreshed, and the user is told only once (#66)
            const { queued } = this.stateDb.queueConflict({
                localRelPath: relPath,
                nodeUid: remoteNode.uid,
                localSha1,
                remoteSha1,
                localMtimeMs,
                remoteMtimeMs,
            });
            if (queued) {
                notify();
                this.stateDb.logActivity({
                    action: 'conflict',
                    localRelPath: relPath,
                    details: 'Conflict queued for manual resolution',
                });
            }
            return;
        }
        if ([...this.drivingPaths.keys()].some((p) => isSameOrUnder(relPath, p))) {
            return; // Being renamed or deleted through the drive right now: the next pass decides, from what it leaves (#121)
        }
        notify();

        // Claimed until it is done: a manual resolution of it meanwhile is refused (#77), and a drive rename or delete of
        // it waits (#121)
        this.strategyResolvingPaths.add(relPath);
        let ended!: () => void;
        this.resolutionEnds.set(relPath, new Promise<void>((resolve) => (ended = resolve)));
        try {
            // keep-both: the only strategy that settles a conflict on its own, and it never replaces either side (#91)
            const kept = await this.keepBoth(relPath, localFullPath, localSha1, remoteNode, remoteMap, since);
            if (kept === null) {
                return; // Changed meanwhile: the next pass keeps both again, and a conflict waiting there keeps waiting
            }
            const conflictCopyRelPath = kept.copyPath;

            this.stateDb.settleConflict({
                localRelPath: relPath,
                nodeUid: remoteNode.uid,
                localSha1,
                remoteSha1,
                localMtimeMs,
                remoteMtimeMs,
                resolution: 'keep-both',
                conflictCopyPath: conflictCopyRelPath,
            });
            this.stateDb.logActivity({
                action: 'conflict',
                localRelPath: relPath,
                // A copy moved or deleted before it uploaded is in the log already, from uploadConflictCopy
                details:
                    conflictCopyRelPath === null
                        ? 'Resolved conflict with keep-both'
                        : `Resolved conflict with keep-both: saved ${conflictCopyRelPath}`,
            });
        } finally {
            this.strategyResolvingPaths.delete(relPath);
            this.resolutionEnds.delete(relPath);
            ended();
        }
    }

    // Keeps both versions of a file in conflict: its local content as a conflict copy, uploaded as a new file, and the
    // cloud's version in its place. Returns where the copy ends up. One conflict makes one copy (#25): a retry after the
    // download failed goes on from the copy the earlier try made (see earlierKeepBothCopy), and nothing else is ever
    // taken for it. A copy nothing tracks yet is uploaded as made; refused (its name taken in Proton Drive), it stays as
    // it is and a new copy is made, so no file anything tracks is ever renamed.
    // copyPath is null when the user moved or deleted the copy before it uploaded (#122, #127): both were kept as asked,
    // but no copy is where it was made.
    // Returns null, with the local file left as it is, when it changed after its copy was taken (still being written,
    // say: #67): what was written since would be lost under the cloud's version. The next pass keeps both again, from
    // what it holds then; the copy made here stays, a new local file to that pass.
    private async keepBoth(
        relPath: string,
        localFullPath: string,
        localSha1: string,
        remoteNode: NodeEntity,
        remoteMap: Map<string, NodeEntity>,
        since: number,
    ): Promise<{ copyPath: string | null } | null> {
        // The local file as it was when copied: checked again just before the cloud's version replaces it
        const snapshot = async (sha1: string) => {
            const st = await stat(localFullPath).catch(() => null);
            return st ? { size: st.size, mtimeMs: st.mtimeMs, sha1 } : null;
        };
        const unchangedSince = (copied: { size: number; mtimeMs: number; sha1: string } | null) => async () => {
            const asCopied = async () => {
                const st = await stat(localFullPath).catch(() => null);
                return Boolean(copied && st?.isFile() && st.size === copied.size && st.mtimeMs === copied.mtimeMs);
            };
            if (!(await asCopied())) {
                return false;
            }
            const sha1 = await computeLocalFileSha1(localFullPath).catch(() => null);
            // Looked at again after reading it all: a write while it was being read is a change too
            return sha1 === copied!.sha1 && (await asCopied());
        };
        const changedMeanwhile = async (madeAs?: string, copySha1?: string) => {
            if (madeAs !== undefined && copySha1 !== undefined) {
                await this.dropUntrackedCopy(madeAs, copySha1);
                this.keepBothCopies.delete(relPath);
            }
            this.logger.info(`Keeping both versions of ${relPath} next time: it changed after its conflict copy was made`);
            return null;
        };
        const earlier = await this.earlierKeepBothCopy(relPath, localSha1);
        let copyRelPath: string | null = null;
        if (earlier?.inCloud) {
            copyRelPath = earlier.relPath;
        } else if (earlier) {
            const parentNode = await this.ensureParentFolderNode(earlier.relPath, remoteMap, since);
            const fullPath = path.join(this.localRoot(), earlier.relPath);
            // Moved or deleted by the user as it uploads: no earlier copy then, and a new one is made below (#137)
            const gone = async () =>
                lstat(fullPath).then(
                    () => false,
                    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
                );
            if (await this.trashHold(parentNode)) {
                // In a folder in the Proton Drive trash: the copy stays here unrecorded, as uploadConflictCopy leaves one
                // (#160), and the folder's removal here keeps it
                copyRelPath = earlier.relPath;
            } else {
                const result = await this.uploadLocalToRemote(earlier.relPath, fullPath, parentNode, since, undefined, 'skip', gone).catch(
                    async (error: unknown) => {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (await gone())) {
                            this.keepBothCopies.delete(relPath);
                            return null;
                        }
                        throw error;
                    },
                );
                copyRelPath = result === null || result.status === 'skipped' ? null : earlier.relPath;
            }
        }
        if (copyRelPath !== null) {
            // The earlier copy holds localSha1: the local file must still be that
            const copied = await snapshot(localSha1);
            if (!(await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath, since, unchangedSince(copied)))) {
                return changedMeanwhile(); // Uploaded already: that copy stays
            }
            this.keepBothCopies.delete(relPath);
            return { copyPath: copyRelPath };
        }
        const madeAs = path.relative(this.localRoot(), await createLocalConflictCopy(localFullPath)).split(path.sep).join('/');
        // What the copy holds, which may be newer than localSha1 (read before): the local file must still be that
        const copySha1 = await computeLocalFileSha1(path.join(this.localRoot(), madeAs));
        const copied = await snapshot(copySha1);
        this.keepBothCopies.set(relPath, { copyRelPath: madeAs, sha1: copySha1 });
        if (!(await this.downloadRemoteToLocal(relPath, remoteNode, localFullPath, since, unchangedSince(copied)))) {
            // The copy goes: the local file holds what it does, or newer. One copy per try would otherwise pile up (and
            // upload) for as long as the file keeps changing.
            return changedMeanwhile(madeAs, copySha1);
        }
        // Past the download no retry comes (the file now holds the cloud's version): a copy whose upload fails here is
        // a new local file to the next pass
        this.keepBothCopies.delete(relPath);
        return { copyPath: await this.uploadConflictCopy(madeAs, remoteMap, since) };
    }

    // Removes a conflict copy just made, while nothing tracks it (no record, no index entry) and it still holds what it
    // was made with; otherwise it stays, as a file of its own
    private async dropUntrackedCopy(copyRelPath: string, sha1: string): Promise<void> {
        const fullPath = path.join(this.localRoot(), copyRelPath);
        if (this.stateDb.getItemByPath(copyRelPath) || this.index.getByPath(copyRelPath)) {
            return;
        }
        if ((await computeLocalFileSha1(fullPath).catch(() => null)) !== sha1) {
            return;
        }
        this.watcher.suppressPath(copyRelPath);
        await unlink(fullPath).catch(() => {});
    }

    // The copy an earlier, unfinished keep-both of this file made of this same content, if it can still be it: as made
    // (a file nothing tracks: no record and no index entry), or uploaded since, when Proton Drive holds that copy there
    // with that content now (inCloud: nothing more to upload). A copy of an earlier conflict, finished, is never in
    // keepBothCopies; one changed, moved or edited in the cloud since is no longer it.
    private async earlierKeepBothCopy(relPath: string, localSha1: string): Promise<{ relPath: string; inCloud: boolean } | null> {
        const earlier = this.keepBothCopies.get(relPath);
        if (!earlier || earlier.sha1 !== localSha1) {
            return null;
        }
        const copyRelPath = earlier.copyRelPath;
        const fullPath = path.join(this.localRoot(), copyRelPath);
        const st = lstatSync(fullPath, { throwIfNoEntry: false });
        if (!st?.isFile() || (await computeLocalFileSha1(fullPath).catch(() => null)) !== localSha1) {
            return null;
        }
        const record = this.stateDb.getItemByPath(copyRelPath);
        if (!record && !this.index.getByPath(copyRelPath)) {
            return { relPath: copyRelPath, inCloud: false };
        }
        if (record?.type !== 'file' || record.syncStatus !== 'synced' || record.localSha1 !== localSha1) {
            return null;
        }
        const there = await this.nodeStillAt(record.nodeUid, record.parentNodeUid, copyRelPath);
        return there?.activeRevision?.claimedDigests?.sha1 === localSha1 ? { relPath: copyRelPath, inCloud: true } : null;
    }

    // Uploads a conflict copy just made here as a new file, never over a cloud file that already has its name: refused,
    // the copy takes the next conflict name free here and tries again (a few times). Returns the path it ends up at.
    private async uploadConflictCopy(
        copyRelPath: string,
        remoteMap: Map<string, NodeEntity>,
        since: number,
    ): Promise<string | null> {
        const root = this.localRoot();
        const name = path.posix.basename(copyRelPath);
        const dot = name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        let relPath = copyRelPath;
        let n = 0;
        for (let attempt = 0; attempt < 10; attempt++) {
            const parentNode = await this.ensureParentFolderNode(relPath, remoteMap, since);
            const fullPath = path.join(root, relPath);
            // Only a copy that isn't there: one that can't be looked at (EACCES, EIO) is still the user's edit, uploaded
            const gone = async () =>
                lstat(fullPath).then(
                    () => false,
                    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
                );
            // The user deleted or moved the copy meanwhile (through Files, say): theirs to do, and both were kept as asked.
            // A copy moved is a new local file wherever it went, which a later look uploads (#122)
            const leftByTheUser = () => {
                this.logger.info(`The conflict copy ${relPath} was moved or deleted before it uploaded; left as the user left it`);
                this.stateDb.logActivity({
                    action: 'conflict',
                    localRelPath: relPath,
                    details: `The conflict copy ${relPath} was moved or deleted before it uploaded; left as it is`,
                });
                return null;
            };
            if (await gone()) {
                return leftByTheUser();
            }
            const held = await this.trashHold(parentNode);
            if (held) {
                // Its folder is in the Proton Drive trash (trashed elsewhere meanwhile), or that couldn't be checked: put
                // there, the copy would be recorded as synced, and the folder's removal here would take the only copy of
                // the user's version as an unchanged one. Left here unrecorded instead: a file only on this computer,
                // which that removal keeps (#150)
                this.logger.warn(`The conflict copy ${relPath} stays on this computer: ${held}`);
                return relPath;
            }
            const result = await this.uploadLocalToRemote(relPath, fullPath, parentNode, since, undefined, 'skip', gone).catch(
                async (error: unknown) => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (await gone())) {
                        return 'gone' as const;
                    }
                    throw error;
                },
            );
            if (result === 'gone') {
                return leftByTheUser();
            }
            if (result.status !== 'skipped') {
                return relPath;
            }
            let next: string;
            do {
                n += 1;
                next = joinRel(parentOf(copyRelPath), `${stem}-${n}${ext}`);
            } while (await this.existsLocally(next));
            this.watcher.suppressPath(relPath);
            this.watcher.suppressPath(next);
            if (moveWithoutReplacing(path.join(root, relPath), path.join(root, next))) {
                relPath = next;
            }
        }
        throw new Error(`No free name in Proton Drive for ${copyRelPath}`);
    }

    async resolveConflictManually(
        conflictId: number,
        choice: 'keep-both' | 'keep-local' | 'keep-remote',
    ): Promise<ConflictRecord> {
        if (this.holding()) {
            throw new Error(BUSY_MOVING);
        }
        this.refuseWhileFilesGone();
        await this.refuseUntilAccountChecked();
        if (this.holding()) {
            throw new Error(BUSY_MOVING); // again: a move of the files may have begun while it looked
        }
        return this.tracked(() => this.resolveConflictNow(conflictId, choice));
    }

    private async resolveConflictNow(
        conflictId: number,
        choice: 'keep-both' | 'keep-local' | 'keep-remote',
    ): Promise<ConflictRecord> {
        const conflict = this.stateDb.getConflictById(conflictId);
        if (!conflict) {
            throw new ConflictRefusedError(404, `Conflict #${conflictId} not found`);
        }
        if (conflict.resolved) {
            throw new ConflictRefusedError(409, `Conflict #${conflictId} is already resolved`);
        }
        if (this.resolvingConflicts.has(conflictId)) {
            throw new ConflictRefusedError(409, `Conflict #${conflictId} is being resolved`);
        }
        if (this.strategyResolvingPaths.has(conflict.localRelPath)) {
            throw new ConflictRefusedError(
                409,
                `Proton Drive is resolving ${conflict.localRelPath} by your conflict setting right now; try again in a moment`,
            );
        }
        if ([...this.drivingPaths.keys()].some((p) => isSameOrUnder(conflict.localRelPath, p))) {
            throw new ConflictRefusedError(
                409,
                `${conflict.localRelPath} is being renamed, moved or deleted on this computer right now; try again in a moment`,
            );
        }
        this.resolvingConflicts.add(conflictId);
        this.manualResolvingPaths.add(conflict.localRelPath);
        let ended!: () => void;
        this.resolutionEnds.set(conflict.localRelPath, new Promise<void>((resolve) => (ended = resolve)));
        try {
            await this.resolveUnresolvedConflict(conflict, choice);
        } finally {
            this.resolvingConflicts.delete(conflictId);
            this.manualResolvingPaths.delete(conflict.localRelPath);
            this.resolutionEnds.delete(conflict.localRelPath);
            ended();
        }
        return this.stateDb.getConflictById(conflictId)!;
    }

    private async resolveUnresolvedConflict(
        conflict: ConflictRecord,
        choice: 'keep-both' | 'keep-local' | 'keep-remote',
    ): Promise<void> {
        const conflictId = conflict.id;
        const localFullPath = path.join(this.localRoot(), conflict.localRelPath);
        const remoteMap = new Map<string, NodeEntity>();

        await this.observingLocal(async (since) => {
            const remoteNode = await this.sdk.getNode(conflict.nodeUid);
            if (choice === 'keep-local') {
                const parentNode = await this.ensureParentFolderNode(conflict.localRelPath, remoteMap, since);
                const root = await this.getRootFolder().catch(() => null);
                if (!root || (parentNode.uid !== root.uid && (parentNode.trashTime || (await this.inTrashedFolder(parentNode))))) {
                    // The folder it goes in is in the Proton Drive trash (or that couldn't be checked): a file put
                    // there would be trash too, and the next pass would remove it here as deleted in the cloud (#111)
                    throw new ConflictRefusedError(
                        409,
                        `The folder holding ${conflict.localRelPath} is in the Proton Drive trash, or Proton Drive couldn't check: nothing was changed. Restore the folder there, or try again later`,
                    );
                }
                if (remoteNode.trashTime || (await this.inTrashedFolder(remoteNode))) {
                    // In the Proton Drive trash: a revision would land there, and the next pass would take the file for
                    // deleted in the cloud and remove it here (#111). Kept as a new file at its place instead; a file
                    // made there meanwhile isn't overwritten
                    const result = await this.uploadLocalToRemote(conflict.localRelPath, localFullPath, parentNode, since, undefined, 'skip');
                    if (result.status !== 'uploaded') {
                        // Not uploaded (the trash still holds its name, say), or matched to a node that may be the
                        // trashed one: the file is let go of the trashed node, so the next pass takes it for a new file
                        // on this computer and keeps it, rather than for one deleted in the cloud
                        this.stateDb.removeItemByPath(conflict.localRelPath);
                        this.logger.warn(
                            `Keep Local: ${conflict.localRelPath} is in the Proton Drive trash; it stays on this computer and uploads as a new file once its name is free`,
                        );
                    }
                } else {
                    await this.uploadLocalToRemote(conflict.localRelPath, localFullPath, parentNode, since, remoteNode.uid);
                }
                this.stateDb.markConflictResolved(conflictId, 'keep-local');
            } else if (choice === 'keep-remote') {
                // The local file as the user chose to replace it: a save made while the cloud's version downloads is
                // newer than what they chose about, so it is never replaced (#104), as keep-both never does (#67)
                const chosenOver = await stat(localFullPath).catch(() => null);
                const chosenSha1 = chosenOver ? await computeLocalFileSha1(localFullPath).catch(() => null) : null;
                const asChosen = async () => {
                    const st = await stat(localFullPath).catch(() => null);
                    if (!chosenOver || !st?.isFile() || st.size !== chosenOver.size || st.mtimeMs !== chosenOver.mtimeMs) {
                        return !chosenOver && !st; // gone then and now: nothing to keep
                    }
                    return (await computeLocalFileSha1(localFullPath).catch(() => null)) === chosenSha1;
                };
                if (!(await this.downloadRemoteToLocal(conflict.localRelPath, remoteNode, localFullPath, since, asChosen))) {
                    throw new ConflictRefusedError(
                        409,
                        `${conflict.localRelPath} changed (saved, moved or deleted) while Proton Drive's version downloaded, so it was left as it is; try again`,
                    );
                }
                this.stateDb.markConflictResolved(conflictId, 'keep-remote');
            } else {
                const localSha1 = await computeLocalFileSha1(localFullPath);
                const kept = await this.keepBoth(conflict.localRelPath, localFullPath, localSha1, remoteNode, remoteMap, since);
                if (kept === null) {
                    throw new ConflictRefusedError(409, `${conflict.localRelPath} changed while both were being kept; try again`);
                }
                // A null copy path leaves the row's as it is (COALESCE), which a waiting row never has set
                this.stateDb.markConflictResolved(conflictId, 'keep-both', kept.copyPath);
            }
            // Resolved, whichever way: a keep-both of it left unfinished before is over too (see keepBoth)
            this.keepBothCopies.delete(conflict.localRelPath);
        });
    }

    // With beforePlacing, the download replaces the local file only if it answers true just before (see keepBoth).
    // Answers whether the local file is now the cloud's version (or one the cloud's can't be).
    private async downloadRemoteToLocal(
        relPath: string,
        remoteNode: NodeEntity,
        localFullPath: string,
        since: number,
        beforePlacing?: () => Promise<boolean>,
    ): Promise<boolean> {
        const transferId = `dl:${relPath}`;
        this.watcher.suppressPath(relPath, 10000);
        this.activeTransfers.set(transferId, {
            id: transferId,
            direction: 'download',
            relPath,
            bytesTransferred: 0,
            totalBytes: remoteNode.activeRevision?.claimedSize ?? 0,
            startedAt: Date.now(),
        });

        try {
            // Before anything is placed or hashed here: a write from then on is newer than what the record says (#109)
            const readFrom = Date.now();
            const result = await downloadDriveNodeToLocal({
                sdk: this.sdk,
                logger: this.logger,
                remoteNode,
                localPath: localFullPath,
                onProgress: (downloadedBytes, totalBytes) => {
                    const current = this.activeTransfers.get(transferId);
                    if (current) {
                        current.bytesTransferred = downloadedBytes;
                        current.totalBytes = totalBytes;
                    }
                },
                beforePlacing,
            });
            if (result.status === 'skipped-changed') {
                return false;
            }

            if (result.status === 'downloaded' || result.status === 'skipped-identical') {
                const remoteMtimeMs = (
                    remoteNode.activeRevision?.claimedModificationTime ?? remoteNode.modificationTime
                ).getTime();
                this.recordSynced({
                    localRelPath: relPath,
                    nodeUid: remoteNode.uid,
                    parentNodeUid: remoteNode.parentUid ?? null,
                    type: 'file',
                    localSha1: result.sha1 ?? null,
                    // What the cloud claims, null when it claims none: never the SHA1 computed here in its place
                    remoteSha1: remoteNode.activeRevision?.claimedDigests?.sha1 ?? null,
                    localMtimeMs: result.mtimeMs,
                    remoteMtimeMs,
                    size: result.size,
                    syncStatus: 'synced',
                    lastError: null,
                    contentReadAt: result.status === 'downloaded' ? placedReadAt(result.ctimeMs, readFrom) : readFrom,
                }, since);

                if (result.status === 'downloaded') {
                    this.stateDb.logActivity({
                        action: 'download',
                        localRelPath: relPath,
                        details: `Downloaded from Proton Drive (${formatBytes(result.size)})`,
                        bytesTransferred: result.size,
                    });
                }
            }
            return true;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.stateDb.setItemStatus(relPath, 'error', msg);
            this.logFailureOnce(relPath, msg, `Download failed: ${msg}`);
            throw error;
        } finally {
            this.activeTransfers.delete(transferId);
            this.watcher.suppressPath(relPath, 2500);
        }
    }

    private async uploadLocalToRemote(
        relPath: string,
        localFullPath: string,
        parentNode: NodeEntity,
        since: number,
        existingNodeUid?: string,
        collisionMode: 'new-revision' | 'skip' = 'new-revision',
        // Says whether a file that failed to upload is gone by the user's doing: the caller reports that, not a failure
        leftByTheUser?: () => Promise<boolean>,
    ): Promise<UploadResult> {
        const transferId = `ul:${relPath}`;
        // Before the upload reads the file: a write from then on (as it uploads, which can take minutes) is newer than
        // what the record says it holds, so the next look hashes the file (#109)
        const readFrom = Date.now();
        const st = await stat(localFullPath);
        this.activeTransfers.set(transferId, {
            id: transferId,
            direction: 'upload',
            relPath,
            bytesTransferred: 0,
            totalBytes: st.size,
            startedAt: Date.now(),
        });

        try {
            const result = await uploadLocalFileToDrive({
                sdk: this.sdk,
                logger: this.logger,
                parentNode,
                localPath: localFullPath,
                remoteName: path.basename(relPath),
                existingNodeUid,
                collisionMode,
                onProgress: (uploadedBytes, totalBytes) => {
                    const current = this.activeTransfers.get(transferId);
                    if (current) {
                        current.bytesTransferred = uploadedBytes;
                        current.totalBytes = totalBytes;
                    }
                },
            });

            if (result.nodeUid && (result.status === 'uploaded' || result.status === 'updated-revision')) {
                this.indexUploaded(result.nodeUid, parentNode.uid, result.remoteName, result);
            }
            // A name taken by another file (with 'skip') is left to the caller
            if (result.nodeUid && result.status !== 'skipped') {
                const item: Omit<SyncedItemRecord, 'updatedAt'> = {
                    localRelPath: relPath,
                    nodeUid: result.nodeUid,
                    parentNodeUid: parentNode.uid,
                    type: 'file',
                    localSha1: result.sha1,
                    remoteSha1: result.sha1,
                    localMtimeMs: result.mtimeMs,
                    remoteMtimeMs: Date.now(),
                    size: result.size,
                    syncStatus: 'synced',
                    lastError: null,
                    contentReadAt: readFrom,
                };
                if (!this.recordSynced(item, since) && result.status === 'uploaded') {
                    this.adoptStrayNode(relPath, item, since); // A new node, for a file renamed or deleted meanwhile
                }
            }

            if (result.status === 'uploaded' || result.status === 'updated-revision') {
                this.stateDb.logActivity({
                    action: 'upload',
                    localRelPath: relPath,
                    details: `${result.status === 'updated-revision' ? 'Updated revision' : 'Uploaded'} to Proton Drive (${formatBytes(result.size)})`,
                    bytesTransferred: result.size,
                });
            }
            return result;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && leftByTheUser && (await leftByTheUser())) {
                throw error;
            }
            const msg = error instanceof Error ? error.message : String(error);
            this.stateDb.setItemStatus(relPath, 'error', msg);
            this.stateDb.logActivity({
                action: 'error',
                localRelPath: relPath,
                details: `Upload failed: ${msg}`,
            });
            throw error;
        } finally {
            this.activeTransfers.delete(transferId);
        }
    }

    // Uploads a local file with no record as a new file, never over a cloud file of that name (#21, #23): returns the
    // file whose name the upload was refused for, for the caller to judge as a pass would, or null once uploaded. One
    // trashed or gone by the time it is read holds that name no more: the upload is tried once again.
    private async uploadNewFile(
        relPath: string,
        localFullPath: string,
        parentNode: NodeEntity,
        since: number,
    ): Promise<NodeEntity | null> {
        const held = await this.trashHold(parentNode);
        if (held) {
            // Its folder is in the Proton Drive trash (trashed elsewhere, not yet removed here), or that couldn't be told:
            // put there, the file would be recorded as synced and the folder's removal here would take it for an
            // unchanged copy, leaving it only in the trash. Left here unrecorded: a file only on this computer, which
            // that removal keeps (#160)
            this.logger.warn(`Not uploading ${relPath}: ${held}`);
            return null;
        }
        for (let attempt = 1; ; attempt++) {
            const result = await this.uploadLocalToRemote(relPath, localFullPath, parentNode, since, undefined, 'skip');
            if (result.status !== 'skipped' || !result.nodeUid) {
                return null;
            }
            const there = await this.liveNode(result.nodeUid);
            if (there) {
                return there;
            }
            if (attempt === 2) {
                this.logger.warn(`Not uploading ${relPath} yet: Proton Drive refuses its name for an item that is gone`);
                return null;
            }
        }
    }

    // A node as Proton Drive has it now; null when it is gone or in its trash. A network failure isn't an answer: it
    // throws.
    private async liveNode(uid: string): Promise<NodeEntity | null> {
        try {
            const node = await this.sdk.getNode(uid);
            return node.trashTime ? null : node;
        } catch (error: unknown) {
            if (error instanceof ValidationError) {
                return null;
            }
            throw error;
        }
    }

    // The record at a path, if it stands for that node
    private recordOf(relPath: string, nodeUid: string): SyncedItemRecord | undefined {
        const record = this.stateDb.getItemByPath(relPath);
        return record?.nodeUid === nodeUid ? record : undefined;
    }

    // #50: what the user confirmed as deleted (confirmFilesMissingDeleted) that this pass couldn't reach through the tree.
    // A record whose folders above have none, as a file opened through the virtual drive has, sits under a folder the
    // pass doesn't go into (online-only here), so it was never looked at, and the hold came back for ever. Each such
    // item, still recorded and still missing, goes as the pass would have taken it (see trashForDeletedLocal), by its
    // recorded node; one gone from Proton Drive already just loses its records. Nothing outside what was confirmed. An
    // item goes only from where its record says it is, its whole path in Proton Drive now (see livePathOf): one moved
    // or renamed in the cloud meanwhile, or under a folder that was, isn't where the user deleted it, so it stays in
    // Proton Drive where it went, and only its records go, as when the pass finds an item moved away (so nothing holds on
    // it again). An item back here meanwhile keeps its records: the next pass syncs it as it finds it.
    private async trashConfirmedOutOfReach(confirmation: { root: string; names: Set<string> }): Promise<void> {
        if (confirmation.root !== this.localRoot()) {
            return;
        }
        const ignorePatterns = this.stateDb.getSettings().ignorePatterns;
        const rootUid = (await this.getRootFolder()).uid;
        const folders = new Map<string, NodeEntity | null>(); // the folders above them, each looked up once
        const left: SyncedItemRecord[] = [];
        for (const name of confirmation.names) {
            for (const record of this.stateDb.getItemsUnder(name)) {
                const rel = record.localRelPath; // parents come before what is in them
                if (
                    left.some((item) => isWithin(rel, item.localRelPath)) || // goes with its folder
                    matchesIgnorePatterns(rel, ignorePatterns) ||
                    this.policy.hiddenBy(rel)?.hide === 'hidden' ||
                    (await this.existsLocally(rel))
                ) {
                    continue;
                }
                left.push(record);
            }
        }
        for (const record of left) {
            const rel = record.localRelPath;
            if (this.stateDb.getItemByPath(rel)?.nodeUid !== record.nodeUid) {
                continue; // Changed meanwhile
            }
            const node = await this.liveNode(record.nodeUid);
            const livePath = node === null ? null : await this.livePathOf(node, rootUid, folders);
            if (await this.existsLocally(rel)) {
                continue; // Back meanwhile: it keeps its records, and the next pass syncs it
            }
            if (node === null) {
                this.stateDb.removeItemByPath(rel); // Gone from Proton Drive already, or in its trash
            } else if (livePath !== rel) {
                this.stateDb.removeItemByPath(rel);
                this.logger.warn(`Not trashing ${rel}: it moved in Proton Drive meanwhile, so it stays there`);
                this.stateDb.logActivity({
                    action: 'sync',
                    localRelPath: rel,
                    details: 'Not moved to the Proton Drive trash: it moved in Proton Drive meanwhile, so it stays there',
                });
            } else {
                await this.trashForDeletedLocal(rel, node);
            }
        }
    }

    // A node's path in My files now, from the root down, looking up each folder above it in Proton Drive (`folders`
    // keeps what was looked up, for the next item). Null when a folder above it is gone or in the trash, or the chain
    // doesn't reach the root. A name that can't be read stands as the node's uid, so it matches no path here.
    private async livePathOf(node: NodeEntity, rootUid: string, folders: Map<string, NodeEntity | null>): Promise<string | null> {
        const names = [getName(node)];
        let parentUid = node.parentUid;
        for (let depth = 0; depth < 512 && parentUid; depth++) {
            if (parentUid === rootUid) {
                return names.reverse().join('/');
            }
            let parent = folders.get(parentUid);
            if (parent === undefined) {
                parent = await this.liveNode(parentUid);
                folders.set(parentUid, parent);
            }
            if (parent === null) {
                return null;
            }
            names.push(getName(parent));
            parentUid = parent.parentUid;
        }
        return null;
    }

    // A trash Proton Drive refused for a node that is in its trash already, or gone: done, not a failure (#179)
    private async alreadyTrashed(uid: string, error: unknown): Promise<boolean> {
        return error instanceof ValidationError && (await this.liveNode(uid).catch(() => undefined)) === null;
    }

    private async trashRemoteNodeForDeletedLocal(relPath: string, remoteNode: NodeEntity): Promise<void> {
        try {
            for await (const res of this.sdk.trashNodes([remoteNode])) {
                if (!res.ok && !(await this.alreadyTrashed(remoteNode.uid, res.error))) {
                    throw res.error;
                }
            }
            this.stateDb.removeItemByPath(relPath);
            this.stateDb.logActivity({
                action: 'trash-remote',
                localRelPath: relPath,
                details: 'Moved remote item to Proton Drive Trash after local deletion',
            });
            this.index.removeSubtree(remoteNode.uid);
        } catch (error: unknown) {
            this.logger.warn(`Failed to trash remote node for ${relPath}: ${error}`);
        }
    }

    // Why nothing is to be put in a folder, or null when it may (the root always may): it is in the Proton Drive trash
    // (itself or by a folder above it), or whether it is couldn't be told (offline, say), which holds it all the same
    // until a later look (#166)
    private async trashHold(folder: NodeEntity): Promise<string | null> {
        const unchecked = "its folder couldn't be checked in Proton Drive just now; it is tried again later";
        const trashed = 'its folder is in the Proton Drive trash';
        const root = await this.getRootFolder().catch(() => null);
        if (!root) return unchecked;
        if (folder.uid === root.uid) return null;
        if (folder.trashTime) return trashed;
        const seen = new Set<string>();
        for (let uid = folder.parentUid; uid && uid !== root.uid; ) {
            if (seen.has(uid)) return unchecked;
            seen.add(uid);
            const above = await this.sdk.getNode(uid).catch(() => null);
            if (!above) return unchecked;
            if (above.trashTime) return trashed;
            uid = above.parentUid;
        }
        return null;
    }

    // Whether a conflict at the path is being resolved right now, by hand or by the conflict setting
    private isResolving(relPath: string): boolean {
        return this.manualResolvingPaths.has(relPath) || this.strategyResolvingPaths.has(relPath);
    }

    // The same, at the path or anywhere under it
    private isResolvingWithin(relPath: string): boolean {
        return [...this.manualResolvingPaths, ...this.strategyResolvingPaths].some((r) => isWithin(r, relPath));
    }

    // The user deleted a synced item locally, so its cloud copy goes to the Proton Drive trash. A folder can also hold
    // things that never were on this computer: online-only, ignored or hidden items, Proton Docs and Sheets, or a node
    // that replaced the one synced here. Those stay in the cloud: only the items that had local copies are trashed, and
    // the folder is left online-only.
    private async trashForDeletedLocal(relPath: string, remoteNode: NodeEntity): Promise<void> {
        if (this.isResolvingWithin(relPath)) {
            // A conflict of it, or of something in it, is being resolved (by hand or by the setting, #140, #143): that
            // decides, and the next look after it sees the delete
            this.logger.info(`Not acting on ${relPath} gone here yet: its conflict is being resolved`);
            return;
        }
        // A rename, move or delete through the drive pending in it makes the remote index show it as it will be, not as
        // the cloud has it: nothing is trashed from that picture; the next look, once those have run, decides
        const { uids, paths } = this.journal.guard();
        if (uids.has(remoteNode.uid) || paths.some((p) => isWithin(p, relPath))) {
            this.logger.warn(`Not trashing ${relPath} yet: changes made through the drive in it are on their way`);
            return;
        }
        if (remoteNode.type !== NodeType.Folder) {
            // Only the node the record points at may be trashed: the listing is by name, so what it shows can be a
            // replacement (a Proton Doc, or a new upload) that never was on this computer
            const recordedUid = this.stateDb.getItemByPath(relPath)?.nodeUid;
            const recorded =
                recordedUid && recordedUid !== remoteNode.uid
                    ? await this.sdk.getNode(recordedUid).catch(() => null)
                    : null;
            // Checked last, as callers may have waited on the network since: the record is still there and the file
            // still missing
            const record = this.stateDb.getItemByPath(relPath);
            if (!record || (await this.existsLocally(relPath))) {
                return;
            }
            if (this.inQueuedConflict(relPath, record)) {
                // This computer's side of a conflict waiting for the user is what went (#63): the cloud has another
                // device's revision, never seen here, which stays, as a delete through the drive leaves it (#29)
                this.stateDb.removeItemByPath(relPath);
                this.endConflictsAsKeepRemote([relPath]);
                this.stateDb.logActivity({
                    action: 'delete-local',
                    localRelPath: relPath,
                    details: "Deleted on this computer while in conflict; the other device's version stays in Proton Drive",
                });
                return;
            }
            if (record.nodeUid === remoteNode.uid) {
                await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
            } else if (recorded && !recorded.trashTime && recorded.uid === record.nodeUid) {
                await this.trashRemoteNodeForDeletedLocal(relPath, recorded);
            } else if (record.nodeUid === recordedUid) {
                // The recorded node is gone or already trashed: the replacement shows up as a new item next pass
                this.stateDb.removeItemByPath(relPath);
            }
            return;
        }
        // Decide from what the cloud holds right now; without the whole picture, trash nothing this time
        const holdsDocs = new Set<string>(); // folders holding Proton Docs or Sheets, which the index leaves out
        if (!(await this.indexRemoteSubtree(remoteNode, relPath, holdsDocs))) {
            this.logger.warn(`Not trashing ${relPath} yet: could not list everything in it`);
            return;
        }
        const entries = this.index.listSubtree(relPath);
        const recordsUnder = this.stateDb.getItemsUnder(relPath);
        // Files in a conflict waiting for the user are kept, as never on this computer: the cloud has another device's
        // revision of them (#63)
        const conflictPaths = new Set(this.stateDb.listConflicts().map((conflict) => conflict.localRelPath));
        const inConflict = recordsUnder
            .filter((item) => this.inQueuedConflict(item.localRelPath, item, conflictPaths))
            .map((item) => item.localRelPath);
        const syncedUid = new Map(
            recordsUnder.filter((item) => !inConflict.includes(item.localRelPath)).map((item) => [item.localRelPath, item.nodeUid]),
        );
        const hidden = this.policy.hiddenWithin(relPath);
        // Everything that never was on this computer, with every folder above it up to the deleted one
        const holdsCloudOnly = new Set<string>();
        const markWithAncestors = (from: string) => {
            let p = from;
            while (!holdsCloudOnly.has(p)) {
                holdsCloudOnly.add(p);
                const slash = p.lastIndexOf('/');
                if (p === relPath || slash === -1) {
                    break;
                }
                p = p.slice(0, slash);
            }
        };
        for (const entry of entries) {
            if (syncedUid.get(entry.relPath) !== entry.uid || hidden.some((h) => isWithin(entry.relPath, h))) {
                markWithAncestors(entry.relPath);
            }
        }
        for (const folder of holdsDocs) {
            markWithAncestors(folder);
        }
        if (!holdsCloudOnly.has(relPath)) {
            // Look again, as listing took a while: only while the record is still there and the folder still missing
            if (this.stateDb.getItemByPath(relPath)?.nodeUid === remoteNode.uid && !(await this.existsLocally(relPath))) {
                await this.trashRemoteNodeForDeletedLocal(relPath, remoteNode);
            }
            return;
        }

        // The topmost items that had local copies, along with everything in them (parents come before children)
        const trashRoots: RemoteIndexEntry[] = [];
        const rootPaths = new Set<string>();
        const underARoot = (p: string) => {
            for (let slash = p.lastIndexOf('/'); slash > 0; slash = p.lastIndexOf('/', slash - 1)) {
                if (rootPaths.has(p.slice(0, slash))) {
                    return true;
                }
            }
            return false;
        };
        for (const entry of entries) {
            if (!holdsCloudOnly.has(entry.relPath) && !underARoot(entry.relPath)) {
                trashRoots.push(entry);
                rootPaths.add(entry.relPath);
            }
        }
        const resolved: Array<{ relPath: string; node: NodeEntity }> = [];
        for (const entry of trashRoots) {
            const node = await this.sdk.getNode(entry.uid).catch(() => null);
            if (node) {
                resolved.push({ relPath: entry.relPath, node });
            }
        }
        // As for any trash, and checked last: only while the record is still there and the local item still missing
        const toTrash: Array<{ relPath: string; node: NodeEntity }> = [];
        for (const item of resolved) {
            if (
                this.stateDb.getItemByPath(item.relPath)?.nodeUid === item.node.uid &&
                !(await this.existsLocally(item.relPath))
            ) {
                toTrash.push(item);
            }
        }
        if (toTrash.length > 0) {
            await this.trashRemoteNodesForDeletedLocal(toTrash);
        }
        if (await this.existsLocally(relPath)) {
            return; // Back meanwhile: the next pass syncs what is there
        }
        // Online-only from now on: no records, so nothing below reads as deleted later, and not pinned, so it isn't
        // downloaded again
        this.stateDb.removeItemByPath(relPath);
        this.endConflictsAsKeepRemote(inConflict);
        if (this.policy.isPinned(relPath) || this.policy.hasPinnedBelow(relPath)) {
            this.policy.setPin(remoteNode.uid, 'unpinned', true);
        }
        this.stateDb.logActivity({
            action: 'sync',
            localRelPath: relPath,
            details:
                'Deleted on this computer, so only what was downloaded went to Proton Drive Trash; the folder stays in Proton Drive, online only, with the items that were never on this computer',
        });
    }

    // Several locally deleted items in one trash call; each one that went loses its records and its index entries.
    private async trashRemoteNodesForDeletedLocal(items: Array<{ relPath: string; node: NodeEntity }>): Promise<void> {
        const byUid = new Map(items.map((item) => [item.node.uid, item]));
        try {
            for await (const res of this.sdk.trashNodes(items.map((item) => item.node))) {
                const item = byUid.get(res.uid);
                if (!item) {
                    continue;
                }
                if (!res.ok && !(await this.alreadyTrashed(res.uid, res.error))) {
                    this.logger.warn(`Failed to trash remote node for ${item.relPath}: ${res.error}`);
                    continue;
                }
                this.stateDb.removeItemByPath(item.relPath);
                this.stateDb.logActivity({
                    action: 'trash-remote',
                    localRelPath: item.relPath,
                    details: 'Moved remote item to Proton Drive Trash after local deletion',
                });
                this.index.removeSubtree(res.uid);
            }
        } catch (error: unknown) {
            this.logger.warn(`Failed to trash remote nodes for ${items.map((item) => item.relPath).join(', ')}: ${error}`);
        }
    }

    // Writes a sync record for work that began when `since` removals of local copies had finished (see observingLocal).
    // Work that looked at a file before Free up space, Hide or a cloud delete removed it, or before a cloud rename moved
    // its folder away (an upload, a download, a hash), can finish after that, and a record left without its file reads
    // as the user deleting it, which trashes the cloud copy. So the record is not written for a path:
    // - that a running removal has taken away (dropped its record, or moved away the subtree it is in): its file is
    //   about to go, or has gone;
    // - that a removal finished since the work began took away, if it is still gone.
    // Anything else is written as usual, a missing file included: that is the user deleting or renaming it while it
    // synced, which the next look at it takes to the cloud. Checked and written with nothing able to run in between.
    // Says whether it wrote the record.
    private recordSynced(item: Omit<SyncedItemRecord, 'updatedAt'>, since: number): boolean {
        const relPath = item.localRelPath;
        for (const takenAway of this.runningRemovals) {
            if (isTakenAway(takenAway, relPath)) {
                return false;
            }
        }
        if (
            this.removalBatches.some((batch) => batch.n > since && isTakenAway(batch.takenAway, relPath)) &&
            !this.localItemExists(relPath)
        ) {
            return false;
        }
        this.stateDb.upsertItem(item);
        if (item.type === 'folder' && !isProvisional(item.nodeUid)) {
            this.stateDb.setParentOfChildren(relPath, item.nodeUid);
        }
        // Synced: whatever conflict it was in is over, and a keep-both of it left unfinished with it (see keepBoth)
        this.keepBothCopies.delete(relPath);
        this.forgetFailure(relPath);
        return true;
    }

    // Whether a rename or delete through the drive since `since` took the item at this path away, or put another there
    // (renamed onto it, or into a folder above it)
    private driveTouched(relPath: string, since: number): boolean {
        const changes = [
            ...this.removalBatches.filter((batch) => batch.n > since).map((batch) => batch.takenAway),
            ...this.runningRemovals,
        ];
        return changes.some(
            ({ drive }) => drive !== undefined && (isWithin(relPath, drive.from) || (drive.to !== null && isWithin(relPath, drive.to))),
        );
    }

    // Where a rename or delete through the drive took an item that work begun when `since` removals had finished was
    // about: its path now (following renames in order), null when deleted (or replaced by the user), undefined when no
    // drive change took it (Free up space, Hide or a cloud delete may have).
    private driveDestination(relPath: string, since: number): string | null | undefined {
        const changes = [
            ...this.removalBatches.filter((batch) => batch.n > since).map((batch) => batch.takenAway),
            ...this.runningRemovals,
        ];
        let current = relPath;
        let moved = false;
        for (const { drive } of changes) {
            if (!drive || !isWithin(current, drive.from)) {
                continue;
            }
            if (drive.to === null) {
                return null;
            }
            current = drive.to + current.slice(drive.from.length);
            moved = true;
        }
        return moved ? current : undefined;
    }

    // A node that work begun before a rename or delete through the drive just made in Proton Drive, for an item that
    // is no longer at its path (its record was refused): left alone, it would come back as a stray copy. It follows the
    // item, recorded at its new path with a journalled rename or move; or goes to the trash with it when the item was
    // deleted or replaced by the user (or, for a file, when its new place already holds another copy). A node taken
    // away by anything else (Free up space, Hide, a cloud delete) is left as before.
    private adoptStrayNode(relPath: string, item: Omit<SyncedItemRecord, 'updatedAt'>, since: number): void {
        const now = this.driveDestination(relPath, since);
        if (now === undefined || (now !== null && matchesIgnorePatterns(now, this.stateDb.getSettings().ignorePatterns))) {
            return;
        }
        const follows = now !== null && !this.stateDb.getItemByPath(now) && this.localItemExists(now);
        if (!follows && now !== null && item.type === 'folder') {
            this.logger.warn(`A folder made in Proton Drive for ${relPath} was left there: ${now} already has its own`);
            return;
        }
        try {
            this.stateDb.connection.transaction(() => {
                if (follows) {
                    // Its record's cloud parent is where the move puts it, as renameItemPath does (#103)
                    this.stateDb.upsertItem({ ...item, localRelPath: now, parentNodeUid: this.cloudParentOf(now) ?? item.parentNodeUid });
                    this.journal.enqueue({
                        kind: parentOf(relPath) === parentOf(now) ? 'rename' : 'move',
                        nodeUid: item.nodeUid,
                        toPath: now,
                        fromPath: relPath,
                    });
                } else {
                    this.journal.enqueue({ kind: 'trash', nodeUid: item.nodeUid, path: relPath });
                }
                this.applyPendingOpsToIndex();
            })();
        } catch (error: unknown) {
            this.logger.warn(`Could not follow up ${relPath} in Proton Drive after it was renamed or deleted: ${error}`);
            return;
        }
        void this.replayRemoteOps();
    }

    // A folder of this computer that Proton Drive now has (made for it, or found there under its name): recorded, so it
    // is known as synced (a rename of it then renames it there too), and put in the remote index. One made now for a
    // folder that a rename or delete through the drive took away meanwhile is followed up (see adoptStrayNode).
    private recordFolderMadeFor(relPath: string, folder: NodeEntity, created: boolean, since: number): void {
        this.indexCreatedFolder(folder, relPath);
        if (this.stateDb.getItemByPath(relPath)) {
            return;
        }
        const local = lstatSync(path.join(this.localRoot(), relPath), { throwIfNoEntry: false });
        const item: Omit<SyncedItemRecord, 'updatedAt'> = {
            localRelPath: relPath,
            nodeUid: folder.uid,
            parentNodeUid: folder.parentUid ?? null,
            type: 'folder',
            localSha1: null,
            remoteSha1: null,
            localMtimeMs: local?.mtimeMs ?? 0,
            remoteMtimeMs: folder.modificationTime.getTime(),
            size: 0,
            syncStatus: 'synced',
            lastError: null,
        };
        if ((!local?.isDirectory() || !this.recordSynced(item, since)) && created) {
            this.adoptStrayNode(relPath, item, since);
        }
    }

    // Any failure to look (ENOTDIR, EACCES, …) counts as gone: this only ever decides against writing a record.
    private localItemExists(relPath: string): boolean {
        try {
            return lstatSync(path.join(this.localRoot(), relPath), { throwIfNoEntry: false }) !== undefined;
        } catch {
            return false;
        }
    }

    // Runs work that looks at local files and may record them, giving it the count of finished removals to pass to
    // recordSynced.
    private async observingLocal<T>(work: (since: number) => Promise<T>): Promise<T> {
        const since = this.localRemovals;
        this.workSince.set(since, (this.workSince.get(since) ?? 0) + 1);
        try {
            return await work(since);
        } finally {
            const left = (this.workSince.get(since) ?? 1) - 1;
            if (left > 0) {
                this.workSince.set(since, left);
            } else {
                this.workSince.delete(since);
            }
            this.pruneRemovalBatches();
        }
    }

    // A batch matters only to work that began before it ended
    private pruneRemovalBatches(): void {
        const oldest = this.workSince.size > 0 ? Math.min(...this.workSince.keys()) : Number.POSITIVE_INFINITY;
        if (this.removalBatches.length > 0) {
            this.removalBatches = this.removalBatches.filter((batch) => batch.n > oldest);
        }
    }

    // Runs a removal of local copies. Its `drop` drops a record just before the file goes, noting the path for
    // recordSynced and keeping the record so that one whose file stayed after all can be put back with `putBack`.
    // `dropSubtree` notes a whole subtree whose local copy moved away, dropping any record left in it (none put back).
    private async whileRemoving<T>(
        removal: (records: {
            drop(relPath: string): void;
            dropSubtree(relPath: string): void;
            noteSubtree(relPath: string): void;
            putBack(stayed: string[]): Promise<void>;
        }) => Promise<T>,
        drive?: DriveChange,
    ): Promise<T> {
        const takenAway: TakenAway = { paths: new Set(), subtrees: new Set(), drive };
        this.runningRemovals.add(takenAway);
        try {
            return await removal(this.recordDropper(takenAway));
        } finally {
            this.runningRemovals.delete(takenAway);
            this.localRemovals += 1;
            if (takenAway.paths.size > 0 || takenAway.subtrees.size > 0) {
                this.removalBatches.push({ n: this.localRemovals, takenAway });
            }
            this.pruneRemovalBatches();
        }
    }

    private existsLocally(relPath: string): Promise<boolean> {
        return lstat(path.join(this.localRoot(), relPath)).then(
            () => true,
            () => false,
        );
    }

    private async handleLocalFileChange(relPath: string): Promise<void> {
        this.stateEvents.touch(relPath); // a new file shows as waiting to upload; a removed one goes
        this.failingItems.delete(relPath); // Changed here: the next pass looks at it again at once
        // A report for a path whose look hasn't started yet joins it: it will see the file as it is when it runs
        const waiting = this.localWaiting.get(relPath);
        if (waiting) {
            return waiting;
        }
        const look = (async () => {
            // One already running for the path is waited for before a turn is taken, not while holding one: a file busy
            // uploading would otherwise hold every turn and keep all other changes waiting (#90)
            await this.localQueue.get(relPath)?.catch(() => {});
            // A few at a time: a large folder copied in reports thousands of files within milliseconds, and each hashes
            // and uploads (#90). The stop, hold and sign-in checks come once its turn has come: they may have changed
            await this.localChangeSlots.run(async () => {
                if (this.localWaiting.get(relPath) === look) {
                    this.localWaiting.delete(relPath); // Started: a report from now on is for a later look
                }
                if (this.stopped || this.holding() || !this.auth.isLoggedIn() || !(await this.verifyAccount())) {
                    return; // Not unless the account is checked to be the records' (#35): the pass after catches up
                }
                if (this.filesGone()) {
                    return; // Not a change to sync: the files are missing from the folder (see filesGone); the pass after catches up
                }
                await this.tracked(() => this.handleLocalFileChangeNow(relPath));
            });
        })();
        this.localWaiting.set(relPath, look);
        try {
            await look;
        } finally {
            if (this.localWaiting.get(relPath) === look) {
                this.localWaiting.delete(relPath);
            }
        }
    }

    private async handleLocalFileChangeNow(relPath: string): Promise<void> {
        const settings = this.stateDb.getSettings();
        if (
            settings.paused ||
            matchesIgnorePatterns(relPath, settings.ignorePatterns) ||
            this.policy.hiddenBy(relPath)?.hide === 'hidden'
        ) {
            return;
        }

        await this.availabilityRun;
        // Looked at again: a hide may have finished meanwhile. One still waiting syncs local changes as usual.
        if (this.policy.hiddenBy(relPath)?.hide === 'hidden') {
            return;
        }
        // A rename, move or delete through the drive that Proton Drive hasn't got yet is about it: left to the sync after
        // that, as an upload now could land on the old item, which still has this name there
        if (this.awaitsRemoteOp(relPath)) {
            return;
        }
        // Every look already running for the path first, one after another: looks that found the same one running would
        // otherwise all go on together once it ends (#108). Nothing awaits between the last check and taking the place
        let waited = false;
        for (let running = this.localQueue.get(relPath); running; running = this.localQueue.get(relPath)) {
            waited = true;
            await running.catch(() => {});
        }
        // Waited out earlier looks, possibly many: what was checked above may have changed meanwhile
        if (
            waited &&
            (this.stopped || this.holding() || this.policy.hiddenBy(relPath)?.hide === 'hidden' || this.awaitsRemoteOp(relPath))
        ) {
            return;
        }

        const task = this.observingLocal(async (since) => {
            const fullPath = path.join(this.localRoot(), relPath);
            const st = await stat(fullPath).catch(() => null);
            const dbRecord = this.stateDb.getItemByPath(relPath);

            if (!st?.isFile()) {
                this.forgetSettling(relPath);
            } else if (
                dbRecord?.type === 'file' &&
                dbRecord.syncStatus === 'synced' &&
                !changedSinceRecord(st, dbRecord) &&
                notWrittenSince(st, dbRecord)
            ) {
                // As it was recorded, and not written since (a spurious report, an app opening it read-write): nothing here
                // to upload, so no hash and no look at Proton Drive; a sync pass compares it with the cloud (#89). The ctime
                // is the system's, set by every write, so an edit that keeps the size and puts the old mtime back (a
                // container, cp -p, touch -r) still goes on to be hashed and uploaded
                return;
            } else if (changedSinceRecord(st, dbRecord) && this.stillBeingWritten(relPath, st)) {
                return; // Looked at again once it has stayed as it is
            }

            if (!st) {
                // Not a delete of this item: every file is missing from the folder; or the files came back after a hold
                // and no pass has looked at what is still missing yet (a copy cancelled part-way removes what it wrote)
                if (this.filesGone() || this.heldBack(relPath)) {
                    return;
                }
                // Local item was deleted: an edit baseline there stands for nothing any more
                this.stateDb.dropEditBaselines(relPath);
                if (dbRecord) {
                    try {
                        const remoteNode = await this.sdk.getNode(dbRecord.nodeUid);
                        await this.trashForDeletedLocal(relPath, remoteNode);
                    } catch {
                        this.stateDb.removeItemByPath(relPath);
                    }
                }
                return;
            }

            const remoteMap = new Map<string, NodeEntity>();
            const parentNode = await this.ensureParentFolderNode(relPath, remoteMap, since);

            if (st.isDirectory()) {
                const held = await this.trashHold(parentNode);
                if (held) {
                    // Its folder is in the Proton Drive trash: made there, it would be recorded as synced, and the folder's
                    // removal here would take it for an unchanged copy. Left here unrecorded, which that removal keeps (#160)
                    this.logger.warn(`Not making ${relPath} in Proton Drive: ${held}`);
                    return;
                }
                const { node: folder, created } = await createRemoteFolder(this.sdk, parentNode, path.basename(relPath));
                this.indexCreatedFolder(folder, relPath);
                const item: Omit<SyncedItemRecord, 'updatedAt'> = {
                    localRelPath: relPath,
                    nodeUid: folder.uid,
                    parentNodeUid: parentNode.uid,
                    type: 'folder',
                    localSha1: null,
                    remoteSha1: null,
                    localMtimeMs: st.mtimeMs,
                    remoteMtimeMs: folder.modificationTime.getTime(),
                    size: 0,
                    syncStatus: 'synced',
                    lastError: null,
                };
                if (!this.recordSynced(item, since) && created) {
                    this.adoptStrayNode(relPath, item, since);
                }
                if (this.journal.hasPending()) {
                    void this.replayRemoteOps(); // A move into it may have been waiting for it
                }
            } else if (st.isFile() && dbRecord) {
                // The cloud may have moved on since the record: another device's edit that no event has brought yet, or
                // one an event brought while this file was being written (#51 left it alone then). That is a conflict,
                // decided as a sync pass decides it, never an upload over the newer version (#72); so is a conflict
                // already waiting here. Whatever can't be told from here (the node can't be looked at, is in the trash,
                // or is no longer where this file is) is left to the sync pass, never uploaded over: a node gone from
                // Proton Drive would make the upload land on whatever now has that name.
                const node = await this.sdk.getNode(dbRecord.nodeUid).catch(() => null);
                if (!(await stat(fullPath).catch(() => null))?.isFile()) {
                    return; // Gone while Proton Drive was asked (freed, deleted): the next look at it decides
                }
                if (!node || node.trashTime || node.type !== NodeType.File || (await this.inTrashedFolder(node))) {
                    return;
                }
                // Moved in Proton Drive: the sync pass follows the move (#16), then compares. Where the file is now in
                // the cloud is told by the folder it is in here, not by the record's parent, which a move leaves as it was
                if (getName(node) !== path.posix.basename(relPath) || node.parentUid !== parentNode.uid) {
                    return;
                }
                // Read again: a sync pass may have recorded an upload of this file while Proton Drive was asked
                const record = this.stateDb.getItemByPath(relPath);
                if (!record || record.nodeUid !== node.uid) {
                    return; // Its record went, or names another node, meanwhile: a pass decided about it; the next look sees
                }
                const cloudMovedOn =
                    record.syncStatus === 'conflict' ||
                    cloudChangedSince(
                        { sha1: record.remoteSha1, mtimeMs: record.remoteMtimeMs, size: record.size },
                        {
                            sha1: node.activeRevision?.claimedDigests?.sha1 ?? null,
                            mtimeMs: (node.activeRevision?.claimedModificationTime ?? node.modificationTime).getTime(),
                            size: getClaimedSize(node) ?? record.size,
                        },
                    );
                if (cloudMovedOn) {
                    const localInfo = { isDirectory: false, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
                    await this.reconcileSinglePath(relPath, node, localInfo, record, remoteMap, this.stateDb.getSettings(), since);
                } else {
                    await this.uploadLocalToRemote(relPath, fullPath, parentNode, since, record.nodeUid);
                }
            } else if (st.isFile()) {
                // No record: where Proton Drive has a file of that name, it is decided as a sync pass decides it (an
                // edit of what the drive showed, with a baseline; the conflict handling otherwise), never by uploading
                // over it. Such a file found only by its upload being refused goes the same way.
                const localInfo = { isDirectory: false, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
                const there =
                    (await this.cloudFileAt(relPath)) ?? (await this.uploadNewFile(relPath, fullPath, parentNode, since));
                if (there) {
                    const now = this.stateDb.getSettings();
                    const dbRecordNow = this.recordOf(relPath, there.uid); // Recorded meanwhile, by a pass
                    await this.reconcileSinglePath(relPath, there, localInfo, dbRecordNow, remoteMap, now, since);
                }
            }
        });

        this.localQueue.set(relPath, task);
        try {
            await task;
        } finally {
            if (this.localQueue.get(relPath) === task) {
                this.localQueue.delete(relPath); // Only its own place, should another look ever have taken it
            }
        }
    }

    // Whether a local file that changed is still being written, by what it was at earlier looks (#51): its size and
    // times must stay the same for a while (SETTLE_QUIET_MS, longer each time it is seen changing again) before it
    // uploads. Until then it is left alone, and looked at again (as the watcher reports a change) once it should have
    // settled. A file whose ctime (set by the system as it changes, unlike an mtime, which cp -a or rsync can put
    // anywhere) is older than that has settled already: such files (edited while the daemon was down, say) upload at the
    // first look, without a wait each. A file that keeps changing is let through anyway once it has for
    // SETTLE_MAX_WAIT_MS, and then at most that often: it uploads as it is (a change during the upload uploads again),
    // and its path is never kept from syncing for long. A file let through stays so while it is as it was then, so the
    // look after the one that settled it (as handling it goes on) never waits again.
    private stillBeingWritten(relPath: string, st: Stats): boolean {
        const settle = this.options.settle ?? {};
        const baseQuietMs = settle.quietMs ?? SETTLE_QUIET_MS;
        if (baseQuietMs <= 0) {
            return false;
        }
        const now = (settle.now ?? Date.now)();
        for (const [rel, entry] of this.settlingFiles) {
            if (entry.settled && now - entry.since > SETTLED_KEPT_MS) {
                this.settlingFiles.delete(rel); // Long settled: its ctime says so by now
            }
        }
        const seen = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        const earlier = this.settlingFiles.get(relPath);
        if (earlier?.settled && earlier.seen === seen) {
            if (earlier.forced && (now - earlier.since >= earlier.quietMs || Date.now() - st.ctimeMs >= earlier.quietMs)) {
                earlier.forced = false; // Let through while it changed, and quiet since: settled after all
            }
            return false;
        }
        earlier?.cancel();
        // A file let through that changes again starts over
        const ongoing = earlier && !earlier.settled ? earlier : null;
        const same = ongoing?.seen === seen;
        const quietMs = !ongoing
            ? baseQuietMs
            : same
              ? ongoing.quietMs
              : Math.min(ongoing.quietMs * 2, settle.maxQuietMs ?? SETTLE_MAX_QUIET_MS);
        const since = ongoing && same ? ongoing.since : now;
        const changingSince = ongoing?.changingSince ?? now;
        const maxWaitMs = settle.maxWaitMs ?? SETTLE_MAX_WAIT_MS;
        // ctime is by the system clock: so is Date.now(), whatever clock the looks are timed by
        const quiet = now - since >= quietMs || Date.now() - st.ctimeMs >= quietMs;
        if (quiet || now - changingSince >= maxWaitMs) {
            this.settlingFiles.set(relPath, { seen, since: now, quietMs, changingSince: now, settled: true, forced: !quiet, cancel: () => {} });
            return false;
        }
        const schedule =
            settle.schedule ??
            ((run: () => Promise<void>, delayMs: number) => {
                const timer = setTimeout(() => void run(), delayMs);
                timer.unref?.(); // Never what keeps a one-off run (the CLI's sync) going
                return () => clearTimeout(timer);
            });
        const lookAgain = async () => {
            const look = this.handleLocalFileChange(relPath).catch((error: unknown) => {
                this.logger.warn(`Could not look at ${relPath} again once written: ${error}`);
            });
            this.runningLooks.add(look);
            try {
                await look;
            } finally {
                this.runningLooks.delete(look);
            }
        };
        const cancel = schedule(lookAgain, Math.min(since + quietMs, changingSince + maxWaitMs) - now);
        this.settlingFiles.set(relPath, { seen, since, quietMs, changingSince, settled: false, cancel });
        return true;
    }

    // For a one-off sync (the CLI's): waits, up to timeoutMs, for the files still being written to settle and be looked
    // at again. Answers how many are still waiting. A look already running when the time is up (an upload, say) is
    // waited for without limit, as a sync pass's upload is.
    async waitForSettling(timeoutMs: number): Promise<number> {
        const deadline = Date.now() + timeoutMs;
        const waiting = () => [...this.settlingFiles.values()].filter((entry) => !entry.settled).length;
        while ((waiting() > 0 || this.runningLooks.size > 0) && Date.now() < deadline) {
            await Bun.sleep(Math.min(100, deadline - Date.now()));
        }
        await Promise.all(this.runningLooks);
        return waiting();
    }

    // Waits for the looks at settling files that are running now (after stop(), before the database is closed), up to
    // timeoutMs if given. Answers whether none is still running.
    async waitForRunningLooks(timeoutMs?: number): Promise<boolean> {
        const running = Promise.all(this.runningLooks);
        if (timeoutMs === undefined) {
            await running;
            return true;
        }
        return settlesWithin(running, timeoutMs);
    }

    // Whether a node sits in a folder that is in the Proton Drive trash (trashing a folder marks only the folder), up to
    // the root of My files. When that can't be told, it counts as in one: the caller leaves the item to the sync pass.
    private async inTrashedFolder(node: NodeEntity): Promise<boolean> {
        const root = await this.getRootFolder().catch(() => null);
        if (!root) {
            return true;
        }
        const seen = new Set<string>();
        for (let uid = node.parentUid; uid && uid !== root.uid; ) {
            if (seen.has(uid)) {
                return true;
            }
            seen.add(uid);
            const folder = await this.sdk.getNode(uid).catch(() => null);
            if (!folder || folder.trashTime) {
                return true;
            }
            uid = folder.parentUid;
        }
        return false;
    }

    // Whether a file was let through only because it kept changing for SETTLE_MAX_WAIT_MS, and hasn't gone quiet since:
    // it uploads as it is, but anything that would replace it (keep-both downloading the cloud version) waits (#70)
    private stillChangingWhenLetThrough(relPath: string): boolean {
        const entry = this.settlingFiles.get(relPath);
        return entry?.settled === true && entry.forced === true;
    }

    private forgetSettling(relPath: string): void {
        this.settlingFiles.get(relPath)?.cancel();
        this.settlingFiles.delete(relPath);
    }

    private async handleRemoteDriveEvent(event: DriveEvent): Promise<void> {
        if (this.holding()) {
            return; // The pass after the move, at start(), catches up
        }
        if (!(await this.verifyAccount())) {
            return; // The account not checked to be the records' (#35): the pass, which checks it, catches up
        }
        if (this.filesGone()) {
            return; // The pass once the files are back catches up
        }
        await this.tracked(() => this.handleRemoteDriveEventNow(event));
    }

    private async handleRemoteDriveEventNow(event: DriveEvent): Promise<void> {
        const settings = this.stateDb.getSettings();
        if (settings.paused || !this.auth.isLoggedIn()) {
            return;
        }

        if (
            event.type === DriveEventType.TreeRefresh ||
            event.type === DriveEventType.FastForward ||
            event.type === DriveEventType.SharedWithMeUpdated
        ) {
            if (event.type !== DriveEventType.SharedWithMeUpdated) {
                this.onlineOnlyCrawlDue = true; // Changes may have been missed anywhere, online-only folders included
            }
            await this.reconcileNow();
            return;
        }

        if (event.type === DriveEventType.NodeDeleted) {
            this.index.removeSubtree(event.nodeUid);
            const tracked = this.stateDb.getItemByNodeUid(event.nodeUid);
            // One with a rename or move through the drive on its way is left to its replay, which keeps its local copy
            if (tracked && !this.awaitsRemoteOp(tracked.localRelPath, event.nodeUid)) {
                await this.removeAfterCloudDelete(tracked.localRelPath, 'deleted');
            }
            return;
        }

        if (event.type === DriveEventType.NodeCreated || event.type === DriveEventType.NodeUpdated) {
            if (event.isTrashed) {
                this.index.removeSubtree(event.nodeUid);
                const tracked = this.stateDb.getItemByNodeUid(event.nodeUid);
                if (tracked && !this.awaitsRemoteOp(tracked.localRelPath, event.nodeUid)) {
                    await this.removeAfterCloudDelete(tracked.localRelPath, 'trashed');
                }
                return;
            }

            if (event.parentNodeUid) {
                await this.indexChangeInOnlineOnlyFolder(event.parentNodeUid);
            }
            // Trigger incremental reconcile
            await this.reconcileNow();
        }
    }

    // The cloud copy of a synced item is gone: deleted, or moved to the Proton Drive trash. Its local copy goes too, but
    // only where that loses nothing: unchanged synced copies are removed as Free up space removes them, each record just
    // before its file. Anything that exists only on this computer (ignored, not a regular file, new or edited) is moved
    // to the desktop Trash, and the user is told; what can't be moved there stays where it is and uploads again as a new
    // item. No record under the path is left either way: a record without its file reads as the user deleting it, which
    // would trash something in the cloud.
    // It takes its turn on availabilityRun, so it never interleaves with Free up space or Hide (whose putBack could bring
    // back a record that this then leaves without its file), and local change handling waits for it.
    private async removeAfterCloudDelete(relPath: string, reason: 'deleted' | 'trashed'): Promise<void> {
        if (relPath === '') {
            return; // Never the whole sync folder
        }
        await this.inAvailabilityRun(async () => {
            if (this.isResolvingWithin(relPath)) {
                // A conflict of it, or of something in it, is being resolved: removing it now would pull the files and
                // records out from under that. The next pass finds it gone and removes it then (#150)
                this.logger.info(`Not removing ${relPath} here yet: a conflict in it is being resolved`);
                return;
            }
            if (this.stateDb.getItemByPath(relPath)) {
                await this.removeLocalCopyAfterCloudDelete(relPath, reason);
            }
            // Otherwise dealt with meanwhile (by another removal, say): whatever is left syncs as usual
        });
    }

    private async removeLocalCopyAfterCloudDelete(relPath: string, reason: 'deleted' | 'trashed'): Promise<void> {
        const settings = this.stateDb.getSettings();
        const root = this.localRoot();
        this.watcher.suppressPath(relPath);
        const scan = await scanLocalCopies({
            syncDir: root,
            relPath,
            ignorePatterns: settings.ignorePatterns,
            stopAtFirst: false,
            isUnchangedSyncedCopy: (rel, fullPath, st) => this.isUnchangedSyncedCopy(rel, fullPath, st),
        });
        const { moved, stayed } = await this.whileRemoving(async (records) => {
            const { kept } = await removeScannedEntries({
                syncDir: root,
                entries: scan.entries,
                keep: new Set(scan.localOnly.map((item) => item.relPath)),
                mode: 'keep-changed',
                dropRecord: records.drop,
                shouldContinue: () => true, // Stopping halfway would leave synced copies behind, unrecorded, to upload
            });
            // The cloud copy is gone, so nothing under the path stays recorded, kept things included: dropped before
            // any of them is moved or removed. Every scanned path is dropped too, recorded or not, so recordSynced
            // won't record any of them while this runs, nor afterwards once it is gone: a new item still uploading
            // would otherwise be recorded after going to the desktop Trash, and taken for a local delete.
            for (const item of this.stateDb.getItemsUnder(relPath)) {
                records.drop(item.localRelPath);
            }
            for (const entry of scan.entries) {
                records.drop(entry.relPath);
            }
            return this.clearKeptAfterCloudDelete(root, relPath, scan.entries, kept);
        });
        const told: string[] = [];
        if (moved > 0) {
            told.push(`${moved} item(s) that existed only on this computer were moved to your Trash.`);
        }
        if (stayed > 0) {
            // Where the user sees it, never the virtual drive's backing store
            const where = path.join(settings.syncDir, relPath);
            told.push(`${stayed} item(s) that existed only on this computer were kept at ${where} and will upload again.`);
        }
        if (told.length === 0) {
            this.stateDb.logActivity({
                action: 'delete-local',
                localRelPath: relPath,
                details:
                    reason === 'trashed'
                        ? 'Removed local item after it was moved to the Proton Drive Trash'
                        : 'Removed local item after it was deleted on Proton Drive',
            });
            return;
        }
        const notice = `${relPath} was removed from Proton Drive. ${told.join(' ')}`;
        this.stateDb.logActivity({ action: 'delete-local', localRelPath: relPath, details: notice });
        sendDesktopNotification({
            title: 'Proton Drive: items only on this computer were kept',
            body: notice,
            urgency: 'normal',
            enabled: settings.notificationsEnabled,
        });
    }

    // Clears what a removal after a cloud delete left in relPath (see removeAfterCloudDelete), with its records already
    // dropped, and says how many things went to the desktop Trash and how many stayed.
    // - Our own downloads still being written are deleted: what they were fetching is no longer in the cloud.
    // - The topmost kept things go to the desktop Trash: one with nothing kept inside it, or a folder kept along with
    //   everything in it, but not a folder that also held removed things and stayed only for what it still holds.
    // - Folders left empty are removed, one at a time, never recursively.
    private async clearKeptAfterCloudDelete(
        root: string,
        relPath: string,
        entries: ScanEntry[],
        kept: string[],
    ): Promise<{ moved: number; stayed: number }> {
        const scannedAsFile = new Set(entries.filter((e) => e.signature.startsWith('file:')).map((e) => e.relPath));
        const isOurDownload = (rel: string) => scannedAsFile.has(rel) && isEngineTempName(path.posix.basename(rel));
        for (const rel of kept.filter(isOurDownload)) {
            await unlink(path.join(root, rel)).catch(() => {});
        }
        const stillKept = new Set(kept.filter((rel) => !isOurDownload(rel)));
        // The folders above `rel`, up to and including relPath (everything scanned is relPath or inside it)
        const foldersAbove = function* (rel: string) {
            for (let p = rel; p.length > relPath.length; ) {
                p = p.slice(0, p.lastIndexOf('/'));
                yield p;
            }
        };
        const holdsRemoved = new Set<string>();
        const holdsKept = new Set<string>();
        for (const entry of entries) {
            for (const folder of foldersAbove(entry.relPath)) {
                (stillKept.has(entry.relPath) ? holdsKept : holdsRemoved).add(folder);
            }
        }
        const candidates = new Set([...stillKept].filter((rel) => !holdsKept.has(rel) || !holdsRemoved.has(rel)));
        const topmost = [...candidates].filter((rel) => !Array.from(foldersAbove(rel)).some((p) => candidates.has(p)));
        let moved = 0;
        let stayed = 0;
        for (const rel of topmost.sort()) {
            const fullPath = path.join(root, rel);
            const st = await lstat(fullPath).catch(() => null);
            if (!st || (st.isDirectory() && (await readdir(fullPath).catch(() => null))?.length === 0)) {
                continue; // Gone meanwhile, or an empty folder: nothing in it to keep
            }
            let wasMoved = false;
            // In the virtual layout the item is in the hidden store, but the user knows it under the drive (#40)
            const shownPath = this.inBackingStore() ? path.join(this.stateDb.getSettings().syncDir, rel) : undefined;
            try {
                wasMoved = await this.moveToDesktopTrash(fullPath, shownPath);
            } catch {
                // Counts as not moved
            }
            if (wasMoved) {
                moved += 1;
            } else {
                stayed += 1;
            }
        }
        // Folders left empty, deepest first (kept lists what is in a folder before the folder)
        for (const rel of kept) {
            const fullPath = path.join(root, rel);
            if ((await lstat(fullPath).catch(() => null))?.isDirectory()) {
                await rmdir(fullPath).catch(() => {}); // Fails, as it should, while anything is still in it
            }
        }
        return { moved, stayed };
    }

    private get moveToDesktopTrash(): MoveToDesktopTrash {
        return this.options.moveToDesktopTrash ?? homeTrash();
    }

    // A synced item the cloud no longer lists at its path. Renamed or moved there, its local copy follows; deleted or
    // trashed (a listing can't tell which), or moved where its local copy can't follow (something is already there,
    // say), it goes as after a cloud delete.
    private async afterGoneFromCloudPath(relPath: string): Promise<void> {
        // Looked at again: earlier in this pass it may have been moved away already, found from its new path
        const record = this.stateDb.getItemByPath(relPath);
        if (!record) {
            return;
        }
        if (this.isResolvingWithin(relPath)) {
            // A conflict of it, or of something in it, is being resolved: the next pass decides where it went, or that it
            // went (#104, #140, #150)
            return;
        }
        const now = await this.currentRemotePath(record.nodeUid, relPath);
        if (now === undefined || now === relPath) {
            // The cloud couldn't be asked (offline, say), or still has it here after all (a listing that missed it):
            // left as it is for the next pass, as removing it could lose what that one would follow
            return;
        }
        if (now !== null && (await this.followRemoteMove(record.nodeUid, relPath, now))) {
            return;
        }
        await this.removeAfterCloudDelete(relPath, 'deleted');
    }

    // Where a node is in My files now, for one the listing of `notAt`'s folder no longer shows there: from the remote
    // index, or else from the cloud, as the index drops a node whose old folder was listed before its new one. Null when
    // it is gone (the cloud says it isn't there, or that it is trashed), or its folder is one the index doesn't hold;
    // undefined when the cloud couldn't say (offline, rate limited, unreadable).
    private async currentRemotePath(uid: string, notAt: string): Promise<string | null | undefined> {
        const indexed = this.index.getByUid(uid);
        if (indexed && indexed.relPath !== notAt) {
            return indexed.relPath;
        }
        let node: NodeEntity;
        try {
            node = await this.sdk.getNode(uid);
        } catch (error: unknown) {
            // The SDK says ValidationError when the API has no such node; failing to load one is another error
            if (error instanceof ValidationError) {
                return null;
            }
            this.logger.warn(`Could not ask Proton Drive where ${notAt} went; looking again next sync: ${error}`);
            return undefined;
        }
        const parent = node.parentUid ? this.index.getByUid(node.parentUid) : null;
        if (node.trashTime || !parent || parent.type !== 'folder') {
            return null;
        }
        return parent.relPath === '' ? getName(node) : `${parent.relPath}/${getName(node)}`;
    }

    // A synced item renamed or moved in the cloud: its local copy moves to match, with everything in it (ignored and
    // unsynced things included), and its records with it, so nothing is downloaded again or lost. Its pin and hide flags
    // follow the node by themselves. Returns false, having moved nothing, when its local copy isn't at fromRel, something
    // is already at toRel (on disk or in the records), or toRel is no place for a local copy: hidden, ignored, or in a
    // folder the remote index doesn't hold. A folder above toRel that isn't on this computer (an online-only one) is
    // created to hold it; the next pass records it.
    // It takes its turn on availabilityRun, like the removals, so it never interleaves with one on the same items, and
    // local change handling waits for it.
    private async followRemoteMove(nodeUid: string, fromRel: string, toRel: string): Promise<boolean> {
        if (fromRel === '' || toRel === '' || toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
            return false;
        }
        return this.inAvailabilityRun(async () => {
            if (
                this.stateDb.getItemByPath(fromRel)?.nodeUid !== nodeUid ||
                this.stateDb.hasItemsUnder(toRel) ||
                matchesIgnorePatterns(toRel, this.stateDb.getSettings().ignorePatterns) ||
                this.policy.hiddenBy(toRel)?.hide === 'hidden' ||
                !(await this.existsLocally(fromRel)) ||
                (await this.existsLocally(toRel))
            ) {
                return false;
            }
            const root = this.localRoot();
            const parentRel = path.posix.dirname(toRel);
            if (parentRel !== '.' && !(await this.existsLocally(parentRel))) {
                if (this.index.getByPath(parentRel)?.type !== 'folder') {
                    return false;
                }
                for (let slash = toRel.indexOf('/'); slash !== -1; slash = toRel.indexOf('/', slash + 1)) {
                    this.watcher.suppressPath(toRel.slice(0, slash));
                }
                try {
                    await mkdir(path.join(root, parentRel), { recursive: true });
                } catch (error: unknown) {
                    this.logger.warn(`Could not make ${parentRel} to move ${fromRel} into: ${error}`);
                    return false;
                }
            }
            this.watcher.suppressPath(fromRel);
            this.watcher.suppressPath(toRel);
            const moved = await this.whileRemoving(async (records) => {
                // The item and its records move together, with nothing able to run in between: neither path is ever
                // seen with a record but no file, which reads as the user deleting it. Something that appeared at toRel
                // since the look above is never replaced.
                try {
                    if (!moveWithoutReplacing(path.join(root, fromRel), path.join(root, toRel))) {
                        return false;
                    }
                } catch (error: unknown) {
                    this.logger.warn(`Could not move ${fromRel} to ${toRel} to follow Proton Drive: ${error}`);
                    return false;
                }
                try {
                    this.stateDb.renameItemPath(fromRel, toRel, this.cloudParentOf(toRel));
                } catch (error: unknown) {
                    this.logger.warn(`Could not move the records of ${fromRel} to ${toRel}, so it goes back: ${error}`);
                    let back = false;
                    try {
                        back = moveWithoutReplacing(path.join(root, toRel), path.join(root, fromRel));
                    } catch {
                        // Counts as not back
                    }
                    if (!back) {
                        // Stuck at toRel: its records can't stay at fromRel without it, so it syncs from there as new
                        records.dropSubtree(fromRel);
                    }
                    return false;
                }
                // Work still under way anywhere in the old subtree (a new file still uploading, say) must not record its
                // old path once done: that record would have no file
                records.dropSubtree(fromRel);
                return true;
            });
            if (moved) {
                this.stateDb.logActivity({
                    action: 'sync',
                    localRelPath: toRel,
                    details: `Moved locally to follow a rename in Proton Drive: ${fromRel} → ${toRel}`,
                });
            }
            return moved;
        });
    }

    // The sync pass lists only the folders on this computer, and the crawl of the others runs only now and then, so a
    // change inside a folder that isn't here re-lists just that folder for the index: an item added in the cloud can
    // then be pinned at once. Hidden folders are never listed.
    private async indexChangeInOnlineOnlyFolder(parentUid: string): Promise<void> {
        const parent = this.index.getByUid(parentUid);
        if (
            !parent ||
            parent.relPath === '' ||
            parent.type !== 'folder' ||
            this.policy.hiddenBy(parent.relPath)?.hide === 'hidden' ||
            (await this.existsLocally(parent.relPath))
        ) {
            return;
        }
        try {
            const node = await this.sdk.getNode(parentUid);
            this.recordListing(node, parent.relPath, await listFolderChildren(this.sdk, node));
        } catch (error: unknown) {
            this.logger.warn(`Could not list ${parent.relPath} for the remote index: ${error}`);
        }
    }

    // Records the subtrees of folders found online-only during a pass, one after another.
    private async crawlOnlineOnly(folders: OnlineOnlyFolder[]): Promise<void> {
        for (const folder of folders) {
            if (this.stateDb.getSettings().paused) {
                return;
            }
            this.currentAction = `Listing /my-files/${folder.relPath}`;
            await this.indexRemoteSubtree(folder.node, folder.relPath);
        }
    }

    // Renames or moves an item of My files through the virtual drive. It happens here at once (its local copy if it has
    // one, its records, and the remote index, so listings show it), and in Proton Drive from the journal of remote
    // operations (see replayRemoteOps), so it also works offline. Replacing an existing file (an editor's atomic save)
    // keeps the replaced file's identity: the new content uploads as a new revision of it, and the file that replaced it
    // goes to the Proton Drive trash if it was ever uploaded. Only a file on this computer can replace, and only a file.
    // Moving into an ignored name takes the item out of what is synced: Proton Drive keeps it where it was. With
    // noReplace, nothing that is at toRel (here or only in Proton Drive) is ever replaced.
    // With deadlineMs, a rename whose turn comes after it is refused with `Timed out waiting: <path>` (EIO), changing
    // nothing (deleteItem and truncateItem take it too).
    // Rejects with a DriveOpError: `Not found: <path>` (ENOENT), `Already exists: <path>` (EEXIST), `Hidden: <path>`
    // (EACCES), or EXDEV for an online-only file replacing another (it has no local copy to put there: mv then copies it,
    // which downloads it, and deletes it); with `Invalid path: <path>` for a path that climbs out of My files.
    async renameItem(
        fromRel: string,
        toRel: string,
        opts: { noReplace?: boolean; deadlineMs?: number } = {},
    ): Promise<void> {
        this.refuseWhileHeld();
        this.refuseWhileFilesGone();
        const from = normalizeDrivePath(fromRel);
        const to = normalizeDrivePath(toRel);
        if (from === '' || to === '') {
            throw new Error("The whole of Proton Drive can't be renamed or replaced");
        }
        if (from === to) {
            return;
        }
        if (to.startsWith(`${from}/`)) {
            throw new Error(`Can't move ${from} into itself`);
        }
        await this.afterResolutions([from, to], opts.deadlineMs);
        await this.inAvailabilityRun(() => {
            this.refuseWhileHeld(); // again: a move of the files may have begun while it waited
            this.inTime(opts.deadlineMs, from);
            return this.drivingAt([from, to], () => this.renameLocally(from, to, opts.noReplace === true));
        });
        void this.replayRemoteOps();
    }

    // Deletes an item of My files through the virtual drive: its local copy (everything in it, things that exist only on
    // this computer included, as the user asked), its records and its index entries go at once, and Proton Drive moves it
    // to its trash from the journal, downloading nothing. An ignored item is only ever local, so only its local copy goes.
    // With onlyIfEmpty (rmdir), only a folder that holds nothing, here or in Proton Drive, is deleted. With trash (Move
    // to Trash through the drive), what exists only on this computer (never uploaded, or changed since) goes to the
    // desktop Trash rather than away, as after a cloud delete, and the user is told.
    // Rejects with a DriveOpError: `Not found: <path>` (ENOENT), `Hidden: <path>` (EACCES), with onlyIfEmpty `Not empty:
    // <path>` (ENOTEMPTY) or `Not a folder: <path>` (EIO); or with `Invalid path: <path>`.
    async deleteItem(
        relPath: string,
        opts: { onlyIfEmpty?: boolean; trash?: boolean; deadlineMs?: number } = {},
    ): Promise<void> {
        this.refuseWhileHeld();
        const rel = normalizeDrivePath(relPath);
        if (rel === '') {
            throw new Error("The whole of Proton Drive can't be deleted");
        }
        await this.afterResolutions([rel], opts.deadlineMs);
        await this.inAvailabilityRun(() => {
            this.refuseWhileHeld(); // again: a move of the files may have begun while it waited
            this.inTime(opts.deadlineMs, rel);
            return this.drivingAt([rel], () => this.deleteLocally(rel, opts.onlyIfEmpty === true, opts.trash === true));
        });
        void this.replayRemoteOps();
    }

    // A drive rename or delete of a file being resolved, by hand or by the conflict setting (or of a folder holding one),
    // waits for that to finish: done meanwhile, it would end the conflict and drop the record under the resolution, whose
    // upload could still land (#112, #121). Waits no longer than the drive op's deadline, which then refuses it
    private async afterResolutions(paths: string[], deadlineMs?: number): Promise<void> {
        for (;;) {
            const ends = [...this.resolutionEnds].filter(([r]) => paths.some((p) => isSameOrUnder(r, p))).map(([, end]) => end);
            if (ends.length === 0) {
                return;
            }
            const left = deadlineMs === undefined ? null : deadlineMs - Date.now();
            if (left !== null && left <= 0) {
                return; // inTime refuses it
            }
            await (left === null ? Promise.all(ends) : Promise.race([Promise.all(ends), Bun.sleep(left)]));
        }
    }

    // Runs a drive rename or delete with its paths marked, so that a resolution by hand doesn't start on them meanwhile;
    // one that started since the wait above (its turn came while this one queued) refuses this one instead (#112)
    private async drivingAt<T>(paths: string[], work: () => Promise<T>): Promise<T> {
        const resolving = [...this.manualResolvingPaths, ...this.strategyResolvingPaths].find((r) =>
            paths.some((p) => isSameOrUnder(r, p)),
        );
        if (resolving !== undefined) {
            throw new DriveOpError('EIO', `Busy resolving a conflict: ${resolving}`);
        }
        for (const p of paths) {
            this.drivingPaths.set(p, (this.drivingPaths.get(p) ?? 0) + 1);
        }
        try {
            return await work();
        } finally {
            for (const p of paths) {
                const left = (this.drivingPaths.get(p) ?? 1) - 1;
                if (left > 0) {
                    this.drivingPaths.set(p, left);
                } else {
                    this.drivingPaths.delete(p);
                }
            }
        }
    }

    // Turns an online-only file into an empty local one for the virtual drive (an app opened it with O_TRUNC, or cut it
    // to nothing), downloading nothing. What the drive showed of it, its index entry, is kept as the baseline that the
    // file's new content is an edit of (see EditBaseline): a new revision of that node while the cloud still has that
    // version, the conflict handling once it doesn't. The empty file is never put over anything that appeared meanwhile.
    // Rejects with a DriveOpError: `Not found: <path>` (ENOENT) for anything but an online-only file, `Hidden: <path>`
    // (EACCES), `Already exists: <path>` (EEXIST) when it is on this computer; or with `Invalid path: <path>`.
    async truncateItem(relPath: string, opts: { deadlineMs?: number } = {}): Promise<void> {
        this.refuseWhileHeld();
        this.refuseWhileFilesGone();
        const rel = normalizeDrivePath(relPath);
        await this.inAvailabilityRun(() => {
            this.inTime(opts.deadlineMs, rel);
            return this.truncateLocally(rel);
        });
    }

    // Drive changes and availability changes made while the files move would touch a half-moved tree
    private refuseWhileHeld(): void {
        if (this.holding()) {
            throw new DriveOpError('EIO', BUSY_MOVING);
        }
        this.refuseForAnotherAccount();
    }

    // Whether the records are of the account signed in to (its My files root): remembered on the first pass, and checked
    // at every pass after. Records of another (signed out of, and another signed in to) are never acted on: their nodes
    // aren't in this account, which would read as cloud deletes of the files here, or upload them under the old
    // structure (#35). The user chooses (startFreshForThisAccount, or signing back in to that account)
    private recordsAreOf(rootUid: string): boolean {
        const recorded = this.stateDb.getMeta(ACCOUNT_ROOT);
        if (recorded === null) {
            // Records from before this was remembered: this account's only if what they say is at the top is in its root
            const top = this.stateDb.getAllItems().filter((item) => !item.localRelPath.includes('/') && item.parentNodeUid !== null);
            if (top.length === 0 || top.some((item) => item.parentNodeUid === rootUid)) {
                this.stateDb.setMeta(ACCOUNT_ROOT, rootUid);
                this.accountMatches();
                return true;
            }
        } else if (recorded === rootUid) {
            this.accountMatches();
            return true;
        }
        if (!this.accountMismatch) {
            this.logger.warn('Signed in to a different Proton account than this computer synced with: not syncing until the user chooses');
        }
        this.accountMismatch = { message: ACCOUNT_MISMATCH_MESSAGE };
        this.stateDb.setMeta(ACCOUNT_MISMATCH, '1');
        this.state = 'error'; // however it was found (a pass, a change, the journal): the status says so
        this.lastError = ACCOUNT_MISMATCH_MESSAGE;
        return false;
    }

    private accountMatches(): void {
        if (this.accountMismatch && this.lastError === this.accountMismatch.message) {
            this.lastError = null;
        }
        this.accountMismatch = null;
        if (this.stateDb.getMeta(ACCOUNT_MISMATCH) !== null) {
            this.stateDb.deleteMeta(ACCOUNT_MISMATCH);
        }
    }

    // What is known of the account signed in to is dropped (its root, whether it was checked, a mismatch found), and a
    // lookup still running is kept from filling it in (see accountGeneration)
    private forgetAccount(): void {
        this.accountGeneration += 1;
        this.rootNode = null;
        this.accountVerified = false;
        if (this.accountMismatch) {
            if (this.lastError === this.accountMismatch.message) this.lastError = null; // said again, if it still holds
            this.accountMismatch = null;
        }
    }

    // Whether the account signed in to is checked to be the records': at once when it was since the engine started, or
    // by looking up its root now; false when that can't be told (offline), so nothing acts on unchecked records (#35)
    private async verifyAccount(): Promise<boolean> {
        if (this.accountMismatch) return false;
        if (this.accountVerified) return true;
        const generation = this.accountGeneration;
        const root = await this.getRootFolder().catch(() => null);
        if (root === null || generation !== this.accountGeneration || !this.recordsAreOf(root.uid)) return false;
        this.accountVerified = true;
        return true;
    }

    private refuseForAnotherAccount(): void {
        if (this.accountMismatch) {
            throw new DriveOpError('EIO', this.accountMismatch.message);
        }
    }

    // For what changes the records or the files they are of at once (availability, the files-missing choices, a
    // resolution by hand): refused until the account is checked to be the records', looking it up now if need be (#35)
    private async refuseUntilAccountChecked(): Promise<void> {
        if (!(await this.verifyAccount())) {
            throw new DriveOpError('EIO', this.accountMismatch?.message ?? ACCOUNT_NOT_CHECKED);
        }
    }

    // Start fresh with the account signed in to: the records, index, availability, journal, conflicts and edit baselines
    // of the other account go, and the files on this computer stay, to be synced to this account as new files (a fresh
    // install's first sync). Nothing is deleted or trashed, here or in either account (#35)
    async startFreshForThisAccount(): Promise<void> {
        if (this.holding()) {
            throw new Error(BUSY_MOVING);
        }
        if (!this.accountMismatch) {
            throw new Error('The files on this computer are synced with the same Proton account: there is nothing to start fresh from');
        }
        const generation = this.accountGeneration;
        const root = await this.getRootFolder();
        const changedMeanwhile = () => generation !== this.accountGeneration || !this.accountMismatch || this.holding();
        if (changedMeanwhile()) {
            throw new Error('Signed out, or the files began to move, meanwhile: nothing was changed');
        }
        // Checked against the account signed in to now, never only by what is remembered: a mismatch kept from before
        // (see ACCOUNT_MISMATCH) may be over, signed back in to the records' account, and starting fresh then would
        // drop their records and the drive changes still to be sent
        if (this.recordsAreOf(root.uid)) {
            this.accountVerified = true;
            throw new Error('The files on this computer are synced with the same Proton account: there is nothing to start fresh from');
        }
        await this.inAvailabilityRun(async () => {
            if (changedMeanwhile()) {
                throw new Error('Signed out, or the files began to move, meanwhile: nothing was changed');
            }
            this.stateDb.connection.transaction(() => {
                for (const table of ['synced_items', 'conflicts', 'drive_edit_baselines', 'remote_nodes', 'remote_ops', 'availability']) {
                    this.stateDb.connection.run(`DELETE FROM ${table}`);
                }
                this.stateDb.setMeta(PIN_ROOT_ON_FIRST_SYNC, '1'); // syncs everything, as a fresh install does
                this.stateDb.setMeta(ACCOUNT_ROOT, root.uid);
                this.stateDb.deleteMeta(ACCOUNT_MISMATCH);
            })();
            this.keepBothCopies.clear(); // the index, journal and policy are read from their tables: nothing else to drop
        });
        this.accountMismatch = null;
        this.accountVerified = true;
        this.lastError = null;
        this.state = 'idle';
        this.stateDb.logActivity({
            action: 'auth',
            localRelPath: '/',
            details: 'Started fresh with this Proton account: the files on this computer sync to it as new files',
        });
    }

    // A drive change carries the time the helper stops waiting for it (it has told the app EIO by then): one whose turn
    // comes later is refused, before it touches anything, rather than done behind the app's back.
    private inTime(deadlineMs: number | undefined, relPath: string): void {
        if (deadlineMs !== undefined && Date.now() > deadlineMs) {
            throw new DriveOpError('EIO', `Timed out waiting: ${relPath}`);
        }
    }

    private async truncateLocally(rel: string): Promise<void> {
        if (rel !== '' && this.policy.hiddenBy(rel) !== null) {
            throw new DriveOpError('EACCES', `Hidden: ${rel}`);
        }
        const fullPath = path.join(this.localRoot(), rel);
        if (rel !== '' && lstatSync(fullPath, { throwIfNoEntry: false })) {
            throw new DriveOpError('EEXIST', `Already exists: ${rel}`);
        }
        const ignored = matchesIgnorePatterns(rel, this.stateDb.getSettings().ignorePatterns);
        const entry = rel === '' || ignored ? null : this.liveIndexEntry(rel);
        if (!entry || entry.type !== 'file' || isProvisional(entry.uid)) {
            throw new DriveOpError('ENOENT', `Not found: ${rel}`);
        }
        await mkdir(path.dirname(fullPath), { recursive: true });
        // First, so that whoever sees the file (the watcher, a pass) finds what it is an edit of
        this.stateDb.recordEditBaseline({
            relPath: rel,
            nodeUid: entry.uid,
            parentUid: entry.parentUid,
            sha1: entry.sha1,
            mtimeMs: entry.mtimeMs,
            size: entry.size,
        });
        try {
            await writeFile(fullPath, '', { flag: 'wx' });
        } catch (error: unknown) {
            this.stateDb.dropEditBaselines(rel);
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new DriveOpError('EEXIST', `Already exists: ${rel}`, { cause: error });
            }
            throw error;
        }
    }

    // A baseline whose file has gone (deleted outside the drive, say) stands for nothing any more: a file put there later
    // is a new one. Takes its turn on availabilityRun, so it never races truncateItem.
    private dropStaleEditBaselines(): void {
        for (const baseline of this.stateDb.listEditBaselines()) {
            if (!this.localItemExists(baseline.relPath)) {
                this.stateDb.dropEditBaselines(baseline.relPath);
            }
        }
    }

    // A folder's listing for the virtual drive: what the remote index holds in it, as this computer sees it, online-only
    // and downloaded items alike (the helper merges it with the backing store), sorted by name. Left out are hidden items
    // (and those being hidden), ignored names, and entries that a pending rename, move or delete takes away from there
    // (see liveIndexEntry); Proton Docs and Sheets aren't indexed. A folder made here that Proton Drive doesn't have yet
    // is listed as the folder it is. A folder the index doesn't hold lists nothing.
    vfsChildren(relPath: string): VfsEntry[] {
        this.refuseWhileHeld();
        const rel = normalizeDrivePath(relPath);
        const ignorePatterns = this.stateDb.getSettings().ignorePatterns;
        const folder = this.liveIndexEntry(rel);
        if (
            !folder ||
            folder.type !== 'folder' ||
            matchesIgnorePatterns(rel, ignorePatterns) ||
            this.policy.hiddenBy(rel) !== null
        ) {
            return [];
        }
        // The folder is where its entry is, so only a child's own pending operation can take the child away
        const latest = new Map(this.latestOpPerNode().map((op) => [op.nodeUid, op]));
        const localNames = new Set(this.localChildNames(rel) ?? []);
        const conflictPaths = new Set(this.stateDb.listConflicts().map((conflict) => conflict.localRelPath));
        const entries: VfsEntry[] = [];
        for (const child of this.index.listChildren(rel)) {
            if (
                takesAway(latest.get(child.uid), child) ||
                matchesIgnorePatterns(child.relPath, ignorePatterns) ||
                this.policy.hiddenBy(child.relPath) !== null
            ) {
                continue;
            }
            // Where a local file and another cloud file collide, the local one is what the drive shows (#29)
            const local = localNames.has(child.name) ? this.unresolvedCollision(child.relPath, child, conflictPaths) : null;
            entries.push(
                local
                    ? { name: child.name, type: 'file', size: local.size, mtimeMs: local.mtimeMs }
                    : { name: child.name, type: child.type, size: child.size, mtimeMs: child.mtimeMs },
            );
        }
        return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    // What the file manager shows on a folder and each of its children, in a fixed number of queries (see
    // AvailabilityPolicy.childStates): the availability, and a transfer under way, an error or a conflict at the item or
    // anywhere below it, as recorded. A child that is a local item matching an ignore pattern gets null (no emblem); one not in Proton
    // Drive yet is waiting to upload (syncing). Hidden items are left out, as the drive leaves them out. Null when the
    // path isn't a folder of the drive, or while the files are moving.
    itemStates(relPath: string): FolderStates | null {
        let rel: string;
        try {
            rel = normalizeDrivePath(relPath);
        } catch {
            return null;
        }
        if (this.holding()) {
            return null;
        }
        const ignorePatterns = this.stateDb.getSettings().ignorePatterns;
        if (rel !== '' && (matchesIgnorePatterns(rel, ignorePatterns) || this.policy.hiddenBy(rel) !== null)) {
            return null;
        }
        const localNames = this.localChildNames(rel);
        const folder = this.liveIndexEntry(rel);
        if (!folder || folder.type !== 'folder') {
            // A folder made here and not uploaded yet: everything in it waits to upload
            if (localNames === null || folder) {
                return null;
            }
            const children: Record<string, ItemState | null> = {};
            for (const name of localNames) {
                children[name] = this.localOnlyState(childRel(rel, name), ignorePatterns);
            }
            return { self: { availability: 'downloaded', transfer: 'syncing' }, children };
        }

        const availability = this.policy.childStates(rel);
        const transfers = this.transfersBelow(rel);
        const latest = new Map(this.latestOpPerNode().map((op) => [op.nodeUid, op]));
        const children: Record<string, ItemState | null> = {};
        for (const child of this.index.listChildren(rel)) {
            const state = availability.get(child.name);
            if (
                takesAway(latest.get(child.uid), child) ||
                matchesIgnorePatterns(child.relPath, ignorePatterns) ||
                state === undefined ||
                state === 'hidden' ||
                state === 'hiding'
            ) {
                continue;
            }
            children[child.name] = { availability: state, transfer: transfers.get(child.name) ?? null };
        }
        for (const name of localNames ?? []) {
            if (!(name in children) && !availability.has(name)) {
                // Shown as syncing on itself only: what waits to upload is known by looking at the disk, which a folder's
                // emblem can't do for everything below it, so folders sum up what the records say, the same from any view
                children[name] = this.localOnlyState(childRel(rel, name), ignorePatterns);
            }
        }
        let below: Transfer = null;
        for (const transfer of transfers.values()) {
            below = worseTransfer(below, transfer);
        }
        const selfState = this.policy.stateOf(rel);
        const self =
            rel === '' || selfState === 'hidden' || selfState === 'hiding' ? null : { availability: selfState, transfer: below };
        return { self, children };
    }

    // The names in a folder of the local root (engine temp files left out), or null when it isn't a folder here
    private localChildNames(rel: string): string[] | null {
        try {
            return readdirSync(path.join(this.localRoot(), rel)).filter((name) => !isEngineTempName(name));
        } catch {
            return null;
        }
    }

    private localOnlyState(rel: string, ignorePatterns: string[]): ItemState | null {
        return matchesIgnorePatterns(rel, ignorePatterns) ? null : { availability: 'downloaded', transfer: 'syncing' };
    }

    // The worst transfer at or below each child of a folder, by the child's name: uploads and downloads under way and
    // opens of online-only files (syncing), errors, and unresolved conflicts
    private transfersBelow(folderRel: string): Map<string, Transfer> {
        const prefix = folderRel === '' ? '' : `${folderRel}/`;
        const below = (column: string) => (folderRel === '' ? `${column} != ''` : `(${column} >= $lo AND ${column} < $hi)`);
        const params = { $prefix: prefix, ...(folderRel === '' ? {} : { $lo: prefix, $hi: `${folderRel}0` }) };
        const firstSegment = (column: string) =>
            `CASE WHEN instr(substr(${column}, length($prefix) + 1), '/') > 0
                  THEN substr(substr(${column}, length($prefix) + 1), 1, instr(substr(${column}, length($prefix) + 1), '/') - 1)
                  ELSE substr(${column}, length($prefix) + 1) END`;
        const rows = this.stateDb.connection
            .query(
                `SELECT ${firstSegment('localRelPath')} AS name,
                        CASE WHEN syncStatus = 'error' THEN 'error' ELSE 'syncing' END AS transfer
                   FROM synced_items
                  WHERE syncStatus IN ('uploading', 'downloading', 'error') AND ${below('localRelPath')}
                 UNION ALL
                 SELECT ${firstSegment('localRelPath')} AS name, 'conflict' AS transfer
                   FROM conflicts WHERE resolved = 0 AND ${below('localRelPath')}`,
            )
            .all(params) as { name: string; transfer: Exclude<Transfer, null> }[];
        const out = new Map<string, Transfer>();
        for (const row of rows) {
            out.set(row.name, worseTransfer(out.get(row.name) ?? null, row.transfer));
        }
        for (const opening of this.hydrations.keys()) {
            if (opening.startsWith(prefix) && opening !== folderRel) {
                const name = opening.slice(prefix.length).split('/')[0];
                out.set(name, worseTransfer(out.get(name) ?? null, 'syncing'));
            }
        }
        return out;
    }

    // Downloads an online-only file into the backing store, for the virtual drive to open it (an app opened it). Calls for
    // the same path while one runs get that one; a file already here resolves at once. Nothing waits for the download,
    // and whatever happens to the item meanwhile wins (see hydrateFile). The user is told when the download takes over
    // 2 s, and when it fails; once the file is here, GNOME's failed-thumbnail record of it goes, so its thumbnail shows.
    // A rename, delete or cloud move of it meanwhile makes it reject with ENOENT. Rejects with a DriveOpError:
    // `Hidden: <path>` (EACCES) for an item hidden or being hidden, `Not in Proton Drive: <path>` (ENOENT), `Not a file:
    // <path>` (EIO), or the download's error (EIO); with `Invalid path: <path>` for a path that climbs out of My files.
    hydrate(relPath: string, opts: { opener?: string } = {}): Promise<void> {
        let rel: string;
        try {
            // An app the user blocked is refused first, quietly: it may be walking a whole folder
            if (opts.opener !== undefined && this.stateDb.getSettings().blockedApps.includes(opts.opener)) {
                throw new DriveOpError('EACCES', `Blocked: ${opts.opener}`);
            }
            this.refuseWhileHeld();
            this.refuseWhileFilesGone();
            rel = normalizeDrivePath(relPath);
        } catch (error: unknown) {
            return Promise.reject(error);
        }
        const running = this.hydrations.get(rel);
        if (running) {
            return running;
        }
        const run = this.hydrateNow(rel, opts.opener).finally(() => {
            this.hydrations.delete(rel);
            this.stateEvents.touch(rel);
        });
        this.hydrations.set(rel, run);
        this.stateEvents.touch(rel); // shown as syncing while it opens
        return run;
    }

    // One app downloaded many files in the last minute: the user is told, and can block it from the notification. Without
    // buttons (an old notify-send), the notification says where to block it instead.
    private noticeMassDownload(app: string, count: number): void {
        const enabled = this.stateDb.getSettings().notificationsEnabled;
        if (!enabled) {
            return;
        }
        const title = `${app} is downloading many files from Proton Drive`;
        const body = `It has downloaded ${count} files in the last minute.`;
        this.logger.info(`${title} (${count} in the last minute)`);
        const ask = this.options.askWithActions ?? sendActionNotification;
        void ask({ title, body, actions: [{ key: 'block', label: 'Block this app' }], enabled })
            .then((choice) => {
                if (choice === 'block') {
                    this.blockApp(app);
                } else if (choice === 'unsupported') {
                    sendDesktopNotification({ title, body: `${body} You can block it in Proton Drive's Settings.`, enabled });
                }
            })
            .catch(() => {});
    }

    // Adds an app to the blocklist (the user chose Block this app), unless it is there already or the list is full
    private blockApp(app: string): void {
        const current = this.stateDb.getSettings().blockedApps;
        const next = current.includes(app) ? current : [...current, app];
        if (problemWithBlockedApps(next) !== null) {
            this.logger.warn(`Can't block ${app}: ${problemWithBlockedApps(next)}`);
            return;
        }
        if (next !== current) {
            this.stateDb.updateSettings({ blockedApps: next });
            this.logger.info(`Blocked ${app} from downloading files from Proton Drive`);
        }
        sendDesktopNotification({
            title: `${app} is blocked`,
            body: "It can't download files from Proton Drive any more. Unblock it in Settings.",
            enabled: this.stateDb.getSettings().notificationsEnabled,
        });
    }

    private async hydrateNow(rel: string, opener: string | undefined): Promise<void> {
        const name = path.posix.basename(rel);
        // Counted from when the download itself starts: a refusal, or a slow look-up before it, says nothing
        let slowNotice: ReturnType<typeof setTimeout> | undefined;
        const downloadStarted = () => {
            if (slowNotice === undefined) {
                const count = this.downloadWatch.record(opener);
                if (count !== null && opener !== undefined) {
                    this.noticeMassDownload(opener, count);
                }
            }
            slowNotice ??= setTimeout(() => {
                sendDesktopNotification({
                    title: `Downloading ${name}…`,
                    body: 'It opens once it is on this computer.',
                    urgency: 'low',
                    enabled: this.stateDb.getSettings().notificationsEnabled,
                });
            }, this.slowDownloadNoticeMs);
        };
        try {
            if (await this.observingLocal((since) => this.hydrateFile(rel, since, downloadStarted))) {
                await this.forgetFailedThumbnailOf(rel);
            }
        } catch (error: unknown) {
            const failure = error instanceof DriveOpError ? error : new DriveOpError('EIO', messageOf(error), { cause: error });
            // A download that failed (not a refusal: hidden, not there, or not a file)
            if (failure.code === 'EIO' && !failure.message.startsWith('Not a file:')) {
                this.logger.warn(`Could not download ${rel} for an app to open it: ${failure.message}`);
                const cause = failure.cause ?? error;
                sendDesktopNotification({
                    title: `Couldn't open ${name}`,
                    body:
                        cause instanceof ConnectionError || cause instanceof AbortError
                            ? `${name} can't be downloaded while Proton Drive is unreachable. Try again once you are back online.`
                            : `${name} could not be downloaded: ${failure.message}`,
                    urgency: 'normal',
                    enabled: this.stateDb.getSettings().notificationsEnabled,
                });
            }
            throw failure;
        } finally {
            clearTimeout(slowNotice);
        }
    }

    // The download runs outside availabilityRun, into a staging file at the root of the backing store (where a rename of
    // a folder above the item can't take it), so nothing waits for it: renames, deletes, availability changes, other
    // opens and local change handling all go on meanwhile. Only placing it takes a turn there, for a moment, and whatever
    // happened meanwhile wins: a rename, delete or hide, a cloud move followed here, or a file written at the path (never
    // replaced). The staging file goes whatever happens. Returns whether it placed the file (false when a local copy is
    // there instead, which is what opens).
    private async hydrateFile(rel: string, since: number, downloadStarted: () => void): Promise<boolean> {
        if (await this.existsLocally(rel)) {
            return false;
        }
        const entry = this.hydratableEntry(rel);
        if (!this.auth.isLoggedIn()) {
            throw new DriveOpError('EIO', 'Sign in to Proton Drive to download it');
        }
        let node: NodeEntity;
        try {
            node = await this.sdk.getNode(entry.uid);
        } catch (error: unknown) {
            if (error instanceof ValidationError) {
                throw new DriveOpError('ENOENT', `Not in Proton Drive: ${rel}`, { cause: error });
            }
            throw new DriveOpError('EIO', messageOf(error), { cause: error });
        }
        if (node.trashTime) {
            throw new DriveOpError('ENOENT', `Not in Proton Drive: ${rel}`);
        }
        if (node.type !== NodeType.File || isUnsupportedRemoteNode(node)) {
            throw new DriveOpError('EIO', `Not a file: ${rel}`);
        }
        const staging = path.join(this.localRoot(), `${HYDRATE_STAGING_PREFIX}${randomUUID()}`);
        const transferId = `dl:${rel}`;
        this.hydrateStaging.add(staging);
        this.activeTransfers.set(transferId, {
            id: transferId,
            direction: 'download',
            relPath: rel,
            bytesTransferred: 0,
            totalBytes: node.activeRevision?.claimedSize ?? 0,
            startedAt: Date.now(),
        });
        try {
            let downloaded: { sha1: string; size: number; mtimeMs: number };
            try {
                downloaded = await downloadRevisionToFile({
                    sdk: this.sdk,
                    logger: this.logger,
                    remoteNode: node,
                    filePath: staging,
                    onStart: downloadStarted,
                    onProgress: (bytes, total) => {
                        const transfer = this.activeTransfers.get(transferId);
                        if (transfer) {
                            transfer.bytesTransferred = bytes;
                            transfer.totalBytes = total;
                        }
                    },
                });
            } catch (error: unknown) {
                this.stateDb.logActivity({ action: 'error', localRelPath: rel, details: `Download failed: ${messageOf(error)}` });
                throw new DriveOpError('EIO', messageOf(error), { cause: error });
            }
            return await this.inAvailabilityRun(() => this.placeHydrated(rel, node, staging, downloaded, since));
        } finally {
            this.activeTransfers.delete(transferId);
            await unlink(staging).catch(() => {});
            this.hydrateStaging.delete(staging);
        }
    }

    // The index entry of a file hydrate can download: `Hidden: <path>` (EACCES) for an item hidden or being hidden; `Not
    // in Proton Drive: <path>` (ENOENT) for an ignored name, or one with no entry here, or an entry that a pending
    // operation takes elsewhere (a second copy of that node would come down); `Not a file: <path>` (EIO) for a folder,
    // provisional ones included, whose uid is never asked about.
    private hydratableEntry(rel: string): RemoteIndexEntry {
        if (this.policy.hiddenBy(rel) !== null) {
            throw new DriveOpError('EACCES', `Hidden: ${rel}`);
        }
        const entry = matchesIgnorePatterns(rel, this.stateDb.getSettings().ignorePatterns) ? null : this.liveIndexEntry(rel);
        if (!entry) {
            throw new DriveOpError('ENOENT', `Not in Proton Drive: ${rel}`);
        }
        if (isProvisional(entry.uid) || entry.type !== 'file') {
            throw new DriveOpError('EIO', `Not a file: ${rel}`);
        }
        return entry;
    }

    // Puts a downloaded file in place, in its turn on availabilityRun, if the path still leads to its node (see
    // hydrateFile), making the folders above it that aren't on this computer. From the last look to the record nothing
    // can run in between, and something put at the path meanwhile is never replaced.
    private async placeHydrated(
        rel: string,
        node: NodeEntity,
        staging: string,
        downloaded: { sha1: string; mtimeMs: number },
        since: number,
    ): Promise<boolean> {
        this.recoverLocalMove();
        const stillThere = () => {
            if (this.hydratableEntry(rel).uid !== node.uid) {
                throw new DriveOpError('ENOENT', `Not in Proton Drive: ${rel}`);
            }
        };
        if (this.localItemExists(rel)) {
            return false;
        }
        stillThere();
        const root = this.localRoot();
        const target = path.join(root, rel);
        const madeFrom = await this.firstMissingAncestor(rel);
        for (let slash = rel.indexOf('/'); slash !== -1; slash = rel.indexOf('/', slash + 1)) {
            this.watcher.suppressPath(rel.slice(0, slash));
        }
        this.watcher.suppressPath(rel);
        let placed = false;
        let size = 0;
        try {
            if (madeFrom !== null) {
                await mkdir(path.dirname(target), { recursive: true });
            }
            const readFrom = Date.now(); // before it is placed (see placedReadAt)
            if (!this.localItemExists(rel)) {
                stillThere();
                placed = moveWithoutReplacing(staging, target);
            }
            if (placed) {
                const mtime = new Date(downloaded.mtimeMs);
                try {
                    utimesSync(target, mtime, mtime);
                } catch {
                    // Keeps the time it was written at
                }
                const st = statSync(target);
                size = st.size;
                this.recordSynced(
                    {
                        localRelPath: rel,
                        nodeUid: node.uid,
                        parentNodeUid: node.parentUid ?? null,
                        type: 'file',
                        localSha1: downloaded.sha1,
                        remoteSha1: node.activeRevision?.claimedDigests?.sha1 ?? null, // as the cloud claims it
                        localMtimeMs: st.mtimeMs,
                        remoteMtimeMs: (node.activeRevision?.claimedModificationTime ?? node.modificationTime).getTime(),
                        size: st.size,
                        syncStatus: 'synced',
                        lastError: null,
                        contentReadAt: placedReadAt(st.ctimeMs, readFrom),
                    },
                    since,
                );
            }
        } catch (error: unknown) {
            if (!placed && madeFrom !== null) {
                await this.removeEmptyFolders(parentOf(rel), madeFrom);
            }
            throw error instanceof DriveOpError ? error : new DriveOpError('EIO', messageOf(error), { cause: error });
        }
        if (!placed) {
            if (madeFrom !== null) {
                await this.removeEmptyFolders(parentOf(rel), madeFrom);
            }
            // Something was put there meanwhile, and it is what opens; or the move left the file where it was
            if (this.localItemExists(rel)) {
                return false;
            }
            throw new DriveOpError('EIO', `${rel} could not be put in place`);
        }
        this.stateDb.logActivity({
            action: 'download',
            localRelPath: rel,
            details: `Downloaded from Proton Drive (${formatBytes(size)})`,
            bytesTransferred: size,
        });
        return true;
    }

    // Staging files of hydrates that a crash or a kill interrupted (see hydrateFile), at the root of the backing store
    private async sweepHydrateStaging(): Promise<void> {
        const root = this.localRoot();
        for (const name of await readdir(root).catch(() => [] as string[])) {
            const fullPath = path.join(root, name);
            if (name.startsWith(HYDRATE_STAGING_PREFIX) && !this.hydrateStaging.has(fullPath)) {
                await unlink(fullPath).catch(() => {});
            }
        }
    }

    // The topmost folder above relPath missing on this computer, or null when they are all here
    private async firstMissingAncestor(relPath: string): Promise<string | null> {
        for (let slash = relPath.indexOf('/'); slash !== -1; slash = relPath.indexOf('/', slash + 1)) {
            const folder = relPath.slice(0, slash);
            if (!(await this.existsLocally(folder))) {
                return folder;
            }
        }
        return null;
    }

    // Removes the folders from `from` up to `upTo` (both included) while they are empty
    private async removeEmptyFolders(from: string, upTo: string): Promise<void> {
        for (let folder = from; isWithin(folder, upTo); folder = parentOf(folder)) {
            try {
                await rmdir(path.join(this.localRoot(), folder));
            } catch {
                return; // Not empty (something was put there meanwhile), or gone already
            }
            if (folder === upTo) {
                return;
            }
        }
    }

    private async forgetFailedThumbnailOf(rel: string): Promise<void> {
        const mountFullPath = path.join(this.stateDb.getSettings().syncDir, rel);
        try {
            await (this.options.forgetFailedThumbnail ?? forgetFailedThumbnail)(mountFullPath);
        } catch (error: unknown) {
            this.logger.warn(`Could not clear the failed thumbnail of ${mountFullPath}: ${error}`);
        }
    }

    // Sends the journalled renames, moves and deletes to Proton Drive, in the order they were made (spec §5.2). A network
    // or server error leaves the operation pending and stops until the next time; nothing runs while paused. It never runs
    // alongside a sync pass, whose listings it would make out of date: asked during one, it runs once the pass is over.
    async replayRemoteOps(): Promise<void> {
        if (this.reconcileRunning) {
            this.replayAfterPass = true;
            return;
        }
        await this.runReplay();
    }

    private runReplay(): Promise<void> {
        if (this.holding()) {
            return Promise.resolve(); // Sent after the move, by the pass at start()
        }
        if (this.accountMismatch) {
            return Promise.resolve(); // Its changes are for the other account's nodes: never sent to this one (#35)
        }
        if (this.replayRun) {
            this.replayAgain = true; // What was journalled meanwhile goes too
            return this.replayRun;
        }
        const run = (async () => {
            try {
                if (!(await this.verifyAccount())) {
                    return; // Never sent before the account is checked to be the records' (#35): the next pass sends it
                }
                do {
                    this.replayAgain = false;
                    await this.replayPending();
                } while (this.replayAgain);
            } catch (error: unknown) {
                this.logger.warn(`Could not send changes made through the drive to Proton Drive; trying again later: ${error}`);
            } finally {
                this.replayRun = null;
            }
        })();
        this.replayRun = run;
        return run;
    }

    private async replayPending(): Promise<void> {
        this.recoverLocalMove();
        let previousId = -1;
        let runsLeft = 0;
        for (;;) {
            if (this.stateDb.getSettings().paused || !this.auth.isLoggedIn()) {
                return;
            }
            const op = this.journal.pending()[0];
            if (!op) {
                return;
            }
            // Every step settles its operation, stops, or asks to run it again (a few times at most): one coming back
            // otherwise would be a bug, never a reason to loop
            if (op.id === previousId) {
                if (runsLeft === 0) {
                    return;
                }
                runsLeft -= 1;
            } else {
                runsLeft = 3;
            }
            previousId = op.id;
            const { retryAfter } = this.journal.failures(op.id);
            if (retryAfter !== null && Date.now() < retryAfter) {
                return; // Backing off (see replayFailed): everything after it waits, keeping the order
            }
            const next = op.kind === 'trash' ? await this.replayTrash(op) : await this.replayMove(op);
            if (next === 'stop') {
                return;
            }
            if (next !== 'again') {
                runsLeft = 0;
            }
        }
    }

    private async renameLocally(fromRel: string, toRel: string, noReplace: boolean): Promise<void> {
        this.recoverLocalMove();
        for (const p of [fromRel, toRel]) {
            if (this.policy.hiddenBy(p)?.hide === 'hidden') {
                throw new DriveOpError('EACCES', `Hidden: ${p}`);
            }
        }
        const root = this.localRoot();
        const ignorePatterns = this.stateDb.getSettings().ignorePatterns;
        const ignoredFrom = matchesIgnorePatterns(fromRel, ignorePatterns);
        const ignoredTo = matchesIgnorePatterns(toRel, ignorePatterns);
        const source = lstatSync(path.join(root, fromRel), { throwIfNoEntry: false });
        // An ignored item is never in Proton Drive, whatever the cloud holds at its path; and an entry that a pending
        // operation takes elsewhere isn't what is at its path here
        const sourceEntry = ignoredFrom ? null : this.liveIndexEntry(fromRel);
        if (!source && !sourceEntry) {
            throw new DriveOpError('ENOENT', `Not found: ${fromRel}`);
        }
        // A file being edited through the drive with no record yet is an edit of its baseline's node: the index may hold
        // another node at its path since (another device's), which isn't the one this file stands for
        // A local file in an unresolved collision stands for no node: the cloud file at its path is another device's,
        // which stays where it is (#29)
        const sourceCollides = !ignoredFrom && source?.isFile() === true && (await this.collidingLocalFile(fromRel, sourceEntry)) !== null;
        const sourceUid =
            ignoredFrom || sourceCollides
                ? null
                : (this.stateDb.getItemByPath(fromRel)?.nodeUid ?? this.stateDb.getEditBaseline(fromRel)?.nodeUid ?? nodeUidOf(sourceEntry));
        const target = lstatSync(path.join(root, toRel), { throwIfNoEntry: false });
        const targetRecord = this.stateDb.getItemByPath(toRel);
        const targetEntry = ignoredTo ? null : this.liveIndexEntry(toRel);
        const parentRel = parentOf(toRel);
        const parent = parentRel === '' ? null : lstatSync(path.join(root, parentRel), { throwIfNoEntry: false });
        if (parentRel !== '' && (parent ? !parent.isDirectory() : this.liveIndexEntry(parentRel)?.type !== 'folder')) {
            throw new DriveOpError('ENOENT', `Not found: ${parentRel}`);
        }
        const replacing = Boolean(target || targetRecord || targetEntry);
        if (replacing && noReplace) {
            throw new DriveOpError('EEXIST', `Already exists: ${toRel}`);
        }
        // Nor does a target in an unresolved collision: what replaces it stays unrecorded, for the conflict handling to
        // decide, rather than turning into a new revision of the other device's file (#29). Only something with no node
        // of its own replaces it, as an editor's save does: one with a node would be moved onto that file's name.
        const targetCollides = replacing && !ignoredTo && target?.isFile() === true && (await this.collidingLocalFile(toRel, targetEntry)) !== null;
        if (targetCollides && sourceUid !== null) {
            throw new DriveOpError('EEXIST', `Already exists: ${toRel}`);
        }
        const targetUid = !replacing || ignoredTo || targetCollides ? null : (targetRecord?.nodeUid ?? nodeUidOf(targetEntry));
        if (replacing) {
            // Only a file on this computer replaces, and only a file
            const targetIsFile = target ? target.isFile() : (targetRecord?.type ?? targetEntry?.type) === 'file';
            if (!source && sourceEntry?.type === 'file' && targetIsFile) {
                // Online-only, it has no local copy to put in the target's place: mv copies it instead (downloading it)
                throw new DriveOpError('EXDEV', `Can't replace ${toRel} with ${fromRel}, which isn't on this computer`);
            }
            if (!source?.isFile() || !targetIsFile) {
                throw new DriveOpError('EEXIST', `Already exists: ${toRel}`);
            }
        }
        if (source && parentRel !== '' && !parent) {
            // Into a folder only Proton Drive has (online-only): made here to hold the local copy; the next sync records it
            for (let slash = toRel.indexOf('/'); slash !== -1; slash = toRel.indexOf('/', slash + 1)) {
                this.watcher.suppressPath(toRel.slice(0, slash));
            }
            await mkdir(path.join(root, parentRel), { recursive: true });
        }
        // The user's replace of a file with an identity in Proton Drive keeps that identity: the replacing file's own node
        // goes to the trash. Otherwise the item itself moves to toRel.
        const keepsTarget = replacing && targetUid !== null;
        // A folder with no node of its own (made here) can still hold items Proton Drive has: they move with it there
        const pendingUids = new Set(this.journal.pending().map((op) => op.nodeUid));
        const carried =
            sourceUid === null && !keepsTarget && !ignoredFrom && !ignoredTo && source?.isDirectory()
                ? this.topmostRecordedUnder(fromRel).filter((item) => item.localRelPath !== fromRel && !pendingUids.has(item.nodeUid))
                : [];
        this.watcher.suppressPath(fromRel);
        if (!keepsTarget && !sourceCollides && (sourceUid !== null || this.stateDb.hasItemsUnder(fromRel))) {
            this.watcher.suppressPath(toRel); // Its records go with it: reported as something new, it would upload again
        }
        // Not toRel when the target is kept: its new content is reported, and uploads as a new revision
        const kept = this.keptForPendingOps();
        await this.whileRemoving(
            async (records) => {
                const snapshot = this.snapshotLocalStep([fromRel, toRel], sourceUid === null ? [] : [sourceUid]);
                // Records, journal and index first, in one transaction with a note of the move, then the item itself, with
                // nothing able to run in between; a crash between the two is finished on the next start (recoverLocalMove)
                this.stateDb.connection.transaction(() => {
                    if (keepsTarget) {
                        // The replaced file keeps its identity, marked as changed here, so the next look uploads its new
                        // content as a new revision of it. A target being edited through the drive with no record yet
                        // keeps its edit baseline instead: what the drive showed decides, not the index, which may
                        // have moved on to another device's change since, or to another node altogether (which the
                        // baseline then doesn't match: the conflict handling)
                        const edit = targetRecord ? null : this.stateDb.getEditBaseline(toRel);
                        this.stateDb.removeItemByPath(fromRel);
                        if (!edit) {
                            const base =
                                targetRecord?.nodeUid === targetUid ? targetRecord : recordFromIndexEntry(targetEntry!, toRel);
                            this.stateDb.upsertItem({
                                ...base,
                                localSha1: null,
                                localMtimeMs: 0,
                                syncStatus: 'synced',
                                lastError: null,
                                updatedAt: undefined,
                                contentReadAt: null, // what is here now was never read (#109)
                            });
                        }
                        if (sourceUid !== null && sourceUid !== targetUid) {
                            this.journal.enqueue({ kind: 'trash', nodeUid: sourceUid, path: fromRel });
                        }
                    } else {
                        this.stateDb.removeItemByPath(toRel); // Only something that exists only here (or nothing) is there
                        if (sourceCollides) {
                            // Its record (one of a conflict) stands for the cloud file, which stays: the local file goes
                            // on as a new one, and the conflict is over, both kept
                            this.stateDb.removeItemByPath(fromRel);
                            for (const conflict of this.unresolvedConflictsAt(fromRel)) {
                                this.stateDb.markConflictResolved(conflict.id, 'keep-both');
                            }
                        } else if (ignoredTo || !source) {
                            // Into an ignored name nothing follows it; and records with no local copy would read as deletes
                            this.stateDb.removeItemByPath(fromRel);
                        } else {
                            this.stateDb.renameItemPath(fromRel, toRel, this.cloudParentOf(toRel));
                        }
                        this.journal.retarget(fromRel, toRel);
                        if (!ignoredTo) {
                            if (sourceUid !== null) {
                                this.journal.enqueue({
                                    kind: parentOf(fromRel) === parentRel ? 'rename' : 'move',
                                    nodeUid: sourceUid,
                                    toPath: toRel,
                                    fromPath: fromRel,
                                });
                            }
                            for (const item of carried) {
                                this.journal.enqueue({
                                    kind: 'move',
                                    nodeUid: item.nodeUid,
                                    toPath: toRel + item.localRelPath.slice(fromRel.length),
                                    fromPath: item.localRelPath,
                                });
                            }
                        }
                    }
                    if (source) {
                        this.stateDb.setMeta(LOCAL_MOVE_IN_PROGRESS, this.moveIntent(fromRel, toRel, replacing));
                    }
                })();
                if (source) {
                    this.moveLocalOrUndo(fromRel, toRel, replacing, snapshot, () => records.dropSubtree(fromRel));
                }
                // Work still under way anywhere in the old subtree (an upload, say) must not record its old path once
                // done; a node it makes follows the item (see adoptStrayNode). Noted as soon as the item has moved, so that
                // the rename is seen by such work even if a step after this fails (#145)
                records.dropSubtree(fromRel);
                // An edit baseline follows its file, unless the file now stands for the target (its record) or leaves
                // what is synced
                // A colliding file goes on as a new one: what it was an edit of stays where it is (#65). A colliding target
                // keeps its own baseline, if any: what replaces it is judged by it, as an edit of what the drive showed
                if (keepsTarget || ignoredTo || sourceCollides || targetCollides) {
                    this.stateDb.dropEditBaselines(fromRel);
                } else {
                    this.stateDb.moveEditBaselines(fromRel, toRel);
                }
            },
            { from: fromRel, to: keepsTarget ? null : toRel },
        );
        // Once the item is where it goes, so a folder made here is found holding it
        this.applyPendingOpsToIndex(kept);
        this.stateDb.logActivity({
            action: 'sync',
            localRelPath: toRel,
            details: keepsTarget ? `Replaced on this computer by ${fromRel}` : `Renamed on this computer: ${fromRel} → ${toRel}`,
        });
    }

    private async deleteLocally(relPath: string, onlyIfEmpty: boolean, trash: boolean): Promise<void> {
        this.recoverLocalMove();
        if (this.policy.hiddenBy(relPath)?.hide === 'hidden') {
            throw new DriveOpError('EACCES', `Hidden: ${relPath}`);
        }
        const root = this.localRoot();
        const ignored = matchesIgnorePatterns(relPath, this.stateDb.getSettings().ignorePatterns);
        const local = lstatSync(path.join(root, relPath), { throwIfNoEntry: false });
        const entry = ignored ? null : this.liveIndexEntry(relPath);
        if (!local && !entry) {
            throw new DriveOpError('ENOENT', `Not found: ${relPath}`);
        }
        if (onlyIfEmpty) {
            if (local ? !local.isDirectory() : entry?.type !== 'folder') {
                throw new DriveOpError('EIO', `Not a folder: ${relPath}`);
            }
            if (await this.holdsAnything(relPath, Boolean(local), entry)) {
                throw new DriveOpError('ENOTEMPTY', `Not empty: ${relPath}`);
            }
        }
        // A local file in an unresolved collision is what the drive shows there (#29): only it goes, and the other file
        // Proton Drive has at that name stays (with the folders it is in), listed again once the local one is gone.
        // Everything else in a folder being deleted goes to the Proton Drive trash, item by item.
        const collisions = ignored || onlyIfEmpty ? [] : await this.collisionsAt(relPath, entry, local);
        const collision = collisions.length > 0;
        const toTrash = ignored
            ? new Map<string, string>()
            : collision
              ? this.trashTargetsKeeping(relPath, collisions)
              : this.trashTargets(relPath, entry);
        this.watcher.suppressPath(relPath);
        // For a Move to Trash, what is only here is told apart from unchanged synced copies while the records still say
        // which those are
        const scan =
            trash && local
                ? await scanLocalCopies({
                      syncDir: root,
                      relPath,
                      ignorePatterns: this.stateDb.getSettings().ignorePatterns,
                      stopAtFirst: false,
                      isUnchangedSyncedCopy: (rel, fullPath, st) => this.isUnchangedSyncedCopy(rel, fullPath, st),
                  })
                : null;
        let kept = { moved: 0, stayed: 0 };
        await this.whileRemoving(
            async (records) => {
                // Records first, in one transaction with the index and the journalled trash: a crash before the files
                // are gone leaves them unrecorded, to upload again as new items (nothing lost), never recorded without
                // their files
                this.stateDb.connection.transaction(() => {
                    this.stateDb.removeItemByPath(relPath);
                    this.stateDb.dropEditBaselines(relPath);
                    if (collision) {
                        // Nothing is left of this computer's side: what stays is the cloud's version
                        this.endConflictsAsKeepRemote(collisions);
                        for (const uid of toTrash.keys()) {
                            this.index.removeSubtree(uid);
                        }
                    } else if (entry) {
                        this.index.removeSubtree(entry.uid);
                    }
                    for (const [uid, where] of toTrash) {
                        this.journal.enqueue({ kind: 'trash', nodeUid: uid, path: where });
                    }
                    this.applyPendingOpsToIndex();
                })();
                // Noted for work under way once it has happened: a transaction that threw rolled everything back, and no
                // delete is there to see (#154). Nothing runs between the commit and this, which writes nothing (the
                // records went in the transaction), so it can't fail after the delete committed
                records.noteSubtree(relPath);
                if (local && onlyIfEmpty) {
                    // Never what was put in it since the look above: that stays, and syncs as new, folder and all
                    await rmdir(path.join(root, relPath)).catch((error: NodeJS.ErrnoException) => {
                        throw error.code === 'ENOTEMPTY' || error.code === 'EEXIST'
                            ? new DriveOpError('ENOTEMPTY', `Not empty: ${relPath}`, { cause: error })
                            : error;
                    });
                } else if (scan) {
                    // Unchanged synced copies go (their records already have), the rest to the desktop Trash
                    const removal = await removeScannedEntries({
                        syncDir: root,
                        entries: scan.entries,
                        keep: new Set(scan.localOnly.map((item) => item.relPath)),
                        mode: 'keep-changed',
                        dropRecord: () => {},
                        shouldContinue: () => true,
                    });
                    kept = await this.clearKeptAfterCloudDelete(root, relPath, scan.entries, removal.kept);
                } else if (local) {
                    await rm(path.join(root, relPath), { recursive: true, force: true });
                }
            },
            { from: relPath, to: null },
        );
        const told: string[] = [];
        if (kept.moved > 0) {
            told.push(`${kept.moved} item(s) that existed only on this computer were moved to your Trash.`);
        }
        if (kept.stayed > 0) {
            const where = path.join(this.stateDb.getSettings().syncDir, relPath);
            told.push(`${kept.stayed} item(s) that existed only on this computer were kept at ${where} and will upload again.`);
        }
        const deleted =
            toTrash.size > 0
                ? 'Deleted on this computer; it goes to Proton Drive Trash'
                : collision
                  ? 'Deleted on this computer; the other file Proton Drive has at that name stays'
                  : 'Deleted on this computer';
        this.stateDb.logActivity({
            action: 'delete-local',
            localRelPath: relPath,
            details: told.length > 0 ? `${deleted}. ${told.join(' ')}` : deleted,
        });
        if (told.length > 0) {
            sendDesktopNotification({
                title: 'Proton Drive: items only on this computer were kept',
                body: `${relPath} was moved to the Trash. ${told.join(' ')}`,
                urgency: 'normal',
                enabled: this.stateDb.getSettings().notificationsEnabled,
            });
        }
    }

    // The local file at a path in an unresolved collision (#29), or null: a file made or changed here and another file,
    // or another version, in Proton Drive at that path, with neither chosen yet. That is a conflict waiting for the user
    // (prompt), a local file with no record and no edit baseline where the remote index has a file, which the conflict
    // handling has yet to see (see uploadNewFile), or a file edited through the drive whose node has changed since (#65).
    // The drive shows the local file there (vfsChildren), and a delete through it removes only that (deleteLocally): the
    // cloud file is the other device's, never seen here.
    // conflictPaths: the paths of the unresolved conflicts, when the caller has them already (a listing looks at many)
    private unresolvedCollision(relPath: string, entry: RemoteIndexEntry | null, conflictPaths?: Set<string>): Stats | null {
        if (!entry || entry.type !== 'file' || isProvisional(entry.uid)) {
            return null;
        }
        const local = lstatSync(path.join(this.localRoot(), relPath), { throwIfNoEntry: false });
        if (!local?.isFile()) {
            return null;
        }
        const record = this.stateDb.getItemByPath(relPath);
        if (record) {
            return this.inQueuedConflict(relPath, record, conflictPaths) ? local : null;
        }
        // A file edited through the drive is an edit of its baseline: a collision once the node it is an edit of has
        // changed in the cloud since, as far as the index knows (#65). Another node at its path since is left to the
        // baseline's own node (see trashTargets).
        const edit = this.stateDb.getEditBaseline(relPath);
        const colliding = !edit || (edit.nodeUid === entry.uid && cloudChangedSince(edit, entry));
        return colliding ? local : null;
    }

    // The local file a delete or rename through the drive finds in an unresolved collision, or null. With no record, a
    // local file with the very content of the cloud file (by its SHA1) is that file, not recorded yet: it goes, or moves,
    // as a synced file does. One whose content can't be compared stays a collision, so the cloud file is kept.
    private async collidingLocalFile(
        relPath: string,
        entry: RemoteIndexEntry | null,
        conflictPaths?: Set<string>,
    ): Promise<Stats | null> {
        const local = this.unresolvedCollision(relPath, entry, conflictPaths);
        if (!local || !entry?.sha1 || this.stateDb.getItemByPath(relPath)) {
            return local;
        }
        const localSha1 = await computeLocalFileSha1(path.join(this.localRoot(), relPath)).catch(() => null);
        return localSha1 === entry.sha1 ? null : local;
    }

    // The local files at or under relPath that are in an unresolved collision (see collidingLocalFile)
    private async collisionsAt(relPath: string, entry: RemoteIndexEntry | null, local: Stats | undefined): Promise<string[]> {
        if (!local) {
            return [];
        }
        if (!local.isDirectory()) {
            return (await this.collidingLocalFile(relPath, entry)) ? [relPath] : [];
        }
        const ignorePatterns = this.stateDb.getSettings().ignorePatterns;
        const conflictPaths = new Set(this.stateDb.listConflicts().map((conflict) => conflict.localRelPath));
        const found: string[] = [];
        const walk = async (dirRel: string) => {
            const children = await readdir(path.join(this.localRoot(), dirRel), { withFileTypes: true }).catch(() => []);
            for (const child of children) {
                const rel = `${dirRel}/${child.name}`;
                if (isEngineTempName(child.name) || matchesIgnorePatterns(rel, ignorePatterns)) {
                    continue;
                }
                if (child.isDirectory()) {
                    await walk(rel);
                } else if (child.isFile() && (await this.collidingLocalFile(rel, this.liveIndexEntry(rel), conflictPaths))) {
                    found.push(rel);
                }
            }
        };
        await walk(relPath);
        return found;
    }

    // What goes to the Proton Drive trash for a delete of relPath that keeps the cloud files of the collisions in it, and
    // the folders they are in: everything else in those folders, item by item (as trashTargets otherwise), and whatever
    // a pending move puts in it
    private trashTargetsKeeping(relPath: string, collisions: string[]): Map<string, string> {
        const targets = new Map<string, string>();
        const latest = new Map(this.latestOpPerNode().map((op) => [op.nodeUid, op]));
        const holdsCollision = (folderRel: string) => collisions.some((rel) => rel.startsWith(`${folderRel}/`));
        const visit = (folderRel: string) => {
            for (const child of this.index.listChildren(folderRel)) {
                if (takesAway(latest.get(child.uid), child) || collisions.includes(child.relPath)) {
                    continue;
                }
                if (child.type === 'folder' && holdsCollision(child.relPath)) {
                    visit(child.relPath);
                    continue;
                }
                const uid = nodeUidOf(child);
                if (uid !== null) {
                    targets.set(uid, child.relPath);
                }
            }
        };
        visit(relPath);
        for (const op of latest.values()) {
            if (op.kind !== 'trash' && op.toPath.startsWith(`${relPath}/`) && !targets.has(op.nodeUid)) {
                targets.set(op.nodeUid, op.toPath);
            }
        }
        return targets;
    }

    // Whether a recorded item is in a conflict waiting for the user (prompt)
    private inQueuedConflict(relPath: string, record: SyncedItemRecord, conflictPaths?: Set<string>): boolean {
        return (
            record.syncStatus === 'conflict' ||
            (conflictPaths ? conflictPaths.has(relPath) : this.unresolvedConflictsAt(relPath).length > 0)
        );
    }

    // This computer's side of the conflicts waiting at these paths is gone: what stays is the cloud's version
    private endConflictsAsKeepRemote(paths: string[]): void {
        if (paths.length === 0) {
            return;
        }
        const ending = new Set(paths);
        for (const conflict of this.stateDb.listConflicts()) {
            if (ending.has(conflict.localRelPath)) {
                this.stateDb.markConflictResolved(conflict.id, 'keep-remote');
            }
        }
    }

    // The uid of the cloud folder a path is in, as the remote index has it now, or undefined while that isn't known (a
    // folder not in Proton Drive yet has only a provisional uid): what a moved item's record names as its parent (#80)
    private cloudParentOf(relPath: string): string | undefined {
        const parent = this.index.getByPath(parentOf(relPath));
        return parent && parent.type === 'folder' && !isProvisional(parent.uid) ? parent.uid : undefined;
    }

    private unresolvedConflictsAt(relPath: string): ConflictRecord[] {
        return this.stateDb.listConflicts().filter((conflict) => conflict.localRelPath === relPath);
    }

    // Whether a folder holds anything: on this computer, in Proton Drive as this computer sees it (hidden and ignored items
    // included, not what a pending operation takes elsewhere), or what a pending move puts in it
    private async holdsAnything(relPath: string, local: boolean, entry: RemoteIndexEntry | null): Promise<boolean> {
        if (local && (await readdir(path.join(this.localRoot(), relPath))).length > 0) {
            return true;
        }
        const latest = new Map(this.latestOpPerNode().map((op) => [op.nodeUid, op]));
        if (entry && this.index.listChildren(relPath).some((child) => !takesAway(latest.get(child.uid), child))) {
            return true;
        }
        return [...latest.values()].some((op) => op.kind !== 'trash' && op.toPath.startsWith(`${relPath}/`));
    }

    // What goes to the Proton Drive trash for a delete of relPath: the item itself if Proton Drive has it, and whatever was
    // moved into it whose move hasn't reached Proton Drive yet (it isn't in the item there yet). A folder made here that
    // never reached Proton Drive holds only such things, or things that are still where they were there. A pending move
    // to relPath itself is no reason: its node is the item (then it is that already), or is hidden behind it, as the
    // cloud has another node at that name, which is what the user deleted.
    private trashTargets(relPath: string, entry: RemoteIndexEntry | null): Map<string, string> {
        const targets = new Map<string, string>();
        // A file being edited through the drive with no record yet stands for its baseline's node, not for another node
        // the index may hold at its path since
        const own = this.stateDb.getItemByPath(relPath)?.nodeUid ?? this.stateDb.getEditBaseline(relPath)?.nodeUid ?? nodeUidOf(entry);
        if (own !== null) {
            targets.set(own, relPath);
        } else {
            for (const item of this.topmostRecordedUnder(relPath)) {
                targets.set(item.nodeUid, item.localRelPath);
            }
        }
        for (const op of this.latestOpPerNode()) {
            if (op.kind !== 'trash' && op.toPath.startsWith(`${relPath}/`) && !targets.has(op.nodeUid)) {
                targets.set(op.nodeUid, op.toPath);
            }
        }
        return targets;
    }

    // The records at or under a path that aren't under another of them
    private topmostRecordedUnder(relPath: string): SyncedItemRecord[] {
        const topmost: SyncedItemRecord[] = [];
        for (const item of this.stateDb.getItemsUnder(relPath)) {
            if (!topmost.some((t) => item.localRelPath.startsWith(`${t.localRelPath}/`))) {
                topmost.push(item);
            }
        }
        return topmost;
    }

    private latestOpPerNode(): RemoteOp[] {
        const latest = new Map<string, RemoteOp>();
        for (const op of this.journal.pending()) {
            latest.set(op.nodeUid, op);
        }
        return [...latest.values()];
    }

    // Whether a pending remote operation is about this path (or one above it), or about the cloud node found at it: the
    // sync pass and local change handling leave those alone until it has run, as they would otherwise undo it here (a
    // local copy moved back to where the cloud still has it), or do it twice (a new file uploaded onto the old item).
    private awaitsRemoteOp(relPath: string, remoteUid?: string): boolean {
        const { uids, paths } = this.journal.guard();
        return (remoteUid !== undefined && uids.has(remoteUid)) || paths.some((p) => isWithin(relPath, p));
    }

    // The remote index is a copy of the cloud, written from its listings; with renames, moves and deletes through the
    // drive pending, it shows them as done (see applyPendingOpsToIndex). Every write of it goes through here: the entries
    // of nodes with pending renames and moves are kept aside first (a listing of the folder they were put in drops them),
    // and the pending operations applied again after.
    private indexWrite(write: () => void): void {
        const kept = this.keptForPendingOps();
        write();
        this.applyPendingOpsToIndex(kept);
    }

    private keptForPendingOps(): Map<string, RemoteIndexEntry[]> {
        const kept = new Map<string, RemoteIndexEntry[]>();
        for (const op of this.latestOpPerNode()) {
            const entry = op.kind === 'trash' ? null : this.index.getByUid(op.nodeUid);
            if (entry) {
                kept.set(op.nodeUid, this.index.listSubtree(entry.relPath).filter((e) => !isProvisional(e.uid)));
            }
        }
        return kept;
    }

    // The remote index as it will be once the pending operations reach Proton Drive, so listings show the result at once
    // (spec §5.2), whatever a listing of the cloud put back meanwhile:
    // - a node deleted here is left out;
    // - a renamed or moved node is at its new path, unless the cloud has another node there or its folder isn't there
    //   (then it stays where it was, if that is still free, or is left out until a listing puts it back; either way it
    //   is no longer anything at that path here: see liveIndexEntry);
    // - a folder made here that Proton Drive doesn't have yet is a provisional entry holding what was moved into it.
    // Nothing the cloud has is removed for it but what was deleted here, and provisional entries go once no pending move
    // needs them. `kept` has the entries of nodes a write just dropped, to put back at their new paths.
    // Deletes go first, as the name one frees can be what a rename takes. Then every node with a pending rename or move
    // that isn't in place yet is taken out of the tree, with what is under it, so that none is in the way of another (a
    // name one frees can be what another takes, at any depth, or two can swap names), and each goes to the target of
    // its latest operation, folders before what goes in them: targets are where the items are here now, which a later
    // rename of a folder above takes along (see RemoteOpsJournal.retarget).
    private applyPendingOpsToIndex(kept = new Map<string, RemoteIndexEntry[]>()): void {
        try {
            this.stateDb.connection.transaction(() => {
                const pending = this.journal.pending();
                for (const op of pending) {
                    if (op.kind === 'trash') {
                        this.index.removeSubtree(op.nodeUid);
                    }
                }
                const latest = new Map<string, RemoteOp>(pending.map((op) => [op.nodeUid, op]));
                const moves = [...latest.values()]
                    .filter((op): op is Exclude<RemoteOp, { kind: 'trash' }> => op.kind !== 'trash')
                    .sort((a, b) => depthOf(a.toPath) - depthOf(b.toPath) || a.id - b.id);
                // In place: at its target, in the folder the cloud has there (one in a folder made here is placed afresh,
                // as a node renamed to that folder's name may take its place)
                const was = new Map<string, string>();
                const outOfPlace: string[] = [];
                for (const op of moves) {
                    const entry = this.index.getByUid(op.nodeUid);
                    if (!entry) {
                        continue;
                    }
                    was.set(op.nodeUid, entry.relPath);
                    const parent = entry.parentUid ? this.index.getByUid(entry.parentUid) : null;
                    const inPlace =
                        entry.relPath === op.toPath &&
                        parent !== null &&
                        !isProvisional(parent.uid) &&
                        parent.relPath === parentOf(op.toPath);
                    if (!inPlace) {
                        outOfPlace.push(op.nodeUid);
                    }
                }
                // Only once every place is noted: a detach takes along what is under the node
                for (const uid of outOfPlace) {
                    this.index.detach(uid);
                }
                const needed = new Set<string>();
                const stuck: RemoteIndexEntry[] = [];
                for (const op of moves) {
                    const parent = this.indexedFolderFor(parentOf(op.toPath), needed);
                    const occupant = this.index.getByPath(op.toPath);
                    const entry = this.index.getByUid(op.nodeUid);
                    // A provisional folder at the target is only a stand-in for what goes there
                    if (!parent || (occupant && occupant.uid !== op.nodeUid && !isProvisional(occupant.uid))) {
                        if (entry) {
                            stuck.push(entry);
                        }
                        continue;
                    }
                    const name = path.posix.basename(op.toPath);
                    if (entry) {
                        if (entry.relPath !== op.toPath || entry.parentUid !== parent.uid) {
                            this.index.upsert({ ...entry, parentUid: parent.uid, relPath: op.toPath, name });
                        }
                        continue;
                    }
                    const [top, ...below] = kept.get(op.nodeUid) ?? [];
                    if (top) {
                        this.index.upsert({ ...top, parentUid: parent.uid, relPath: op.toPath, name });
                        for (const e of below) {
                            this.index.upsert({ ...e, relPath: op.toPath + e.relPath.slice(top.relPath.length) });
                        }
                    }
                }
                // One that can't go to its target goes back where it was, folders before what was in them, unless another
                // has taken that place
                stuck.sort((a, b) => depthOf(was.get(a.uid) ?? '') - depthOf(was.get(b.uid) ?? ''));
                for (const entry of stuck) {
                    const parent = entry.parentUid ? this.index.getByUid(entry.parentUid) : null;
                    const back = parent && !this.index.isDetached(parent) ? joinRel(parent.relPath, entry.name) : null;
                    const there = back === null ? null : this.index.getByPath(back);
                    if (back !== null && (!there || there.uid === entry.uid)) {
                        this.index.upsert({ ...entry, relPath: back });
                    } else {
                        this.index.removeSubtree(entry.uid);
                    }
                }
                for (const uid of this.index.uidsWithPrefix(PROVISIONAL)) {
                    if (!needed.has(uid)) {
                        this.index.removeSubtree(uid);
                    }
                }
            })();
        } catch (error: unknown) {
            this.logger.warn(`Failed to show pending changes in the remote index: ${error}`);
        }
    }

    // The index folder at a path, for a pending move into it: one the cloud has, or a provisional one (made now if need
    // be) for a folder of this computer that Proton Drive doesn't have yet. Provisional ones used are noted in `needed`.
    private indexedFolderFor(relPath: string, needed: Set<string>): RemoteIndexEntry | null {
        const entry = this.index.getByPath(relPath);
        if (entry) {
            for (let e: RemoteIndexEntry | null = entry; e && isProvisional(e.uid); e = e.parentUid ? this.index.getByUid(e.parentUid) : null) {
                needed.add(e.uid);
            }
            return entry.type === 'folder' ? entry : null;
        }
        if (relPath === '' || matchesIgnorePatterns(relPath, this.stateDb.getSettings().ignorePatterns)) {
            return null;
        }
        const local = lstatSync(path.join(this.localRoot(), relPath), { throwIfNoEntry: false });
        const parent = local?.isDirectory() ? this.indexedFolderFor(parentOf(relPath), needed) : null;
        if (!local || !parent) {
            return null;
        }
        const provisional: RemoteIndexEntry = {
            uid: `${PROVISIONAL}${randomUUID()}`,
            parentUid: parent.uid,
            relPath,
            name: path.posix.basename(relPath),
            type: 'folder',
            size: 0,
            mtimeMs: local.mtimeMs,
            sha1: null,
        };
        this.index.upsert(provisional);
        needed.add(provisional.uid);
        return provisional;
    }

    // The index entry at a path as this computer sees it. None for a node (or what is in one) that a pending operation
    // deletes or takes elsewhere, left where the cloud has it because its new place is taken there: deleting or moving
    // that would act on the item at its new place.
    private liveIndexEntry(relPath: string): RemoteIndexEntry | null {
        const entry = this.index.getByPath(relPath);
        if (!entry) {
            return null;
        }
        const latest = new Map(this.latestOpPerNode().map((op) => [op.nodeUid, op]));
        if (latest.size > 0) {
            for (let node: RemoteIndexEntry | null = entry; node; node = node.parentUid ? this.index.getByUid(node.parentUid) : null) {
                if (takesAway(latest.get(node.uid), node)) {
                    return null;
                }
                if (node.relPath === '') {
                    break;
                }
            }
        }
        return entry;
    }

    // A node's index entry from what Proton Drive says, for one a replayed operation just changed
    private indexFromCloud(node: NodeEntity): void {
        const parent = node.parentUid ? this.index.getByUid(node.parentUid) : null;
        const entry = parent?.type === 'folder' && !node.trashTime ? entryFromNode(node, parent.relPath) : null;
        try {
            this.indexWrite(() => {
                if (entry) {
                    this.index.upsert(entry);
                } else {
                    this.index.removeSubtree(node.uid);
                }
            });
        } catch (error: unknown) {
            this.logger.warn(`Failed to update the remote index for ${getName(node)}: ${error}`);
        }
    }

    // A folder just made in Proton Drive for a local one goes into the remote index at once (in place of a provisional
    // entry), so a move into it can find it and listings show it without waiting for its parent to be listed again.
    private indexCreatedFolder(folder: NodeEntity, relPath: string): void {
        const parent = this.index.getByPath(parentOf(relPath));
        const entry = parent && parent.uid === folder.parentUid ? entryFromNode(folder, parent.relPath) : null;
        if (!entry || entry.relPath !== relPath) {
            return;
        }
        try {
            this.indexWrite(() => this.index.upsert(entry));
        } catch (error: unknown) {
            this.logger.warn(`Failed to add ${relPath} to the remote index: ${error}`);
        }
    }

    // A file just uploaded, as a new node or a new revision, goes into the remote index at once, as a listing of its folder
    // would put it there (#47): Free up space, status, the drive's listings and an open then see it without waiting for
    // the next pass to list that folder. Its size, time and checksum are what the upload claimed. A new revision updates
    // the node's entry where it is (it doesn't rename the node), and only while the index has it: one dropped meanwhile,
    // deleted in the cloud, isn't put back. A new node goes into its folder, if the index has that folder (if not, the
    // listing that adds the folder adds the file too).
    private indexUploaded(uid: string, parentUid: string, name: string, result: UploadResult): void {
        const claimed = { size: result.size, mtimeMs: new Date(result.mtimeMs).getTime(), sha1: result.sha1 };
        const known = this.index.getByUid(uid);
        const parent = known || result.status !== 'uploaded' ? null : this.index.getByUid(parentUid);
        let entry: RemoteIndexEntry;
        if (known) {
            entry = { ...known, ...claimed };
        } else if (parent?.type === 'folder') {
            entry = { uid, parentUid, relPath: joinRel(parent.relPath, name), name, type: 'file', ...claimed };
        } else {
            return;
        }
        try {
            this.indexWrite(() => this.index.upsert(entry));
        } catch (error: unknown) {
            this.logger.warn(`Failed to add ${entry.relPath} to the remote index: ${error}`);
        }
    }

    // What a local move or replacement can change in the state database (records at and under both paths, the journal,
    // and the index entries of the moving node and at both paths), taken just before it, to put back exactly as it was if
    // the file system step then fails.
    private snapshotLocalStep(paths: string[], uids: string[]): LocalStepSnapshot {
        const records = paths.flatMap((p) => this.stateDb.getItemsUnder(p));
        const indexRoots: string[] = [];
        const index: RemoteIndexEntry[] = [];
        const keep = (entry: RemoteIndexEntry | null) => {
            if (entry) {
                indexRoots.push(entry.uid);
                index.push(...this.index.listSubtree(entry.relPath));
            }
        };
        for (const uid of uids) {
            keep(this.index.getByUid(uid));
        }
        for (const p of paths) {
            keep(this.index.getByPath(p));
        }
        return { paths, records, ops: this.journal.snapshot(), indexRoots, index };
    }

    private restoreLocalStep(snapshot: LocalStepSnapshot): void {
        this.stateDb.connection.transaction(() => {
            for (const p of snapshot.paths) {
                this.stateDb.removeItemByPath(p);
            }
            for (const record of snapshot.records) {
                this.stateDb.upsertItem(record);
            }
            this.journal.restore(snapshot.ops);
            for (const uid of snapshot.indexRoots) {
                this.index.removeSubtree(uid);
            }
            for (const p of snapshot.paths) {
                const occupant = this.index.getByPath(p);
                if (occupant) {
                    this.index.removeSubtree(occupant.uid);
                }
            }
            for (const entry of snapshot.index) {
                if (!isProvisional(entry.uid)) {
                    this.index.upsert(entry);
                }
            }
            this.applyPendingOpsToIndex();
            this.stateDb.deleteMeta(LOCAL_MOVE_IN_PROGRESS);
        })();
    }

    // The file system half of a local move, once its records went in one transaction with the note of it: a replacing
    // rename(2) when the user asked to replace, otherwise a move that never replaces what is there. If it fails, the state
    // database is put back as it was and the error is thrown (`Already exists: <path>` for something now at toRel).
    // onMoved runs as soon as the item is where it goes, before anything after that can fail (#145)
    private moveLocalOrUndo(
        fromRel: string,
        toRel: string,
        replace: boolean,
        snapshot: LocalStepSnapshot,
        onMoved?: () => void,
    ): void {
        const root = this.localRoot();
        let moved = false;
        let failure: unknown = null;
        try {
            if (replace) {
                renameSync(path.join(root, fromRel), path.join(root, toRel));
                moved = true;
            } else {
                moved = moveWithoutReplacing(path.join(root, fromRel), path.join(root, toRel));
            }
        } catch (error: unknown) {
            failure = error;
        }
        if (!moved) {
            this.restoreLocalStep(snapshot);
            throw driveOpErrorOf(failure, toRel);
        }
        onMoved?.();
        this.stateDb.deleteMeta(LOCAL_MOVE_IN_PROGRESS);
    }

    // A crash between a local move's transaction (records moved, cloud change journalled) and the move itself leaves the
    // records at the new path without the item: once the change reached Proton Drive, they would read as the user
    // deleting it there, which trashes it. So the move is finished on the next start, and before the files move between
    // the sync folder and the backing store. Whatever happens, no record is left where nothing is: if the item can't be
    // put there, it syncs as a new one from where it is (nothing lost or trashed).
    // What a local move is about to do, for recoverLocalMove: with the item it moves (inode and birth time, which a rename
    // keeps, and which a new file never has both of), so that a move found done already is never done again over what
    // was put at its old path since (#153)
    private moveIntent(fromRel: string, toRel: string, replace: boolean): string {
        const st = lstatSync(path.join(this.localRoot(), fromRel), { throwIfNoEntry: false, bigint: true });
        return JSON.stringify({
            from: fromRel,
            to: toRel,
            replace,
            ...(st ? { ino: st.ino.toString(), born: st.birthtimeNs.toString() } : {}),
        });
    }

    recoverLocalMove(): void {
        const raw = this.stateDb.getMeta(LOCAL_MOVE_IN_PROGRESS);
        if (raw === null) {
            return;
        }
        let intent: { from?: unknown; to?: unknown; replace?: unknown; ino?: unknown; born?: unknown } = {};
        try {
            intent = JSON.parse(raw) as typeof intent;
        } catch {
            // Unreadable: nothing to finish
        }
        if (typeof intent.from === 'string' && typeof intent.to === 'string' && intent.from && intent.to) {
            const root = this.localRoot();
            const from = path.join(root, intent.from);
            const to = path.join(root, intent.to);
            const exists = (fullPath: string) => lstatSync(fullPath, { throwIfNoEntry: false }) !== undefined;
            // The item the move was about is at its target already: the move happened, and only clearing the marker
            // didn't. Whatever is at the source now was put there since, and is never moved over it. Only this firm sign
            // stops a move: an identity that doesn't match (a marker from before #153, an inode renumbered by a remount)
            // leaves recovery as it always was, as a move not finished is undone in the cloud too otherwise
            const movedAlready = () => {
                if (typeof intent.ino !== 'string' || typeof intent.born !== 'string') {
                    return false;
                }
                const st = lstatSync(to, { throwIfNoEntry: false, bigint: true });
                return st !== undefined && st.ino.toString() === intent.ino && st.birthtimeNs.toString() === intent.born;
            };
            try {
                if (movedAlready()) {
                    // Nothing to finish
                } else if (intent.replace === true) {
                    // The replaced file is there either way: the source still being there says the rename didn't happen
                    if (exists(from)) {
                        renameSync(from, to);
                    }
                } else if (exists(from) && !exists(to)) {
                    moveWithoutReplacing(from, to);
                }
            } catch (error: unknown) {
                this.logger.warn(`Could not finish moving ${intent.from} to ${intent.to}: ${error}`);
            }
            const finished = exists(to);
            if (!finished) {
                this.stateDb.removeItemByPath(intent.to);
            }
            this.stateDb.logActivity({
                action: 'sync',
                localRelPath: intent.to,
                details: finished
                    ? `Finished moving ${intent.from} to ${intent.to} after an interruption`
                    : `Could not finish moving ${intent.from} to ${intent.to} after an interruption; it syncs from where it is`,
            });
        }
        this.stateDb.deleteMeta(LOCAL_MOVE_IN_PROGRESS);
    }

    private async replayTrash(op: Extract<RemoteOp, { kind: 'trash' }>): Promise<'next' | 'stop'> {
        try {
            for await (const result of this.sdk.trashNodes([op.nodeUid])) {
                if (result.uid === op.nodeUid && !result.ok) {
                    throw result.error;
                }
            }
        } catch (error: unknown) {
            if (await this.alreadyTrashed(op.nodeUid, error)) {
                // In the Proton Drive trash already, or gone (a trash sent before a restart, say): done (#179)
                this.journal.complete(op.id);
                this.indexWrite(() => this.index.removeSubtree(op.nodeUid));
                this.stateDb.logActivity({
                    action: 'trash-remote',
                    localRelPath: op.path,
                    details: 'Already in Proton Drive Trash',
                });
                return 'next';
            }
            if (error instanceof ValidationError) {
                // Not allowed, say: nothing more to do for it
                this.journal.complete(op.id);
                this.stateDb.logActivity({
                    action: 'sync',
                    localRelPath: op.path,
                    details: `Not moved to Proton Drive Trash: ${messageOf(error)}`,
                });
                return 'next';
            }
            return this.replayFailed(op, op.path, error);
        }
        this.journal.complete(op.id);
        this.indexWrite(() => this.index.removeSubtree(op.nodeUid));
        this.stateDb.logActivity({
            action: 'trash-remote',
            localRelPath: op.path,
            details: 'Moved to Proton Drive Trash after it was deleted or replaced on this computer',
        });
        return 'next';
    }

    private async replayMove(queued: Exclude<RemoteOp, { kind: 'trash' }>): Promise<'next' | 'stop' | 'again'> {
        if (this.isSuperseded(queued)) {
            this.journal.complete(queued.id);
            return 'next';
        }
        if (this.resolveFolderUid('') === null) {
            try {
                await this.getRootFolder();
            } catch (error: unknown) {
                return this.replayFailed(queued, queued.toPath, error);
            }
        }
        let node: NodeEntity | null = null;
        try {
            node = await this.sdk.getNode(queued.nodeUid);
        } catch (error: unknown) {
            // The SDK says ValidationError when the API has no such node
            if (!(error instanceof ValidationError)) {
                return this.replayFailed(queued, queued.toPath, error);
            }
        }
        // As it is now: a rename here while the cloud was asked may have moved its target, or superseded it. From here to
        // the decision below nothing waits, so nothing can change it in between.
        const op = this.journal.get(queued.id);
        if (!op || op.kind === 'trash') {
            return 'next';
        }
        if (this.isSuperseded(op)) {
            this.journal.complete(op.id);
            return 'next';
        }
        if (!node || node.trashTime) {
            return this.afterMoveSourceGone(op);
        }
        const parentRel = parentOf(op.toPath);
        const parentUid = this.resolveFolderUid(parentRel);
        if (parentUid === null) {
            // Folders made here that Proton Drive doesn't have yet are made there now, rather than waiting for the sync
            // pass or the watcher, which leave alone what is under a pending rename (and that may be waiting on this)
            const missing = this.missingCloudFolders(parentRel);
            if (missing === null) {
                // Its folder is gone from here since, or is never synced (ignored): Proton Drive keeps it where it is
                this.journal.complete(op.id);
                this.indexFromCloud(node);
                this.stateDb.logActivity({
                    action: 'sync',
                    localRelPath: op.toPath,
                    details: `Not moved in Proton Drive: ${parentRel} isn't synced`,
                });
                return 'next';
            }
            try {
                await this.makeCloudFolders(missing);
            } catch (error: unknown) {
                return this.replayFailed(op, op.toPath, error);
            }
            return 'again'; // Looked at afresh: a rename here meanwhile may have moved where it goes
        }
        let placedAs: string;
        try {
            placedAs = await this.placeNode(node, parentUid, op.toPath);
        } catch (error: unknown) {
            if (error instanceof ValidationError && !(error instanceof NodeWithSameNameExistsValidationError)) {
                const gone = await this.isGoneFromCloud(op.nodeUid);
                if (gone === true) {
                    return this.afterMoveSourceGone(op);
                }
                if (gone === false) {
                    // Refused (a name Proton Drive doesn't take, say): the next sync puts the local copy back where the
                    // cloud has it
                    this.journal.complete(op.id);
                    this.indexFromCloud(node);
                    this.tellUser(
                        'sync',
                        'Proton Drive: rename not applied',
                        op.toPath,
                        `${op.toPath} could not be renamed or moved in Proton Drive: ${messageOf(error)}`,
                    );
                    return 'next';
                }
            }
            return this.replayFailed(op, op.toPath, error);
        }
        await this.afterMoveReplayed(op, placedAs);
        return 'next';
    }

    // The folders at and above relPath that Proton Drive doesn't have yet, top down, all of them folders of this computer
    // that are synced (not ignored or hidden); null when one of them isn't, so there is nowhere to move into.
    private missingCloudFolders(relPath: string): string[] | null {
        const missing: string[] = [];
        for (let p = relPath; p !== '' && this.resolveFolderUid(p) === null; p = parentOf(p)) {
            const local = lstatSync(path.join(this.localRoot(), p), { throwIfNoEntry: false });
            if (
                !local?.isDirectory() ||
                matchesIgnorePatterns(p, this.stateDb.getSettings().ignorePatterns) ||
                this.policy.hiddenBy(p)?.hide === 'hidden'
            ) {
                return null;
            }
            missing.unshift(p);
        }
        return missing;
    }

    // Makes those folders in Proton Drive, each recorded and put in the remote index on its turn (one renamed or deleted
    // here meanwhile is followed up instead: see recordFolderMadeFor).
    private async makeCloudFolders(missing: string[]): Promise<void> {
        await this.observingLocal(async (since) => {
            for (const relPath of missing) {
                const parentUid = this.resolveFolderUid(parentOf(relPath));
                if (parentUid === null) {
                    return; // Renamed or deleted here meanwhile: the operation is looked at again
                }
                const { node, created } = await createRemoteFolder(this.sdk, parentUid, path.posix.basename(relPath));
                await this.inAvailabilityRun(async () => this.recordFolderMadeFor(relPath, node, created, since));
            }
        });
    }

    // A later operation on the same item decides where it ends up, or trashes it: an earlier one has nothing left to do
    private isSuperseded(op: RemoteOp): boolean {
        return this.journal.hasLaterOn(op.id, op.nodeUid);
    }

    // A failed operation stays pending and replay stops, keeping the order; one that keeps failing for a reason that
    // isn't the network or the server is given up on in the end, and the user told (the next sync then follows what the
    // cloud has).
    // Refusals Proton Drive answers with are ServerErrors too, yet not all are trouble a later try gets past (#39): a
    // permanent one (see permanentRefusal) is given up on after MAX_PERMANENT_REFUSALS tries; an API code outside the
    // 2xxx family, which an outage or an expired session can answer with, only after GIVE_UP_UNMAPPED_AFTER_MS of
    // failing in a row (MIN_UNMAPPED_FAILURES times at least), tried again with backoff meanwhile; a failure of any other
    // kind ends that run. Network failures, 5xx, 401 and rate limits are never given up on.
    private async replayFailed(op: RemoteOp, where: string, error: unknown): Promise<'next' | 'stop'> {
        const message = messageOf(error);
        const now = Date.now();
        const keep = (opts: { retryAfter?: number; unmapped?: boolean } = {}): 'stop' => {
            this.journal.failed(op.id, message, opts);
            this.logger.warn(`Could not apply a change to ${where} in Proton Drive yet; trying again later: ${message}`);
            return 'stop';
        };
        if (permanentRefusal(error)) {
            if (op.attempts + 1 < MAX_PERMANENT_REFUSALS) {
                return keep();
            }
        } else if (unmappedApiCode(error)) {
            const run = this.journal.failures(op.id);
            const firstFailedAt = run.firstFailedAt ?? now;
            if (now - firstFailedAt < GIVE_UP_UNMAPPED_AFTER_MS || run.unmappedFailures + 1 < MIN_UNMAPPED_FAILURES) {
                const retryAfter = now + Math.min(2 ** run.unmappedFailures * 60_000, MAX_REPLAY_BACKOFF_MS);
                return keep({ retryAfter, unmapped: true });
            }
        } else if (isTransient(error) || op.attempts + 1 < MAX_UNEXPECTED_FAILURES) {
            return keep();
        }
        this.journal.complete(op.id);
        this.tellUser(
            'error',
            'Proton Drive: change not applied',
            where,
            `A change to ${where} could not be made in Proton Drive, and was given up on: ${message}. The next sync follows what Proton Drive has`,
        );
        await this.followCloudAfterGivingUp(op);
        return 'next';
    }

    // After an operation is given up on, this computer follows what Proton Drive has of its node: its index entry goes
    // back to where the cloud has it now (a local copy follows at the next pass, as for a move made in the cloud), and the
    // next pass crawls the online-only folders, so listings show the item where it is (#39). Nothing is deleted: a
    // rename or move given up on leaves the item under its old name, a delete given up on brings it back.
    private async followCloudAfterGivingUp(op: RemoteOp): Promise<void> {
        this.onlineOnlyCrawlDue = true;
        try {
            this.indexFromCloud(await this.sdk.getNode(op.nodeUid));
        } catch (error: unknown) {
            this.logger.warn(`Could not look up ${op.nodeUid} in Proton Drive after giving up on a change to it; the next crawl does: ${error}`);
        }
    }

    private async isGoneFromCloud(uid: string): Promise<boolean | undefined> {
        try {
            return Boolean((await this.sdk.getNode(uid)).trashTime);
        } catch (error: unknown) {
            return error instanceof ValidationError ? true : undefined;
        }
    }

    // The node of the folder at a path here, for a move into it: from its record, from a pending rename or move that put
    // it there, or from the remote index (at that path, or under a folder found one of those ways, as a listing can put
    // the index back to where the cloud still has a renamed folder). Null for a folder Proton Drive doesn't have yet.
    private resolveFolderUid(relPath: string): string | null {
        if (relPath === '') {
            return this.index.getByPath('')?.uid ?? this.rootNode?.uid ?? null;
        }
        const record = this.stateDb.getItemByPath(relPath);
        if (record) {
            return record.type === 'folder' ? record.nodeUid : null;
        }
        for (const op of this.latestOpPerNode()) {
            if (op.kind !== 'trash' && op.toPath === relPath) {
                return op.nodeUid;
            }
        }
        const entry = this.liveIndexEntry(relPath);
        if (entry && !isProvisional(entry.uid)) {
            return entry.type === 'folder' ? entry.uid : null;
        }
        const parentUid = this.resolveFolderUid(parentOf(relPath));
        const parent = parentUid === null ? null : this.index.getByUid(parentUid);
        if (!parent) {
            return null;
        }
        const child = this.liveIndexEntry(joinRel(parent.relPath, path.posix.basename(relPath)));
        return child && !isProvisional(child.uid) && child.type === 'folder' && child.parentUid === parentUid ? child.uid : null;
    }

    // Puts a node into its new folder under its new name, as far as Proton Drive lets it, and returns the name it got: a
    // conflict name when the one asked for is taken there. It looks at where the node is first, so running it again after
    // an interruption carries on from there.
    private async placeNode(node: NodeEntity, parentUid: string, toPath: string): Promise<string> {
        const name = path.posix.basename(toPath);
        const currentName = getName(node);
        if (node.parentUid !== parentUid) {
            try {
                await this.moveNodeTo(node.uid, parentUid);
            } catch (error: unknown) {
                if (!(error instanceof NodeWithSameNameExistsValidationError)) {
                    throw error;
                }
                // Its present name is taken in the new folder, which the new name may not be: renamed first, then moved
                if (currentName === name) {
                    return this.placeUnderConflictName(node.uid, parentUid, toPath, false);
                }
                try {
                    await this.sdk.renameNode(node.uid, name);
                    await this.moveNodeTo(node.uid, parentUid);
                    return name;
                } catch (retryError: unknown) {
                    if (!(retryError instanceof NodeWithSameNameExistsValidationError)) {
                        throw retryError;
                    }
                    return this.placeUnderConflictName(node.uid, parentUid, toPath, false);
                }
            }
        }
        if (currentName !== name) {
            try {
                await this.sdk.renameNode(node.uid, name);
            } catch (error: unknown) {
                if (!(error instanceof NodeWithSameNameExistsValidationError)) {
                    throw error;
                }
                return this.placeUnderConflictName(node.uid, parentUid, toPath, true);
            }
        }
        return name;
    }

    // The name being taken in Proton Drive, the item gets the usual conflict name there instead (one free here too)
    private async placeUnderConflictName(uid: string, parentUid: string, toPath: string, inParent: boolean): Promise<string> {
        const parentRel = parentOf(toPath);
        const first = formatConflictFileName(path.posix.basename(toPath));
        const dot = first.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [first.slice(0, dot), first.slice(dot)] : [first, ''];
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = attempt === 0 ? first : `${stem}-${attempt}${ext}`;
            const candidatePath = joinRel(parentRel, candidate);
            if (
                (await this.existsLocally(candidatePath)) ||
                this.stateDb.getItemByPath(candidatePath) ||
                this.index.getByPath(candidatePath)
            ) {
                continue;
            }
            try {
                await this.sdk.renameNode(uid, candidate);
                if (!inParent) {
                    await this.moveNodeTo(uid, parentUid);
                }
                return candidate;
            } catch (error: unknown) {
                if (!(error instanceof NodeWithSameNameExistsValidationError)) {
                    throw error;
                }
            }
        }
        throw new Error(`No free name for ${toPath} in Proton Drive`);
    }

    private async moveNodeTo(uid: string, parentUid: string): Promise<void> {
        for await (const result of this.sdk.moveNodes([uid], parentUid)) {
            if (result.uid === uid && !result.ok) {
                throw result.error;
            }
        }
    }

    // The rename or move is in Proton Drive. When it got a conflict name there, its local copy, records and pending
    // operations take that name too (unless it was renamed again here meanwhile, which a later operation brings to the
    // cloud), and the user is told. Then the remote index takes what the cloud says.
    private async afterMoveReplayed(op: Exclude<RemoteOp, { kind: 'trash' }>, placedAs: string): Promise<void> {
        const wanted = path.posix.basename(op.toPath);
        const conflict = await this.inAvailabilityRun(async () => {
            // As it is now: a folder above it may have been renamed here meanwhile
            const fresh = this.journal.get(op.id);
            let renamed: { from: string; to: string } | null = null;
            if (placedAs !== wanted && fresh && fresh.kind !== 'trash' && path.posix.basename(fresh.toPath) === wanted) {
                renamed = { from: fresh.toPath, to: joinRel(parentOf(fresh.toPath), placedAs) };
                try {
                    await this.moveLocalToConflictName(op.nodeUid, renamed.from, renamed.to);
                } catch (error: unknown) {
                    this.logger.warn(`Could not rename ${renamed.from} to ${renamed.to} here as in Proton Drive: ${error}`);
                }
            }
            this.journal.complete(op.id);
            return renamed;
        });
        try {
            this.indexFromCloud(await this.sdk.getNode(op.nodeUid));
        } catch (error: unknown) {
            this.logger.warn(`Could not read ${op.toPath} back from Proton Drive for the remote index: ${error}`);
        }
        if (conflict) {
            this.tellUser(
                'conflict',
                'Proton Drive: name already taken',
                conflict.to,
                `${conflict.from} already exists in Proton Drive, so it was renamed to ${path.posix.basename(conflict.to)}`,
            );
        }
    }

    private async moveLocalToConflictName(uid: string, fromRel: string, toRel: string): Promise<void> {
        const record = this.stateDb.getItemByPath(fromRel);
        const hasLocalCopy =
            record?.nodeUid === uid &&
            (await this.existsLocally(fromRel)) &&
            !(await this.existsLocally(toRel)) &&
            !this.stateDb.hasItemsUnder(toRel);
        if (!hasLocalCopy) {
            // Online-only (or not where it was): only what leads to it moves
            this.journal.retarget(fromRel, toRel);
            return;
        }
        this.watcher.suppressPath(fromRel);
        this.watcher.suppressPath(toRel);
        await this.whileRemoving(async (records) => {
            const snapshot = this.snapshotLocalStep([fromRel, toRel], [uid]);
            this.stateDb.connection.transaction(() => {
                this.stateDb.renameItemPath(fromRel, toRel, this.cloudParentOf(toRel));
                this.journal.retarget(fromRel, toRel);
                this.stateDb.setMeta(LOCAL_MOVE_IN_PROGRESS, this.moveIntent(fromRel, toRel, false));
            })();
            this.moveLocalOrUndo(fromRel, toRel, false, snapshot, () => records.dropSubtree(fromRel));
        }, { from: fromRel, to: toRel });
    }

    // The item was deleted or trashed in Proton Drive before its rename or move reached it. A local copy stays and
    // uploads as a new item from where it is now, so nothing is lost; an online-only one has nothing left to move, and
    // the user is told.
    private async afterMoveSourceGone(op: Exclude<RemoteOp, { kind: 'trash' }>): Promise<'next'> {
        await this.inAvailabilityRun(async () => {
            const fresh = this.journal.get(op.id);
            const toPath = fresh && fresh.kind !== 'trash' ? fresh.toPath : op.toPath;
            const record = this.stateDb.getItemByPath(toPath);
            const hasLocalCopy = record?.nodeUid === op.nodeUid && (await this.existsLocally(toPath));
            this.stateDb.connection.transaction(() => {
                if (record?.nodeUid === op.nodeUid) {
                    this.stateDb.removeItemByPath(toPath);
                }
                this.journal.complete(op.id);
                this.indexWrite(() => this.index.removeSubtree(op.nodeUid));
            })();
            if (hasLocalCopy) {
                this.stateDb.logActivity({
                    action: 'sync',
                    localRelPath: toPath,
                    details: `${toPath} was deleted from Proton Drive before its rename reached it, so it uploads again as a new item`,
                });
            } else {
                this.tellUser(
                    'sync',
                    'Proton Drive: rename not applied',
                    toPath,
                    `${toPath} could not be renamed or moved in Proton Drive: it was deleted there`,
                );
            }
        });
        return 'next';
    }

    private tellUser(action: 'sync' | 'conflict' | 'error', title: string, relPath: string, notice: string): void {
        this.stateDb.logActivity({ action, localRelPath: relPath, details: notice });
        sendDesktopNotification({
            title,
            body: notice,
            urgency: 'normal',
            enabled: this.stateDb.getSettings().notificationsEnabled,
        });
    }

    get remoteIndex(): RemoteIndex {
        return this.index;
    }

    get availability(): AvailabilityPolicy {
        return this.policy;
    }

    // Pin, free, hide or unhide an item of My files by its path ('' is the whole drive, for pin and free only). The
    // changes run one at a time on availabilityRun, in the order asked; asking again about the same item supersedes
    // what is still waiting or running for it. A pin's download runs after its turn, so other changes and local change
    // handling don't wait for it. Rejects with `Not in Proton Drive: <path>` for a path the remote index doesn't hold.
    async setAvailability(relPath: string, action: AvailabilityAction): Promise<AvailabilityResult> {
        if (this.holding()) {
            throw new Error(BUSY_MOVING);
        }
        await this.refuseUntilAccountChecked();
        if (this.holding()) {
            throw new Error(BUSY_MOVING); // again: a move of the files may have begun while it looked
        }
        this.refuseWhileFilesGone();
        return this.tracked(() => this.setAvailabilityNow(relPath, action));
    }

    private async setAvailabilityNow(relPath: string, action: AvailabilityAction): Promise<AvailabilityResult> {
        if (!AVAILABILITY_ACTIONS.includes(action)) {
            throw new Error(`Unknown availability action: ${action}`);
        }
        if (relPath === '' && (action === 'hide' || action === 'unhide')) {
            throw new Error(`Can't ${action} the whole of Proton Drive: only pin and free apply to it`);
        }
        const asked = this.askAvailability(this.index.getByPath(relPath)?.uid);
        const pinned: { stillAsked: (() => boolean) | null } = { stillAsked: null };
        const result = await this.inAvailabilityRun(async () => {
            const entry = this.index.getByPath(relPath);
            if (!entry || isProvisional(entry.uid)) {
                throw new Error(`Not in Proton Drive: ${relPath}`);
            }
            // The path may lead to another node by now (a move in the cloud); then this ask is about that one
            const ask = asked && asked.uid === entry.uid ? asked.n : this.askAvailability(entry.uid)!.n;
            const current = () => this.availabilityAsks.get(entry.uid) === ask;
            if (!current()) {
                return this.availabilityResult(relPath); // Asked again since: the later ask decides
            }
            switch (action) {
                case 'pin':
                    this.stateDb.connection.transaction(() => {
                        if (relPath === '') {
                            this.stateDb.deleteMeta(PIN_ROOT_ON_FIRST_SYNC); // An explicit choice wins over the default
                        }
                        this.policy.setPin(entry.uid, 'pinned', true);
                    })();
                    pinned.stillAsked = current;
                    return this.availabilityResult(relPath);
                case 'free':
                    return this.freeUpSpace(relPath, entry.uid, current);
                case 'hide':
                    return this.hide(relPath, entry.uid, current, false);
                case 'unhide':
                    return this.unhide(relPath, entry.uid);
            }
        });
        if (!pinned.stillAsked?.()) {
            return result; // Not a pin, or asked again since (a free, say): no download
        }
        await this.downloadPinned(relPath);
        return this.availabilityResult(relPath);
    }

    // What is hidden from this computer, for the app's list with Unhide: each hidden item by its path, sorted, a hide
    // still waiting on uploads as hiding. Reads only.
    hiddenItems(): Array<{ path: string; state: 'hidden' | 'hiding' }> {
        return this.policy
            .hiddenItems()
            .map(({ relPath, hide }) => ({ path: relPath, state: hide === 'pending' ? 'hiding' : 'hidden' }));
    }

    // The availability of an item of My files by its path, for `status <path>`. A path the remote index doesn't hold
    // resolves through its nearest indexed folder only while it exists on this computer (new local items aren't indexed
    // until they are uploaded, ruling R3); otherwise this rejects with `Not in Proton Drive: <path>`.
    async availabilityOf(relPath: string): Promise<ItemAvailability> {
        if (!this.index.getByPath(relPath) && !(await this.existsInSyncFolder(relPath))) {
            throw new Error(`Not in Proton Drive: ${relPath}`);
        }
        return this.policy.stateOf(relPath);
    }

    // Like existsLocally, for a path from outside the engine: one that climbs out of the sync folder is not in it.
    private async existsInSyncFolder(relPath: string): Promise<boolean> {
        const root = path.resolve(this.localRoot());
        const fullPath = path.resolve(root, relPath);
        const fromRoot = path.relative(root, fullPath);
        if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
            return false;
        }
        return lstat(fullPath).then(
            () => true,
            () => false,
        );
    }

    private askAvailability(uid: string | undefined): { uid: string; n: number } | null {
        if (!uid) {
            return null;
        }
        const n = (this.availabilityAsks.get(uid) ?? 0) + 1;
        this.availabilityAsks.set(uid, n);
        return { uid, n };
    }

    private inAvailabilityRun<T>(step: () => Promise<T>): Promise<T> {
        const run = this.availabilityRun.then(step);
        this.availabilityRun = run.then(
            () => {},
            () => {},
        );
        return run;
    }

    private availabilityResult(relPath: string, kept: string[] = [], refused: string | null = null): AvailabilityResult {
        return { state: this.policy.stateOf(relPath), kept, refused };
    }

    // Drops records for a removal of local copies (each just before its file goes). The records are kept aside so
    // that one whose file stayed after all, because it changed at the very last moment, can be put back: without it an
    // edit would read as a conflict on the next sync, kept as a conflict copy beside the cloud version.
    private recordDropper(takenAway: TakenAway) {
        const dropped = new Map<string, SyncedItemRecord>();
        return {
            drop: (relPath: string) => {
                const record = this.stateDb.getItemByPath(relPath);
                if (record) {
                    dropped.set(relPath, record);
                }
                takenAway.paths.add(relPath);
                this.stateDb.removeItemByPath(relPath);
            },
            dropSubtree: (relPath: string) => {
                takenAway.subtrees.add(relPath);
                this.stateDb.removeItemByPath(relPath);
            },
            // Only notes a subtree whose records are gone already
            noteSubtree: (relPath: string) => {
                takenAway.subtrees.add(relPath);
            },
            putBack: async (stayed: string[]) => {
                for (const relPath of stayed) {
                    const record = dropped.get(relPath);
                    if (record && !this.stateDb.getItemByPath(relPath) && (await this.existsLocally(relPath))) {
                        this.stateDb.upsertItem(record);
                    }
                }
            },
        };
    }

    // Drops the records at or below relPath whose local copies are gone: any of them would read as the user deleting
    // that item, and trash it in the cloud.
    private async dropRecordsWithoutFiles(relPath: string): Promise<void> {
        for (const item of this.stateDb.getItemsUnder(relPath)) {
            if (!(await this.existsLocally(item.localRelPath))) {
                this.stateDb.removeItemByPath(item.localRelPath);
            }
        }
    }

    // Brings a just pinned item down now: its folders as plain local folders (online-only in the app) and then the
    // item, or its whole subtree. It is marked as syncing meanwhile, so the full sync leaves it alone. A failure is
    // logged; the pin stands and the next sync tries again.
    private async downloadPinned(relPath: string): Promise<void> {
        const settings = this.stateDb.getSettings();
        if (settings.paused || !this.auth.isLoggedIn()) {
            return; // The next sync brings it down
        }
        if (relPath === '') {
            await this.reconcileNow();
            return;
        }
        // The exact path (names can end in a space), so the full sync skips it and the finally below clears it
        this.syncingFolders.add(relPath);
        this.state = 'syncing';
        try {
            const entry = this.index.getByPath(relPath);
            if (!entry) {
                return;
            }
            const node = await this.sdk.getNode(entry.uid);
            for (let slash = relPath.indexOf('/'); slash !== -1; slash = relPath.indexOf('/', slash + 1)) {
                this.watcher.suppressPath(relPath.slice(0, slash));
            }
            const localFullPath = path.join(this.localRoot(), relPath);
            await mkdir(path.dirname(localFullPath), { recursive: true });
            const st = await stat(localFullPath).catch(() => null);
            const localInfo = st
                ? { isDirectory: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }
                : undefined;
            const remoteMap = new Map<string, NodeEntity>([[relPath, node]]);
            const onlineOnly: OnlineOnlyFolder[] = [];
            this.currentAction = `Syncing ${relPath}`;
            await this.observingLocal(async (since) => {
                await this.reconcileSinglePath(
                    relPath,
                    node,
                    localInfo,
                    this.stateDb.getItemByPath(relPath) ?? undefined,
                    remoteMap,
                    settings,
                    since,
                );
                const isLocalFolder = await stat(localFullPath).then(
                    (s) => s.isDirectory(),
                    () => false,
                );
                if (node.type === NodeType.Folder && isLocalFolder) {
                    await this.reconcileDirectoryIncremental(node, relPath, remoteMap, settings, since, onlineOnly);
                }
            });
            // A pin always reads its own subtree in full
            await this.crawlOnlineOnly(onlineOnly);
        } catch (error: unknown) {
            this.logger.warn(`Could not download ${relPath} now; the next sync tries again: ${error}`);
        } finally {
            this.syncingFolders.delete(relPath);
            if (!this.reconcileRunning && this.syncingFolders.size === 0) {
                this.currentAction = null;
                this.state = this.stateDb.getSettings().paused ? 'paused' : 'idle';
            }
        }
    }

    // Free up space: the item becomes online-only, and its local copies go where they are exactly what Proton Drive
    // holds. Anything else (ignored, not a regular file, new or edited, or changed while this runs) stays, with its
    // record, and the user is told.
    private async freeUpSpace(relPath: string, uid: string, current: () => boolean): Promise<AvailabilityResult> {
        this.stateDb.connection.transaction(() => {
            if (relPath === '') {
                this.stateDb.deleteMeta(PIN_ROOT_ON_FIRST_SYNC); // An explicit choice wins over the default
            }
            this.policy.setPin(uid, 'unpinned', true);
        })();
        const settings = this.stateDb.getSettings();
        const scan = await scanLocalCopies({
            syncDir: this.localRoot(),
            relPath,
            ignorePatterns: settings.ignorePatterns,
            stopAtFirst: false,
            isUnchangedSyncedCopy: (rel, fullPath, st) => this.isUnchangedSyncedCopy(rel, fullPath, st),
        });
        if (!current()) {
            return this.availabilityResult(relPath); // Asked again while it was being looked at: that ask decides
        }
        const { kept } = await this.whileRemoving(async (records) => {
            const removal = await removeScannedEntries({
                syncDir: this.localRoot(),
                entries: scan.entries,
                keep: new Set(scan.localOnly.map((item) => item.relPath)),
                mode: 'keep-changed',
                dropRecord: records.drop,
                shouldContinue: () => current() && !this.policy.isPinned(relPath),
            });
            await records.putBack(removal.kept);
            return removal;
        });
        if (scan.entries.length > kept.length) {
            this.stateDb.logActivity({
                action: 'delete-local',
                localRelPath: relPath || '/',
                details: 'Freed up space (removed the local copies; kept in Proton Drive)',
            });
        }
        // The kept things themselves, not the folders holding them, and not the engine's own downloads in progress
        const stayed = kept
            .filter((p) => !isEngineTempName(path.posix.basename(p)) && !kept.some((q) => q.startsWith(`${p}/`)))
            .sort();
        if (stayed.length > 0) {
            const message = `${stayed.length} item(s) in ${relPath || 'your Proton Drive folder'} stayed on this computer because they aren't in Proton Drive yet (e.g. ${stayed[0]})`;
            this.stateDb.logActivity({ action: 'sync', localRelPath: relPath || '/', details: message });
            sendDesktopNotification({
                title: 'Proton Drive: some items stayed on this computer',
                body: message,
                urgency: 'normal',
                enabled: settings.notificationsEnabled,
            });
        }
        return this.availabilityResult(relPath, kept);
    }

    // Hide: refused while the item holds something that can never be uploaded (ignored, or not a regular file); waits
    // as 'hiding' while it holds new or edited files, which keep uploading; otherwise it is flagged hidden and its local
    // copies go, all or nothing. `rerun` is a pending hide being tried again after a sync.
    private async hide(
        relPath: string,
        uid: string,
        current: () => boolean,
        rerun: boolean,
    ): Promise<AvailabilityResult> {
        if (this.policy.hiddenBy(relPath)?.hide === 'hidden') {
            return this.availabilityResult(relPath); // Already hidden, by itself or by a folder above
        }
        const settings = this.stateDb.getSettings();
        const scan = await scanLocalCopies({
            syncDir: this.localRoot(),
            relPath,
            ignorePatterns: settings.ignorePatterns,
            stopAtFirst: false,
            isUnchangedSyncedCopy: (rel, fullPath, st) => this.isUnchangedSyncedCopy(rel, fullPath, st),
        });
        // Looked at again, as the scan took a while: asked again (an unhide, say), moved, or no longer waiting to be
        // hidden means it stops here, having changed nothing
        if (
            !current() ||
            this.index.getByUid(uid)?.relPath !== relPath ||
            (rerun && !this.hasOwnHide(relPath, 'pending'))
        ) {
            return this.availabilityResult(relPath);
        }
        const blocker = scan.localOnly.find((item) => item.reason !== 'not-in-cloud');
        if (blocker) {
            const refused = `Can't hide ${relPath}: ${blocker.relPath} exists only on this computer`;
            if (this.hasOwnHide(relPath)) {
                this.policy.setHide(uid, null); // A hide that was waiting can no longer happen
            }
            this.stateDb.logActivity({ action: 'error', localRelPath: relPath, details: refused });
            if (rerun) {
                sendDesktopNotification({
                    title: 'Proton Drive: folder not hidden',
                    body: refused,
                    urgency: 'normal',
                    enabled: settings.notificationsEnabled,
                });
            }
            return this.availabilityResult(relPath, [], refused);
        }
        if (scan.localOnly.length > 0) {
            this.policy.setHide(uid, 'pending'); // Waits for the uploads; the sync after them finishes it
            return this.availabilityResult(relPath);
        }
        this.policy.setHide(uid, 'hidden');
        const removal = await this.whileRemoving(async (records) => {
            const result = await removeScannedEntries({
                syncDir: this.localRoot(),
                entries: scan.entries,
                keep: new Set(),
                mode: 'all-or-nothing',
                dropRecord: records.drop,
                shouldContinue: () =>
                    current() && this.index.getByUid(uid)?.relPath === relPath && this.hasOwnHide(relPath, 'hidden'),
            });
            await records.putBack(result.kept);
            return result;
        });
        if (!removal.complete) {
            // Something changed, or it was called off: what is left waits as hiding, and is looked at again later
            if (this.hasOwnHide(relPath, 'hidden')) {
                this.policy.setHide(uid, 'pending');
            }
            return this.availabilityResult(relPath);
        }
        // Its local copy is gone, so no record under it may be left (say, for a file deleted while it was hiding)
        await this.dropRecordsWithoutFiles(relPath);
        this.stateDb.logActivity({
            action: 'delete-local',
            localRelPath: relPath,
            details: 'Hidden from this computer (removed the local copy; kept in Proton Drive)',
        });
        return this.availabilityResult(relPath);
    }

    // Whether the item itself (not a folder above it) carries a hide flag, of the given kind if one is given.
    private hasOwnHide(relPath: string, hide?: 'pending' | 'hidden'): boolean {
        const hidden = this.policy.hiddenBy(relPath);
        return hidden !== null && hidden.relPath === relPath && (hide === undefined || hidden.hide === hide);
    }

    // Unhide: the item comes back online-only. Records whose local copies are gone are dropped first: once the flag is
    // cleared they would read as the user deleting those files, and trash them in the cloud. Nothing listed it while it
    // was hidden, so its part of the remote index is read again.
    private async unhide(relPath: string, uid: string): Promise<AvailabilityResult> {
        if (!this.hasOwnHide(relPath)) {
            return this.availabilityResult(relPath); // Not hidden, or hidden by a folder above, which is what to unhide
        }
        await this.dropRecordsWithoutFiles(relPath);
        this.stateDb.connection.transaction(() => {
            this.policy.setHide(uid, null);
            if (this.policy.isPinned(relPath)) {
                this.policy.setPin(uid, 'unpinned', true); // Online-only, even inside a pinned folder
            }
        })();
        try {
            await this.indexRemoteSubtree(await this.sdk.getNode(uid), relPath);
        } catch (error: unknown) {
            this.logger.warn(`Could not read ${relPath} again for the remote index: ${error}`);
        }
        return this.availabilityResult(relPath);
    }

    // Tries again every hide that was waiting for uploads, once a sync has run.
    private async completePendingHides(): Promise<void> {
        // Counted now, before waiting for a turn: a request about one of them made meanwhile (an unhide) supersedes it
        const askedBefore = new Map<string, number | undefined>();
        for (const relPath of this.policy.pendingHides()) {
            const uid = this.index.getByPath(relPath)?.uid;
            if (uid) {
                askedBefore.set(uid, this.availabilityAsks.get(uid));
            }
        }
        if (askedBefore.size === 0) {
            return;
        }
        await this.inAvailabilityRun(async () => {
            for (const relPath of this.policy.pendingHides()) {
                const uid = this.index.getByPath(relPath)?.uid;
                if (!uid || !askedBefore.has(uid) || this.stateDb.getSettings().paused) {
                    continue; // Pending only since this was asked for: tried after the next sync
                }
                const ask = askedBefore.get(uid);
                try {
                    await this.hide(relPath, uid, () => this.availabilityAsks.get(uid) === ask, true);
                } catch (error: unknown) {
                    this.logger.warn(`Could not finish hiding ${relPath}; trying again after the next sync: ${error}`);
                }
            }
        });
    }

    private async getRootFolder(): Promise<NodeEntity> {
        if (this.rootNode) {
            return this.rootNode;
        }
        const generation = this.accountGeneration;
        const root = await this.sdk.getMyFilesRootFolder();
        if (generation === this.accountGeneration) {
            this.rootNode = root; // Not when stopped or started again meanwhile: it may be another account's (#35)
        }
        return root;
    }

    // The cloud folder that relPath goes into, made (with any missing above it) where Proton Drive doesn't have it. Each
    // one made or found by name for a folder of this computer is recorded (see recordFolderMadeFor): unrecorded, it
    // would be renamed or deleted here without its node.
    private async ensureParentFolderNode(
        relPath: string,
        remoteMap: Map<string, NodeEntity>,
        since: number,
    ): Promise<NodeEntity> {
        const dirRel = path.posix.dirname(relPath);
        const root = await this.getRootFolder();
        if (!dirRel || dirRel === '.') {
            return root;
        }

        const cached = remoteMap.get(dirRel);
        if (cached) {
            return cached;
        }

        const dbItem = this.stateDb.getItemByPath(dirRel);
        if (dbItem && dbItem.type === 'folder') {
            const existing = await this.sdk.getNode(dbItem.nodeUid).catch(() => null);
            if (existing) {
                remoteMap.set(dirRel, existing);
                return existing;
            }
        }

        // Down from the root, each folder: as the listing had it, as its record names it, or made by name. A recorded
        // folder whose node is gone from Proton Drive (deleted for good elsewhere, not yet removed here) is never made
        // again by name, at any depth, or the folder the other device deleted would come back: refused, and what was to
        // go in it stays here unrecorded, which that folder's removal keeps (#161). One of that name made since in the
        // cloud stands in for it, so a stale record never holds anything up for good
        const segments = dirRel.split('/').filter(Boolean);
        let currentParent = root;
        let currentRel = '';

        for (const seg of segments) {
            currentRel = currentRel ? `${currentRel}/${seg}` : seg;
            const foundInMap = remoteMap.get(currentRel);
            if (foundInMap) {
                currentParent = foundInMap;
                continue;
            }
            const recorded = this.stateDb.getItemByPath(currentRel);
            if (recorded?.type === 'folder') {
                const node = await this.sdk.getNode(recorded.nodeUid).then(
                    (found) => found,
                    (error: unknown) => {
                        if (error instanceof ValidationError) return null;
                        throw error;
                    },
                );
                if (node && !node.trashTime) {
                    remoteMap.set(currentRel, node);
                    currentParent = node;
                    continue;
                }
                if (!node) {
                    const parentUid = currentParent.uid;
                    const madeSince = (await listFolderChildren(this.sdk, currentParent)).find(
                        (child) => child.type === NodeType.Folder && getName(child) === seg && child.parentUid === parentUid,
                    );
                    if (!madeSince) {
                        throw new Error(`${currentRel} is gone from Proton Drive: nothing is put there`);
                    }
                    remoteMap.set(currentRel, madeSince);
                    currentParent = madeSince;
                    continue;
                }
                // In the Proton Drive trash: as it is (the callers that put things in it check that, #160)
                remoteMap.set(currentRel, node);
                currentParent = node;
                continue;
            }
            const { node: ensured, created } = await createRemoteFolder(this.sdk, currentParent, seg);
            remoteMap.set(currentRel, ensured);
            this.recordFolderMadeFor(currentRel, ensured, created, since);
            currentParent = ensured;
        }

        return currentParent;
    }

    private indexEntries(children: NodeEntity[], parentRelPath: string) {
        return children.flatMap((child) => {
            const entry = entryFromNode(child, parentRelPath);
            return entry ? [entry] : [];
        });
    }

    // The index is a cache: a listing is written only for a folder the index still holds at that path (so no orphan rows),
    // and a failed write is logged without aborting the sync.
    private recordListing(folder: NodeEntity, relPath: string, children: NodeEntity[]): boolean {
        try {
            if (relPath !== '' && this.index.getByUid(folder.uid)?.relPath !== relPath) {
                return false;
            }
            this.indexWrite(() => this.index.replaceChildren(folder.uid, relPath, this.indexEntries(children, relPath)));
            return true;
        } catch (error: unknown) {
            this.logger.warn(`Failed to update the remote index for ${relPath || '/'}: ${error}`);
            return false;
        }
    }

    // Lists and records a remote folder's subtree in the index without touching disk or sync state. Returns whether the
    // whole subtree was recorded: false when paused, when the folder is not indexed at relPath, or when a listing failed
    // (that is logged, and the rest is still crawled). Nothing is listed below a hidden folder. The index leaves out
    // Proton Docs and Sheets, so the folders whose listing holds one are added to `unsupportedIn` when given.
    private async indexRemoteSubtree(node: NodeEntity, relPath: string, unsupportedIn?: Set<string>): Promise<boolean> {
        if (this.stateDb.getSettings().paused || this.index.getByUid(node.uid)?.relPath !== relPath) {
            return false;
        }
        if (this.policy.hiddenBy(relPath)?.hide === 'hidden') {
            return true;
        }
        let children: NodeEntity[];
        try {
            children = await listFolderChildren(this.sdk, node);
        } catch (error: unknown) {
            this.logger.warn(`Could not list ${relPath} for the remote index: ${error}`);
            return false;
        }
        if (!this.recordListing(node, relPath, children)) {
            return false;
        }
        if (unsupportedIn && children.some((child) => entryFromNode(child, relPath) === null)) {
            unsupportedIn.add(relPath);
        }
        let complete = true;
        for (const child of children) {
            if (child.type === NodeType.Folder) {
                complete = (await this.indexRemoteSubtree(child, `${relPath}/${getName(child)}`, unsupportedIn)) && complete;
            }
        }
        return complete;
    }

    // Syncs a folder that is on this computer and, depth first, its subfolders that are too. Remote folders that aren't
    // here are added to `onlineOnly`, for the caller to crawl (or not) once the whole local pass is done.
    private async reconcileDirectoryIncremental(
        folderNode: NodeEntity,
        prefix: string,
        remoteMap: Map<string, NodeEntity>,
        _initialSettings: SyncSettings,
        since: number,
        onlineOnly: OnlineOnlyFolder[],
        failed: SyncFailure[] = [],
    ): Promise<void> {
        const liveSettings = this.stateDb.getSettings();
        if (liveSettings.paused) {
            return;
        }
        if (
            prefix &&
            (matchesIgnorePatterns(prefix, liveSettings.ignorePatterns) || this.policy.hiddenBy(prefix)?.hide === 'hidden')
        ) {
            return;
        }

        const localDirFullPath = prefix ? path.join(this.localRoot(), prefix) : this.localRoot();
        this.watcher.suppressPath(prefix || '.');
        await mkdir(localDirFullPath, { recursive: true });

        this.currentAction = `Listing /my-files/${prefix || ''}`;
        const remoteChildren = await listFolderChildren(this.sdk, folderNode);
        // Record the whole listing (ignored children too) before any child is reconciled
        this.recordListing(folderNode, prefix, remoteChildren);
        const freshSettings = this.stateDb.getSettings();
        const remoteChildByName = new Map<string, NodeEntity>();
        for (const child of remoteChildren) {
            const name = getName(child);
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (!matchesIgnorePatterns(relPath, freshSettings.ignorePatterns)) {
                remoteChildByName.set(name, child);
                remoteMap.set(relPath, child);
            }
        }

        const localEntries = await readdir(localDirFullPath, { withFileTypes: true }).catch(() => []);
        const localChildByName = new Map<string, { isDirectory: boolean; size: number; mtimeMs: number; ctimeMs: number }>();
        for (const entry of localEntries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (matchesIgnorePatterns(relPath, freshSettings.ignorePatterns)) {
                continue;
            }
            const fullPath = path.join(localDirFullPath, entry.name);
            const st = await stat(fullPath).catch(() => null);
            if (st && (st.isDirectory() || st.isFile())) {
                localChildByName.set(entry.name, {
                    isDirectory: st.isDirectory(),
                    size: st.isDirectory() ? 0 : st.size,
                    mtimeMs: st.mtimeMs,
                    ctimeMs: st.ctimeMs,
                });
            }
        }

        // Direct children previously tracked in DB under this prefix
        const allDbItems = this.stateDb.getAllItems();
        const dbChildByName = new Map<string, SyncedItemRecord>();
        for (const item of allDbItems) {
            const itemDir = path.posix.dirname(item.localRelPath);
            const expectedDir = prefix || '.';
            if (itemDir === expectedDir) {
                if (!matchesIgnorePatterns(item.localRelPath, freshSettings.ignorePatterns)) {
                    dbChildByName.set(path.posix.basename(item.localRelPath), item);
                }
            }
        }

        const childNames = Array.from(
            new Set([...remoteChildByName.keys(), ...localChildByName.keys(), ...dbChildByName.keys()]),
        ).sort((a, b) => a.localeCompare(b));

        const subFoldersToRecurse: Array<{ node: NodeEntity; relPath: string }> = [];

        for (const name of childNames) {
            const stepSettings = this.stateDb.getSettings();
            if (stepSettings.paused) {
                return;
            }
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (matchesIgnorePatterns(relPath, stepSettings.ignorePatterns)) {
                continue;
            }
            if (this.policy.hiddenBy(relPath)?.hide === 'hidden') {
                continue; // Skipped entirely: not downloaded, uploaded or trashed, and its listing is not fetched
            }
            if (this.syncingFolders.has(relPath)) {
                // Being synced on its own right now (just pinned); avoid concurrent duplicate work
                continue;
            }
            if (this.awaitsRemoteOp(relPath, remoteChildByName.get(name)?.uid)) {
                continue; // Nor what is in it: a rename, move or delete through the drive is on its way to Proton Drive
            }

            const backingOff = this.failingItems.get(relPath);
            if (backingOff && Date.now() < backingOff.retryAt) {
                failed.push({ relPath, message: backingOff.message }); // Still failing, as far as this pass knows
                continue;
            }

            this.currentAction = `Syncing ${relPath}`;
            const remoteChild = remoteChildByName.get(name);
            const localChild = localChildByName.get(name);
            const dbRecord = dbChildByName.get(name);

            try {
                await this.reconcileSinglePath(relPath, remoteChild, localChild, dbRecord, remoteMap, stepSettings, since);
            } catch (error: unknown) {
                this.itemFailed(relPath, error, failed);
                continue; // Nor what is in it, this pass
            }

            const resolvedFolderNode = remoteMap.get(relPath) ?? remoteChild;
            const localStillExists = await stat(path.join(this.localRoot(), relPath))
                .then((s) => s.isDirectory())
                .catch(() => false);
            if (resolvedFolderNode && resolvedFolderNode.type === NodeType.Folder && localStillExists) {
                subFoldersToRecurse.push({ node: resolvedFolderNode, relPath }); // Its failure is forgotten once listed
                continue;
            }
            this.forgetFailure(relPath);
            if (resolvedFolderNode && resolvedFolderNode.type === NodeType.Folder) {
                onlineOnly.push({ node: resolvedFolderNode, relPath });
            }
        }

        for (const sub of subFoldersToRecurse) {
            const nextSettings = this.stateDb.getSettings();
            if (nextSettings.paused) {
                return;
            }
            if (
                matchesIgnorePatterns(sub.relPath, nextSettings.ignorePatterns) ||
                this.policy.hiddenBy(sub.relPath)?.hide === 'hidden'
            ) {
                continue;
            }
            try {
                await this.reconcileDirectoryIncremental(sub.node, sub.relPath, remoteMap, nextSettings, since, onlineOnly, failed);
            } catch (error: unknown) {
                this.itemFailed(sub.relPath, error, failed); // Its listing, say: nothing in it is looked at this pass
                continue;
            }
            this.forgetFailure(sub.relPath);
        }
    }

    // An item a sync pass couldn't sync (#18): marked as failed, logged, and left for the next pass to try again, while
    // this one goes on with the rest. Nothing is decided about it, or about what is in it, this pass. A failure of the
    // network or the server (offline, a 5xx, a rate limit) would fail every item alike: it ends the pass, as before. A
    // refusal of this one request (see permanentRefusal and unmappedApiCode) is this item's failure: an outage ends the
    // pass all the same, as the SDK answers with a plain ServerError once its requests keep failing.
    private itemFailed(relPath: string, error: unknown, failed: SyncFailure[]): void {
        if (isTransient(error) && !permanentRefusal(error) && !unmappedApiCode(error)) {
            throw error;
        }
        const message = messageOf(error);
        const failures = (this.failingItems.get(relPath)?.failures ?? 0) + 1;
        const waitMs = Math.min(2 ** (failures - 1) * 60_000, MAX_ITEM_BACKOFF_MS);
        this.failingItems.set(relPath, { message, failures, retryAt: Date.now() + waitMs });
        this.logger.warn(`Could not sync ${relPath}; trying again in ${Math.round(waitMs / 60_000)} min: ${message}`);
        if (this.stateDb.getItemByPath(relPath)) {
            this.stateDb.setItemStatus(relPath, 'error', message);
        }
        this.logFailureOnce(relPath, message, `Could not sync: ${message}; trying again later`);
        failed.push({ relPath, message });
    }

    // An item's failure goes to the activity log once, until its error changes: one that keeps failing pass after
    // pass would otherwise fill the log
    private logFailureOnce(relPath: string, message: string, details: string): void {
        if (this.loggedFailures.get(relPath) === message) {
            return;
        }
        this.loggedFailures.set(relPath, message);
        this.stateDb.logActivity({ action: 'error', localRelPath: relPath, details });
    }

    private forgetFailure(relPath: string): void {
        this.loggedFailures.delete(relPath);
        this.failingItems.delete(relPath);
    }
}

// An item a sync pass couldn't sync, and why (see itemFailed)
interface SyncFailure {
    relPath: string;
    message: string;
}

// What is missing while held (see stillMissing)
interface MissingItems {
    names: string[];
    items: number;
    whole: boolean;
}

// What the status says while held (see filesMissing)
export interface FilesMissingStatus {
    root: string;
    names: string[];
    items: number;
    message: string;
}

// What one removal of local copies took away: paths whose records it dropped, and whole subtrees it moved away (a move
// can't list everything in them: an ignored node_modules can be huge).
interface TakenAway {
    paths: Set<string>;
    subtrees: Set<string>;
    // For a rename or delete through the drive: where the subtree went (null when deleted, or replaced by the user)
    drive?: DriveChange;
}

interface DriveChange {
    from: string;
    to: string | null;
}

// The state database as it was before a local move or replacement (see snapshotLocalStep)
interface LocalStepSnapshot {
    paths: string[];
    records: SyncedItemRecord[];
    ops: unknown[];
    indexRoots: string[];
    index: RemoteIndexEntry[];
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whether the promise settled within ms; its timer never outlives it
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// A path from the virtual drive as a path of My files: no slash at either end, and no empty, '.' or '..' segment, so
// it can't climb out of it.
export type Transfer = 'syncing' | 'error' | 'conflict' | null;
export interface ItemState {
    availability: 'pinned' | 'downloaded' | 'partial' | 'online-only';
    transfer: Transfer;
}
export interface FolderStates {
    self: ItemState | null; // null for the root
    children: Record<string, ItemState | null>; // null: no emblem (a local item matching an ignore pattern)
}

const TRANSFER_RANK: Record<string, number> = { syncing: 1, error: 2, conflict: 3 };

// A conflict shows over an error, and an error over a transfer under way
function worseTransfer(a: Transfer, b: Transfer): Transfer {
    return (b ? TRANSFER_RANK[b] : 0) > (a ? TRANSFER_RANK[a] : 0) ? b : a;
}

function childRel(parentRel: string, name: string): string {
    return parentRel === '' ? name : `${parentRel}/${name}`;
}

function normalizeDrivePath(relPath: string): string {
    const trimmed = relPath.replace(/^\/+|\/+$/g, '');
    if (trimmed.includes('\0') || trimmed.split('/').some((s) => s === '.' || s === '..' || (s === '' && trimmed !== ''))) {
        throw new Error(`Invalid path: ${relPath}`);
    }
    return trimmed;
}

function isProvisional(uid: string): boolean {
    return uid.startsWith(PROVISIONAL);
}

// Whether a node's latest pending operation takes it away from where its index entry is: deleted, or moved elsewhere
function takesAway(op: RemoteOp | undefined, entry: RemoteIndexEntry): boolean {
    return op !== undefined && (op.kind === 'trash' || op.toPath !== entry.relPath);
}

// Why the file system step of a local move failed, as a drive operation error where its errno means something to the
// drive (null is something having taken toRel since the look at it)
function driveOpErrorOf(failure: unknown, toRel: string): unknown {
    const code = (failure as NodeJS.ErrnoException | null)?.code;
    if (failure === null || code === 'EEXIST' || code === 'ENOTEMPTY') {
        return new DriveOpError('EEXIST', `Already exists: ${toRel}`, { cause: failure ?? undefined });
    }
    if (code === 'ENOENT') {
        return new DriveOpError('ENOENT', messageOf(failure), { cause: failure });
    }
    return failure;
}

// Whether nothing has written to a file since the content its record holds was read, by its ctime, which the system
// sets on every write (unlike the mtime, which cp -p, touch -r or an encrypted container can put back). Measured from
// when the content was read, not when the record was written, as a write in between (during an upload, say) is one the
// record knows nothing of (#109). The system's ctime may run up to a clock tick behind (CTIME_TICK_MS): a write that
// close to the read counts as one after it. Without a ctime or a read time it can't be told, which counts as written:
// the caller then compares contents (#105).
function notWrittenSince(local: { ctimeMs?: number }, record: SyncedItemRecord): boolean {
    const readAt = record.contentReadAt;
    return local.ctimeMs !== undefined && readAt !== null && readAt !== undefined && local.ctimeMs + CTIME_TICK_MS < readAt;
}
const CTIME_TICK_MS = 20;

// The read time for a file just placed by a download: the ctime its placing gave it, as seen at once after, so that
// what placed it isn't taken for a write after (which would have the watcher upload the download back). Just above it
// (notWrittenSince then holds for a ctime no newer than the one seen, and not for any later one, however close): only
// a write within the same clock tick as that stat, keeping the size and the old mtime, is left unseen. Without that
// ctime, the time before placing, which has the next look hash the file once
function placedReadAt(placedCtimeMs: number | undefined, readFrom: number): number {
    return placedCtimeMs === undefined ? readFrom : Math.max(readFrom, placedCtimeMs + CTIME_TICK_MS + PLACED_CTIME_EPSILON_MS);
}
// Above the rounding of a ctime in ms at today's dates (about 0.0002 ms), below any later ctime the system gives
const PLACED_CTIME_EPSILON_MS = 0.001;

// Whether a local file differs from its record by size or time (as a pass's fast path tells), or has none: an upload
// is what it would come to
function changedSinceRecord(local: { size: number; mtimeMs: number }, record: SyncedItemRecord | null | undefined): boolean {
    return !record || local.size !== record.size || Math.abs(local.mtimeMs - record.localMtimeMs) >= 10;
}

// The node an index entry stands for; none for a provisional one
function nodeUidOf(entry: RemoteIndexEntry | null): string | null {
    return entry && !isProvisional(entry.uid) ? entry.uid : null;
}

function parentOf(relPath: string): string {
    const slash = relPath.lastIndexOf('/');
    return slash === -1 ? '' : relPath.slice(0, slash);
}

// How many folders down a path is: a folder's path is less deep than anything in it
function depthOf(relPath: string): number {
    return relPath.split('/').length;
}

function joinRel(parentRel: string, name: string): string {
    return parentRel === '' ? name : `${parentRel}/${name}`;
}

function isWithin(relPath: string, dir: string): boolean {
    return relPath === dir || relPath.startsWith(`${dir}/`);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// A version of a cloud file, as its active revision claims it: its SHA1 (null when the uploader gave none), modified
// time and size
interface CloudVersion {
    sha1: string | null;
    mtimeMs: number;
    size: number;
}

// Whether the cloud's file has changed since a version of it seen before: what the drive showed (an edit baseline), or
// what a record says it held. Two checksums decide it alone. A missing checksum never makes it the same (#24): then the
// checksums, the time and the size must all match.
function cloudChangedSince(seen: CloudVersion, now: CloudVersion): boolean {
    if (seen.sha1 !== null && now.sha1 !== null) {
        return now.sha1 !== seen.sha1;
    }
    return now.sha1 !== seen.sha1 || now.mtimeMs !== seen.mtimeMs || now.size !== seen.size;
}

// A record for a file only the remote index knows (online-only), as replaced through the drive: its node, and what the
// cloud holds, so the new local content reads as an edit of it
function recordFromIndexEntry(entry: RemoteIndexEntry, relPath: string): Omit<SyncedItemRecord, 'updatedAt'> {
    return {
        localRelPath: relPath,
        nodeUid: entry.uid,
        parentNodeUid: entry.parentUid,
        type: 'file',
        localSha1: null,
        remoteSha1: entry.sha1,
        localMtimeMs: 0,
        remoteMtimeMs: entry.mtimeMs,
        size: entry.size,
        syncStatus: 'synced',
        lastError: null,
    };
}

function isTakenAway(takenAway: TakenAway, relPath: string): boolean {
    if (takenAway.paths.has(relPath)) {
        return true;
    }
    for (const subtree of takenAway.subtrees) {
        if (relPath === subtree || relPath.startsWith(`${subtree}/`)) {
            return true;
        }
    }
    return false;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}
