# Command line

`protondrive` runs the background service and does the everyday things from a terminal: status, sync, pause, keeping or freeing files, conflicts, and direct uploads and downloads. `protondrive --help` lists every command.

```bash
protondrive gui                            # Open native Rust Proton Drive desktop app
protondrive daemon                         # Run two-way sync daemon & local API server
protondrive status [--json]                # Show sync status & statistics
protondrive status <path>                  # Show whether an item is kept, downloaded, online only or hidden
protondrive pin <path>                     # Always keep a file or folder on this device
protondrive free <path>                    # Free up space: make downloaded files online only
protondrive hide <path>                    # Hide a file or folder from this computer
protondrive unhide <path>                  # Unhide it (it becomes online only)
protondrive sync                           # Trigger immediate two-way sync pass
protondrive pause / resume                 # Pause or resume background sync
protondrive auth login / logout / status   # Manage Proton account session
protondrive conflicts                      # List or resolve file conflicts
protondrive selective-sync list            # List top-level folders with their availability
protondrive selective-sync exclude <path>  # Same as hide
protondrive selective-sync include <path>  # Same as unhide
protondrive ls [/my-files]                 # Browse remote Proton Drive files
protondrive ls /shared-with-me             # Browse what others shared with you
protondrive upload <local> <remoteDir>     # Upload a file directly
protondrive download <remote> <local>      # Download a file directly
protondrive mkdir <remoteDir> <name>       # Create a remote folder
protondrive trash <remotePath>             # Move a remote node to Trash
```

**Paths for `pin`, `free`, `hide`, `unhide` and `status <path>`:**
- A path inside your sync folder (`~/ProtonDrive/Docs/report.pdf`) or a My files path (`/my-files/Docs/report.pdf`).
- A relative path resolves against the current directory when you are inside the sync folder, and against My files otherwise.
- To act on the whole drive (pin and free only), name it explicitly: `/my-files` or the sync folder itself. A relative path that would mean the whole drive, such as `.` at the top of the sync folder, is refused, and so is anything outside the sync folder.
- `status <path>` answers `Not in Proton Drive: <path>` for a path that is neither in Proton Drive nor in the sync folder.
- These commands go through the running daemon's user-only control socket, so `protondrive daemon` must be running.

