import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import {
    buildGame,
    buildReview,
    classifyMove,
    estimateRating,
    moveAccuracy,
    sacrificedMaterial,
    scoreToCp,
    terminalEvaluation,
    winPct,
} from "./analysisCore.js";
import { matchOpening, OPENING_LINES } from "./openingBook.js";

const base = {
    winBefore: 50,
    winAfter: 50,
    winSecond: null,
    isBest: false,
    isBook: false,
    isForced: false,
    sacrifice: 0,
    isRecapture: false,
    opponentLoss: 0,
    hadMate: false,
    keptMate: false,
};

test("every opening line is a legal sequence of moves", () => {
    for (const [name, moves] of OPENING_LINES) {
        const game = new Chess();
        for (const san of moves.split(" ")) {
            let played = null;
            try {
                played = game.move(san);
            } catch {
                played = null;
            }
            assert.ok(played, `${name}: "${san}" is not legal in "${moves}"`);
            assert.equal(played.san, san, `${name}: "${san}" should be written "${played.san}"`);
        }
    }
});

test("opening names", () => {
    assert.deepEqual(matchOpening("e4 c5 Nf3".split(" ")), { name: "Sicilian Defense", plies: 3 });
    assert.equal(
        matchOpening("e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6".split(" ")).name,
        "Sicilian Defense, Najdorf Variation"
    );
    assert.deepEqual(matchOpening(["h4"]), { name: null, plies: 0 });
});

test("win chance and accuracy curves", () => {
    assert.equal(winPct(0), 50);
    assert.ok(winPct(300) > 74 && winPct(300) < 76);
    assert.ok(Math.abs(winPct(200) + winPct(-200) - 100) < 1e-9);
    assert.equal(Math.round(moveAccuracy(0)), 100);
    assert.ok(moveAccuracy(20) < 45);
    assert.equal(estimateRating(null), null);
    assert.ok(estimateRating(15) > estimateRating(80));
});

test("mate scores sort correctly", () => {
    assert.ok(scoreToCp({ cp: null, mate: 2 }) > scoreToCp({ cp: null, mate: 7 }));
    assert.ok(scoreToCp({ cp: null, mate: 7 }) > scoreToCp({ cp: 2500, mate: null }));
    assert.ok(scoreToCp({ cp: null, mate: -1 }) < scoreToCp({ cp: -2500, mate: null }));
    assert.equal(scoreToCp(terminalEvaluation("checkmate")), -10000);
    assert.equal(scoreToCp(terminalEvaluation("draw")), 0);
});

test("labels: from book to blunder", () => {
    assert.equal(classifyMove({ ...base, isBook: true, winAfter: 10 }), "book");
    assert.equal(classifyMove({ ...base, isForced: true }), "forced");
    assert.equal(classifyMove({ ...base, isBest: true }), "best");
    assert.equal(classifyMove({ ...base, winAfter: 48.5 }), "excellent");
    assert.equal(classifyMove({ ...base, winAfter: 46 }), "good");
    assert.equal(classifyMove({ ...base, winAfter: 43 }), "inaccuracy");
    assert.equal(classifyMove({ ...base, winAfter: 35 }), "mistake");
    assert.equal(classifyMove({ ...base, winAfter: 20 }), "blunder");
});

test("labels: brilliant, great and miss", () => {
    // sound piece sacrifice in a balanced position
    assert.equal(classifyMove({ ...base, isBest: true, sacrifice: 3, winAfter: 55 }), "brilliant");
    // not when already winning easily ... unless a rook or queen is given
    assert.equal(classifyMove({ ...base, isBest: true, sacrifice: 3, winBefore: 97, winAfter: 97 }), "best");
    assert.equal(classifyMove({ ...base, isBest: true, sacrifice: 9, winBefore: 99, winAfter: 99 }), "brilliant");
    // a sacrifice that loses is not brilliant
    assert.equal(classifyMove({ ...base, sacrifice: 3, winAfter: 20 }), "blunder");

    // the only move that holds
    assert.equal(classifyMove({ ...base, isBest: true, winSecond: 30 }), "great");
    assert.equal(classifyMove({ ...base, isBest: true, winSecond: 30, isRecapture: true }), "best");

    // opponent blundered, reply lets them escape
    assert.equal(classifyMove({ ...base, winBefore: 85, winAfter: 60, opponentLoss: 30 }), "miss");
    // forced mate thrown away but still better
    assert.equal(classifyMove({ ...base, winBefore: 100, winAfter: 90, hadMate: true }), "miss");
    // really losing afterwards is a blunder, not a miss
    assert.equal(classifyMove({ ...base, winBefore: 85, winAfter: 15, opponentLoss: 30 }), "blunder");
});

test("sacrifice detection", () => {
    // Opera game 16.Qb8+: the queen can simply be taken
    const game = new Chess("4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 1 16");
    const move = game.move("Qb8+");
    assert.equal(sacrificedMaterial(game.fen(), move), 9);

    // a normal developing move gives nothing away
    const quiet = new Chess();
    const nf3 = quiet.move("Nf3");
    assert.equal(sacrificedMaterial(quiet.fen(), nf3), 0);
});

test("full review of a short game with hand-made evaluations", () => {
    // 1.f3 e5 2.g4 Qh4#  (fool's mate)
    const game = buildGame("1. f3 e5 2. g4 Qh4#");
    assert.equal(game.moves.length, 4);
    assert.equal(game.positions[4].terminal, "checkmate");

    const E = (cp, bestMove, extra = {}) => ({ cp, mate: null, second: null, bestMove, pv: [bestMove], depth: 12, ...extra });

    const evaluations = [
        E(30, "e2e4"), // start, white to move
        E(60, "e7e5"), // after f3: black is a bit better
        E(-60, "d2d4"), // after e5, white to move
        { cp: null, mate: 1, second: { cp: 100, mate: null }, bestMove: "d8h4", pv: ["d8h4"], depth: 12 }, // after g4: black mates
        terminalEvaluation("checkmate"),
    ];

    const review = buildReview(game, evaluations, { depth: 12, tier: "diamond" });

    assert.equal(review.version, 2);
    assert.deepEqual(review.moves.map((m) => m.classification), ["inaccuracy", "best", "blunder", "best"]);

    const mate = review.moves[3];
    assert.equal(mate.mate, 0);
    assert.equal(mate.mateFor, "b");
    assert.equal(mate.evalCp, -10000);

    const g4 = review.moves[2];
    assert.equal(g4.bestSan, "d4");
    assert.equal(g4.mate, 1);
    assert.equal(g4.mateFor, "b");
    assert.deepEqual(g4.reply, ["Qh4#"]);

    assert.ok(review.accuracy.b > review.accuracy.w);
    assert.equal(review.counts.w.blunder, 1);
    assert.deepEqual(review.keyMoments, [2]);
});

test("a played move that beats the engine's choice counts as best", () => {
    const game = buildGame("1. e4 e5");
    const E = (cp, bestMove) => ({ cp, mate: null, second: null, bestMove, pv: [bestMove], depth: 10 });

    // engine preferred d4 (+20) but after e4 the position is +40 for White
    const review = buildReview(game, [E(20, "d2d4"), E(-40, "c7c5"), E(35, "g1f3")], { depth: 10, tier: "gold" });

    // (both are book moves here, so check the data instead of the label)
    assert.equal(review.moves[0].bestMove, "e2e4");
    assert.equal(review.moves[0].loss, 0);
});
