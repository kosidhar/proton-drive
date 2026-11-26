import { Logger } from '@protontech/drive-sdk';

import type { Config } from '../config';
import { Credentials } from './credentials';
import { PlaintextFileSessionStore } from './fileCredentialsStore';
import type { CredentialsStore } from './interface';
import { PassSessionStore } from './passCredentialsStore';
import { SecretsSessionStore } from './secretCredentialsStore';

export type { Credentials } from './credentials';
export { describeSessionFields, describeSessionLocation, NO_FILE_SESSION_ENV, sessionFields } from './sessionLocation';
export type { SessionLocation } from './sessionLocation';

export function initCredentials(config: Config, logger: Logger): Credentials {
    const credentialsStore = createAuthSessionStore(config, logger);
    return new Credentials(credentialsStore, logger);
}

function createAuthSessionStore(config: Config, logger: Logger): CredentialsStore {
    const fileFallback = new PlaintextFileSessionStore(config.appDir, logger);
    switch (config.credentialsStore) {
        case 'unsafe_file':
            return fileFallback;
        case 'pass':
            return new PassSessionStore(logger);
        case 'keychain':
            return new SecretsSessionStore(logger, fileFallback, { refuseFile: config.noFileSession });
        default:
            throw new Error(`Invalid credentials store: ${config.credentialsStore}`);
    }
}
