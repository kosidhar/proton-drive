import { NodeEntity } from '@protontech/drive-sdk';

export function findName(nodes: NodeEntity[], uid: string): string {
    for (const node of nodes) {
        if (node.uid === uid) {
            return getName(node);
        }
    }
    return uid;
}

export function getName(node: NodeEntity): string {
    const name = node.name.ok ? node.name.value : '';
    return name.length > 0 ? name : node.uid;
}

export function getClaimedSize(node: NodeEntity): number | undefined {
    return node.activeRevision?.claimedSize;
}

// Why a name from Proton Drive can't be the name of a file or folder on this computer, or null when it can (#536). Names
// are encrypted, so Proton's servers can't check them, and the SDK checks only their length: anyone who can edit a
// folder the user shares can give an item any name, `..` or `../../.config/autostart/x.desktop` included. A name that is
// empty, `.` or `..`, or holds a `/` or a NUL, would name another place than an item in its folder: such a node is never
// turned into a path (see syncableName).
export function remoteNameProblem(name: string): string | null {
    if (name === '') {
        return 'it is empty';
    }
    if (name === '.' || name === '..') {
        return `it is ${name}`;
    }
    if (name.includes('/')) {
        return 'it holds a /';
    }
    if (name.includes('\0')) {
        return 'it holds a NUL character';
    }
    return null;
}

// The name a node has as a file or folder on this computer (see getName), or null when it can't have one (see
// remoteNameProblem): it is then left out of everything synced, listed or downloaded, with its whole subtree.
export function syncableName(node: NodeEntity): string | null {
    const name = getName(node);
    return remoteNameProblem(name) === null ? name : null;
}

// A name from Proton Drive as it may be written in a log or a message: JSON, which escapes quotes, backslashes and
// control characters, with the marks that reverse the order text is shown in, and the line and paragraph separators,
// escaped too. The name is someone else's text (#536).
export function quotedName(name: string): string {
    return JSON.stringify(name).replace(
        /[\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
