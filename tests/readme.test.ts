import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The README is for people installing the app (#521): it opens with what the app is and a picture, says how to
// install from the releases, and leaves the details to docs/. Its links must all lead somewhere.
const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const DOCS = [
    'README.md',
    'docs/INSTALL.md',
    'docs/USER_GUIDE.md',
    'docs/CLI.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'RELEASING.md',
];

/** GitHub's anchor for a heading: lower case, punctuation dropped (but - and _ kept), spaces to hyphens. */
export function anchorOf(heading: string): string {
    return heading
        .trim()
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
}

function anchorsIn(markdown: string): Set<string> {
    const out = new Set<string>();
    let fenced = false;
    for (const line of markdown.split('\n')) {
        if (line.startsWith('```')) fenced = !fenced;
        const m = !fenced && line.match(/^#{1,6} (.+)$/);
        if (m) out.add(anchorOf(m[1]!));
    }
    return out;
}

/** Every relative link and image target in a Markdown file: [text](target), <img src="target">, <a href="target">. */
function relativeTargets(markdown: string): string[] {
    const body = markdown.replace(/```[\s\S]*?```/g, '');
    const targets = [
        ...[...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!),
        ...[...body.matchAll(/<(?:img|a)\s[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1]!),
    ];
    return targets.filter((t) => !/^[a-z]+:/i.test(t));
}

describe('anchors (#521)', () => {
    test('match GitHub\'s', () => {
        expect(anchorOf('Works best with')).toBe('works-best-with');
        expect(anchorOf('Uninstalling, or going back to an older version')).toBe('uninstalling-or-going-back-to-an-older-version');
        expect(anchorOf('Debian, Ubuntu, Mint and Pop!_OS (`.deb`)')).toBe('debian-ubuntu-mint-and-pop_os-deb');
    });
});

describe('the README and docs (#521)', () => {
    for (const doc of DOCS) {
        test(`every relative link and anchor in ${doc} leads somewhere`, () => {
            const broken: string[] = [];
            for (const target of relativeTargets(read(doc))) {
                const [file, anchor] = target.split('#') as [string, string | undefined];
                const resolved = file === '' ? path.join(ROOT, doc) : path.resolve(path.dirname(path.join(ROOT, doc)), file);
                if (!existsSync(resolved)) {
                    broken.push(`${target}: no such file`);
                } else if (anchor !== undefined && resolved.endsWith('.md') && !anchorsIn(readFileSync(resolved, 'utf8')).has(anchor)) {
                    broken.push(`${target}: no such heading`);
                }
            }
            expect(broken).toEqual([]);
        });
    }

    test('the README opens with the name, the unofficial notice, the CI badge and a picture of the drive in Files', () => {
        const readme = read('README.md');
        const top = readme.slice(0, readme.indexOf('## What it does'));
        expect(top).toContain('# Proton Drive for Linux');
        expect(top).toContain('actions/workflows/ci.yml/badge.svg');
        expect(top).toContain('docs/images/files.png');
        expect(top).toMatch(/Not made, endorsed or supported by Proton AG/);
    });

    test('the Files picture is labelled an illustration with made-up files, and every app screenshot exists', () => {
        const readme = read('README.md');
        expect(readme).toMatch(/an illustration with made-up files/);
        const images = [...readme.matchAll(/src="(docs\/images\/[^"]+\.png)"/g)].map((m) => m[1]!);
        expect(images.length).toBeGreaterThanOrEqual(7);
        for (const image of images) expect(statSync(path.join(ROOT, image)).size).toBeGreaterThan(10_000);
    });

    test('installing means downloading a release, with apt rather than dpkg, and no systemd step to remember', () => {
        const readme = read('README.md');
        const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('## Works best with'));
        expect(install).toContain('https://github.com/kosidhar/proton-drive/releases');
        expect(install).toContain('sudo apt install ./kosidhar-protondrive-<version>-linux-amd64.deb');
        expect(install).not.toContain('dpkg -i');
        expect(install).not.toContain('systemctl');
        expect(install).not.toContain('dist/release');
    });

    test('the README links every guide', () => {
        const readme = read('README.md');
        for (const doc of ['docs/INSTALL.md', 'docs/USER_GUIDE.md', 'docs/CLI.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
            expect(readme).toContain(`](${doc})`);
        }
    });
});
