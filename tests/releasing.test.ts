import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';

// How to release, and how to install on the owner's laptop, written down for any agent (#510)
const root = path.join(import.meta.dir, '..');
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

describe('the release process is written down for every agent (#510)', () => {
    test('AGENTS.md and GEMINI.md link to CLAUDE.md, so every agent reads the same rules', () => {
        for (const name of ['AGENTS.md', 'GEMINI.md']) {
            expect(lstatSync(path.join(root, name)).isSymbolicLink()).toBe(true);
            expect(readlinkSync(path.join(root, name))).toBe('CLAUDE.md');
        }
        expect(read('CLAUDE.md')).toContain('`AGENTS.md` and `GEMINI.md` link to this file');
    });

    test('RELEASING.md covers the steps and the never-dos', () => {
        const doc = read('RELEASING.md');
        for (const step of [
            'bun run set-version X.Y.Z',
            'packaging/linux/package.sh',
            'packaging/linux/verify-release.sh',
            'sha256sum kosidhar-protondrive-X.Y.Z-*',
            'gh release create vX.Y.Z --prerelease',
            'Not made by or affiliated with Proton AG',
        ]) {
            expect(doc).toContain(step);
        }
        expect(doc).toContain('**Never** pass `--native` or `--allow-newer-glibc` for a release');
        expect(doc).toContain('external-drive-ubuntu_sync@0.1.0-alpha');
        expect(doc).toContain('No AI attribution');
        expect(doc).toContain('RUST_VERSION');
    });

    test('CLAUDE.md points to RELEASING.md and says how to install on the owner\'s laptop, backup first', () => {
        const rules = read('CLAUDE.md');
        expect(rules).toContain('## Releasing');
        expect(rules).toContain('Follow `RELEASING.md`');
        expect(rules).toContain("## Install on the owner's laptop");
        const install = rules.split("## Install on the owner's laptop")[1]!;
        const backup = install.indexOf('Back up the sync database first');
        const stop = install.indexOf('Stop everything');
        const installStep = install.indexOf('./packaging/linux/install.sh --user');
        expect(backup).toBeGreaterThan(0);
        expect(stop).toBeGreaterThan(backup);
        expect(installStep).toBeGreaterThan(stop);
        expect(install).toContain('s.backup(d)');
        expect(install).toContain("with the owner's OK");
    });

    test('verify-release.sh installs the .deb with apt in Ubuntu 22.04 and Debian 12 and starts every program', () => {
        const file = path.join(root, 'packaging', 'linux', 'verify-release.sh');
        expect(statSync(file).mode & 0o111).not.toBe(0);
        expect(Bun.spawnSync(['bash', '-n', file]).exitCode).toBe(0);
        const sh = readFileSync(file, 'utf8');
        expect(sh).toContain('IMAGES="${IMAGES:-ubuntu:22.04 debian:12}"');
        expect(sh).toContain('apt-get install -y -qq /pkgs/$DEB');
        for (const program of ['protondrive --version', 'protondrive-gui --version', 'protondrive-vfs']) {
            expect(sh).toContain(program);
        }
        expect(sh).toContain('error while loading shared libraries');
        expect(sh).toContain('exit "$failed"');
    });

    test('verify-release.sh and package.sh hold the same glibc limit', () => {
        const limit = (file: string): string | undefined => read(file).match(/^GLIBC_LIMIT=(\S+)$/m)?.[1];
        expect(limit('packaging/linux/verify-release.sh')).toBe('2.35');
        expect(limit('packaging/linux/package.sh')).toBe(limit('packaging/linux/verify-release.sh'));
    });
});
