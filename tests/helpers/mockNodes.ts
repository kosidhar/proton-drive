import { MemberRole, type NodeEntity, NodeType, RevisionState } from '@protontech/drive-sdk';

export function makeMockNode(overrides: Partial<NodeEntity> & { uid: string; nameStr: string; type: NodeType; sha1?: string; content?: string }): NodeEntity {
    const now = new Date();
    const contentBytes = Buffer.from(overrides.content ?? '');
    return {
        parentUid: 'vol~root',
        name: { ok: true, value: overrides.nameStr },
        keyAuthor: { ok: true, value: 'user@proton.me' },
        nameAuthor: { ok: true, value: 'user@proton.me' },
        directRole: MemberRole.Admin,
        ownedBy: { email: 'user@proton.me' },
        mediaType: overrides.type === NodeType.File ? 'text/plain' : undefined,
        isShared: false,
        isSharedByUrl: false,
        creationTime: now,
        modificationTime: now,
        treeEventScopeId: 'scope-main',
        activeRevision:
            overrides.type === NodeType.File
                ? {
                      uid: `${overrides.uid}~rev1`,
                      state: RevisionState.Active,
                      creationTime: now,
                      contentAuthor: { ok: true, value: 'user@proton.me' },
                      storageSize: contentBytes.length,
                      isImported: false,
                      claimedSize: contentBytes.length,
                      claimedModificationTime: now,
                      claimedDigests: {
                          sha1: overrides.sha1 ?? new Bun.CryptoHasher('sha1').update(contentBytes).digest('hex'),
                          sha1Verified: true,
                      },
                  }
                : undefined,
        ...overrides,
    };
}
