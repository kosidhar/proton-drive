import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type NodeEntity, NodeType, NodeWithSameNameExistsValidationError, type ProtonDriveClient } from '@protontech/drive-sdk';

import { createRemoteFolder, downloadDriveNodeToLocal, downloadRevisionToFile } from '../src/sdk/fileOps';
import { makeMockNode } from './helpers/mockNodes';

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// The SDK's download slots: five, each taken by getFileRevisionDownloader and given back only when the download it
// returned ends (a downloader never used keeps its slot for ever), as in the SDK's DownloadQueue
function slottedSdk(content: string, slots = 5) {
    let free = slots;
    const waiting: Array<() => void> = [];
    const release = () => {
        free += 1;
        waiting.shift()?.();
    };
    const sdk = {
        getFileRevisionDownloader: async () => {
            while (free === 0) await new Promise<void>((resolve) => waiting.push(resolve));
            free -= 1;
            return {
                downloadToStream: (writable: WritableStream) => {
                    const writer = writable.getWriter();
                    const promise = (async () => {
                        try {
                            await writer.write(Buffer.from(content));
                        } finally {
                            release();
                        }
                    })();
                    return { completion: () => promise };
                },
            };
        },
    };
    return { sdk: sdk as unknown as ProtonDriveClient, free: () => free };
}

describe('downloadRevisionToFile', () => {
    // Final review I-2 (deferred L93): the downloader was asked for before the file was opened, outside the try, so a
    // file that couldn't be opened kept its slot, and after five of those every download waited for ever
    test('a file that cannot be opened gives its download slot back: five such failures, then a download still works', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-fileops-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const { sdk, free } = slottedSdk('content');
        const remoteNode = makeMockNode({ uid: 'vol~a.txt', parentUid: 'vol~root', nameStr: 'a.txt', type: NodeType.File, content: 'content' }) as NodeEntity;

        for (let i = 0; i < 5; i++) {
            const filePath = path.join(dir, 'missing-folder', `a${i}.txt`); // opening it fails at once
            await expect(downloadRevisionToFile({ sdk, logger, remoteNode, filePath })).rejects.toThrow(/ENOENT/);
        }
        expect(free()).toBe(5);

        const filePath = path.join(dir, 'a.txt');
        const done = downloadRevisionToFile({ sdk, logger, remoteNode, filePath }).then(() => 'downloaded');
        expect(await Promise.race([done, Bun.sleep(2000).then(() => 'waited for a slot for ever')])).toBe('downloaded');
        expect(readFileSync(filePath, 'utf8')).toBe('content');
        expect(free()).toBe(5);
    });
});

describe('downloadDriveNodeToLocal', () => {
    // #349: staging temp file names must stay within NAME_MAX even when the target file name is 255 bytes
    test('downloads a file whose name is at the 255-byte limit without exceeding NAME_MAX for its temp file', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-fileops-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const { sdk } = slottedSdk('long-name-content');
        const longName = `${'a'.repeat(251)}.txt`;
        expect(Buffer.byteLength(longName)).toBe(255);
        const remoteNode = makeMockNode({ uid: 'vol~long', parentUid: 'vol~root', nameStr: longName, type: NodeType.File, content: 'long-name-content' }) as NodeEntity;
        const localPath = path.join(dir, longName);
        let stagedNames: string[] = [];

        const result = await downloadDriveNodeToLocal({
            sdk,
            logger,
            remoteNode,
            localPath,
            beforePlacing: async () => {
                stagedNames = readdirSync(dir);
                return true;
            },
        });

        expect(result.status).toBe('downloaded');
        expect(stagedNames).toHaveLength(1);
        expect(stagedNames[0]).toStartWith('.proton-drive-tmp-');
        expect(Buffer.byteLength(stagedNames[0]!)).toBeLessThanOrEqual(255);
        expect(readFileSync(localPath, 'utf8')).toBe('long-name-content');
        expect(readdirSync(dir)).toEqual([longName]);
    });
});

// #165: a name held by an item in the Proton Drive trash, or by a file, is never taken for the folder asked for
describe('createRemoteFolder never adopts a trashed node or a file (#165)', () => {
    const refusing = (existing: NodeEntity) =>
        ({
            createFolder: async () => {
                throw new NodeWithSameNameExistsValidationError('An item with that name already exists', 2500, existing.uid);
            },
            getNode: async () => existing,
        }) as unknown as ProtonDriveClient;

    test('a live folder holding the name is taken, as before', async () => {
        const live = makeMockNode({ uid: 'vol~f', parentUid: 'vol~root', nameStr: 'Folder', type: NodeType.Folder });
        expect(await createRemoteFolder(refusing(live), 'vol~root', 'Folder')).toEqual({ node: live, created: false });
    });

    test('one in the trash is refused', async () => {
        const trashed = { ...makeMockNode({ uid: 'vol~f', parentUid: 'vol~root', nameStr: 'Folder', type: NodeType.Folder }), trashTime: new Date() };
        await expect(createRemoteFolder(refusing(trashed), 'vol~root', 'Folder')).rejects.toThrow(/trash/);
    });

    test('a file holding the name is refused', async () => {
        const file = makeMockNode({ uid: 'vol~f', parentUid: 'vol~root', nameStr: 'Folder', type: NodeType.File });
        await expect(createRemoteFolder(refusing(file), 'vol~root', 'Folder')).rejects.toThrow(/not a folder/);
    });
});
