// The app's own temporary and junk files. They are not a setting: matchesIgnorePatterns always applies them, because
// the app's own temporary files (and a browser's half-downloaded ones) must never sync, whatever the user's list says.
// They are not in the stored list, so the user can neither remove them by mistake nor see them as theirs to edit.
// Its own module so that the file watcher, which applies them, needs nothing that needs the watcher back.
export const BUILTIN_IGNORE_PATTERNS: readonly string[] = ['.proton-drive-tmp-*', '*.part', '*.crdownload', '.DS_Store', '.Trash-*'];
