import {
    accessSync,
    chmodSync,
    closeSync,
    constants,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmdirSync,
    statSync,
    writeSync,
    type Stats,
} from 'node:fs';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import { formatConflictFileName } from '../sync/conflictResolver';
import type { DriveLayout } from '../sync/driveMode';
import { moveWithoutReplacing } from '../sync/localMove';

// Runs protondrive-vfs, which mounts the drive at the sync folder: readies the mount point (a mount left by an earlier
// session is unmounted, files saved into the bare folder are merged into the backing store), restarts a crashed
// helper, and unmounts on shutdown. While unmounted the mount point is 0555, so nothing new lands in it.

export type VfsReason = 'ejected' | 'crashed' | 'fuse-unavailable' | 'switched-off' | 'starting' | 'mount-point-busy' | null;

export interface VfsStatus {
    mode: 'virtual' | 'plain';
    mounted: boolean;
    reason: VfsReason;
}

export interface VfsTiming {
    restartDelaysMs: readonly number[]; // one per restart; a crash after the last one, within the window, is final
    crashWindowMs: number;
    unmountWaitMs: number; // for a lazy unmount to leave mountinfo
    stopWaitMs: number; // for the helper to exit at shutdown, and again after each signal
    mountPollMs: number; // first look for the new mount; it doubles up to 2 s
}

export const DEFAULT_VFS_TIMING: VfsTiming = {
    restartDelaysMs: [1000, 5000, 30_000],
    crashWindowMs: 5 * 60_000,
    unmountWaitMs: 2000,
    stopWaitMs: 2000,
    mountPollMs: 100,
};

// FSName and Subtype "protondrive": how our own mounts show in mountinfo
const OUR_FSTYPE = 'fuse.protondrive';
const LOG_ROTATE_BYTES = 1024 * 1024;

type HelperProcess = Pick<ReturnType<typeof Bun.spawn>, 'exited' | 'exitCode' | 'signalCode' | 'kill' | 'pid'>;

export interface VfsSupervisorOptions {
    mountpoint: string;
    backingDir: string;
    socketPath: string;
    helperPath: string;
    logPath: string; // the helper's stdout and stderr: <appDir>/vfs.log
    logger: Logger;
    mergeStray(fullPath: string): Promise<void>;
    spawn?: typeof Bun.spawn;
    run?: (cmd: string[]) => Promise<number>;
    // Seams for tests: the text of /proc/self/mountinfo (read as latin1), and stat of the mount point
    readMountInfo?: () => string;
    stat?: (p: string) => Stats;
    timing?: Partial<VfsTiming>;
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

// What /api/status says when no supervisor runs, worked out once at start
export function unsupervisedStatus(layout: DriveLayout, wanted: boolean, fuseOk: boolean): VfsStatus {
    if (layout === 'virtual') return { mode: 'virtual', mounted: false, reason: 'fuse-unavailable' };
    return { mode: 'plain', mounted: false, reason: !wanted ? 'switched-off' : !fuseOk ? 'fuse-unavailable' : null };
}

// The file system types mounted exactly at a path, bottom first. mountinfo escapes space, tab, newline and backslash
// in octal (\040); the text is read as latin1 so each char is one byte and the comparison is byte for byte.
export function mountsAt(mountinfo: string, mountpoint: string): string[] {
    const wanted = Buffer.from(mountpoint, 'utf8').toString('latin1');
    const found: string[] = [];
    for (const line of mountinfo.split('\n')) {
        const fields = line.split(' ');
        const separator = fields.indexOf('-', 6);
        if (separator < 0 || fields[4] === undefined) continue;
        const at = fields[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
        if (at === wanted) found.push(fields[separator + 1] ?? '');
    }
    return found;
}

// Moves an entry found in the bare mount point to the same place in the backing store, where the engine picks it up
// as a new local file. Nothing is ever replaced: a folder already in the store is merged into, and an entry whose
// name is taken there gets a conflict name. Answers where conflict-named entries went. Throws when something can't be
// moved; what wasn't moved stays put.
export function mergeStrayInto(strayPath: string, mountpoint: string, backingDir: string, now = new Date()): string[] {
    const rel = path.relative(mountpoint, strayPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${strayPath} isn't inside ${mountpoint}`);
    }
    const renamed: string[] = [];
    mergeEntry(strayPath, path.join(backingDir, rel), now, renamed);
    return renamed;
}

function mergeEntry(from: string, to: string, now: Date, renamed: string[]): void {
    // moveWithoutReplacing undoes a move it can't finish without saying why; this says why first
    accessSync(path.dirname(from), constants.W_OK | constants.X_OK);
    for (let attempt = 0; attempt < 3; attempt++) {
        const there = lstatSync(to, { throwIfNoEntry: false });
        if (!there) {
            if (moveWithoutReplacing(from, to)) return;
            if (!lstatSync(to, { throwIfNoEntry: false })) throw new Error(`Could not move ${from} to ${to}`);
            continue; // the name was taken meanwhile
        }
        if (there.isDirectory() && lstatSync(from).isDirectory()) {
            for (const name of readdirSync(from)) {
                mergeEntry(path.join(from, name), path.join(to, name), now, renamed);
            }
            rmdirSync(from); // ENOTEMPTY if something new arrived: then this stray isn't merged yet
            return;
        }
        renamed.push(moveToConflictName(from, to, now));
        return;
    }
    throw new Error(`Could not move ${from} to ${to}: its name keeps changing`);
}

function moveToConflictName(from: string, to: string, now: Date): string {
    const name = formatConflictFileName(path.basename(to), now);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 0; n < 1000; n++) {
        const candidate = path.join(path.dirname(to), n === 0 ? name : `${stem}-${n}${ext}`);
        if (moveWithoutReplacing(from, candidate)) return candidate;
    }
    throw new Error(`No free conflict name for ${to}`);
}

async function runCommand(cmd: string[], logger: Logger): Promise<number> {
    const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    try {
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (code !== 0) logger.warn(`${cmd.join(' ')} failed (${code}): ${stderr.trim()}`);
        return code;
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    private readonly run: (cmd: string[]) => Promise<number>;
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

    constructor(private readonly opts: VfsSupervisorOptions) {
        this.timing = { ...DEFAULT_VFS_TIMING, ...opts.timing };
        this.logger = opts.logger;
        this.spawn = opts.spawn ?? Bun.spawn;
        this.run = opts.run ?? ((cmd) => runCommand(cmd, this.logger));
        this.readMountInfo =
            opts.readMountInfo ??
            (() => {
                try {
                    return readFileSync('/proc/self/mountinfo', 'latin1');
                } catch {
                    return '';
                }
            });
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
    }

    private serially<T>(task: () => Promise<T>): Promise<T> {
        const next = this.queue.then(task, task);
        this.queue = next.catch(() => {});
        return next;
    }

    // The canonical path, where the helper mounts and what mountinfo shows. Worked out from the parent and readlink,
    // never by looking inside the mount point: a dead or stuck mount there must still be recognised.
    private realMountpoint(): string {
        let p = path.resolve(this.opts.mountpoint);
        for (let hops = 0; hops < 40; hops++) {
            let joined: string;
            try {
                joined = path.join(realpathSync(path.dirname(p)), path.basename(p));
            } catch {
                return p;
            }
            try {
                p = path.resolve(path.dirname(joined), readlinkSync(joined));
            } catch {
                return joined; // not a symlink
            }
        }
        return p;
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
        const cmd = ['fusermount3', '-u', '-z', this.opts.mountpoint];
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
        const blocked = await this.clearOurMounts();
        if (blocked) return blocked;
        const mountpoint = this.opts.mountpoint;
        let st: Stats;
        try {
            st = this.stat(mountpoint);
        } catch (err) {
            if (errnoOf(err) !== 'ENOENT') return `Can't use ${mountpoint}: ${messageOf(err)}`;
            mkdirSync(mountpoint, { recursive: true, mode: 0o700 });
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

    private watchForMount(proc: HelperProcess): void {
        let delay = this.timing.mountPollMs;
        const look = () => {
            this.pollTimer = null;
            if (proc !== this.proc) return;
            if (this.mounts().includes(OUR_FSTYPE)) {
                this.state = { mounted: true, reason: null };
                this.logger.info(`Mounted the drive at ${this.opts.mountpoint}`);
                return;
            }
            delay = Math.min(delay * 2, 2000);
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
        if (this.mounts().length > 0) return;
        try {
            if (!this.stat(this.opts.mountpoint).isDirectory()) return;
            chmodSync(this.opts.mountpoint, 0o555);
        } catch (err) {
            if (errnoOf(err) !== 'ENOENT') this.logger.warn(`Could not make ${this.opts.mountpoint} read-only: ${messageOf(err)}`);
        }
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
