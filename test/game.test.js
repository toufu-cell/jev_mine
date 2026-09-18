import test from "node:test";
import assert from "node:assert/strict";
import {
    createGame,
    getCell,
    revealCell,
    toggleFlag,
    toPublicBoard,
} from "../public/game.js";

test("初手を安全に開き、指定した数の地雷を配置する", () => {
    const game = createGame({ random: () => 0 });

    revealCell(game, 1, 1);

    assert.equal(getCell(game, 1, 1).mine, false);
    assert.equal(game.cells.filter((cell) => cell.mine).length, 10);
    assert.equal(game.status, "playing");
});

test("数字が0の領域と周囲の数字をまとめて公開する", () => {
    const game = createGame({ random: () => 0 });

    const result = revealCell(game, 8, 8);

    assert.ok(result.changed.length > 1);
    assert.equal(getCell(game, 8, 8).revealed, true);
    assert.equal(getCell(game, 2, 2).revealed, true);
});

test("地雷を開いた敗北と安全マスを開き切った勝利を判定する", () => {
    const losingGame = createGame({ random: () => 0 });
    revealCell(losingGame, 1, 1);
    revealCell(losingGame, 0, 0);
    assert.equal(losingGame.status, "lost");

    const winningGame = createGame({ size: 2, mineCount: 1, random: () => 0 });
    revealCell(winningGame, 1, 1);
    revealCell(winningGame, 0, 1);
    revealCell(winningGame, 1, 0);
    assert.equal(winningGame.status, "won");
});

test("公開盤面には地雷位置や未公開マスの数字を含めない", () => {
    const game = createGame({ random: () => 0 });
    revealCell(game, 1, 1);
    toggleFlag(game, 8, 8);

    const publicBoard = toPublicBoard(game);
    const serialized = JSON.stringify(publicBoard);

    assert.deepEqual(Object.keys(publicBoard).sort(), ["flags", "revealed", "size", "totalMines", "unopened"]);
    assert.equal(serialized.includes("mine"), false);
    assert.equal(publicBoard.flags.some((cell) => cell.row === 8 && cell.column === 8), true);
    assert.equal(publicBoard.unopened.some((cell) => cell.row === 8 && cell.column === 8), false);
});
