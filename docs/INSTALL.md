# Installing Proton Drive for Linux

## What you need

- A 64-bit Intel or AMD PC (x86_64). There's no ARM build yet.
- Ubuntu 22.04, Debian 12 or newer, or another distribution with glibc 2.35 or newer. `ldd --version` shows yours.
- A Proton account with Proton Drive.
- For online-only files (the virtual drive): FUSE 3. The `.deb`, `.rpm` and Arch packages install it.

Download the package for your system from the [releases page](https://github.com/kosidhar/proton-drive/releases).
Every release lists its files' SHA-256 checksums in `SHA256SUMS`: `sha256sum -c SHA256SUMS --ignore-missing` checks
yours.

## Debian, Ubuntu, Mint and Pop!_OS (`.deb`)

From the folder you downloaded it to:

```bash
sudo apt install ./kosidhar-protondrive-<version>-linux-amd64.deb
```

Use `apt` rather than `dpkg -i` or double-clicking: `apt` also installs FUSE and the recommended `python3-nautilus` and
`gir1.2-ayatanaappindicator3-0.1`, so the status icons and right-click menu in Files and the tray icon work straight
away.

- **Files:** restart it once (`nautilus -q`, or log out and back in) so it loads the extension.
- **The tray icon:** Ubuntu shows it out of the box. On other GNOME desktops, enable the "AppIndicator and
  KStatusNotifierItem Support" extension.
- **Cinnamon:** for Nemo's right-click menu, also install `nemo-python`.

To update, install the new version's `.deb` the same way.

## Fedora (`.rpm`)

```bash
sudo dnf install ./kosidhar-protondrive-<version>-linux-x86_64.rpm
```

`dnf` also installs the recommended `nautilus-python` and `libayatana-appindicator-gtk3`, unless you've turned off
weak dependencies. If you have, install those two yourself.

- **Files:** restart it once (`nautilus -q`) so it loads the extension.
- **The tray icon:** on GNOME, enable the "AppIndicator and KStatusNotifierItem Support" extension.

The `.rpm` is built and checked less often than the `.deb`. Please report anything that doesn't work.

## Arch Linux and Manjaro

Download the release's `.tar.gz`, and the PKGBUILD from the same release's tag:
`https://github.com/kosidhar/proton-drive/raw/v<version>/packaging/linux/arch/PKGBUILD`. The one on `main` may already
be for a newer version ([#535](https://github.com/kosidhar/proton-drive/issues/535)). Put both in one folder and run `makepkg -si` there. For the Files integration and the
tray icon, install `nautilus-python` and `libayatana-appindicator`.

## AppImage (any distribution, nothing to install)

```bash
chmod +x kosidhar-protondrive-<version>-linux-x86_64.AppImage
./kosidhar-protondrive-<version>-linux-x86_64.AppImage
```

The first time it runs, the AppImage registers the Proton Docs and Sheets file types and an open handler under
`~/.local/share`, so the `.protondoc` and `.protonsheet` files open in your browser. If you move the AppImage, it
updates them the next time it runs. To remove them:

```bash
rm ~/.local/share/applications/io.github.kosidhar.ProtonDrive.OpenDoc.desktop \
   ~/.local/share/mime/packages/io.github.kosidhar.ProtonDrive.xml \
   ~/.local/share/icons/hicolor/scalable/mimetypes/application-vnd.proton.{doc,sheet}.svg
update-mime-database ~/.local/share/mime
```

The AppImage doesn't include the Files extension, so there are no status icons or right-click menu in Files. For
online-only files it needs FUSE 3 (`fuse3`) installed on your system. Before deleting the AppImage, turn off **Start
Proton Drive when I log in** in Settings, or delete `~/.config/autostart/kosidhar-protondrive.desktop`.

## Tarball (any distribution, installed for your user)

```bash
tar xf kosidhar-protondrive-<version>-linux-x86_64.tar.gz
cd kosidhar-protondrive-<version>-linux-x86_64
./install.sh --user          # into ~/.local; no root needed
```

It installs the app, the service and the Files extension, but not their dependencies. From your distribution, install:
- FUSE 3 (`fuse3`), for online-only files;
- the Python bindings for Files (`python3-nautilus` or `nautilus-python`), for the status icons and right-click menu;
- an AppIndicator library (`gir1.2-ayatanaappindicator3-0.1` or `libayatana-appindicator-gtk3`), for the tray icon.

`./install.sh --system` installs into `/usr` instead (as root), and `--uninstall` removes either.

## The first run

1. Open **Proton Drive** from your app menu. It starts the background service.
2. Sign in. Proton's sign-in page opens in your browser, so the app never sees your password. Your session is kept in
   the system keyring, or, where there's no keyring, in a file in the app's data folder that only you can read.
3. Proton Drive appears in Files' sidebar and starts syncing.

From then on, Proton Drive starts when you log in, without opening its window. To change that, use **Start Proton
Drive when I log in** in Settings, or your desktop's startup apps. It's an ordinary autostart entry
(`~/.config/autostart/kosidhar-protondrive.desktop`).

If you'd rather have systemd run it, the packages also include a user service:
`systemctl --user enable --now protondrive.service`. Then no autostart entry is written. You only need one of the
two.

## Uninstalling, or going back to an older version

While the virtual drive is on, your downloaded files live in a hidden folder, not in `~/ProtonDrive` itself. An
uninstall leaves them there. An older version, which knows nothing of that folder, would take the empty
`~/ProtonDrive` for files you deleted, and move them to the Proton Drive trash. So:

1. **Switch the virtual drive off first:** in Settings, turn off **Show online-only files in Files (virtual drive)**.
   That moves your files back into your sync folder.
2. **If you're leaving for good, sign out:** use **Sign out** in Settings, so your session doesn't stay in the keyring.
3. **Quit Proton Drive:** **Quit Proton Drive** in the tray menu. Without a tray, run
   `curl -s -X POST http://127.0.0.1:49152/api/quit`. Check that `pgrep -a protondrive` prints nothing.
4. **Uninstall:** `sudo apt remove kosidhar-protondrive`, `sudo dnf remove kosidhar-protondrive`,
   `sudo pacman -R kosidhar-protondrive`, or `./install.sh --uninstall` for the tarball.

Your files in `~/ProtonDrive` and in Proton Drive are left alone. So is the app's own data: the sync database and
caches, in `~/.local/share/proton-drive-ubuntu`, and its logs, in `~/.local/state/proton-drive-ubuntu`. Delete those
folders yourself if you won't install it again.

## Building the packages yourself

[CONTRIBUTING.md](../CONTRIBUTING.md#building-from-source) covers building and installing from source. The release
packages come from:

```bash
./packaging/linux/package.sh
```

It writes the `.deb`, `.rpm`, AppImage and tarball to `dist/release/`.
- **Docker:** it needs Docker, because the app and the drive helper are built in an Ubuntu 22.04 container
  (`packaging/linux/build-portable.sh`). That's what lets the packages run on glibc 2.35 and newer.
- **The glibc floor:** the packages declare the newest glibc their binaries need, and the build stops if that is newer
  than 2.35.
- **Without Docker:** `--native` builds on your own system, and `--allow-newer-glibc` lifts the limit. Those packages
  only run on systems as new as yours.
- **Flatpak:** `packaging/linux/flatpak-bundle.sh` builds a Flatpak bundle. It isn't published, and in it Proton Drive
  is a plain folder, with no virtual drive.
