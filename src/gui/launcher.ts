import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function launchDesktopWindow(_url?: string): void {
    const nativeGuiCandidates = [
        path.join(path.dirname(process.execPath), 'protondrive-gui'),
        path.join(process.cwd(), 'release', 'protondrive-gui'),
        path.join(homedir(), '.local', 'bin', 'protondrive-gui'),
        '/usr/bin/protondrive-gui',
    ];

    for (const binPath of nativeGuiCandidates) {
        if (existsSync(binPath)) {
            const child = spawn(binPath, [], {
                detached: true,
                stdio: 'ignore',
            });
            child.on('error', () => {});
            child.unref();
            return;
        }
    }

    const fallback = spawn('protondrive-gui', [], {
        detached: true,
        stdio: 'ignore',
    });
    fallback.on('error', () => {});
    fallback.unref();
}
