import { describe, expect, test } from 'bun:test';
import {
    accessSync,
    constants,
    existsSync,
    readFileSync,
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

describe('Docs and Sheets file types', () => {
    const dir = path.join(import.meta.dir, '..', 'packaging', 'linux');
    const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');

    test('the MIME package declares both types with their globs and generic icons', () => {
        const xml = read('io.github.kosidhar.ProtonDrive.xml');
        const types = [...xml.matchAll(/<mime-type type="([^"]+)">([\s\S]*?)<\/mime-type>/g)];
        expect(types.map((t) => t[1])).toEqual(['application/vnd.proton.doc', 'application/vnd.proton.sheet']);
        expect(types[0]![2]).toContain('<comment>Proton Docs document</comment>');
        expect(types[0]![2]).toContain('<glob pattern="*.protondoc"/>');
        expect(types[0]![2]).toContain('<generic-icon name="x-office-document"/>');
        expect(types[1]![2]).toContain('<comment>Proton Sheets spreadsheet</comment>');
        expect(types[1]![2]).toContain('<glob pattern="*.protonsheet"/>');
        expect(types[1]![2]).toContain('<generic-icon name="x-office-spreadsheet"/>');
    });

    test('the open handler is hidden, takes both types, and runs protondrive open-doc', () => {
        const desktop = read('io.github.kosidhar.ProtonDrive.OpenDoc.desktop');
        expect(desktop).toMatch(/^NoDisplay=true$/m);
        expect(desktop).toMatch(/^MimeType=application\/vnd\.proton\.doc;application\/vnd\.proton\.sheet;$/m);
        expect(desktop).toMatch(/^Exec=protondrive open-doc %f$/m);
        expect(desktop).toMatch(/^Name=Proton Drive$/m);
    });

    test('install.sh installs both files, refreshes the MIME database, and removes them on uninstall', () => {
        const sh = read('install.sh');
        const mime = 'share/mime/packages/io.github.kosidhar.ProtonDrive.xml';
        const opendoc = 'share/applications/io.github.kosidhar.ProtonDrive.OpenDoc.desktop';
        for (const file of [mime, opendoc]) {
            // uninstall rm, tarball install, source install
            expect(sh.split(file).length - 1).toBeGreaterThanOrEqual(3);
        }
        expect(sh).toContain('packaging/linux/io.github.kosidhar.ProtonDrive.xml');
        expect(sh).toContain('packaging/linux/io.github.kosidhar.ProtonDrive.OpenDoc.desktop');
        expect(sh).toContain('update-mime-database -n "$PREFIX/share/mime"');
        expect(sh).toContain('Exec=$PREFIX/bin/protondrive open-doc %f');
        // the handler's sed runs only when its file was installed (an older tarball may not carry it)
        expect(sh).toMatch(/if \[ -f "\$OPENDOC_DESKTOP" \]; then\s+sed -i [^\n]*open-doc %f[^\n]*"\$OPENDOC_DESKTOP"/);
        // the main entry's sed must not touch the handler
        const mainSed = sh.split('\n').find((l) => l.includes('Exec=$PREFIX/bin/protondrive-gui'))!;
        expect(mainSed).not.toContain('OpenDoc');
    });

    test('package.sh stages both files under usr/share and validates the handler', () => {
        const sh = read('package.sh');
        expect(sh).toContain('"$STAGE/usr/share/mime/packages/$APP_ID.xml"');
        expect(sh).toContain('"$STAGE/usr/share/applications/$APP_ID.OpenDoc.desktop"');
        expect(sh).toMatch(/desktop-file-validate "\$STAGE\/usr\/share\/applications\/\$APP_ID\.OpenDoc\.desktop"/);
    });

    test('postinst refreshes the MIME database, and the Flatpak installs both files', () => {
        expect(read('postinst.sh')).toContain('update-mime-database /usr/share/mime');
        const flatpak = read('flatpak/io.github.kosidhar.ProtonDrive.bundle.yml');
        expect(flatpak).toContain('/app/share/mime/packages/io.github.kosidhar.ProtonDrive.xml');
        expect(flatpak).toContain('/app/share/applications/io.github.kosidhar.ProtonDrive.OpenDoc.desktop');
    });
});
