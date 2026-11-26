import { describe, expect, test } from 'bun:test';

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8');
const pkgVersion = (root = ROOT) => JSON.parse(read(root, 'package.json')).version as string;

const VERSIONED_FILES = [
    'package.json',
    'native-gui/Cargo.toml',
    'native-gui/Cargo.lock',
    'native-vfs/Cargo.toml',
    'native-vfs/Cargo.lock',
    'packaging/linux/arch/PKGBUILD',
];

/** The version of the named crate: its `[package]` entry in Cargo.toml, or its `[[package]]` entry in Cargo.lock. */
function crateVersion(text: string, crate: string): string | undefined {
    const m = text.match(new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`));
    return m?.[1];
}

function pkgbuildField(text: string, field: string): string | undefined {
    return text.match(new RegExp(`^${field}=(\\S+)$`, 'm'))?.[1];
}

describe('one version for the whole app', () => {
    const v = pkgVersion();

    test('package.json holds a MAJOR.MINOR.PATCH version, optionally -pre.N', () => {
        expect(v).toMatch(/^\d+\.\d+\.\d+(-pre\.\d+)?$/);
    });

    test('both Cargo.toml files and both Cargo.lock entries match package.json', () => {
        expect(crateVersion(read(ROOT, 'native-gui/Cargo.toml'), 'protondrive-gui')).toBe(v);
        expect(crateVersion(read(ROOT, 'native-gui/Cargo.lock'), 'protondrive-gui')).toBe(v);
        expect(crateVersion(read(ROOT, 'native-vfs/Cargo.toml'), 'protondrive-vfs')).toBe(v);
        expect(crateVersion(read(ROOT, 'native-vfs/Cargo.lock'), 'protondrive-vfs')).toBe(v);
    });

    test('the PKGBUILD pkgver matches package.json', () => {
        expect(pkgbuildField(read(ROOT, 'packaging/linux/arch/PKGBUILD'), 'pkgver')).toBe(v);
    });

    test('package.sh and flatpak-bundle.sh read the version from package.json', () => {
        for (const script of ['package.sh', 'flatpak-bundle.sh']) {
            const text = read(ROOT, `packaging/linux/${script}`);
            expect(text).not.toMatch(/^VERSION="\d/m);
            expect(text).toMatch(/^VERSION="\$\(.*package\.json.*\)"$/m);
        }
    });

    test('the README and the install guide have no literal version in package file names', () => {
        for (const doc of ['README.md', 'docs/INSTALL.md']) {
            const text = read(ROOT, doc);
            expect(text).not.toMatch(/kosidhar-protondrive-\d/);
            expect(text).toContain('kosidhar-protondrive-<version>-linux-amd64.deb');
        }
    });

    test('the release steps are in RELEASING.md, which CONTRIBUTING.md points to', () => {
        expect(read(ROOT, 'RELEASING.md')).toMatch(/bun run set-version X\.Y\.Z/);
        expect(read(ROOT, 'CONTRIBUTING.md')).toContain('(RELEASING.md)');
    });
});

describe('set-version', () => {
    function tempCopy(): string {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'set-version-'));
        for (const rel of VERSIONED_FILES) {
            mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
            cpSync(path.join(ROOT, rel), path.join(dir, rel));
        }
        return dir;
    }

    function run(dir: string, version: string) {
        const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'scripts/set-version.ts'), version, '--root', dir], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    }

    test('sets 0.2.0 everywhere and resets pkgrel to 1', () => {
        const dir = tempCopy();
        try {
            // Start from pkgrel=3 so the reset is visible.
            const pkgbuild = path.join(dir, 'packaging/linux/arch/PKGBUILD');
            writeFileSync(pkgbuild, read(dir, 'packaging/linux/arch/PKGBUILD').replace(/^pkgrel=.*$/m, 'pkgrel=3'));
            const r = run(dir, '0.2.0');
            expect(r.code).toBe(0);
            expect(pkgVersion(dir)).toBe('0.2.0');
            expect(crateVersion(read(dir, 'native-gui/Cargo.toml'), 'protondrive-gui')).toBe('0.2.0');
            expect(crateVersion(read(dir, 'native-gui/Cargo.lock'), 'protondrive-gui')).toBe('0.2.0');
            expect(crateVersion(read(dir, 'native-vfs/Cargo.toml'), 'protondrive-vfs')).toBe('0.2.0');
            expect(crateVersion(read(dir, 'native-vfs/Cargo.lock'), 'protondrive-vfs')).toBe('0.2.0');
            const pb = read(dir, 'packaging/linux/arch/PKGBUILD');
            expect(pkgbuildField(pb, 'pkgver')).toBe('0.2.0');
            expect(pkgbuildField(pb, 'pkgrel')).toBe('1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('changes nothing but the version lines', () => {
        const dir = tempCopy();
        try {
            expect(run(dir, '0.2.0').code).toBe(0);
            for (const rel of VERSIONED_FILES) {
                const before = read(ROOT, rel).split('\n');
                const after = read(dir, rel).split('\n');
                expect(after.length).toBe(before.length);
                const changed = after.filter((l, i) => l !== before[i]);
                expect(changed.length).toBeLessThanOrEqual(2);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('accepts a -pre.N suffix', () => {
        const dir = tempCopy();
        try {
            expect(run(dir, '1.2.3-pre.1').code).toBe(0);
            expect(pkgVersion(dir)).toBe('1.2.3-pre.1');
            expect(crateVersion(read(dir, 'native-gui/Cargo.toml'), 'protondrive-gui')).toBe('1.2.3-pre.1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '', '1.2.3-rc.1', '1.2.3-pre']) {
        test(`refuses ${JSON.stringify(bad)} and changes nothing`, () => {
            const dir = tempCopy();
            try {
                const r = run(dir, bad);
                expect(r.code).not.toBe(0);
                for (const rel of VERSIONED_FILES) expect(read(dir, rel)).toBe(read(ROOT, rel));
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }

    test('leaves the Proton API identity untouched', () => {
        const dir = tempCopy();
        try {
            expect(run(dir, '0.2.0').code).toBe(0);
            // The script works only on the versioned files, never on source: the identity stays as it is.
            expect(read(ROOT, 'src/sdk/fileOps.ts')).toContain('external-drive-ubuntu_sync@0.1.0-alpha');
            expect(read(ROOT, 'scripts/build.ts')).toContain('external-drive-ubuntu_sync@0.1.0-alpha');
            for (const rel of VERSIONED_FILES) expect(read(dir, rel)).not.toContain('external-drive-ubuntu_sync@0.2.0');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('protondrive --version', () => {
    test('prints the app version first, then the App Version and SDK Version lines', () => {
        const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'src/cli/main.ts'), '--version'], { stdout: 'pipe', stderr: 'pipe' });
        expect(r.exitCode).toBe(0);
        const lines = r.stdout.toString().split('\n');
        expect(lines[0]).toBe(`protondrive ${pkgVersion()}`);
        expect(lines[1]).toMatch(/^App Version: external-drive-ubuntu_sync@/);
        expect(lines[2]).toMatch(/^SDK Version: /);
    });

    test('--json carries the version too', () => {
        const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'src/cli/main.ts'), '--version', '--json'], { stdout: 'pipe', stderr: 'pipe' });
        const info = JSON.parse(r.stdout.toString());
        expect(info.version).toBe(pkgVersion());
        expect(info.appVersion).toContain('external-drive-ubuntu_sync@');
    });
});
