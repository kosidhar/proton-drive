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

export const DRIVE_CHANGE_FROM_APP = 'Change the drive folder and the virtual drive from the Proton Drive app: moving files is not done over the local web API';

// What changing the folder and the switch answers, as both routes below report it: the folder refused or its move
// failed (folderError), the switch refused or its move failed (switchError); null when fine
interface DriveChange {
    folderError: string | null;
    switchError: string | null;
}

// The folder and the switch, last, so that neither can stop the rest from saving. The sync folder moves only when
// syncDir names another folder than the stored one (normalized: '~', trailing slashes); the same folder is nothing to
// do, even while files move or a move waits for an action (those are finished, moved back or retried only by POST
// /drive/move on the control socket). virtualDriveWanted moves the files when it changes. With mayMove false (the
// unauthenticated TCP API) a change is refused and nothing moves.
async function changeDrive(
    req: { syncDir?: unknown; wanted?: unknown },
    deps: SettingsRouteDeps,
    mayMove: boolean,
): Promise<DriveChange> {
    const { stateDb, drive, engine } = deps;
    const { syncDir, wanted } = req;
    const prev = stateDb.getSettings();
    let folderError: string | null = null;
    if (typeof syncDir === 'string' && syncDir.trim() && resolveSyncDirInput(syncDir.trim()) !== path.resolve(prev.syncDir)) {
        if (!mayMove) {
            folderError = DRIVE_CHANGE_FROM_APP;
        } else {
            try {
                stateDb.updateSettings({ syncDir: await drive.relocate(syncDir.trim()) });
            } catch (error: unknown) {
                folderError = messageOf(error);
            }
        }
    }
    if (prev.syncDir !== stateDb.getSettings().syncDir) {
        void engine.reconcileNow();
    }
    let switchError: string | null = null;
    if (typeof wanted === 'boolean' && wanted !== virtualDriveWanted(stateDb)) {
        if (!mayMove) {
            switchError = DRIVE_CHANGE_FROM_APP;
        } else {
            try {
                await drive.setVirtualDriveWanted(wanted);
            } catch (error: unknown) {
                switchError = messageOf(error);
            }
        }
    }
    return { folderError, switchError };
}

function answer(deps: SettingsRouteDeps, change: DriveChange, refused: boolean): Response {
    const { stateDb, drive } = deps;
    return Response.json({
        ok: true,
        settings: stateDb.getSettings(),
        virtualDriveWanted: virtualDriveWanted(stateDb),
        vfs: drive.status(),
        ...change,
        ...(refused ? { code: 'EACCES' } : {}),
    });
}

// POST /api/settings (the unauthenticated TCP API): saves the settings given, except that it can't move files: a
// syncDir naming another folder than the stored one, or a virtualDriveWanted other than the current one, is refused in
// folderError / switchError (code EACCES), while an unchanged one (the app always sends syncDir) is ignored and the
// rest is saved. Those changes are made by POST /drive/settings on the user-only control socket. Answers 200 { ok:
// true, settings, virtualDriveWanted, vfs, folderError, switchError }: ok means the other settings were saved. 400 for
// a malformed body, 500 when the settings themselves can't be saved.
export async function settingsRoute(req: Request, deps: SettingsRouteDeps): Promise<Response> {
    const { stateDb, engine } = deps;
    try {
        const prev = stateDb.getSettings();
        const { virtualDriveWanted: wanted, syncDir, ...body } = (await req.json()) as Record<string, unknown>;
        if (wanted !== undefined && typeof wanted !== 'boolean') {
            return Response.json({ error: 'virtualDriveWanted must be true or false' }, { status: 400 });
        }
        stateDb.updateSettings(body);
        if (JSON.stringify(prev.ignorePatterns) !== JSON.stringify(stateDb.getSettings().ignorePatterns)) {
            void engine.reconcileNow();
        }
        const change = await changeDrive({ syncDir, wanted }, deps, false);
        return answer(deps, change, change.folderError !== null || change.switchError !== null);
    } catch (error: unknown) {
        return Response.json({ error: messageOf(error) }, { status: 500 });
    }
}

// POST /drive/settings {syncDir?, virtualDriveWanted?} (the user-only control socket, via startControlServer): changes
// the drive folder and the virtual drive switch, which move the user's files. Answers as settingsRoute does, 200 with
// folderError / switchError null or why; the caller has checked the body.
export async function driveSettings(change: { syncDir?: string; virtualDriveWanted?: boolean }, deps: SettingsRouteDeps): Promise<Response> {
    try {
        return answer(deps, await changeDrive({ syncDir: change.syncDir, wanted: change.virtualDriveWanted }, deps, true), false);
    } catch (error: unknown) {
        return Response.json({ error: messageOf(error), code: 'EIO' }, { status: 500 });
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
