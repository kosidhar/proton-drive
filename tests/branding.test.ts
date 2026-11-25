import { describe, expect, test } from 'bun:test';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SELF = 'tests/branding.test.ts';

// Tracked text files, except vendor/, docs/, bun.lock and binary assets.
function scannedFiles(): string[] {
    const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT }).stdout.toString().split('\0').filter(Boolean);
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
        } catch {
            continue; // deleted in the working tree but still listed
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
