import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The repository is public: no tracked file may carry a developer's own home folder or a local tool session's path
// (#500). Examples use the sample homes below.
const SAMPLE_HOMES = new Set(['u', 'me', 'user']);
const SESSION_PATH = /\/tmp\/claude-\d+|-home-[a-z0-9._-]+-projects-/;
const HOME_PATH = /\/home\/([A-Za-z0-9._-]+)/g;

const root = path.join(import.meta.dir, '..');

function trackedTextFiles(): string[] {
    const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root }).stdout.toString();
    return listed
        .split('\0')
        .filter((f) => f !== '' && !f.startsWith('vendor/'))
        .filter((f) => !/\.(png|jpe?g|gif|webp|ico|svg|ttf|otf|woff2?|lockb|sqlite)$/i.test(f));
}

test('no tracked file holds a local home folder or a tool session path', () => {
    const found: string[] = [];
    for (const file of trackedTextFiles()) {
        let text: string;
        try {
            text = readFileSync(path.join(root, file), 'utf8');
        } catch {
            continue; // listed but not in the working tree (a deleted file not yet staged)
        }
        if (SESSION_PATH.test(text)) found.push(`${file}: a tool session path`);
        for (const m of text.matchAll(HOME_PATH)) {
            if (!SAMPLE_HOMES.has(m[1]!)) found.push(`${file}: /home/${m[1]}`);
        }
    }
    expect(found).toEqual([]);
});
