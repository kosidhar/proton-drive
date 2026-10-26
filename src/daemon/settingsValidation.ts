import { matchesIgnorePatterns } from '../sync/localWatcher';
import { CONFLICT_STRATEGIES, type SyncSettings } from '../sync/syncStateDb';

export const MAX_IGNORE_PATTERNS = 500;
export const MAX_IGNORE_PATTERN_LENGTH = 1024;

// Paths of every shape a pattern must not all ignore: one that does would hide the whole drive
const SAMPLE_PATHS = ['a', 'a.txt', '.hidden', 'x.y.z', 'a/b', 'Documents/report.pdf', 'photos/2024/img 1.jpg', 'a/b/c/d/e'];

function problemWithPattern(pattern: unknown, index: number): string | null {
    const which = `ignorePatterns[${index}]`;
    if (typeof pattern !== 'string' || !pattern.trim()) return `${which} must be a non-empty pattern`;
    if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) return `${which} is longer than ${MAX_IGNORE_PATTERN_LENGTH} characters`;
    if (pattern.includes('\0')) return `${which} must not contain a null character`;
    try {
        const ignored = (sample: string) => matchesIgnorePatterns(sample, [pattern]);
        // Everything, or everything inside a folder (what '*/**' hides): either way the drive would show nothing
        if (SAMPLE_PATHS.every(ignored) || SAMPLE_PATHS.filter((sample) => sample.includes('/')).every(ignored)) {
            return `${which} (${JSON.stringify(pattern)}) matches every file and would hide the whole drive`;
        }
    } catch {
        return `${which} is not a valid pattern`;
    }
    return null;
}

export type ParsedSettings = { ok: true; value: Partial<SyncSettings> } | { ok: false; error: string };

// The settings the app may change over the TCP API: ignorePatterns (at most 500 non-empty patterns of at most 1024
// characters, none of which matches everything), conflictStrategy (one the engine knows) and notificationsEnabled
// (true or false). Checks all of them before anything is stored; keys it doesn't know are left out of the value.
export function parseSettings(body: Record<string, unknown>): ParsedSettings {
    const value: Partial<SyncSettings> = {};
    const { ignorePatterns, conflictStrategy, notificationsEnabled } = body;
    if (ignorePatterns !== undefined) {
        if (!Array.isArray(ignorePatterns)) return { ok: false, error: 'ignorePatterns must be a list of patterns' };
        if (ignorePatterns.length > MAX_IGNORE_PATTERNS) return { ok: false, error: `ignorePatterns holds more than ${MAX_IGNORE_PATTERNS} patterns` };
        for (const [index, pattern] of ignorePatterns.entries()) {
            const problem = problemWithPattern(pattern, index);
            if (problem) return { ok: false, error: problem };
        }
        value.ignorePatterns = ignorePatterns as string[];
    }
    if (conflictStrategy !== undefined) {
        if (typeof conflictStrategy !== 'string' || !(CONFLICT_STRATEGIES as readonly string[]).includes(conflictStrategy)) {
            return { ok: false, error: `conflictStrategy must be one of ${CONFLICT_STRATEGIES.join(', ')}` };
        }
        value.conflictStrategy = conflictStrategy as SyncSettings['conflictStrategy'];
    }
    if (notificationsEnabled !== undefined) {
        if (typeof notificationsEnabled !== 'boolean') return { ok: false, error: 'notificationsEnabled must be true or false' };
        value.notificationsEnabled = notificationsEnabled;
    }
    return { ok: true, value };
}
