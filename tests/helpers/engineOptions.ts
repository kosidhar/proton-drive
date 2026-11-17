// Engine options for tests that write a file and sync it straight away: a changed file uploads at the first look, rather
// than once it has stayed as it is for a while (see stillBeingWritten, #51). Tests of that wait set their own.
export const uploadAtOnce = { settle: { quietMs: 0 } };

// Engine options for tests that open online-only files through the drive (hydrate): the store's disk always has room,
// so a download is never refused for room (#301) whatever the disk running the tests has free. Tests of that refusal
// give their own disk.
export const roomyDisk = { diskFree: async () => Number.MAX_SAFE_INTEGER };
