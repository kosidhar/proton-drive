# Open in Files on Home, Settings in the sidebar, and an empty Shared page that isn't a wall of text

Issues: #308, #309, #310. Asked for by the user on 2026-11-16 with two screenshots; the design below was approved
("looks good").

## Why

- **Home (#308):** the "Your drive" card shows `~/ProtonDrive` with one button beside it, **Trash**. Trash opens the
  Proton Drive trash on the web, but alone beside the drive's name it reads as "trash the drive".
- **Settings (#309):** since #276 Settings is only behind the top bar's gear. The user wants it in the sidebar with the
  other sections.
- **Shared (#310):** with nothing shared, the page is two lines of grey text at the top left. #276's spec asked for the
  empty states to be given icons; this one wasn't. The user finds it too much text and asked for a share-related
  picture.

## Goals and non-goals

- **Goals:**
  - The drive row's buttons read as actions on the drive, starting with opening it.
  - Settings is a sidebar section; one control opens it.
  - The empty Shared page is a short, centred empty state with a picture.
- **Non-goals:**
  - Changing what Trash, Open in Files, or any Settings control does.
  - Changing the Shared list, its loading and error states, or Refresh.
  - Changing the Photos note under a non-empty list.

## Approaches (decided)

1. **Home:** add **Open in Files** to the left of Trash on the drive row (the user's suggestion). Rejected: renaming or
   moving Trash, which the user didn't ask for.
2. **Settings:** a fourth sidebar section under Activity, and the gear leaves the top bar. My call, and the user
   accepted it: two controls opening one page is what the user flagged earlier with the account name (#274).
   Rejected: keeping the gear as well.
3. **The empty Shared page:** a picture painted by the app from the theme's colours and Phosphor icons. It is crisp at
   any zoom and follows light and dark mode, with no image files. Rejected: an original illustration as an image file,
   which is richer but needs drawing plus light and dark versions.

## How it works

### Home (#308)
- **The drive row:** on its right, **Open in Files** (the `FOLDER_OPEN` icon, a Secondary button like Trash), then
  **Trash**.
- **What Open in Files does:** the same as the sidebar's button: it opens the drive's folder in the file manager.
  Screenshot mode opens nothing.
- **When the buttons show:** both appear only once a folder is set up, as Trash does today.
- **Trash itself:** unchanged: its icon, wording, hover text and screen-reader name stay.
- **In a narrow card** (a small window, a large zoom): when the buttons don't fit beside the drive's name, they go on
  their own row under it, as the status card's buttons do (`STACKED_BELOW`).

### Settings in the sidebar (#309)
- **The sidebar:** Home, Shared, Activity, **Settings** (the `SETTINGS` gear icon). The Settings row is filled while
  Settings is open, like the other sections.
- **The top bar:** the gear goes. The top bar keeps the section's title on the left and the account (and its menu) on
  the right.
- **Other ways in:** `--tab settings`, and a second launch asking for Settings, still open it.

### The empty Shared page (#310)
- **When it shows:** only when the list is loaded and empty. The page's toolbar with Refresh stays above it.
- **Layout:** a centred group in the page:
  - **The picture:** a soft purple circle (`PROTON_PURPLE_SOFT`) with a large link icon in purple, and two small person
    icons on badges overlapping the circle's edge. Purely decorative: screen readers skip it.
  - **The heading:** "Nothing shared yet", bold.
  - **One line:** "Right-click a file or folder in Files and choose Share…", muted, wrapping and centred in a narrow page.
  - **The Photos note, smaller, at the foot:** "Shared from Photos?" followed by the link "See them on drive.proton.me",
    which opens the same page as today.
- **Fitting the page:** the group sits a little above the middle of the space under the toolbar. In a short window it
  starts at the top and the page scrolls; nothing is clipped.

## Constraints

- **Tests:** test first. In `native-gui`, run `cargo test --release` and `cargo clippy --release --all-targets` with no
  warnings. Screenshots go through the stand-in daemon (`shoot.sh`), light and dark, at 1000×700 and at 840×540 with
  120% zoom.
- **Text contrast:** muted text keeps at least 4.5:1, as tested today.
- **Process:** one issue, one branch, one PR each. Only the app changes, so deploying means installing the app alone.

## Left to the builder

- The picture's exact sizes and offsets, within the description above.
- How the group is centred vertically (for example, measured from the previous frame).
