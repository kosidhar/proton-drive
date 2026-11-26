import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// CI (#518): every check CLAUDE.md lists runs on each pull request, so a PR can't be merged with a failing test (#512).
const ROOT = path.resolve(import.meta.dir, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');
const read = (file: string) => readFileSync(file, 'utf8');

describe('CI workflow (#518)', () => {
    test('exists and runs on pull requests and on pushes to main', () => {
        expect(existsSync(WORKFLOW)).toBe(true);
        const ci = read(WORKFLOW);
        expect(ci).toMatch(/^on:\s*\n\s+pull_request:/m);
        expect(ci).toMatch(/push:\s*\n\s+branches:\s*\[main\]/);
    });

    test('runs every check that CLAUDE.md lists', () => {
        const ci = read(WORKFLOW);
        const claude = read(path.join(ROOT, 'CLAUDE.md'));
        for (const check of [
            'bun test tests',
            'bunx tsc --noEmit',
            'python3 linux/nautilus/test_proton_drive_nautilus.py',
            'python3 linux/tray/test_proton_drive_tray.py',
        ]) {
            expect(claude).toContain(check);
            expect(ci).toContain(check);
        }
        // Both Rust crates (a matrix): tests, and clippy with warnings as errors, each run in the crate's folder
        expect(ci).toMatch(/crate: \[native-gui, native-vfs\]/);
        expect(ci.match(/working-directory: \$\{\{ matrix\.crate \}\}\s*\n\s+run: cargo test\s*$/m)).toBeTruthy();
        expect(ci.match(/working-directory: \$\{\{ matrix\.crate \}\}\s*\n\s+run: cargo clippy --all-targets -- -D warnings\s*$/m)).toBeTruthy();
    });

    test('installs exactly what the lockfile says', () => {
        expect(read(WORKFLOW)).toContain('bun install --frozen-lockfile');
    });

    test('uses the Rust version the release container pins', () => {
        const pinned = read(path.join(ROOT, 'packaging/linux/build-env/Dockerfile')).match(/^ARG RUST_VERSION=(\S+)$/m)?.[1];
        expect(pinned).toBeTruthy();
        expect(read(WORKFLOW)).toContain(`RUST_VERSION: ${pinned}`);
    });

    test('pins every action to a full commit SHA and only reads the repository', () => {
        const ci = read(WORKFLOW);
        const uses = [...ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
        expect(uses.length).toBeGreaterThan(0);
        for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        expect(ci).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m);
        expect(ci).not.toMatch(/pull_request_target/);
    });

    test('leaves the real-mount tests off: runners have no FUSE to mount with', () => {
        expect(read(WORKFLOW)).not.toContain('PROTONDRIVE_VFS_MOUNT_TESTS');
    });
});
