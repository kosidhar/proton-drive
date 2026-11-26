#!/usr/bin/env bun
// Sets the app's version everywhere it is written down: package.json (the one source of truth), both
// Cargo.toml files and their Cargo.lock entries, and the Arch PKGBUILD (with pkgrel reset to 1).
//
//   bun run set-version 0.2.0 [--root <dir>]
//
// The Proton API identity (`external-drive-ubuntu_sync@...`) is deliberately not touched: Proton sees it.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-pre\.\d+)?$/;

function fail(message: string): never {
    console.error(`set-version: ${message}`);
    process.exit(1);
}

function replaceOnce(text: string, pattern: RegExp, replacement: string, what: string): string {
    if (!pattern.test(text)) fail(`could not find ${what}`);
    return text.replace(pattern, replacement);
}

const args = process.argv.slice(2);
let root = path.resolve(import.meta.dir, '..');
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') {
        const value = args[++i];
        if (!value) fail('--root needs a directory');
        root = path.resolve(value);
    } else {
        positional.push(args[i]!);
    }
}
if (positional.length !== 1) fail('usage: set-version <MAJOR.MINOR.PATCH[-pre.N]> [--root <dir>]');
const version = positional[0]!;
if (!VERSION_PATTERN.test(version)) {
    fail(`"${version}" is not a version: use MAJOR.MINOR.PATCH, optionally with a -pre.N suffix (for example 1.2.3 or 1.2.3-pre.1)`);
}

// Compute every new text first, so a missing line in any file leaves all of them untouched.
const edits: Array<[string, (text: string) => string]> = [
    ['package.json', (t) => replaceOnce(t, /("version":\s*")[^"]*(")/, `$1${version}$2`, 'the "version" field')],
    ...(['native-gui/Cargo.toml', 'native-vfs/Cargo.toml'] as const).map(
        (rel): [string, (text: string) => string] => [
            rel,
            (t) => replaceOnce(t, /(\[package\][^[]*?\nversion = ")[^"]*(")/, `$1${version}$2`, '[package] version'),
        ],
    ),
    ['native-gui/Cargo.lock', (t) => replaceOnce(t, /(name = "protondrive-gui"\nversion = ")[^"]*(")/, `$1${version}$2`, 'the protondrive-gui entry')],
    ['native-vfs/Cargo.lock', (t) => replaceOnce(t, /(name = "protondrive-vfs"\nversion = ")[^"]*(")/, `$1${version}$2`, 'the protondrive-vfs entry')],
    [
        'packaging/linux/arch/PKGBUILD',
        (t) => replaceOnce(replaceOnce(t, /^pkgver=.*$/m, `pkgver=${version}`, 'pkgver'), /^pkgrel=.*$/m, 'pkgrel=1', 'pkgrel'),
    ],
];

const results = edits.map(([rel, edit]) => {
    const file = path.join(root, rel);
    return { rel, file, text: edit(readFileSync(file, 'utf8')) };
});
for (const { rel, file, text } of results) {
    writeFileSync(file, text);
    console.log(`set ${version} in ${rel}`);
}
