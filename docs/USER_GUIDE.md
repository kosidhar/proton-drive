# Using Proton Drive for Linux

- [Your drive in Files](#your-drive-in-files)
- [Status icons](#status-icons)
- [The right-click menu](#the-right-click-menu)
- [Proton Docs and Sheets](#proton-docs-and-sheets)
- [Deleting files](#deleting-files)
- [Apps that download many files](#apps-that-download-many-files)
- [The app](#the-app)
- [The tray menu](#the-tray-menu)
- [The virtual drive and the plain folder](#the-virtual-drive-and-the-plain-folder)
- [Moving the sync folder](#moving-the-sync-folder)

## Your drive in Files

Proton Drive shows up in your file manager's sidebar as **Proton Drive**, at `~/ProtonDrive` unless you move it. It
lists everything in your Proton Drive's My files, including files that aren't on this computer, and a file downloads
the moment an app opens it.

**Nothing downloads in the background on GNOME.** GNOME's thumbnailers and desktop search never trigger a download, so
browsing a folder of online-only photos shows generic icons and costs no bandwidth. Other desktops' thumbnailers and
indexers, such as KDE's or Xfce's, aren't recognised yet ([#534](https://github.com/kosidhar/proton-drive/issues/534)): they count as ordinary apps, so they can download
files. If one does, block it (see [Apps that download many files](#apps-that-download-many-files)).

**Files you change sync both ways,** usually within seconds. When the same file changed on both sides, both versions
are kept, so nothing is overwritten.

**Symbolic links aren't synced.** Any symlink inside the sync folder is skipped and stays on this computer: it is never
uploaded, and downloads never follow it.

## Status icons

| Icon | Means |
| :--- | :--- |
| Solid green check | **Always keep on this device**: always here, even offline |
| Green ring | **Downloaded**: here now, and its space can be freed |
| Grey cloud | **Online only**: downloads when opened. On a folder: nothing inside it is here |
| Cloud with a small green check | A folder that's **partly here**: some of what's inside is on this computer |
| Sync arrows | Syncing |
| Warning | An error or a conflict: the app's Home says what to do |
| Lock | A Proton Docs or Sheets file, which is read-only |

The icons update by themselves within a couple of seconds. They appear in GNOME Files. Cinnamon's Nemo and KDE's
Dolphin have a smaller integration: see the [README](../README.md#works-best-with).

**After installing or upgrading,** restart Files once (`nautilus -q`) so it loads the new extension.

## The right-click menu

On one item or many, in GNOME Files:

- **Always keep on this device:** download it and keep it here.
- **Free up space:** remove the copies on this computer. They stay in Proton Drive and download again when opened.
- **Hide from this computer:** remove the item from Files altogether. Hidden items are listed in the app's
  **Settings**, under **Hidden from this computer**, where **Unhide** brings them back as online only. Hiding is
  refused, with the reason, for a folder holding something that exists only on this computer, such as a `.git`
  folder.

On one item:

- **Share…:** opens the app's Share window, with the item's link (with an optional password and expiry), inviting
  people as viewer or editor, and who has access.
- **Copy Link:** copies the item's link, making one if it has none. An existing link is never changed.

The icons and the right-click actions also work when Proton Drive is a plain folder, for what is on this computer.

## Proton Docs and Sheets

Each one shows in the drive as a read-only `<name>.protondoc` or `<name>.protonsheet` file, with Proton's Docs or
Sheets icon. A double-click opens it at docs.proton.me in your browser.

- **Read-only:** they can't be renamed, moved, edited or deleted from Linux, and they're never uploaded.
- **Deleting a folder that holds one:** a permanent delete (`rm -r`, Shift+Delete) is refused. **Move to Trash**
  moves the folder, documents included, to the Proton Drive trash.
- **Where they appear:** only in the virtual drive, so not in a plain folder or the Flatpak build.

## Deleting files

- **In the virtual drive,** deleting an item moves it to the **Proton Drive trash**.
- **With Files' Move to Trash,** anything that existed only on this computer, or had changes not yet uploaded, goes to
  your desktop Trash instead. `rm` removes those for good.
- **Removing a folder** that Proton Drive has (`rmdir`, `rm -r`, Shift+Delete) checks the folder in Proton Drive
  first, so it needs a connection. Offline, `rm -r` deletes the files but leaves the folders, and Files offers
  **Retry**.
- **In a plain folder,** Move to Trash also leaves a copy in your desktop Trash.

The **Trash** button on the app's Home and in Settings › Account, and **Open Proton Drive Trash** in the tray menu,
open the Proton Drive trash in your browser, where you can restore items.

## Apps that download many files

Any app that opens an online-only file downloads it, so copying files out of the drive works. When one app other than
Files downloads more than 20 files in a minute, for example a code indexer or `rg`, a notification says so, with a
**Block this app** button.

- **What blocking does:** a blocked app can't download online-only files any more. Files it already has on this
  computer still open.
- **Managing the list:** the app's **Settings** lists blocked apps, each with **Unblock**. It can also block an app by
  its process name, as `ps` shows it.

## The app

- **Home:**
  - whether everything is in sync, and what needs you: conflicts, missing files, a drive that isn't mounted, or being
    signed in to a different Proton account than your files were synced with;
  - what is uploading or downloading;
  - your storage, with **Open in Files** and **Free up space…** for the whole drive.
- **Shared:** everything you share, with its link, password, expiry and people, and quick actions for each.
- **Shared with me:** invitations to accept or decline, and the items others shared with you, which you can open,
  download or leave. They don't appear in the drive yet.
- **Activity:** what was synced, with a search.
- **Settings:**
  - your account;
  - the drive's location and the virtual-drive switch;
  - blocked apps, and what's hidden from this computer;
  - **Start Proton Drive when I log in**.

**Pausing:** **Pause** on Home stops syncing **for 1 hour**, **until tomorrow** or **until I resume**. `protondrive
pause` pauses until you resume.

## The tray menu

The tray menu shows the same status as Home and your Proton storage, plus a line that opens the app when something
needs you. It has:
- **Open Proton Drive:** opens the drive in Files.
- **View Online** and **Open Proton Drive Trash:** open Proton Drive in your browser.
- **Mount Proton Drive,** when the drive isn't mounted.
- **Status & Settings…:** opens the app.
- **Sync Now**, **Pause Sync** (for 1 hour, until tomorrow, or until you resume) and **Resume Sync.**
- **Quit Proton Drive.**

**Ejecting:** Eject in Files unmounts the drive. **Mount again** on Home, or **Mount Proton Drive** in the tray, brings
it back.

## The virtual drive and the plain folder

With the virtual drive (the default), downloaded files are kept in a hidden store,
`~/.local/share/proton-drive-ubuntu/files`, and `~/ProtonDrive` is a FUSE view of it. The `protondrive-vfs` helper,
installed next to `protondrive`, serves that view.

Proton Drive is set up as an ordinary folder, with every file downloaded, when:
- FUSE isn't available: no `/dev/fuse`, no `fusermount3`, or no helper;
- you're running the Flatpak build;
- **Show online-only files in Files (virtual drive)** is off in Settings;
- the sync folder is on a different disk from `~/.local/share`.

Settings shows which applies. If FUSE goes away later on a computer that already uses the virtual drive, Home says the
drive isn't mounted, rather than switching to a plain folder.

**Before uninstalling or going back to an older version, switch the virtual drive off.** [INSTALL.md](INSTALL.md#uninstalling-or-going-back-to-an-older-version)
explains why.

## Moving the sync folder

**Move…** in Settings moves the drive to another folder, which must be empty or new. If a move stops partway, for
example because the disk is full, Home lets you finish it, move it back, or retry.
