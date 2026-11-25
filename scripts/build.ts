#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dir, '..');
const outDir = path.join(rootDir, 'release');
await mkdir(outDir, { recursive: true });

const outfile = path.join(outDir, 'protondrive');
const appVersion = process.env.PROTON_DRIVE_APP_VERSION || 'external-drive-ubuntu_sync@0.1.0-alpha';
const sdkVersion = 'js@0.0.1';

console.log(`Building standalone executable -> ${outfile}`);
const proc = Bun.spawn(
    [
        process.execPath,
        'build',
        '--compile',
        '--target=bun',
        '--format=esm',
        '--minify',
        '--sourcemap=inline',
        '--define',
        `APP_VERSION=${JSON.stringify(appVersion)}`,
        '--define',
        `SDK_VERSION=${JSON.stringify(sdkVersion)}`,
        path.join(rootDir, 'src/cli/main.ts'),
        `--outfile=${outfile}`,
    ],
    {
        cwd: rootDir,
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, NODE_ENV: 'production' },
    },
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
    process.exit(exitCode);
}
console.log(`Successfully built ${outfile}`);
