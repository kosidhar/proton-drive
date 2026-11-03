import { copyFile, lstat, readdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { computeLocalFileSha1 } from '../sdk/fileOps';

export function formatConflictFileName(originalName: string, date = new Date(), host = hostname()): string {
    const { stem, ext } = splitName(originalName);
    return `${stem}${conflictMark(date, host)}${ext}`;
}

// What a conflict name adds between the stem and the extension: " (conflict <date time> <host>)"
export function conflictMark(date = new Date(), host = hostname()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return ` (conflict ${stamp} ${safeHostName(host)})`;
}

// Whether `name` is a conflict copy made on this host of the file named `originalName`: formatConflictFileName's name,
// with any "-<n>" added after it to free the name
export function isConflictCopyOf(name: string, originalName: string, host = hostname()): boolean {
    const { stem, ext } = splitName(originalName);
    const mark = ` \\(conflict \\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}-\\d{2} ${escapeRegExp(safeHostName(host))}\\)`;
    return new RegExp(`^${escapeRegExp(stem)}${mark}(-\\d+)*${escapeRegExp(ext)}$`).test(name);
}

// A conflict copy made here of the file at `localFullPath`, next to it, that holds exactly the content with this SHA1:
// what a keep-both cut short (its download failed) made, for the retry to go on from rather than make another (#25)
export async function findLocalConflictCopy(localFullPath: string, sha1: string, host = hostname()): Promise<string | null> {
    const dir = path.dirname(localFullPath);
    const originalName = path.basename(localFullPath);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => isConflictCopyOf(n, originalName, host)).sort()) {
        const fullPath = path.join(dir, name);
        const st = await lstat(fullPath).catch(() => null);
        if (st?.isFile() && (await computeLocalFileSha1(fullPath).catch(() => null)) === sha1) {
            return fullPath;
        }
    }
    return null;
}

function splitName(name: string): { stem: string; ext: string } {
    const dotIndex = name.lastIndexOf('.');
    const hasExt = dotIndex > 0 && dotIndex < name.length - 1;
    return { stem: hasExt ? name.slice(0, dotIndex) : name, ext: hasExt ? name.slice(dotIndex) : '' };
}

function safeHostName(host: string): string {
    return host.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'ubuntu';
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function createLocalConflictCopy(localFullPath: string): Promise<string> {
    const dir = path.dirname(localFullPath);
    const baseName = path.basename(localFullPath);
    let candidateName = formatConflictFileName(baseName);
    let candidatePath = path.join(dir, candidateName);
    let counter = 1;

    while (await fileExists(candidatePath)) {
        const dotIndex = candidateName.lastIndexOf('.');
        const stem = dotIndex > 0 ? candidateName.slice(0, dotIndex) : candidateName;
        const ext = dotIndex > 0 ? candidateName.slice(dotIndex) : '';
        candidatePath = path.join(dir, `${stem}-${counter}${ext}`);
        counter++;
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
