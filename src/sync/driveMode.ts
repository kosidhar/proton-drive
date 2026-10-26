import path from 'node:path';

import type { SyncStateDatabase } from './syncStateDb';

export type DriveLayout = 'plain' | 'virtual';

// Where downloaded files live while the sync folder is a virtual drive
export function backingDirFor(appDir: string): string {
    return path.join(appDir, 'files');
}

// Where the files physically are: in the sync folder itself (plain) or in the backing store (virtual)
export function readDriveLayout(stateDb: SyncStateDatabase): DriveLayout {
    return stateDb.getMeta('driveLayout') === 'virtual' ? 'virtual' : 'plain';
}

// Whether the user wants the virtual drive (on unless switched off)
export function virtualDriveWanted(stateDb: SyncStateDatabase): boolean {
    return stateDb.getMeta('virtualDriveWanted') !== '0';
}
