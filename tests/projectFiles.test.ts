import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The files a public project needs (#519): a changelog the release notes come from, a private way to report a
// security problem, a contributor guide, and issue templates that ask for what a bug report needs.
const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const version = () => JSON.parse(read('package.json')).version as string;
const ADVISORIES = 'https://github.com/kosidhar/proton-drive/security/advisories/new';
// The repository is public: these files name no one's email address (example.com is fine)
const EMAIL = /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

describe('CHANGELOG.md (#519)', () => {
    const changelog = () => read('CHANGELOG.md');
    const versions = () => [...changelog().matchAll(/^## \[(\d+\.\d+\.\d+(?:-pre\.\d+)?)\] - (\d{4}-\d{2}-\d{2})$/gm)];

    test('starts with Unreleased, then has a dated section for the current version', () => {
        const headings = [...changelog().matchAll(/^## (.+)$/gm)].map((m) => m[1]);
        expect(headings[0]).toBe('[Unreleased]');
        expect(versions().map((m) => m[1])).toContain(version());
    });

    test('lists versions newest first', () => {
        const listed = versions().map((m) => m[1]!.split(/[.-]/).slice(0, 3).map(Number));
        for (let i = 1; i < listed.length; i++) {
            const [a, b] = [listed[i - 1]!, listed[i]!];
            const newer = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
            expect(newer).toBeGreaterThan(0);
        }
    });

    test('groups changes only under the Keep a Changelog headings', () => {
        for (const [, heading] of changelog().matchAll(/^### (.+)$/gm)) {
            expect(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']).toContain(heading!);
        }
    });

    test('every version links to its release', () => {
        for (const [, v] of versions()) {
            expect(changelog()).toContain(`[${v}]: https://github.com/kosidhar/proton-drive/releases/tag/v${v}`);
        }
    });
});

describe('RELEASING.md uses the changelog (#519)', () => {
    test('the bump moves Unreleased into the new version, and the notes come from that section', () => {
        const releasing = read('RELEASING.md');
        expect(releasing).toMatch(/CHANGELOG\.md/);
        expect(releasing).toMatch(/Unreleased/);
        expect(releasing).toMatch(/git commit -am "chore: release X\.Y\.Z"/);
        // The changelog edit comes before the bump's commit
        expect(releasing.indexOf('CHANGELOG.md')).toBeLessThan(releasing.indexOf('git commit -am "chore: release X.Y.Z"'));
    });
});

describe('SECURITY.md and CONTRIBUTING.md (#519)', () => {
    test('SECURITY.md says to report privately, through GitHub', () => {
        const security = read('SECURITY.md');
        expect(security).toContain(ADVISORIES);
        expect(security).toMatch(/not .*public issue|don't open a public issue/i);
    });

    test('CONTRIBUTING.md lists every check and points to CLAUDE.md for the full rules', () => {
        const contributing = read('CONTRIBUTING.md');
        const claude = read('CLAUDE.md');
        for (const check of [
            'bun test tests',
            'bunx tsc --noEmit',
            'cargo test',
            'cargo clippy --all-targets',
            'python3 linux/nautilus/test_proton_drive_nautilus.py',
            'python3 linux/tray/test_proton_drive_tray.py',
        ]) {
            expect(claude).toContain(check);
            expect(contributing).toContain(check);
        }
        expect(contributing).toContain('(CLAUDE.md)');
    });

    test('name no one\'s email address', () => {
        for (const file of ['SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/pull_request_template.md']) {
            expect(`${file}: ${read(file)}`).not.toMatch(EMAIL);
        }
    });
});

describe('issue and PR templates (#519)', () => {
    type Field = { type: string; id?: string; validations?: { required?: boolean } };
    const form = (name: string) => Bun.YAML.parse(read(`.github/ISSUE_TEMPLATE/${name}`)) as { name: string; body: Field[] };

    test('a bug report asks for the version, the system, how it was installed, the drive mode and the steps', () => {
        const bug = form('bug_report.yml');
        const required = bug.body.filter((f) => f.validations?.required).map((f) => f.id);
        for (const id of ['version', 'distro', 'install', 'drive', 'what-happened', 'steps']) {
            expect(required).toContain(id);
        }
    });

    test('a feature request asks what problem it solves', () => {
        const feature = form('feature_request.yml');
        expect(feature.body.some((f) => f.id === 'problem' && f.validations?.required)).toBe(true);
    });

    test('blank issues stay allowed, and security reports go to the private form', () => {
        const config = Bun.YAML.parse(read('.github/ISSUE_TEMPLATE/config.yml')) as {
            blank_issues_enabled: boolean;
            contact_links: { url: string }[];
        };
        expect(config.blank_issues_enabled).toBe(true);
        expect(config.contact_links.map((l) => l.url)).toContain(ADVISORIES);
    });

    test('the PR template asks for the issue, the testing and the data-safety review', () => {
        expect(existsSync(path.join(ROOT, '.github/pull_request_template.md'))).toBe(true);
        const pr = read('.github/pull_request_template.md');
        expect(pr).toMatch(/Fixes #/);
        expect(pr).toMatch(/How it was tested/);
        expect(pr).toMatch(/data safety/i);
    });
});
