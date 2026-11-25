# Own App ID and Package Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app stops using Proton's ID namespace and the `proton-drive-ubuntu` / `protondrive` package names, while
it still looks like Proton Drive and keeps the `protondrive` commands.

**Architecture:** A straight rename across packaging, the daemon (`src/`), the app (`native-gui/`), the tray and the
file-manager extensions (`linux/`). There is no upgrade path: the owner uninstalls the old version with its own
installer and installs the new one. A repo-wide test pins that old names survive only where they must: the data
folder and the API identity.

**Tech Stack:** Bun/TypeScript (`bun test`), Rust/egui (`cargo test`), Python (unittest), shell (install.sh,
package.sh), nfpm, Arch PKGBUILD, Flatpak manifest.

**Spec:** `docs/superpowers/specs/2026-11-25-app-id-and-package-rename-design.md` (issue #413)

## Global Constraints

- **New app ID:** `io.github.kosidhar.ProtonDrive`, replacing `ch.proton.drive` everywhere: desktop file, window app
  ID, icons, AppStream id and launchable, notification icon, Flatpak id, the autostart entry's `Icon=`. The tray's
  AppIndicator id becomes `io.github.kosidhar.ProtonDrive.tray`.
- **Keyring entry:** `CREDENTIALS_SERVICE = 'io.github.kosidhar.ProtonDrive/drive-sdk-cli'`.
- **New package name:** `kosidhar-protondrive`, with no replaces, provides or conflicts for old names (no upgrade path).
- **Installed Nautilus extension file:** `kosidhar_protondrive_nautilus.py`.
- **Start-at-login entry:** `~/.config/autostart/kosidhar-protondrive.desktop`. The marker stays
  `X-ProtonDrive-Autostart=true`.
- **AppStream:** `<developer id="io.github.kosidhar"><name>Kosidhar</name></developer>`. Homepage
  `https://github.com/kosidhar/proton-drive`. `<name>` stays `Proton Drive`.
- **Unchanged:**
  - the displayed name "Proton Drive", the icon images and the look;
  - the commands `protondrive`, `protondrive-gui` and `protondrive-vfs`;
  - the systemd unit `protondrive.service`;
  - `APP_DIR_NAME = 'proton-drive-ubuntu'` (the data folder) and `~/.config/protondrive`;
  - the socket and port 49152;
  - `DEFAULT_APP_VERSION` (`external-drive-ubuntu_sync@…`) and `DEFAULT_CLIENT_UID_PREFIX` (`ubuntu-sync`);
  - the Nemo and Dolphin file names `proton_drive_nemo.py` and `protondrive.desktop`.
- **No compatibility code for old names:** no legacy autostart handling, no old-name cleanup lists in the installer,
  and no detection of `proton-drive-ubuntu.service`.
- **Removed:**
  - the `proton-drive-ubuntu` alias command and the `proton-drive-ubuntu.service` alias unit;
  - `scripts/build-deb.sh`, with `linux/desktop/proton-drive.desktop`, `linux/systemd/proton-drive-ubuntu.service` and
    `linux/icons/proton-drive-ubuntu.svg`.
- **Repo rules (CLAUDE.md):**
  - branch `feat/413-own-app-id-and-package`, conventional commits, and the last one says `Fixes #413`;
  - no AI attribution;
  - never commit `.claude/`, `.superpowers/`, `target/`, `release/`, `dist/`;
  - run every check in CLAUDE.md before pushing.
- **Safety for implementers:** never run `install.sh`, `package.sh`, `bun run build` or the app outside
  `--screenshot`. Never touch `~/.local`, `~/.config/protondrive`, `~/.config/autostart`, the keyring, or the user's
  daemon or app.

## Review Focus

1. **A stray old ID or package name left in some corner** (an icon, a notification, a test, the README, a packaging
   script). A repo scan fails on any occurrence outside the allowed list (Task 2).
2. **An over-eager rename of what must not change:** the data folder would lose the sync records, and the API identity
   might be refused. The scan asserts their exact values (Task 2).
3. **The window not matching its desktop entry** (wrong dock icon, two dock entries). The app ID, the desktop file's
   base name and `StartupWMClass` must be the same string. A test checks the desktop file against `APP_ID` (Task 1).
4. **Start at login writing to the new name, with the new icon** (Task 1).
5. **Signing in storing under the new keyring entry, and reading from it** (Task 1).

---

### Task 1: The app ID and the keyring entry become `io.github.kosidhar.ProtonDrive`

**Files:**
- Rename (`git mv`):
  - `assets/app-icon/hicolor/*/apps/ch.proton.drive.{png,svg}` → `io.github.kosidhar.ProtonDrive.{png,svg}` (all 9);
  - `packaging/linux/ch.proton.drive.desktop` → `io.github.kosidhar.ProtonDrive.desktop`;
  - `packaging/linux/ch.proton.drive.metainfo.xml.in` → `io.github.kosidhar.ProtonDrive.metainfo.xml.in`;
  - `packaging/linux/flatpak/ch.proton.drive.bundle.yml` → `io.github.kosidhar.ProtonDrive.bundle.yml`.
- Modify:
  - `native-gui/src/main.rs`: `with_app_id`, the embedded icon path and the notification icon;
  - `src/linux/notifications.ts`: the default icon;
  - `src/linux/autostart.ts`: the entry name and `Icon=`;
  - `src/daemon/controlWiring.ts`: the "is your own entry" message names the path from `autostartEntryPath()`;
  - `src/sdk/credentials/constants.ts`;
  - `linux/tray/proton_drive_tray.py`: the notification icon and the AppIndicator id;
  - `linux/nautilus/proton_drive_nautilus.py` and `linux/dolphin/protondrive.desktop`: the icons;
  - `packaging/linux/install.sh` and `packaging/linux/package.sh`: the app ID, the Nautilus file name, and the
    uninstall paths for the new names and the new autostart entry;
  - `packaging/linux/flatpak-bundle.sh` and `README.md`.
- Test:
  - `tests/autostart.test.ts` and `tests/` for notifications and credentials;
  - `linux/tray/test_proton_drive_tray.py` and `linux/nautilus/test_proton_drive_nautilus.py`;
  - a `native-gui` unit test.

**Interfaces:**
- Produces: in `native-gui/src/main.rs`, `pub(crate) const APP_ID: &str = "io.github.kosidhar.ProtonDrive";`, used for
  `with_app_id` and for `--icon=`.

- [ ] **Step 1: Write the failing tests.**
  - **TypeScript, `tests/autostart.test.ts`** (update the existing assertions on the path and entry):
    - `autostartEntryPath({ XDG_CONFIG_HOME: '/c' })` is `'/c/autostart/kosidhar-protondrive.desktop'`;
    - `desktopEntry([...])` contains `'\nIcon=io.github.kosidhar.ProtonDrive\n'` (Review Focus 4).
  - **TypeScript, notifications:** they send `--icon=io.github.kosidhar.ProtonDrive` by default. Use the existing test
    file, or a new `tests/notifications.test.ts`.
  - **TypeScript, credentials:** `CREDENTIALS_SERVICE === 'io.github.kosidhar.ProtonDrive/drive-sdk-cli'`, and the
    keyring store reads and writes under that service. Use the existing credentials tests and their fakes
    (Review Focus 5).
  - **Rust, `the_app_id_is_kosidhars`:**
    - `APP_ID == "io.github.kosidhar.ProtonDrive"`;
    - the notification command the app builds carries `--icon=io.github.kosidhar.ProtonDrive`. Factor the args
      builder at ~3558 into a function if it isn't one already;
    - `include_str!("../../packaging/linux/io.github.kosidhar.ProtonDrive.desktop")` contains
      `StartupWMClass=io.github.kosidhar.ProtonDrive` and `Icon=io.github.kosidhar.ProtonDrive` (Review Focus 3).
  - **Python:**
    - tray: the notification command has `--icon=io.github.kosidhar.ProtonDrive`, and the indicator id is
      `io.github.kosidhar.ProtonDrive.tray`;
    - Nautilus: the notification icon, and the Dolphin assertion at ~787 now expects
      `Icon=io.github.kosidhar.ProtonDrive`.

- [ ] **Step 2: Run them and see them fail.**

  Run:
  - `bun test tests/autostart.test.ts` and the notifications and credentials tests;
  - `cd native-gui && cargo test --release the_app_id`;
  - both Python test files.

  Expected: FAIL on the old ID and entry name.

- [ ] **Step 3: Implement.**
  - Do the renames.
  - **Desktop file:** `Icon=io.github.kosidhar.ProtonDrive` and `StartupWMClass=io.github.kosidhar.ProtonDrive`.
    `Name` stays.
  - **Metainfo:**
    - `<id>` and `<launchable type="desktop-id">io.github.kosidhar.ProtonDrive.desktop</launchable>`;
    - the developer and homepage from Global Constraints;
    - `<name>` unchanged.
  - **Flatpak:** the manifest id, the paths, and `flatpak-bundle.sh`'s `APP_ID`.
  - **`autostart.ts`:**
    - `ENTRY_NAME = 'kosidhar-protondrive.desktop'` and the new `Icon=`;
    - drop `'proton-drive-ubuntu.service'` from `SYSTEMD_UNITS`, keeping `'protondrive.service'`.
  - **`package.sh`:** `APP_ID="io.github.kosidhar.ProtonDrive"`, and it installs Nautilus as
    `kosidhar_protondrive_nautilus.py`.
  - **`install.sh`:**
    - both branches install the new desktop file, metainfo, Nautilus name and icons, and the user-mode `sed` points
      `Icon=` at the new png;
    - uninstalling removes the new names, and the own autostart entry at its new name. Old names aren't listed.
  - **`README.md`:** the app-ID line names the new ID and `StartupWMClass`, and says "the app's icon" instead of
    "the official Proton Drive icon".

- [ ] **Step 4: Run every check.**
  - `bun test tests` and `bunx tsc --noEmit`;
  - both Python test files;
  - in `native-gui/`: `cargo test --release` and `cargo clippy --release --all-targets` with 0 warnings;
  - `bash -n packaging/linux/install.sh packaging/linux/package.sh packaging/linux/flatpak-bundle.sh`.

  Expected: all pass.

- [ ] **Step 5: Commit.** Check `git status` first: nothing under `.claude/`, `.superpowers/`, `target/` or `release/`
  may be staged.

```bash
git add -A assets/app-icon packaging/linux native-gui/src/main.rs src linux README.md tests
git commit -m "feat(packaging): the app ID and keyring entry are io.github.kosidhar.ProtonDrive

Refs #413"
```

### Task 2: The package becomes `kosidhar-protondrive`, and a scan pins what stays

**Files:**
- Modify:
  - `package.json` (`"name": "kosidhar-protondrive"`) and `bun.lock` (the root package's name);
  - `packaging/linux/nfpm.yaml`, `packaging/linux/arch/PKGBUILD`, `packaging/linux/package.sh` and
    `packaging/linux/postinst.sh`;
  - `scripts/build.ts`: the output becomes `release/protondrive`;
  - `packaging/linux/install.sh`: the release path, and no alias;
  - `src/cli/main.ts`: messages and usage say `protondrive`;
  - `src/linux/notifications.ts`: `getSystemdServiceStatus` defaults to `'protondrive.service'`;
  - `README.md`.
- Delete:
  - `scripts/build-deb.sh`, `linux/desktop/proton-drive.desktop`, `linux/systemd/proton-drive-ubuntu.service` and
    `linux/icons/proton-drive-ubuntu.svg`.
- Create:
  - `tests/branding.test.ts`.

- [ ] **Step 1: Write the failing test** `tests/branding.test.ts`

```ts
// Lists tracked files with `git ls-files`, skipping vendor/, docs/, bun.lock and binary assets, and reads each.
describe('names after #413', () => {
  test('ch.proton.drive and ch_proton appear nowhere', ...)                              // Review Focus 1
  // any occurrence outside this test file → fail, naming file and line
  test('proton-drive-ubuntu appears only as the data folder', ...)                       // Review Focus 1
  // allowed: src/sdk/config.ts (APP_DIR_NAME); native-gui/src/main.rs lines holding `.local/share/proton-drive-ubuntu`
  // or the data-dir candidate; packaging/linux/install.sh's data-dir helper (proton_app_dir); tests that use the
  // data folder; this file. Anything else → fail, naming file and line.
  test('what must not change is unchanged', ...)                                         // Review Focus 2
  // config.ts's APP_DIR_NAME is 'proton-drive-ubuntu';
  // DEFAULT_APP_VERSION starts with 'external-drive-ubuntu_sync@' (no env override set); DEFAULT_CLIENT_UID_PREFIX is 'ubuntu-sync'
  test('the packages are kosidhar-protondrive', ...)
  // package.json name; nfpm.yaml `name: kosidhar-protondrive`; PKGBUILD pkgname=kosidhar-protondrive; no
  // /usr/bin/proton-drive-ubuntu anywhere in packaging
})
```

- [ ] **Step 2: Run it and see it fail.** Run `bun test tests/branding.test.ts`. Expected: FAIL, listing the
  occurrences this task removes.

- [ ] **Step 3: Implement.**
  - **nfpm.yaml:**
    - `name: kosidhar-protondrive`, `vendor: Kosidhar`, and `homepage: https://github.com/kosidhar/proton-drive`;
    - no replaces, provides or conflicts with old names;
    - drop the `/usr/bin/proton-drive-ubuntu` symlink.
  - **PKGBUILD:**
    - `pkgname=kosidhar-protondrive`, and the url;
    - drop `provides` and `conflicts`;
    - the source tarball named as `package.sh` now names it.
  - **package.sh:**
    - the artifact names use `kosidhar-protondrive`;
    - no alias symlink and no `proton-drive-ubuntu.service` alias unit;
    - it reads `release/protondrive`.
  - **postinst.sh:** drop its cleanup of the old desktop file, since there's no upgrade path.
  - **install.sh:** reads `release/protondrive` and never creates the alias.
  - **CLI:** prefixes say `[protondrive]`, and usage says `protondrive …`.
  - **README:** the build and install instructions use the new package and artifact names.
  - **The four legacy files:** delete them.
  - **bun.lock:** edit the root name only. Then `bun install --frozen-lockfile` must succeed, offline from the cache.
    If it can't run offline, say so in the report rather than regenerating the lock.

- [ ] **Step 4: Run every check.**
  - `bun test tests` and `bunx tsc --noEmit`;
  - both Python test files;
  - in `native-gui/`: `cargo test --release` and clippy with 0 warnings;
  - `bash -n` on the changed shell scripts.

  Expected: all pass.

- [ ] **Step 5: Commit.** This commit adds the spec and this plan too.

```bash
git add -A package.json bun.lock packaging scripts src tests linux README.md \
  docs/superpowers/specs/2026-11-25-app-id-and-package-rename-design.md docs/superpowers/plans/2026-11-25-app-id-and-package-rename.md
git commit -m "feat(packaging): the package is kosidhar-protondrive; the proton-drive-ubuntu alias and old deb build go

Fixes #413"
```

### After the plan (controller, not an implementer)

1. Wait for the daemon to be idle, and back up the sync database.
2. Stop the app, tray and daemon.
3. Uninstall with the old version's own installer, taken from the commit before this branch, with `--user --uninstall`.
4. Build the new release binaries and install with `install.sh --user`.
5. Start the daemon and the app. The owner signs in again.
6. Check on the owner's desktop:
   - the new desktop entry and icon in the app grid, and no old ones;
   - the window's app ID;
   - the tray and notification icons, and the Files menu;
   - `~/.config/autostart/kosidhar-protondrive.desktop`, with start at login on;
   - syncing with the same records.
