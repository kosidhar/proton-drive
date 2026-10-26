import path from 'node:path';

import { virtualDriveWanted } from '../sync/driveMode';
import { type ProtonDriveSyncEngine, resolveSyncDirInput } from '../sync/syncEngine';
import type { SyncStateDatabase } from '../sync/syncStateDb';
import type { DriveController } from './driveController';

export interface SettingsRouteDeps {
    stateDb: SyncStateDatabase;
    drive: Pick<DriveController, 'relocate' | 'setVirtualDriveWanted' | 'status'>;
    engine: Pick<ProtonDriveSyncEngine, 'reconcileNow'>;
}

// POST /api/settings: saves the settings given, the folder and the switch last, so that neither can stop the rest
// from saving. The sync folder moves only when syncDir names another folder than the stored one (normalized: '~',
// trailing slashes); the same folder is nothing to do, even while files move or a move waits for an action (those are
// finished, moved back or retried only by POST /drive/move on the control socket). virtualDriveWanted moves the files
// when it changes. Answers 200 { ok: true, settings, virtualDriveWanted, vfs, folderError, switchError }: ok means the
// other settings were saved; folderError (the folder refused or its move failed) and switchError (the switch refused or
// its move failed) are null or why. 400 for a malformed body, 500 when the settings themselves can't be saved.
export async function settingsRoute(req: Request, deps: SettingsRouteDeps): Promise<Response> {
    const { stateDb, drive, engine } = deps;
    try {
        const prev = stateDb.getSettings();
        const { virtualDriveWanted: wanted, syncDir, ...body } = (await req.json()) as Record<string, unknown>;
        if (wanted !== undefined && typeof wanted !== 'boolean') {
            return Response.json({ error: 'virtualDriveWanted must be true or false' }, { status: 400 });
        }
        stateDb.updateSettings(body);
        let folderError: string | null = null;
        if (typeof syncDir === 'string' && syncDir.trim() && resolveSyncDirInput(syncDir.trim()) !== path.resolve(prev.syncDir)) {
            try {
                stateDb.updateSettings({ syncDir: await drive.relocate(syncDir.trim()) });
            } catch (error: unknown) {
                folderError = messageOf(error);
            }
        }
        const updated = stateDb.getSettings();
        if (prev.syncDir !== updated.syncDir || JSON.stringify(prev.ignorePatterns) !== JSON.stringify(updated.ignorePatterns)) {
            void engine.reconcileNow();
        }
        let switchError: string | null = null;
        if (typeof wanted === 'boolean' && wanted !== virtualDriveWanted(stateDb)) {
            try {
                await drive.setVirtualDriveWanted(wanted);
            } catch (error: unknown) {
                switchError = messageOf(error);
            }
        }
        return Response.json({
            ok: true,
            settings: stateDb.getSettings(),
            virtualDriveWanted: virtualDriveWanted(stateDb),
            vfs: drive.status(),
            folderError,
            switchError,
        });
    } catch (error: unknown) {
        return Response.json({ error: messageOf(error) }, { status: 500 });
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
