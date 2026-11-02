// What changed in the drive, for the file manager's emblems: the paths whose state may have changed (each with its
// ancestors, since a folder's emblem sums up what is inside it), and the subtrees where everything may have. Changes
// are coalesced: the first one starts a short timer, and all that come in until it fires go out together.

export interface StateChange {
    paths: string[]; // relative to the drive root; '' is the root
    subtrees: string[];
}

export type StateListener = (change: StateChange | 'reset') => void;

type Schedule = (run: () => void, delayMs: number) => () => void;

const DEFAULT_DELAY_MS = 250;
const DEFAULT_MAX_PATHS = 2000;

const realSchedule: Schedule = (run, delayMs) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
};

// Paths the index uses for a moment while it moves nodes (they start with U+0001) are never real
function isInternal(relPath: string): boolean {
    return relPath.startsWith('\u0001');
}

function ancestorsAndSelf(relPath: string): string[] {
    const out = [''];
    if (relPath === '') {
        return out;
    }
    const parts = relPath.split('/');
    for (let i = 1; i <= parts.length; i++) {
        out.push(parts.slice(0, i).join('/'));
    }
    return out;
}

function isWithin(relPath: string, root: string): boolean {
    return root === '' || relPath === root || relPath.startsWith(`${root}/`);
}

export class StateEvents {
    private readonly delayMs: number;
    private readonly maxPaths: number;
    private readonly schedule: Schedule;
    private paths = new Set<string>();
    private subtrees = new Set<string>();
    private resetPending = false;
    private cancel: (() => void) | null = null;
    private listeners = new Set<StateListener>();

    constructor(opts: { delayMs?: number; maxPaths?: number; schedule?: Schedule } = {}) {
        this.delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
        this.maxPaths = opts.maxPaths ?? DEFAULT_MAX_PATHS;
        this.schedule = opts.schedule ?? realSchedule;
    }

    touch(relPath: string): void {
        if (isInternal(relPath)) {
            return;
        }
        for (const p of ancestorsAndSelf(relPath)) {
            this.paths.add(p);
        }
        this.arm();
    }

    touchSubtree(relPath: string): void {
        if (isInternal(relPath)) {
            return;
        }
        this.touch(relPath);
        this.subtrees.add(relPath);
    }

    reset(): void {
        this.resetPending = true;
        this.arm();
    }

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    get listenerCount(): number {
        return this.listeners.size;
    }

    stop(): void {
        this.cancel?.();
        this.cancel = null;
        this.paths.clear();
        this.subtrees.clear();
        this.resetPending = false;
    }

    private arm(): void {
        if (this.cancel || this.listeners.size === 0) {
            if (this.listeners.size === 0) {
                // Nobody listens: nothing to keep
                this.paths.clear();
                this.subtrees.clear();
                this.resetPending = false;
            }
            return;
        }
        this.cancel = this.schedule(() => this.flush(), this.delayMs);
    }

    private flush(): void {
        this.cancel = null;
        const change = this.take();
        for (const listener of [...this.listeners]) {
            try {
                listener(change);
            } catch {
                this.listeners.delete(listener);
            }
        }
    }

    private take(): StateChange | 'reset' {
        const reset = this.resetPending;
        const subtrees = [...this.subtrees].sort();
        // A subtree swallows the subtrees below it, and the paths below it (but not its ancestors)
        const topSubtrees = subtrees.filter((s) => !subtrees.some((other) => other !== s && isWithin(s, other)));
        const paths = [...this.paths]
            .filter((p) => !topSubtrees.some((s) => p !== s && isWithin(p, s)))
            .sort();
        this.paths.clear();
        this.subtrees.clear();
        this.resetPending = false;
        if (reset || paths.length + topSubtrees.length > this.maxPaths) {
            return 'reset';
        }
        return { paths, subtrees: topSubtrees };
    }
}
