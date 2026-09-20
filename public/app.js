import {
    coordinateLabel,
    createGame,
    getCell,
    getFlagCount,
    revealCell,
    toggleFlag,
} from "./game.js";
import { createInferenceController } from "./inference-controller.js";
import { executeAutomatedTurn } from "./turn-policy.js";

const AUTO_PLAY_DELAY_MS = 650;
const elements = {
    board: document.querySelector("#board"),
    gameStatus: document.querySelector("#game-status"),
    flagCount: document.querySelector("#flag-count"),
    revealCount: document.querySelector("#reveal-count"),
    stepButton: document.querySelector("#step-button"),
    autoButton: document.querySelector("#auto-button"),
    stopButton: document.querySelector("#stop-button"),
    restartButton: document.querySelector("#restart-button"),
    flagModeButton: document.querySelector("#flag-mode-button"),
    configMessage: document.querySelector("#config-message"),
    candidateEmpty: document.querySelector("#candidate-empty"),
    candidateDetails: document.querySelector("#candidate-details"),
    candidateCoordinate: document.querySelector("#candidate-coordinate"),
    candidateProbability: document.querySelector("#candidate-probability"),
    history: document.querySelector("#history"),
    activityIndicator: document.querySelector("#activity-indicator"),
};

let game = createGame();
let jevAvailable = false;
let configLoaded = false;
let flagMode = false;
let autoPlaying = false;
let autoGeneration = 0;
let lastCandidate = null;
let statusMessage = "盤面を選ぶか、Jevに一手を依頼してください。";
let historyEntries = ["新しい盤面を開始しました。"];

async function requestInference(board, { signal }) {
    const response = await fetch("/api/infer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(board),
        signal,
    });

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new Error("サーバーの応答を読み取れませんでした。");
    }

    if (!response.ok) {
        throw new Error(typeof payload.message === "string"
            ? payload.message
            : "Jevで推論できませんでした。");
    }

    const candidate = payload?.candidate;
    if (
        !candidate
        || !Number.isInteger(candidate.row)
        || !Number.isInteger(candidate.column)
        || candidate.coordinate !== coordinateLabel(candidate.row, candidate.column)
        || !Number.isFinite(candidate.probability)
        || candidate.probability < 0
        || candidate.probability > 1
    ) {
        throw new Error("候補の応答形式を確認できませんでした。");
    }

    return candidate;
}

const inferenceController = createInferenceController({
    request: requestInference,
    onBusyChange: () => render(),
});

function addHistory(message) {
    historyEntries.push(message);
    historyEntries = historyEntries.slice(-8);
}

function gameStatusText() {
    if (game.status === "won") {
        return "すべての安全なマスを開きました。";
    }
    if (game.status === "lost") {
        return "地雷を開きました。再開始すると新しい盤面になります。";
    }
    return statusMessage;
}

function cellAriaLabel(row, column, cell) {
    const coordinate = coordinateLabel(row, column);
    if (cell.revealed && cell.mine) {
        return `${coordinate}、地雷`;
    }
    if (cell.revealed) {
        return `${coordinate}、周囲の地雷は${cell.neighborMines}個`;
    }
    if (cell.flagged) {
        return `${coordinate}、旗あり`;
    }
    return `${coordinate}、未開封`;
}

function appendAxisLabel(text) {
    const label = document.createElement("span");
    label.className = "axis-label";
    label.textContent = text;
    label.setAttribute("aria-hidden", "true");
    elements.board.append(label);
}

function captureBoardFocus() {
    const activeElement = document.activeElement;
    if (!activeElement?.classList?.contains("cell")) {
        return null;
    }

    return {
        row: Number(activeElement.dataset.row),
        column: Number(activeElement.dataset.column),
    };
}

function restoreBoardFocus(previousFocus) {
    if (!previousFocus) {
        return;
    }

    if (game.status !== "playing") {
        elements.restartButton.focus({ preventScroll: true });
        return;
    }

    const buttons = [...elements.board.querySelectorAll(".cell")];
    const previousIndex = previousFocus.row * game.size + previousFocus.column;
    for (let offset = 0; offset < buttons.length; offset += 1) {
        const button = buttons[(previousIndex + offset) % buttons.length];
        if (!button.disabled) {
            button.focus({ preventScroll: true });
            return;
        }
    }
}

function renderBoard() {
    const previousFocus = captureBoardFocus();
    const locked = inferenceController.isBusy() || autoPlaying || game.status !== "playing";
    elements.board.replaceChildren();
    appendAxisLabel("");
    for (let column = 0; column < game.size; column += 1) {
        appendAxisLabel(String(column + 1));
    }

    for (let row = 0; row < game.size; row += 1) {
        appendAxisLabel(String.fromCharCode(65 + row));
        for (let column = 0; column < game.size; column += 1) {
            const cell = getCell(game, row, column);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "cell";
            button.dataset.row = String(row);
            button.dataset.column = String(column);
            button.setAttribute("aria-label", cellAriaLabel(row, column, cell));
            button.disabled = locked || cell.revealed;

            if (cell.revealed) {
                button.classList.add("revealed");
                if (cell.mine) {
                    button.classList.add("mine");
                } else if (cell.neighborMines > 0) {
                    button.classList.add(`number-${cell.neighborMines}`);
                    button.textContent = String(cell.neighborMines);
                }
            } else if (game.status === "lost" && cell.mine) {
                button.classList.add("mine");
            } else if (cell.flagged) {
                button.classList.add("flagged");
            }

            if (lastCandidate?.row === row && lastCandidate?.column === column) {
                button.classList.add("last-candidate");
            }

            elements.board.append(button);
        }
    }

    restoreBoardFocus(previousFocus);
}

function renderHistory() {
    elements.history.replaceChildren();
    for (const entry of historyEntries) {
        const item = document.createElement("li");
        item.textContent = entry;
        elements.history.append(item);
    }
    elements.history.scrollTop = elements.history.scrollHeight;
}

function render() {
    const busy = inferenceController.isBusy();
    const terminal = game.status !== "playing";
    const aiDisabled = !configLoaded || !jevAvailable || busy || autoPlaying || terminal;

    renderBoard();
    renderHistory();
    elements.gameStatus.textContent = gameStatusText();
    elements.flagCount.textContent = `${getFlagCount(game)} / ${game.mineCount}`;
    elements.revealCount.textContent = `${game.revealedCount} / ${game.size * game.size - game.mineCount}`;
    elements.stepButton.disabled = aiDisabled;
    elements.autoButton.disabled = aiDisabled;
    elements.stopButton.disabled = !busy && !autoPlaying;
    elements.restartButton.disabled = false;
    elements.flagModeButton.disabled = busy || autoPlaying || terminal;
    elements.flagModeButton.setAttribute("aria-pressed", String(flagMode));
    elements.flagModeButton.textContent = `タッチ旗モード: ${flagMode ? "オン" : "オフ"}`;
    elements.activityIndicator.hidden = !busy;

    if (lastCandidate) {
        elements.candidateEmpty.hidden = true;
        elements.candidateDetails.hidden = false;
        elements.candidateCoordinate.textContent = lastCandidate.coordinate;
        elements.candidateProbability.textContent = `${(lastCandidate.probability * 100).toFixed(1)}%`;
    } else {
        elements.candidateEmpty.hidden = false;
        elements.candidateDetails.hidden = true;
    }
}

function updateAfterMove(result) {
    if (result.status === "won") {
        stopAutomation(false);
    } else if (result.status === "lost") {
        stopAutomation(false);
    }
    render();
}

async function takeJevStep() {
    if (!jevAvailable || game.status !== "playing") {
        return false;
    }

    const turn = await executeAutomatedTurn(game, (publicBoard) => {
        statusMessage = "公開盤面から地雷確率を推定しています。";
        render();
        return inferenceController.run(publicBoard);
    });

    if (turn.kind === "no-candidate") {
        statusMessage = "旗のない未開封マスがありません。";
        addHistory(`停止: ${statusMessage}`);
        stopAutomation(false);
        render();
        return false;
    }

    if (turn.kind === "local-opening") {
        lastCandidate = null;
        statusMessage = `初手として${turn.candidate.coordinate}をローカルで開きました。`;
        addHistory(`初手: ${turn.candidate.coordinate}をローカルで開きました。`);
        updateAfterMove(turn.moveResult);
        return true;
    }

    const { result } = turn;

    if (result.status === "stale" || result.status === "busy") {
        return false;
    }

    if (result.status === "error") {
        statusMessage = result.error instanceof Error
            ? result.error.message
            : "Jevで推論できませんでした。";
        addHistory(`停止: ${statusMessage}`);
        stopAutomation(false);
        render();
        return false;
    }

    const candidate = result.value;
    if (
        candidate.row < 0
        || candidate.row >= game.size
        || candidate.column < 0
        || candidate.column >= game.size
    ) {
        statusMessage = "候補の座標が盤面外でした。";
        addHistory(`停止: ${statusMessage}`);
        stopAutomation(false);
        render();
        return false;
    }

    const cell = getCell(game, candidate.row, candidate.column);
    if (cell.revealed || cell.flagged || game.status !== "playing") {
        statusMessage = "現在の盤面に適用できない候補を破棄しました。";
        addHistory(`停止: ${statusMessage}`);
        stopAutomation(false);
        render();
        return false;
    }

    lastCandidate = candidate;
    const probability = `${(candidate.probability * 100).toFixed(1)}%`;
    const moveResult = revealCell(game, candidate.row, candidate.column);
    statusMessage = `${candidate.coordinate}を開きました。推定地雷確率は${probability}です。`;
    addHistory(`Jev: ${candidate.coordinate}（推定地雷確率 ${probability}）を開きました。`);
    updateAfterMove(moveResult);
    return true;
}

function stopAutomation(addEntry = true) {
    const wasActive = autoPlaying || inferenceController.isBusy();
    autoGeneration += 1;
    autoPlaying = false;
    inferenceController.invalidate();
    if (addEntry && wasActive) {
        statusMessage = "自動操作を停止しました。";
        addHistory("自動操作を停止しました。");
    }
    render();
}

function waitForNextMove(generation) {
    return new Promise((resolve) => {
        window.setTimeout(() => resolve(generation === autoGeneration), AUTO_PLAY_DELAY_MS);
    });
}

async function startAutoPlay() {
    if (autoPlaying || inferenceController.isBusy() || !jevAvailable || game.status !== "playing") {
        return;
    }

    autoPlaying = true;
    const generation = ++autoGeneration;
    statusMessage = "自動操作を開始しました。";
    addHistory("自動操作を開始しました。");
    render();

    while (generation === autoGeneration && game.status === "playing") {
        const moved = await takeJevStep();
        if (!moved || generation !== autoGeneration || game.status !== "playing") {
            break;
        }
        if (!await waitForNextMove(generation)) {
            break;
        }
    }

    if (generation === autoGeneration) {
        autoPlaying = false;
        render();
    }
}

function handleBoardAction(row, column, useFlag) {
    if (inferenceController.isBusy() || autoPlaying || game.status !== "playing") {
        return;
    }

    inferenceController.invalidate();
    const label = coordinateLabel(row, column);

    if (useFlag) {
        if (toggleFlag(game, row, column)) {
            const flagged = getCell(game, row, column).flagged;
            statusMessage = flagged ? `${label}に旗を置きました。` : `${label}の旗を外しました。`;
            addHistory(statusMessage);
        }
        render();
        return;
    }

    const result = revealCell(game, row, column);
    if (result.changed.length > 0) {
        lastCandidate = null;
        statusMessage = `${label}を手動で開きました。`;
        addHistory(statusMessage);
    }
    updateAfterMove(result);
}

function restartGame() {
    stopAutomation(false);
    game = createGame();
    lastCandidate = null;
    flagMode = false;
    statusMessage = "新しい盤面を開始しました。";
    historyEntries = [statusMessage];
    render();
}

async function loadConfig() {
    try {
        const response = await fetch("/api/config");
        if (!response.ok) {
            throw new Error("設定を取得できませんでした。");
        }
        const config = await response.json();
        jevAvailable = config.jevAvailable === true;
        elements.configMessage.classList.toggle("error", !jevAvailable);
        elements.configMessage.textContent = jevAvailable
            ? "Jevを利用できます。旗は仮説として推論へ渡します。"
            : ".envにTYPESAFE_API_KEYを設定するとJev操作を利用できます。手動操作は利用できます。";
    } catch {
        jevAvailable = false;
        elements.configMessage.classList.add("error");
        elements.configMessage.textContent = "Jevの設定を確認できません。手動操作は利用できます。";
    } finally {
        configLoaded = true;
        render();
    }
}

elements.board.addEventListener("click", (event) => {
    const button = event.target.closest(".cell");
    if (!button) {
        return;
    }
    handleBoardAction(Number(button.dataset.row), Number(button.dataset.column), flagMode);
});

elements.board.addEventListener("contextmenu", (event) => {
    const button = event.target.closest(".cell");
    if (!button) {
        return;
    }
    event.preventDefault();
    handleBoardAction(Number(button.dataset.row), Number(button.dataset.column), true);
});

elements.stepButton.addEventListener("click", () => void takeJevStep());
elements.autoButton.addEventListener("click", () => void startAutoPlay());
elements.stopButton.addEventListener("click", () => stopAutomation());
elements.restartButton.addEventListener("click", restartGame);
elements.flagModeButton.addEventListener("click", () => {
    flagMode = !flagMode;
    render();
});

render();
void loadConfig();
