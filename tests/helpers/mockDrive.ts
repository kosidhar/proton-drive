import {
    ConnectionError,
    type DriveEvent,
    type NodeEntity,
    NodeType,
    NodeWithSameNameExistsValidationError,
    type ProtonDriveClient,
    ValidationError,
} from '@protontech/drive-sdk';

import type { Manager as EventsManager } from '../../src/sdk/events/manager';
import { makeMockNode } from './mockNodes';

export type MockNode = NodeEntity & { content?: string };

// An in-memory My files tree behind the SDK calls the sync engine makes. Uploads, downloads and trashes are recorded
// (by path, and trashes per call by uid), as are renames and moves (by uid), so tests can assert on exactly what reached
// the cloud. A call that fails (see failNext and down) reaches nothing and is not recorded.
export function makeMockDrive() {
    const nodes = new Map<string, MockNode>();
    const root = makeMockNode({ uid: 'vol~root', nameStr: 'root', type: NodeType.Folder });
    nodes.set(root.uid, root);
    const calls = {
        uploads: [] as string[],
        downloads: [] as string[],
        trashed: [] as string[][],
        renamed: [] as Array<{ uid: string; name: string }>,
        moved: [] as Array<{ uid: string; parentUid: string }>,
    };
    const failListing = new Set<string>(); // folder uids whose listing fails
    // SDK methods (by name) whose next call fails with the error given, once each
    const failures = new Map<string, Error[]>();
    // SDK methods (by name) that fail with a ConnectionError for as long as they are in the set, as when offline
    const down = new Set<string>();
    const failNext = (method: string, error: Error = new ConnectionError('Network unreachable')) => {
        failures.set(method, [...(failures.get(method) ?? []), error]);
    };
    const maybeFail = (method: string) => {
        const queued = failures.get(method);
        if (queued && queued.length > 0) {
            throw queued.shift()!;
        }
        if (down.has(method)) {
            throw new ConnectionError('Network unreachable');
        }
    };
    let nextId = 1;
    let eventCallback: ((context: 'drive' | 'photos', event: DriveEvent) => Promise<void>) | null = null;

    const nameOf = (node: NodeEntity) => (node.name.ok ? node.name.value : '');
    const childNamed = (parentUid: string, name: string) =>
        Array.from(nodes.values()).find((n) => n.uid !== root.uid && n.parentUid === parentUid && nameOf(n) === name);
    const refuseTakenName = (parentUid: string, name: string) => {
        const taken = childNamed(parentUid, name);
        if (taken) {
            throw new NodeWithSameNameExistsValidationError('An item with that name already exists', 2500, taken.uid);
        }
    };
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
            maybeFail('getNode');
            const found = nodes.get(uid);
            if (!found) throw new ValidationError('Item not found'); // as the SDK says it
            return found;
        },
        iterateFolderChildren: async function* (parent: NodeEntity | string) {
            const parentUid = typeof parent === 'string' ? parent : parent.uid;
            maybeFail('iterateFolderChildren');
            if (failListing.has(parentUid)) throw new Error(`Listing ${parentUid} failed`);
            for (const node of nodes.values()) {
                if (node.uid !== root.uid && node.parentUid === parentUid) yield node;
            }
        },
        // As the API does, a name already used in the folder is refused, naming the item that has it (ensureRemoteFolder
        // then takes that item)
        createFolder: async (parent: NodeEntity | string, name: string) => {
            maybeFail('createFolder');
            const parentUid = typeof parent === 'string' ? parent : parent.uid;
            refuseTakenName(parentUid, name);
            const folder = makeMockNode({ uid: `vol~created${nextId++}`, parentUid, nameStr: name, type: NodeType.Folder });
            nodes.set(folder.uid, folder);
            return folder;
        },
        getFileRevisionDownloader: async (revisionUid: string) => {
            maybeFail('getFileRevisionDownloader');
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
        // A new file with a name already used in the folder is refused as the API refuses it, naming the item that has
        // it: uploadLocalFileToDrive then uploads a new revision of that item instead
        getFileUploader: async (parent: NodeEntity | string, name: string, metadata: { expectedSha1: string }) => {
            maybeFail('getFileUploader');
            const parentUid = typeof parent === 'string' ? parent : parent.uid;
            refuseTakenName(parentUid, name);
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
            maybeFail('getFileRevisionUploader');
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
        // Takes nodes or uids, as the SDK does
        trashNodes: async function* (trash: Array<NodeEntity | string>) {
            maybeFail('trashNodes');
            const uids = trash.map((n) => (typeof n === 'string' ? n : n.uid));
            calls.trashed.push(uids);
            for (const uid of uids) {
                // Trashing a folder takes everything in it along
                const prefix = `${pathOf(uid)}/`;
                const doomed = Array.from(nodes.keys()).filter((u) => u === uid || pathOf(u).startsWith(prefix));
                for (const u of doomed) nodes.delete(u);
                yield { uid, ok: true as const };
            }
        },
        // A name already used by another item in the same folder is refused, as the API refuses it
        renameNode: async (uid: string, newName: string) => {
            maybeFail('renameNode');
            const node = nodes.get(uid);
            if (!node) throw new ValidationError('Item not found');
            const clash = childNamed(node.parentUid!, newName);
            if (clash && clash.uid !== uid) {
                throw new NodeWithSameNameExistsValidationError('An item with that name already exists', 2500, clash.uid);
            }
            const renamed: MockNode = { ...node, name: { ok: true as const, value: newName } };
            nodes.set(uid, renamed);
            calls.renamed.push({ uid, name: newName });
            return renamed;
        },
        moveNodes: async function* (uids: string[], newParentUid: string) {
            maybeFail('moveNodes');
            for (const uid of uids) {
                const node = nodes.get(uid);
                const parent = nodes.get(newParentUid);
                if (!node || !parent || parent.type !== NodeType.Folder) {
                    yield { uid, ok: false as const, error: new ValidationError('Item not found') };
                    continue;
                }
                const clash = childNamed(newParentUid, nameOf(node));
                if (clash && clash.uid !== uid) {
                    yield {
                        uid,
                        ok: false as const,
                        error: new NodeWithSameNameExistsValidationError('An item with that name already exists', 2500, clash.uid),
                    };
                    continue;
                }
                nodes.set(uid, { ...node, parentUid: newParentUid });
                calls.moved.push({ uid, parentUid: newParentUid });
                yield { uid, ok: true as const };
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
        failNext,
        down,
        nameOf,
        fire: (e: DriveEvent) => eventCallback!('drive', e),
    };
}
