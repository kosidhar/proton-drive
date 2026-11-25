import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKGBUILD = path.join(import.meta.dir, '..', 'packaging', 'linux', 'arch', 'PKGBUILD');

function put(file: string, body = 'x'): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
}

describe('Arch PKGBUILD package()', () => {
    test('installs the tarball bin, share and lib into /usr, and never install.sh', () => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'pd-pkgbuild-'));
        try {
            const ver = '0.1.0';
            const srcdir = path.join(tmp, 'src');
            const pkgdir = path.join(tmp, 'pkg');
            const root = path.join(srcdir, `kosidhar-protondrive-${ver}-linux-x86_64`);
            put(path.join(root, 'bin', 'protondrive'));
            put(path.join(root, 'share', 'applications', 'x.desktop'));
            put(path.join(root, 'lib', 'systemd', 'user', 'protondrive.service'));
            put(path.join(root, 'install.sh'), '#!/bin/sh\n');
            mkdirSync(pkgdir, { recursive: true });

            // Source the real PKGBUILD in a subshell and run its package().
            const run = Bun.spawnSync(['bash', '-c', 'source "$1" && package', 'bash', PKGBUILD], {
                env: { ...process.env, srcdir, pkgdir, pkgver: ver, CARCH: 'x86_64' },
                stdout: 'pipe',
                stderr: 'pipe',
            });
            expect(run.stderr.toString()).toBe('');
            expect(run.exitCode).toBe(0);

            expect(existsSync(path.join(pkgdir, 'usr', 'bin', 'protondrive'))).toBe(true);
            expect(existsSync(path.join(pkgdir, 'usr', 'share', 'applications', 'x.desktop'))).toBe(true);
            expect(existsSync(path.join(pkgdir, 'usr', 'lib', 'systemd', 'user', 'protondrive.service'))).toBe(true);
            expect(existsSync(path.join(pkgdir, 'usr', 'install.sh'))).toBe(false);
            expect(readdirSync(path.join(pkgdir, 'usr')).sort()).toEqual(['bin', 'lib', 'share']);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
