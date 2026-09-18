import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate } from "ai";

const JEV_MODEL = "typesafe-ai/jev";
const MAX_UPSTREAM_BODY_BYTES = 256 * 1024;
const NETWORK_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

export class JevRequestError extends Error {
    constructor(code) {
        super(code);
        this.name = "JevRequestError";
        this.code = code;
    }
}

function coordinateLabel(row, column) {
    return `${String.fromCharCode(65 + row)}${column + 1}`;
}

function sortCoordinates(coordinates) {
    return [...coordinates].sort((left, right) => (
        left.row - right.row || left.column - right.column
    ));
}

export function buildEvaluationRequest(board) {
    const candidates = sortCoordinates(board.unopened);
    const questions = {};

    for (const candidate of candidates) {
        const key = `cell_${candidate.row}_${candidate.column}`;
        const label = coordinateLabel(candidate.row, candidate.column);
        questions[key] = {
            type: "boolean",
            instructions: `Does the unopened Minesweeper cell at coordinate ${label} contain a mine?`,
        };
    }

    return {
        candidates,
        state: {
            task: "Estimate each unopened candidate's mine probability from the public Minesweeper board.",
            rules: [
                "The board follows standard Minesweeper rules with eight-direction adjacency.",
                "Each revealed number is the exact count of adjacent mines.",
                "Flagged cells are user hypotheses and can be wrong.",
                "Unopened cells have no revealed value.",
            ],
            board: {
                rows: board.size,
                columns: board.size,
                totalMines: board.totalMines,
                revealed: board.revealed.map((cell) => ({
                    coordinate: coordinateLabel(cell.row, cell.column),
                    adjacentMines: cell.neighborMines,
                })),
                unopened: candidates.map((cell) => coordinateLabel(cell.row, cell.column)),
                flags: sortCoordinates(board.flags).map((cell) => coordinateLabel(cell.row, cell.column)),
            },
        },
        questions,
    };
}

export function parseEvaluationResponse(payload, candidates) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new JevRequestError("malformed_response");
    }

    if (!payload.answers || typeof payload.answers !== "object" || Array.isArray(payload.answers)) {
        throw new JevRequestError("malformed_response");
    }

    const expectedKeys = candidates.map((candidate) => `cell_${candidate.row}_${candidate.column}`);
    if (
        Object.keys(payload.answers).length !== expectedKeys.length
        || expectedKeys.some((key) => !Object.hasOwn(payload.answers, key))
    ) {
        throw new JevRequestError("malformed_response");
    }

    const probabilities = candidates.map((candidate) => {
        const key = `cell_${candidate.row}_${candidate.column}`;
        const answer = payload.answers[key];

        if (
            !answer
            || typeof answer !== "object"
            || answer.type !== "boolean"
            || !Number.isFinite(answer.probability)
            || answer.probability < 0
            || answer.probability > 1
        ) {
            throw new JevRequestError("malformed_response");
        }

        return {
            ...candidate,
            coordinate: coordinateLabel(candidate.row, candidate.column),
            probability: answer.probability,
        };
    });

    if (probabilities.length === 0) {
        throw new JevRequestError("no_candidates");
    }

    return probabilities.reduce((best, candidate) => (
        candidate.probability < best.probability ? candidate : best
    ));
}

async function bufferLimitedResponse(response, signal) {
    if (!response.body) {
        return response;
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_BODY_BYTES) {
        await response.body.cancel();
        throw new JevRequestError("malformed_response");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let cancelPromise;
    let handleAbort;
    const abortPromise = signal && new Promise((resolve, reject) => {
        handleAbort = () => {
            const reason = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
            cancelPromise = reader.cancel(reason);
            reject(reason);
        };

        if (signal.aborted) {
            handleAbort();
        } else {
            signal.addEventListener("abort", handleAbort, { once: true });
        }
    });

    try {
        while (true) {
            const readResult = abortPromise
                ? await Promise.race([reader.read(), abortPromise])
                : await reader.read();
            if (readResult.done) {
                break;
            }

            size += readResult.value.byteLength;
            if (size > MAX_UPSTREAM_BODY_BYTES) {
                await reader.cancel();
                throw new JevRequestError("malformed_response");
            }
            chunks.push(readResult.value);
        }
    } finally {
        if (handleAbort) {
            signal.removeEventListener("abort", handleAbort);
        }
        await cancelPromise?.catch(() => {});
        reader.releaseLock();
    }

    return new Response(Buffer.concat(chunks, size), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

function createLimitedFetch(fetchImpl) {
    return async (url, options = {}) => {
        const response = await fetchImpl(url, options);
        return bufferLimitedResponse(response, options.signal);
    };
}

function errorChain(error) {
    const chain = [];
    const seen = new Set();
    let current = error;

    while (current && typeof current === "object" && !seen.has(current)) {
        chain.push(current);
        seen.add(current);
        current = current.cause;
    }

    return chain;
}

function mapEvaluationError(error, { signal, timedOut }) {
    const chain = errorChain(error);
    const knownError = chain.find((current) => current instanceof JevRequestError);
    if (knownError) {
        return knownError;
    }
    if (timedOut) {
        return new JevRequestError("timeout");
    }
    if (signal?.aborted) {
        return new JevRequestError("client_cancelled");
    }

    const statusCode = chain.find((current) => Number.isInteger(current.statusCode))?.statusCode;
    if (statusCode === 401 || statusCode === 403) {
        return new JevRequestError("unauthorized");
    }
    if (statusCode === 402) {
        return new JevRequestError("payment_required");
    }
    if (statusCode === 429) {
        return new JevRequestError("rate_limited");
    }
    if (
        statusCode === 200
        || chain.some((current) => current.name === "AI_InvalidResponseDataError")
    ) {
        return new JevRequestError("malformed_response");
    }

    const isNetworkError = chain.some((current) => (
        current instanceof TypeError
        || (typeof current.code === "string" && NETWORK_ERROR_CODES.has(current.code))
        || (current.name === "AI_APICallError" && current.statusCode === undefined)
    ));
    return new JevRequestError(isNetworkError ? "network_error" : "upstream_error");
}

export async function evaluateBoard(board, {
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    signal,
} = {}) {
    const { state, questions, candidates } = buildEvaluationRequest(board);
    if (candidates.length === 0) {
        throw new JevRequestError("no_candidates");
    }

    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
    }, timeoutMs);
    timeout.unref?.();

    const handleExternalAbort = () => abortController.abort();
    if (signal?.aborted) {
        abortController.abort();
    } else {
        signal?.addEventListener("abort", handleExternalAbort, { once: true });
    }

    try {
        const gateway = createGateway({
            apiKey,
            fetch: createLimitedFetch(fetchImpl),
        });
        const result = await experimental_evaluate({
            model: gateway.evaluationModel(JEV_MODEL),
            state,
            questions,
            providerOptions: {},
            maxRetries: 0,
            abortSignal: abortController.signal,
        });
        return parseEvaluationResponse(result, candidates);
    } catch (error) {
        throw mapEvaluationError(error, { signal, timedOut });
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", handleExternalAbort);
    }
}
