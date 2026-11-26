# Proton's look for the app

Tracking issue: #276. Fixes along the way: #273 (the logo's dark tile), #274 (the account name opening Settings), #275
(Activity's unreadable selected filter). Asked for by the user on 2026-11-15, with screenshots of Proton Drive on the
web and of the Proton Mail desktop app. The user chose drive.proton.me's dark navy sidebar for light mode as well.

## Why

The app works, but it doesn't look like a Proton app, and it reads like a form. The user's notes:

- **A black box around the logo in light mode.** The sidebar draws the app icon, which has a dark tile behind the folder
  (#273).
- **The name at the bottom of the sidebar opens Settings,** just like the Settings item above it (#274).
- **The pages are text-heavy.** There are no icons for Sync, Trash, Open in Files and the rest. Settings explains
  everything in sentences.
- **It should match the official Proton theme,** like drive.proton.me and Proton Mail desktop.

## Goals

- **In light mode, look like Proton Drive on the web:**
  - a dark navy sidebar with white text;
  - a white content area with a top bar;
  - a purple primary button;
  - Proton's colours, measured from the user's screenshot (below).
- **In dark mode, stay all dark,** with the same layout. The current dark colours stay.
- **More icons, fewer words:**
  - each section in the sidebar gets a line icon;
  - so does every button, and every row of the Shared and Activity lists;
  - long explanations move into a tooltip behind an ⓘ.
- **The account sits where Proton puts it:** at the top right, opening a small account menu.
- **Every function the app has today stays,** reachable in no more clicks than now, except Settings: one click on the gear,
  as now on the sidebar item.

## Non-goals

- **New features:** no search, no file browser, no "Shared with me", no new daemon routes. No new themes either.
  Settings' existing Appearance picker stays (see Settings).
- **The tray, the Files extension and their icons:** unchanged.
- **Proton's own files:** no copies of Proton's icons or stylesheets. Proton's web code is GPL. The app already uses
  Inter, Proton's font, under its OFL licence.

## Anti-goals (a failure even if it works)

- **A function, or the only path to one, is lost.**
- **Text that's hard to read:** body text below 4.5:1 contrast on the navy sidebar or on white.
- **An icon-only button with no tooltip,** or with no accessible name. Each keeps today's label as its tooltip and
  accessible name.
- **Clipping:** anything clipped or overlapping at the 840×540 minimum window, or at 120% zoom.
- **Screenshot mode sends anything,** as always.

## Approaches

1. **Restyle the egui app in place (chosen).**
   - The colours are already functions per theme (`BG_SIDEBAR()`, `TEXT_PRIMARY()`, …). They get Proton's values and a
     few new tokens.
   - The layout changes happen in the existing render functions.
   - Icons come from an icon font.
   - This is the smallest change that reaches the look, and it keeps every test and screenshot flag working.
2. **A theming or component crate for egui:** none mirrors Proton's design. It would add a dependency, and the app's
   own widgets (`proton_button`, the cards) would still need restyling.
3. **Rebuild the UI as a web view,** to reuse Proton's web styles: a different stack, a rewrite of every page, and
   Proton's styles are GPL.

## How it looks

The emoji in this document stand for Phosphor glyphs.

```
┌──────────────────────┬───────────────────────────────────────────────────┐
│ ▰ Proton Drive       │ Home                         ⚙   Test User       [TU] │
│                      │                                  name@proton.me         │
│ [📂 Open in Files ]  ├───────────────────────────────────────────────────┤
│                      │                                                       │
│ ⌂  Home          ②  │  ✓  Up to date                  [⟳ Sync now] [⏸ Pause] │
│ 🔗 Shared            │     Last synced just now                              │
│ ⟲  Activity          │                                                       │
│                      │  📁 ~/ProtonDrive                          [🗑 Trash]  │
│                      │     Virtual drive · mounted                           │
│                      │     On this computer  71.8 MB      [Free up space…]  │
│ ━━━━━───────────     │                                                       │
│ 3.01 GB / 510 GB 0.1.0│                                                      │
└──────────────────────┴───────────────────────────────────────────────────┘
```

### Colours: light mode (Proton's "Proton" theme)

Measured from the user's drive.proton.me screenshot, rounded to Proton's published values where they differ by
antialiasing:

| Token | Value | Where |
|---|---|---|
| Sidebar background | `#211A42` | the sidebar |
| Sidebar selected item | `#2E2359` | the current section's row |
| Sidebar hover | `#28204D` | a row under the pointer (builder may tune) |
| Sidebar text | `#FFFFFF` | section names, "Proton Drive" |
| Sidebar weak text and icons | `#B1A1F5` | the storage line, the version, section icons |
| Storage bar | `#B1A1F5` on `#3E2F7F` | the sidebar's storage meter |
| Primary | `#6D4AFF`, hover `#6243E6`, white text | primary buttons, selected chips, links |
| Content background | `#FFFFFF` | the section area and the top bar |
| Weak background | `#F5F4F2` | inputs, hovered rows, secondary-button hover |
| Weak border | `#EAE7E4` | separators, card borders, the top bar's bottom edge |
| Norm border | `#D1CFCD` | secondary buttons' outline |
| Text | `#0C0C14` | body text, titles |
| Weak text | `#5C5958` | hints, secondary lines, column headers |
| Folder icon | `#F5A428` | folders in the Shared list, as in Proton's lists |

The status colours (success, warning, danger) stay as they are.

### Colours: dark mode

The current dark palette stays (canvas `#1A1823`, sidebar `#14121B`, cards `#211D2C`). The sidebar uses the same layout,
and the new tokens get dark equivalents chosen by the builder from that palette, with the same contrast rule.

### Window structure

- **The sidebar,** 252 pt as now, navy in both themes' layouts (navy in light, `#14121B` in dark):
  - **The logo:** the folder mark alone, without the tile (#273), then "Proton Drive" in white. The mark is rendered
    once from `assets/app-icon/protondrive.svg`, without its tile, to a committed PNG at 2× size. There is no SVG
    renderer at run time.
  - **One primary button, full width: 📂 Open in Files.** It does exactly what Home's "Open in Files" does today, and is
    greyed out with a tooltip saying why whenever that one can't run. Home's own "Open in Files" goes, so the
    action isn't offered twice.
  - **Home, Shared, Activity,** each with its icon. Home keeps its red count of things that need the user.
    **Settings leaves the sidebar** and becomes the gear in the top bar.
  - **At the bottom:** the Proton storage meter as in Proton's apps, a thin bar over "3.01 GB / 510.00 GB" on the left
    and the version on the right. It replaces the name and initials, which move to the top bar.
- **The top bar** sits over the section area, white with a weak bottom border:
  - **On the left,** the section's title ("Home", "Shared", "Activity", "Settings"). The pages lose their own big
    titles, so a title is never shown twice.
  - **On the right, a gear** (tooltip "Settings"). It opens Settings and looks pressed while Settings is open.
  - **Then the account, as in Proton's top bar:** the name over the email (weak), and the initials in a small bordered
    square. Clicking any of it opens the **account menu** (#274), a popup under it, aligned right:
    - the initials, name, email and plan badge;
    - Proton storage ("3.0 GB of 510.0 GB");
    - **Open Proton Drive on the web**;
    - **Sign out**, which signs out at once, as Settings › Account's Sign out does today.

    Escape or a click outside closes the menu.
  - **Signed out or connecting:** the account area shows "Not signed in" or "Connecting…" with no menu, as the footer
    shows today.
- **Settings stays a page.** Its Account card stays too: it's where the account is managed in full. The menu is the
  quick path.

### Buttons and icons

- **Icons:** Phosphor icons through the `egui-phosphor` crate (0.9, built for egui 0.31; MIT or Apache-2.0, with the
  icons MIT). The "regular" weight, or "light" if it sits closer to Proton's strokes in the screenshots (the builder
  compares and picks one).
- **Button kinds:**
  - **Primary:** filled `#6D4AFF`, white text.
  - **Secondary:** white (light) or card (dark) fill, norm border, weak-background hover.
  - **Icon-only:** no fill until hovered.
  - **Danger:** confirm buttons stay red.

  All use radius 8. A button with a label gets its icon before the label.
- **Labels shorten where the icon carries the meaning:**
  - "Open Proton Drive Trash" becomes **🗑 Trash** (tooltip: "Open Proton Drive's trash on the web");
  - Refresh on the Shared page becomes an icon-only ⟳ (tooltip "Refresh").
- **Each icon-only button** has its old label as tooltip and accessible name.

### Home

- **The status card:** a large icon matching the state:
  - ✓ green: up to date;
  - ⟳ purple: syncing;
  - ⏸ amber: paused;
  - ⚠ red: a problem;
  - cloud-slash, grey: offline.

  Then the title and subtitle as today, and the buttons ⟳ Sync now and ⏸ Pause / ▶ Resume. Resume stays primary and
  Pause secondary (#254).
- **The drive card:** 📁 ~/ProtonDrive over "Virtual drive · mounted", the 🗑 Trash button, then "On this computer
  71.8 MB" with Free up space… as today. Open in Files goes (it's in the sidebar). The Proton storage line goes too:
  it's at the bottom of the sidebar.
- **What needs attention, the transfers and the moves:** these keep their behaviour and gain icons on their buttons.

### Shared

A Proton-style list instead of stacked text rows:

- **A small toolbar row** above the list: the ⟳ Refresh icon button on the right.
- **Column headers** in weak text: Name, Location, Sharing. Below them, one row per item, separated by weak borders,
  with no card around them:
  - **Name:** a folder icon (orange) or file icon, then the name.
  - **Location:**
    - the folder, "(top level)";
    - or "Hidden from this computer" / "Not on this computer", in weak text.
  - **Sharing:**
    - 🔗 for a link, with 🔒 when it has a password and ⏱ when it expires;
    - 👥 with the number of people;
    - the full sentence of today's second line as the tooltip;
    - an expired link shows 🔗 crossed out in red, with "Link expired".
  - **Actions,** icon-only on the right, in weak colour until the row is hovered:
    - 📋 Copy link, 👥 Manage…, 📂 Show in Files, ⛓ Stop sharing for `my-files` rows, by the same rules as now (R10,
      R12);
    - ↗ Manage on the web for the others.
  - **An unreadable row:** ⚠ and its reason in weak text, in place of the Sharing column.
- **Narrow windows:** Location truncates first, then the name, never the actions. At 840×540 every column is still shown.
- **Unchanged:**
  - the Photos note (#256);
  - the empty, loading and error states, given icons;
  - the confirmation, the reloads and all the rules of #253 and #260.

### Activity

- **The filter chips:**
  - the selected one is white text on the primary fill (#275);
  - the others are weak text on the weak background;
  - the search box gets a 🔍 icon and Proton's input style.
- **The table** keeps its columns. Its header goes to weak text with no tinted band. Rows are separated by weak borders,
  and the status pills keep their colours.

### Settings

- **Proton's settings layout:** each section stays a bordered card, with its heading at the top. Each setting is a
  row: the label (and a one-line hint at most) on the left, its control (switch, button, field) on the right.
- **When a change takes effect doesn't change** (builder check, my call):
  - **At once, as today:** the virtual-drive switch (it confirms when turning off), Block/Unblock, Unhide and the
    theme.
  - **On Save Preferences, as today:** the sync folder, the conflict choice, notifications, start at login and the
    ignore patterns. They stay together in their section, with Save Preferences at its foot and a hint under the
    heading saying these apply when saved.

  Switches that wait for Save are never mixed into a section whose controls act at once.
- **The Appearance theme picker stays** (builder check, my call). It's saved, and `--theme` uses it. Its choices read
  "Follow the system", "Light" and "Dark". They no longer say "Proton Snow" or "Proton Carbon": light is now the navy
  sidebar look.
- **Long explanations** move into an ⓘ tooltip next to the label. That covers "Files you haven't downloaded appear in
  Files…", the blocked-apps paragraph and the hidden-items paragraph.
- **The Account card** shows the plan badge, email, storage and Sign out as now. Its "Open Proton Drive on the web" and
  "Open Proton Drive Trash" buttons become icon buttons with labels (↗ Web, 🗑 Trash).

### Dialogs and the Share window

- The confirmation dialog and the Share window take the new tokens, buttons and icons, with no layout change.

## Constraints

- **Tests:**
  - **Every existing test keeps its meaning.** Tests that find a button by its painted text find icon-only buttons by
    their accessible name or tooltip instead. The harness gets a helper for that.
  - **New tests** cover:
    - the account menu: it opens, its items work, and Escape or a click outside closes it;
    - the gear opening Settings;
    - the sidebar's Open in Files sending the same command as before;
    - #275's chip contrast;
    - the 840×540 layout at 120% zoom.
- **Screenshot flags:**
  - all keep working;
  - a new `--account-menu` flag captures the menu;
  - every PR shows light and dark screenshots of each page it touches, at 1100×760 and at 840×540.
- **Checks:** `cargo test --release` and `cargo clippy --release --all-targets` with no warnings in `native-gui`. No
  daemon change is expected.

## Left to the builder

- **Within the tokens:** the exact sizes, spacing and paddings, and the sidebar hover colour.
- **Icons:** which Phosphor weight to use, and which glyph for each action, as long as one glyph means one thing
  everywhere.
- **The dark-mode values** of the new tokens, within the contrast rule.
- **Column widths** on the Shared page, and how a hovered row looks.

## Order of work

1. **Foundation** (fixes #273 and #274):
   - tokens, the icon font and the button kinds;
   - the tile-less logo;
   - the sidebar with Open in Files, the storage meter and the version;
   - the top bar with the gear and the account menu.
2. **The pages** (fixes #275, finishes #276): Home, Shared, Activity, Settings, the dialogs and the Share window.
