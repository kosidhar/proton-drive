import { isConflictStrategy, CONFLICT_STRATEGIES, RETIRED_CONFLICT_STRATEGIES, problemWithBlockedApps, problemWithIgnorePatterns } from '../sync/settingsRules';
import type { SyncSettings } from '../sync/syncStateDb';

export { MAX_IGNORE_PATTERN_LENGTH, MAX_IGNORE_PATTERNS } from '../sync/settingsRules';

export type ParsedSettings = { ok: true; value: Partial<SyncSettings> } | { ok: false; error: string };

// The plain settings the app may change: ignorePatterns, conflictStrategy, notificationsEnabled and blockedApps (see
// sync/settingsRules.ts for what they may hold). Checks all of them before anything is stored; keys it doesn't know
// are left out of the value (parseSettingsRequest refuses them).
export function parseSettings(body: Record<string, unknown>): ParsedSettings {
    const value: Partial<SyncSettings> = {};
    const { ignorePatterns, conflictStrategy, notificationsEnabled, blockedApps, startAtLogin } = body;
    if (ignorePatterns !== undefined) {
        const problem = problemWithIgnorePatterns(ignorePatterns);
        if (problem) return { ok: false, error: problem };
        value.ignorePatterns = ignorePatterns as string[];
    }
    if (conflictStrategy !== undefined) {
        if (typeof conflictStrategy === 'string' && RETIRED_CONFLICT_STRATEGIES.includes(conflictStrategy)) {
            return {
                ok: false,
                error: `conflictStrategy ${conflictStrategy} is no longer offered: a conflict always keeps both versions (keep-both, or prompt to choose each time)`,
            };
        }
        if (!isConflictStrategy(conflictStrategy)) {
            return { ok: false, error: `conflictStrategy must be one of ${CONFLICT_STRATEGIES.join(', ')}` };
        }
        value.conflictStrategy = conflictStrategy;
    }
    if (notificationsEnabled !== undefined) {
        if (typeof notificationsEnabled !== 'boolean') return { ok: false, error: 'notificationsEnabled must be true or false' };
        value.notificationsEnabled = notificationsEnabled;
    }
    if (startAtLogin !== undefined) {
        if (typeof startAtLogin !== 'boolean') return { ok: false, error: 'startAtLogin must be true or false' };
        value.startAtLogin = startAtLogin;
    }
    if (blockedApps !== undefined) {
        const problem = problemWithBlockedApps(blockedApps);
        if (problem) return { ok: false, error: problem };
        value.blockedApps = blockedApps as string[];
    }
    return { ok: true, value };
}

// What POST /drive/settings on the control socket accepts: the plain settings (settings), and the drive folder and
// the virtual drive switch, which move files
export interface SettingsChange {
    settings: Partial<SyncSettings>;
    syncDir?: string;
    virtualDriveWanted?: boolean;
}

const SETTING_KEYS: readonly string[] = [
    'ignorePatterns',
    'conflictStrategy',
    'notificationsEnabled',
    'startAtLogin',
    'blockedApps',
    'syncDir',
    'virtualDriveWanted',
];

// Checks every field of a request (unknown keys are refused) before anything is stored
export function parseSettingsRequest(body: Record<string, unknown>): { ok: true; value: SettingsChange } | { ok: false; error: string } {
    const unknown = Object.keys(body).filter((key) => !SETTING_KEYS.includes(key));
    if (unknown.length > 0) return { ok: false, error: `Unknown setting: ${unknown.join(', ')}` };
    const { syncDir, virtualDriveWanted } = body;
    if (syncDir !== undefined && (typeof syncDir !== 'string' || !syncDir.trim())) return { ok: false, error: 'syncDir must be the path of a folder' };
    if (virtualDriveWanted !== undefined && typeof virtualDriveWanted !== 'boolean') return { ok: false, error: 'virtualDriveWanted must be true or false' };
    const plain = parseSettings(body);
    if (!plain.ok) return plain;
    return { ok: true, value: { settings: plain.value, syncDir, virtualDriveWanted } };
}
