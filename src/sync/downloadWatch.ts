// Notices one app downloading many online-only files from the virtual drive: an IDE indexer, `rg`, a backup script,
// anything the built-in list of background readers doesn't know. The user is told, and can block it.

export const MASS_DOWNLOAD_COUNT = 20; // more than this many downloads by one app...
export const MASS_DOWNLOAD_WINDOW_MS = 60_000; // ...within this long
export const MASS_DOWNLOAD_QUIET_MS = 10 * 60_000; // and then not again for that app for this long
// Copying out of the drive in Files is the user's own action
export const MASS_DOWNLOAD_EXEMPT: readonly string[] = ['nautilus'];

export class DownloadWatch {
    private readonly recent = new Map<string, number[]>();
    private readonly notifiedAt = new Map<string, number>();

    constructor(private readonly clock: () => number = Date.now) {}

    // A download by `app` (its process name; undefined when unknown) has started. Answers how many it made in the last
    // minute when the user should be told now, or null.
    record(app: string | undefined): number | null {
        if (!app || MASS_DOWNLOAD_EXEMPT.includes(app)) {
            return null;
        }
        const now = this.clock();
        this.forgetBefore(now - MASS_DOWNLOAD_WINDOW_MS);
        const times = this.recent.get(app) ?? [];
        times.push(now);
        this.recent.set(app, times);
        if (times.length <= MASS_DOWNLOAD_COUNT) {
            return null;
        }
        const last = this.notifiedAt.get(app);
        if (last !== undefined && now - last < MASS_DOWNLOAD_QUIET_MS) {
            return null;
        }
        this.notifiedAt.set(app, now);
        return times.length;
    }

    // Keeps memory bounded by what happened in the last minute (and the last ten, for the quiet period)
    private forgetBefore(cutoff: number): void {
        for (const [app, times] of this.recent) {
            const kept = times.filter((t) => t > cutoff);
            if (kept.length === 0) {
                this.recent.delete(app);
            } else if (kept.length !== times.length) {
                this.recent.set(app, kept);
            }
        }
        for (const [app, at] of this.notifiedAt) {
            if (at <= cutoff + MASS_DOWNLOAD_WINDOW_MS - MASS_DOWNLOAD_QUIET_MS) {
                this.notifiedAt.delete(app);
            }
        }
    }
}
