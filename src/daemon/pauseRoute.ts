// The longest a timed pause may run: a time further ahead is refused (#205)
export const MAX_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;

// POST /api/pause { paused, until? }: until (epoch ms, a whole number) is taken only with paused: true, and only in the
// future and at most MAX_PAUSE_MS ahead; anything else is 400 { error } and nothing changes. No until (or null) pauses
// until resumed; paused: false resumes and clears any time.
export async function pauseRoute(
    body: unknown,
    engine: { setPaused(paused: boolean, until?: number | null): Promise<void>; getStatus(): unknown },
    now: number,
): Promise<Response> {
    const req = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { paused?: unknown; until?: unknown };
    const paused = Boolean(req.paused);
    const until = req.until ?? null;
    if (until !== null) {
        const refuse = (error: string) => Response.json({ error }, { status: 400 });
        if (!paused) {
            return refuse('A pause end time is only taken with paused: true');
        }
        if (typeof until !== 'number' || !Number.isSafeInteger(until)) {
            return refuse('until must be a time in milliseconds since 1970');
        }
        if (until <= now) {
            return refuse('until must be in the future');
        }
        if (until > now + MAX_PAUSE_MS) {
            return refuse('A pause can last at most 7 days');
        }
    }
    await engine.setPaused(paused, paused ? (until as number | null) : null);
    return Response.json({ ok: true, status: engine.getStatus() });
}
