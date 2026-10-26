import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
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
    unsupervisedStatus,
    VfsSupervisor,
    type VfsTiming,
} from '../src/daemon/vfsSupervisor';
import { formatConflictFileName } from '../src/sync/conflictResolver';

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

const FAST: VfsTiming = { restartDelaysMs: [20, 40, 60], crashWindowMs: 60_000, unmountWaitMs: 300, stopWaitMs: 100, mountPollMs: 5 };

interface SpawnCall {
    cmd: string[];
    stdout: unknown;
    stderr: unknown;
    mode: number;
    entries: string[];
    mountsAtSpawn: number;
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
} = {}) {
    const root = tempRoot();
    const mountpoint = path.join(root, 'Proton Drive');
    // mountinfo and the helper use the canonical path
    const target = opts.linkedMountpoint ? path.join(root, 'real drive') : mountpoint;
    const backing = path.join(root, 'files');
    const logPath = path.join(root, 'vfs.log');
    if (!opts.noMountpoint) {
        mkdirSync(target);
        chmodSync(target, opts.mountpointMode ?? 0o555);
        if (target !== mountpoint) symlinkSync(target, mountpoint);
    }
    mkdirSync(backing);
    const mounts: string[] = opts.mounts ? opts.mounts(target) : [];
    let nextId = 100;
    let spawnThrows = opts.spawnThrows ?? 0;
    const runs: string[][] = [];
    const procs: FakeProc[] = [];
    const spawns: SpawnCall[] = [];
    const merged: Array<{ path: string; mountsThen: number }> = [];
    const logs: string[] = [];
    const ours = (line: string) => line.includes(' - fuse.protondrive ');
    const at = (line: string) => line.split(' ')[4] === target.replace(/ /g, '\\040');
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
        async run(cmd: string[]) {
            runs.push(cmd);
            if (cmd[0] === 'fusermount3' && cmd[cmd.length - 1] === mountpoint) {
                removeOneOurs();
                // The session of a live helper ends when its mount goes
                if (opts.exitsOnUnmount !== false) {
                    for (const proc of procs) proc.finish(0);
                }
            }
            return 0;
        },
        readMountInfo: () => mounts.join('\n') + '\n',
        stat: opts.stat ? (p: string) => opts.stat!(p, runs) : undefined,
        timing: { ...FAST, ...opts.timing },
    });
    cleanups.push(() => supervisor.stop());
    // The user ejects the drive in Files: the kernel ends the session, the helper exits 0
    const eject = () => {
        removeOneOurs();
        procs[procs.length - 1]!.finish(0);
    };
    // The helper dies (exit code, or a signal), leaving its mount behind dead
    const crash = (code: number | null = 1, signal: string | null = null) => procs[procs.length - 1]!.finish(code, signal);
    return { root, mountpoint, backing, logPath, mounts, runs, procs, spawns, merged, logs, supervisor, eject, crash };
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
        expect(orphan.runs).toEqual([fusermount(orphan.mountpoint)]);
        expect(orphan.spawns).toHaveLength(1);
        await until(() => orphan.supervisor.status().mounted);
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

    test('a helper that cannot be started counts as a crash', async () => {
        const h = harness({ spawnThrows: 2 });
        await h.supervisor.start();
        expect(h.supervisor.status().reason).toBe('starting');
        expect(modeOf(h.mountpoint)).toBe(0o555);
        await until(() => h.supervisor.status().mounted);
        expect(h.spawns).toHaveLength(3);
        expect(modeOf(h.mountpoint)).toBe(0o700);
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

    test('refuses a path outside the mount point', () => {
        const { mountpoint: mp, backing: b } = dirs();
        expect(() => mergeStrayInto(path.join(path.dirname(mp), 'elsewhere'), mp, b, when)).toThrow();
        expect(() => mergeStrayInto(mp, mp, b, when)).toThrow();
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

// A real mount of the built helper over temp dirs, with a fake daemon on a temp socket; only with
// PROTONDRIVE_VFS_MOUNT_TESTS=1. Everything on the mount goes through async fs: this process also answers the helper.
const MOUNT_TESTS = process.env.PROTONDRIVE_VFS_MOUNT_TESTS === '1';
const REAL_HELPER = path.resolve(import.meta.dir, '../native-vfs/target/release/protondrive-vfs');

describe.skipIf(!MOUNT_TESTS)('VfsSupervisor with the real helper', () => {
    test(
        'kill -9 leaves no lasting ENOTCONN, an eject ends at 0555, an orphan helper is taken over, and stop unmounts',
        async () => {
            if (!existsSync(REAL_HELPER)) throw new Error(`Build the helper first (cargo build --release): ${REAL_HELPER}`);
            const root = tempRoot();
            const mountpoint = path.join(root, 'Proton Drive');
            const backing = path.join(root, 'files');
            const socketPath = path.join(root, 'control.sock');
            mkdirSync(mountpoint);
            chmodSync(mountpoint, 0o555);
            mkdirSync(backing);
            writeFileSync(path.join(backing, 'local.txt'), 'here');
            const daemon = Bun.serve({
                unix: socketPath,
                fetch(req) {
                    if (new URL(req.url).pathname === '/vfs/children') return Response.json({ entries: [] });
                    return Response.json({ error: 'Not found', code: 'ENOENT' }, { status: 404 });
                },
            });
            const isMounted = () => mountsAt(readFileSync('/proc/self/mountinfo', 'latin1'), mountpoint).length > 0;
            const spawned: Subprocess[] = [];
            let orphan: Subprocess | null = null;
            const supervisor = new VfsSupervisor({
                mountpoint,
                backingDir: backing,
                socketPath,
                helperPath: REAL_HELPER,
                logPath: path.join(root, 'vfs.log'),
                logger: { debug() {}, info() {}, warn() {}, error() {} },
                mergeStray: async (fullPath) => {
                    mergeStrayInto(fullPath, mountpoint, backing);
                },
                spawn: ((cmd: string[], o: object) => {
                    const proc = Bun.spawn(cmd, o);
                    spawned.push(proc);
                    return proc;
                }) as unknown as typeof Bun.spawn,
                timing: { restartDelaysMs: [200, 200, 200], stopWaitMs: 2000, mountPollMs: 20 },
            });
            try {
                await supervisor.start();
                await until(() => supervisor.status().mounted, 10_000);
                expect(await readdir(mountpoint)).toContain('local.txt');

                // kill -9 of the helper: its dead mount is cleared and a new helper mounts
                process.kill(spawned[0]!.pid, 'SIGKILL');
                await until(() => spawned.length === 2 && supervisor.status().mounted, 10_000);
                expect(statSync(mountpoint).isDirectory()).toBe(true);
                expect(await readdir(mountpoint)).toContain('local.txt');

                // Eject, as Files does
                expect(Bun.spawnSync(['fusermount3', '-u', mountpoint]).exitCode).toBe(0);
                expect(await spawned[1]!.exited).toBe(0);
                await until(() => supervisor.status().reason === 'ejected', 5000);
                expect(modeOf(mountpoint)).toBe(0o555);
                expect(isMounted()).toBe(false);
                await supervisor.stop();

                // A helper that outlived a killed daemon still holds a live mount: the next start takes it over
                chmodSync(mountpoint, 0o700);
                orphan = Bun.spawn([REAL_HELPER, '--mountpoint', mountpoint, '--backing', backing, '--socket', socketPath], {
                    stdin: 'ignore',
                    stdout: 'ignore',
                    stderr: 'ignore',
                });
                await until(isMounted, 10_000);
                await supervisor.start();
                expect(await orphan.exited).toBe(0);
                await until(() => supervisor.status().mounted, 10_000);
                expect(await readdir(mountpoint)).toContain('local.txt');

                await supervisor.stop();
                expect(isMounted()).toBe(false);
                expect(modeOf(mountpoint)).toBe(0o555);
                expect(spawned.every((proc) => proc.exitCode !== null || proc.signalCode !== null)).toBe(true);
            } finally {
                await supervisor.stop();
                for (const proc of [...spawned, orphan]) {
                    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
                }
                for (let i = 0; i < 5 && isMounted(); i++) Bun.spawnSync(['fusermount3', '-u', '-z', mountpoint]);
                void daemon.stop(true);
                expect(readFileSync('/proc/self/mounts', 'utf8')).not.toContain(root);
            }
        },
        60_000,
    );
});
