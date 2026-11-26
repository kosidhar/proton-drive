# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome. This is a small project, so the rules below
keep it safe for the people whose files it syncs.

The full rules are in [the project rules](CLAUDE.md). They apply to everyone, people and AI tools alike (`AGENTS.md`
and `GEMINI.md` point there too). This page is the short version.

## Before you start

- **Every change starts with an issue.** Open one, or comment on an existing one, so we agree on what to build before
  you build it. Anything you find along the way that's out of scope gets its own issue.
- **Data safety comes first:**
  - never trash or overwrite a file in Proton Drive unless the user deleted or changed it;
  - write the sync record before the file, never leaving a record without its file, or a file whose record says it's
    synced when it isn't;
  - a missing local file is never proof of a delete when the folder holding it may be gone;
  - when unsure, keep both copies.

## Building from source

You need:
- [Bun](https://bun.sh) 1.4.2 or newer;
- Rust (releases are built with 1.99.1);
- Python 3, for the extension tests;
- `fuse3`, for the virtual drive.

Building the release packages also needs Docker.

```bash
bun install
bun run build                                   # writes release/protondrive
(cd native-gui && cargo build --release)
(cd native-vfs && cargo build --release)
install -m755 native-gui/target/release/protondrive-gui native-vfs/target/release/protondrive-vfs release/
./packaging/linux/install.sh --user             # into ~/.local; --uninstall removes it
```

The release packages (`.deb`, `.rpm`, AppImage, tarball) come from `packaging/linux/package.sh`, which builds in an
Ubuntu 22.04 container so they run on older systems too. [RELEASING.md](RELEASING.md) covers making a release.

## Checks

Run all of these before you push. CI runs them on every pull request, and a PR can't merge while any fails.

```bash
bun test tests
bunx tsc --noEmit
python3 linux/nautilus/test_proton_drive_nautilus.py
python3 linux/tray/test_proton_drive_tray.py
(cd native-gui && cargo test && cargo clippy --all-targets -- -D warnings)
(cd native-vfs && cargo test && cargo clippy --all-targets -- -D warnings)
```

Run the tests as a normal user: a few check read-only folders, and root ignores file permissions. The drive helper's
real-mount tests run with `PROTONDRIVE_VFS_MOUNT_TESTS=1 cargo test --test mount` in `native-vfs` and need
`/dev/fuse` and `fusermount3`.

## Making a change

1. **Branch:** create one from `main` named after the issue, such as `fix/123-short-name`.
2. **Test first:** write a test that fails without your change, watch it fail, then make it pass.
3. **Commits:** use [Conventional Commits](https://www.conventionalcommits.org/) (`fix(sync): …`, `feat(gui): …`).
   The commit that finishes the issue says `Fixes #N`.
4. **Changelog:** for anything a user would notice, add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
5. **Pull request:** open it against `main`. Say what changed, how you tested it, and what's left (as new issues).
   Review your own diff first as if someone else wrote it, looking hardest at data safety.

**AI tools are fine to use,** but you're responsible for every line. Commits and pull requests carry no AI
attribution: no `Co-Authored-By` trailer for an AI tool, and no "Generated with" lines.

Never commit build output (`release/`, `target/`, `target-portable/`, `dist/`), `node_modules`, `__pycache__/`, local
state, or your own paths and username. A test checks for those.

## License

Contributions are under the project's [MIT License](LICENSE).

## Security problems

Don't open a public issue. See [SECURITY.md](SECURITY.md).
