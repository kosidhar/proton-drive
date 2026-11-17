import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    writeSync,
    type Stats,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Subprocess } from 'bun';

import {
    DEFAULT_VFS_TIMING,
    findHelper,
    fuseAvailable,
    mergeStrayInto,
    mountsAt,
    notMountableReason,
    runCommand,
    unsupervisedStatus,
    VfsSupervisor,
    type VfsTiming,
} from '../src/daemon/vfsSupervisor';
import { formatConflictFileName } from '../src/sync/conflictResolver';
import { mountsUnder } from '../src/sync/mountPoint';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

function tempRoot(): string {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pd-vfs-')));
    cleanups.push(() => {
        // Tests make folders read-only; give write access back so they can be removed
        const unlock = (dir: string) => {
            try {
                chmodSync(dir, 0o700);
                for (const name of readdirSync(dir)) {
                    const full = path.join(dir, name);
                    if (statSync(full, { throwIfNoEntry: false })?.isDirectory()) unlock(full);
                }
            } catch {
                // gone already
            }
        };
        unlock(root);
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

const modeOf = (p: string) => statSync(p).mode & 0o777;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await Bun.sleep(5);
    }
}

// A mountinfo line as the kernel writes it, with spaces and backslashes in the mount point escaped in octal
function mountLine(id: number, mountpoint: string, fstype: string, source = fstype): string {
    const escaped = mountpoint.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011');
    return `${id} 30 0:${id} / ${escaped} rw,nosuid,nodev,relatime shared:${id} - ${fstype} ${source} rw,user_id=1000,group_id=1000`;
}

class FakeProc {
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    kills: string[] = [];
    private resolveExit!: (code: number) => void;
    readonly exited = new Promise<number>((resolve) => (this.resolveExit = resolve));
    constructor(
        readonly pid: number,
        private readonly diesOn: 'any-kill' | 'sigkill' | 'never' = 'any-kill',
    ) {}
    get alive(): boolean {
        return this.exitCode === null && this.signalCode === null;
    }
    finish(code: number | null, signal: string | null = null): void {
        if (!this.alive) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.resolveExit(code ?? 128 + 9);
    }
    kill(signal: string | number = 'SIGTERM'): void {
        this.kills.push(String(signal));
        this.killed = true;
        if (this.diesOn === 'any-kill' || (this.diesOn === 'sigkill' && signal === 'SIGKILL')) {
            this.finish(null, String(signal));
        }
    }
}

const FAST: VfsTiming = {
    restartDelaysMs: [20, 40, 60],
    crashWindowMs: 60_000,
    unmountWaitMs: 300,
    stopWaitMs: 100,
    mountPollMs: 5,
    mountTimeoutMs: 10_000,
    nudgeWaitMs: 200,
};

interface SpawnCall {
    cmd: string[];
    stdout: unknown;
    stderr: unknown;
    mode: number;
    entries: string[];
    mountsAtSpawn: number;
}

// A spawn of the nudge's helper (#49), and what was there when it started
interface NudgeSpawnCall {
    cmd: string[];
    stdout: unknown;
    stderr: unknown;
    dirMode: number; // of the nudge's own folder beside the control socket
    dirIsLink: boolean;
    mountpointMode: number;
    mountpointEntries: string[];
    storeEntries: string[];
    socketExists: boolean;
    driveMounts: number; // the drive's own mounts in mountinfo then
    nudgesAlive: number; // nudge helpers still running then
}

// How the nudge's fake helper behaves: whether its mount shows, whether fusermount3 -u (without -z) on it fails,
// whether it exits once unmounted, which signals end it, whether it can't be started, and a gate its unmount waits on
interface FakeNudge {
    mounts?: boolean;
    plainUnmountFails?: boolean;
    exitsOnUnmount?: boolean;
    diesOn?: 'any-kill' | 'sigkill' | 'never';
    spawnThrows?: boolean;
    exitsWith?: number; // exits with this code before it mounts
    unmountGate?: Promise<void>;
}

// A supervisor over temp dirs with a fake helper: spawning it "mounts" (a fuse.protondrive line in a fake mountinfo),
// an eject or fusermount3 removes the line, and a crash leaves it behind as a dead mount does
function harness(opts: {
    timing?: Partial<VfsTiming>;
    mounts?: (mountpoint: string) => string[];
    helperMounts?: boolean;
    diesOn?: 'any-kill' | 'sigkill' | 'never';
    exitsOnUnmount?: boolean;
    mergeStray?: (fullPath: string, h: { mountpoint: string; backing: string }) => Promise<void>;
    stat?: (p: string, runs: string[][]) => Stats;
    mountpointMode?: number;
    noMountpoint?: boolean;
    onSpawn?: (stderr: unknown) => void;
    spawnThrows?: number;
    linkedMountpoint?: boolean; // the sync folder is a symlink to the folder mounted on
    paths?: (root: string) => { mountpoint?: string; backing?: string; appDir?: string };
    runGate?: Promise<void>; // fusermount3 doesn't return until this settles
    nudge?: FakeNudge; // the supervisor nudges (#49), with this fake helper for it
    helperStarts?: boolean; // the supervisor is given onHelperStart, which counts in helperStarts
} = {}) {
    const root = tempRoot();
    const custom = opts.paths?.(root) ?? {};
    const appDir = custom.appDir ?? path.join(root, 'app');
    const backing = custom.backing ?? path.join(appDir, 'files');
    const mountpoint = custom.mountpoint ?? path.join(root, 'Proton Drive');
    // mountinfo, the helper and fusermount3 use the canonical path
    const target = opts.linkedMountpoint ? path.join(root, 'real drive') : mountpoint;
    const logPath = path.join(appDir, 'vfs.log');
    mkdirSync(appDir, { recursive: true });
    mkdirSync(backing, { recursive: true });
    if (!opts.noMountpoint) {
        mkdirSync(target, { recursive: true });
        chmodSync(target, opts.mountpointMode ?? 0o555);
        if (target !== mountpoint) symlinkSync(target, mountpoint);
    }
    const mounts: string[] = opts.mounts ? opts.mounts(target) : [];
    let nextId = 100;
    let spawnThrows = opts.spawnThrows ?? 0;
    const runs: string[][] = [];
    const quietRuns: boolean[] = []; // for each run, whether it was asked to log nothing itself
    const procs: FakeProc[] = [];
    const spawns: SpawnCall[] = [];
    const merged: Array<{ path: string; mountsThen: number }> = [];
    const logs: string[] = [];
    // Each onHelperStart, with how many helpers had been spawned then (#64)
    const helperStarts: number[] = [];
    const ours = (line: string) => line.includes(' - fuse.protondrive ');
    const at = (line: string) => line.split(' ')[4] === target.replace(/ /g, '\\040');
    // The nudge (#49): a hidden folder beside the control socket, holding the nudge's mount point and empty store
    const nudgeDir = path.join(root, '.nudge');
    const nudgeMnt = path.join(nudgeDir, 'mnt');
    const nudgeStore = path.join(nudgeDir, 'store');
    const nudgeProcs: FakeProc[] = [];
    const nudgeSpawns: NudgeSpawnCall[] = [];
    const atNudge = (line: string) => line.split(' ')[4] === nudgeMnt.replace(/ /g, '\\040');
    const modeIfThere = (p: string) => (existsSync(p) ? modeOf(p) : -1);
    const entriesIfThere = (p: string) => (existsSync(p) ? readdirSync(p) : []);
    const removeOneOurs = () => {
        for (let i = mounts.length - 1; i >= 0; i--) {
            if (at(mounts[i]!) && ours(mounts[i]!)) {
                mounts.splice(i, 1);
                return;
            }
        }
    };
    const supervisor = new VfsSupervisor({
        mountpoint,
        backingDir: backing,
        appDir,
        socketPath: path.join(root, 'control.sock'),
        helperPath: '/fake/bin/protondrive-vfs',
        logPath,
        logger: {
            debug: (m: string) => logs.push(`debug ${m}`),
            info: (m: string) => logs.push(`info ${m}`),
            warn: (m: string) => logs.push(`warn ${m}`),
            error: (m: string, e?: unknown) => logs.push(`error ${m}${e ? ` ${String(e)}` : ''}`),
        },
        async mergeStray(fullPath: string) {
            merged.push({ path: fullPath, mountsThen: mounts.filter(at).length });
            if (opts.mergeStray) return opts.mergeStray(fullPath, { mountpoint, backing });
            mergeStrayInto(fullPath, mountpoint, backing);
        },
        spawn: ((cmd: string[], o: { stdout: unknown; stderr: unknown }) => {
            if (cmd[4] === nudgeStore) return spawnNudge(cmd, o); // the nudge's helper, by its store
            const entries = existsSync(mountpoint) ? readdirSync(mountpoint) : [];
            spawns.push({
                cmd,
                stdout: o.stdout,
                stderr: o.stderr,
                mode: existsSync(mountpoint) ? modeOf(mountpoint) : -1,
                entries,
                mountsAtSpawn: mounts.filter(at).length,
            });
            opts.onSpawn?.(o.stderr);
            if (spawnThrows-- > 0) throw Object.assign(new Error('ENOENT: no such file or directory, posix_spawn'), { code: 'ENOENT' });
            const proc = new FakeProc(1000 + procs.length, opts.diesOn ?? 'any-kill');
            procs.push(proc);
            if (opts.helperMounts !== false) {
                // The kernel shows the mount a moment after the helper starts
                setTimeout(() => {
                    if (proc.alive) mounts.push(mountLine(nextId++, target, 'fuse.protondrive', 'protondrive'));
                }, 10);
            }
            return proc;
        }) as unknown as typeof Bun.spawn,
        async run(cmd: string[], o?: { quiet?: boolean }) {
            runs.push(cmd);
            quietRuns.push(o?.quiet === true);
            await opts.runGate;
            if (cmd[0] === 'fusermount3' && cmd[cmd.length - 1] === nudgeMnt && nudgeMnt !== target) return unmountNudge(cmd);
            // fusermount3 resolves the parent but not the last component: a symlink's path isn't in mtab
            if (cmd[0] !== 'fusermount3' || cmd[cmd.length - 1] !== target) return 1;
            removeOneOurs();
            // The session of a live helper ends when its mount goes
            if (opts.exitsOnUnmount !== false) {
                for (const proc of procs) proc.finish(0);
            }
            return 0;
        },
        readMountInfo: () => mounts.join('\n') + '\n',
        stat: opts.stat ? (p: string) => opts.stat!(p, runs) : undefined,
        timing: { ...FAST, ...opts.timing },
        nudge: opts.nudge !== undefined,
        ...(opts.helperStarts ? { onHelperStart: () => helperStarts.push(procs.length) } : {}),
    });
    cleanups.push(() => supervisor.stop());
    // The user ejects the drive in Files: the kernel ends the session, the helper exits 0
    const eject = () => {
        removeOneOurs();
        procs[procs.length - 1]!.finish(0);
    };
    // The helper dies (exit code, or a signal), leaving its mount behind dead
    const crash = (code: number | null = 1, signal: string | null = null) => procs[procs.length - 1]!.finish(code, signal);
    // The nudge's helper mounts a moment after it starts, as the drive's does, and its session ends with its unmount
    function spawnNudge(cmd: string[], o: { stdout: unknown; stderr: unknown }) {
        const fake = opts.nudge ?? {};
        nudgeSpawns.push({
            cmd,
            stdout: o.stdout,
            stderr: o.stderr,
            dirMode: modeIfThere(nudgeDir),
            dirIsLink: lstatSync(nudgeDir, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
            mountpointMode: modeIfThere(nudgeMnt),
            mountpointEntries: entriesIfThere(nudgeMnt),
            storeEntries: entriesIfThere(nudgeStore),
            socketExists: existsSync(cmd[6]!),
            driveMounts: mounts.filter(at).length,
            nudgesAlive: nudgeProcs.filter((p) => p.alive).length,
        });
        if (fake.spawnThrows) throw Object.assign(new Error('ENOENT: no such file or directory, posix_spawn'), { code: 'ENOENT' });
        const proc = new FakeProc(5000 + nudgeProcs.length, fake.diesOn ?? 'any-kill');
        nudgeProcs.push(proc);
        if (fake.exitsWith !== undefined) {
            setTimeout(() => proc.finish(fake.exitsWith!), 10);
        } else if (fake.mounts !== false) {
            setTimeout(() => {
                if (proc.alive) mounts.push(mountLine(nextId++, nudgeMnt, 'fuse.protondrive', 'protondrive'));
            }, 10);
        }
        return proc;
    }
    async function unmountNudge(cmd: string[]): Promise<number> {
        const fake = opts.nudge ?? {};
        await fake.unmountGate;
        if (fake.plainUnmountFails && !cmd.includes('-z')) return 1; // busy
        const i = mounts.findIndex((line) => atNudge(line) && ours(line));
        if (i < 0) return 1; // not mounted
        mounts.splice(i, 1);
        if (fake.exitsOnUnmount !== false) {
            for (const proc of nudgeProcs) proc.finish(0);
        }
        return 0;
    }
    const nudgeRuns = () => runs.filter((cmd) => cmd[cmd.length - 1] === nudgeMnt);
    const nudgeMounts = () => mounts.filter(atNudge);
    return {
        root,
        appDir,
        mountpoint,
        target,
        backing,
        logPath,
        mounts,
        runs,
        quietRuns,
        procs,
        spawns,
        merged,
        logs,
        helperStarts,
        supervisor,
        eject,
        crash,
        nudgeDir,
        nudgeMnt,
        nudgeStore,
        nudgeProcs,
        nudgeSpawns,
        nudgeRuns,
        nudgeMounts,
    };
}

const fusermount = (mountpoint: string) => ['fusermount3', '-u', '-z', mountpoint];

describe('VfsSupervisor: preparing the mount point', () => {
    test('a stale ENOTCONN mount point is unmounted with fusermount3 -u -z before the helper starts', async () => {
        const enotconn = Object.assign(new Error('ENOTCONN: socket is not connected'), { code: 'ENOTCONN' });
        const h = harness({
            stat: (p, runs) => {
                if (runs.length === 0) throw enotconn;
                return statSync(p);
            },
        });
        await h.supervisor.start();
        expect(h.runs).toEqual([fusermount(h.mountpoint)]);
        expect(h.spawns).toHaveLength(1);
        expect(h.spawns[0]!.cmd).toEqual([
            '/fake/bin/protondrive-vfs',
            '--mountpoint',
            h.mountpoint,
            '--backing',
            h.backing,
            '--socket',
            path.join(h.root, 'control.sock'),
        ]);
    });

    test('a live mount left by an orphaned helper is unmounted, and gone, before strays are merged or the helper starts', async () => {
        const h = harness({ mounts: (mp) => [mountLine(7, mp, 'fuse.protondrive', 'protondrive')], mountpointMode: 0o700 });
        writeFileSync(path.join(h.mountpoint, 'saved while down.txt'), 'keep me');
        await h.supervisor.start();
        expect(h.runs).toEqual([fusermount(h.mountpoint)]);
        expect(h.merged).toEqual([{ path: path.join(h.mountpoint, 'saved while down.txt'), mountsThen: 0 }]);
        expect(h.spawns).toHaveLength(1);
        expect(h.spawns[0]!.mountsAtSpawn).toBe(0);
    });

    test('two of our mounts stacked at the mount point are both unmounted', async () => {
        const h = harness({
            mounts: (mp) => [mountLine(7, mp, 'fuse.protondrive', 'protondrive'), mountLine(8, mp, 'fuse.protondrive', 'protondrive')],
        });
        await h.supervisor.start();
        expect(h.runs).toEqual([fusermount(h.mountpoint), fusermount(h.mountpoint)]);
        expect(h.spawns).toHaveLength(1);
    });

    test('a mount that is not ours is never touched: no fusermount3, no chmod, no helper, mount-point-busy', async () => {
        const h = harness({ mounts: (mp) => [mountLine(7, mp, 'fuse.sshfs', 'me@host:')], mountpointMode: 0o750 });
        await h.supervisor.start();
        expect(h.runs).toEqual([]);
        expect(h.spawns).toEqual([]);
        expect(h.merged).toEqual([]);
        expect(modeOf(h.mountpoint)).toBe(0o750);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'mount-point-busy' });
        expect(h.logs.some((l) => l.includes(h.mountpoint) && l.includes('fuse.sshfs'))).toBe(true);
    });

    test('a foreign mount on top of ours, or under it, is never touched either', async () => {
        for (const order of [['fuse.protondrive', 'ext4'], ['ext4', 'fuse.protondrive']]) {
            const h = harness({ mounts: (mp) => order.map((fstype, i) => mountLine(7 + i, mp, fstype)) });
            await h.supervisor.start();
            expect(h.runs).toEqual([]);
            expect(h.spawns).toEqual([]);
            expect(h.supervisor.status().reason).toBe('mount-point-busy');
        }
    });

    test('a sync folder that is a symlink is matched in mountinfo at its target, never by looking inside the mount', async () => {
        const foreign = harness({ linkedMountpoint: true, mounts: (mp) => [mountLine(7, mp, 'fuse.sshfs')] });
        await foreign.supervisor.start();
        expect(foreign.runs).toEqual([]);
        expect(foreign.supervisor.status().reason).toBe('mount-point-busy');

        const orphan = harness({ linkedMountpoint: true, mounts: (mp) => [mountLine(7, mp, 'fuse.protondrive', 'protondrive')] });
        await orphan.supervisor.start();
        expect(orphan.runs).toEqual([fusermount(orphan.target)]);
        expect(orphan.spawns).toHaveLength(1);
        await until(() => orphan.supervisor.status().mounted);
    });

    test('a symlinked sync folder: a crash and a stop unmount the canonical path, so no dead mount is left', async () => {
        const h = harness({ linkedMountpoint: true });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.crash(null, 'SIGKILL');
        await until(() => h.spawns.length === 2);
        expect(h.runs).toEqual([fusermount(h.target)]);
        expect(h.spawns[1]!.mountsAtSpawn).toBe(0);
        await until(() => h.supervisor.status().mounted);
        await h.supervisor.stop();
        expect(h.runs).toEqual([fusermount(h.target), fusermount(h.target)]);
        expect(h.procs[1]!.kills).toEqual([]);
        expect(h.mounts).toEqual([]);
        expect(modeOf(h.target)).toBe(0o555);
    });

    test("a dead foreign mount at the symlink's target is recognised, so the ENOTCONN fallback never touches it", async () => {
        const enotconn = Object.assign(new Error('ENOTCONN: socket is not connected'), { code: 'ENOTCONN' });
        const h = harness({
            linkedMountpoint: true,
            mounts: (mp) => [mountLine(7, mp, 'fuse.sshfs')],
            stat: () => {
                throw enotconn;
            },
        });
        rmSync(path.join(h.root, 'real drive'), { recursive: true }); // as realpath sees a dead mount: unreachable
        await h.supervisor.start();
        expect(h.runs).toEqual([]);
        expect(h.supervisor.status().reason).toBe('mount-point-busy');
    });

    test('mounts elsewhere, ours or not, are left alone, including paths that only start with the mount point', async () => {
        const h = harness({
            mounts: (mp) => [
                mountLine(7, `${mp}2`, 'fuse.protondrive', 'protondrive'),
                mountLine(8, path.dirname(mp), 'ext4', '/dev/sda1'),
                mountLine(9, path.join(mp, 'sub'), 'fuse.sshfs'),
            ],
        });
        await h.supervisor.start();
        expect(h.runs).toEqual([]);
        expect(h.spawns).toHaveLength(1);
    });

    test('strays are merged into the backing store before the mount, which starts with the mount point at 0700', async () => {
        const h = harness({ mountpointMode: 0o700 });
        writeFileSync(path.join(h.mountpoint, 'a.txt'), 'a');
        mkdirSync(path.join(h.mountpoint, 'Docs'));
        writeFileSync(path.join(h.mountpoint, 'Docs', 'b.txt'), 'b');
        await h.supervisor.start();
        expect(h.merged.map((m) => path.basename(m.path)).sort()).toEqual(['Docs', 'a.txt']);
        expect(h.spawns).toHaveLength(1);
        expect(h.spawns[0]!.entries).toEqual([]);
        expect(h.spawns[0]!.mode).toBe(0o700);
        expect(readFileSync(path.join(h.backing, 'a.txt'), 'utf8')).toBe('a');
        expect(readFileSync(path.join(h.backing, 'Docs', 'b.txt'), 'utf8')).toBe('b');
    });

    test('strays in a read-only (0555) mount point are still merged', async () => {
        const h = harness();
        chmodSync(h.mountpoint, 0o700);
        writeFileSync(path.join(h.mountpoint, 'a.txt'), 'a');
        chmodSync(h.mountpoint, 0o555);
        await h.supervisor.start();
        expect(h.spawns).toHaveLength(1);
        expect(readFileSync(path.join(h.backing, 'a.txt'), 'utf8')).toBe('a');
    });

    test('a stray that cannot be merged keeps the drive unmounted, says which, and is retried by mountAgain', async () => {
        let refuse = true;
        const h = harness({
            mountpointMode: 0o700,
            mergeStray: async (fullPath, { mountpoint, backing }) => {
                if (refuse) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
                mergeStrayInto(fullPath, mountpoint, backing);
            },
        });
        writeFileSync(path.join(h.mountpoint, 'report.odt'), 'precious');
        await h.supervisor.start();
        expect(h.spawns).toEqual([]);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'mount-point-busy' });
        expect(h.logs.some((l) => l.startsWith('error') && l.includes(path.join(h.mountpoint, 'report.odt')))).toBe(true);
        expect(readFileSync(path.join(h.mountpoint, 'report.odt'), 'utf8')).toBe('precious');
        expect(modeOf(h.mountpoint)).toBe(0o555);

        await expect(h.supervisor.mountAgain()).rejects.toThrow(/report\.odt/);
        expect(h.spawns).toEqual([]);

        refuse = false;
        await h.supervisor.mountAgain();
        expect(h.spawns).toHaveLength(1);
        expect(readFileSync(path.join(h.backing, 'report.odt'), 'utf8')).toBe('precious');
    });

    test('a file saved while the strays are being merged is merged in another round', async () => {
        let saved = false;
        const h = harness({
            mountpointMode: 0o700,
            mergeStray: async (fullPath, { mountpoint, backing }) => {
                if (!saved) {
                    saved = true;
                    writeFileSync(path.join(mountpoint, 'late.txt'), 'late'); // an app saves meanwhile
                }
                mergeStrayInto(fullPath, mountpoint, backing);
            },
        });
        writeFileSync(path.join(h.mountpoint, 'early.txt'), 'early');
        await h.supervisor.start();
        expect(h.spawns).toHaveLength(1);
        expect(h.spawns[0]!.entries).toEqual([]);
        expect(readdirSync(h.backing).sort()).toEqual(['early.txt', 'late.txt']);
    });

    test('strays whose names start with two dots are merged like any other', async () => {
        const h = harness({ mountpointMode: 0o700 });
        writeFileSync(path.join(h.mountpoint, '..notes'), 'n');
        mkdirSync(path.join(h.mountpoint, '...'));
        await h.supervisor.start();
        expect(h.spawns).toHaveLength(1);
        expect(readdirSync(h.backing).sort()).toEqual(['...', '..notes']);
    });

    test('a file saved into a stray folder mid-merge keeps the drive unmounted, and nothing is lost', async () => {
        const h = harness({
            mountpointMode: 0o700,
            mergeStray: async (fullPath, { mountpoint, backing }) => {
                mergeStrayInto(fullPath, mountpoint, backing, new Date(), (folder) => {
                    writeFileSync(path.join(folder, 'late.txt'), 'late'); // an app saves just before it goes
                });
            },
        });
        mkdirSync(path.join(h.backing, 'Docs'));
        mkdirSync(path.join(h.mountpoint, 'Docs'));
        writeFileSync(path.join(h.mountpoint, 'Docs', 'a.txt'), 'a');
        await h.supervisor.start();
        expect(h.spawns).toEqual([]);
        expect(h.supervisor.status().reason).toBe('mount-point-busy');
        expect(readFileSync(path.join(h.backing, 'Docs', 'a.txt'), 'utf8')).toBe('a');
        expect(readFileSync(path.join(h.mountpoint, 'Docs', 'late.txt'), 'utf8')).toBe('late');
    });

    test('a mount point overlapping the backing store or the app dir is refused and never touched', async () => {
        const cases = {
            'inside the backing store': (root: string) => ({ mountpoint: path.join(root, 'app', 'files', 'Drive') }),
            'the backing store itself': (root: string) => ({ mountpoint: path.join(root, 'app', 'files') }),
            'inside the app dir': (root: string) => ({ mountpoint: path.join(root, 'app', 'Drive') }),
            'holding the app dir': (root: string) => ({
                mountpoint: path.join(root, 'home'),
                appDir: path.join(root, 'home', '.local', 'app'),
            }),
        };
        for (const [name, paths] of Object.entries(cases)) {
            const h = harness({ paths, mountpointMode: 0o750 });
            writeFileSync(path.join(h.backing, 'in the store.txt'), 'x');
            await h.supervisor.start();
            expect([name, h.spawns.length, h.runs.length]).toEqual([name, 0, 0]);
            expect(h.supervisor.status().reason).toBe('mount-point-busy');
            expect(h.logs.some((l) => l.startsWith('error') && l.includes('overlaps'))).toBe(true);
            await expect(h.supervisor.mountAgain()).rejects.toThrow(/overlaps/);
            await h.supervisor.stop();
            expect([name, modeOf(h.mountpoint)]).toEqual([name, 0o750]);
            expect(readFileSync(path.join(h.backing, 'in the store.txt'), 'utf8')).toBe('x');
        }
    });

    test('a stray left in the mount point after merging keeps the drive unmounted', async () => {
        const h = harness({ mountpointMode: 0o700, mergeStray: async () => {} });
        writeFileSync(path.join(h.mountpoint, 'stuck.txt'), 'x');
        await h.supervisor.start();
        expect(h.spawns).toEqual([]);
        expect(h.supervisor.status().reason).toBe('mount-point-busy');
    });

    test('the real merge failing on a read-only stray folder keeps the drive unmounted and loses nothing', async () => {
        const h = harness({ mountpointMode: 0o700 });
        mkdirSync(path.join(h.backing, 'Docs'));
        writeFileSync(path.join(h.backing, 'Docs', 'cloud.txt'), 'cloud');
        mkdirSync(path.join(h.mountpoint, 'Docs'));
        writeFileSync(path.join(h.mountpoint, 'Docs', 'mine.txt'), 'mine');
        chmodSync(path.join(h.mountpoint, 'Docs'), 0o555); // its entries can't be moved out
        await h.supervisor.start();
        expect(h.spawns).toEqual([]);
        expect(h.supervisor.status().reason).toBe('mount-point-busy');
        expect(readFileSync(path.join(h.mountpoint, 'Docs', 'mine.txt'), 'utf8')).toBe('mine');
        expect(readFileSync(path.join(h.backing, 'Docs', 'cloud.txt'), 'utf8')).toBe('cloud');
    });

    test('a missing mount point is created at 0700 before the mount', async () => {
        const h = harness({ noMountpoint: true });
        await h.supervisor.start();
        expect(h.spawns).toHaveLength(1);
        expect(h.spawns[0]!.mode).toBe(0o700);
    });

    test('a file where the mount point should be keeps the drive unmounted', async () => {
        const h = harness({ noMountpoint: true });
        writeFileSync(h.mountpoint, 'not a folder');
        await h.supervisor.start();
        expect(h.spawns).toEqual([]);
        expect(h.supervisor.status().reason).toBe('mount-point-busy');
        expect(readFileSync(h.mountpoint, 'utf8')).toBe('not a folder');
    });
});

describe('VfsSupervisor: the helper session', () => {
    test('status is starting until the mount shows, then mounted', async () => {
        const h = harness({ helperMounts: false });
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'starting' });
        await h.supervisor.start();
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'starting' });
        h.mounts.push(mountLine(50, h.mountpoint, 'fuse.protondrive', 'protondrive'));
        await until(() => h.supervisor.status().mounted);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
    });

    test('exit 0 (an eject) is ejected, restores 0555 and starts no new helper; mountAgain does', async () => {
        const h = harness();
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.eject();
        await until(() => h.supervisor.status().reason === 'ejected');
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'ejected' });
        await until(() => modeOf(h.mountpoint) === 0o555);
        await Bun.sleep(150); // longer than every restart delay
        expect(h.spawns).toHaveLength(1);
        expect(h.runs).toEqual([]);

        await h.supervisor.mountAgain();
        expect(h.spawns).toHaveLength(2);
        expect(h.spawns[1]!.mode).toBe(0o700);
        await until(() => h.supervisor.status().mounted);
    });

    test('mountAgain while the drive is mounted starts nothing', async () => {
        const h = harness();
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await h.supervisor.mountAgain();
        expect(h.spawns).toHaveLength(1);
    });

    test('a crash unmounts the dead mount, restores 0555, then restarts the helper', async () => {
        const h = harness({ timing: { restartDelaysMs: [300, 300, 300] } });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.crash(null, 'SIGKILL');
        await until(() => h.runs.length === 1 && modeOf(h.mountpoint) === 0o555);
        expect(h.runs).toEqual([fusermount(h.mountpoint)]);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'starting' });
        expect(h.spawns).toHaveLength(1);
        await until(() => h.spawns.length === 2);
        expect(h.spawns[1]!.mode).toBe(0o700);
        expect(h.spawns[1]!.mountsAtSpawn).toBe(0);
        await until(() => h.supervisor.status().mounted);
    });

    test('a crash shows unmounted at once, while its dead mount is still being cleared', async () => {
        let release!: () => void;
        const h = harness({ runGate: new Promise<void>((resolve) => (release = resolve)) });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.crash(1);
        await until(() => h.runs.length === 1);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'starting' });
        release();
        await until(() => h.spawns.length === 2);
    });

    test('mountAgain while a restart is pending starts exactly one helper', async () => {
        const h = harness({ timing: { restartDelaysMs: [150, 150, 150] } });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.crash(1);
        await until(() => h.runs.length === 1 && modeOf(h.mountpoint) === 0o555);
        await h.supervisor.mountAgain();
        expect(h.spawns).toHaveLength(2);
        await Bun.sleep(300); // past the restart that was pending
        expect(h.spawns).toHaveLength(2);
        await until(() => h.supervisor.status().mounted);
    });

    test('exit 2 (the mount failed) counts as a crash and is retried', async () => {
        const h = harness({ helperMounts: false });
        await h.supervisor.start();
        h.crash(2);
        await until(() => h.spawns.length === 2);
        expect(h.runs).toEqual([]); // nothing was mounted, so nothing to unmount
    });

    test('three restarts that crash again within the window end in crashed, with no more restarts', async () => {
        const h = harness();
        await h.supervisor.start();
        for (let n = 1; n <= 4; n++) {
            await until(() => h.supervisor.status().mounted);
            h.crash(1);
            if (n < 4) await until(() => h.spawns.length === n + 1);
        }
        await until(() => h.supervisor.status().reason === 'crashed');
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: 'crashed' });
        await Bun.sleep(150);
        expect(h.spawns).toHaveLength(4);
        expect(h.runs).toEqual([1, 2, 3, 4].map(() => fusermount(h.mountpoint)));
        expect(modeOf(h.mountpoint)).toBe(0o555);

        // The user asks again: a fresh start, with the crash count forgotten
        await h.supervisor.mountAgain();
        expect(h.spawns).toHaveLength(5);
        await until(() => h.supervisor.status().mounted);
    });

    test('restarts wait 1 s, 5 s and 30 s by default, and three crashes are counted over 5 minutes', () => {
        expect(DEFAULT_VFS_TIMING.restartDelaysMs).toEqual([1000, 5000, 30_000]);
        expect(DEFAULT_VFS_TIMING.crashWindowMs).toBe(5 * 60_000);
    });

    test('crashes older than the window are forgotten', async () => {
        const h = harness({ timing: { crashWindowMs: 100 } });
        await h.supervisor.start();
        for (let n = 1; n <= 5; n++) {
            await until(() => h.supervisor.status().mounted);
            await Bun.sleep(120);
            h.crash(1);
            await until(() => h.spawns.length === n + 1);
        }
        expect(h.supervisor.status().reason).not.toBe('crashed');
    });

    // Final review M-6: a helper that stays alive but never mounts left the status at starting for ever, with no Mount
    // again
    test('a helper that never mounts within the bound is killed and counted as a crash, ending in crashed', async () => {
        const h = harness({ helperMounts: false, timing: { mountTimeoutMs: 80 } });
        await h.supervisor.start();
        expect(h.supervisor.status().reason).toBe('starting');
        await until(() => h.spawns.length === 2);
        expect(h.procs[0]!.kills).toEqual(['SIGKILL']);
        expect(h.logs.some((l) => l.includes("didn't mount the drive"))).toBe(true);
        await until(() => h.supervisor.status().reason === 'crashed', 3000);
        expect(h.spawns).toHaveLength(4);
        expect(h.procs.every((p) => !p.alive)).toBe(true);
        expect(modeOf(h.mountpoint)).toBe(0o555);
    });

    test('a helper that mounts within the bound is never killed for it', async () => {
        const h = harness({ timing: { mountTimeoutMs: 200 } });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await Bun.sleep(300);
        expect(h.procs[0]!.kills).toEqual([]);
        expect(h.spawns).toHaveLength(1);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
    });

    test('the mount is waited for 30 s by default', () => {
        expect(DEFAULT_VFS_TIMING.mountTimeoutMs).toBe(30_000);
    });

    test('a helper that cannot be started counts as a crash', async () => {
        const h = harness({ spawnThrows: 2 });
        await h.supervisor.start();
        expect(h.supervisor.status().reason).toBe('starting');
        expect(modeOf(h.mountpoint)).toBe(0o555);
        await until(() => h.supervisor.status().mounted);
        expect(h.spawns).toHaveLength(3);
        expect(modeOf(h.mountpoint)).toBe(0o700);
    });

    // #64: a new helper has no file open for writing, so the daemon forgets what the last one said was
    test('onHelperStart is called once for each helper started: at start, after a crash, and on Mount again', async () => {
        const h = harness({ helperStarts: true });
        await h.supervisor.start();
        expect(h.helperStarts).toEqual([1]); // as soon as it is spawned, before it mounts
        await until(() => h.supervisor.status().mounted);
        h.crash(null, 'SIGKILL');
        await until(() => h.spawns.length === 2);
        expect(h.helperStarts).toEqual([1, 2]);
        await until(() => h.supervisor.status().mounted);
        h.eject();
        await until(() => h.supervisor.status().reason === 'ejected');
        await h.supervisor.mountAgain();
        expect(h.helperStarts).toEqual([1, 2, 3]);
        await until(() => h.supervisor.status().mounted);
        await h.supervisor.mountAgain(); // mounted already: starts nothing
        expect(h.helperStarts).toEqual([1, 2, 3]);
    });

    test('onHelperStart is not called for a helper that could not be started', async () => {
        const h = harness({ helperStarts: true, spawnThrows: 2 });
        await h.supervisor.start();
        expect(h.helperStarts).toEqual([]);
        await until(() => h.supervisor.status().mounted);
        expect(h.spawns).toHaveLength(3);
        expect(h.helperStarts).toEqual([1]);
    });
});

describe('VfsSupervisor: stopping', () => {
    test('stop unmounts, waits for the helper to exit, and restores 0555, without calling it an eject', async () => {
        const h = harness();
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await h.supervisor.stop();
        expect(h.runs).toEqual([fusermount(h.mountpoint)]);
        expect(h.procs[0]!.alive).toBe(false);
        expect(h.procs[0]!.kills).toEqual([]);
        expect(modeOf(h.mountpoint)).toBe(0o555);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: false, reason: null });
        await Bun.sleep(100);
        expect(h.spawns).toHaveLength(1);
    });

    test('stop is bounded: a helper that will not exit is killed, and its dead mount unmounted', async () => {
        const h = harness({ exitsOnUnmount: false, diesOn: 'sigkill' });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        // The fake fusermount3 removed the mount, but the session lingers (a process still has a file open)
        const started = Date.now();
        await h.supervisor.stop();
        expect(Date.now() - started).toBeLessThan(3000);
        expect(h.procs[0]!.kills).toEqual(['SIGTERM', 'SIGKILL']);
        expect(h.procs[0]!.alive).toBe(false);
        expect(modeOf(h.mountpoint)).toBe(0o555);
    });

    test('stop during a restart delay cancels the restart', async () => {
        const h = harness({ timing: { restartDelaysMs: [100, 100, 100] } });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.crash(1);
        await until(() => h.runs.length === 1);
        await h.supervisor.stop();
        await Bun.sleep(200);
        expect(h.spawns).toHaveLength(1);
        expect(modeOf(h.mountpoint)).toBe(0o555);
    });

    test('after stop, mountAgain (a late request during shutdown) starts nothing', async () => {
        const h = harness();
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await h.supervisor.stop();
        await expect(h.supervisor.mountAgain()).rejects.toThrow(/stopping/);
        expect(h.spawns).toHaveLength(1);
        await h.supervisor.start(); // starting again is explicit
        expect(h.spawns).toHaveLength(2);
    });

    test('stop never runs fusermount3 through a foreign mount stacked on ours', async () => {
        const h = harness({ mountpointMode: 0o700 });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        h.mounts.push(mountLine(60, h.mountpoint, 'fuse.sshfs'));
        await h.supervisor.stop();
        expect(h.runs).toEqual([]);
        expect(h.procs[0]!.kills).toEqual(['SIGTERM']);
        expect(modeOf(h.mountpoint)).toBe(0o700); // not chmodded through the mount on top
    });

    test('stop with a foreign mount at the mount point touches nothing', async () => {
        const h = harness({ mounts: (mp) => [mountLine(7, mp, 'fuse.sshfs')], mountpointMode: 0o750 });
        await h.supervisor.start();
        await h.supervisor.stop();
        expect(h.runs).toEqual([]);
        expect(modeOf(h.mountpoint)).toBe(0o750);
    });
});

describe('VfsSupervisor: helper output', () => {
    test("the helper's stdout and stderr are one fd of vfs.log opened for append, never a pipe", async () => {
        const h = harness({
            onSpawn: (stderr) => {
                if (typeof stderr === 'number') writeSync(stderr, 'protondrive-vfs: hello\n');
            },
        });
        writeFileSync(h.logPath, 'earlier session\n');
        await h.supervisor.start();
        const call = h.spawns[0]!;
        expect(typeof call.stdout).toBe('number');
        expect(call.stderr).toBe(call.stdout);
        const log = readFileSync(h.logPath, 'utf8');
        expect(log.startsWith('earlier session\n')).toBe(true);
        expect(log).toContain('protondrive-vfs: hello\n');
        expect(existsSync(`${h.logPath}.1`)).toBe(false);
    });

    test('vfs.log is made user-only each time it is opened, not only when created', async () => {
        const h = harness();
        writeFileSync(h.logPath, 'earlier\n');
        chmodSync(h.logPath, 0o644);
        await h.supervisor.start();
        expect(modeOf(h.logPath)).toBe(0o600);
    });

    test('a log that grew past 1 MB during a session is rotated when the crashed helper restarts', async () => {
        let first = true;
        const h = harness({
            onSpawn: (fd) => {
                if (first && typeof fd === 'number') writeSync(fd, 'y'.repeat(1024 * 1024 + 10));
                first = false;
            },
        });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        expect(existsSync(`${h.logPath}.1`)).toBe(false);
        h.crash(1);
        await until(() => h.spawns.length === 2);
        expect(statSync(`${h.logPath}.1`).size).toBeGreaterThan(1024 * 1024);
        expect(statSync(h.logPath).size).toBeLessThan(4096);
    });

    test('vfs.log over 1 MB is rotated to vfs.log.1 when the helper starts', async () => {
        const h = harness();
        const big = 'x'.repeat(1024 * 1024 + 10);
        writeFileSync(h.logPath, big);
        writeFileSync(`${h.logPath}.1`, 'older');
        await h.supervisor.start();
        expect(readFileSync(`${h.logPath}.1`, 'utf8')).toBe(big);
        expect(statSync(h.logPath).size).toBeLessThan(4096);
        expect(modeOf(h.logPath)).toBe(0o600); // it names the user's files
    });
});

// #49: GLib's mount monitor misses the attach of a FUSE mount made through fusermount3 (it sees the detach), so Files
// showed the drive in its sidebar only minutes later, at the next mount change anywhere. Once the drive shows mounted,
// the supervisor makes such a change: it mounts a tiny private helper at a hidden path beside the control socket and
// unmounts it at once. Best effort: bounded, always cleaned up, never touching the drive, never holding up its status.
describe('VfsSupervisor: the nudge that shows the drive in Files (#49)', () => {
    type H = ReturnType<typeof harness>;
    const nudgeCmd = (h: H) => [
        '/fake/bin/protondrive-vfs',
        '--mountpoint',
        h.nudgeMnt,
        '--backing',
        h.nudgeStore,
        '--socket',
        path.join(h.nudgeDir, 'no-daemon.sock'),
    ];
    const unmountNudge = (h: H) => ['fusermount3', '-u', h.nudgeMnt];
    const lazyUnmountNudge = (h: H) => ['fusermount3', '-u', '-z', h.nudgeMnt];
    // n nudges have run, and the last has cleaned up: its helper gone, its folder removed
    const nudged = (h: H, n = 1) =>
        until(() => h.nudgeSpawns.length === n && h.nudgeProcs.every((p) => !p.alive) && !existsSync(h.nudgeDir));
    const nudgeWarnings = (h: H) => h.logs.filter((l) => l.startsWith('warn') && l.includes('nudge'));
    const problems = (h: H) => h.logs.filter((l) => l.startsWith('warn') || l.startsWith('error'));
    const driveMounted = (h: H) => mountsAt(h.mounts.join('\n'), h.target).length;

    test('once the drive shows mounted, a hidden private mount beside the control socket is mounted and unmounted', async () => {
        const h = harness({ nudge: {} });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await nudged(h);

        expect(h.nudgeSpawns).toHaveLength(1);
        const nudge = h.nudgeSpawns[0]!;
        // The same helper, on a hidden folder in the control socket's own private dir, with an empty store and no daemon
        expect(nudge.cmd).toEqual(nudgeCmd(h));
        expect(h.nudgeDir).toBe(path.join(path.dirname(path.join(h.root, 'control.sock')), '.nudge'));
        expect(nudge.dirMode).toBe(0o700);
        expect(nudge.mountpointMode).toBe(0o700);
        expect(nudge.mountpointEntries).toEqual([]);
        expect(nudge.storeEntries).toEqual([]);
        expect(nudge.socketExists).toBe(false);
        expect(typeof nudge.stdout === 'string' && nudge.stdout === 'pipe').toBe(false); // never a pipe nobody drains
        // After the drive's mount showed, and only then
        expect(nudge.driveMounts).toBe(1);
        // Mounted, then unmounted, and its helper's session ended by that
        expect(h.runs).toEqual([unmountNudge(h)]);
        expect(h.nudgeProcs[0]!.kills).toEqual([]);
        expect(h.nudgeMounts()).toEqual([]);
        // The drive is untouched
        expect(h.runs.flat()).not.toContain(h.mountpoint);
        expect(driveMounted(h)).toBe(1);
        expect(h.procs[0]!.alive).toBe(true);
        expect(h.spawns).toHaveLength(1);
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
        expect(problems(h)).toEqual([]);
    });

    test('without the option there is no nudge', async () => {
        const h = harness();
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await Bun.sleep(100);
        expect(h.nudgeSpawns).toEqual([]);
        expect(h.runs).toEqual([]);
        expect(existsSync(h.nudgeDir)).toBe(false);
    });

    test('every mount is nudged: at start, after Mount again and after a crash', async () => {
        const h = harness({ nudge: {} });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await nudged(h, 1);

        h.eject();
        await until(() => h.supervisor.status().reason === 'ejected');
        await Bun.sleep(50);
        expect(h.nudgeSpawns).toHaveLength(1); // an eject mounts nothing
        await h.supervisor.mountAgain();
        await until(() => h.supervisor.status().mounted);
        await nudged(h, 2);

        h.crash(null, 'SIGKILL');
        await until(() => h.spawns.length === 3 && h.supervisor.status().mounted);
        await nudged(h, 3);

        expect(h.nudgeSpawns.map((s) => s.driveMounts)).toEqual([1, 1, 1]);
        expect(h.nudgeRuns()).toEqual([unmountNudge(h), unmountNudge(h), unmountNudge(h)]);
        // The drive's own unmount after the crash was its own, never the nudge's, and logs as ever
        expect(h.runs.filter((cmd) => cmd[cmd.length - 1] === h.target)).toEqual([fusermount(h.target)]);
        expect(h.runs.map((cmd, i) => [cmd[cmd.length - 1], h.quietRuns[i]])).toEqual(
            h.runs.map((cmd) => [cmd[cmd.length - 1], cmd[cmd.length - 1] === h.nudgeMnt]),
        );
        expect(problems(h).filter((l) => l.includes('nudge'))).toEqual([]);
    });

    test("the drive's status never waits for the nudge: mounted at once, and an eject meanwhile is seen at once", async () => {
        let release!: () => void;
        const h = harness({ nudge: { unmountGate: new Promise<void>((resolve) => (release = resolve)) } });
        await h.supervisor.start();
        await until(() => h.nudgeRuns().length === 1); // the nudge is mounted, and its unmount hangs
        expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });

        h.eject();
        await until(() => h.supervisor.status().reason === 'ejected');
        expect(h.nudgeProcs[0]!.alive).toBe(true);
        release();
        await nudged(h);
        expect(h.supervisor.status().reason).toBe('ejected');
    });

    test('never two nudges at once: a mount during a nudge is nudged once that one has finished', async () => {
        let release!: () => void;
        const h = harness({ nudge: { unmountGate: new Promise<void>((resolve) => (release = resolve)) } });
        await h.supervisor.start();
        await until(() => h.nudgeRuns().length === 1);

        // The drive crashes and mounts again while the first nudge still runs
        h.crash(1);
        await until(() => h.spawns.length === 2 && h.supervisor.status().mounted);
        await Bun.sleep(50);
        expect(h.nudgeSpawns).toHaveLength(1);

        release();
        await nudged(h, 2);
        expect(h.nudgeSpawns.map((s) => s.nudgesAlive)).toEqual([0, 0]);
        await Bun.sleep(50);
        expect(h.nudgeSpawns).toHaveLength(2); // one more, not one per mount seen meanwhile
    });

    test('a nudge that fails is logged once and ignored, and always cleans up', async () => {
        type Case = { what: string; nudge: FakeNudge; runs: (h: H) => string[][]; killed: string[]; says: (h: H) => string };
        const cases: Case[] = [
            { what: 'its helper cannot start', nudge: { spawnThrows: true }, runs: () => [], killed: [], says: () => 'posix_spawn' },
            // Stuck before its mount: killed at the bound
            {
                what: 'its mount never shows',
                nudge: { mounts: false },
                runs: () => [],
                killed: ['SIGKILL'],
                says: () => "its mount didn't show within",
            },
            // Its mount failed (exit code 2): nothing to unmount or kill
            {
                what: 'its helper exits before it mounts',
                nudge: { exitsWith: 2 },
                runs: () => [],
                killed: [],
                says: () => 'protondrive-vfs stopped (exit code 2)',
            },
            // Busy (something looks into it): unmounted lazily instead
            {
                what: 'fusermount3 -u fails',
                nudge: { plainUnmountFails: true },
                runs: (h) => [unmountNudge(h), lazyUnmountNudge(h)],
                killed: [],
                says: (h) => `fusermount3 -u ${h.nudgeMnt} failed (exit code 1), so it was unmounted lazily`,
            },
            // Its session lingers after the unmount: killed
            {
                what: 'its helper does not exit',
                nudge: { exitsOnUnmount: false, diesOn: 'sigkill' },
                runs: (h) => [unmountNudge(h)],
                killed: ['SIGKILL'],
                says: () => "its helper didn't exit after the unmount",
            },
        ];
        for (const c of cases) {
            const h = harness({ nudge: c.nudge, timing: { nudgeWaitMs: 100 } });
            await h.supervisor.start();
            await until(() => nudgeWarnings(h).length > 0, 3000);
            await nudged(h);
            expect({ what: c.what, runs: h.runs }).toEqual({ what: c.what, runs: c.runs(h) });
            expect({ what: c.what, killed: h.nudgeProcs.flatMap((p) => p.kills) }).toEqual({ what: c.what, killed: c.killed });
            expect(h.nudgeMounts()).toEqual([]);
            expect(existsSync(h.nudgeDir)).toBe(false);
            await Bun.sleep(50);
            expect({ what: c.what, warnings: nudgeWarnings(h).length }).toEqual({ what: c.what, warnings: 1 });
            expect({ what: c.what, says: nudgeWarnings(h)[0]!.includes(c.says(h)) }).toEqual({ what: c.what, says: true });
            expect(problems(h)).toEqual(nudgeWarnings(h));
            // The one line: its commands log nothing themselves (in production, runCommand would add its own warning)
            expect({ what: c.what, quiet: h.quietRuns }).toEqual({ what: c.what, quiet: h.runs.map(() => true) });
            // The drive is untouched, and shows mounted
            expect(h.runs.flat()).not.toContain(h.mountpoint);
            expect(driveMounted(h)).toBe(1);
            expect(h.procs[0]!.kills).toEqual([]);
            expect(h.supervisor.status()).toEqual({ mode: 'virtual', mounted: true, reason: null });
        }
    });

    test('a nudge mount left by an earlier session is unmounted lazily first; one that is not ours stops the nudge', async () => {
        const left = harness({ nudge: {} });
        mkdirSync(left.nudgeMnt, { recursive: true });
        writeFileSync(path.join(left.nudgeDir, 'leftover'), 'x');
        left.mounts.push(mountLine(7, left.nudgeMnt, 'fuse.protondrive', 'protondrive'));
        await left.supervisor.start();
        await nudged(left);
        expect(left.runs).toEqual([lazyUnmountNudge(left), unmountNudge(left)]);
        expect(left.nudgeSpawns[0]!.mountpointEntries).toEqual([]);
        expect(left.nudgeMounts()).toEqual([]);

        const foreign = harness({ nudge: {} });
        mkdirSync(foreign.nudgeMnt, { recursive: true });
        foreign.mounts.push(mountLine(7, foreign.nudgeMnt, 'fuse.sshfs', 'me@host:'));
        await foreign.supervisor.start();
        await until(() => nudgeWarnings(foreign).length === 1);
        await Bun.sleep(50);
        expect(foreign.nudgeSpawns).toEqual([]);
        expect(foreign.runs).toEqual([]);
        expect(foreign.nudgeMounts()).toHaveLength(1);
        expect(existsSync(foreign.nudgeMnt)).toBe(true); // never removed from under a mount
        expect(foreign.supervisor.status().mounted).toBe(true);
    });

    test("a link where the nudge's folder goes is removed, never followed", async () => {
        const h = harness({ nudge: {} });
        const elsewhere = path.join(h.root, 'elsewhere');
        mkdirSync(path.join(elsewhere, 'mnt'), { recursive: true });
        writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
        symlinkSync(elsewhere, h.nudgeDir);
        await h.supervisor.start();
        await nudged(h);
        expect(h.nudgeSpawns[0]!.dirIsLink).toBe(false);
        expect(h.nudgeSpawns[0]!.dirMode).toBe(0o700);
        expect(readdirSync(elsewhere).sort()).toEqual(['keep.txt', 'mnt']);
        expect(problems(h)).toEqual([]);
    });

    test('a drive folder overlapping where the nudge would mount is never nudged', async () => {
        const h = harness({ nudge: {}, paths: (root) => ({ mountpoint: path.join(root, '.nudge', 'mnt') }) });
        await h.supervisor.start();
        await until(() => h.supervisor.status().mounted);
        await until(() => nudgeWarnings(h).length === 1);
        await Bun.sleep(50);
        expect(h.nudgeSpawns).toEqual([]);
        expect(h.runs).toEqual([]);
        expect(driveMounted(h)).toBe(1);
    });

    test('stop waits for a nudge on its way, so nothing is left mounted', async () => {
        let release!: () => void;
        const h = harness({ nudge: { unmountGate: new Promise<void>((resolve) => (release = resolve)) } });
        await h.supervisor.start();
        await until(() => h.nudgeRuns().length === 1);
        setTimeout(release, 50);
        await h.supervisor.stop();
        expect(h.nudgeMounts()).toEqual([]);
        expect(h.nudgeProcs.every((p) => !p.alive)).toBe(true);
        expect(existsSync(h.nudgeDir)).toBe(false);
        expect(driveMounted(h)).toBe(0);
    });

    test('runCommand warns of a failed command with its stderr, unless asked to be quiet', async () => {
        const logs: string[] = [];
        const logger = { debug: () => {}, info: () => {}, warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
        const failing = ['sh', '-c', 'echo busy >&2; exit 3'];
        expect(await runCommand(failing, logger, { quiet: true })).toBe(3);
        expect(logs).toEqual([]);
        expect(await runCommand(failing, logger)).toBe(3);
        expect(logs).toEqual(['sh -c echo busy >&2; exit 3 failed (3): busy']);
        expect(await runCommand(['true'], logger)).toBe(0);
        expect(logs).toHaveLength(1);
    });

    test('the nudge waits 5 s for its mount by default', () => {
        expect(DEFAULT_VFS_TIMING.nudgeWaitMs).toBe(5000);
    });
});

describe('mergeStrayInto', () => {
    const when = new Date(2026, 9, 26, 14, 5, 9);

    function dirs() {
        const root = tempRoot();
        const mountpoint = path.join(root, 'ProtonDrive');
        const backing = path.join(root, 'files');
        mkdirSync(mountpoint);
        mkdirSync(backing);
        const put = (p: string, content: string) => {
            mkdirSync(path.dirname(p), { recursive: true });
            writeFileSync(p, content);
        };
        return { mountpoint, backing, put, read: (p: string) => readFileSync(p, 'utf8') };
    }

    test('merges recursively: a new entry moves, a folder already in the store is merged into, a taken name gets a conflict name', () => {
        const { mountpoint: mp, backing: b, put, read } = dirs();
        put(path.join(b, 'Docs', 'same.txt'), 'cloud copy');
        put(path.join(b, 'Docs', 'Sub', 'kept.txt'), 'kept');
        put(path.join(mp, 'Docs', 'same.txt'), 'saved while down');
        put(path.join(mp, 'Docs', 'new.txt'), 'new');
        put(path.join(mp, 'Docs', 'Sub', 'deep.txt'), 'deep');
        put(path.join(mp, 'Docs', 'Fresh', 'f.txt'), 'f');

        expect(mergeStrayInto(path.join(mp, 'Docs'), mp, b, when)).toEqual([
            path.join(b, 'Docs', formatConflictFileName('same.txt', when)),
        ]);

        expect(existsSync(path.join(mp, 'Docs'))).toBe(false);
        expect(read(path.join(b, 'Docs', 'same.txt'))).toBe('cloud copy');
        expect(read(path.join(b, 'Docs', formatConflictFileName('same.txt', when)))).toBe('saved while down');
        expect(read(path.join(b, 'Docs', 'new.txt'))).toBe('new');
        expect(read(path.join(b, 'Docs', 'Sub', 'deep.txt'))).toBe('deep');
        expect(read(path.join(b, 'Docs', 'Sub', 'kept.txt'))).toBe('kept');
        expect(read(path.join(b, 'Docs', 'Fresh', 'f.txt'))).toBe('f');
    });

    test('a folder over a file of its name, or a file over a folder, gets a conflict name', () => {
        const { mountpoint: mp, backing: b, put, read } = dirs();
        put(path.join(b, 'Photos'), 'a file in the store');
        put(path.join(mp, 'Photos', 'p.jpg'), 'jpg');
        mkdirSync(path.join(b, 'Music'));
        put(path.join(mp, 'Music'), 'a file in the mount point');

        mergeStrayInto(path.join(mp, 'Photos'), mp, b, when);
        mergeStrayInto(path.join(mp, 'Music'), mp, b, when);

        expect(read(path.join(b, 'Photos'))).toBe('a file in the store');
        expect(read(path.join(b, formatConflictFileName('Photos', when), 'p.jpg'))).toBe('jpg');
        expect(statSync(path.join(b, 'Music')).isDirectory()).toBe(true);
        expect(read(path.join(b, formatConflictFileName('Music', when)))).toBe('a file in the mount point');
    });

    test('a conflict name that is taken too gets a counter, and nothing is replaced', () => {
        const { mountpoint: mp, backing: b, put, read } = dirs();
        const conflict = formatConflictFileName('a.txt', when);
        put(path.join(b, 'a.txt'), 'cloud');
        put(path.join(b, conflict), 'an earlier conflict');
        put(path.join(mp, 'a.txt'), 'mine');

        mergeStrayInto(path.join(mp, 'a.txt'), mp, b, when);

        expect(read(path.join(b, 'a.txt'))).toBe('cloud');
        expect(read(path.join(b, conflict))).toBe('an earlier conflict');
        expect(read(path.join(b, conflict.replace(/\.txt$/, '-1.txt')))).toBe('mine');
    });

    test('a symlink moves as a link and is never followed into the store', () => {
        const { mountpoint: mp, backing: b } = dirs();
        mkdirSync(path.join(b, 'Docs'));
        symlinkSync('/etc', path.join(mp, 'Docs'));
        mergeStrayInto(path.join(mp, 'Docs'), mp, b, when);
        expect(statSync(path.join(b, 'Docs')).isDirectory()).toBe(true);
        expect(readdirSync(path.join(b, 'Docs'))).toEqual([]);
        expect(existsSync(path.join(b, formatConflictFileName('Docs', when)))).toBe(true);
    });

    test('an entry that cannot be moved throws, and both copies stay where they were', () => {
        const { mountpoint: mp, backing: b, put, read } = dirs();
        put(path.join(b, 'Docs', 'cloud.txt'), 'cloud');
        put(path.join(mp, 'Docs', 'mine.txt'), 'mine');
        chmodSync(path.join(mp, 'Docs'), 0o555);
        expect(() => mergeStrayInto(path.join(mp, 'Docs'), mp, b, when)).toThrow(/EACCES|permission/i);
        expect(read(path.join(mp, 'Docs', 'mine.txt'))).toBe('mine');
        expect(read(path.join(b, 'Docs', 'cloud.txt'))).toBe('cloud');
        expect(readdirSync(path.join(b, 'Docs'))).toEqual(['cloud.txt']);
    });

    test('refuses a path outside the mount point, but not a name starting with two dots', () => {
        const { mountpoint: mp, backing: b, put, read } = dirs();
        expect(() => mergeStrayInto(path.join(path.dirname(mp), 'elsewhere'), mp, b, when)).toThrow();
        expect(() => mergeStrayInto(mp, mp, b, when)).toThrow();
        expect(() => mergeStrayInto(path.dirname(mp), mp, b, when)).toThrow();
        put(path.join(mp, '..notes'), 'n');
        mergeStrayInto(path.join(mp, '..notes'), mp, b, when);
        expect(read(path.join(b, '..notes'))).toBe('n');
    });
});

describe('mountsAt', () => {
    test('lists the file system types mounted exactly at a path, octal escapes decoded, in mount order', () => {
        const info = [
            mountLine(1, '/', 'ext4', '/dev/sda1'),
            mountLine(2, '/home/me/Proton Drive', 'fuse.protondrive', 'protondrive'),
            mountLine(3, '/home/me/Proton Drive', 'fuse.sshfs'),
            mountLine(4, '/home/me/Proton', 'fuse.protondrive'),
            mountLine(5, '/home/me/Proton Drive/sub', 'tmpfs'),
            mountLine(6, '/home/me/back\\slash', 'tmpfs'),
            '',
        ].join('\n');
        expect(mountsAt(info, '/home/me/Proton Drive')).toEqual(['fuse.protondrive', 'fuse.sshfs']);
        expect(mountsAt(info, '/home/me/Proton')).toEqual(['fuse.protondrive']);
        expect(mountsAt(info, '/home/me')).toEqual([]);
        expect(mountsAt(info, '/home/me/back\\slash')).toEqual(['tmpfs']);
    });

    test('reads optional fields up to the separator', () => {
        const info = '36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 propagate_from:2 - fuse.protondrive protondrive rw\n';
        expect(mountsAt(info, '/mnt/parent')).toEqual(['fuse.protondrive']);
        expect(mountsAt('37 35 98:0 / /mnt/x rw - ext4 /dev/sda1 rw\n', '/mnt/x')).toEqual(['ext4']);
    });

    test('compares bytes, so a non-ASCII mount point matches the kernel text exactly', () => {
        const mp = '/home/me/Prôton Drive';
        const raw = Buffer.from(`${mountLine(2, mp, 'fuse.protondrive')}\n`, 'utf8').toString('latin1');
        expect(mountsAt(raw, mp)).toEqual(['fuse.protondrive']);
        expect(mountsAt(raw, '/home/me/Proton Drive')).toEqual([]);
    });

    test('mountsUnder lists what is mounted at a folder or anywhere under it, never beside it', () => {
        const info = [
            mountLine(1, '/', 'ext4', '/dev/sda1'),
            mountLine(2, '/run/u/pd/.nudge/mnt', 'fuse.protondrive', 'protondrive'),
            mountLine(3, '/run/u/pd/.nudge', 'tmpfs'),
            mountLine(4, '/run/u/pd/.nudge2', 'tmpfs'),
            mountLine(5, '/run/u/pd/.nudge/a b/é', 'fuse.sshfs'),
            '',
        ].join('\n');
        const raw = Buffer.from(info, 'utf8').toString('latin1');
        expect(mountsUnder(raw, '/run/u/pd/.nudge')).toEqual([
            ['/run/u/pd/.nudge/mnt', 'fuse.protondrive'],
            ['/run/u/pd/.nudge', 'tmpfs'],
            ['/run/u/pd/.nudge/a b/é', 'fuse.sshfs'],
        ]);
        expect(mountsUnder(raw, '/run/u/pd/.nudge/mnt')).toEqual([['/run/u/pd/.nudge/mnt', 'fuse.protondrive']]);
        expect(mountsUnder(raw, '/run/u/other')).toEqual([]);
    });
});

describe('fuseAvailable and findHelper', () => {
    test('fuseAvailable is false when the helper is missing or not executable', () => {
        const root = tempRoot();
        const notExec = path.join(root, 'protondrive-vfs');
        writeFileSync(notExec, '#!/bin/sh\n');
        chmodSync(notExec, 0o644);
        expect(fuseAvailable(null)).toBe(false);
        expect(fuseAvailable(path.join(root, 'missing'))).toBe(false);
        expect(fuseAvailable(notExec)).toBe(false);
        expect(fuseAvailable(root)).toBe(false); // a folder isn't a helper
    });

    test('fuseAvailable needs /dev/fuse and fusermount3 as well as the helper', () => {
        const root = tempRoot();
        const helper = path.join(root, 'protondrive-vfs');
        writeFileSync(helper, '#!/bin/sh\n');
        chmodSync(helper, 0o755);
        const savedPath = process.env.PATH;
        try {
            process.env.PATH = root; // no fusermount3 here
            expect(fuseAvailable(helper)).toBe(false);
        } finally {
            process.env.PATH = savedPath;
        }
    });

    test('findHelper: $PROTON_DRIVE_VFS_BIN wins, else next to the running binary, else PATH', () => {
        const root = tempRoot();
        const onPath = path.join(root, 'protondrive-vfs');
        writeFileSync(onPath, '#!/bin/sh\n');
        chmodSync(onPath, 0o755);
        const saved = { bin: process.env.PROTON_DRIVE_VFS_BIN, path: process.env.PATH };
        try {
            process.env.PROTON_DRIVE_VFS_BIN = '/opt/custom/protondrive-vfs';
            expect(findHelper()).toBe('/opt/custom/protondrive-vfs');
            delete process.env.PROTON_DRIVE_VFS_BIN;
            process.env.PATH = `/nonexistent:${root}`;
            const nextToBun = path.join(path.dirname(process.execPath), 'protondrive-vfs');
            expect(findHelper()).toBe(existsSync(nextToBun) ? nextToBun : onPath);
            process.env.PATH = '/nonexistent';
            expect(findHelper()).toBe(existsSync(nextToBun) ? nextToBun : null);
        } finally {
            if (saved.bin === undefined) delete process.env.PROTON_DRIVE_VFS_BIN;
            else process.env.PROTON_DRIVE_VFS_BIN = saved.bin;
            process.env.PATH = saved.path;
        }
    });
});

describe('notMountableReason', () => {
    test('says why Mount again has nothing to mount', () => {
        expect(notMountableReason({ mode: 'plain', mounted: false, reason: 'switched-off' })).toMatch(/switched off/);
        expect(notMountableReason({ mode: 'plain', mounted: false, reason: 'fuse-unavailable' })).toMatch(/FUSE/);
        expect(notMountableReason({ mode: 'virtual', mounted: false, reason: 'fuse-unavailable' })).toMatch(/FUSE/);
        expect(notMountableReason({ mode: 'virtual', mounted: false, reason: 'mount-point-busy' })).toMatch(/control socket/);
        expect(notMountableReason({ mode: 'plain', mounted: false, reason: null })).toMatch(/plain folder/);
    });
});

describe('unsupervisedStatus', () => {
    test('plain layout: switched off, FUSE unavailable, or neither', () => {
        expect(unsupervisedStatus('plain', false, true)).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
        expect(unsupervisedStatus('plain', false, false)).toEqual({ mode: 'plain', mounted: false, reason: 'switched-off' });
        expect(unsupervisedStatus('plain', true, false)).toEqual({ mode: 'plain', mounted: false, reason: 'fuse-unavailable' });
        expect(unsupervisedStatus('plain', true, true)).toEqual({ mode: 'plain', mounted: false, reason: null });
    });

    test('virtual layout without FUSE cannot mount', () => {
        expect(unsupervisedStatus('virtual', true, false)).toEqual({ mode: 'virtual', mounted: false, reason: 'fuse-unavailable' });
    });
});

// Real mounts of the built helper over temp dirs, with a fake daemon on a temp socket; only with
// PROTONDRIVE_VFS_MOUNT_TESTS=1. Everything on the mount goes through async fs (this process also answers the helper),
// every await is bounded so a failure always reaches the cleanup, and the cleanup always unmounts.
const MOUNT_TESTS = process.env.PROTONDRIVE_VFS_MOUNT_TESTS === '1';
const REAL_HELPER = path.resolve(import.meta.dir, '../native-vfs/target/release/protondrive-vfs');

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms))),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function realMount(linked: boolean, opts: { nudge?: boolean } = {}) {
    if (!existsSync(REAL_HELPER)) throw new Error(`Build the helper first (cargo build --release): ${REAL_HELPER}`);
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    const backing = path.join(appDir, 'files');
    const mountpoint = path.join(root, 'Proton Drive');
    const target = linked ? path.join(root, 'real drive') : mountpoint; // where the mount really is
    const socketPath = path.join(root, 'control.sock');
    mkdirSync(backing, { recursive: true });
    mkdirSync(target);
    chmodSync(target, 0o555);
    if (linked) symlinkSync(target, mountpoint);
    writeFileSync(path.join(backing, 'local.txt'), 'here');
    const daemon = Bun.serve({
        unix: socketPath,
        fetch(req) {
            if (new URL(req.url).pathname === '/vfs/children') return Response.json({ entries: [] });
            return Response.json({ error: 'Not found', code: 'ENOENT' }, { status: 404 });
        },
    });
    const isMounted = () => mountsAt(readFileSync('/proc/self/mountinfo', 'latin1'), target).length > 0;
    const spawned: Subprocess[] = [];
    const commands: string[][] = [];
    const orphans: Subprocess[] = [];
    const logs: string[] = [];
    const log = (level: string) => (m: string) => logs.push(`${level} ${m}`);
    const supervisor = new VfsSupervisor({
        mountpoint,
        backingDir: backing,
        appDir,
        socketPath,
        helperPath: REAL_HELPER,
        logPath: path.join(appDir, 'vfs.log'),
        logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
        mergeStray: async (fullPath) => {
            mergeStrayInto(fullPath, mountpoint, backing);
        },
        spawn: ((cmd: string[], o: object) => {
            commands.push(cmd);
            const proc = Bun.spawn(cmd, o);
            spawned.push(proc);
            return proc;
        }) as unknown as typeof Bun.spawn,
        timing: { restartDelaysMs: [200, 200, 200], stopWaitMs: 2000, mountPollMs: 20 },
        nudge: opts.nudge,
    });
    // Never throws: stops, kills what is left, unmounts the temp mount point; answers what it couldn't clean up
    const cleanup = async (): Promise<string[]> => {
        const problems: string[] = [];
        await within(supervisor.stop(), 15_000, 'stop').catch((err: unknown) => problems.push(String(err)));
        for (const proc of [...spawned, ...orphans]) {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        }
        for (let i = 0; i < 5 && isMounted(); i++) Bun.spawnSync(['fusermount3', '-u', '-z', target]);
        // A nudge's mount too, beside the temp socket: only ever our own, and only under the temp root
        for (const [at, fstype] of mountsUnder(readFileSync('/proc/self/mountinfo', 'latin1'), root)) {
            if (fstype === 'fuse.protondrive') Bun.spawnSync(['fusermount3', '-u', '-z', at]);
        }
        void daemon.stop(true);
        if (readFileSync('/proc/self/mounts', 'utf8').includes(root)) problems.push(`still mounted under ${root}`);
        return problems;
    };
    return { root, mountpoint, target, backing, socketPath, supervisor, spawned, commands, orphans, isMounted, logs, cleanup };
}

// Runs the body, then always the cleanup; a failure is reported as it was, after the cleanup has run
async function withRealMount(
    linked: boolean,
    body: (m: ReturnType<typeof realMount>) => Promise<void>,
    opts: { nudge?: boolean } = {},
): Promise<void> {
    const m = realMount(linked, opts);
    let failure: unknown = null;
    try {
        await body(m);
    } catch (err) {
        failure = err;
    }
    const problems = await m.cleanup();
    if (failure) {
        if (failure instanceof Error) failure.message += `\ncleanup: ${problems.join('; ') || 'clean'}\n${m.logs.join('\n')}`;
        throw failure;
    }
    expect(problems).toEqual([]);
}

describe.skipIf(!MOUNT_TESTS)('VfsSupervisor with the real helper', () => {
    test(
        'kill -9 leaves no lasting ENOTCONN, an eject ends at 0555, an orphan helper is taken over, and stop unmounts',
        () =>
            withRealMount(false, async ({ mountpoint, backing, socketPath, supervisor, spawned, orphans, isMounted }) => {
                await within(supervisor.start(), 15_000, 'start');
                await until(() => supervisor.status().mounted, 10_000);
                expect(await within(readdir(mountpoint), 5000, 'readdir')).toContain('local.txt');

                // kill -9 of the helper: its dead mount is cleared and a new helper mounts
                process.kill(spawned[0]!.pid, 'SIGKILL');
                await until(() => spawned.length === 2 && supervisor.status().mounted, 10_000);
                expect(statSync(mountpoint).isDirectory()).toBe(true);
                expect(await within(readdir(mountpoint), 5000, 'readdir')).toContain('local.txt');

                // Eject, as Files does
                expect(Bun.spawnSync(['fusermount3', '-u', mountpoint]).exitCode).toBe(0);
                expect(await within(spawned[1]!.exited, 5000, 'helper exit after eject')).toBe(0);
                await until(() => supervisor.status().reason === 'ejected', 5000);
                expect(modeOf(mountpoint)).toBe(0o555);
                expect(isMounted()).toBe(false);
                await within(supervisor.stop(), 15_000, 'stop');

                // A helper that outlived a killed daemon still holds a live mount: the next start takes it over
                chmodSync(mountpoint, 0o700);
                const orphan = Bun.spawn([REAL_HELPER, '--mountpoint', mountpoint, '--backing', backing, '--socket', socketPath], {
                    stdin: 'ignore',
                    stdout: 'ignore',
                    stderr: 'ignore',
                });
                orphans.push(orphan);
                await until(isMounted, 10_000);
                await within(supervisor.start(), 15_000, 'start over the orphan');
                expect(await within(orphan.exited, 5000, 'orphan exit')).toBe(0);
                await until(() => supervisor.status().mounted, 10_000);
                expect(await within(readdir(mountpoint), 5000, 'readdir')).toContain('local.txt');

                await within(supervisor.stop(), 15_000, 'stop');
                expect(isMounted()).toBe(false);
                expect(modeOf(mountpoint)).toBe(0o555);
                expect(spawned[2]!.exitCode).toBe(0); // its session ended with the unmount, not a kill
            }),
        60_000,
    );

    test(
        'a symlinked sync folder: kill -9 recovers with no lasting ENOTCONN, and stop unmounts',
        () =>
            withRealMount(true, async ({ mountpoint, target, supervisor, spawned, isMounted }) => {
                await within(supervisor.start(), 15_000, 'start');
                await until(() => supervisor.status().mounted, 10_000);
                expect(isMounted()).toBe(true); // at the canonical path
                expect(await within(readdir(mountpoint), 5000, 'readdir')).toContain('local.txt');

                process.kill(spawned[0]!.pid, 'SIGKILL');
                await until(() => spawned.length === 2 && supervisor.status().mounted, 10_000);
                expect(statSync(mountpoint).isDirectory()).toBe(true);
                expect(await within(readdir(mountpoint), 5000, 'readdir')).toContain('local.txt');

                await within(supervisor.stop(), 15_000, 'stop');
                expect(isMounted()).toBe(false);
                expect(spawned[1]!.exitCode).toBe(0); // unmounted, not killed
                expect(statSync(mountpoint).isDirectory()).toBe(true);
                expect(modeOf(target)).toBe(0o555);
            }),
        60_000,
    );

    // #49: the nudge, for real: the same helper mounts beside the control socket (here in the temp root) and is
    // unmounted at once, its session ending with that; mountinfo, read straight from the kernel, then shows the drive
    // alone, and nothing at all once it stops
    test(
        'a real nudge leaves nothing mounted but the drive, and stop leaves nothing at all',
        () =>
            withRealMount(
                false,
                async ({ root, mountpoint, socketPath, supervisor, spawned, commands, isMounted }) => {
                    const nudgeDir = path.join(path.dirname(socketPath), '.nudge');
                    const mounted = () => mountsUnder(readFileSync('/proc/self/mountinfo', 'latin1'), root);
                    await within(supervisor.start(), 15_000, 'start');
                    await until(() => supervisor.status().mounted, 10_000);
                    await until(() => spawned.length === 2 && spawned[1]!.exitCode !== null && !existsSync(nudgeDir), 15_000);
                    expect(spawned[1]!.exitCode).toBe(0); // unmounted, not killed
                    expect(commands[1]).toEqual([
                        REAL_HELPER,
                        '--mountpoint',
                        path.join(nudgeDir, 'mnt'),
                        '--backing',
                        path.join(nudgeDir, 'store'),
                        '--socket',
                        path.join(nudgeDir, 'no-daemon.sock'),
                    ]);
                    expect(mounted()).toEqual([[mountpoint, 'fuse.protondrive']]);
                    expect(isMounted()).toBe(true);
                    expect(await within(readdir(mountpoint), 5000, 'readdir')).toContain('local.txt');

                    await within(supervisor.stop(), 15_000, 'stop');
                    expect(mounted()).toEqual([]);
                },
                { nudge: true },
            ),
        60_000,
    );

    // #49, as Files sees it: GLib's mount monitor in another process (python3 with gi, when present) is told of a mount
    // change once the drive mounts, and the drive is in GLib's list of mounts then
    const GLIB_WATCH = `
import sys, warnings
warnings.simplefilter('ignore')
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
want, seconds = sys.argv[1], int(sys.argv[2])
loop = GLib.MainLoop()
def listed():
    mounts = Gio.unix_mounts_get()[0]
    return any(m.get_mount_path() == want for m in mounts)
def changed(*_):
    if listed():
        print('listed', flush=True)
        loop.quit()
monitor = Gio.UnixMountMonitor.get()
monitor.connect('mounts-changed', changed)
def give_up():
    print('not listed', flush=True)
    loop.quit()
GLib.timeout_add_seconds(seconds, give_up)
GLib.idle_add(lambda: print('ready', flush=True) and False)
loop.run()
`;
    const hasGi = Bun.spawnSync(['python3', '-I', '-c', 'import gi; gi.require_version("Gio", "2.0")']).exitCode === 0;
    test.skipIf(!hasGi)(
        "GLib's mount monitor hears of the drive's mount, with the drive in its list then",
        () =>
            withRealMount(
                false,
                async ({ mountpoint, supervisor }) => {
                    const watch = Bun.spawn(['python3', '-I', '-c', GLIB_WATCH, mountpoint, '15'], { stdout: 'pipe', stderr: 'ignore' });
                    try {
                        const reader = watch.stdout.getReader();
                        let said = '';
                        const nextLine = async () => {
                            while (!said.includes('\n')) {
                                const { value, done } = await within(reader.read(), 20_000, 'GLib watcher');
                                if (done) break;
                                said += new TextDecoder().decode(value);
                            }
                            const [line, ...rest] = said.split('\n');
                            said = rest.join('\n');
                            return line;
                        };
                        expect(await nextLine()).toBe('ready');
                        await within(supervisor.start(), 15_000, 'start');
                        expect(await nextLine()).toBe('listed');
                    } finally {
                        watch.kill('SIGKILL');
                    }
                },
                { nudge: true },
            ),
        60_000,
    );
});
