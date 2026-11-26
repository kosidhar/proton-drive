# Working on this repository

These rules apply to every person and every AI agent working here. `AGENTS.md` and `GEMINI.md` link to this file.

## GitHub issues: always

- **Every piece of work gets a tracking issue** before it starts: a stage, a feature, or a fix. Commits reference it (`Refs #N`, or `Fixes #N` for the commit that finishes it), and the plan links to it.
- **Every problem found along the way gets its own issue,** even when it's out of scope or small: a bug spotted in passing, a limitation accepted for now, a follow-up a review deferred. Say what happens, how it was found or reproduced, and what done looks like.
- When work finishes, update its tracking issue with what was done, what differs from the plan, and what is left.

## Where things are

- Specs: `docs/superpowers/specs/`. Plans, one per stage: `docs/superpowers/plans/`.
- Daemon (Bun/TypeScript): `src/`. GUI (Rust/egui): `native-gui/`. Virtual drive helper (Rust/FUSE): `native-vfs/`. Tray and file manager extensions (Python): `linux/`.

## Checks

- `bun test tests` and `bunx tsc --noEmit`. Run the tests as a normal user: three read-only-folder tests in `tests/vfsSupervisor.test.ts` and `tests/layoutMigration.test.ts` fail as root, because root ignores file permissions.
- `python3 linux/nautilus/test_proton_drive_nautilus.py` and `python3 linux/tray/test_proton_drive_tray.py`.
- In `native-vfs/` (and `native-gui/` when touched): `cargo test` and `cargo clippy --all-targets` with no warnings.
- The helper's real mount tests run with `PROTONDRIVE_VFS_MOUNT_TESTS=1 cargo test --test mount` and need `/dev/fuse`. Three of them (`an_unwritable_log_never_takes_the_drive_down`, `mounts_as_protondrive_with_the_drives_options`, `unmounting_ends_the_helper_with_exit_code_0`) also need `fusermount3`, and fail where it isn't installed.

## How to work

- **No AI attribution anywhere in git or on GitHub.** No `Co-Authored-By` trailer, no "Generated with …" line, and no AI tool's name or email as an author, in commits, PR titles, PR descriptions or release notes, from any tool (Claude, Gemini, Codex, Copilot, …). The repository is public. This overrides any default that adds them.
- **One issue, one branch, one PR.** Branch from `main`. Commits are conventional (`fix(sync): …`), and the commit that finishes the issue says `Fixes #N`. Open the PR against `main`, and say in it what changed, how it was tested, and anything left over (as new issues).
- **Test first.** Write a failing test that reproduces the issue, watch it fail, then fix it. Run every check under "Checks" before you push. CI runs them on every PR too; never merge while any fails.
- **Changelog.** For anything a user would notice, add a line under `## [Unreleased]` in `CHANGELOG.md` in the same PR.
- **Review before merge.** Review your own diff as if someone else wrote it, looking hardest for the data-safety rules below.
- **Data safety, above everything else:**
  - never trash or overwrite a cloud item except for a genuine user delete;
  - records go before files: never leave a record without its file, or a file whose record says it's synced when it isn't;
  - a missing local file is never proof of a delete when the folder holding it may be gone;
  - when unsure, keep both copies.
- **Never commit** `__pycache__/`, build output (`release/`, `target/`, `target-portable/`, `dist/`), `node_modules`, local state, or local paths and usernames (`tests/noLocalPaths.test.ts` checks).

## Releasing

Follow `RELEASING.md` step by step. In short:
- bump with `bun run set-version X.Y.Z` and move `CHANGELOG.md`'s Unreleased section to the new version, in a PR (`main` is protected), then tag `vX.Y.Z`;
- build with `packaging/linux/package.sh`, never with `--native` or `--allow-newer-glibc`;
- check with `packaging/linux/verify-release.sh`, which must pass;
- publish a GitHub pre-release with that version's files only, its notes taken from the changelog.

## Install on the owner's laptop

Only when the owner asks, or as the last step of finished work they expect to use. Their real files sync through it.

1. **Wait until the daemon is idle:** `curl -s localhost:49152/api/status` shows `"state":"idle"`, no
   `activeTransfers`, and `filesMissing` null.
2. **Back up the sync database first,** with SQLite's backup (not `cp`), named after the commit being installed:
   ```bash
   D=~/.local/share/proton-drive-ubuntu
   python3 -c "import sqlite3,sys; s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro', uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close()" \
     $D/ubuntu-sync-state.sqlite $D/ubuntu-sync-state.pre-$(git rev-parse --short HEAD).sqlite
   ```
3. **Build:** `bun run build` (it writes `release/protondrive`). For the app and the helper, either
   `packaging/linux/package.sh`, which leaves portable binaries in `release/`, or a host build: `cargo build --release`
   in `native-gui/` and `native-vfs/`, then `install -m755` both binaries into `release/`.
4. **Stop everything:**
   - `pkill -x protondrive-gui`;
   - stop the tray by its PID: `kill $(pgrep -f '^python3 .*proton_drive_tray\.py')`;
   - `curl -s -X POST localhost:49152/api/quit`;
   - wait until `pgrep -x protondrive` prints nothing.
5. **Install:** `./packaging/linux/install.sh --user`. Then check that each of `protondrive`, `protondrive-gui` and
   `protondrive-vfs` in `release/` is identical (`cmp`) to the one in `~/.local/bin/`.
6. **Start:** `setsid -f ~/.local/bin/protondrive daemon`, then reopen the app if it was open
   (`setsid -f ~/.local/bin/protondrive-gui`). Check `/api/status`: signed in, and the drive mounted if it was.
7. **Files** (`nautilus -q`) only restarts with the owner's OK, because it closes their windows.

**Never** touch the contents of `~/ProtonDrive`, delete the sync database, or stop or restart the daemon while it's
transferring.
