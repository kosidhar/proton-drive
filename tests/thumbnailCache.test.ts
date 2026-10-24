import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { failedThumbnailPath, forgetFailedThumbnail } from '../src/sync/thumbnailCache';

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const failDir = (home: string) => path.join(home, '.cache', 'thumbnails', 'fail', 'gnome-thumbnail-factory');

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

function tempHome(): string {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pd-thumbs-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
}

describe('failedThumbnailPath', () => {
    test('is the md5 of the escaped file:// URI, under the GNOME thumbnail factory fail folder', () => {
        expect(failedThumbnailPath('/home/u/ProtonDrive/a b.jpg', '/home/u')).toBe(
            `/home/u/.cache/thumbnails/fail/gnome-thumbnail-factory/${md5('file:///home/u/ProtonDrive/a%20b.jpg')}.png`,
        );
    });

    test('escapes every byte as g_filename_to_uri does', () => {
        // What GLib.filename_to_uri gives for this path (checked against GLib on this system): UTF-8 bytes and the
        // reserved characters other than its path set are percent-encoded in upper case; ';' is escaped too
        const name = "/home/u/ProtonDrive/a b;c!$&'()*+,=:@~é#?[]%.jpg";
        const uri = "file:///home/u/ProtonDrive/a%20b%3Bc!$&'()*+,=:@~%C3%A9%23%3F%5B%5D%25.jpg";
        expect(failedThumbnailPath(name, '/home/u')).toBe(path.join(failDir('/home/u'), `${md5(uri)}.png`));
        // Letters, digits and -._ stay; control characters, quotes, backslashes and braces don't
        expect(failedThumbnailPath('/d/A-z_0.9/"\\{|}^`<>\t', '/h')).toBe(
            path.join(failDir('/h'), `${md5('file:///d/A-z_0.9/%22%5C%7B%7C%7D%5E%60%3C%3E%09')}.png`),
        );
    });

    test('uses XDG_CACHE_HOME when no home is given and it is set', () => {
        const saved = process.env.XDG_CACHE_HOME;
        try {
            process.env.XDG_CACHE_HOME = '/tmp/some-cache';
            expect(failedThumbnailPath('/m/x.png')).toBe(
                `/tmp/some-cache/thumbnails/fail/gnome-thumbnail-factory/${md5('file:///m/x.png')}.png`,
            );
            process.env.XDG_CACHE_HOME = 'relative/cache'; // not absolute: ignored, as the XDG spec says
            expect(failedThumbnailPath('/m/x.png')).toBe(
                path.join(failDir(os.homedir()), `${md5('file:///m/x.png')}.png`),
            );
        } finally {
            if (saved === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = saved;
        }
    });
});

describe('forgetFailedThumbnail', () => {
    test('deletes the failed thumbnail of a file, and is fine when there is none', async () => {
        const home = tempHome();
        const mountPath = '/home/u/ProtonDrive/Photos/beach é.jpg';
        const failed = failedThumbnailPath(mountPath, home);
        const other = failedThumbnailPath('/home/u/ProtonDrive/Photos/other.jpg', home);
        mkdirSync(path.dirname(failed), { recursive: true });
        writeFileSync(failed, 'png');
        writeFileSync(other, 'png');

        await forgetFailedThumbnail(mountPath, home);

        expect(existsSync(failed)).toBe(false);
        expect(existsSync(other)).toBe(true);
        await forgetFailedThumbnail(mountPath, home); // already gone
        await forgetFailedThumbnail('/nowhere/x.jpg', path.join(home, 'no-such-home'));
    });
});
