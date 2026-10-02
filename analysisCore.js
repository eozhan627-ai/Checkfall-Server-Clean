// Turns raw engine evaluations into a game review: a label for every move
// (brilliant ... blunder, book), accuracy, an estimated playing strength and
// the key moments of the game.
//
// No engine and no database in here - only chess.js and maths - so the whole
// thing can be unit-tested with hand-made evaluations.

import { Chess } from "chess.js";
import { matchOpening } from "./openingBook.js";
import { detectTacticalMotif } from "./tacticsDetector.js";

export const ANALYSIS_VERSION = 2;

export const CLASSIFICATIONS = [
    "brilliant",
    "great",
    "best",
    "excellent",
    "good",
    "book",
    "forced",
    "inaccuracy",
    "mistake",
    "miss",
    "blunder",
];

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Engine scores are capped here before they are turned into numbers the app
// shows; a forced mate is stored separately as "mate in N".
const MATE_CP = 10000;
const ACPL_CLAMP = 1000;

// =============================
// BASIC MATHS
// =============================

// Chance to win (0-100) for the side the centipawn value belongs to.
// Same curve Lichess uses for its accuracy numbers.
export function winPct(cp) {
    const clamped = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

// Accuracy (0-100) of a single move from the win chance it gave away.
export function moveAccuracy(winLoss) {
    const raw = 103.1668 * Math.exp(-0.04354 * Math.max(0, winLoss)) - 3.1669;
    return Math.max(0, Math.min(100, raw));
}

// Rough playing strength for one game from the average centipawn loss.
// Only an estimate - shown as such in the app.
export function estimateRating(acpl) {
    if (acpl === null || !Number.isFinite(acpl)) return null;
    const rating = 3100 * Math.exp(-0.01 * acpl);
    return Math.max(100, Math.min(3200, Math.round(rating / 50) * 50));
}

// { cp, mate } from the engine (side-to-move view) -> one comparable number.
// A mate in 3 scores higher than a mate in 7.
export function scoreToCp(score) {
    if (!score) return 0;

    if (score.mate !== null && score.mate !== undefined) {
        if (score.mate > 0) return MATE_CP - Math.min(score.mate, 99);
        // mate 0 = the side to move is already checkmated
        return -MATE_CP + Math.min(Math.abs(score.mate), 99);
    }

    return Math.max(-MATE_CP + 100, Math.min(MATE_CP - 100, score.cp ?? 0));
}

const round1 = (n) => Math.round(n * 10) / 10;

// =============================
// CHESS HELPERS
// =============================

// Material (in pawns) a move gives up by putting a piece where it can simply
// be taken for less than it is worth; 0 if nothing is given up. That is what
// turns a strong move into a "brilliant" one.
export function sacrificedMaterial(fenAfter, move) {
    try {
        if (!move || move.piece === "p" || move.piece === "k") return 0;

        const game = new Chess(fenAfter);
        const movedValue = PIECE_VALUE[move.promotion || move.piece];
        const capturedValue = move.captured ? PIECE_VALUE[move.captured] : 0;

        const captures = game
            .moves({ verbose: true })
            .filter((m) => m.to === move.to && m.captured);

        if (captures.length === 0) return 0;

        const cheapest = captures.reduce((a, b) =>
            PIECE_VALUE[a.piece] <= PIECE_VALUE[b.piece] ? a : b
        );

        const probe = new Chess(fenAfter);
        probe.move({ from: cheapest.from, to: cheapest.to, promotion: cheapest.promotion });

        const canRecapture = probe
            .moves({ verbose: true })
            .some((m) => m.to === move.to && m.captured);

        const net =
            movedValue - (canRecapture ? PIECE_VALUE[cheapest.piece] : 0) - capturedValue;

        return Math.max(0, net);
    } catch {
        return 0;
    }
}

function nonPawnMaterial(game) {
    let total = 0;
    let queens = 0;

    for (const row of game.board()) {
        for (const piece of row) {
            if (!piece || piece.type === "p" || piece.type === "k") continue;
            total += PIECE_VALUE[piece.type];
            if (piece.type === "q") queens += 1;
        }
    }

    return { total, queens };
}

function phaseOf(moveNumber, material) {
    if (material.queens === 0 ? material.total <= 20 : material.total <= 13) {
        return "endgame";
    }
    if (moveNumber <= 10) return "opening";
    return "middlegame";
}

function uciToSanLine(fen, uciMoves, maxPlies) {
    const sans = [];

    try {
        const game = new Chess(fen);

        for (const uci of uciMoves.slice(0, maxPlies)) {
            if (!uci || uci.length < 4) break;

            const move = game.move({
                from: uci.slice(0, 2),
                to: uci.slice(2, 4),
                promotion: uci.length > 4 ? uci[4] : undefined,
            });

            if (!move) break;
            sans.push(move.san);
        }
    } catch {
        // An illegal move in the engine line just ends the line early.
    }

    return sans;
}

// =============================
// REPLAY
// =============================

/**
 * Replays a PGN and returns every position the engine has to look at.
 *
 * positions[0] is the start position, positions[i + 1] the position after
 * move i. `terminal` positions (mate / stalemate / draw) need no engine.
 */
export function buildGame(pgn) {
    const source = new Chess();
    source.loadPgn(pgn);

    const verbose = source.history({ verbose: true });
    const replay = new Chess();

    const positions = [{ fen: replay.fen(), terminal: null }];
    const moves = [];

    for (const [index, mv] of verbose.entries()) {
        const fenBefore = replay.fen();
        const legalMoves = replay.moves().length;

        const done = replay.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
        const fenAfter = replay.fen();

        let terminal = null;
        if (replay.isCheckmate()) terminal = "checkmate";
        else if (replay.isGameOver()) terminal = "draw";

        positions.push({ fen: fenAfter, terminal });

        const material = nonPawnMaterial(replay);
        const moveNumber = Math.floor(index / 2) + 1;

        moves.push({
            ply: index,
            moveNumber,
            color: index % 2 === 0 ? "w" : "b",
            san: done.san,
            uci: `${done.from}${done.to}${done.promotion ?? ""}`,
            from: done.from,
            to: done.to,
            piece: done.piece,
            captured: done.captured ?? null,
            promotion: done.promotion ?? null,
            fenBefore,
            fenAfter,
            legalMoves,
            sacrifice: sacrificedMaterial(fenAfter, done),
            isRecapture: Boolean(
                done.captured && index > 0 && verbose[index - 1].to === done.to && verbose[index - 1].captured
            ),
            phase: phaseOf(moveNumber, material),
        });
    }

    const opening = matchOpening(moves.map((m) => m.san));

    return { positions, moves, opening };
}

// Engine result for a position that is already decided.
export function terminalEvaluation(terminal) {
    if (terminal === "checkmate") {
        // The side to move has been mated.
        return { cp: null, mate: 0, second: null, bestMove: null, pv: [], depth: 0 };
    }
    return { cp: 0, mate: null, second: null, bestMove: null, pv: [], depth: 0 };
}

// =============================
// CLASSIFICATION
// =============================

/**
 * Label for one move.
 *
 * @param {object} c
 * @param {number} c.winBefore  mover's win chance before the move (best play)
 * @param {number} c.winAfter   mover's win chance after the move actually played
 * @param {number|null} c.winSecond mover's win chance with the second-best move
 * @param {boolean} c.isBest    played move = engine's first choice
 * @param {boolean} c.isBook    still following opening theory
 * @param {boolean} c.isForced  only one legal move
 * @param {number} c.sacrifice material offered (in pawns), 0 = none
 * @param {boolean} c.isRecapture simply taking back
 * @param {number} c.opponentLoss win chance the opponent gave away one move earlier
 * @param {boolean} c.hadMate   mover had a forced mate before the move
 * @param {boolean} c.keptMate  ... and still has one afterwards
 */
export function classifyMove(c) {
    if (c.isBook) return "book";
    if (c.isForced) return "forced";

    const loss = Math.max(0, c.winBefore - c.winAfter);

    // ---- chances not taken ----
    // The opponent just went wrong (or a forced mate was on the board) and
    // the reply lets them off the hook without ending up worse.
    const letOffTheHook =
        !c.isBest && c.opponentLoss >= 10 && loss >= 8 && c.winAfter >= 30;
    const wonGameSlipped =
        !c.isBest && c.winBefore >= 80 && c.winAfter <= 65 && c.winAfter >= 35 && loss >= 12;
    const mateMissed =
        c.hadMate && !c.keptMate && !c.isBest && c.winAfter >= 30 && c.winAfter < 97;

    if (letOffTheHook || wonGameSlipped || mateMissed) return "miss";

    // ---- errors ----
    if (!c.isBest) {
        if (loss > 20) return "blunder";
        if (loss > 10) return "mistake";
        if (loss > 5) return "inaccuracy";
    }

    // ---- good moves ----
    const nearBest = c.isBest || loss <= 2;

    // A sacrifice that works. When the game is already won only a big one
    // (rook or queen) still counts, otherwise every winning line would be
    // full of "brilliant" moves.
    if (
        nearBest &&
        c.sacrifice >= 1 &&
        !c.isRecapture &&
        c.winAfter >= 45 &&
        (c.winBefore < 92 || c.sacrifice >= 5)
    ) {
        return "brilliant";
    }

    const onlyGoodMove =
        c.winSecond !== null &&
        c.winSecond !== undefined &&
        c.winBefore - c.winSecond >= 12;

    if (
        (c.isBest || loss <= 0.5) &&
        onlyGoodMove &&
        !c.isRecapture &&
        c.winAfter >= 30 &&
        c.winBefore < 97
    ) {
        return "great";
    }

    if (c.isBest || loss <= 0.5) return "best";
    if (loss <= 2) return "excellent";
    return "good";
}

// =============================
// FULL REVIEW
// =============================

/**
 * @param {ReturnType<typeof buildGame>} game
 * @param {Array<{cp:number|null, mate:number|null, second:{cp:number|null,mate:number|null}|null, bestMove:string|null, pv:string[], depth:number}>} evaluations
 *        one per position, from the side to move's point of view
 * @param {{ depth: number, tier: string }} meta
 */
export function buildReview(game, evaluations, meta) {
    const { moves, opening } = game;

    const reviewed = [];
    const counts = { w: {}, b: {} };
    const accuracySum = { w: 0, b: 0 };
    const cpLossSum = { w: 0, b: 0 };
    const moveCount = { w: 0, b: 0 };
    const phaseSum = { w: {}, b: {} };
    const phaseCount = { w: {}, b: {} };

    // ---- make the engine's numbers consistent along the game ----
    // The position after a move was searched one move deeper than the
    // position before it. So going backwards from the end:
    //   - engine's best move = the move played: the position is worth
    //     exactly what that move leads to
    //   - the move played turns out BETTER than the engine's choice: the
    //     shallow search was wrong, the played move counts as best
    const value = evaluations.map(scoreToCp); // side to move's view
    const playedIsBest = new Array(moves.length).fill(false);
    const overruled = new Array(moves.length).fill(false);

    const sameMove = (a, b) =>
        Boolean(a) && a.slice(0, 4) === b.slice(0, 4) && (a[4] ?? "") === (b[4] ?? "");

    const MATE_THRESHOLD = MATE_CP - 100;

    for (let k = moves.length - 1; k >= 0; k--) {
        let playedValue = -value[k + 1];

        // "The opponent is mated in N" one move later means "mate in N + 1"
        // here (mate values are stored as MATE_CP - number of moves).
        if (playedValue > MATE_THRESHOLD) playedValue -= 1;

        if (sameMove(evaluations[k].bestMove, moves[k].uci)) {
            playedIsBest[k] = true;
            value[k] = playedValue;
        } else if (playedValue > value[k]) {
            playedIsBest[k] = true;
            overruled[k] = true;
            value[k] = playedValue;
        }
    }

    let opponentLoss = 0;

    for (const move of moves) {
        const before = evaluations[move.ply];
        const after = evaluations[move.ply + 1];

        const cpBefore = value[move.ply]; // mover's view
        const cpAfter = -value[move.ply + 1]; // after the move the opponent is to move

        const winBefore = winPct(cpBefore);
        const winAfter = winPct(cpAfter);
        const winSecond =
            before.second && !overruled[move.ply] ? winPct(scoreToCp(before.second)) : null;

        const isBest = playedIsBest[move.ply];

        const hadMate = cpBefore > MATE_THRESHOLD;
        const keptMate = cpAfter > MATE_THRESHOLD;

        const classification = classifyMove({
            winBefore,
            winAfter,
            winSecond,
            isBest,
            isBook: move.ply < opening.plies,
            isForced: move.legalMoves === 1,
            sacrifice: move.sacrifice,
            isRecapture: move.isRecapture,
            opponentLoss,
            hadMate,
            keptMate,
        });

        const loss = isBest ? 0 : Math.max(0, winBefore - winAfter);
        const accuracy = moveAccuracy(loss);

        const cpLoss = isBest
            ? 0
            : Math.max(
                  0,
                  Math.max(-ACPL_CLAMP, Math.min(ACPL_CLAMP, cpBefore)) -
                      Math.max(-ACPL_CLAMP, Math.min(ACPL_CLAMP, cpAfter))
              );

        const side = move.color;
        counts[side][classification] = (counts[side][classification] || 0) + 1;
        accuracySum[side] += accuracy;
        cpLossSum[side] += cpLoss;
        moveCount[side] += 1;
        phaseSum[side][move.phase] = (phaseSum[side][move.phase] || 0) + accuracy;
        phaseCount[side][move.phase] = (phaseCount[side][move.phase] || 0) + 1;

        // White's point of view for everything the app draws.
        const whiteCp = side === "w" ? cpAfter : -cpAfter;

        // Forced mate: number of moves and who mates (0 = this move is mate).
        const mate = Math.abs(cpAfter) > MATE_THRESHOLD ? MATE_CP - Math.abs(cpAfter) : null;
        const mateFor = mate === null ? null : whiteCp > 0 ? "w" : "b";

        const reply = after.pv?.length ? uciToSanLine(move.fenAfter, after.pv, 4) : [];
        const bestLine = overruled[move.ply]
            ? [move.san, ...reply].slice(0, 6)
            : before.pv?.length
                ? uciToSanLine(move.fenBefore, before.pv, 6)
                : [];
        const bestMove = overruled[move.ply] ? move.uci : before.bestMove ?? null;

        const isNegative = ["inaccuracy", "mistake", "miss", "blunder"].includes(classification);

        reviewed.push({
            ply: move.ply,
            moveNumber: move.moveNumber,
            color: side,
            san: move.san,
            uci: move.uci,
            evalCp: Math.round(Math.max(-MATE_CP, Math.min(MATE_CP, whiteCp))),
            mate,
            mateFor,
            bestMove,
            bestSan: bestLine[0] ?? null,
            bestLine,
            reply,
            classification,
            winBefore: round1(winBefore),
            winAfter: round1(winAfter),
            loss: round1(loss),
            accuracy: round1(accuracy),
            cpLoss: Math.round(cpLoss),
            phase: move.phase,
            sacrifice: move.sacrifice > 0,
            motif:
                isNegative && bestMove
                    ? detectTacticalMotif(Chess, move.fenBefore, bestMove)
                    : null,
            depth: before.depth ?? null,
        });

        opponentLoss = loss;
    }

    const perSide = (fn) => ({ w: fn("w"), b: fn("b") });

    const accuracy = perSide((s) => (moveCount[s] ? round1(accuracySum[s] / moveCount[s]) : null));
    const acpl = perSide((s) => (moveCount[s] ? Math.round(cpLossSum[s] / moveCount[s]) : null));

    const phases = perSide((s) => {
        const out = {};
        for (const phase of ["opening", "middlegame", "endgame"]) {
            out[phase] = phaseCount[s][phase]
                ? round1(phaseSum[s][phase] / phaseCount[s][phase])
                : null;
        }
        return out;
    });

    const keyMoments = reviewed
        .filter((m) => ["brilliant", "great", "miss", "mistake", "blunder"].includes(m.classification))
        .map((m) => m.ply);

    return {
        version: ANALYSIS_VERSION,
        depth: meta.depth,
        tier: meta.tier,
        opening: { name: opening.name, plies: opening.plies },
        moves: reviewed,
        accuracy,
        acpl,
        estimatedRating: perSide((s) => estimateRating(acpl[s])),
        counts,
        phases,
        keyMoments,
    };
}
