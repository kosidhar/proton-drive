import { matchesIgnorePatterns } from './localWatcher';

// What the settings may hold. The control socket checks a request against these before it stores anything, and
// getSettings checks what is stored (values saved before the checks existed), so a bad value never reaches the engine.

export const CONFLICT_STRATEGIES = ['keep-both', 'keep-local', 'keep-remote', 'prompt'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export const MAX_IGNORE_PATTERNS = 500;
export const MAX_IGNORE_PATTERN_LENGTH = 1024;

// Names no real file has, so only a wildcard can match them: a pattern or a list that ignores all of these hides every
// file (or, for the nested ones, everything inside folders), whatever the files are called. Between them they differ in
// every feature a broad pattern may key on (#43): first character (lower and upper case, early and late letters, a
// digit, a dot), a hyphen or none, a digit or none, an extension or none, a space, an underscore
const SAMPLE_PATHS = [
    'zq7-a',
    'Bqk',
    '4vxq.Wz',
    '.zq7-e',
    'q x_j',
    // A file in folders is hidden when it or any folder above it is (the scan doesn't go into an ignored folder): each
    // of these starts all its names alike, so that a pattern keyed on how a name starts doesn't hide them all
    'Zq7 c/Yk3-d.zq7',
    '9vu_f/4y k',
    'aqj/ykg.w',
    '.vq/.k8',
];
const NESTED_SAMPLE_PATHS = SAMPLE_PATHS.filter((sample) => sample.includes('/'));

// Samples no name of which starts with a dot: what the file manager shows
const VISIBLE_SAMPLE_PATHS = SAMPLE_PATHS.filter((sample) => sample.split('/').every((name) => !name.startsWith('.')));

// Ordinary names, as many starting upper case as lower, files and folders, with and without extensions, some in folders.
// A sample list can be dodged by a class leaving out only the characters its names start with ([0-x]*, [!yz.]*): a list
// that hides nearly all of these hides nearly every real file, whatever the samples say (#151)
const ORDINARY_PATHS = [
    'Documents',
    'Photos/IMG_0001.jpg',
    'Desktop',
    'Music/Album/01 Track.mp3',
    'Projects/app/src/main.rs',
    'README.md',
    'Work/Q3 plan.docx',
    'Videos/clip.mp4',
    'notes.txt',
    'todo',
    'report-2024.pdf',
    'budget.xlsx',
    'résumé.pdf',
    'data.csv',
    'archive.zip',
    'keys',
];
const NEARLY_ALL = 0.9;

// Hidden as the engine hides it: the path itself, or any folder above it, ignored
function hiddenBy(patterns: string[]) {
    return (sample: string) => {
        const names = sample.split('/');
        return names.some((_, i) => matchesIgnorePatterns(names.slice(0, i + 1).join('/'), patterns));
    };
}

// Every file, every file inside folders, or every file not hidden by its name (a pattern like [!.]* leaves only
// dotfiles: the whole drive as the user sees it)
function hidesAll(patterns: string[]): boolean {
    const ignored = hiddenBy(patterns);
    return SAMPLE_PATHS.every(ignored) || NESTED_SAMPLE_PATHS.every(ignored) || VISIBLE_SAMPLE_PATHS.every(ignored);
}

// Nearly every ordinary name, by the wildcard patterns alone: a pattern naming a file or folder hides only that, however
// many of the ordinary names it happens to be (#151)
function hidesNearlyAll(patterns: string[]): boolean {
    const wildcards = patterns.filter((pattern) => /[*?[{]/.test(pattern));
    if (wildcards.length === 0) return false;
    return ORDINARY_PATHS.filter(hiddenBy(wildcards)).length >= NEARLY_ALL * ORDINARY_PATHS.length;
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
            if (hidesNearlyAll([pattern])) return `ignorePatterns[${index}] (${JSON.stringify(pattern)}) matches nearly every file and would hide most of the drive`;
        }
        if (list.length > 1 && hidesAll(list)) return 'ignorePatterns together match every file and would hide the whole drive';
        if (list.length > 1 && hidesNearlyAll(list)) return 'ignorePatterns together match nearly every file and would hide most of the drive';
    } catch {
        return 'ignorePatterns holds a pattern that is not valid';
    }
    return null;
}

// What of a stored list can be used (it may have been saved before the checks existed): the entries that are valid,
// none of which hides everything alone, or null when nothing usable is left (or the rest together hide everything), and
// the default list stands in. A stored list that is empty is a usable list that ignores nothing. `dropped` counts the
// entries left out. Judged by hidesAll only: a list saved before the check for nearly every file (#151) stays as the
// user saved it, rather than letting files they kept out start syncing after an update.
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

export const MAX_BLOCKED_APPS = 100;
// An app is named by its comm, the kernel's name of its process, which is at most 15 bytes
export const MAX_BLOCKED_APP_LENGTH = 15;

// Why a list of blocked apps can't be stored, or null when it can: a list of at most MAX_BLOCKED_APPS distinct names,
// each the name of a process (1 to 15 bytes, no '/', no control characters, no leading or trailing spaces).
export function problemWithBlockedApps(apps: unknown): string | null {
    if (!Array.isArray(apps)) return 'blockedApps must be a list of app names';
    if (apps.length > MAX_BLOCKED_APPS) return `At most ${MAX_BLOCKED_APPS} apps can be blocked`;
    const seen = new Set<string>();
    for (const app of apps) {
        if (typeof app !== 'string' || app === '') return 'Each blocked app must be a name';
        if (Buffer.byteLength(app, 'utf8') > MAX_BLOCKED_APP_LENGTH) {
            return `"${app}" is too long: an app's name has at most ${MAX_BLOCKED_APP_LENGTH} bytes`;
        }
        if (app.includes('/') || /[\u0000-\u001f\u007f]/.test(app) || app.trim() !== app) {
            return `"${app}" isn't the name of an app`;
        }
        if (seen.has(app)) return `"${app}" is listed twice`;
        seen.add(app);
    }
    return null;
}

export function isConflictStrategy(value: unknown): value is ConflictStrategy {
    return typeof value === 'string' && (CONFLICT_STRATEGIES as readonly string[]).includes(value);
}
