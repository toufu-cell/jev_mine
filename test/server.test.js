import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../src/server.js";

async function startServer(options = {}) {
    const server = createApp(options);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    return {
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
    };
}

async function closeServer(server) {
    server.close();
    await once(server, "close");
}

function makeBoard() {
    const revealed = [{ row: 4, column: 4, neighborMines: 0 }];
    const unopened = [];
    for (let row = 0; row < 9; row += 1) {
        for (let column = 0; column < 9; column += 1) {
            if (row !== 4 || column !== 4) {
                unopened.push({ row, column });
            }
        }
    }
    return { size: 9, totalMines: 10, revealed, unopened, flags: [] };
}

function requestWithHost({
    port,
    host,
    origin,
    path = "/api/config",
    method = "GET",
    headers = {},
    body,
}) {
    return new Promise((resolve, reject) => {
        const requestHeaders = { host, ...headers };
        if (origin !== undefined) {
            requestHeaders.origin = origin;
        }
        const request = httpRequest({
            hostname: "127.0.0.1",
            port,
            path,
            method,
            headers: requestHeaders,
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
            }));
        });
        request.on("error", reject);
        request.end(body);
    });
}

function successfulJevResponse(options) {
    const requestBody = JSON.parse(options.body);
    const answers = Object.fromEntries(
        Object.keys(requestBody.questions).map((key) => [key, { type: "boolean", probability: 0.1 }]),
    );
    return new Response(JSON.stringify({ answers }), { status: 200 });
}

function gatewayErrorResponse(status, type, message) {
    return new Response(JSON.stringify({
        error: { type, message },
    }), { status });
}

function postInference(fixture, { signal } = {}) {
    return fetch(`${fixture.origin}/api/infer`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: fixture.origin,
            "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(makeBoard()),
        signal,
    });
}

test("キー未設定でも画面を配信し、Jev操作だけを無効と通知する", async (context) => {
    const fixture = await startServer();
    context.after(() => closeServer(fixture.server));

    const [pageResponse, configResponse, turnPolicyResponse, appResponse, inferenceResponse] = await Promise.all([
        requestWithHost({
            port: fixture.port,
            host: `127.0.0.1:${fixture.port}`,
            path: "/",
            headers: {
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            },
        }),
        fetch(`${fixture.origin}/api/config`),
        fetch(`${fixture.origin}/turn-policy.js`),
        fetch(`${fixture.origin}/app.js`),
        postInference(fixture),
    ]);

    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.body, /Jevマインスイーパー/);
    assert.deepEqual(await configResponse.json(), { jevAvailable: false });
    assert.equal(turnPolicyResponse.status, 200);
    assert.match(await appResponse.text(), /\.envにAI_GATEWAY_API_KEY/);
    assert.equal(inferenceResponse.status, 503);
    assert.deepEqual(await inferenceResponse.json(), {
        error: "jev_not_configured",
        message: "AI_GATEWAY_API_KEYを設定するとJev操作を利用できます。",
    });
});

test("公開アセット以外と不正なHostや推論元を拒否する", async (context) => {
    const fixture = await startServer();
    context.after(() => closeServer(fixture.server));

    const privateResponse = await fetch(`${fixture.origin}/src/server.js`);
    const badHost = await requestWithHost({
        port: fixture.port,
        host: `evil.example:${fixture.port}`,
        origin: fixture.origin,
    });
    const badOrigin = await requestWithHost({
        port: fixture.port,
        host: `127.0.0.1:${fixture.port}`,
        origin: "http://evil.example",
        path: "/api/infer",
        method: "POST",
        headers: {
            "content-type": "application/json",
            "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify(makeBoard()),
    });

    assert.equal(privateResponse.status, 404);
    assert.equal(badHost.status, 403);
    assert.equal(badOrigin.status, 403);
});

test("同時推論を1件に制限し、完了後に次の推論を受け付ける", async (context) => {
    let upstreamCalls = 0;
    let markStarted;
    let releaseFirst;
    const started = new Promise((resolve) => {
        markStarted = resolve;
    });
    const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
    });
    const fixture = await startServer({
        apiKey: "server-secret",
        fetchImpl: async (_url, options) => {
            upstreamCalls += 1;
            markStarted();
            await firstGate;
            return successfulJevResponse(options);
        },
    });
    context.after(() => closeServer(fixture.server));

    const firstRequest = postInference(fixture);
    await started;
    const concurrentResponse = await postInference(fixture);

    assert.equal(concurrentResponse.status, 409);
    assert.equal(upstreamCalls, 1);

    releaseFirst();
    assert.equal((await firstRequest).status, 200);
    assert.equal((await postInference(fixture)).status, 200);
    assert.equal(upstreamCalls, 2);
});

test("不正な盤面と大きすぎるbodyをJevへ送らない", async (context) => {
    let upstreamCalls = 0;
    const fixture = await startServer({
        apiKey: "server-secret",
        fetchImpl: async () => {
            upstreamCalls += 1;
            return new Response("{}", { status: 200 });
        },
    });
    context.after(() => closeServer(fixture.server));

    const invalidResponse = await fetch(`${fixture.origin}/api/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ size: 9 }),
    });
    const largeResponse = await fetch(`${fixture.origin}/api/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
    });

    assert.equal(invalidResponse.status, 400);
    assert.equal(largeResponse.status, 413);
    assert.equal(upstreamCalls, 0);
});

test("Gatewayエラーを固定文へ変換し、APIキーや生のエラーを返さない", async (context) => {
    const secret = "server-secret-do-not-leak";
    const rawMessage = `raw upstream error: ${secret}`;
    const cases = [
        {
            response: () => gatewayErrorResponse(401, "authentication_error", rawMessage),
            status: 502,
            body: {
                error: "jev_unauthorized",
                message: "Vercel AI Gatewayの認証に失敗しました。AI_GATEWAY_API_KEYを確認してください。",
            },
        },
        {
            response: () => gatewayErrorResponse(403, "forbidden", rawMessage),
            status: 502,
            body: {
                error: "jev_unauthorized",
                message: "Vercel AI Gatewayの認証に失敗しました。AI_GATEWAY_API_KEYを確認してください。",
            },
        },
        {
            response: () => gatewayErrorResponse(402, "invalid_request_error", rawMessage),
            status: 402,
            body: {
                error: "jev_payment_required",
                message: "Vercel AI Gatewayの残高が不足しています。",
            },
        },
        {
            response: () => gatewayErrorResponse(429, "rate_limit_exceeded", rawMessage),
            status: 503,
            body: {
                error: "jev_rate_limited",
                message: "Vercel AI Gatewayの利用上限に達しました。時間を置いて再試行してください。",
            },
        },
        {
            response: () => new Response(JSON.stringify({
                internal: secret,
                answers: {},
            }), { status: 200 }),
            status: 502,
            body: {
                error: "jev_malformed_response",
                message: "Jevの応答形式を確認できませんでした。",
            },
        },
    ];
    let upstreamCalls = 0;
    const fixture = await startServer({
        apiKey: secret,
        fetchImpl: async () => {
            const fixtureCase = cases[upstreamCalls];
            upstreamCalls += 1;
            return fixtureCase.response();
        },
    });
    context.after(() => closeServer(fixture.server));

    const publicBodies = [];
    for (const fixtureCase of cases) {
        const response = await postInference(fixture);
        const body = await response.json();
        assert.equal(response.status, fixtureCase.status);
        assert.deepEqual(body, fixtureCase.body);
        publicBodies.push(JSON.stringify(body));
    }

    const [configBody, clientBody] = await Promise.all([
        fetch(`${fixture.origin}/api/config`).then((clientResponse) => clientResponse.text()),
        fetch(`${fixture.origin}/app.js`).then((clientResponse) => clientResponse.text()),
    ]);

    assert.equal(`${publicBodies.join("")}${configBody}${clientBody}`.includes(secret), false);
    assert.equal(`${publicBodies.join("")}${configBody}${clientBody}`.includes(rawMessage), false);
    assert.match(clientBody, /AI_GATEWAY_API_KEY/);
    assert.equal(upstreamCalls, cases.length);
});

test("クライアントの停止後に排他を解放する", async (context) => {
    let upstreamCalls = 0;
    let markStarted;
    let markCancelled;
    const started = new Promise((resolve) => {
        markStarted = resolve;
    });
    const cancelled = new Promise((resolve) => {
        markCancelled = resolve;
    });
    const fixture = await startServer({
        apiKey: "server-secret",
        fetchImpl: async (_url, options) => {
            upstreamCalls += 1;
            if (upstreamCalls > 1) {
                return successfulJevResponse(options);
            }

            markStarted();
            return new Promise((resolve, reject) => {
                options.signal.addEventListener("abort", () => {
                    markCancelled();
                    reject(options.signal.reason);
                }, { once: true });
            });
        },
    });
    context.after(() => closeServer(fixture.server));

    const abortController = new AbortController();
    const firstRequest = postInference(fixture, { signal: abortController.signal });
    await started;
    abortController.abort();
    await assert.rejects(firstRequest, (error) => error.name === "AbortError");
    await cancelled;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((await postInference(fixture)).status, 200);
    assert.equal(upstreamCalls, 2);
});
