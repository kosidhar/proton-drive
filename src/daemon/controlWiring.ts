import { applyStartAtLogin } from '../linux/autostart';
import type { ProtonDriveSyncEngine } from '../sync/syncEngine';
import type { SyncStateDatabase } from '../sync/syncStateDb';
import type { ControlServerOptions } from './controlServer';
import type { DriveController } from './driveController';
import { driveSettings } from './settingsRoute';

// What the daemon gives the control socket: the routes that change things, reachable only there, never through the
// TCP API. Kept apart from startSyncDaemon so that a test can check what each route reaches.
export function controlServerOptions(deps: {
    socketPath: string;
    engine: ControlServerOptions['engine'] &
        Pick<
            ProtonDriveSyncEngine,
            | 'resolveConflictManually'
            | 'reconcileNow'
            | 'confirmFilesMissingDeleted'
            | 'keepFilesMissingOnlineOnly'
            | 'itemStates'
            | 'stateEvents'
        >;
    drive: Pick<DriveController, 'mountAgain' | 'resolveMove' | 'relocate' | 'setVirtualDriveWanted' | 'status'>;
    stateDb: SyncStateDatabase;
    signIn: NonNullable<ControlServerOptions['login']>;
    signOut: NonNullable<ControlServerOptions['logout']>;
    makeRemoteFolder: NonNullable<ControlServerOptions['remoteMkdir']>;
    space?: ControlServerOptions['space'];
}): ControlServerOptions {
    const { socketPath, engine, drive, stateDb } = deps;
    return {
        socketPath,
        engine,
        mountAgain: () => drive.mountAgain(),
        space: deps.space,
        driveMove: (action, from, to) => drive.resolveMove(action, from, to),
        driveSettings: (change) => driveSettings(change, { stateDb, drive, engine, applyStartAtLogin: (on) => applyStartAtLogin(on) }),
        login: deps.signIn,
        logout: deps.signOut,
        resolveConflict: (id, choice) => engine.resolveConflictManually(id, choice),
        // Only the exact delete action reaches the delete: an action not wired here reaches nothing
        resolveFilesMissing: async (action, expected) => {
            switch (action) {
                case 'delete-in-cloud':
                    return engine.confirmFilesMissingDeleted(expected);
                case 'keep-online-only':
                    return engine.keepFilesMissingOnlineOnly(expected);
                default: {
                    const unknown: never = action;
                    throw new Error(`Unknown action: ${String(unknown)}`);
                }
            }
        },
        remoteMkdir: deps.makeRemoteFolder,
        fileManager: {
            root: () => {
                const { mode, mounted } = drive.status();
                return { syncDir: stateDb.getSettings().syncDir, mode, mounted };
            },
            states: (relPath) => engine.itemStates(relPath),
            events: engine.stateEvents,
        },
    };
}
