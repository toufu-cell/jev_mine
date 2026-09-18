import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateBoard, JevRequestError } from "./jev.js";

const DEFAULT_PORT = 3000;
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const PUBLIC_DIRECTORY = new URL("../public/", import.meta.url);
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join("; ");
const PUBLIC_ASSETS = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/game.js", { file: "game.js", type: "text/javascript; charset=utf-8" }],
    ["/inference-controller.js", { file: "inference-controller.js", type: "text/javascript; charset=utf-8" }],
    ["/turn-policy.js", { file: "turn-policy.js", type: "text/javascript; charset=utf-8" }],
]);

class HttpError extends Error {
    constructor(status, message, code = "request_error") {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(body);
}

function getAllowedOrigins(port) {
    return new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
    ]);
}

function assertLocalHost(request, port) {
    const allowedOrigins = getAllowedOrigins(port);
    const host = request.headers.host;

    if (typeof host !== "string" || !allowedOrigins.has(`http://${host}`)) {
        throw new HttpError(403, "ローカルの正しいURLから開いてください。", "invalid_host");
    }
}

function assertSameOriginInference(request, port) {
    const allowedOrigins = getAllowedOrigins(port);
    const origin = request.headers.origin;

    if (origin !== undefined && (typeof origin !== "string" || !allowedOrigins.has(origin))) {
        throw new HttpError(403, "同じローカル画面から操作してください。", "invalid_origin");
    }

    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
        throw new HttpError(403, "同じローカル画面から操作してください。", "invalid_origin");
    }
}

async function readJsonBody(request) {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "JSON形式で送信してください。", "invalid_content_type");
    }

    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
        throw new HttpError(413, "送信データが大きすぎます。", "body_too_large");
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > MAX_REQUEST_BODY_BYTES) {
            throw new HttpError(413, "送信データが大きすぎます。", "body_too_large");
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "送信データを読み取れません。", "invalid_json");
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCoordinate(cell, size, withNumber = false) {
    if (!isPlainObject(cell)) {
        throw new HttpError(400, "盤面データが正しくありません。", "invalid_board");
    }

    if (
        !Number.isInteger(cell.row)
        || !Number.isInteger(cell.column)
        || cell.row < 0
        || cell.row >= size
        || cell.column < 0
        || cell.column >= size
    ) {
        throw new HttpError(400, "盤面の座標が正しくありません。", "invalid_board");
    }

    if (withNumber && (
        !Number.isInteger(cell.neighborMines)
        || cell.neighborMines < 0
        || cell.neighborMines > 8
    )) {
        throw new HttpError(400, "公開マスの数字が正しくありません。", "invalid_board");
    }
}

export function validateBoardDto(payload) {
    if (!isPlainObject(payload)) {
        throw new HttpError(400, "盤面データが正しくありません。", "invalid_board");
    }

    if (payload.size !== 9 || payload.totalMines !== 10) {
        throw new HttpError(400, "9×9、地雷10個の盤面を送信してください。", "invalid_board");
    }

    if (!Array.isArray(payload.revealed) || !Array.isArray(payload.unopened) || !Array.isArray(payload.flags)) {
        throw new HttpError(400, "盤面データが正しくありません。", "invalid_board");
    }

    if (payload.revealed.length === 0 || payload.unopened.length === 0) {
        throw new HttpError(400, "公開済みマスと候補マスが必要です。", "invalid_board");
    }

    const seen = new Set();
    const groups = [
        { cells: payload.revealed, withNumber: true },
        { cells: payload.unopened, withNumber: false },
        { cells: payload.flags, withNumber: false },
    ];

    for (const group of groups) {
        for (const cell of group.cells) {
            assertCoordinate(cell, payload.size, group.withNumber);
            const key = `${cell.row}:${cell.column}`;
            if (seen.has(key)) {
                throw new HttpError(400, "盤面に重複した座標があります。", "invalid_board");
            }
            seen.add(key);
        }
    }

    if (seen.size !== payload.size * payload.size) {
        throw new HttpError(400, "盤面の全マスを指定してください。", "invalid_board");
    }

    return {
        size: payload.size,
        totalMines: payload.totalMines,
        revealed: payload.revealed.map((cell) => ({
            row: cell.row,
            column: cell.column,
            neighborMines: cell.neighborMines,
        })),
        unopened: payload.unopened.map((cell) => ({ row: cell.row, column: cell.column })),
        flags: payload.flags.map((cell) => ({ row: cell.row, column: cell.column })),
    };
}

function publicErrorForJev(error) {
    const messages = {
        unauthorized: [502, "Vercel AI Gatewayの認証に失敗しました。AI_GATEWAY_API_KEYを確認してください。", "jev_unauthorized"],
        payment_required: [402, "Vercel AI Gatewayの残高が不足しています。", "jev_payment_required"],
        rate_limited: [503, "Vercel AI Gatewayの利用上限に達しました。時間を置いて再試行してください。", "jev_rate_limited"],
        timeout: [504, "Jevの応答が時間内に届きませんでした。再試行してください。", "jev_timeout"],
        malformed_response: [502, "Jevの応答形式を確認できませんでした。", "jev_malformed_response"],
        no_candidates: [409, "開けられる候補がありません。", "no_candidates"],
        client_cancelled: [499, "推論を停止しました。", "client_cancelled"],
        network_error: [502, "Vercel AI Gatewayへ接続できませんでした。", "jev_network_error"],
        upstream_error: [502, "Vercel AI Gatewayがリクエストを処理できませんでした。", "jev_upstream_error"],
    };
    return messages[error.code] ?? messages.upstream_error;
}

async function serveAsset(response, asset, method) {
    const body = await readFile(new URL(asset.file, PUBLIC_DIRECTORY));
    response.writeHead(200, {
        "content-type": asset.type,
        "content-length": body.byteLength,
        "cache-control": "no-cache",
        "content-security-policy": CONTENT_SECURITY_POLICY,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
    });
    response.end(method === "HEAD" ? undefined : body);
}

export function createApp({
    apiKey = process.env.AI_GATEWAY_API_KEY ?? "",
    fetchImpl = globalThis.fetch,
    upstreamTimeoutMs = 15_000,
} = {}) {
    let inferenceInFlight = false;
    const server = createServer(async (request, response) => {
        try {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
            assertLocalHost(request, port);

            const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
            if (requestUrl.search || requestUrl.hash) {
                throw new HttpError(404, "ページが見つかりません。", "not_found");
            }

            if ((request.method === "GET" || request.method === "HEAD") && PUBLIC_ASSETS.has(requestUrl.pathname)) {
                await serveAsset(response, PUBLIC_ASSETS.get(requestUrl.pathname), request.method);
                return;
            }

            if (request.method === "GET" && requestUrl.pathname === "/api/config") {
                sendJson(response, 200, { jevAvailable: apiKey.trim().length > 0 });
                return;
            }

            if (request.method === "POST" && requestUrl.pathname === "/api/infer") {
                assertSameOriginInference(request, port);
                const board = validateBoardDto(await readJsonBody(request));
                if (apiKey.trim().length === 0) {
                    throw new HttpError(
                        503,
                        "AI_GATEWAY_API_KEYを設定するとJev操作を利用できます。",
                        "jev_not_configured",
                    );
                }
                if (inferenceInFlight) {
                    throw new HttpError(
                        409,
                        "別の推論が完了してから再試行してください。",
                        "inference_busy",
                    );
                }

                const abortController = new AbortController();
                const cancelUpstream = () => {
                    if (!response.writableEnded) {
                        abortController.abort();
                    }
                };
                response.once("close", cancelUpstream);
                inferenceInFlight = true;

                try {
                    const candidate = await evaluateBoard(board, {
                        apiKey,
                        fetchImpl,
                        timeoutMs: upstreamTimeoutMs,
                        signal: abortController.signal,
                    });
                    sendJson(response, 200, { candidate });
                } finally {
                    inferenceInFlight = false;
                    response.removeListener("close", cancelUpstream);
                }
                return;
            }

            if (requestUrl.pathname.startsWith("/api/")) {
                throw new HttpError(405, "この操作には対応していません。", "method_not_allowed");
            }

            throw new HttpError(404, "ページが見つかりません。", "not_found");
        } catch (error) {
            if (response.headersSent || response.destroyed) {
                response.destroy();
                return;
            }

            if (error instanceof HttpError) {
                sendJson(response, error.status, { error: error.code, message: error.message });
                return;
            }

            if (error instanceof JevRequestError) {
                const [status, message, code] = publicErrorForJev(error);
                sendJson(response, status, { error: code, message });
                return;
            }

            sendJson(response, 500, {
                error: "internal_error",
                message: "サーバーで処理を続けられませんでした。",
            });
        }
    });

    return server;
}

function parsePort(rawPort) {
    if (rawPort === undefined || rawPort === "") {
        return DEFAULT_PORT;
    }

    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError("PORTには1から65535までの整数を指定してください。");
    }
    return port;
}

const isEntryPoint = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
    const port = parsePort(process.env.PORT);
    const server = createApp();
    server.listen(port, "127.0.0.1", () => {
        console.log(`Jevマインスイーパーをhttp://127.0.0.1:${port}で起動しました。`);
    });
}
