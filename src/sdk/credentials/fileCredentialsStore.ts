import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { Logger } from '@protontech/drive-sdk';

import type { Credentials, CredentialsStore } from './interface';
import { parseStoredSnapshot } from './parseCredentials';
import type { SessionLocation } from './sessionLocation';

const UNSAFE_SESSION_FILENAME = 'auth-session.json';

export class PlaintextFileSessionStore implements CredentialsStore {
    private readonly filePath: string;
    private warned = false;

    constructor(private readonly cacheDir: string, private readonly logger: Logger) {
        this.filePath = path.join(this.cacheDir, UNSAFE_SESSION_FILENAME);
    }

    location(): SessionLocation {
        return { storage: 'file', path: this.filePath };
    }

    // Once per run, at warning level: the session is a plain file, which the user should know (#537)
    private warnOnce(): void {
        if (this.warned) return;
        this.warned = true;
        this.logger.warn(
            `The session is kept in a plain file, ${this.filePath} (mode 0600, readable by anything running as you), ` +
                `because no keyring is available. Install a Secret Service keyring such as GNOME Keyring or KWallet to keep it there.`,
        );
    }

    async load(): Promise<Credentials | null> {
        const file = Bun.file(this.filePath);
        if (!(await file.exists())) {
            this.logger.debug(`Session file does not exist: ${this.filePath}`);
            return null;
        }
        this.logger.debug(`Loading session from file: ${this.filePath}`);
        const parsed = parseStoredSnapshot(await file.text());
        if (parsed) this.warnOnce();
        return parsed;
    }

    async save(snapshot: Credentials): Promise<void> {
        this.logger.debug(`Saving session to file: ${this.filePath}`);
        await Bun.write(this.filePath, JSON.stringify(snapshot), { mode: 0o600 });
        this.warnOnce();
    }

    async remove(): Promise<void> {
        this.logger.debug(`Removing session file: ${this.filePath}`);
        try {
            await unlink(this.filePath);
        } catch (err: unknown) {
            const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
            if (code !== 'ENOENT') {
                throw err;
            }
        }
    }
}
