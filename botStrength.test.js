import assert from "node:assert/strict";
import test from "node:test";
import { blunderChance, chooseWeightedMove, computeEloProfile } from "./botStrength.js";

// A typical position: one good move, a few ok ones, two that hang a piece.
const CANDIDATES = [
    { uci: "e2e4", cp: 40 },
    { uci: "d2d4", cp: 30 },
    { uci: "g1f3", cp: 25 },
    { uci: "a2a3", cp: -10 },
    { uci: "h2h4", cp: -40 },
    { uci: "d1h5", cp: -280 }, // hangs the queen's pawn cover - loses material
    { uci: "f3e5", cp: -320 }, // hangs a knight
];
const HANGS = new Set(["d1h5", "f3e5"]);

// Deterministic random numbers, so the test always gives the same result.
function seeded(seed) {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
    };
}

function blunderRate(elo, n = 4000) {
    const { belowFloorRatio } = computeEloProfile(elo);
    const random = seeded(elo);
    let bad = 0;
    for (let i = 0; i < n; i++) {
        if (HANGS.has(chooseWeightedMove(CANDIDATES, belowFloorRatio, random))) bad++;
    }
    return bad / n;
}

test("weak bots really blunder, stronger ones much less", () => {
    const at350 = blunderRate(350);
    const at800 = blunderRate(800);
    const at1200 = blunderRate(1200);

    assert.ok(at350 > 0.2, `350: ${at350}`);
    assert.ok(at800 < at350 && at800 > 0.08, `800: ${at800}`);
    assert.ok(at1200 < 0.08, `1200: ${at1200}`);
});

test("at engine strength there are no artificial blunders", () => {
    assert.equal(blunderChance(computeEloProfile(1500).belowFloorRatio), 0);
    assert.equal(blunderRate(1500), 0);
});
