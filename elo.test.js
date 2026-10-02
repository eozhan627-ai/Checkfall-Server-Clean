import test from "node:test";
import assert from "node:assert/strict";
import { calculateElo, calculateGameRatings } from "./elo.js";

test("equal ratings: win +16, loss -16, draw 0", () => {
    assert.equal(calculateElo(1000, 1000, "win"), 1016);
    assert.equal(calculateElo(1000, 1000, "loss"), 984);
    assert.equal(calculateElo(1000, 1000, "draw"), 1000);
});

test("beating a much stronger opponent gains more than beating a weaker one", () => {
    const upset = calculateElo(1000, 1400, "win") - 1000;
    const expected = calculateElo(1400, 1000, "win") - 1400;
    assert.ok(upset > expected);
    assert.equal(upset, 29);
    assert.equal(expected, 3);
});

test("rating never drops below 0", () => {
    assert.equal(calculateElo(5, 5, "loss"), 0);
});

test("game ratings are zero-sum for equal K", () => {
    const next = calculateGameRatings({ w: 1200, b: 1350 }, "w");
    assert.equal(next.w - 1200, -(next.b - 1350));
    assert.ok(next.w > 1200);
});

test("draw moves the lower-rated player up", () => {
    const next = calculateGameRatings({ w: 1000, b: 1400 }, null);
    assert.ok(next.w > 1000);
    assert.ok(next.b < 1400);
});
