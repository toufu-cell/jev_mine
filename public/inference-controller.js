export function createInferenceController({ request, onBusyChange = () => {} }) {
    if (typeof request !== "function") {
        throw new TypeError("推論リクエスト関数を指定してください。");
    }

    let generation = 0;
    let pending = null;

    async function run(payload) {
        if (pending) {
            return { status: "busy" };
        }

        const requestGeneration = generation;
        const abortController = new AbortController();
        const current = { abortController, generation: requestGeneration };
        pending = current;
        onBusyChange(true);

        try {
            const value = await request(payload, { signal: abortController.signal });
            if (generation !== requestGeneration || pending !== current) {
                return { status: "stale" };
            }

            return { status: "ok", value };
        } catch (error) {
            if (generation !== requestGeneration || pending !== current) {
                return { status: "stale" };
            }

            return { status: "error", error };
        } finally {
            if (pending === current) {
                pending = null;
                onBusyChange(false);
            }
        }
    }

    function invalidate() {
        generation += 1;

        if (pending) {
            const current = pending;
            pending = null;
            current.abortController.abort();
            onBusyChange(false);
        }
    }

    return {
        run,
        invalidate,
        isBusy: () => pending !== null,
    };
}
