export const BOARD_SIZE = 9;
export const MINE_COUNT = 10;

function assertGameOptions(size, mineCount) {
    if (!Number.isInteger(size) || size < 2) {
        throw new TypeError("盤面サイズは2以上の整数で指定してください。");
    }

    if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount >= size * size) {
        throw new TypeError("地雷数は1以上かつマス数未満で指定してください。");
    }
}

function toIndex(game, row, column) {
    return row * game.size + column;
}

function isInside(game, row, column) {
    return row >= 0 && row < game.size && column >= 0 && column < game.size;
}

function getNeighbors(game, row, column) {
    const neighbors = [];

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            if (rowOffset === 0 && columnOffset === 0) {
                continue;
            }

            const neighborRow = row + rowOffset;
            const neighborColumn = column + columnOffset;
            if (isInside(game, neighborRow, neighborColumn)) {
                neighbors.push({ row: neighborRow, column: neighborColumn });
            }
        }
    }

    return neighbors;
}

function placeMines(game, safeRow, safeColumn) {
    const safeIndex = toIndex(game, safeRow, safeColumn);
    const available = game.cells
        .map((_, index) => index)
        .filter((index) => index !== safeIndex);

    for (let placed = 0; placed < game.mineCount; placed += 1) {
        const sample = game.random();
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
            throw new RangeError("乱数生成関数は0以上1未満の数値を返す必要があります。");
        }

        const choiceIndex = Math.floor(sample * available.length);
        const [cellIndex] = available.splice(choiceIndex, 1);
        game.cells[cellIndex].mine = true;
    }

    for (let row = 0; row < game.size; row += 1) {
        for (let column = 0; column < game.size; column += 1) {
            const cell = game.cells[toIndex(game, row, column)];
            if (cell.mine) {
                continue;
            }

            cell.neighborMines = getNeighbors(game, row, column)
                .filter((neighbor) => game.cells[toIndex(game, neighbor.row, neighbor.column)].mine)
                .length;
        }
    }

    game.minesPlaced = true;
}

function revealSafeArea(game, startRow, startColumn) {
    const queue = [{ row: startRow, column: startColumn }];
    const changed = [];

    while (queue.length > 0) {
        const current = queue.shift();
        const cell = game.cells[toIndex(game, current.row, current.column)];

        if (cell.revealed || cell.flagged || cell.mine) {
            continue;
        }

        cell.revealed = true;
        game.revealedCount += 1;
        changed.push(current);

        if (cell.neighborMines === 0) {
            for (const neighbor of getNeighbors(game, current.row, current.column)) {
                const neighborCell = game.cells[toIndex(game, neighbor.row, neighbor.column)];
                if (!neighborCell.revealed && !neighborCell.flagged && !neighborCell.mine) {
                    queue.push(neighbor);
                }
            }
        }
    }

    return changed;
}

export function createGame({
    size = BOARD_SIZE,
    mineCount = MINE_COUNT,
    random = Math.random,
} = {}) {
    assertGameOptions(size, mineCount);

    if (typeof random !== "function") {
        throw new TypeError("乱数生成関数を指定してください。");
    }

    return {
        size,
        mineCount,
        random,
        cells: Array.from({ length: size * size }, () => ({
            mine: false,
            neighborMines: 0,
            revealed: false,
            flagged: false,
        })),
        minesPlaced: false,
        revealedCount: 0,
        status: "playing",
    };
}

export function getCell(game, row, column) {
    if (!isInside(game, row, column)) {
        throw new RangeError("盤面外の座標です。");
    }

    return game.cells[toIndex(game, row, column)];
}

export function revealCell(game, row, column) {
    const cell = getCell(game, row, column);

    if (game.status !== "playing" || cell.revealed || cell.flagged) {
        return { changed: [], status: game.status };
    }

    if (!game.minesPlaced) {
        placeMines(game, row, column);
    }

    if (cell.mine) {
        cell.revealed = true;
        game.status = "lost";
        return { changed: [{ row, column }], status: game.status };
    }

    const changed = revealSafeArea(game, row, column);
    if (game.revealedCount === game.size * game.size - game.mineCount) {
        game.status = "won";
    }

    return { changed, status: game.status };
}

export function toggleFlag(game, row, column) {
    const cell = getCell(game, row, column);

    if (game.status !== "playing" || cell.revealed) {
        return false;
    }

    cell.flagged = !cell.flagged;
    return true;
}

export function getFlagCount(game) {
    return game.cells.filter((cell) => cell.flagged).length;
}

export function coordinateLabel(row, column) {
    return `${String.fromCharCode(65 + row)}${column + 1}`;
}

export function toPublicBoard(game) {
    const revealed = [];
    const unopened = [];
    const flags = [];

    for (let row = 0; row < game.size; row += 1) {
        for (let column = 0; column < game.size; column += 1) {
            const cell = getCell(game, row, column);
            const coordinate = { row, column };

            if (cell.revealed && !cell.mine) {
                revealed.push({ ...coordinate, neighborMines: cell.neighborMines });
            } else if (cell.flagged) {
                flags.push(coordinate);
            } else if (!cell.revealed) {
                unopened.push(coordinate);
            }
        }
    }

    return {
        size: game.size,
        totalMines: game.mineCount,
        revealed,
        unopened,
        flags,
    };
}
