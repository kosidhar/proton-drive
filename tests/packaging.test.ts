import { describe, expect, test } from 'bun:test';
import {
    accessSync,
    constants,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKGBUILD = path.join(import.meta.dir, '..', 'packaging', 'linux', 'arch', 'PKGBUILD');

function put(file: string, body = 'x', mode = 0o644): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, { mode });
}

describe('Arch PKGBUILD package()', () => {
    test('installs the tarball bin, share and lib into /usr, and never install.sh', () => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'pd-pkgbuild-'));
        try {
            // The PKGBUILD sets pkgver itself, so read it from there.
            const ver = Bun.spawnSync(['bash', '-c', 'source "$1" && printf %s "$pkgver"', 'bash', PKGBUILD])
                .stdout.toString();
            expect(ver).not.toBe('');

            const srcdir = path.join(tmp, 'src');
            const pkgdir = path.join(tmp, 'pkg');
            const root = path.join(srcdir, `kosidhar-protondrive-${ver}-linux-x86_64`);
            put(path.join(root, 'bin', 'protondrive'), '#!/bin/sh\n', 0o755);
            put(path.join(root, 'share', 'applications', 'x.desktop'));
            symlinkSync('x.desktop', path.join(root, 'share', 'applications', 'link.desktop'));
            put(path.join(root, 'lib', 'systemd', 'user', 'protondrive.service'));
            put(path.join(root, 'install.sh'), '#!/bin/sh\n', 0o755);
            mkdirSync(pkgdir, { recursive: true });

            // Source the real PKGBUILD in a subshell and run its package().
            const run = Bun.spawnSync(['bash', '-c', 'source "$1" && package', 'bash', PKGBUILD], {
                env: { ...process.env, srcdir, pkgdir, CARCH: 'x86_64' },
                stdout: 'pipe',
                stderr: 'pipe',
            });
            expect(run.exitCode).toBe(0);

            const usr = path.join(pkgdir, 'usr');
            expect(existsSync(path.join(usr, 'bin', 'protondrive'))).toBe(true);
            expect(() => accessSync(path.join(usr, 'bin', 'protondrive'), constants.X_OK)).not.toThrow();
            expect(existsSync(path.join(usr, 'share', 'applications', 'x.desktop'))).toBe(true);
            const link = path.join(usr, 'share', 'applications', 'link.desktop');
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
            expect(readlinkSync(link)).toBe('x.desktop');
            expect(existsSync(path.join(usr, 'lib', 'systemd', 'user', 'protondrive.service'))).toBe(true);
            expect(existsSync(path.join(usr, 'install.sh'))).toBe(false);
            expect(readdirSync(usr).sort()).toEqual(['bin', 'lib', 'share']);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
