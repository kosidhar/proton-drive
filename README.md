# Proton Drive for Linux

A fast, native Linux desktop application and two-way background folder synchronization client for **Proton Drive**, built on top of the official **Proton Drive SDK (`@protontech/drive-sdk`)** and a native Rust **`eframe` / `egui`** desktop GUI.

**Unofficial:** this app is not made, endorsed or supported by Proton AG. "Proton" and "Proton Drive" are trademarks of Proton AG.

---

## Supported Linux Distributions & Package Formats

Built to work out-of-the-box across all major Linux distributions and desktop environments (GNOME, KDE Plasma, XFCE, Cinnamon, MATE, COSMIC, Sway, Hyprland):

| Format | Output Artifact (`dist/release/`) | Target Distributions |
| :--- | :--- | :--- |
| **AppImage** | `kosidhar-protondrive-<version>-linux-x86_64.AppImage` | **Universal** — runs on any Linux distro (Ubuntu, Fedora, Arch, openSUSE, Mint, NixOS, SteamOS) without installation |
| **Debian / Ubuntu (`.deb`)** | `kosidhar-protondrive-<version>-linux-amd64.deb` | Debian, Ubuntu, Linux Mint, Pop!\_OS, Zorin OS, Elementary OS, Kali |
| **Fedora / RHEL / SUSE (`.rpm`)** | `kosidhar-protondrive-<version>-linux-x86_64.rpm` | Fedora, RHEL, CentOS Stream, Rocky Linux, AlmaLinux, openSUSE Tumbleweed / Leap |
| **Portable Tarball (`.tar.gz`)** | `kosidhar-protondrive-<version>-linux-x86_64.tar.gz` | Any Linux distro — includes FHS tree (`bin/`, `share/`, `lib/systemd/user/`) and universal `install.sh` (`--user` or `--system`) |
| **Arch Linux (`PKGBUILD`)** | `packaging/linux/arch/PKGBUILD` | Arch Linux, Manjaro, EndeavourOS, Garuda (`makepkg -si`) |
| **Flatpak Bundle (`.flatpak`)** | `packaging/linux/flatpak-bundle.sh` | Sandboxed Flatpak bundle for Flathub / Fedora Silverblue / immutable distros |

---

## Features

- **Native Rust Desktop App (`protondrive-gui`)**:
  - Built with `eframe`/`egui` in Rust using Proton's **Carbon Dark** design palette and embedded `Inter` + `JetBrains Mono` typography.
  - Proper Freedesktop reverse-DNS App ID (`io.github.kosidhar.ProtonDrive`), `StartupWMClass=io.github.kosidhar.ProtonDrive`, AppStream metainfo, and complete `hicolor` icon theme (`16x16` through `512x512` + `scalable` SVG) so docks and taskbars display the app's icon across X11 and Wayland.
  - **Home, Activity and Settings:** **Home** shows whether everything is in sync, what needs you (signed in to another Proton account than your files were synced with, conflicts, missing files, a drive that isn't mounted), what is uploading or downloading, and your drive with **Open in Files** and **Free up space…** for the whole drive. **Activity** lists what was synced, with a search. **Settings** holds your account, the virtual drive switch, blocked apps, what is hidden from this computer, and the sync preferences, with **Start Proton Drive when I log in**. Keeping files on this device and freeing up space are done from the right-click menu in Files.
  - **Self-Starting Companion Daemon**: Launching the GUI automatically spawns `protondrive daemon` in the background if it is not already running.
  - **Starts at login**: Proton Drive starts when you log in (the daemon, so syncing and the drive, and the tray icon), without opening the window. Turn it off in Settings with **Start Proton Drive when I log in**, or with your desktop's own startup-apps settings. It is an XDG autostart entry, `~/.config/autostart/kosidhar-protondrive.desktop`, which runs `protondrive daemon`; `install.sh --uninstall` removes it. If you enabled the systemd unit instead, that starts Proton Drive and no entry is written. Not available in the Flatpak build.
- **Event-Driven Two-Way Folder Synchronization (`~/ProtonDrive`)**:
  - Real-time remote changes via Proton Drive SDK event subscriptions (`subscribeToDriveEvents` & `subscribeToTreeEvents`) with persisted cursors.
  - Real-time local filesystem watching via Linux `inotify` (`fs.watch`) with debouncing and atomic writes.
- **Cross-Distro OS Keyring & Browser Authentication**:
  - Browser-based Proton sign-in (`auth.authViaWeb`).
  - Stores credentials in the Freedesktop Secret Service (`libsecret` / GNOME Keyring / KDE KWallet / KeePassXC) with automatic fallback to a mode-`0600` local XDG session store on minimal window managers or headless systems.
- **Multi-Desktop File Manager Integration**:
  - **GNOME Files (Nautilus)**: `linux/nautilus/proton_drive_nautilus.py`
  - **Cinnamon / Linux Mint (Nemo)**: `linux/nemo/proton_drive_nemo.py`
  - **KDE Plasma (Dolphin)**: `linux/dolphin/protondrive.desktop`

---

## Virtual Drive (Files On-Demand)

Proton Drive shows up in your file manager's sidebar as **Proton Drive**. It lists every file in your account, including online-only ones, and a file downloads the moment an app opens it.

- **How it works:** the daemon keeps downloaded files in a hidden store, `~/.local/share/proton-drive-ubuntu/files`, and mounts a FUSE view of it at your sync folder (default `~/ProtonDrive`). The `protondrive-vfs` helper, installed next to `protondrive`, serves that mount.
- **Nothing downloads in the background:** thumbnailers and desktop search never trigger a download, so browsing a folder of online-only photos shows generic icons and costs no bandwidth.
- **Apps that download many files:** any app that opens an online-only file downloads it, so copying files out of the drive works. When one app other than Files downloads more than 20 files in a minute, for example a code indexer or `rg`, a notification says so, with a **Block this app** button. A blocked app can't download online-only files any more; files it already has on this computer still open. The app's **Settings** lists blocked apps, each with **Unblock**, and can block an app by its process name (as `ps` shows it).
- **Icons in Files:** a solid green check means **Always keep on this device**, a green ring means **Downloaded** (the space can be freed), and a grey cloud means **Online only** (it downloads when opened). A folder shows a cloud when anything inside it is online-only. Files that are syncing show the sync icon, and errors and conflicts show a warning. The icons update by themselves within a couple of seconds.
- **Right-click in Files:** **Always keep on this device**, **Free up space** (removes the copies on this computer; they stay in Proton Drive) and **Hide from this computer** (removes the item from Files altogether), on one item or many. Hidden items are listed in the app's **Settings**, under **Hidden from this computer**, where **Unhide** brings them back as online-only. Hide is refused, with the reason, for a folder holding something that exists only on this computer, such as a `.git` folder. On one item, **Share…** opens the app's Share window: the item's link with a password and an expiry, inviting people as viewer or editor, and who has access. **Copy Link** copies the item's link, making one if it has none; an existing link is never changed.
- **After installing or upgrading,** restart Files once (`nautilus -q`) so it loads the new extension. The icons and the right-click actions also work when Proton Drive is a plain folder, for what is on this computer.
- **Proton Docs and Sheets:** each one shows in the drive as a read-only `<name>.protondoc` or `<name>.protonsheet` file with Proton's Docs or Sheets icon, and a double-click opens it at docs.proton.me in your browser. They can't be renamed, moved, edited or deleted from Linux, and they're never uploaded. A permanent delete (`rm -r`, Shift+Delete) of a folder that holds any is refused; **Move to Trash** moves the folder, documents included, to the Proton Drive trash. They appear only in the virtual drive, so not in a plain folder or the Flatpak build.
- **Deleted files:** deleting an item in the virtual drive moves it to the **Proton Drive trash**. With Files' **Move to Trash**, anything in it that existed only on this computer, or had changes not yet uploaded, goes to your desktop Trash instead; `rm` removes those for good. Removing a folder that Proton Drive has (`rmdir`, `rm -r`, Shift+Delete) checks the folder in Proton Drive first, so it needs a connection: offline, `rm -r` deletes the files but leaves the folders, and Files offers **Retry**. When Proton Drive is a plain folder, Move to Trash also leaves a copy in your desktop Trash. **Open Proton Drive Trash** (on the app's Home and in Settings › Account, or in the tray menu) opens the Proton Drive trash in your browser, where you can restore items.
- **The tray menu:** shows the same status as the app's Home and your Proton storage, plus a line that opens the app when something needs you. **Open Proton Drive** opens the drive in Files, **View Online** and **Open Proton Drive Trash** open Proton Drive in your browser, and **Status & Settings…** opens the app.
- **Eject and mount again:** Eject in Files unmounts the drive. **Mount again** on the app's Home, or **Mount Proton Drive** in the tray, brings it back.
- **Plain folder fallback:** Proton Drive stays an ordinary folder when FUSE isn't available (no `/dev/fuse`, no `fusermount3`, no helper, or the Flatpak build), when the switch **Show online-only files in Files (virtual drive)** in Settings is off, or when the sync folder is on a different disk from `~/.local/share` (Settings shows the reason).
- **Changing the sync folder** needs an empty or new folder. If a move stops partway (for example, a full disk), Home lets you finish it, move it back or retry.
- **Switch the virtual drive off in Settings before uninstalling or installing an older version.** While it is on, your files live in the hidden store: an uninstall leaves them there, and an older version, which knows nothing of the store, takes the empty folder for files you deleted and moves them to the Proton Drive trash. Switching it off moves them back into your sync folder first. Then quit Proton Drive (**Quit Proton Drive** in the tray menu, or close the app and run `curl -s -X POST http://127.0.0.1:49152/api/quit`) and check that `pgrep -a protondrive` prints nothing: an uninstall stops only the systemd service, and a daemon the app started keeps running.
- **Runtime dependency:** `fuse3` (the `.deb`, `.rpm` and Arch packages pull it in). Moving files to the desktop Trash uses `gio` (`libglib2.0-bin` / `glib2`).

---

## Building & Installing on Any Linux Distro

### Build All Linux Packages (`.AppImage`, `.deb`, `.rpm`, `.tar.gz`)

```bash
./packaging/linux/package.sh
```

This outputs all 4 universal release artifacts to `./dist/release/`:
- `dist/release/kosidhar-protondrive-<version>-linux-x86_64.AppImage`
- `dist/release/kosidhar-protondrive-<version>-linux-amd64.deb`
- `dist/release/kosidhar-protondrive-<version>-linux-x86_64.rpm`
- `dist/release/kosidhar-protondrive-<version>-linux-x86_64.tar.gz`

### Option A: Universal Per-User Install (Any Distro, No Root Needed)

```bash
./packaging/linux/install.sh --user
systemctl --user enable --now protondrive.service
```

Install `fuse3` from your distro first if you want the virtual drive.

### Option B: Debian / Ubuntu / Mint / Pop!\_OS (`.deb`)

```bash
sudo apt install ./dist/release/kosidhar-protondrive-<version>-linux-amd64.deb
systemctl --user enable --now protondrive.service
```

`apt` installs the recommended `python3-nautilus` and `gir1.2-ayatanaappindicator3-0.1`, so the Files status icons and right-click menu and the tray icon work right away. Restart Files once (`nautilus -q`) to load the extension. On GNOME without Ubuntu's extension, enable "AppIndicator and KStatusNotifierItem Support" for the tray icon.

### Option C: Fedora / RHEL / openSUSE (`.rpm`)

```bash
sudo dnf install ./dist/release/kosidhar-protondrive-<version>-linux-x86_64.rpm
systemctl --user enable --now protondrive.service
```

For status icons and the right-click menu in Files, install `nautilus-python`, then restart Files once (`nautilus -q`). For the tray icon, install `libayatana-appindicator-gtk3`; on GNOME, also enable the "AppIndicator and KStatusNotifierItem Support" extension.

### Option D: Universal AppImage (Zero Installation)

```bash
chmod +x ./dist/release/kosidhar-protondrive-<version>-linux-x86_64.AppImage
./dist/release/kosidhar-protondrive-<version>-linux-x86_64.AppImage
```

The first time it runs, the AppImage registers the Proton Docs and Sheets file types and an open handler under `~/.local/share`, so the `.protondoc` and `.protonsheet` placeholders open in your browser. If you move the AppImage file, it updates them the next time it runs. If you delete the AppImage, its handler entry is ignored. To remove them, delete `~/.local/share/applications/io.github.kosidhar.ProtonDrive.OpenDoc.desktop`, `~/.local/share/mime/packages/io.github.kosidhar.ProtonDrive.xml` and the two icons `~/.local/share/icons/hicolor/scalable/mimetypes/application-vnd.proton.{doc,sheet}.svg`, then run `update-mime-database ~/.local/share/mime`.

---

## CLI Reference

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

---

## Releasing

The version lives in `package.json`; everything else follows it.

1. Bump it in a PR: `bun run set-version X.Y.Z` (or `X.Y.Z-pre.N` for a pre-release). It updates `package.json`, both `Cargo.toml` files and their `Cargo.lock` entries, and the PKGBUILD's `pkgver` (resetting `pkgrel` to 1). A test fails if any of them disagree.
2. Merge the PR.
3. Tag the merge commit `vX.Y.Z` and push the tag.
4. Run `packaging/linux/package.sh` to build the packages. Their names carry the version.
5. Publish a GitHub release for the tag with the packages attached (mark `-pre.N` versions as pre-releases).

`protondrive --version` prints the app version first. The Proton API identity that follows it is separate and is not changed by `set-version`.

---

## License

MIT, see [`LICENSE`](LICENSE). Third-party parts are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
