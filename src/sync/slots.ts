// At most `size` tasks at once; the rest wait their turn, first come first served. A slot freed goes straight to the
// next task waiting, so the limit holds however the tasks interleave.
export class Slots {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly size: number) {
        if (!Number.isInteger(size) || size < 1) {
            throw new Error(`Slots needs a size of at least 1, not ${size}`);
        }
    }

    get running(): number {
        return this.active;
    }

    get queued(): number {
        return this.waiting.length;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active < this.size) {
            this.active++;
        } else {
            await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over, already counted
        }
        try {
            return await task();
        } finally {
            const next = this.waiting.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
    }
}
