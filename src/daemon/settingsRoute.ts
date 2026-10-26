import path from 'node:path';

import { virtualDriveWanted } from '../sync/driveMode';
import { type ProtonDriveSyncEngine, resolveSyncDirInput } from '../sync/syncEngine';
import type { SyncStateDatabase } from '../sync/syncStateDb';
import type { DriveController } from './driveController';
import type { SettingsChange } from './settingsValidation';

export interface SettingsRouteDeps {
    stateDb: SyncStateDatabase;
    drive: Pick<DriveController, 'relocate' | 'setVirtualDriveWanted' | 'status'>;
    engine: Pick<ProtonDriveSyncEngine, 'reconcileNow'>;
}

// What changing the folder and the switch answers: the folder refused or its move
// failed (folderError), the switch refused or its move failed (switchError); null when fine
interface DriveChange {
    folderError: string | null;
    switchError: string | null;
}

// The folder and the switch, last, so that neither can stop the rest from saving. The sync folder moves only when
// syncDir names another folder than the stored one (normalized: '~', trailing slashes); the same folder is nothing to
// do, even while files move or a move waits for an action (those are finished, moved back or retried only by POST
// /drive/move on the control socket). virtualDriveWanted moves the files when it changes.
async function changeDrive(
    req: { syncDir?: unknown; wanted?: unknown },
    deps: SettingsRouteDeps,
): Promise<DriveChange> {
    const { stateDb, drive, engine } = deps;
    const { syncDir, wanted } = req;
    const prev = stateDb.getSettings();
    let folderError: string | null = null;
    if (typeof syncDir === 'string' && syncDir.trim() && resolveSyncDirInput(syncDir.trim()) !== path.resolve(prev.syncDir)) {
        try {
            stateDb.updateSettings({ syncDir: await drive.relocate(syncDir.trim()) });
        } catch (error: unknown) {
            folderError = messageOf(error);
        }
    }
    if (prev.syncDir !== stateDb.getSettings().syncDir) {
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
    return { folderError, switchError };
}

function answer(deps: SettingsRouteDeps, change: DriveChange): Response {
    const { stateDb, drive } = deps;
    return Response.json({
        ok: true,
        settings: stateDb.getSettings(),
        virtualDriveWanted: virtualDriveWanted(stateDb),
        vfs: drive.status(),
        ...change,
    });
}

// POST /drive/settings (the user-only control socket, via startControlServer): saves every setting the app changes,
// the plain ones (ignorePatterns, conflictStrategy, notificationsEnabled) and the ones that move the user's files, the
// drive folder and the virtual drive switch. The caller has checked the whole request (parseSettingsRequest), so nothing
// invalid is stored, and a bad field stops the others. Answers 200 { ok: true, settings, virtualDriveWanted, vfs,
// folderError, switchError }: the plain settings are saved, and folderError / switchError are null or why that change
// was refused or failed. 500 { error, code } when the settings themselves can't be saved.
export async function driveSettings(change: SettingsChange, deps: SettingsRouteDeps): Promise<Response> {
    const { stateDb, engine } = deps;
    try {
        const prev = stateDb.getSettings();
        stateDb.updateSettings(change.settings);
        if (JSON.stringify(prev.ignorePatterns) !== JSON.stringify(stateDb.getSettings().ignorePatterns)) {
            void engine.reconcileNow();
        }
        return answer(deps, await changeDrive({ syncDir: change.syncDir, wanted: change.virtualDriveWanted }, deps));
    } catch (error: unknown) {
        return Response.json({ error: messageOf(error), code: 'EIO' }, { status: 500 });
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
