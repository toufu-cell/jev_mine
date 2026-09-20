import test from "node:test";
import assert from "node:assert/strict";
import {
    buildEvaluationRequest,
    evaluateBoard,
    JevRequestError,
} from "../src/jev.js";

const board = {
    size: 9,
    totalMines: 10,
    revealed: [{ row: 4, column: 4, neighborMines: 1 }],
    unopened: [
        { row: 0, column: 1 },
        { row: 0, column: 0 },
    ],
    flags: [{ row: 8, column: 8 }],
};

function upstreamError(status) {
    return new Response(JSON.stringify({
        error: {
            message: "raw upstream error",
        },
    }), { status });
}

test("公開情報とnoul質問をTypeSafeへ1回だけ送る", async () => {
    const testBoard = {
        ...board,
        unopened: [...board.unopened, { row: 0, column: 2 }],
    };
    const request = buildEvaluationRequest(testBoard);
    const serializedState = JSON.stringify(request.state);
    let upstreamCalls = 0;
    let capturedBody;
    let capturedHeaders;
    let capturedUrl;
    let capturedOptions;

    const candidate = await evaluateBoard(testBoard, {
        apiKey: "test-secret",
        fetchImpl: async (url, options) => {
            upstreamCalls += 1;
            capturedUrl = url;
            capturedOptions = options;
            capturedHeaders = new Headers(options.headers);
            capturedBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                answers: {
                    cell_0_0: { type: "noul", noul: 0.2 },
                    cell_0_1: { type: "noul", noul: 0.2 },
                    cell_0_2: { type: "noul", noul: 0.8 },
                },
            }), { status: 200, headers: { "content-type": "application/json" } });
        },
    });

    assert.deepEqual(request.state.board.revealed, [{ coordinate: "E5", adjacentMines: 1 }]);
    assert.deepEqual(request.state.board.flags, ["I9"]);
    assert.match(request.questions.cell_0_0.instructions, /A1/);
    assert.equal(request.questions.cell_0_0.type, "noul");
    assert.equal(serializedState.includes("mineLocations"), false);
    assert.equal(serializedState.includes("neighborMines"), false);
    assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
    assert.equal(capturedOptions.method, "POST");
    assert.equal(capturedOptions.redirect, "error");
    assert.equal(capturedHeaders.get("authorization"), "Bearer test-secret");
    assert.equal(capturedHeaders.get("content-type"), "application/json");
    assert.deepEqual(Object.keys(capturedBody).sort(), ["model", "questions", "state"]);
    assert.equal(capturedBody.model, "jev-latest");
    assert.deepEqual(capturedBody.state, request.state);
    assert.deepEqual(capturedBody.questions, request.questions);
    assert.deepEqual(candidate, { row: 0, column: 0, coordinate: "A1", probability: 0.2 });
    assert.equal(upstreamCalls, 1);
});

test("全候補の欠落、型違い、範囲外、余分な回答と256 KiB超過を拒否する", async () => {
    const invalidResponses = [
        () => new Response(JSON.stringify({
            answers: {
                cell_0_0: { type: "noul", noul: 0.1 },
            },
        }), { status: 200 }),
        () => new Response(JSON.stringify({
            answers: {
                cell_0_0: { type: "choice", choice: "safe" },
                cell_0_1: { type: "noul", noul: 0.2 },
            },
        }), { status: 200 }),
        () => new Response(JSON.stringify({
            answers: {
                cell_0_0: { type: "noul", noul: -0.1 },
                cell_0_1: { type: "noul", noul: 0.2 },
            },
        }), { status: 200 }),
        () => new Response(JSON.stringify({
            answers: {
                cell_0_0: { type: "noul", noul: 1.1 },
                cell_0_1: { type: "noul", noul: 0.2 },
            },
        }), { status: 200 }),
        () => new Response(JSON.stringify({
            answers: {
                cell_0_0: { type: "noul", noul: "0.1" },
                cell_0_1: { type: "noul", noul: 0.2 },
            },
        }), { status: 200 }),
        () => new Response(JSON.stringify({
            answers: {
                cell_0_0: { type: "noul", noul: 0.1 },
                cell_0_1: { type: "noul", noul: 0.2 },
                cell_8_8: { type: "noul", noul: 0.3 },
            },
        }), { status: 200 }),
        () => new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
    ];

    for (const createResponse of invalidResponses) {
        let upstreamCalls = 0;
        await assert.rejects(
            evaluateBoard(board, {
                apiKey: "test-secret",
                fetchImpl: async () => {
                    upstreamCalls += 1;
                    return createResponse();
                },
            }),
            (error) => error instanceof JevRequestError && error.code === "malformed_response",
        );
        assert.equal(upstreamCalls, 1);
    }
});

test("HTTP statusで認証、支払い、利用上限、上流エラーを区別し、再試行しない", async () => {
    const cases = [
        { status: 401, expected: "unauthorized" },
        { status: 403, expected: "unauthorized" },
        { status: 402, expected: "payment_required" },
        { status: 422, expected: "upstream_error" },
        { status: 429, expected: "rate_limited" },
        { status: 529, expected: "upstream_error" },
    ];

    for (const fixture of cases) {
        let upstreamCalls = 0;
        await assert.rejects(
            evaluateBoard(board, {
                apiKey: "test-secret",
                fetchImpl: async () => {
                    upstreamCalls += 1;
                    return upstreamError(fixture.status);
                },
            }),
            (error) => error instanceof JevRequestError && error.code === fixture.expected,
        );
        assert.equal(upstreamCalls, 1);
    }
});

test("応答本文の待機中もタイムアウトとクライアント取消を反映する", async () => {
    let timeoutBodyCancelled = false;
    await assert.rejects(
        evaluateBoard(board, {
            apiKey: "test-secret",
            fetchImpl: async () => new Response(new ReadableStream({
                cancel() {
                    timeoutBodyCancelled = true;
                },
            })),
            timeoutMs: 5,
        }),
        (error) => error instanceof JevRequestError && error.code === "timeout",
    );
    assert.equal(timeoutBodyCancelled, true);

    let markResponseStarted;
    let cancelledBody = false;
    const responseStarted = new Promise((resolve) => {
        markResponseStarted = resolve;
    });
    const abortController = new AbortController();
    const evaluation = evaluateBoard(board, {
        apiKey: "test-secret",
        signal: abortController.signal,
        fetchImpl: async () => {
            markResponseStarted();
            return new Response(new ReadableStream({
                cancel() {
                    cancelledBody = true;
                },
            }));
        },
    });
    await responseStarted;
    abortController.abort();

    await assert.rejects(
        evaluation,
        (error) => error instanceof JevRequestError && error.code === "client_cancelled",
    );
    assert.equal(cancelledBody, true);
});
