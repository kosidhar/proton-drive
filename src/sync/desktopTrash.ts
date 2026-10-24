// Moves a file or folder to the desktop Trash, where the file manager shows it and can restore it. True when moved.
export type MoveToDesktopTrash = (fullPath: string) => Promise<boolean>;

// Runs `argv` with the path appended as one more argument. Moved only when it exits 0: a failure, a command that
// can't be started, or one still running after `timeoutMs` (it is then killed) all count as not moved.
export function trashCommand(argv: string[], timeoutMs = 60_000): MoveToDesktopTrash {
    return async (fullPath) => {
        try {
            const proc = Bun.spawn([...argv, fullPath], {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                timeout: timeoutMs,
            });
            return (await proc.exited) === 0;
        } catch {
            return false;
        }
    };
}

// GIO's trash, as the Files app uses: the home Trash, or `.Trash-$uid` at the top of another drive. `--` keeps a path
// starting with '-' from being read as an option. Never `--force`, which also counts a missing path as trashed.
export const gioTrash: MoveToDesktopTrash = trashCommand(['gio', 'trash', '--']);
