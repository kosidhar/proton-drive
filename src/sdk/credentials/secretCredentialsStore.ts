import { Logger, ValidationError } from '@protontech/drive-sdk';

import { CREDENTIALS_NAME, CREDENTIALS_SERVICE } from './constants';
import type { Credentials, CredentialsStore } from './interface';
import { parseStoredSnapshot } from './parseCredentials';
import { NO_FILE_SESSION_ENV, SessionFileRefusedError, type SessionLocation } from './sessionLocation';

export class SecretsSessionStore implements CredentialsStore {
    private where: SessionLocation | null = null;

    constructor(
        private readonly logger: Logger,
        private readonly fallbackStore?: CredentialsStore,
        // refuseFile: with no keyring, do not write the session to the fallback file (PROTONDRIVE_NO_FILE_SESSION)
        private readonly options: { refuseFile?: boolean } = {},
    ) {}

    location(): SessionLocation | null {
        return this.where;
    }

    private fileLocation(): SessionLocation {
        return this.fallbackStore?.location?.() ?? { storage: 'file' };
    }

    async load(): Promise<Credentials | null> {
        this.logger.debug(`Loading session ${CREDENTIALS_NAME} from secrets`);
        try {
            const raw = await Bun.secrets.get({ service: CREDENTIALS_SERVICE, name: CREDENTIALS_NAME });
            const parsed = parseStoredSnapshot(raw);
            if (parsed) {
                this.where = { storage: 'keyring' };
                return parsed;
            }
            if (this.fallbackStore) {
                const fromFile = await this.fallbackStore.load();
                if (fromFile) this.where = this.fileLocation();
                return fromFile;
            }
            return null;
        } catch (error: unknown) {
            if (this.fallbackStore) {
                this.logger.debug(`OS keyring unavailable, falling back to local XDG session store`);
                const fromFile = await this.fallbackStore.load();
                if (fromFile) this.where = this.fileLocation();
                return fromFile;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ValidationError(
                `Failed to load session from secrets (ensure you have secrets available, read the README for more information): ${message}`,
                undefined,
                { cause: error },
            );
        }
    }

    async save(snapshot: Credentials): Promise<void> {
        this.logger.debug(`Saving session ${CREDENTIALS_NAME} to secrets`);
        try {
            await Bun.secrets.set({
                service: CREDENTIALS_SERVICE,
                name: CREDENTIALS_NAME,
                value: JSON.stringify(snapshot),
            });
        } catch (error: unknown) {
            if (this.fallbackStore) {
                if (this.options.refuseFile) {
                    throw new SessionFileRefusedError(
                        `No keyring is available, and ${NO_FILE_SESSION_ENV} is set, so the session was not saved to a file. ` +
                            `You stay signed out. Install a Secret Service keyring (GNOME Keyring or KWallet) or unset ${NO_FILE_SESSION_ENV}.`,
                        { cause: error },
                    );
                }
                this.logger.debug(`OS keyring unavailable, saving session to local XDG session store`);
                await this.fallbackStore.save(snapshot);
                this.where = this.fileLocation();
                return;
            }
            throw error;
        }
        this.where = { storage: 'keyring' };
        // Only reached once the keyring holds the session: drop any plaintext
        // copy left from an earlier keyring outage. Never fails the save.
        if (this.fallbackStore) {
            try {
                await this.fallbackStore.remove();
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.debug(`Could not remove the stale fallback session: ${message}`);
            }
        }
    }

    async remove(): Promise<void> {
        this.where = null;
        this.logger.debug(`Removing session ${CREDENTIALS_NAME} from secrets`);
        try {
            await Bun.secrets.delete({ service: CREDENTIALS_SERVICE, name: CREDENTIALS_NAME });
        } catch {
            // Ignore keyring errors on remove
        }
        if (this.fallbackStore) {
            await this.fallbackStore.remove().catch(() => {});
        }
    }
}
