import { describe, expect, test } from 'bun:test';
import {
    accessSync,
    constants,
    copyFileSync,
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

    test('the MIME package declares both types with their globs and Proton icons', () => {
        const xml = read('io.github.kosidhar.ProtonDrive.xml');
        const types = [...xml.matchAll(/<mime-type type="([^"]+)">([\s\S]*?)<\/mime-type>/g)];
        expect(types.map((t) => t[1])).toEqual(['application/vnd.proton.doc', 'application/vnd.proton.sheet']);
        expect(types[0]![2]).toContain('<comment>Proton Docs document</comment>');
        expect(types[0]![2]).toContain('<glob pattern="*.protondoc"/>');
        expect(types[0]![2]).toContain('<generic-icon name="application-vnd.proton.doc"/>');
        expect(types[1]![2]).toContain('<comment>Proton Sheets spreadsheet</comment>');
        expect(types[1]![2]).toContain('<glob pattern="*.protonsheet"/>');
        expect(types[1]![2]).toContain('<generic-icon name="application-vnd.proton.sheet"/>');
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

    describe('Proton icons for the placeholders (#439)', () => {
        const root = path.join(import.meta.dir, '..');
        const icons = ['application-vnd.proton.doc', 'application-vnd.proton.sheet'];
        const hicolor = 'share/icons/hicolor/scalable/mimetypes';

        test('both SVGs exist and are well-formed XML', () => {
            for (const name of icons) {
                const file = path.join(root, 'assets', 'mimetypes', `${name}.svg`);
                expect(existsSync(file)).toBe(true);
                const svg = readFileSync(file, 'utf8');
                expect(svg).toMatch(/^\s*<svg[\s>]/);
                expect(svg.trimEnd()).toEndWith('</svg>');
                expect(Bun.spawnSync(['xmllint', '--noout', file]).exitCode).toBe(0);
            }
        });

        test('the license text for the icons ships next to them', () => {
            const text = readFileSync(path.join(root, 'assets', 'mimetypes', 'LICENSE'), 'utf8');
            expect(text).toContain('GNU GENERAL PUBLIC LICENSE');
            expect(text.split('\n')[0]).toContain('ProtonMail/WebClients');
        });

        // GTK looks every name up in the current theme (and its parents) before hicolor, where the Proton icons are, so
        // any generic name a theme has (Yaru's x-office-document, Adwaita's application-x-generic) would win (#471).
        // The generic icon is therefore the Proton icon itself: the only names offered are Proton's.
        test('the MIME package names only the Proton icons, as the icon and as the generic icon', () => {
            const xml = read('io.github.kosidhar.ProtonDrive.xml');
            for (const name of icons) {
                expect(xml).toContain(`<icon name="${name}"/>`);
                expect(xml).toContain(`<generic-icon name="${name}"/>`);
            }
            expect(xml).not.toMatch(/<generic-icon name="(?!application-vnd\.proton\.)/);
        });

        const hasGio = Bun.spawnSync(['python3', '-c', 'import gi; gi.require_version("Gio", "2.0")']).exitCode === 0;
        test.skipIf(!hasGio)('GIO offers Files only the Proton icon names for both types', () => {
            const tmp = mkdtempSync(path.join(os.tmpdir(), 'pd-mime-'));
            try {
                mkdirSync(path.join(tmp, 'mime', 'packages'), { recursive: true });
                copyFileSync(
                    path.join(dir, 'io.github.kosidhar.ProtonDrive.xml'),
                    path.join(tmp, 'mime', 'packages', 'io.github.kosidhar.ProtonDrive.xml'),
                );
                expect(Bun.spawnSync(['update-mime-database', path.join(tmp, 'mime')]).exitCode).toBe(0);
                const script = [
                    'import gi, json',
                    'gi.require_version("Gio", "2.0")',
                    'from gi.repository import Gio',
                    'print(json.dumps({t: Gio.content_type_get_icon(t).get_names() for t in ("application/vnd.proton.doc", "application/vnd.proton.sheet")}))',
                ].join('\n');
                const p = Bun.spawnSync(['python3', '-I', '-W', 'ignore', '-c', script], {
                    env: { ...process.env, XDG_DATA_HOME: tmp },
                });
                const names = JSON.parse(p.stdout.toString()) as Record<string, string[]>;
                expect(names['application/vnd.proton.doc']).toEqual(['application-vnd.proton.doc', 'application-vnd.proton.doc-symbolic']);
                expect(names['application/vnd.proton.sheet']).toEqual([
                    'application-vnd.proton.sheet',
                    'application-vnd.proton.sheet-symbolic',
                ]);
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });

        test('install.sh installs and removes both, from the tarball and the source tree', () => {
            const sh = read('install.sh');
            for (const name of icons) {
                expect(sh).toContain(`$SRC_Root/${hicolor}/${name}.svg`);
                expect(sh).toContain(`$SRC_Root/assets/mimetypes/${name}.svg`);
                expect(sh).toMatch(new RegExp(`rm -f[^\\n]*\\$PREFIX/${hicolor}/${name}\\.svg`));
            }
            expect(sh).toContain('gtk-update-icon-cache -q -t -f "$PREFIX/share/icons/hicolor"');
        });

        test('package.sh stages both, and the Flatpak installs both', () => {
            const sh = read('package.sh');
            const flatpak = read('flatpak/io.github.kosidhar.ProtonDrive.bundle.yml');
            for (const name of icons) {
                expect(sh).toContain(`assets/mimetypes/${name}.svg`);
                expect(sh).toContain(`$STAGE/usr/${hicolor}/${name}.svg`);
                expect(flatpak).toContain(`install -Dm644 ${hicolor}/${name}.svg /app/${hicolor}/${name}.svg`);
            }
        });

        // Proton's square Docs and Sheets logo glyphs (#473), as the website's app switcher shows them, converted from
        // JSX to SVG with their path data unchanged
        test('the icons stay byte for byte what was taken from upstream', () => {
            const sha = (name: string): string =>
                new Bun.CryptoHasher('sha256')
                    .update(readFileSync(path.join(root, 'assets', 'mimetypes', `${name}.svg`)))
                    .digest('hex');
            expect(sha('application-vnd.proton.doc')).toBe('f2d4c1f66c11fa86ea567be7bd610d34b80c8203991aba6bb374eb49c067f4a8');
            expect(sha('application-vnd.proton.sheet')).toBe('18b9a2ca8bfd4a7c5f97cd197ac604a20cd246a7932d7e5e769ede150de9d951');
        });

        describe('the license texts ship with every package', () => {
            const lic = 'share/licenses/kosidhar-protondrive';
            const files: [string, string][] = [
                ['LICENSE', 'LICENSE'],
                ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
                ['LICENSE.proton-file-icons', 'assets/mimetypes/LICENSE'],
            ];

            test('package.sh stages all three, which nfpm and the tarball then carry', () => {
                const sh = read('package.sh');
                for (const [name, from] of files) {
                    expect(sh).toContain(`"$ROOT/${from}" "$STAGE/usr/${lic}/${name}"`);
                }
                expect(read('nfpm.yaml')).toContain('# @STAGED_CONTENTS@'); // nfpm-contents.sh lists everything staged (#548)
            });

            test('install.sh installs them from the tarball and the source tree, and removes them', () => {
                const sh = read('install.sh');
                for (const [name, from] of files) {
                    expect(sh).toContain(`"$SRC_Root/${lic}/${name}" "$PREFIX/${lic}/${name}"`);
                    expect(sh).toContain(`"$SRC_Root/${from}" "$PREFIX/${lic}/${name}"`);
                    expect(sh).toMatch(new RegExp(`rm -f[^\\n]*\\$PREFIX/${lic}/${name.replace(/\./g, '\\.')}`));
                }
                expect(sh).toContain(`rmdir "$PREFIX/${lic}"`);
            });

            test('the Flatpak installs them, and the PKGBUILD takes the whole share tree', () => {
                const flatpak = read('flatpak/io.github.kosidhar.ProtonDrive.bundle.yml');
                for (const [name] of files) {
                    expect(flatpak).toContain(`install -Dm644 ${lic}/${name} /app/${lic}/${name}`);
                }
                expect(read('arch/PKGBUILD')).toContain('"${root}/share"');
            });
        });

        test('the package license metadata and the notices cover the GPL icons', () => {
            expect(read('nfpm.yaml')).toMatch(/^license: MIT AND GPL-3\.0-only$/m);
            expect(read('arch/PKGBUILD')).toContain("license=('MIT' 'GPL-3.0-only')");
            const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
            expect(notices).toContain('## Proton Docs and Sheets icons');
            expect(notices).toContain('assets/mimetypes/LICENSE');
        });
    });
});

// The release binaries are built for Ubuntu 22.04's glibc 2.35, and the packages declare the glibc they need (#505)
describe('portable release binaries and their glibc minimum', () => {
    const root = path.join(import.meta.dir, '..');
    const dir = path.join(root, 'packaging', 'linux');
    const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');
    const GLIBC_MIN_SH = path.join(dir, 'glibc-min.sh');

    function glibcMin(files: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
        const p = Bun.spawnSync(['bash', GLIBC_MIN_SH, ...files], {
            env: { ...process.env, ...env },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    }

    test('the build image is Ubuntu 22.04 with a pinned Rust from a minimal rustup', () => {
        const dockerfile = read('build-env/Dockerfile');
        const instructions = dockerfile.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
        expect(instructions[0]).toBe('FROM ubuntu:22.04');
        const install = dockerfile.match(/apt-get install[^\n]*/)?.[0] ?? '';
        for (const pkg of ['build-essential', 'pkg-config', 'ca-certificates', 'curl']) {
            expect(install.split(/\s+/)).toContain(pkg);
        }
        expect(dockerfile).toContain('https://sh.rustup.rs');
        expect(dockerfile).toContain('--profile minimal');
        expect(dockerfile).toMatch(/^ARG RUST_VERSION=\d+\.\d+\.\d+$/m);
        expect(dockerfile).toContain('--default-toolchain "$RUST_VERSION"');
    });

    test('build-portable.sh builds both crates locked, as the calling user, into their own target dirs', () => {
        const sh = read('build-portable.sh');
        expect(sh).toContain('--user "$(id -u):$(id -g)"');
        expect(sh).toContain('cargo build --release --locked');
        for (const crate of ['native-gui', 'native-vfs']) {
            expect(sh).toContain(`${crate}/target-portable`);
        }
        expect(sh).toContain('"$ROOT/release/protondrive-gui"');
        expect(sh).toContain('"$ROOT/release/protondrive-vfs"');
        // only the repository and the cargo cache are mounted, never the home folder
        expect(sh).not.toMatch(/(-v|--volume|--mount)[ =][^\n]*\$HOME/);
        const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
        expect(ignore).toContain('native-gui/target-portable/');
        expect(ignore).toContain('native-vfs/target-portable/');
    });

    test('package.sh builds the Rust binaries portably by default, and keeps --native for a host build', () => {
        const sh = read('package.sh');
        expect(sh).toContain('"$HERE/build-portable.sh"');
        expect(sh).toMatch(/^NATIVE=0$/m);
        expect(sh).toMatch(/^\s+--native\) NATIVE=1; shift ;;$/m);
        // the host build is still there, behind --native
        expect(sh).toContain('(cd "$ROOT/native-gui" && cargo build --release)');
        expect(sh).toContain('(cd "$ROOT/native-vfs" && cargo build --release)');
    });

    test('package.sh stops at once, naming --native, when docker is missing', () => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'pd-nodocker-'));
        try {
            // A PATH with only what package.sh needs before it builds: no docker, and no mkdir, so nothing is written
            const bin = path.join(tmp, 'bin');
            mkdirSync(bin);
            for (const tool of ['dirname', 'python3', 'date', 'uname']) {
                symlinkSync(Bun.which(tool)!, path.join(bin, tool));
            }
            const run = (args: string[]) => {
                const p = Bun.spawnSync(['/bin/bash', path.join(dir, 'package.sh'), ...args], {
                    env: { PATH: bin, HOME: tmp },
                    stdout: 'pipe',
                    stderr: 'pipe',
                });
                return { code: p.exitCode, err: p.stderr.toString() };
            };
            const portable = run(['--formats', 'deb']);
            expect(portable.code).toBe(1);
            expect(portable.err).toContain('docker');
            expect(portable.err).toContain('--native');
            // --native needs no docker: it goes on, as far as the mkdir this PATH lacks
            const native = run(['--native', '--formats', 'deb']);
            expect(native.code).toBe(127);
            expect(native.err).toContain('mkdir');
            expect(native.err).not.toContain('docker');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('nfpm takes the glibc minimum from the build, for the deb and the rpm', () => {
        const nfpm = read('nfpm.yaml');
        expect(nfpm).toContain('- libc6 (>= ${GLIBC_MIN})');
        expect(nfpm).toContain('- glibc >= ${GLIBC_MIN}');
        expect(nfpm).not.toMatch(/libc6 \(>= \d/);
    });

    test('package.sh computes the minimum from every bundled binary and refuses one newer than 2.35', () => {
        const sh = read('package.sh');
        expect(sh).toContain(
            'GLIBC_MIN="$("$HERE/glibc-min.sh" "$STAGE/usr/bin/protondrive" "$STAGE/usr/bin/protondrive-gui" "$STAGE/usr/bin/protondrive-vfs")"',
        );
        expect(sh).toMatch(/^GLIBC_LIMIT=2\.35$/m);
        expect(sh).toMatch(/^\s+--allow-newer-glibc\) ALLOW_NEWER_GLIBC=1; shift ;;$/m);
        expect(sh).toContain('export GLIBC_MIN');
    });

    test('glibc-min.sh prints the newest glibc a real binary needs', () => {
        const r = glibcMin(['/bin/true']);
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/^2\.\d+(\.\d+)?\n$/);
    });

    test('glibc-min.sh takes the newest version across binaries, by version and not by text', () => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'pd-glibc-'));
        try {
            // A stand-in objdump: a needs 2.2.5, 2.9 and 2.17 (GLIBC_PRIVATE and GLIBCXX_ aren't glibc versions);
            // b needs 2.14; none names no version at all
            writeFileSync(
                path.join(tmp, 'objdump'),
                [
                    '#!/bin/sh',
                    'case "$2" in',
                    '  */a) printf "%s\\n" "DYNAMIC SYMBOL TABLE:" \\',
                    '    "0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.2.5) malloc" \\',
                    '    "0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.9)  pipe2" \\',
                    '    "0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.17) clock_gettime" \\',
                    '    "0000000000000000      DF *UND*  0000000000000000 (GLIBC_PRIVATE) _dl_x" \\',
                    '    "0000000000000000      DF *UND*  0000000000000000 (GLIBCXX_3.4.30) _ZSt4cout" ;;',
                    '  */b) printf "%s\\n" "0000000000000000      DF *UND*  0000000000000000  GLIBC_2.14  memcpy" ;;',
                    '  */none) printf "%s\\n" "DYNAMIC SYMBOL TABLE:" ;;',
                    'esac',
                ].join('\n') + '\n',
                { mode: 0o755 },
            );
            const env = { PATH: `${tmp}:${process.env.PATH}` };
            const at = (name: string): string => path.join(tmp, name);
            expect(glibcMin([at('a')], env)).toMatchObject({ code: 0, out: '2.17\n' });
            expect(glibcMin([at('b'), at('a')], env)).toMatchObject({ code: 0, out: '2.17\n' });
            expect(glibcMin([at('b')], env)).toMatchObject({ code: 0, out: '2.14\n' });
            // a binary that names no glibc version can't be measured: never guess a minimum for it
            const none = glibcMin([at('a'), at('none')], env);
            expect(none.code).not.toBe(0);
            expect(none.out).toBe('');
            expect(none.err).toContain(at('none'));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('glibc-min.sh fails, printing nothing, without binaries or on a file that is not one', () => {
        expect(glibcMin([]).code).not.toBe(0);
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'pd-glibc-'));
        try {
            const text = path.join(tmp, 'notes.txt');
            writeFileSync(text, 'not a binary\n');
            const r = glibcMin(['/bin/true', text]);
            expect(r.code).not.toBe(0);
            expect(r.out).toBe('');
            expect(glibcMin([path.join(tmp, 'missing')]).code).not.toBe(0);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe('recommends for the Files extension and the tray (#506)', () => {
    const root = path.join(import.meta.dir, '..');
    const nfpm = readFileSync(path.join(root, 'packaging', 'linux', 'nfpm.yaml'), 'utf8');
    const recommendsOf = (format: 'deb' | 'rpm'): string[] => {
        const block = nfpm.split(new RegExp(`^  ${format}:$`, 'm'))[1]?.split(/^  \w+:$|^\S/m)[0] ?? '';
        const list = block.split(/^    recommends:$/m)[1] ?? '';
        return [...list.matchAll(/^      - (.+)$/gm)].map((m) => m[1]!.trim());
    };

    test('the deb recommends python3-nautilus and the tray libraries', () => {
        const rec = recommendsOf('deb');
        for (const p of ['python3-nautilus', 'python3-gi', 'gir1.2-gtk-3.0', 'gir1.2-ayatanaappindicator3-0.1']) {
            expect(rec).toContain(p);
        }
        expect(rec).toContain('libsecret-1-0');
    });

    test('the rpm recommends nautilus-python and the tray libraries', () => {
        const rec = recommendsOf('rpm');
        for (const p of ['nautilus-python', 'python3-gobject', 'gtk3', 'libayatana-appindicator-gtk3']) {
            expect(rec).toContain(p);
        }
        expect(rec).toContain('libsecret');
    });

    test('the Arch package lists the Files extension and the tray library as optional', () => {
        const pkgbuild = readFileSync(PKGBUILD, 'utf8');
        expect(pkgbuild).toMatch(/'nautilus-python:/);
        expect(pkgbuild).not.toContain('python-nautilus');
        expect(pkgbuild).toMatch(/'libayatana-appindicator:/);
    });

    test('the install guide tells deb and rpm users what the Files extension and the tray need', () => {
        const guide = readFileSync(path.join(root, 'docs/INSTALL.md'), 'utf8');
        const install = guide.slice(guide.indexOf('## Debian'), guide.indexOf('## Arch Linux'));
        expect(install.length).toBeGreaterThan(0);
        expect(install).toContain('python3-nautilus');
        expect(install).toContain('sudo apt install ./kosidhar-protondrive-<version>-linux-amd64.deb');
        expect(install).not.toMatch(/sudo dpkg -i/); // it may say to use apt rather than dpkg -i, but never to run it
        expect(install).toContain('nautilus-python');
        expect(install).toContain('nautilus -q');
        expect(install).toContain('gir1.2-ayatanaappindicator3-0.1');
        expect(install).toContain('AppIndicator and KStatusNotifierItem Support');
    });
});
