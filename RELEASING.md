# Releasing

How to make a release of Kosidhar for Proton Drive. Follow every step, in order, whoever (or whatever agent) does it.
The repo's general rules in `CLAUDE.md` apply too.

## Before you start

- **Docker** is installed and running. The release binaries are built in an Ubuntu 22.04 container.
- **Tools:** `bun`, `cargo` and an authenticated `gh` are available.
- **Starting point:** you're on a clean, up-to-date `main` (`git status` is clean, `git pull` done).
- **Checks:** every check in `CLAUDE.md` passes on `main`.
- **Version number:** pick it with semantic versioning. While it's `0.x`, new features bump the middle number
  (`0.1.1` → `0.2.0`) and fixes the last (`0.1.1` → `0.1.2`).

## Steps

1. **Issue.** Open a tracking issue for the release (CLAUDE.md: every piece of work gets one).
2. **Bump the version and the changelog in a PR.** `main` is protected, so even this goes through a pull request.
   In `CHANGELOG.md`:
   - rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today's date);
   - add a new, empty `## [Unreleased]` above it;
   - at the bottom, add `[X.Y.Z]: https://github.com/kosidhar/proton-drive/releases/tag/vX.Y.Z` and point the
     `[Unreleased]` link at `compare/vX.Y.Z...HEAD`.

   Read the section through: it becomes the release notes, so every line should make sense to someone using the app.
   ```bash
   git checkout -b chore/release-X.Y.Z
   bun run set-version X.Y.Z          # package.json, both Cargo.toml + Cargo.lock, PKGBUILD
   # …edit CHANGELOG.md as above…
   bun test tests/version.test.ts tests/projectFiles.test.ts   # every place agrees; the changelog has X.Y.Z
   git commit -am "chore: release X.Y.Z"
   git push -u origin chore/release-X.Y.Z
   gh pr create --base main --title "chore: release X.Y.Z" --body "…"
   gh pr merge --merge --delete-branch
   ```
3. **Tag the merge commit,** with the tag matching `package.json` exactly.
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   ```
4. **Build the packages.**
   ```bash
   packaging/linux/package.sh
   ```
   It must say `The binaries need glibc 2.35 or newer`.
   - **Never** pass `--native` or `--allow-newer-glibc` for a release. That builds binaries that only run on very new
     systems (the v0.1.0 problem, #505).
   - The first run builds the container image, which takes several minutes; later runs take seconds.
5. **Check the packages as a user installs them.**
   ```bash
   packaging/linux/verify-release.sh
   ```
   - It installs the `.deb` with `apt` in clean Ubuntu 22.04 and Debian 12 containers, and the `.rpm` with `dnf` in
     Fedora next to the packages that own the shared icon and MIME folders (checking it owns only its own folders),
     and starts the daemon, the app and the drive helper.
   - It must end with `is ready to publish` and exit 0. If anything says FAIL, stop and fix it; don't publish.
6. **Checksums,** for this version's files only: `dist/release/` also keeps older builds.
   ```bash
   cd dist/release && sha256sum kosidhar-protondrive-X.Y.Z-* > SHA256SUMS
   ```
7. **Publish** as a GitHub pre-release while the version is `0.x`.
   ```bash
   gh release create vX.Y.Z --prerelease --title "vX.Y.Z (pre-release)" --notes-file notes.md \
     kosidhar-protondrive-X.Y.Z-linux-amd64.deb kosidhar-protondrive-X.Y.Z-linux-x86_64.rpm \
     kosidhar-protondrive-X.Y.Z-linux-x86_64.AppImage kosidhar-protondrive-X.Y.Z-linux-x86_64.tar.gz SHA256SUMS
   ```
   The release notes:
   - start with the notice: *Not made by or affiliated with Proton AG. Proton Drive is a trademark of Proton AG. This
     is early software that syncs your files: keep backups.*
   - say what changed: this version's section of `CHANGELOG.md`, with its Added / Changed / Fixed headings and issue
     numbers;
   - say how to install (`sudo apt install ./…deb`, `sudo dnf install ./…rpm`).
   - contain no local paths, usernames or personal details.
8. **Close the release issue** with the release link.
9. **Optional:** install the new build on the owner's laptop, following "Install on the owner's laptop" in
   `CLAUDE.md`.

## Never

- **Don't change the Proton API identity** `external-drive-ubuntu_sync@0.1.0-alpha` (`src/sdk/fileOps.ts`,
  `scripts/build.ts`). Proton sees it. `set-version` deliberately leaves it alone.
- **No AI attribution** in commits, PRs or release notes: no `Co-authored-by`, no "Generated with". The repo is
  public.
- **Never force-push `main`,** delete a published tag, or upload another version's files to a release.
- **Don't skip `verify-release.sh`.** A package can build and install fine and still not start.

## When something changes

- **A newer Rust:** the container's Rust version is pinned in `packaging/linux/build-env/Dockerfile`
  (`RUST_VERSION`). If the project starts needing a newer Rust, update it there, or release builds fail.
- **Raising the oldest supported system** (glibc 2.35, Ubuntu 22.04) is a deliberate decision. Change the image in the
  Dockerfile, `GLIBC_LIMIT` in `package.sh` and `verify-release.sh`, and say so in the release notes.
