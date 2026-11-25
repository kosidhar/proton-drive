import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const APPRUN = path.join(ROOT, 'packaging/linux/appimage/AppRun');
const APP_ID = 'io.github.kosidhar.ProtonDrive';

const temps: string[] = [];
afterEach(() => {
    for (const t of temps.splice(0)) {
        rmSync(t, { recursive: true, force: true });
    }
});

function tmp(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'apprun-'));
    temps.push(d);
    return d;
}

/** A read-only directory that is removed again after the test. */
function readOnlyDir(): string {
    const d = path.join(tmp(), 'ro');
    mkdirSync(d);
    chmodSync(d, 0o500);
    return d;
}

function stub(file: string, body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

interface Env {
    appDir: string;
    home: string;
    data: string;
    calls: string;
}

function fakeAppDir(): Env {
    const root = tmp();
    const appDir = path.join(root, 'AppDir');
    const calls = path.join(root, 'calls.log');
    const bin = path.join(appDir, 'usr/bin');
    stub(path.join(bin, 'protondrive'), 'echo "cli:$*"');
    stub(path.join(bin, 'protondrive-gui'), 'echo "gui:$*"');
    stub(path.join(bin, 'update-mime-database'), `echo "mime:$*" >> "${calls}"`);
    stub(path.join(bin, 'update-desktop-database'), `echo "desktop:$*" >> "${calls}"`);
    const share = path.join(appDir, 'usr/share');
    mkdirSync(path.join(share, 'mime/packages'), { recursive: true });
    mkdirSync(path.join(share, 'applications'), { recursive: true });
    mkdirSync(path.join(share, 'icons/hicolor/scalable/mimetypes'), { recursive: true });
    copyFileSync(
        path.join(ROOT, `packaging/linux/${APP_ID}.xml`),
        path.join(share, `mime/packages/${APP_ID}.xml`),
    );
    copyFileSync(
        path.join(ROOT, `packaging/linux/${APP_ID}.OpenDoc.desktop`),
        path.join(share, `applications/${APP_ID}.OpenDoc.desktop`),
    );
    for (const k of ['doc', 'sheet']) {
        const n = `application-vnd.proton.${k}.svg`;
        copyFileSync(
            path.join(ROOT, 'assets/mimetypes', n),
            path.join(share, 'icons/hicolor/scalable/mimetypes', n),
        );
    }
    copyFileSync(APPRUN, path.join(appDir, 'AppRun'));
    chmodSync(path.join(appDir, 'AppRun'), 0o755);
    const home = path.join(root, 'home');
    const data = path.join(root, 'data');
    mkdirSync(home);
    mkdirSync(data);
    return { appDir, home, data, calls };
}

function run(env: Env, args: string[], extra: Record<string, string> = {}) {
    const e: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: env.home,
        XDG_DATA_HOME: env.data,
        ...extra,
    };
    const p = Bun.spawnSync(['sh', path.join(env.appDir, 'AppRun'), ...args], {
        env: e,
        timeout: 20000,
    });
    return {
        code: p.exitCode,
        out: p.stdout.toString().trim(),
        err: p.stderr.toString(),
    };
}

function appImage(): string {
    const d = path.join(tmp(), 'My Apps');
    mkdirSync(d);
    const f = path.join(d, 'kosidhar "q".AppImage');
    writeFileSync(f, 'x', { mode: 0o755 });
    return f;
}

const desktopPath = (env: Env) => path.join(env.data, `applications/${APP_ID}.OpenDoc.desktop`);
const mimePath = (env: Env) => path.join(env.data, `mime/packages/${APP_ID}.xml`);
const iconPath = (env: Env, k: string) =>
    path.join(env.data, `icons/hicolor/scalable/mimetypes/application-vnd.proton.${k}.svg`);
const callLines = (env: Env) =>
    existsSync(env.calls) ? readFileSync(env.calls, 'utf8').trim().split('\n') : [];

describe('AppImage AppRun', () => {
    test('(a) outside an AppImage nothing is written and dispatch works', () => {
        const env = fakeAppDir();
        expect(run(env, ['open-doc', 'x']).out).toBe('cli:open-doc x');
        expect(run(env, []).out).toBe('gui:');
        expect(run(env, ['--version']).out).toBe('gui:--version');
        expect(existsSync(desktopPath(env))).toBe(false);
        expect(existsSync(mimePath(env))).toBe(false);
        expect(callLines(env)).toEqual([]);
    });

    test('(b) first AppImage run registers types, icons and handler', () => {
        const env = fakeAppDir();
        const ai = appImage();
        const r = run(env, ['open-doc', 'x'], { APPIMAGE: ai });
        expect(r.out).toBe('cli:open-doc x');
        expect(existsSync(mimePath(env))).toBe(true);
        expect(existsSync(iconPath(env, 'doc'))).toBe(true);
        expect(existsSync(iconPath(env, 'sheet'))).toBe(true);
        const d = readFileSync(desktopPath(env), 'utf8');
        // The file's string escaping comes first: a literal backslash is four, " ` $ get two.
        const escaped = ai.replace(/\\/g, '\\\\\\\\').replace(/["`$]/g, (c) => '\\\\' + c);
        expect(d).toContain(`Exec="${escaped}" open-doc %f\n`);
        expect(d).toContain('X-Kosidhar-AppImage=true');
        // TryExec is a plain string: only backslashes are escaped (none in this path)
        expect(d).toContain(`TryExec=${ai}\n`);
        expect(d).toContain('MimeType=application/vnd.proton.doc;application/vnd.proton.sheet;');
        expect(callLines(env)).toEqual([
            `mime:${env.data}/mime`,
            `desktop:${env.data}/applications`,
        ]);
    });

    test('(b2) a path with a percent sign is skipped (GLib rejects it) and the app still starts', () => {
        const env = fakeAppDir();
        const d = path.join(tmp(), '100%');
        mkdirSync(d);
        const ai = path.join(d, 'a.AppImage');
        writeFileSync(ai, 'x', { mode: 0o755 });
        const r = run(env, ['open-doc', 'x'], { APPIMAGE: ai });
        expect(r.out).toBe('cli:open-doc x');
        expect(existsSync(desktopPath(env))).toBe(false);
        expect(existsSync(mimePath(env))).toBe(false);
        expect(callLines(env)).toEqual([]);
    });

    const hasGio =
        Bun.spawnSync([
            'python3',
            '-I',
            '-c',
            'import gi; gi.require_version("Gio","2.0")',
        ]).exitCode === 0;
    if (!hasGio) console.log('skipping the GLib check: python3 gi (Gio 2.0) is not available');
    test.skipIf(!hasGio)('(g) GLib loads the written entry and reads back the exact path', () => {
        const env = fakeAppDir();
        const ai = path.join(tmp(), 'My Apps', 'kosidhar "q" $x `y` \\z.AppImage');
        mkdirSync(path.dirname(ai));
        writeFileSync(ai, 'x', { mode: 0o755 });
        run(env, [], { APPIMAGE: ai });
        const script = [
            'import sys',
            'import gi',
            'gi.require_version("Gio", "2.0")',
            'from gi.repository import Gio, GLib',
            'try:',
            '    a = Gio.DesktopAppInfo.new_from_filename(sys.argv[1])',
            'except TypeError:  # PyGObject raises when the constructor returns NULL',
            '    a = None',
            'print("NULL" if a is None else GLib.shell_parse_argv(a.get_commandline())[1][0])',
        ].join('\n');
        const load = () =>
            Bun.spawnSync(['python3', '-I', '-W', 'ignore', '-c', script, desktopPath(env)])
                .stdout.toString()
                .replace(/\n$/, '');
        expect(load()).toBe(ai);
        // Once the AppImage is gone GLib ignores the entry, so a system handler wins again.
        rmSync(ai);
        expect(load()).toBe('NULL');
    });

    test('(c) a second run with the same AppImage writes nothing', () => {
        const env = fakeAppDir();
        const ai = appImage();
        run(env, ['open-doc', 'x'], { APPIMAGE: ai });
        const before = readFileSync(desktopPath(env), 'utf8');
        const r = run(env, ['open-doc', 'x'], { APPIMAGE: ai });
        expect(r.out).toBe('cli:open-doc x');
        expect(readFileSync(desktopPath(env), 'utf8')).toBe(before);
        expect(callLines(env).length).toBe(2);
    });

    test('(d) a moved AppImage rewrites the marked entry', () => {
        const env = fakeAppDir();
        run(env, [], { APPIMAGE: appImage() });
        const other = path.join(tmp(), 'other.AppImage');
        writeFileSync(other, 'x');
        run(env, [], { APPIMAGE: other });
        const d = readFileSync(desktopPath(env), 'utf8');
        expect(d).toContain(`Exec="${other}" open-doc %f`);
        expect(d).toContain('X-Kosidhar-AppImage=true');
        expect(callLines(env).length).toBe(4);
    });

    test('(e) an unmarked entry is left untouched', () => {
        const env = fakeAppDir();
        mkdirSync(path.dirname(desktopPath(env)), { recursive: true });
        const mine = '[Desktop Entry]\nExec=protondrive open-doc %f\n';
        writeFileSync(desktopPath(env), mine);
        run(env, [], { APPIMAGE: appImage() });
        expect(readFileSync(desktopPath(env), 'utf8')).toBe(mine);
    });

    test('(f) an unwritable data dir still launches the app', () => {
        const env = fakeAppDir();
        const r = run(env, ['open-doc', 'x'], { APPIMAGE: appImage(), XDG_DATA_HOME: readOnlyDir() });
        expect(r.code).toBe(0);
        expect(r.out).toBe('cli:open-doc x');
    });

    test('(f2) the app exit code is passed through when integration fails', () => {
        const env = fakeAppDir();
        stub(path.join(env.appDir, 'usr/bin/protondrive'), 'exit 7');
        expect(run(env, ['x'], { APPIMAGE: appImage(), XDG_DATA_HOME: readOnlyDir() }).code).toBe(7);
    });

    test('package.sh copies AppRun from its own file', () => {
        const sh = readFileSync(path.join(ROOT, 'packaging/linux/package.sh'), 'utf8');
        expect(sh).toContain('appimage/AppRun');
        expect(sh).not.toMatch(/cat > "\$APPDIR\/AppRun"/);
        expect(sh).not.toContain('SELF="$(readlink -f "$0")"');
    });
});
