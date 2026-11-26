# Changelog

What changed in each release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/). While the version is `0.x`, every release is a
pre-release.

## [Unreleased]

### Added

- A release checklist (`RELEASING.md`) and a check that installs each release's `.deb` in clean Ubuntu 22.04 and
  Debian 12 before it's published (#510).
- Every pull request now runs all the tests automatically (#518).
- This changelog, a security policy, a contributor guide, and issue templates (#519).

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

[Unreleased]: https://github.com/kosidhar/proton-drive/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kosidhar/proton-drive/releases/tag/v0.1.1
[0.1.0]: https://github.com/kosidhar/proton-drive/releases/tag/v0.1.0
