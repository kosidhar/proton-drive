import { copyFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

export function formatConflictFileName(originalName: string, date = new Date(), host = hostname()): string {
    const dotIndex = originalName.lastIndexOf('.');
    const hasExt = dotIndex > 0 && dotIndex < originalName.length - 1;
    const stem = hasExt ? originalName.slice(0, dotIndex) : originalName;
    const ext = hasExt ? originalName.slice(dotIndex) : '';

    return `${stem}${conflictMark(date, host)}${ext}`;
}

// What a conflict name adds between the stem and the extension: " (conflict <date time> <host>)"
export function conflictMark(date = new Date(), host = hostname()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    const safeHost = host.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'ubuntu';
    return ` (conflict ${stamp} ${safeHost})`;
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
