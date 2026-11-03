import type { AvailabilityPolicy, ItemAvailability } from '../sync/availability';

// What the app's My files shows for each item of a folder: its availability, worked out per response (never cached,
// so a cached listing still shows the current state), in a fixed number of queries for the whole folder (#83). An item
// the remote index doesn't hold (a Proton Docs document, #48) is asked about on its own.
export function withAvailability<T extends { name: string }>(
    policy: Pick<AvailabilityPolicy, 'childStates' | 'stateOf'>,
    remotePath: string,
    items: T[],
): Array<T | (T & { availability: ItemAvailability })> {
    if (remotePath !== '/my-files' && !remotePath.startsWith('/my-files/')) {
        return items;
    }
    const relDir = remotePath.replace(/^\/my-files\/?/, '').replace(/^\/+|\/+$/g, '');
    const states = policy.childStates(relDir);
    return items.map((item) => ({
        ...item,
        availability: states.get(item.name) ?? policy.stateOf(relDir ? `${relDir}/${item.name}` : item.name),
    }));
}
