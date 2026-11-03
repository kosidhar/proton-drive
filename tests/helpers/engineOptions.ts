// Engine options for tests that write a file and sync it straight away: a changed file uploads at the first look, rather
// than once it has stayed as it is for a while (see stillBeingWritten, #51). Tests of that wait set their own.
export const uploadAtOnce = { settle: { quietMs: 0 } };
