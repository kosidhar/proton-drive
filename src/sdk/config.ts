import { homedir } from 'node:os';
import path from 'node:path';

import { type SearchServiceProvider, ValidationError } from '@protontech/drive-sdk';
import { LogLevel } from '@protontech/drive-sdk/telemetry';

const APP_DIR_NAME = 'proton-drive-ubuntu';

export enum CredentialsStoreType {
    Keychain = 'keychain',
    UnsafeFile = 'unsafe_file',
    Pass = 'pass',
}

export interface InitConfig {
    appVersion: string;
    sdkVersion?: string;
    clientUidPrefix: string;
    enablePersistedEvents?: boolean;
    enableConsoleLog?: boolean;
    enableMetrics?: boolean;
    flags?: Record<string, boolean>;
    /** Search is experimental and only wired up by the internal CLI. */
    searchServiceProvider?: SearchServiceProvider;
}

export interface Config {
    /** Client UID is auto generated at the first run with a given prefix. */
    clientUidPrefix: string;
    /** Version of the CLI. */
    appVersion: string;
    /** Client ID for the authentication. cli-drive for the official CLI, external-drive for 3p forks. */
    authClientId: string;
    /** Version of the SDK used by the CLI. */
    sdkVersion?: string;
    /** Base URL for the API. */
    baseUrl: string;
    /** Base URL for the account (login) web pages. */
    accountUrl: string;

    /** Cache folder for ephemeral files (cryptographic cache, etc.). */
    cacheDir: string;
    /** App data folder for persistent files (events, client UID, etc.). */
    appDir: string;
    /** Folder for storing log files. */
    logDir: string;

    /** Whether to enable persisted events, stored in the app data folder. */
    enablePersistedEvents: boolean;
    /** Whether to enable printing logs to the console. */
    enableConsoleLog: boolean;
    /** Whether to enable sending anonymized operational metrics. */
    enableMetrics: boolean;
    /** Level of logging to both console and log file. */
    logLevel: LogLevel;
    /** The level for the SDK's own loggers (api, download, upload, nodes…), which log a line per block at INFO. */
    sdkLogLevel: LogLevel;

    /** Where to persist the authenticated session. */
    credentialsStore: CredentialsStoreType;
    /** PROTONDRIVE_NO_FILE_SESSION: with no keyring, refuse to save the session to a file. */
    noFileSession: boolean;
    /** Only for testing: store cryptographic cache unencrypted. */
    unsafeCache: boolean;
}

export function getConfig(options: InitConfig): Config {
    // The app's own lines at INFO and the SDK's at WARNING by default: the SDK's DEBUG and INFO lines (each API call,
    // several per file and per block) filled the rotating log files within hours, taking what the sync engine logged
    // with them (#180). PROTON_DRIVE_LOG_LEVEL sets both; without it, -v (the console log) asks for DEBUG
    const fromEnv = process.env.PROTON_DRIVE_LOG_LEVEL
        ? LogLevel[process.env.PROTON_DRIVE_LOG_LEVEL.toUpperCase() as keyof typeof LogLevel]
        : undefined;
    const logLevel = fromEnv ?? (options.enableConsoleLog ? LogLevel.DEBUG : LogLevel.INFO);
    const sdkLogLevel = fromEnv ?? (options.enableConsoleLog ? LogLevel.DEBUG : LogLevel.WARNING);

    const { cacheDir, appDir, logDir } = defaultDataDirs();

    const baseUrl = process.env.PROTON_DRIVE_BASE_URL || 'drive-api.proton.me';

    return {
        clientUidPrefix: options.clientUidPrefix,
        appVersion: options.appVersion,
        authClientId: options.appVersion.startsWith('cli-drive') ? 'cli-drive' : 'external-drive',
        sdkVersion: options.sdkVersion,
        baseUrl,
        accountUrl: accountUrlFromBaseUrl(baseUrl),
        cacheDir,
        appDir,
        logDir,
        enablePersistedEvents: options.enablePersistedEvents || false,
        enableConsoleLog: options.enableConsoleLog || false,
        enableMetrics: options.enableMetrics || false,
        logLevel,
        sdkLogLevel,
        credentialsStore: parseCredentialsStore(process.env.PROTON_DRIVE_CREDENTIALS_STORE),
        noFileSession: parseBooleanEnv(process.env.PROTONDRIVE_NO_FILE_SESSION),
        unsafeCache: parseBooleanEnv(process.env.PROTON_DRIVE_UNSAFE_CACHE),
    };
}

/**
 * Derives the account URL from the API base URL by swapping the `drive-api` host label for `account`,
 * e.g. `drive-api.houssay.proton.black` into `account.houssay.proton.black`.
 * Falls back to `account.proton.black`/`account.proton.me` when the base URL doesn't follow that pattern.
 */
function accountUrlFromBaseUrl(baseUrl: string): string {
    if (baseUrl.startsWith('drive-api.')) {
        return baseUrl.replace(/^drive-api\./, 'account.');
    }
    return baseUrl.endsWith('.black') ? 'account.proton.black' : 'account.proton.me';
}

function defaultDataDirs(): Pick<Config, 'cacheDir' | 'appDir' | 'logDir'> {
    const home = homedir();
    const override = process.env.PROTON_DRIVE_CACHE_DIR;
    if (override) {
        return { cacheDir: override, appDir: override, logDir: override };
    }

    const xdgCache = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const xdgState = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
    return {
        cacheDir: path.join(xdgCache, APP_DIR_NAME),
        appDir: path.join(xdgData, APP_DIR_NAME),
        logDir: path.join(xdgState, APP_DIR_NAME),
    };
}

function parseCredentialsStore(value: string | undefined): CredentialsStoreType {
    const normalized = value?.toLowerCase() ?? 'keychain';
    const allowedValues = Object.values(CredentialsStoreType);
    if (allowedValues.includes(normalized as CredentialsStoreType)) {
        return normalized as CredentialsStoreType;
    }
    throw new ValidationError(
        `Invalid PROTON_DRIVE_CREDENTIALS_STORE: ${value}. Expected one of: ${allowedValues.join(', ')}.`,
    );
}

function parseBooleanEnv(value: string | undefined): boolean {
    return ['yes', 'y', '1', 'true'].includes(value?.toLowerCase() ?? '');
}
