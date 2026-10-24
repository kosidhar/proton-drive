# Proton Drive for Linux

A fast, native Linux desktop application and two-way background folder synchronization client for **Proton Drive**, built on top of the official **Proton Drive SDK (`@protontech/drive-sdk`)** and a native Rust **`eframe` / `egui`** desktop GUI (modeled on the cross-distro architecture of [`wordcraft`](https://github.com/storytold/wordcraft)).

---

## Supported Linux Distributions & Package Formats

Built to work out-of-the-box across all major Linux distributions and desktop environments (GNOME, KDE Plasma, XFCE, Cinnamon, MATE, COSMIC, Sway, Hyprland):

| Format | Output Artifact (`dist/release/`) | Target Distributions |
| :--- | :--- | :--- |
| **AppImage** | `protondrive-0.1.0-linux-x86_64.AppImage` | **Universal** — runs on any Linux distro (Ubuntu, Fedora, Arch, openSUSE, Mint, NixOS, SteamOS) without installation |
| **Debian / Ubuntu (`.deb`)** | `protondrive-0.1.0-linux-amd64.deb` | Debian, Ubuntu, Linux Mint, Pop!\_OS, Zorin OS, Elementary OS, Kali |
| **Fedora / RHEL / SUSE (`.rpm`)** | `protondrive-0.1.0-linux-x86_64.rpm` | Fedora, RHEL, CentOS Stream, Rocky Linux, AlmaLinux, openSUSE Tumbleweed / Leap |
| **Portable Tarball (`.tar.gz`)** | `protondrive-0.1.0-linux-x86_64.tar.gz` | Any Linux distro — includes FHS tree (`bin/`, `share/`, `lib/systemd/user/`) and universal `install.sh` (`--user` or `--system`) |
| **Arch Linux (`PKGBUILD`)** | `packaging/linux/arch/PKGBUILD` | Arch Linux, Manjaro, EndeavourOS, Garuda (`makepkg -si`) |
| **Flatpak Bundle (`.flatpak`)** | `packaging/linux/flatpak-bundle.sh` | Sandboxed Flatpak bundle for Flathub / Fedora Silverblue / immutable distros |

---

## Features

- **Native Rust Desktop App (`protondrive-gui`)**:
  - Built with `eframe`/`egui` in Rust using Proton's **Carbon Dark** design palette and embedded `Inter` + `JetBrains Mono` typography.
  - Proper Freedesktop reverse-DNS App ID (`ch.proton.drive`), `StartupWMClass=ch.proton.drive`, AppStream metainfo, and complete `hicolor` icon theme (`16x16` through `512x512` + `scalable` SVG) so docks and taskbars display the official Proton Drive icon across X11 and Wayland.
  - **Self-Starting Companion Daemon**: Launching the GUI automatically spawns `protondrive daemon` in the background if it is not already running.
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

## Building & Installing on Any Linux Distro

### Build All Linux Packages (`.AppImage`, `.deb`, `.rpm`, `.tar.gz`)

```bash
./packaging/linux/package.sh
```

This outputs all 4 universal release artifacts to `./dist/release/`:
- `dist/release/protondrive-0.1.0-linux-x86_64.AppImage`
- `dist/release/protondrive-0.1.0-linux-amd64.deb`
- `dist/release/protondrive-0.1.0-linux-x86_64.rpm`
- `dist/release/protondrive-0.1.0-linux-x86_64.tar.gz`

### Option A: Universal Per-User Install (Any Distro, No Root Needed)

```bash
./packaging/linux/install.sh --user
systemctl --user enable --now protondrive.service
```

### Option B: Debian / Ubuntu / Mint / Pop!\_OS (`.deb`)

```bash
sudo dpkg -i ./dist/release/protondrive-0.1.0-linux-amd64.deb
systemctl --user enable --now protondrive.service
```

### Option C: Fedora / RHEL / openSUSE (`.rpm`)

```bash
sudo dnf install ./dist/release/protondrive-0.1.0-linux-x86_64.rpm
systemctl --user enable --now protondrive.service
```

### Option D: Universal AppImage (Zero Installation)

```bash
chmod +x ./dist/release/protondrive-0.1.0-linux-x86_64.AppImage
./dist/release/protondrive-0.1.0-linux-x86_64.AppImage
```

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
