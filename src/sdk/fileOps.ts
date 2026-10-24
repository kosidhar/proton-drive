import { mkdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

import {
    IntegrityError,
    type Logger,
    type NodeEntity,
    NodeType,
    NodeWithSameNameExistsValidationError,
    type ProtonDriveClient,
    type Revision,
} from '@protontech/drive-sdk';
import { isProtonDocument, isProtonSheet } from '@protontech/drive-sdk/internal/nodes/mediaTypes';

import { getName } from './node';

export const THIRD_PARTY_DISCLOSURE = 'This is a third-party application not officially supported by Proton.';
export const DEFAULT_APP_VERSION = process.env.PROTON_DRIVE_APP_VERSION || 'external-drive-ubuntu_sync@0.1.0-alpha';
export const DEFAULT_SDK_VERSION = 'js@0.0.1';
export const DEFAULT_CLIENT_UID_PREFIX = 'ubuntu-sync';

const MIME_BY_EXT: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.py': 'text/x-python',
    '.sh': 'application/x-sh',
};

export function detectMediaType(localPath: string): string {
    const ext = path.extname(localPath).toLowerCase();
    if (MIME_BY_EXT[ext]) {
        return MIME_BY_EXT[ext];
    }
    const bunType = Bun.file(localPath).type;
    if (bunType && bunType !== 'application/octet-stream') {
        return bunType.split(';')[0]!.trim();
    }
    return 'application/octet-stream';
}

export async function computeLocalFileSha1(localPath: string): Promise<string> {
    const file = Bun.file(localPath);
    const hasher = new Bun.CryptoHasher('sha1');
    const stream = file.stream();
    const reader = stream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value) {
            hasher.update(value);
        }
    }
    return hasher.digest('hex');
}

export function isUnsupportedRemoteNode(node: NodeEntity): boolean {
    return isProtonDocument(node.mediaType) || isProtonSheet(node.mediaType);
}

export type UploadCollisionMode = 'new-revision' | 'rename' | 'skip';

export interface UploadResult {
    status: 'uploaded' | 'updated-revision' | 'skipped-identical' | 'skipped';
    nodeUid?: string;
    remoteName: string;
    sha1: string;
    size: number;
    mtimeMs: number;
}

export async function uploadLocalFileToDrive(options: {
    sdk: ProtonDriveClient;
    logger: Logger;
    parentNode: NodeEntity | string;
    localPath: string;
    remoteName?: string;
    existingNodeUid?: string;
    collisionMode?: UploadCollisionMode;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<UploadResult> {
    const {
        sdk,
        logger,
        parentNode,
        localPath,
        collisionMode = 'new-revision',
        onProgress,
    } = options;

    const st = await stat(localPath);
    const file = Bun.file(localPath);
    const expectedSha1 = await computeLocalFileSha1(localPath);
    const mediaType = detectMediaType(localPath);
    const mtimeMs = st.mtimeMs || Date.now();

    let targetName = options.remoteName ?? path.basename(localPath);
    let revisionTargetNodeUid = options.existingNodeUid;

    if (revisionTargetNodeUid) {
        try {
            const existing = await sdk.getNode(revisionTargetNodeUid);
            const existingSha1 = existing.activeRevision?.claimedDigests?.sha1;
            if (existingSha1 && existingSha1 === expectedSha1) {
                return {
                    status: 'skipped-identical',
                    nodeUid: existing.uid,
                    remoteName: getName(existing),
                    sha1: expectedSha1,
                    size: st.size,
                    mtimeMs,
                };
            }
        } catch {
            revisionTargetNodeUid = undefined;
        }
    }

    const metadata = {
        mediaType,
        expectedSize: st.size,
        expectedSha1,
        modificationTime: new Date(mtimeMs),
    };

    while (true) {
        try {
            const uploader = revisionTargetNodeUid
                ? await sdk.getFileRevisionUploader(revisionTargetNodeUid, metadata)
                : await sdk.getFileUploader(parentNode, targetName, metadata);

            const controller = await uploader.uploadFromStream(
                file.stream(),
                [],
                onProgress
                    ? (uploadedBytes: number) => {
                          onProgress(Math.min(uploadedBytes, st.size), st.size);
                      }
                    : undefined,
            );

            const completionResult = await controller.completion();
            const uploadedNodeUid =
                completionResult && typeof completionResult === 'object' && 'nodeUid' in completionResult
                    ? String((completionResult as { nodeUid: string }).nodeUid)
                    : revisionTargetNodeUid;

            return {
                status: revisionTargetNodeUid ? 'updated-revision' : 'uploaded',
                nodeUid: uploadedNodeUid,
                remoteName: targetName,
                sha1: expectedSha1,
                size: st.size,
                mtimeMs,
            };
        } catch (error: unknown) {
            if (!(error instanceof NodeWithSameNameExistsValidationError)) {
                throw error;
            }
            const conflictingUid = error.existingNodeUid;
            if (!conflictingUid) {
                throw error;
            }

            const existingNode = await sdk.getNode(conflictingUid);
            const existingSha1 = existingNode.activeRevision?.claimedDigests?.sha1;
            if (existingSha1 && existingSha1 === expectedSha1) {
                logger.debug(`Skipping upload for ${targetName}: remote SHA1 matches local SHA1`);
                return {
                    status: 'skipped-identical',
                    nodeUid: existingNode.uid,
                    remoteName: getName(existingNode),
                    sha1: expectedSha1,
                    size: st.size,
                    mtimeMs,
                };
            }

            if (collisionMode === 'skip') {
                return {
                    status: 'skipped',
                    nodeUid: existingNode.uid,
                    remoteName: getName(existingNode),
                    sha1: expectedSha1,
                    size: st.size,
                    mtimeMs,
                };
            }

            if (collisionMode === 'rename') {
                targetName = await sdk.getAvailableName(parentNode, targetName, NodeType.File);
                revisionTargetNodeUid = undefined;
                continue;
            }

            // Default: create a new revision on the existing file node
            revisionTargetNodeUid = conflictingUid;
        }
    }
}

export interface DownloadResult {
    status: 'downloaded' | 'skipped-unsupported' | 'skipped-identical';
    localPath: string;
    sha1?: string;
    size: number;
    mtimeMs: number;
}

export async function downloadDriveNodeToLocal(options: {
    sdk: ProtonDriveClient;
    logger: Logger;
    remoteNode: NodeEntity;
    localPath: string;
    revision?: Revision;
    onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}): Promise<DownloadResult> {
    const { sdk, logger, remoteNode, localPath, onProgress } = options;

    if (isUnsupportedRemoteNode(remoteNode)) {
        return {
            status: 'skipped-unsupported',
            localPath,
            size: 0,
            mtimeMs: Date.now(),
        };
    }

    const revision = options.revision ?? remoteNode.activeRevision;
    if (!revision) {
        throw new Error(`Remote file ${getName(remoteNode)} (${remoteNode.uid}) has no active revision`);
    }

    const expectedSha1 = revision.claimedDigests?.sha1;
    const sha1Verified = Boolean(revision.claimedDigests?.sha1Verified);
    const expectedSize = revision.claimedSize ?? 0;
    const claimedMtime = revision.claimedModificationTime ?? remoteNode.modificationTime;
    const mtimeMs = claimedMtime instanceof Date ? claimedMtime.getTime() : Date.now();

    // Check if local file already exists with identical SHA1
    const existingStat = await stat(localPath).catch(() => null);
    if (existingStat && existingStat.isFile() && expectedSha1) {
        const currentSha1 = await computeLocalFileSha1(localPath).catch(() => '');
        if (currentSha1 === expectedSha1) {
            return {
                status: 'skipped-identical',
                localPath,
                sha1: expectedSha1,
                size: existingStat.size,
                mtimeMs: existingStat.mtimeMs,
            };
        }
    }

    const parentDir = path.dirname(localPath);
    await mkdir(parentDir, { recursive: true });

    // Asked for before the temp file exists (creating the writer creates it), so failing here (offline, say) leaves none
    const downloader = await sdk.getFileRevisionDownloader(revision.uid);

    const tempPath = path.join(parentDir, `.proton-drive-tmp-${process.pid}-${Date.now()}-${path.basename(localPath)}`);
    const tempFile = Bun.file(tempPath);
    const writer = tempFile.writer();

    const writableStream: WritableStream = {
        // @ts-expect-error Bun FileSink writer compatibility with WritableStream
        getWriter: () => writer,
        close: async () => {
            await writer.end();
        },
        abort: async () => {
            await writer.end();
            await unlink(tempPath).catch(() => {});
        },
        locked: false,
    };

    try {
        const controller = downloader.downloadToStream(writableStream, (downloadedBytes) => {
            onProgress?.(downloadedBytes, expectedSize);
        });
        await controller.completion();
        await writer.end();

        if (expectedSha1) {
            const actualSha1 = await computeLocalFileSha1(tempPath);
            if (actualSha1 !== expectedSha1 && sha1Verified) {
                throw new IntegrityError('Downloaded file SHA1 mismatch', {
                    computedSha1: actualSha1,
                    expectedSha1,
                });
            }
        }

        await rename(tempPath, localPath);
        const mtimeDate = new Date(mtimeMs);
        await utimes(localPath, mtimeDate, mtimeDate).catch(() => {});

        const finalStat = await stat(localPath);
        return {
            status: 'downloaded',
            localPath,
            sha1: expectedSha1 ?? (await computeLocalFileSha1(localPath)),
            size: finalStat.size,
            mtimeMs: finalStat.mtimeMs,
        };
    } catch (error) {
        logger.error(`Failed downloading ${getName(remoteNode)} to ${localPath}`, error);
        try {
            await writer.end(); // closes the temp file if the stream left it open
        } catch {
            // Closed already
        }
        await unlink(tempPath).catch(() => {});
        throw error;
    }
}

export async function ensureRemoteFolder(
    sdk: ProtonDriveClient,
    parentNode: NodeEntity | string,
    folderName: string,
): Promise<NodeEntity> {
    return (await createRemoteFolder(sdk, parentNode, folderName)).node;
}

// Like ensureRemoteFolder, also saying whether the folder was made now (false when one of that name was already there)
export async function createRemoteFolder(
    sdk: ProtonDriveClient,
    parentNode: NodeEntity | string,
    folderName: string,
): Promise<{ node: NodeEntity; created: boolean }> {
    try {
        return { node: await sdk.createFolder(parentNode, folderName), created: true };
    } catch (error: unknown) {
        if (error instanceof NodeWithSameNameExistsValidationError && error.existingNodeUid) {
            return { node: await sdk.getNode(error.existingNodeUid), created: false };
        }
        throw error;
    }
}

export async function listFolderChildren(sdk: ProtonDriveClient, folderNode: NodeEntity | string): Promise<NodeEntity[]> {
    const children: NodeEntity[] = [];
    for await (const child of sdk.iterateFolderChildren(folderNode)) {
        if (!child.trashTime) {
            children.push(child);
        }
    }
    return children;
}
