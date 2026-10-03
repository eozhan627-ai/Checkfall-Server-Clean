// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_RATING_DIFFERENCE, matchRange, pickOpponent, ratingsFit } from "./matchmakingRules.js";

const NOW = 1_000_000;
const player = (id, rating, waitedSeconds = 0, timeControl = "5+2") => ({
    id,
    rating,
    timeControl,
    joinedAt: NOW - waitedSeconds * 1000,
});

test("the rating range grows while waiting and stops at the maximum", () => {
    assert.equal(matchRange(0), 100);
    assert.equal(matchRange(7), 150);
    assert.equal(matchRange(12), 250);
    assert.equal(matchRange(17), 400);
    assert.equal(matchRange(25), MAX_RATING_DIFFERENCE);
    assert.equal(matchRange(600), MAX_RATING_DIFFERENCE);
});

test("close ratings are paired at once", () => {
    assert.equal(ratingsFit(player("a", 1000), player("b", 1080), NOW), true);
    assert.equal(ratingsFit(player("a", 1000), player("b", 1150), NOW), false);
});

test("the player who waited longer decides the range", () => {
    // 500 points apart: fits as soon as one of the two has waited 20 seconds.
    assert.equal(ratingsFit(player("a", 1000, 12), player("b", 1500, 2), NOW), false);
    assert.equal(ratingsFit(player("a", 1000, 25), player("b", 1500, 0), NOW), true);
    assert.equal(ratingsFit(player("a", 1000, 0), player("b", 1500, 25), NOW), true);
});

test("players too far apart are never paired", () => {
    assert.equal(ratingsFit(player("a", 1000, 25), player("b", 2000, 25), NOW), false);
    assert.equal(ratingsFit(player("a", 1000, 900), player("b", 1601, 900), NOW), false);
    assert.equal(ratingsFit(player("a", 1000, 900), player("b", 1600, 900), NOW), true);
});

test("the closest fitting opponent is chosen", () => {
    const me = player("me", 1000, 40);
    const queue = [player("far", 1600, 50), player("near", 1100, 1), player("mid", 1400, 10), me];

    assert.equal(pickOpponent(me, queue, NOW).id, "near");
});

test("on a tie the player who waited longer is chosen", () => {
    const me = player("me", 1000);
    const queue = [player("new", 1050, 1), player("old", 950, 9)];

    assert.equal(pickOpponent(me, queue, NOW).id, "old");
});

test("different time controls are never paired", () => {
    const me = player("me", 1000, 120, "3+0");

    assert.equal(pickOpponent(me, [player("other", 1000, 120, "5+2")], NOW), null);
    assert.equal(pickOpponent(me, [me], NOW), null);
    assert.equal(pickOpponent(me, [], NOW), null);
});
