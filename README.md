# Proton Drive for Ubuntu (Unofficial Client)

> **Disclaimer:** _This is a third-party application not officially supported by Proton._
> It does not use Proton branding or trademarks and identifies itself honestly via `x-pm-appversion: external-drive-ubuntu_sync@0.1.0-alpha` in compliance with the [Proton Drive SDK Operational & Legal Guidelines](https://github.com/ProtonDriveApps/sdk).

A native Ubuntu/Linux two-way folder synchronization daemon, Desktop GUI, CLI, and GNOME Files (Nautilus) integration built directly on top of the official **Proton Drive SDK (`@protontech/drive-sdk`)** and **`proton-drive-sdk-account`**.

---

## Features

- **Official Proton Drive SDK Integration (`@protontech/drive-sdk`)**:
  - End-to-end OpenPGP encryption & verification via `@protontech/crypto` (`OpenPGPCryptoWithCryptoProxy`)
  - Encrypted local SQLite crypto and entity caches (`cache-crypto.sqlite`, `cache-entities.sqlite`)
  - SHA1 digest verification on uploads and downloads
- **Event-Driven Two-Way Folder Synchronization (`~/ProtonDrive`)**:
  - Real-time remote updates via Proton Drive SDK event subscriptions (`subscribeToDriveEvents` & `subscribeToTreeEvents`) with persisted event cursors
  - Real-time local filesystem watching on Linux via `inotify` (`fs.watch`) with debouncing and atomic temp-file writes
- **OS Keyring & Browser Authentication**:
  - Browser-based Proton sign-in (`auth.authViaWeb`) — never prompts for raw credentials in the app
  - Persists session tokens securely in the Ubuntu OS Keyring (`libsecret` / GNOME Keyring) or `pass`
- **Conflict Resolution & Selective Sync**:
  - Configurable strategies: `keep-both` (saves conflict copy with timestamp & hostname), `keep-local`, `keep-remote`, or `prompt` (manual resolution in the GUI/CLI)
  - Selective sync to exclude specific remote `/my-files` top-level folders plus customizable glob ignore patterns (`.git`, `node_modules`, `*.tmp`, etc.)
- **Ubuntu Desktop GUI & Linux Integration**:
  - Adwaita-inspired dark Desktop GUI (`proton-drive-ubuntu gui`) with live transfer progress, activity log, cloud file browser, conflict center, and selective sync configuration
  - **Ubuntu Nautilus (`python3-nautilus`) Extension** (`linux/nautilus/proton_drive_nautilus.py`) for sync status emblems and right-click context menu actions
  - **Systemd User Service** (`linux/systemd/proton-drive-ubuntu.service`) for automatic background startup on login
  - **Debian Package (`.deb`) Builder** (`bun run build:deb`)

---

## Quick Start

### 1. Install Dependencies & Run from Source

```bash
bun install
bun run start help
```

### 2. Sign In with Your Proton Account

```bash
bun run start auth login
```

This opens `account.proton.me` in your browser and stores the encrypted session in your Ubuntu Keyring (`libsecret`).

### 3. Start the Desktop GUI or Background Sync Daemon

```bash
# Launch the Desktop GUI (automatically starts the sync daemon on 127.0.0.1:49152)
bun run gui

# Or run the background daemon directly
bun run daemon
```

### 4. Build Standalone Binary & Ubuntu `.deb` Package

```bash
# Build standalone executable at ./release/proton-drive-ubuntu
bun run build

# Build installable Debian package at ./release/proton-drive-ubuntu_0.1.0_amd64.deb
bun run build:deb

# Install on Ubuntu
sudo dpkg -i ./release/proton-drive-ubuntu_0.1.0_amd64.deb
systemctl --user enable --now proton-drive-ubuntu.service
```

---

## CLI Reference

```bash
proton-drive-ubuntu daemon                         # Run two-way sync daemon & local API server
proton-drive-ubuntu gui                            # Open Ubuntu Desktop GUI window
proton-drive-ubuntu status [--json]                # Show sync status & statistics
proton-drive-ubuntu sync                           # Trigger immediate two-way sync pass
proton-drive-ubuntu pause / resume                 # Pause or resume background sync
proton-drive-ubuntu auth login / logout / status   # Manage Proton account session
proton-drive-ubuntu conflicts                      # List or resolve file conflicts
proton-drive-ubuntu selective-sync list            # Manage selective folder sync
proton-drive-ubuntu ls [/my-files]                 # Browse remote Proton Drive files
proton-drive-ubuntu upload <local> <remoteDir>     # Upload a file directly
proton-drive-ubuntu download <remote> <local>      # Download a file directly
proton-drive-ubuntu mkdir <remoteDir> <name>       # Create a remote folder
proton-drive-ubuntu trash <remotePath>             # Move a remote node to Trash
```

---

## License

MIT License. Access to Proton's hosted services remains subject to Proton's terms of service and operational policies.
