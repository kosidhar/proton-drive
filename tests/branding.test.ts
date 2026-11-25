import { describe, expect, test } from 'bun:test';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SELF = 'tests/branding.test.ts';

// Files the scan must always see: if they are missing from the list, the list is wrong and a pass would mean nothing.
const SENTINELS = ['src/sdk/config.ts', 'packaging/linux/install.sh', 'package.json'];

// Tracked text files, except vendor/, docs/, bun.lock and binary assets. Throws when the list cannot be trusted.
function scannedFiles(cwd: string = ROOT): string[] {
    const ls = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd });
    if (ls.exitCode !== 0) throw new Error(`git ls-files failed (exit ${ls.exitCode}) in ${cwd}: ${ls.stderr.toString().trim()}`);
    const listed = ls.stdout.toString().split('\0').filter(Boolean);
    for (const sentinel of SENTINELS) {
        if (!listed.includes(sentinel)) throw new Error(`git ls-files in ${cwd} did not list ${sentinel}: the scan would be vacuous`);
    }
    return listed.filter(
        (f) =>
            !f.startsWith('vendor/') &&
            !f.startsWith('docs/') &&
            f !== 'bun.lock' &&
            !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|otf|zip|gz|pdf|webp)$/i.test(f),
    );
}

function occurrences(pattern: RegExp, allowed: (file: string, line: string) => boolean): string[] {
    const found: string[] = [];
    for (const file of scannedFiles()) {
        if (file === SELF) continue;
        let text: string;
        try {
            text = readFileSync(path.join(ROOT, file), 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // deleted in the working tree but still listed
            throw err;
        }
        text.split('\n').forEach((line, i) => {
            if (pattern.test(line) && !allowed(file, line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    return found;
}

// proton-drive-ubuntu is only ever the data folder. Each entry says why.
const DATA_FOLDER_ALLOWED: Array<[file: string, line: RegExp, why: string]> = [
    ['src/sdk/config.ts', /^const APP_DIR_NAME = 'proton-drive-ubuntu';/, 'the data folder name'],
    ['native-gui/src/main.rs', /\.local\/share\/proton-drive-ubuntu/, 'the data folder, in the layout move and its test'],
    ['packaging/linux/install.sh', /proton-drive-ubuntu/, 'proton_app_dir: the data folder (comment and echo)'],
    ['README.md', /~\/\.local\/share\/proton-drive-ubuntu\/files/, 'the data folder, where the store lives'],
];

describe('names after #413', () => {
    test('the scan refuses a file list it cannot trust', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'branding-'));
        try {
            expect(() => scannedFiles(dir)).toThrow(/git ls-files/); // not a repo
            Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
            expect(() => scannedFiles(dir)).toThrow(/vacuous/); // a repo that lists nothing
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(scannedFiles().length).toBeGreaterThan(100);
    });

    test('ch.proton.drive and ch_proton appear nowhere', () => {
        expect(occurrences(/ch\.proton\.drive|ch_proton/, () => false)).toEqual([]);
    });

    test('proton-drive-ubuntu appears only as the data folder', () => {
        const found = occurrences(/proton-drive-ubuntu/, (file, line) =>
            DATA_FOLDER_ALLOWED.some(([f, re]) => f === file && re.test(line)),
        );
        expect(found).toEqual([]);
    });

    test('what must not change is unchanged', () => {
        const config = readFileSync(path.join(ROOT, 'src/sdk/config.ts'), 'utf8');
        expect(config).toContain("const APP_DIR_NAME = 'proton-drive-ubuntu';");
        const fileOps = readFileSync(path.join(ROOT, 'src/sdk/fileOps.ts'), 'utf8');
        expect(fileOps).toContain("process.env.PROTON_DRIVE_APP_VERSION || 'external-drive-ubuntu_sync@0.1.0-alpha'");
        expect(fileOps).toContain("export const DEFAULT_CLIENT_UID_PREFIX = 'ubuntu-sync';");
    });

    test('the packages are kosidhar-protondrive', () => {
        const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
        expect(JSON.parse(read('package.json')).name).toBe('kosidhar-protondrive');
        expect(read('packaging/linux/nfpm.yaml')).toMatch(/^name: kosidhar-protondrive$/m);
        expect(read('packaging/linux/arch/PKGBUILD')).toMatch(/^pkgname=kosidhar-protondrive$/m);
        expect(occurrences(/\/usr\/bin\/proton-drive-ubuntu/, () => false)).toEqual([]);
    });

    test('the daemon is built and found as protondrive, and the old deb build is gone', () => {
        const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
        expect(read('scripts/build.ts')).not.toContain('alias');
        expect(read('packaging/linux/package.sh')).toContain('release/protondrive"');
        expect(read('src/linux/notifications.ts')).toContain("serviceName = 'protondrive.service'");
        for (const gone of [
            'scripts/build-deb.sh',
            'linux/desktop/proton-drive.desktop',
            'linux/systemd/proton-drive-ubuntu.service',
            'linux/icons/proton-drive-ubuntu.svg',
        ]) {
            expect(existsSync(path.join(ROOT, gone))).toBe(false);
        }
    });
});
