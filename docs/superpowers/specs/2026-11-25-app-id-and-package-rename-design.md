# Own app ID and package names (short design)

**Why:** before the repo goes public under the GitHub org `kosidhar`, the app stops using Proton's ID namespace
(`ch.proton.drive`) and Canonical's trademark in its package (`proton-drive-ubuntu`), while it keeps looking and
feeling like Proton Drive. The owner chose this scope (levels 2 and 3 of four) on 2026-11-25.

## Approaches

The rename was considered at four levels:
1. The visible name and look ("Proton Drive", the icon).
2. The app ID.
3. Commands and package names.
4. The data folders.

- **Levels 2 and 3, commands kept (chosen).** The IDs (including the keyring entry's) and the package become the
  owner's; the name, look and commands stay.
- **Levels 1–3 ("Kosidhar for Proton Drive" visibly):** rejected by the owner. The app should still look like Proton
  Drive.
- **All four levels:** moving the data folders means migrating live sync records and downloaded files, for no
  visible gain. Rejected.

## What changes

- **App ID `ch.proton.drive` → `io.github.kosidhar.ProtonDrive`,** everywhere it names the app:
  - the desktop file's name;
  - the window's app ID (Wayland `app_id` and X11 `WM_CLASS`);
  - the icon names in `assets/app-icon/hicolor/*/apps/`;
  - the AppStream metadata file and its `<id>`;
  - the notification icon (app, daemon, tray, file-manager extensions);
  - the autostart entry's `Icon=`;
  - the Flatpak manifest;
  - the tray's AppIndicator id.
- **The keyring entry** that holds the login becomes `io.github.kosidhar.ProtonDrive/drive-sdk-cli`. The owner signs
  in again after reinstalling.
- **Store metadata:** `<developer>` names **Kosidhar**. `<name>` stays "Proton Drive".
- **File-manager extensions:** the installed Nautilus extension becomes `kosidhar_protondrive_nautilus.py`. The Nemo
  and Dolphin files (`proton_drive_nemo.py`, `protondrive.desktop`) have no Proton ID in their names and keep them;
  only their icon lines change.
- **Package `protondrive` / `proton-drive-ubuntu` → `kosidhar-protondrive`:**
  - the .deb, .rpm and Arch packages, `package.json`'s name, and the packaging and build scripts;
  - the daemon's build output in `release/`.
- **systemd:** the unit the installer writes stays `protondrive.service`, which is protondrive-like. The
  `proton-drive-ubuntu.service` alias unit goes, and the app checks `protondrive.service`.
- **The `proton-drive-ubuntu` alias command is removed.** CLI messages and usage text say `protondrive`.
- **The old Debian build:** `scripts/build-deb.sh` was superseded by `packaging/linux/package.sh` and nothing calls it.
  It goes, with the three files only it used (`linux/desktop/proton-drive.desktop`,
  `linux/systemd/proton-drive-ubuntu.service`, `linux/icons/proton-drive-ubuntu.svg`).
- **"Start at login"** writes `~/.config/autostart/kosidhar-protondrive.desktop` instead of `proton-drive.desktop`.

## What doesn't change

- The name "Proton Drive" everywhere it's shown, the icon images, and the whole look.
- The commands `protondrive`, `protondrive-gui` and `protondrive-vfs`.
- The data folders `~/.config/protondrive` and `~/.local/share/proton-drive-ubuntu` (sync records and downloaded
  files), the control socket, and port 49152.
- What the app sends Proton's servers to identify itself (`external-drive-ubuntu_sync@…`, client UID prefix
  `ubuntu-sync`): changing it risks Proton's servers refusing the app.
- A Flatpak build's data folder is per app ID (`~/.var/app/<id>/`), so it moves with the new ID. No Flatpak build
  is installed anywhere, so nothing migrates.

## No upgrade path (owner's call, 2026-11-25)

The app is installed only on the owner's laptop, so nothing migrates old names. The owner uninstalls the old version
with its own installer, which removes every old-named file, then installs the new one and signs in again. The data
folders stay, so the sync records and downloaded files carry on. No code keeps old names alive to clean up later.

## Checks

- Updated tests wherever names are asserted.
- A repo scan test: old IDs and package names appear nowhere except the data folder name, and the API identity is
  unchanged.
- The full check list from CLAUDE.md.
- After reinstalling, on the owner's desktop:
  - the window's app ID;
  - the desktop entry and icon in the app grid, and no old ones;
  - the tray and notification icons;
  - the Files menu;
  - the new start-at-login entry;
  - signed in again, and syncing with the same records.

## Not in scope

The one-time "unofficial app" notice, the README line, the LICENSE file and moving the repo into the kosidhar org.
Each comes after this.
