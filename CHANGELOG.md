# Changelog

What changed in each release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/). While the version is `0.x`, every release is a
pre-release.

## [Unreleased]

### Fixed

- The `.rpm` installs on Fedora again: it no longer claims shared folders such as `/usr/share/icons/hicolor`, which
  conflicted with `hicolor-icon-theme` and many other packages. The release check now installs the `.rpm` on Fedora
  too (#548).

## [0.1.2] - 2026-11-26

### Security

- Names from Proton Drive are now checked before they become paths on this computer. Names are encrypted, so Proton's
  servers can't check them: someone with edit rights on a folder you share could give an item a name with `..` or `/`
  that made a sync write outside the sync folder. Such items are now skipped, without deleting or trashing anything,
  and no path the app uses can lead outside the sync folder (#536). Reported on Reddit: thank you.
- Without a keyring, the app now says that your session is saved in a file: in the log, in `protondrive auth status`
  and in Settings › Account. `PROTONDRIVE_NO_FILE_SESSION=1` makes it refuse the file and leave you signed out instead
  (#537).

### Fixed

- A file renamed in Proton Drive to a name longer than 255 bytes no longer has its copy on this computer deleted
  (#536).

### Added

- A release checklist (`RELEASING.md`) and a check that installs each release's `.deb` in clean Ubuntu 22.04 and
  Debian 12 before it's published (#510).
- Every pull request now runs all the tests automatically (#518).
- This changelog, a security policy, a contributor guide, and issue templates (#519).
- A README for people installing the app, with screenshots, and an install guide, a user guide and a command-line
  reference in `docs/` (#521).

## [0.1.1] - 2026-11-26

### Fixed

- The app and the online-only drive helper now run on Ubuntu 22.04, Debian 12 and anything newer. v0.1.0's needed
  glibc 2.43, so they wouldn't start on Ubuntu 22.04 / 24.04, Debian 12 / 13 or Mint 22 (#505).
- The `.deb` and `.rpm` now recommend what the Files integration and the tray icon need, so `apt` and `dnf` install
  them with the app (#506).

## [0.1.0] - 2026-11-25

The first public pre-release.

### Added

- Two-way sync between Proton Drive's My files and a local folder (`~/ProtonDrive`), with conflicts kept as copies.
- A virtual drive: everything in your Proton Drive is listed in Files, and online-only files download when an app
  opens them. **Always keep on this device**, **Free up space** and **Hide from this computer** are in Files'
  right-click menu, and status icons show what's where.
- Proton Docs and Sheets appear in the drive as read-only files that open in your browser.
- Sharing: share links and invitations from Files, a **Shared** page for what you share, and a **Shared with me**
  page to accept invitations and to open, download or leave shared items.
- An app and a tray menu with status, storage, activity and settings, and Proton Drive's trash on the web.
- Packages: `.deb`, `.rpm`, AppImage and a tarball.

[Unreleased]: https://github.com/kosidhar/proton-drive/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/kosidhar/proton-drive/releases/tag/v0.1.2
[0.1.1]: https://github.com/kosidhar/proton-drive/releases/tag/v0.1.1
[0.1.0]: https://github.com/kosidhar/proton-drive/releases/tag/v0.1.0
