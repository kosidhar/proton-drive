import { autostartEntryPath, syncLoginEntry } from '../linux/autostart';
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
            | 'startFreshForThisAccount'
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
    share?: ControlServerOptions['share'];
    sharedWithMe?: ControlServerOptions['sharedWithMe'];
    shareSignedIn?: ControlServerOptions['shareSignedIn'];
    shareLog?: ControlServerOptions['shareLog'];
}): ControlServerOptions {
    const { socketPath, engine, drive, stateDb } = deps;
    return {
        socketPath,
        engine,
        mountAgain: () => drive.mountAgain(),
        space: deps.space,
        share: deps.share,
        sharedWithMe: deps.sharedWithMe,
        shareSignedIn: deps.shareSignedIn,
        shareLog: deps.shareLog,
        driveMove: (action, from, to) => drive.resolveMove(action, from, to),
        driveSettings: (change) =>
            driveSettings(change, {
                stateDb,
                drive,
                engine,
                // The setting as just saved, which wins over what the entry says (#92)
                applyStartAtLogin: () => {
                    const result = syncLoginEntry(stateDb, { explicit: true });
                    if (result === 'unsupported') throw new Error('Proton Drive can not start itself at login from inside Flatpak');
                    if (result === 'not-ours') {
                        throw new Error(`${autostartEntryPath()} is your own entry: Proton Drive leaves it alone`);
                    }
                },
            }),
        login: deps.signIn,
        logout: deps.signOut,
        resolveConflict: (id, choice) => engine.resolveConflictManually(id, choice),
        // Then the first sync with this account, as a fresh install's (#35)
        startFresh: async () => {
            await engine.startFreshForThisAccount();
            void engine.reconcileNow();
        },
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
