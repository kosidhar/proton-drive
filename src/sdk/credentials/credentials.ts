import { randomBytes } from 'node:crypto';
import { SessionFileRefusedError } from './sessionLocation';

import { Logger } from '@protontech/drive-sdk';

import type { SessionCredentials, SessionInfo } from 'proton-drive-sdk-account';

import type { CredentialsStore } from './interface';
import type { SessionLocation } from './sessionLocation';

export class Credentials implements SessionCredentials {
    private cachePassword?: string;
    private userKeyPassword?: string;
    private sessionInfo?: SessionInfo;
    private telemetryEnabled?: boolean;

    private readonly sessionInfoChangedCallbacks = new Set<() => void>();

    constructor(
        private readonly store: CredentialsStore,
        private readonly logger: Logger,
    ) {}

    on(_: 'sessionInfoChanged', callback: () => void): void {
        this.sessionInfoChangedCallbacks.add(callback as () => void);
    }

    isLoggedIn(): boolean {
        return !!this.userKeyPassword && !!this.sessionInfo;
    }

    /** Where the session is kept; null when there is none. A store that does not say is the keyring. */
    sessionLocation(): SessionLocation | null {
        return this.store.location ? this.store.location() : { storage: 'keyring' };
    }

    isTelemetryEnabled(): boolean {
        if (!this.isLoggedIn()) {
            return false;
        }
        return this.telemetryEnabled ?? false;
    }

    getUserKeyPassword(): string | undefined {
        return this.userKeyPassword;
    }

    async getCachePassword(): Promise<string> {
        if (!this.cachePassword) {
            this.cachePassword = randomBytes(32).toString('base64');
            await this.persistCredentials();
        }
        return this.cachePassword;
    }

    get uid(): string | undefined {
        return this.sessionInfo?.uid;
    }

    get accessToken(): string | undefined {
        return this.sessionInfo?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.sessionInfo?.refreshToken;
    }

    async load(): Promise<void> {
        const raw = await this.store.load();
        if (!raw) {
            this.logger.debug(`No session loaded`);
            return;
        }
        this.cachePassword = raw.cachePassword;
        this.userKeyPassword = raw.userKeyPassword;
        this.sessionInfo = raw.session;
        this.telemetryEnabled = raw.telemetryEnabled;
        this.notifySessionInfoChanged();
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.userKeyPassword = userKeyPassword;
        await this.persistCredentials();
        this.notifySessionInfoChanged();
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.sessionInfo = info;
        await this.persistCredentials();
        this.notifySessionInfoChanged();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this.telemetryEnabled = enabled;
        await this.persistCredentials();
    }

    async signOut(): Promise<void> {
        this.logger.debug(`Signing out`);
        this.userKeyPassword = undefined;
        this.sessionInfo = undefined;
        this.telemetryEnabled = undefined;
        await this.store.remove();
        this.notifySessionInfoChanged();
    }

    private async persistCredentials(): Promise<void> {
        if (!this.userKeyPassword || !this.sessionInfo) {
            return;
        }
        try {
            await this.saveSnapshot(this.userKeyPassword, this.sessionInfo);
        } catch (error) {
            // The user chose no stored session over a file (PROTONDRIVE_NO_FILE_SESSION) and there's no keyring: the
            // session must not live on in memory either, or the app would say signed in after saying it is not (#537)
            if (error instanceof SessionFileRefusedError) {
                this.userKeyPassword = undefined;
                this.sessionInfo = undefined;
                this.notifySessionInfoChanged();
            }
            throw error;
        }
    }

    private async saveSnapshot(userKeyPassword: string, session: SessionInfo): Promise<void> {
        await this.store.save({
            cachePassword: this.cachePassword,
            userKeyPassword,
            session,
            telemetryEnabled: this.telemetryEnabled,
        });
    }

    private notifySessionInfoChanged(): void {
        this.sessionInfoChangedCallbacks.forEach((callback) => callback());
    }
}
