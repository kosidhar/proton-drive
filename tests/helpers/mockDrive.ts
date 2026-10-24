import { type DriveEvent, type NodeEntity, NodeType, type ProtonDriveClient } from '@protontech/drive-sdk';

import type { Manager as EventsManager } from '../../src/sdk/events/manager';
import { makeMockNode } from './mockNodes';

export type MockNode = NodeEntity & { content?: string };

// An in-memory My files tree behind the SDK calls the sync engine makes. Uploads, downloads and trashes are recorded
// (by path, and trashes per call by uid) so tests can assert on exactly what reached the cloud.
export function makeMockDrive() {
    const nodes = new Map<string, MockNode>();
    const root = makeMockNode({ uid: 'vol~root', nameStr: 'root', type: NodeType.Folder });
    nodes.set(root.uid, root);
    const calls = { uploads: [] as string[], downloads: [] as string[], trashed: [] as string[][] };
    const failListing = new Set<string>(); // folder uids whose listing fails
    let nextId = 1;
    let eventCallback: ((context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) | null = null;

    const nameOf = (node: NodeEntity) => (node.name.ok ? node.name.value : '');
    const childNamed = (parentUid: string, name: string) =>
        Array.from(nodes.values()).find((n) => n.uid !== root.uid && n.parentUid === parentUid && nameOf(n) === name);
    const pathOf = (uid: string): string => {
        const node = nodes.get(uid);
        if (!node || uid === root.uid || !node.parentUid) {
            return '';
        }
        const parent = pathOf(node.parentUid);
        return parent ? `${parent}/${nameOf(node)}` : nameOf(node);
    };

    // Adds a file (with content) or a folder (without), creating missing parent folders; uids are `vol~<path>`.
    const add = (relPath: string, content?: string): MockNode => {
        const segments = relPath.split('/');
        let parentUid = root.uid;
        let current = '';
        for (const [i, name] of segments.entries()) {
            current = current ? `${current}/${name}` : name;
            const isLast = i === segments.length - 1;
            const existing = childNamed(parentUid, name);
            if (existing && !isLast) {
                parentUid = existing.uid;
                continue;
            }
            const isFile = isLast && content !== undefined;
            const node = makeMockNode({
                uid: `vol~${current}`,
                parentUid,
                nameStr: name,
                type: isFile ? NodeType.File : NodeType.Folder,
                content: isFile ? content : undefined,
            });
            nodes.set(node.uid, node);
            parentUid = node.uid;
        }
        return nodes.get(`vol~${relPath}`)!;
    };

    const sdk = {
        getMyFilesRootFolder: async () => root,
        getNode: async (uid: string) => {
            const found = nodes.get(uid);
            if (!found) throw new Error(`Node ${uid} not found`);
            return found;
        },
        iterateFolderChildren: async function* (parent: NodeEntity | string) {
            const parentUid = typeof parent === 'string' ? parent : parent.uid;
            if (failListing.has(parentUid)) throw new Error(`Listing ${parentUid} failed`);
            for (const node of nodes.values()) {
                if (node.uid !== root.uid && node.parentUid === parentUid) yield node;
            }
        },
        createFolder: async (parent: NodeEntity | string, name: string) => {
            const parentUid = typeof parent === 'string' ? parent : parent.uid;
            const folder = makeMockNode({ uid: `vol~created${nextId++}`, parentUid, nameStr: name, type: NodeType.Folder });
            nodes.set(folder.uid, folder);
            return folder;
        },
        getFileRevisionDownloader: async (revisionUid: string) => {
            const nodeUid = revisionUid.replace(/~rev\d+$/, '');
            calls.downloads.push(pathOf(nodeUid));
            const bytes = Buffer.from(nodes.get(nodeUid)?.content ?? '');
            return {
                downloadToStream: (writable: WritableStream, onProgress?: (b: number) => void) => {
                    const writer = writable.getWriter();
                    const promise = (async () => {
                        await writer.write(bytes);
                        onProgress?.(bytes.length);
                    })();
                    return { completion: () => promise };
                },
            };
        },
        getFileUploader: async (parent: NodeEntity | string, name: string, metadata: { expectedSha1: string }) => {
            const parentUid = typeof parent === 'string' ? parent : parent.uid;
            const parentPath = pathOf(parentUid);
            calls.uploads.push(parentPath ? `${parentPath}/${name}` : name);
            return {
                uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                    const buf = Buffer.from(await new Response(stream).arrayBuffer());
                    const uid = `vol~uploaded${nextId++}`;
                    nodes.set(
                        uid,
                        makeMockNode({
                            uid,
                            parentUid,
                            nameStr: name,
                            type: NodeType.File,
                            sha1: metadata.expectedSha1,
                            content: buf.toString('utf8'),
                        }),
                    );
                    return { completion: async () => ({ nodeUid: uid }) };
                },
            };
        },
        // A new revision of an existing file (an edit), recorded among the uploads by path
        getFileRevisionUploader: async (nodeUid: string, metadata: { expectedSha1: string }) => {
            calls.uploads.push(pathOf(nodeUid));
            return {
                uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
                    const buf = Buffer.from(await new Response(stream).arrayBuffer());
                    const current = nodes.get(nodeUid);
                    if (!current) throw new Error(`Node ${nodeUid} not found`);
                    nodes.set(
                        nodeUid,
                        makeMockNode({
                            uid: nodeUid,
                            parentUid: current.parentUid,
                            nameStr: nameOf(current),
                            type: NodeType.File,
                            sha1: metadata.expectedSha1,
                            content: buf.toString('utf8'),
                        }),
                    );
                    return { completion: async () => ({ nodeUid }) };
                },
            };
        },
        trashNodes: async function* (trash: NodeEntity[]) {
            calls.trashed.push(trash.map((n) => n.uid));
            for (const n of trash) {
                // Trashing a folder takes everything in it along
                const prefix = `${pathOf(n.uid)}/`;
                const doomed = Array.from(nodes.keys()).filter((uid) => uid === n.uid || pathOf(uid).startsWith(prefix));
                for (const uid of doomed) nodes.delete(uid);
                yield { uid: n.uid, ok: true as const };
            }
        },
    } as unknown as ProtonDriveClient;

    const eventsManager = {
        addEventListener: (cb: (context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) => {
            eventCallback = cb;
            return () => {
                eventCallback = null;
            };
        },
        subscribeDriveScope: async () => {},
    } as unknown as EventsManager;

    const warnings: string[] = [];
    const logger = { debug: () => {}, info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} };

    return {
        root,
        nodes,
        add,
        sdk,
        eventsManager,
        logger,
        warnings,
        calls,
        failListing,
        fire: (e: DriveEvent) => eventCallback!('drive', e),
    };
}
