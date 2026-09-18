import { coordinateLabel, revealCell, toPublicBoard } from "./game.js";

function selectInitialCandidate(game, unopened) {
    const center = Math.floor(game.size / 2);
    return unopened.find((cell) => cell.row === center && cell.column === center)
        ?? unopened[0];
}

export async function executeAutomatedTurn(game, infer) {
    const publicBoard = toPublicBoard(game);
    if (publicBoard.unopened.length === 0) {
        return { kind: "no-candidate" };
    }

    if (game.revealedCount === 0) {
        const candidate = selectInitialCandidate(game, publicBoard.unopened);
        return {
            kind: "local-opening",
            candidate: {
                ...candidate,
                coordinate: coordinateLabel(candidate.row, candidate.column),
            },
            moveResult: revealCell(game, candidate.row, candidate.column),
        };
    }

    return {
        kind: "inference",
        result: await infer(publicBoard),
    };
}
