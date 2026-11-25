# Shared page: a loading picture and an easy-to-find Refresh (short design)

**Why:** the owner finds the Shared page's first load bare ("Loading what you've shared…" alone at the top left) and
the Refresh glyph at the top right hard to notice; it is also greyed out while a load runs, so it looks broken. They
want a visible loading state and a Refresh that's centred and easy to see. They chose the recommendation below.

## Approaches

- **One refresh at a time, where the eyes already are (chosen).** Turning arrows in the middle of the page while the
  first load runs; a centred Refresh on the empty page and a centred Retry on the error page; a labelled Refresh in the
  toolbar only when a list shows, which turns into turning arrows and "Refreshing…" while the list reloads.
- A big centred Refresh on every state: crowds the list and repeats the toolbar's button. Rejected.
- Placeholder rows while loading: they promise a list, then jump to the empty picture when nothing is shared. Rejected.

Refresh stays unusable while a load runs, as now: a click would only start the same read again. Making it restart a
stuck load was the alternative; the owner chose the recommendation.

## The page, state by state

1. **First load** (no list yet, no error): a group a little above the middle of the page, placed as the empty
   picture is: the empty picture's soft circle (same size and colour) with the sync arrows turning inside it, then
   "Loading what you've shared…" under it, centred. No Refresh anywhere.
2. **Nothing shared:** the picture, heading and how-to line as now, then a centred secondary **Refresh** button with
   the sync glyph, then the Photos line. No toolbar Refresh.
3. **Couldn't read the list:** the same placement: the message (red, wrapped, centred), then a centred primary
   **Retry**. No toolbar Refresh. The words don't change.
4. **A list:** the toolbar's right end shows a labelled secondary **Refresh** button with the sync glyph, in place of
   the bare glyph. "Link copied" stays at the left.
5. **Reloading a list:** the rows stay, greyed and without clicks, as now. In the toolbar, Refresh gives way to the
   sync arrows turning and "Refreshing…". The "Loading what you've shared…" line above the rows goes.

## How

- **Motion:** as Home's status arrows (#345): one turn in `TURN_SECONDS`, frames every `TURN_FRAME`, still with GNOME's
  Reduce animation and in screenshots. Reuse home.rs's turning helpers rather than copying them.
- **Screen readers:** the arrows are decoration; the words say what is happening. Only one control named Refresh shows
  at a time.
- **Screenshots:** `--fake-shared` gains `loading` and `refreshing`. Refreshing shows the list, greyed.

## Not in scope

Making the listing faster, cancelling or restarting a running load, refreshing on a timer.

## Left to the builder

Spacing and sizes beyond the above; one helper for the "a little above the middle" placement that the loading, empty and
error groups share.
