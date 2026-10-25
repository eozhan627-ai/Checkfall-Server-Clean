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

// Version of the numbers that sum a game up (accuracy, "played like").
// They are computed from the stored moves, so a review saved with an older
// version is brought up to date without asking the engine again
// (see rescoreReview).
export const SCORING_VERSION = 2;

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
// THE WHOLE GAME: ACCURACY AND "PLAYED LIKE"
// =============================

// Accuracy of a set of moves: [{ accuracy, weight }] -> 0-100.
//
// A plain average is far too friendly. Most moves of a game are easy (theory,
// recaptures, a position that is already won or lost), so even a game with
// several blunders ends up near 90 and every player looks alike. Lichess
// solves it like this, and so do we:
//   - an average in which a move counts more the more was at stake around it
//   - the harmonic mean, which bad moves pull down hard
// and the result is the middle of the two.
export function combinedAccuracy(items) {
    if (items.length === 0) return null;

    let weightSum = 0;
    let weighted = 0;
    let inverse = 0;

    for (const { accuracy, weight } of items) {
        weightSum += weight;
        weighted += weight * accuracy;
        inverse += 1 / Math.max(1, accuracy);
    }

    return (weighted / weightSum + items.length / inverse) / 2;
}

// How much was at stake around every move: the spread of the win chances
// over the last few positions, 0.5 (nothing going on) to 12 (wild).
//
// @param {Array<{color:string, winBefore:number, winAfter:number}>} moves
//        win chances of the mover (0-100) before and after the move
export function moveWeights(moves) {
    if (moves.length === 0) return [];

    // Win chance from White's point of view: start, then after every move.
    const white = [moves[0].color === "w" ? moves[0].winBefore : 100 - moves[0].winBefore];
    for (const move of moves) {
        white.push(move.color === "w" ? move.winAfter : 100 - move.winAfter);
    }

    // Longer games look at more positions at once.
    const size = Math.max(2, Math.min(8, Math.floor(moves.length / 10)));

    return moves.map((_, index) => {
        // The window ends with the position after the move.
        const start = Math.max(0, index + 2 - size);
        const window = white.slice(start, start + size);

        const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
        const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length;

        return Math.max(0.5, Math.min(12, Math.sqrt(variance)));
    });
}

// ---- "played like" ----
// The numbers below were measured on games of players whose rating is known
// (online games of club players rated about 1100 to 1950 on Lichess, and
// well-known master games), analysed the way the server does it.

// Long games look more accurate than short ones: whoever is still playing
// after 60 moves has made many easy moves in a decided position, while a game
// that is over after 15 moves consists of little but its mistakes. The gap to
// 100 shrinks with the length of the game; this puts every game on the
// footing of a typical one.
const TYPICAL_MOVES = 34;
const LENGTH_EXPONENT = 0.4;

function accuracyAtTypicalLength(accuracy, moves) {
    const length = Math.max(10, Math.min(60, moves));
    return 100 - (100 - accuracy) * Math.pow(length / TYPICAL_MOVES, LENGTH_EXPONENT);
}

// Accuracy (of a game of typical length) -> the rating at which players
// reach it on average, on the scale the app uses for its ratings
// (beginner 400 ... expert 2000).
const RATING_BY_ACCURACY = [
    [40, 100],
    [50, 220],
    [60, 400],
    [70, 730],
    [75, 970],
    [80, 1250],
    [85, 1560],
    [90, 1920],
    [93, 2250],
    [95, 2500],
    [97, 2750],
    [100, 3000],
];

/**
 * What one game on its own looked like, as a rating.
 *
 * @param {number} accuracy accuracy of the player in the game
 * @param {number} moves    number of moves the player made
 */
export function performanceRating(accuracy, moves) {
    const table = RATING_BY_ACCURACY;
    const value = accuracyAtTypicalLength(accuracy, moves);

    if (value <= table[0][0]) return table[0][1];

    for (let i = 1; i < table.length; i++) {
        const [a0, r0] = table[i - 1];
        const [a1, r1] = table[i];
        if (value <= a1) return r0 + ((value - a0) / (a1 - a0)) * (r1 - r0);
    }

    return table[table.length - 1][1];
}

// A single game says little about a player: the same person is easily 10 to
// 15 points of accuracy better or worse from one game to the next. So the
// estimate starts at the rating the player is known to have and only moves
// part of the way towards what this game looked like - further the more
// moves there were.
const TRUST_HALF_MOVES = 30; // own moves after which the game counts half
const TRUST_MAX = 0.65;
const UNKNOWN_RATING = 1000; // start rating of a new player

/**
 * "Played like": rough playing strength shown for one game.
 * Only an estimate - shown as such in the app.
 *
 * @param {object} p
 * @param {number|null} p.accuracy  accuracy of the player in this game
 * @param {number} p.moves          number of moves the player made
 * @param {number|null} [p.rating]  rating the player is known to have
 */
export function estimateRating({ accuracy, moves, rating = null }) {
    if (accuracy === null || !Number.isFinite(accuracy) || !moves) return null;

    const known = Number.isFinite(rating) ? rating : UNKNOWN_RATING;
    const trust = Math.min(TRUST_MAX, moves / (moves + TRUST_HALF_MOVES));
    const estimate = known + trust * (performanceRating(accuracy, moves) - known);

    return Math.max(100, Math.min(3200, Math.round(estimate / 50) * 50));
}

// The level of a practice bot is only stored in its name: "Stockfish (1200)".
// A name without a number is the engine at full strength.
export function botLevel(name) {
    if (typeof name !== "string" || !name) return null;

    const level = /\((\d{2,4})\)/.exec(name);
    return level ? Number(level[1]) : 3200;
}

/**
 * The ratings the two players are known to have, for estimateRating().
 *
 * @param {object} p
 * @param {"w"|"b"|null} p.playerColor colour the user played, if known
 * @param {number|null} p.userRating       rating of the user
 * @param {number|null} [p.opponentRating] rating of an opponent with an account
 * @param {string|null} [p.mode]           "bot" | "online" | ...
 * @param {string|null} [p.opponentName]
 */
export function knownRatings({ playerColor, userRating, opponentRating = null, mode = null, opponentName = null }) {
    const user = Number.isFinite(userRating) ? userRating : null;

    // Old games do not say which side the user had.
    if (playerColor !== "w" && playerColor !== "b") return { w: user, b: user };

    // No account on the other side: a bot has its level, and an opponent from
    // matchmaking was picked because they are about as strong as the user.
    const opponent =
        (Number.isFinite(opponentRating) ? opponentRating : null) ??
        (mode === "bot" ? botLevel(opponentName) : null) ??
        user;

    return playerColor === "w" ? { w: user, b: opponent } : { w: opponent, b: user };
}

/**
 * Everything the review says about the game as a whole, from its moves.
 *
 * @param {Array<{color:string, winBefore:number, winAfter:number, accuracy:number, phase?:string}>} moves
 * @param {{ w?: number|null, b?: number|null }} [ratings] ratings the two
 *        players are known to have (see estimateRating)
 */
export function summarizeGame(moves, ratings = {}) {
    const weights = moveWeights(moves);
    const perSide = (fn) => ({ w: fn("w"), b: fn("b") });

    const items = (side, phase = null) =>
        moves
            .map((move, index) => ({ move, weight: weights[index] }))
            .filter(({ move }) => move.color === side && (phase === null || move.phase === phase))
            .map(({ move, weight }) => ({ accuracy: move.accuracy, weight }));

    const rounded = (value) => (value === null ? null : round1(value));

    const accuracy = perSide((side) => rounded(combinedAccuracy(items(side))));

    const phases = perSide((side) => {
        const out = {};
        for (const phase of ["opening", "middlegame", "endgame"]) {
            out[phase] = rounded(combinedAccuracy(items(side, phase)));
        }
        return out;
    });

    const estimatedRating = perSide((side) =>
        estimateRating({
            accuracy: accuracy[side],
            moves: moves.filter((move) => move.color === side).length,
            rating: ratings?.[side] ?? null,
        })
    );

    return { accuracy, phases, estimatedRating };
}

/**
 * Brings the summary numbers of a stored review up to date. The moves are
 * left alone, so no engine is needed.
 */
export function rescoreReview(review, ratings = {}) {
    return {
        ...review,
        ...summarizeGame(review.moves, ratings),
        scoring: SCORING_VERSION,
    };
}

// =============================
// FULL REVIEW
// =============================

/**
 * @param {ReturnType<typeof buildGame>} game
 * @param {Array<{cp:number|null, mate:number|null, second:{cp:number|null,mate:number|null}|null, bestMove:string|null, pv:string[], depth:number}>} evaluations
 *        one per position, from the side to move's point of view
 * @param {{ depth: number, tier: string, ratings?: { w?: number|null, b?: number|null } }} meta
 *        ratings: what the two players are rated (for "played like")
 */
export function buildReview(game, evaluations, meta) {
    const { moves, opening } = game;

    const reviewed = [];
    const counts = { w: {}, b: {} };
    const cpLossSum = { w: 0, b: 0 };
    const moveCount = { w: 0, b: 0 };

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
        cpLossSum[side] += cpLoss;
        moveCount[side] += 1;

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

    const acpl = perSide((s) => (moveCount[s] ? Math.round(cpLossSum[s] / moveCount[s]) : null));

    // From the moves exactly as they are stored, so that rescoreReview()
    // gets the same numbers later.
    const { accuracy, phases, estimatedRating } = summarizeGame(reviewed, meta.ratings);

    const keyMoments = reviewed
        .filter((m) => ["brilliant", "great", "miss", "mistake", "blunder"].includes(m.classification))
        .map((m) => m.ply);

    return {
        version: ANALYSIS_VERSION,
        scoring: SCORING_VERSION,
        depth: meta.depth,
        tier: meta.tier,
        opening: { name: opening.name, plies: opening.plies },
        moves: reviewed,
        accuracy,
        acpl,
        estimatedRating,
        counts,
        phases,
        keyMoments,
    };
}
