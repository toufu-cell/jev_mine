import test from "node:test";
import assert from "node:assert/strict";
import { createInferenceController } from "../public/inference-controller.js";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test("停止後に届いた成功結果を古い応答として破棄する", async () => {
    const response = deferred();
    const controller = createInferenceController({ request: () => response.promise });

    const pending = controller.run({});
    controller.invalidate();
    response.resolve({ candidate: "A1" });

    assert.deepEqual(await pending, { status: "stale" });
});

test("停止後に届いた失敗を画面へ適用するエラーにしない", async () => {
    const response = deferred();
    const controller = createInferenceController({ request: () => response.promise });

    const pending = controller.run({});
    controller.invalidate();
    response.reject(new Error("古い失敗"));

    assert.deepEqual(await pending, { status: "stale" });
});

test("処理中は2件目の推論を開始しない", async () => {
    const response = deferred();
    let calls = 0;
    const controller = createInferenceController({
        request: () => {
            calls += 1;
            return response.promise;
        },
    });

    const first = controller.run({ turn: 1 });
    assert.deepEqual(await controller.run({ turn: 2 }), { status: "busy" });
    response.resolve("完了");

    assert.deepEqual(await first, { status: "ok", value: "完了" });
    assert.equal(calls, 1);
});
