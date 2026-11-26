# Command line

`protondrive` runs the background service and does the everyday things from a terminal: status, sync, pause, keeping or freeing files, conflicts, and direct uploads and downloads. `protondrive --help` lists every command.

```bash
# The app and the background service
protondrive gui                            # Open the app (starts the service if needed)
protondrive daemon                         # Run the background service: sync, the drive and the local API

# Status and syncing
protondrive status [--json]                # Sync status, the sync folder and file counts
protondrive status <path>                  # Whether an item is kept, downloaded, online only or hidden
protondrive sync                           # Sync now
protondrive pause / resume                 # Pause or resume syncing

# What's on this computer
protondrive pin <path>                     # Always keep a file or folder on this device
protondrive free <path>                    # Free up space: make downloaded files online only
protondrive hide <path>                    # Hide a file or folder from this computer
protondrive unhide <path>                  # Unhide it (it becomes online only)
protondrive selective-sync list            # Top-level folders and their availability
protondrive selective-sync exclude <path>  # Same as hide
protondrive selective-sync include <path>  # Same as unhide

# Conflicts
protondrive conflicts                      # List conflicts
protondrive conflicts resolve <id> <mode>  # Resolve one: keep-both, keep-local or keep-remote

# Your account
protondrive auth login                     # Sign in, in your browser
protondrive auth logout                    # Sign out and clear the local caches
protondrive auth status                    # Whether you're signed in

# Proton Drive directly, without the sync folder
protondrive ls [/my-files]                 # List a folder in Proton Drive
protondrive ls /shared-with-me             # List what others shared with you
protondrive upload <local> <remoteDir>     # Upload a file
protondrive download <remote> <local>      # Download a file
protondrive mkdir <remoteDir> <name>       # Create a folder
protondrive trash <remotePath>             # Move an item to the Proton Drive trash

# Other
protondrive open-doc <file>                # Open a Proton Docs or Sheets file in your browser
protondrive version                        # The app and SDK versions (also --version)
protondrive help                           # This list
```

`--json` (or `-j`) gives machine-readable output where a command supports it, and `--verbose` (or `-v`) logs more.

**Paths for `pin`, `free`, `hide`, `unhide` and `status <path>`:**
- A path inside your sync folder (`~/ProtonDrive/Docs/report.pdf`) or a My files path (`/my-files/Docs/report.pdf`).
- A relative path resolves against the current directory when you are inside the sync folder, and against My files otherwise.
- To act on the whole drive (pin and free only), name it explicitly: `/my-files` or the sync folder itself. A relative path that would mean the whole drive, such as `.` at the top of the sync folder, is refused, and so is anything outside the sync folder.
- `status <path>` answers `Not in Proton Drive: <path>` for a path that is neither in Proton Drive nor in the sync folder.
- These commands go through the running daemon's user-only control socket, so `protondrive daemon` must be running.

