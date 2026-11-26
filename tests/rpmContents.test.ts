import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The .deb and .rpm carry each staged file, and own only their own folders (#548). Owning shared folders such as
// /usr/share/icons/hicolor (and at 0775, from the staging umask) made the .rpm conflict with hicolor-icon-theme and
// every other package that owns them on Fedora.
const ROOT = path.resolve(import.meta.dir, '..');
const LINUX = path.join(ROOT, 'packaging', 'linux');
const read = (name: string) => readFileSync(path.join(LINUX, name), 'utf8');
const OWN_DIRS = ['/usr/share/protondrive', '/usr/share/protondrive/tray', '/usr/share/licenses/kosidhar-protondrive'];

type Entry = { src?: string; dst: string; type?: string; file_info?: { mode?: number } };
// nfpm reads `mode: 0755` as octal; a YAML 1.2 parser may read it as decimal. Either way, name it as written.
const modeOf = (e: Entry) => ({ 493: '0755', 755: '0755', 420: '0644', 644: '0644' })[e.file_info?.mode ?? -1] ?? String(e.file_info?.mode);

let stage = '';
afterEach(() => {
    if (stage) rmSync(path.dirname(stage), { recursive: true, force: true });
    stage = '';
});

function put(rel: string, mode = 0o664): void {
    const full = path.join(stage, rel);
    mkdirSync(path.dirname(full), { recursive: true, mode: 0o775 });
    writeFileSync(full, rel);
    chmodSync(full, mode);
}

function contents(): Entry[] {
    const run = Bun.spawnSync(['bash', path.join(LINUX, 'nfpm-contents.sh'), stage]);
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
    return (Bun.YAML.parse(`contents:\n${run.stdout.toString()}`) as { contents: Entry[] }).contents;
}

describe('the packages own only their own folders (#548)', () => {
    test('every staged file is listed once, 0755 if executable and 0644 otherwise, with links as links', () => {
        stage = path.join(mkdtempSync(path.join(os.tmpdir(), 'nfpm-contents-')), 'root');
        put('usr/share/icons/hicolor/48x48/apps/io.github.kosidhar.ProtonDrive.png');
        put('usr/share/icons/hicolor/scalable/emblems/emblem-protondrive-cloud.svg');
        put('usr/share/mime/packages/io.github.kosidhar.ProtonDrive.xml');
        put('usr/share/applications/io.github.kosidhar.ProtonDrive.desktop');
        put('usr/share/nautilus-python/extensions/kosidhar_protondrive_nautilus.py');
        put('usr/share/protondrive/tray/proton_drive_tray.py', 0o775);
        put('usr/share/licenses/kosidhar-protondrive/LICENSE');
        put('usr/share/protondrive/a name with spaces.txt');
        put('usr/lib/systemd/user/protondrive.service');
        symlinkSync('LICENSE', path.join(stage, 'usr/share/licenses/kosidhar-protondrive/COPYING'));

        const entries = contents();
        const files = entries.filter((e) => e.type === undefined);
        expect(files.map((e) => [e.dst, e.src, modeOf(e)]).sort()).toEqual(
            [
                ['/usr/lib/systemd/user/protondrive.service', '0644'],
                ['/usr/share/applications/io.github.kosidhar.ProtonDrive.desktop', '0644'],
                ['/usr/share/icons/hicolor/48x48/apps/io.github.kosidhar.ProtonDrive.png', '0644'],
                ['/usr/share/icons/hicolor/scalable/emblems/emblem-protondrive-cloud.svg', '0644'],
                ['/usr/share/licenses/kosidhar-protondrive/LICENSE', '0644'],
                ['/usr/share/mime/packages/io.github.kosidhar.ProtonDrive.xml', '0644'],
                ['/usr/share/nautilus-python/extensions/kosidhar_protondrive_nautilus.py', '0644'],
                ['/usr/share/protondrive/a name with spaces.txt', '0644'],
                ['/usr/share/protondrive/tray/proton_drive_tray.py', '0755'],
            ].map(([dst, mode]) => [dst, path.join(stage, dst!), mode]),
        );
        expect(entries.filter((e) => e.type === 'symlink')).toEqual([
            { src: 'LICENSE', dst: '/usr/share/licenses/kosidhar-protondrive/COPYING', type: 'symlink' },
        ]);
    });

    test('the only folders it owns are its own, at 0755: never /usr/share/icons/hicolor or other shared ones', () => {
        stage = path.join(mkdtempSync(path.join(os.tmpdir(), 'nfpm-contents-')), 'root');
        put('usr/share/icons/hicolor/48x48/apps/io.github.kosidhar.ProtonDrive.png');
        put('usr/share/kio/servicemenus/protondrive.desktop');
        put('usr/share/protondrive/tray/proton_drive_tray.py', 0o775);
        put('usr/share/licenses/kosidhar-protondrive/LICENSE');

        const dirs = contents().filter((e) => e.type === 'dir');
        expect(dirs.map((e) => [e.dst, modeOf(e)]).sort()).toEqual(OWN_DIRS.map((d) => [d, '0755']).sort());
    });

    test('an own folder that isn\'t staged isn\'t claimed', () => {
        stage = path.join(mkdtempSync(path.join(os.tmpdir(), 'nfpm-contents-')), 'root');
        put('usr/share/protondrive/x.txt');
        expect(contents().filter((e) => e.type === 'dir').map((e) => e.dst)).toEqual(['/usr/share/protondrive']);
    });

    test('nfpm.yaml takes the generated list instead of whole trees, and staging uses umask 022', () => {
        const nfpm = read('nfpm.yaml');
        expect(nfpm).not.toMatch(/type: tree/);
        expect(nfpm).toContain('# @STAGED_CONTENTS@');
        const sh = read('package.sh');
        expect(sh).toMatch(/nfpm-contents\.sh" "\$STAGE"/);
        expect(sh).toContain('@STAGED_CONTENTS@');
        expect(sh).toMatch(/^umask 022$/m);
        expect(sh.indexOf('umask 022')).toBeLessThan(sh.indexOf('mkdir -p "$STAGE"'));
    });

    test('the release check installs the .rpm with dnf on Fedora next to the folders\' owners, and checks what it owns', () => {
        const check = read('verify-release.sh');
        expect(check).toMatch(/fedora/);
        expect(check).toContain('dnf install');
        for (const owner of ['hicolor-icon-theme', 'shared-mime-info', 'nautilus-python']) expect(check).toContain(owner);
        for (const own of OWN_DIRS) expect(check).toContain(own);
        expect(check).toMatch(/protondrive --version/);
    });
});
