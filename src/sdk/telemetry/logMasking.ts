import { LogHandler, LogRecord } from '@protontech/drive-sdk/telemetry';

// No email address reaches the log file or Sentry's breadcrumbs, whichever logger writes it (#216). The SDKs log them:
// the drive SDK's sharing logger at INFO ("Inviting user …", sharingManagement.ts), and the account SDK at ERROR when an
// address's keys can't be loaded (addresses.ts), with an error whose message holds the request's URL, where the address
// is URL-encoded (%40). Anything shaped like an address becomes <email>.
//
// The name before the @ stops at whitespace and at what bounds an address in a log line (quotes, brackets, slashes,
// commas, colons…), so a path keeps its folders. The domain is made of what a host name is made of, and must end in
// letters, so a version such as name@0.1.0-alpha is kept. An address starts only where a run of such characters starts:
// tried from every character of a long run instead, each try would scan the rest of it, and a line with a long token
// would take seconds.
const CHAR = String.raw`[^\s@/\\"'<>()[\]{},;:]`;
const DOMAIN = String.raw`[\p{L}\p{M}\p{N}._-]+`;
const TOP_LEVEL_DOMAIN = String.raw`(?:\p{L}{2,}|xn--[\p{L}\p{N}-]+)`;
const EMAIL = new RegExp(`(?<!${CHAR})${CHAR}+(?:@|%40)${DOMAIN}\\.${TOP_LEVEL_DOMAIN}`, 'gu');

export function maskEmails(text: string): string {
    return text.replace(EMAIL, '<email>');
}

// What the log handlers write of an error is its message and stack (the file), or the error itself (Sentry, which
// would send its other fields too): a new Error with those two masked, and the error logged is left as it was
function maskedError(error: unknown): unknown {
    if (error === undefined || error === null) return error;
    if (Array.isArray(error)) return error.map(maskedError);
    if (error instanceof Error) {
        const masked = new Error(maskEmails(error.message));
        masked.name = error.name;
        masked.stack = error.stack === undefined ? undefined : maskEmails(error.stack);
        return masked;
    }
    return maskEmails(String(error));
}

export function maskedLogRecord(log: LogRecord): LogRecord {
    return { ...log, message: maskEmails(log.message), error: maskedError(log.error) };
}

// Hands each record to the handlers that write it out (the file, Sentry, the console) with every address masked
export class MaskingLogHandler implements LogHandler {
    constructor(private readonly handlers: LogHandler[]) {}

    log(log: LogRecord) {
        const masked = maskedLogRecord(log);
        for (const handler of this.handlers) {
            handler.log(masked);
        }
    }
}
