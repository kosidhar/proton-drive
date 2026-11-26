/** Where the signed-in session is kept: the OS keyring (or another secret store), or a plain file only the user can read. */
export type SessionLocation = { storage: 'keyring' } | { storage: 'file'; path?: string };

export const NO_FILE_SESSION_ENV = 'PROTONDRIVE_NO_FILE_SESSION';

/** Saving the session was refused: no keyring, and PROTONDRIVE_NO_FILE_SESSION forbids the file. The user stays signed out. */
export class SessionFileRefusedError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'SessionFileRefusedError';
    }
}

export const KEYRING_HELP =
    'Install and unlock a keyring (GNOME Keyring or KWallet, or any other Secret Service provider) and sign in again to keep it there.';

/** One plain sentence for the CLI: where the session is and, for a file, why that matters and what to do. */
export function describeSessionLocation(location: SessionLocation): string {
    if (location.storage === 'keyring') {
        return 'Your session is kept in the system keyring.';
    }
    const where = location.path ? ` in ${location.path}` : ' in a file';
    return (
        `No keyring was found, so your session is saved${where}. Anything running as you can read it. ` +
        `${KEYRING_HELP} Set ${NO_FILE_SESSION_ENV}=1 to refuse the file and stay signed out instead.`
    );
}

/** The two fields the daemon's /api/status and `auth status --json` carry; both null when there is no session. */
export function sessionFields(location: SessionLocation | null): { sessionStorage: 'keyring' | 'file' | null; sessionPath: string | null } {
    if (!location) return { sessionStorage: null, sessionPath: null };
    return { sessionStorage: location.storage, sessionPath: location.storage === 'file' ? (location.path ?? null) : null };
}

/** The same words from the two fields (as the daemon reports them), for a CLI talking to a running daemon. */
export function describeSessionFields(storage: string | null | undefined, filePath: string | null | undefined): string | null {
    if (storage === 'keyring') return describeSessionLocation({ storage: 'keyring' });
    if (storage === 'file') return describeSessionLocation({ storage: 'file', path: filePath ?? undefined });
    return null;
}
