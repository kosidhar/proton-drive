# Third-party notices

This app bundles the following third-party parts. Each keeps its own license.

## Proton Drive SDK

- What it is: the SDK the app uses to talk to Proton Drive.
- Where: `vendor/sdk`
- License: MIT
- Copyright: Proton AG
- Source: https://github.com/ProtonDriveApps/sdk
- License text: `vendor/sdk/LICENSE`

## Inter font

- What it is: the app's interface typeface.
- Where: `assets/fonts/Inter-*.ttf`
- License: SIL Open Font License 1.1
- Copyright: (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)
- License text: `assets/fonts/OFL-Inter.txt`

## JetBrains Mono

- What it is: the app's monospace typeface.
- Where: `assets/fonts/JetBrainsMono-Regular.ttf`
- License: SIL Open Font License 1.1
- Copyright: (c) 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
- License text: `assets/fonts/OFL-JetBrainsMono.txt`

## Phosphor icons

- What it is: the app's icons, used through the `egui-phosphor` crate.
- Where: built into the GUI through the crate; the license text is in `assets/fonts/`
- License: MIT
- Copyright: (c) 2020 Phosphor Icons
- License text: `assets/fonts/MIT-Phosphor.txt`

## Proton Drive logo

The app icon (`assets/app-icon/hicolor/`), the tray icons (`assets/app-icon/tray/`), the sidebar mark (`assets/app-icon/protondrive-mark-128.png`) and the source drawings of the logo (`assets/app-icon/protondrive.svg`, `assets/app-icon/protondrive-mark.svg`) are based on the Proton Drive logo. The logo is Proton AG's artwork and trademark; it is not covered by this repository's MIT license, and is used only so the app looks like Proton Drive. To redistribute or modify this project without it, replace these icons with your own.

Dependencies installed by the package managers (npm/bun, cargo) carry their own licenses in their packages.
