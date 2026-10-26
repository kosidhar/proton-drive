import { virtualDriveWanted } from '../sync/driveMode';
import type { ProtonDriveSyncEngine } from '../sync/syncEngine';
import type { SyncStateDatabase } from '../sync/syncStateDb';
import type { DriveController } from './driveController';

export interface SettingsRouteDeps {
    stateDb: SyncStateDatabase;
    drive: Pick<DriveController, 'relocate' | 'setVirtualDriveWanted' | 'status'>;
    engine: Pick<ProtonDriveSyncEngine, 'reconcileNow'>;
}

// POST /api/settings: saves the settings given. The sync folder changes only by moving there (or, for the drive,
// mounting there): every syncDir given goes to the drive, which does nothing for the folder it already is, however it
// is written, unless a move to another one stopped (that folder then means moving back, the other one finishing).
// virtualDriveWanted moves the files when it changes. A failure answers 500 with the error.
export async function settingsRoute(req: Request, deps: SettingsRouteDeps): Promise<Response> {
    const { stateDb, drive, engine } = deps;
    try {
        const prev = stateDb.getSettings();
        const { virtualDriveWanted: wanted, syncDir, ...body } = (await req.json()) as Record<string, unknown>;
        if (wanted !== undefined && typeof wanted !== 'boolean') {
            return Response.json({ error: 'virtualDriveWanted must be true or false' }, { status: 400 });
        }
        if (typeof syncDir === 'string' && syncDir.trim()) {
            body.syncDir = await drive.relocate(syncDir.trim());
        }
        const updated = stateDb.updateSettings(body);
        if (prev.syncDir !== updated.syncDir || JSON.stringify(prev.ignorePatterns) !== JSON.stringify(updated.ignorePatterns)) {
            void engine.reconcileNow();
        }
        // Moves the files, and throws when that fails
        if (typeof wanted === 'boolean' && wanted !== virtualDriveWanted(stateDb)) {
            await drive.setVirtualDriveWanted(wanted);
        }
        return Response.json({
            ok: true,
            settings: stateDb.getSettings(),
            virtualDriveWanted: virtualDriveWanted(stateDb),
            vfs: drive.status(),
        });
    } catch (error: unknown) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
}
