import test from "node:test";
import assert from "node:assert/strict";
import { createGame, getCell, toggleFlag } from "../public/game.js";
import { executeAutomatedTurn } from "../public/turn-policy.js";

test("中央の旗を保ったまま別のマスをローカル初手として開く", async () => {
    const game = createGame({ random: () => 0 });
    toggleFlag(game, 4, 4);
    let inferenceCalls = 0;

    const firstTurn = await executeAutomatedTurn(game, () => {
        inferenceCalls += 1;
    });

    assert.equal(firstTurn.kind, "local-opening");
    assert.equal(firstTurn.candidate.coordinate, "A1");
    assert.equal(getCell(game, 4, 4).flagged, true);
    assert.equal(getCell(game, 0, 0).revealed, true);
    assert.equal(inferenceCalls, 0);

    const secondTurn = await executeAutomatedTurn(game, async () => {
        inferenceCalls += 1;
        return { status: "stale" };
    });
    assert.equal(secondTurn.kind, "inference");
    assert.equal(inferenceCalls, 1);
});

test("全未開封マスに旗がある場合は推論を呼ばずに停止する", async () => {
    const game = createGame();
    for (let row = 0; row < game.size; row += 1) {
        for (let column = 0; column < game.size; column += 1) {
            toggleFlag(game, row, column);
        }
    }
    let inferenceCalls = 0;

    const turn = await executeAutomatedTurn(game, () => {
        inferenceCalls += 1;
    });

    assert.deepEqual(turn, { kind: "no-candidate" });
    assert.equal(inferenceCalls, 0);
    assert.equal(game.minesPlaced, false);
});
