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
        Pick<ProtonDriveSyncEngine, 'resolveConflictManually' | 'reconcileNow' | 'confirmFilesMissingDeleted'>;
    drive: Pick<DriveController, 'mountAgain' | 'resolveMove' | 'relocate' | 'setVirtualDriveWanted' | 'status'>;
    stateDb: SyncStateDatabase;
    signIn: NonNullable<ControlServerOptions['login']>;
    signOut: NonNullable<ControlServerOptions['logout']>;
    makeRemoteFolder: NonNullable<ControlServerOptions['remoteMkdir']>;
}): ControlServerOptions {
    const { socketPath, engine, drive, stateDb } = deps;
    return {
        socketPath,
        engine,
        mountAgain: () => drive.mountAgain(),
        driveMove: (action, from, to) => drive.resolveMove(action, from, to),
        driveSettings: (change) => driveSettings(change, { stateDb, drive, engine }),
        login: deps.signIn,
        logout: deps.signOut,
        resolveConflict: (id, choice) => engine.resolveConflictManually(id, choice),
        confirmFilesMissingDeleted: (expected) => engine.confirmFilesMissingDeleted(expected),
        remoteMkdir: deps.makeRemoteFolder,
    };
}
