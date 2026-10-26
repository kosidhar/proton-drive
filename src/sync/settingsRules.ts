import { matchesIgnorePatterns } from './localWatcher';

// What the settings may hold. The control socket checks a request against these before it stores anything, and
// getSettings checks what is stored (values saved before the checks existed), so a bad value never reaches the engine.

export const CONFLICT_STRATEGIES = ['keep-both', 'keep-local', 'keep-remote', 'prompt'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export const MAX_IGNORE_PATTERNS = 500;
export const MAX_IGNORE_PATTERN_LENGTH = 1024;

// Names no real file has, so only a wildcard can match them: a pattern or a list that ignores all of these hides every
// file (or, for the nested ones, everything inside folders), whatever the files are called
const SAMPLE_PATHS = ['zq7-a', 'zq7-b.zq7', 'zq7-c/yk3-d.zq7', '.zq7-e', 'vu9-f/yk3-g/xw5-h'];
const NESTED_SAMPLE_PATHS = SAMPLE_PATHS.filter((sample) => sample.includes('/'));

function hidesAll(patterns: string[]): boolean {
    const ignored = (sample: string) => matchesIgnorePatterns(sample, patterns);
    return SAMPLE_PATHS.every(ignored) || NESTED_SAMPLE_PATHS.every(ignored);
}

function problemWithPattern(pattern: unknown, index: number): string | null {
    const which = `ignorePatterns[${index}]`;
    if (typeof pattern !== 'string' || !pattern.trim()) return `${which} must be a non-empty pattern`;
    if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) return `${which} is longer than ${MAX_IGNORE_PATTERN_LENGTH} characters`;
    if (pattern.includes('\0')) return `${which} must not contain a null character`;
    return null;
}

// Why a list of ignore patterns can't be used, or null when it can: a list of at most 500 non-empty strings of at most
// 1024 characters, valid as globs, that together (and none alone) ignore every file, or every file inside folders
export function problemWithIgnorePatterns(patterns: unknown): string | null {
    if (!Array.isArray(patterns)) return 'ignorePatterns must be a list of patterns';
    if (patterns.length > MAX_IGNORE_PATTERNS) return `ignorePatterns holds more than ${MAX_IGNORE_PATTERNS} patterns`;
    for (const [index, pattern] of patterns.entries()) {
        const problem = problemWithPattern(pattern, index);
        if (problem) return problem;
    }
    const list = patterns as string[];
    try {
        for (const [index, pattern] of list.entries()) {
            if (hidesAll([pattern])) return `ignorePatterns[${index}] (${JSON.stringify(pattern)}) matches every file and would hide the whole drive`;
        }
        if (list.length > 1 && hidesAll(list)) return 'ignorePatterns together match every file and would hide the whole drive';
    } catch {
        return 'ignorePatterns holds a pattern that is not valid';
    }
    return null;
}

// What of a stored list can be used (it may have been saved before the checks existed): the entries that are valid,
// none of which hides everything alone, or null when nothing usable is left (or the rest together hide everything), and
// the default list stands in. A stored list that is empty is a usable list that ignores nothing. `dropped` counts the
// entries left out.
export function usableIgnorePatterns(stored: unknown): { patterns: string[]; dropped: number } | null {
    if (!Array.isArray(stored)) return null;
    const usable: string[] = [];
    for (const [index, pattern] of stored.entries()) {
        try {
            if (problemWithPattern(pattern, index) === null && !hidesAll([pattern as string])) usable.push(pattern as string);
        } catch {
            // a pattern that is not valid is left out
        }
    }
    const patterns = usable.slice(0, MAX_IGNORE_PATTERNS);
    if (stored.length > 0 && patterns.length === 0) return null;
    try {
        if (patterns.length > 1 && hidesAll(patterns)) return null;
    } catch {
        return null;
    }
    return { patterns, dropped: stored.length - patterns.length };
}

export function isConflictStrategy(value: unknown): value is ConflictStrategy {
    return typeof value === 'string' && (CONFLICT_STRATEGIES as readonly string[]).includes(value);
}
