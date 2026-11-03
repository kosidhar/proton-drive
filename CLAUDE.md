# Working on this repository

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
