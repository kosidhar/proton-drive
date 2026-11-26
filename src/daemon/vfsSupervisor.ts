import {
    accessSync,
    chmodSync,
    closeSync,
    constants,
    fchmodSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeSync,
    type Stats,
} from 'node:fs';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import type { DriveLayout } from '../sync/driveMode';
import { makeUserFolder } from '../sync/layoutMigration';
import { mergeInto } from '../sync/localMerge';
import { localPathIn } from '../sync/localPath';
import { canonicalPath, mountsAt, mountsUnder, pathsOverlap, readMountInfo } from '../sync/mountPoint';

export { mountsAt } from '../sync/mountPoint';

// Runs protondrive-vfs, which mounts the drive at the sync folder: readies the mount point (a mount left by an earlier
// session is unmounted, files saved into the bare folder are merged into the backing store), restarts a crashed
// helper, and unmounts on shutdown. While unmounted the mount point is 0555, so nothing new lands in it.

// different-disk: the sync folder is on another disk than the backing store, so its files can't move there by renames;
// moving: files are moving between the sync folder and the backing store; move-failed: that move stopped (see error)
export type VfsReason =
    | 'ejected'
    | 'crashed'
    | 'fuse-unavailable'
    | 'switched-off'
    | 'starting'
    | 'mount-point-busy'
    | 'different-disk'
    | 'moving'
    | 'move-failed'
    | null;

export interface VfsStatus {
    mode: 'virtual' | 'plain';
    mounted: boolean;
    reason: VfsReason;
    error?: string; // why the move stopped, with move-failed
    move?: DriveMove; // a move that stopped, and what can be done about it (POST /drive/move on the control socket)
}

// finish: complete a layout move toward where it was going; move-back: move the files back where they came from;
// retry: try a move that failed again (a relocation, or a move into the drive that was undone)
export type DriveMoveAction = 'finish' | 'move-back' | 'retry';

// A move that stopped: a relocation of the sync folder, or files moving between the sync folder and the drive's store
// (from and to are the folders the files are moving between), with the error and the actions available now
export interface DriveMove {
    kind: 'relocation' | 'layout';
    from: string;
    to: string;
    error: string | null;
    actions: DriveMoveAction[];
}

export interface VfsTiming {
    restartDelaysMs: readonly number[]; // one per restart; a crash after the last one, within the window, is final
    crashWindowMs: number;
    unmountWaitMs: number; // for a lazy unmount to leave mountinfo
    stopWaitMs: number; // for the helper to exit at shutdown, and again after each signal
    mountPollMs: number; // first look for the new mount; it doubles up to 2 s
    mountTimeoutMs: number; // a helper whose mount hasn't shown by then is killed, and counted as a crash
    nudgeWaitMs: number; // for the nudge's mount to show (see nudge)
}

export const DEFAULT_VFS_TIMING: VfsTiming = {
    restartDelaysMs: [1000, 5000, 30_000],
    crashWindowMs: 5 * 60_000,
    unmountWaitMs: 2000,
    stopWaitMs: 2000,
    mountPollMs: 100,
    mountTimeoutMs: 30_000,
    nudgeWaitMs: 5000,
};

// FSName and Subtype "protondrive": how our own mounts show in mountinfo
const OUR_FSTYPE = 'fuse.protondrive';
const LOG_ROTATE_BYTES = 1024 * 1024;

type HelperProcess = Pick<ReturnType<typeof Bun.spawn>, 'exited' | 'exitCode' | 'signalCode' | 'kill' | 'pid'>;

export interface VfsSupervisorOptions {
    mountpoint: string;
    backingDir: string;
    appDir: string; // the drive must never mount over it, or over a folder holding it
    socketPath: string;
    helperPath: string;
    logPath: string; // the helper's stdout and stderr: <appDir>/vfs.log
    logger: Logger;
    mergeStray(fullPath: string): Promise<void>;
    // Called as each helper starts (a restart after a crash, and Mount again, included): a new helper has no file open
    // for writing, so the daemon forgets the files the last one said were (#64; see ProtonDriveSyncEngine.driveWriting)
    onHelperStart?: () => void;
    spawn?: typeof Bun.spawn;
    // Runs a command (fusermount3) and answers its exit code; it warns of a failure itself unless asked to be quiet
    run?: (cmd: string[], opts?: { quiet?: boolean }) => Promise<number>;
    // Seams for tests: the text of /proc/self/mountinfo (read as latin1), and stat of the mount point
    readMountInfo?: () => string;
    stat?: (p: string) => Stats;
    timing?: Partial<VfsTiming>;
    // Nudge the desktop's mount monitors each time the drive mounts (#49; see nudge). The daemon asks for it; tests
    // that don't ask see only the drive's own helper and commands.
    nudge?: boolean;
}

function errnoOf(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException | null)?.code;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isExecutableFile(p: string): boolean {
    try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

function onPath(name: string): string | null {
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir && isExecutableFile(path.join(dir, name))) return path.join(dir, name);
    }
    return null;
}

// The helper: $PROTON_DRIVE_VFS_BIN, else next to the running binary (the compiled protondrive's own path, symlinks
// resolved; under `bun run` that is bun's folder), else on PATH
export function findHelper(): string | null {
    const fromEnv = process.env.PROTON_DRIVE_VFS_BIN;
    if (fromEnv) return fromEnv;
    const besideUs = path.join(path.dirname(process.execPath), 'protondrive-vfs');
    if (isExecutableFile(besideUs)) return besideUs;
    return onPath('protondrive-vfs');
}

// /dev/fuse readable and writable, fusermount3 on PATH, and the helper executable
export function fuseAvailable(helperPath: string | null): boolean {
    if (!helperPath || !isExecutableFile(helperPath)) return false;
    try {
        accessSync('/dev/fuse', constants.R_OK | constants.W_OK);
    } catch {
        return false;
    }
    return onPath('fusermount3') !== null;
}

// Why POST /vfs/mount has nothing to mount, from the status worked out at start
export function notMountableReason(status: VfsStatus): string {
    switch (status.reason) {
        case 'switched-off':
            return 'The virtual drive is switched off: Proton Drive is a plain folder';
        case 'fuse-unavailable':
            return "The virtual drive can't run: FUSE or protondrive-vfs isn't available on this system";
        case 'mount-point-busy':
            return "The virtual drive can't run: the daemon's control socket is unavailable";
        case 'different-disk':
            return "The virtual drive can't run: the Proton Drive folder is on another disk than the app's data";
        case 'moving':
            return 'Proton Drive is busy moving files';
        case 'move-failed':
            return `Moving the files failed: ${status.error ?? 'unknown error'}${status.move ? ` (what can be done: ${status.move.actions.join(', ')})` : ''}`;
        default:
            return "Proton Drive is a plain folder: its files haven't moved into the virtual drive";
    }
}

// What /api/status says when no supervisor runs, worked out once at start
export function unsupervisedStatus(layout: DriveLayout, wanted: boolean, fuseOk: boolean): VfsStatus {
    if (layout === 'virtual') return { mode: 'virtual', mounted: false, reason: 'fuse-unavailable' };
    return { mode: 'plain', mounted: false, reason: !wanted ? 'switched-off' : !fuseOk ? 'fuse-unavailable' : null };
}

// Moves an entry found in the bare mount point to the same place in the backing store, where the engine picks it up
// as a new local file. Nothing is ever replaced: a folder already in the store is merged into, and an entry whose
// name is taken there gets a conflict name. Answers where conflict-named entries went. Throws when something can't be
// moved; what wasn't moved stays put. beforeRmdir is for tests: it runs as an emptied stray folder is about to go.
export function mergeStrayInto(
    strayPath: string,
    mountpoint: string,
    backingDir: string,
    now = new Date(),
    beforeRmdir?: (folder: string) => void,
): string[] {
    const rel = path.relative(mountpoint, strayPath);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`${strayPath} isn't inside ${mountpoint}`);
    }
    return mergeInto(strayPath, localPathIn(backingDir, rel), { now, beforeRmdir });
}

// Runs a command, killed after 10 s, and answers its exit code. A failure is logged with what the command said, unless
// `quiet` (its caller says it all in one line).
export async function runCommand(cmd: string[], logger: Logger, opts: { quiet?: boolean } = {}): Promise<number> {
    const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    try {
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (code !== 0 && !opts.quiet) logger.warn(`${cmd.join(' ')} failed (${code}): ${stderr.trim()}`);
        return code;
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What the promise answered within ms, or undefined; its timer never outlives it
async function answerWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
    } finally {
        clearTimeout(timer);
    }
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

export class VfsSupervisor {
    private readonly timing: VfsTiming;
    private readonly spawn: typeof Bun.spawn;
    private readonly run: (cmd: string[], opts?: { quiet?: boolean }) => Promise<number>;
    private readonly readMountInfo: () => string;
    private readonly stat: (p: string) => Stats;
    private readonly logger: Logger;

    private proc: HelperProcess | null = null;
    private state: { mounted: boolean; reason: VfsReason } = { mounted: false, reason: 'starting' };
    private crashTimes: number[] = [];
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private stopping = false;
    // Starting, restarting, mounting again and stopping run one at a time, in order
    private queue: Promise<unknown> = Promise.resolve();
    // The nudge running now (never two at once), and whether the drive mounted again meanwhile, which takes one more
    private nudging: Promise<void> | null = null;
    private nudgeAgain = false;

    constructor(private readonly opts: VfsSupervisorOptions) {
        this.timing = { ...DEFAULT_VFS_TIMING, ...opts.timing };
        this.logger = opts.logger;
        this.spawn = opts.spawn ?? Bun.spawn;
        this.run = opts.run ?? ((cmd, runOpts) => runCommand(cmd, this.logger, runOpts));
        this.readMountInfo = opts.readMountInfo ?? readMountInfo;
        this.stat = opts.stat ?? ((p) => statSync(p));
    }

    status(): VfsStatus {
        return { mode: 'virtual', ...this.state };
    }

    // Readies the mount point, then starts the helper; never throws (the status says what went wrong)
    async start(): Promise<void> {
        this.stopping = false;
        await this.serially(async () => {
            if (this.proc) return;
            this.clearRestart();
            this.crashTimes = [];
            await this.launch();
        }).catch((err: unknown) => {
            this.logger.error(`Could not start the drive: ${messageOf(err)}`);
        });
    }

    // Eject, a crash streak or a busy mount point leave the drive unmounted until the user asks again. Throws when
    // the mount point can't be readied, saying why, and after stop() (the daemon is shutting down).
    async mountAgain(): Promise<void> {
        await this.serially(async () => {
            if (this.stopping) throw new Error('The drive is stopping');
            if (this.proc) return;
            this.clearRestart();
            this.crashTimes = [];
            const refusal = await this.launch();
            if (refusal) throw new Error(refusal);
        });
    }

    // Unmounts and waits, bounded, for the helper to exit, killing it if it won't
    async stop(): Promise<void> {
        this.stopping = true;
        this.clearRestart();
        await this.serially(() => this.shutdown()).catch((err: unknown) => {
            this.logger.error(`Could not stop the drive cleanly: ${messageOf(err)}`);
        });
        // A nudge on its way is bounded, and ends with nothing mounted
        await this.nudging;
    }

    // Unmounts the drive and leaves it unmounted, whether this session's helper or an earlier one mounted it: the files
    // are about to move out of the backing store into the bare folder. Answers why something is still mounted there
    // (a mount that isn't ours, or one that won't go), or null.
    async release(): Promise<string | null> {
        await this.stop();
        return this.serially(() => this.clearOurMounts()).catch((err: unknown) => messageOf(err));
    }

    private serially<T>(task: () => Promise<T>): Promise<T> {
        const next = this.queue.then(task, task);
        this.queue = next.catch(() => {});
        return next;
    }

    // Where the helper mounts (it canonicalizes too), what mountinfo shows and what fusermount3 needs: fusermount3
    // resolves only the parent, so a symlinked sync folder's own path is never found in mtab
    private realMountpoint(): string {
        return canonicalPath(this.opts.mountpoint);
    }

    // The drive mounted over its own store, or over a folder holding it, would hide and then merge the store into
    // itself
    private overlapsAppFiles(): string | null {
        for (const dir of [this.opts.appDir, this.opts.backingDir]) {
            if (pathsOverlap(this.opts.mountpoint, dir)) {
                return `The drive folder ${this.opts.mountpoint} overlaps ${dir}; not mounting the drive`;
            }
        }
        return null;
    }

    private mounts(): string[] {
        return mountsAt(this.readMountInfo(), this.realMountpoint());
    }

    private statErrno(): string | null {
        try {
            this.stat(this.opts.mountpoint);
            return null;
        } catch (err) {
            return errnoOf(err) ?? 'EIO';
        }
    }

    private async unmount(): Promise<void> {
        const cmd = ['fusermount3', '-u', '-z', this.realMountpoint()];
        try {
            await settlesWithin(this.run(cmd), this.timing.unmountWaitMs);
        } catch (err) {
            this.logger.warn(`${cmd.join(' ')} failed: ${messageOf(err)}`);
        }
    }

    private async waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
        const end = Date.now() + ms;
        while (!cond()) {
            if (Date.now() >= end) return false;
            await sleep(Math.min(50, this.timing.mountPollMs));
        }
        return true;
    }

    // Unmounts our own mounts at the mount point, live (an orphaned helper's) or dead ("Transport endpoint is not
    // connected"). Answers why the mount point can't be used, or null once nothing is mounted there. A mount that
    // isn't ours is never touched.
    private async clearOurMounts(): Promise<string | null> {
        for (let attempt = 0; ; attempt++) {
            const at = this.mounts();
            const foreign = at.find((fstype) => fstype !== OUR_FSTYPE);
            if (foreign !== undefined) {
                return `Something else (${foreign}) is mounted at ${this.opts.mountpoint}; leaving it alone and not mounting the drive`;
            }
            if (at.length === 0) break;
            if (attempt === 3) return `The drive left mounted at ${this.opts.mountpoint} could not be unmounted`;
            this.logger.info(`Unmounting the drive left mounted at ${this.opts.mountpoint}`);
            await this.unmount();
            await this.waitUntil(() => this.mounts().length < at.length, this.timing.unmountWaitMs);
        }
        // A dead mount mountinfo didn't show us at this path
        if (this.statErrno() === 'ENOTCONN') {
            this.logger.info(`Unmounting the dead mount at ${this.opts.mountpoint}`);
            await this.unmount();
            if (this.statErrno() === 'ENOTCONN') {
                return `${this.opts.mountpoint} is a dead mount ("Transport endpoint is not connected") that could not be unmounted`;
            }
        }
        return null;
    }

    // Answers why the drive can't be mounted, or null when the mount point is ready: free of mounts, a folder, empty
    private async prepare(): Promise<string | null> {
        const overlap = this.overlapsAppFiles();
        if (overlap) return overlap;
        const blocked = await this.clearOurMounts();
        if (blocked) return blocked;
        const mountpoint = this.opts.mountpoint;
        let st: Stats;
        try {
            st = this.stat(mountpoint);
        } catch (err) {
            if (errnoOf(err) !== 'ENOENT') return `Can't use ${mountpoint}: ${messageOf(err)}`;
            makeUserFolder(mountpoint);
            chmodSync(mountpoint, 0o700);
            return null;
        }
        if (!st.isDirectory()) return `${mountpoint} isn't a folder; not mounting the drive`;
        let strays = readdirSync(mountpoint);
        if (strays.length === 0) return null;
        // Saved into the bare folder while the drive wasn't mounted: a mount would hide them. Moving them out needs
        // write access to the folder, so an app may save one more meanwhile: a second round takes it.
        chmodSync(mountpoint, 0o700);
        for (let round = 0; round < 3 && strays.length > 0; round++) {
            for (const name of strays) {
                const full = path.join(mountpoint, name);
                try {
                    await this.opts.mergeStray(full);
                } catch (err) {
                    return `Could not move ${full} into the drive's store (${messageOf(err)}); not mounting over it`;
                }
                this.logger.info(`Moved ${full}, saved while the drive wasn't mounted, into the drive's store`);
            }
            strays = readdirSync(mountpoint);
        }
        if (strays.length > 0) return `${path.join(mountpoint, strays[0]!)} is still in the drive folder; not mounting over it`;
        return null;
    }

    // Answers why the drive wasn't mounted, or null once the helper runs
    private async launch(): Promise<string | null> {
        this.state = { mounted: false, reason: 'starting' };
        let refusal: string | null;
        try {
            refusal = await this.prepare();
        } catch (err) {
            refusal = `Could not ready ${this.opts.mountpoint}: ${messageOf(err)}`;
        }
        if (refusal) {
            this.logger.error(refusal);
            this.state = { mounted: false, reason: 'mount-point-busy' };
            this.restoreReadOnly();
            return refusal;
        }
        try {
            // fusermount3 needs write access to the mount point
            chmodSync(this.opts.mountpoint, 0o700);
            this.proc = this.spawnHelper();
        } catch (err) {
            this.logger.error(`Could not start ${this.opts.helperPath}: ${messageOf(err)}`);
            this.restoreReadOnly();
            this.scheduleRestart();
            return null;
        }
        try {
            this.opts.onHelperStart?.();
        } catch (err) {
            this.logger.warn(`Could not forget the files open for writing through the last drive helper: ${messageOf(err)}`);
        }
        const proc = this.proc;
        void proc.exited
            .then(() => this.serially(() => this.onExit(proc)))
            .catch((err: unknown) => {
                this.logger.error(`Handling the drive helper's exit failed: ${messageOf(err)}`);
            });
        this.watchForMount(proc);
        return null;
    }

    private spawnHelper(): HelperProcess {
        const { logPath, helperPath, mountpoint, backingDir, socketPath } = this.opts;
        // A file, never a pipe: a daemon too busy to drain a pipe would block the helper mid-reply, and with it every
        // app waiting on the drive
        try {
            if (statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, `${logPath}.1`);
        } catch {
            // no log yet
        }
        const fd = openSync(logPath, 'a', 0o600);
        try {
            fchmodSync(fd, 0o600); // it names the user's files, and may predate this mode
            writeSync(fd, `--- ${new Date().toISOString()} starting protondrive-vfs on ${mountpoint}\n`);
            return this.spawn([helperPath, '--mountpoint', mountpoint, '--backing', backingDir, '--socket', socketPath], {
                stdin: 'ignore',
                stdout: fd,
                stderr: fd,
            });
        } finally {
            closeSync(fd); // the helper has its own copy
        }
    }

    // Until the mount shows, or the bound passes: a helper still alive then, with nothing mounted (stuck, say, before
    // or in its mount), is killed, and its exit is a crash like any other (restarted, or crashed after a streak), so
    // the drive never stays starting for ever
    private watchForMount(proc: HelperProcess): void {
        let delay = this.timing.mountPollMs;
        const giveUpAt = Date.now() + this.timing.mountTimeoutMs;
        const look = () => {
            this.pollTimer = null;
            if (proc !== this.proc) return;
            if (this.mounts().includes(OUR_FSTYPE)) {
                this.state = { mounted: true, reason: null };
                this.logger.info(`Mounted the drive at ${this.opts.mountpoint}`);
                this.nudge();
                return;
            }
            const left = giveUpAt - Date.now();
            if (left <= 0) {
                this.logger.error(
                    `protondrive-vfs didn't mount the drive at ${this.opts.mountpoint} within ${Math.round(this.timing.mountTimeoutMs / 1000)} s; stopping it`,
                );
                proc.kill('SIGKILL'); // its exit (onExit) is the crash
                return;
            }
            delay = Math.min(delay * 2, 2000, left);
            this.pollTimer = setTimeout(look, delay);
        };
        this.pollTimer = setTimeout(look, delay);
    }

    private async onExit(proc: HelperProcess): Promise<void> {
        if (proc !== this.proc) return; // stop() has dealt with it
        this.proc = null;
        this.clearPoll();
        if (this.stopping) return;
        const ejected = proc.exitCode === 0;
        this.state = { mounted: false, reason: ejected ? 'ejected' : 'starting' };
        if (ejected) {
            this.logger.info(`The drive at ${this.opts.mountpoint} was ejected`);
        } else {
            const how = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${proc.exitCode}`;
            this.logger.warn(`protondrive-vfs stopped (${how}); see ${this.opts.logPath}`);
        }
        // A helper that died leaves its mount behind, dead
        const blocked = await this.clearOurMounts();
        if (blocked) this.logger.warn(blocked);
        this.restoreReadOnly();
        if (ejected) {
            this.state = { mounted: false, reason: 'ejected' };
        } else {
            this.scheduleRestart();
        }
    }

    // Exit code 2 (the mount failed), any other code or a signal: restart after 1 s, 5 s, then 30 s; one more crash
    // within the window and the drive stays down until the user asks
    private scheduleRestart(): void {
        if (this.stopping) return;
        const now = Date.now();
        this.crashTimes = this.crashTimes.filter((t) => now - t < this.timing.crashWindowMs);
        const delay = this.timing.restartDelaysMs[this.crashTimes.length];
        if (delay === undefined) {
            this.logger.error(`protondrive-vfs keeps crashing; the drive stays unmounted until Mount again`);
            this.state = { mounted: false, reason: 'crashed' };
            return;
        }
        this.crashTimes.push(now);
        this.state = { mounted: false, reason: 'starting' };
        this.clearRestart();
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.serially(async () => {
                if (this.stopping || this.proc) return;
                await this.launch();
            }).catch((err: unknown) => {
                this.logger.error(`Restarting the drive failed: ${messageOf(err)}`);
            });
        }, delay);
    }

    private async shutdown(): Promise<void> {
        this.clearRestart();
        this.clearPoll();
        const proc = this.proc;
        if (proc) {
            const at = this.mounts();
            // fusermount3 takes the top mount, which must be ours
            if (at.length > 0 && at.every((fstype) => fstype === OUR_FSTYPE)) await this.unmount();
            const exited = () => settlesWithin(proc.exited, this.timing.stopWaitMs);
            if (!(await exited())) {
                // A lazy unmount lingers while an app holds a file open in the drive
                proc.kill('SIGTERM');
                if (!(await exited())) {
                    proc.kill('SIGKILL');
                    await exited();
                }
            }
            this.proc = null;
            const blocked = await this.clearOurMounts();
            if (blocked) this.logger.warn(blocked);
        }
        this.restoreReadOnly();
        this.state = { mounted: false, reason: null };
    }

    // 0555 while unmounted, so apps can't save into the bare folder. Never through a mount: on ours it would change
    // the backing store, on another it isn't ours to change.
    private restoreReadOnly(): void {
        if (this.mounts().length > 0 || this.overlapsAppFiles()) return;
        try {
            if (!this.stat(this.opts.mountpoint).isDirectory()) return;
            chmodSync(this.opts.mountpoint, 0o555);
        } catch (err) {
            if (errnoOf(err) !== 'ENOENT') this.logger.warn(`Could not make ${this.opts.mountpoint} read-only: ${messageOf(err)}`);
        }
    }

    // #49: GLib's mount monitor (GUnixMountMonitor) misses the attach of a FUSE mount made through fusermount3, though
    // the kernel signals it, and sees only detaches; so Files (through gvfs's volume monitors) showed the drive in its
    // sidebar only at the next mount change anywhere, minutes later. A detach makes every monitor look again, and find
    // the drive. So once the drive shows mounted, the same helper mounts a tiny private drive at a hidden path in the
    // control socket's own dir (GLib never shows a mount under a dot folder), with an empty store and no daemon to ask
    // (the helper doesn't need one), and it is unmounted at once. Best effort: every step is bounded, it always ends
    // unmounted with its folders removed, it never touches the drive or holds up its status, and a failure is logged
    // once. Never two at once: a mount meanwhile takes one more after it.
    private nudge(): void {
        if (!this.opts.nudge) return;
        if (this.nudging) {
            this.nudgeAgain = true;
            return;
        }
        const run = async () => {
            try {
                do {
                    this.nudgeAgain = false;
                    const problem = await this.nudgeOnce().catch((err: unknown) => messageOf(err));
                    if (problem) this.logger.warn(`Could not nudge Files to show the drive in its sidebar (it may show there late): ${problem}`);
                } while (this.nudgeAgain && !this.stopping);
            } finally {
                this.nudging = null; // in the same step as the last look at nudgeAgain, so no mount is missed
            }
        };
        this.nudging = run();
    }

    // One nudge; answers what went wrong, or null
    private async nudgeOnce(): Promise<string | null> {
        const dir = path.join(canonicalPath(path.dirname(this.opts.socketPath)), '.nudge');
        const at = path.join(dir, 'mnt');
        const store = path.join(dir, 'store');
        for (const ours of [this.opts.mountpoint, this.opts.appDir, this.opts.backingDir]) {
            if (pathsOverlap(dir, ours)) return `${dir} overlaps ${ours}`;
        }
        const mountedIn = () => mountsUnder(this.readMountInfo(), dir);
        // A nudge cut short (the daemon killed meanwhile) may have left its mount, which goes first; anything else
        // mounted there is left alone, and stops the nudge
        const left = mountedIn();
        const foreign = left.find(([p, fstype]) => p !== at || fstype !== OUR_FSTYPE);
        if (foreign) return `something else (${foreign[1]}) is mounted at ${foreign[0]}`;
        if (left.length > 0) await this.unmountNudge(at, true);
        if (mountedIn().length > 0) return `${at} is still mounted`;
        const problems: string[] = [];
        let proc: HelperProcess | null = null;
        try {
            // Made afresh, so it is a private folder of ours with an empty store (a link there is removed, not followed)
            rmSync(dir, { recursive: true, force: true });
            for (const folder of [dir, at, store]) {
                mkdirSync(folder, { mode: 0o700 });
                chmodSync(folder, 0o700);
            }
            proc = this.spawn([this.opts.helperPath, '--mountpoint', at, '--backing', store, '--socket', path.join(dir, 'no-daemon.sock')], {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
            });
            const helper = proc;
            const alive = () => helper.exitCode === null && helper.signalCode === null;
            const shown = () => mountsAt(this.readMountInfo(), at).includes(OUR_FSTYPE);
            await this.waitUntil(() => shown() || !alive(), this.timing.nudgeWaitMs);
            if (!shown()) {
                problems.push(
                    alive()
                        ? `its mount didn't show within ${Math.round(this.timing.nudgeWaitMs / 1000)} s`
                        : `protondrive-vfs stopped (${helper.signalCode ? `signal ${helper.signalCode}` : `exit code ${helper.exitCode}`})`,
                );
            } else {
                const failed = await this.unmountNudge(at, false);
                if (failed) {
                    problems.push(`fusermount3 -u ${at} failed (${failed}), so it was unmounted lazily`);
                    await this.unmountNudge(at, true);
                }
            }
        } catch (err) {
            problems.push(messageOf(err));
        } finally {
            // Always: its helper gone (its session ends with the unmount), nothing mounted, and its folders removed
            if (proc) {
                const helper = proc;
                if (!(await settlesWithin(helper.exited, this.timing.stopWaitMs))) {
                    if (problems.length === 0) problems.push("its helper didn't exit after the unmount, so it was killed");
                    helper.kill('SIGKILL');
                    await settlesWithin(helper.exited, this.timing.stopWaitMs);
                }
            }
            if (mountsAt(this.readMountInfo(), at).length > 0) await this.unmountNudge(at, true);
            if (mountedIn().length > 0) {
                problems.push(`${at} could not be unmounted`);
            } else {
                rmSync(dir, { recursive: true, force: true });
            }
        }
        return problems.length > 0 ? problems.join('; ') : null;
    }

    // fusermount3 -u on the nudge's mount point, never anything else; lazily with -z. Bounded, and quiet: the nudge says
    // what went wrong in its one line. Answers why the mount is still there, or null once it is gone.
    private async unmountNudge(target: string, lazy: boolean): Promise<string | null> {
        const cmd = lazy ? ['fusermount3', '-u', '-z', target] : ['fusermount3', '-u', target];
        let code: number | undefined;
        try {
            code = await answerWithin(this.run(cmd, { quiet: true }), this.timing.unmountWaitMs);
        } catch (err) {
            return messageOf(err);
        }
        if (code === undefined) return `no answer within ${this.timing.unmountWaitMs} ms`;
        if (code !== 0) return `exit code ${code}`;
        const gone = await this.waitUntil(() => !mountsAt(this.readMountInfo(), target).includes(OUR_FSTYPE), this.timing.unmountWaitMs);
        return gone ? null : 'still mounted';
    }

    private clearRestart(): void {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
    }

    private clearPoll(): void {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }
}
