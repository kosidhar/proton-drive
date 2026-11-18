import { copyFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

export function formatConflictFileName(originalName: string, date = new Date(), host = hostname(), n = 0): string {
    return markedName(originalName, `${conflictMark(date, host)}${n > 0 ? `-${n}` : ''}`, NAME_MAX);
}

// The name a file the drive's disk guard cut short is kept under beside Proton Drive's version, once the user puts
// that back (#300): the conflict copy's name, with "not fully written" in place of "conflict", and -<n> after it for the
// n-th taken. Its stem is shortened to keep the name within NAME_MAX bytes, never splitting a character, as the file is
// renamed to it here.
export function formatNotFullyWrittenName(originalName: string, date = new Date(), host = hostname(), n = 0): string {
    return markedName(originalName, `${nameMark('not fully written', date, host)}${n > 0 ? `-${n}` : ''}`, NAME_MAX);
}

// The longest name a Linux file system takes, in bytes
const NAME_MAX = 255;

// What a conflict name adds between the stem and the extension: " (conflict <date time> <host>)"
export function conflictMark(date = new Date(), host = hostname()): string {
    return nameMark('conflict', date, host);
}

// " (<word> <date time> <host>)", which a copy's name adds between the stem and the extension
function nameMark(word: string, date: Date, host: string): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    const safeHost = host.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'ubuntu';
    return ` (${word} ${stamp} ${safeHost})`;
}

// The name with the mark between its stem and its extension; with maxBytes, its stem shortened to fit (an extension too
// long to keep then counts as part of the stem)
function markedName(originalName: string, mark: string, maxBytes?: number): string {
    const dotIndex = originalName.lastIndexOf('.');
    const hasExt = dotIndex > 0 && dotIndex < originalName.length - 1;
    let stem = hasExt ? originalName.slice(0, dotIndex) : originalName;
    let ext = hasExt ? originalName.slice(dotIndex) : '';
    if (maxBytes !== undefined) {
        const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
        if (bytes(mark) + bytes(ext) >= maxBytes) {
            [stem, ext] = [originalName, ''];
        }
        // By whole characters (code points), so none is ever split
        const chars = Array.from(stem);
        while (chars.length > 0 && bytes(chars.join('')) + bytes(mark) + bytes(ext) > maxBytes) {
            chars.pop();
        }
        stem = chars.join('');
    }
    return `${stem}${mark}${ext}`;
}

export async function createLocalConflictCopy(localFullPath: string): Promise<string> {
    const dir = path.dirname(localFullPath);
    const baseName = path.basename(localFullPath);
    const when = new Date();
    const host = hostname();
    let counter = 0;
    let candidatePath = path.join(dir, formatConflictFileName(baseName, when, host, counter));

    while (await fileExists(candidatePath)) {
        counter++;
        candidatePath = path.join(dir, formatConflictFileName(baseName, when, host, counter));
    }

    await copyFile(localFullPath, candidatePath);
    return candidatePath;
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}
