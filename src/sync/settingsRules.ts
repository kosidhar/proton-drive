import { matchesIgnorePatterns } from './localWatcher';

// What the settings may hold. The control socket checks a request against these before it stores anything, and
// getSettings checks what is stored (values saved before the checks existed), so a bad value never reaches the engine.

export const CONFLICT_STRATEGIES = ['keep-both', 'keep-local', 'keep-remote', 'prompt'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export const MAX_IGNORE_PATTERNS = 500;
export const MAX_IGNORE_PATTERN_LENGTH = 1024;

// Paths of every shape the patterns together must not all ignore: that would hide the whole drive
const SAMPLE_PATHS = ['a', 'b', 'a.txt', '.hidden', 'x.y.z', 'a/b', 'Documents/report.pdf', 'photos/2024/img 1.jpg', 'a/b/c/d/e'];

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
        const ignored = (sample: string, within: string[]) => matchesIgnorePatterns(sample, within);
        const hidesAll = (within: string[]) =>
            SAMPLE_PATHS.every((sample) => ignored(sample, within)) ||
            SAMPLE_PATHS.filter((sample) => sample.includes('/')).every((sample) => ignored(sample, within));
        for (const [index, pattern] of list.entries()) {
            if (hidesAll([pattern])) return `ignorePatterns[${index}] (${JSON.stringify(pattern)}) matches every file and would hide the whole drive`;
        }
        if (list.length > 1 && hidesAll(list)) return 'ignorePatterns together match every file and would hide the whole drive';
    } catch {
        return 'ignorePatterns holds a pattern that is not valid';
    }
    return null;
}

export function isConflictStrategy(value: unknown): value is ConflictStrategy {
    return typeof value === 'string' && (CONFLICT_STRATEGIES as readonly string[]).includes(value);
}
