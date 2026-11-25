# Unofficial-app notice, README line and licenses (short design)

**Why:** before the repo goes public under the GitHub org `kosidhar`, people using the app and people reading the repo
should know it isn't Proton's. The app keeps looking like Proton Drive (the owner's choice in #413), so a one-time
notice says it plainly. The repo also needs a license, and the third-party parts need their notices. The owner asked
for these on 2026-11-25 and left the details to me ("I will let you decide").

## Approaches

- **A one-time dialog the first time the app opens (chosen; the owner's idea).**
- A permanent "unofficial" line in the app's chrome: rejected. The owner wants the app to feel like the original.
- A notice in the daemon or tray: rejected. The app is where people look, and the daemon already prints
  `THIRD_PARTY_DISCLOSURE` on the command line.

## The notice (issue: notice)

- **When it shows:** the first time `protondrive-gui` opens for a user, it shows a modal dialog over the app, in the
  existing confirm-dialog style (`render_confirm_modal`). Until it's answered, the app behind it can't be used.
- **Words:**
  - Title: **An unofficial app**.
  - Body: "This app isn't made, endorsed or supported by Proton AG. It's an independent open-source app that syncs your
    Proton Drive using Proton's open-source Drive SDK. Your files stay end-to-end encrypted."
  - Then a link line: "Source code: github.com/kosidhar/proton-drive". It opens `https://github.com/kosidhar/proton-drive`
    with the app's usual opener.
- **Buttons:**
  - **Quit:** secondary. It closes the app and saves nothing, so the notice shows again next time.
  - **I understand:** primary, with the keyboard focus. It records the answer and closes the dialog.
  Escape does nothing: the notice needs an answer.
- **Where the answer is kept:** the app's own UI preferences (`~/.config/protondrive/ui.json`), as
  `unofficialNoticeAccepted: true`. It sits on the existing `WindowGeometry` struct, `serde(default)`, false when
  missing, and is saved at once when accepted. A missing or unreadable `ui.json` means the notice shows. Nothing about
  it touches the daemon, and syncing runs regardless.
- **Screenshots:** never shown in `--screenshot` unless the new screenshot-only flag `--show-unofficial-notice` asks for
  it, so existing screenshots don't change.
- **Tests never write the real `ui.json`.** A test hook records saves instead.
- **Accessibility:** the title and body are readable labels, and the buttons are named "Quit" and "I understand".

## README and licenses (issue: license)

- **`LICENSE`:** the MIT License, "Copyright (c) 2026 Gautam Chauhan". `package.json`, nfpm and the PKGBUILD already say
  MIT. Copyright needs a person or a company; "Kosidhar" is a GitHub org name, not a legal entity.
- **`THIRD_PARTY_NOTICES.md`:** lists what the repo bundles and under what license:
  - the vendored Proton Drive SDK (`vendor/sdk`, MIT, © Proton AG). Its license text comes from Proton's public
    repository and is added as `vendor/sdk/LICENSE`;
  - Inter and JetBrains Mono (SIL OFL 1.1, texts already in `assets/fonts/`);
  - Phosphor icons (MIT, text already in `assets/fonts/MIT-Phosphor.txt`).
- **README:**
  - near the top, a short **Unofficial** note: not made, endorsed or supported by Proton AG; "Proton" and "Proton
    Drive" are trademarks of Proton AG;
  - a **License** section pointing to `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Not in scope

Moving the repo into the kosidhar org, GitHub Support for the old PRs, and making the repo public.
