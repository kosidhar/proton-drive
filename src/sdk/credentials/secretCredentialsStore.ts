import { Logger, ValidationError } from '@protontech/drive-sdk';

import { CREDENTIALS_NAME, CREDENTIALS_SERVICE } from './constants';
import type { Credentials, CredentialsStore } from './interface';
import { parseStoredSnapshot } from './parseCredentials';

export class SecretsSessionStore implements CredentialsStore {
    constructor(
        private readonly logger: Logger,
        private readonly fallbackStore?: CredentialsStore,
    ) {}

    async load(): Promise<Credentials | null> {
        this.logger.debug(`Loading session ${CREDENTIALS_NAME} from secrets`);
        try {
            const raw = await Bun.secrets.get({ service: CREDENTIALS_SERVICE, name: CREDENTIALS_NAME });
            const parsed = parseStoredSnapshot(raw);
            if (parsed) {
                return parsed;
            }
            if (this.fallbackStore) {
                return await this.fallbackStore.load();
            }
            return null;
        } catch (error: unknown) {
            if (this.fallbackStore) {
                this.logger.debug(`OS keyring unavailable, falling back to local XDG session store`);
                return await this.fallbackStore.load();
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
                this.logger.debug(`OS keyring unavailable, saving session to local XDG session store`);
                await this.fallbackStore.save(snapshot);
                return;
            }
            throw error;
        }
    }

    async remove(): Promise<void> {
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
