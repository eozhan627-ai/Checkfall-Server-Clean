// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDays, playDailyMove, timeoutResult } from "./dailyChess.js";

const W = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const base = { status: "active", white_id: W, black_id: B, pgn: "", move_count: 0, days_per_move: 1 };

test("tempo is 1, 2 or 3 days", () => {
    assert.equal(normalizeDays(2), 2);
    assert.equal(normalizeDays("3"), 3);
    assert.equal(normalizeDays(30), 1);
});

test("only the player to move can move, and only legally", () => {
    assert.equal(playDailyMove(base, B, { from: "e7", to: "e5" }).error, "NOT_YOUR_TURN");
    assert.equal(playDailyMove(base, "x", { from: "e2", to: "e4" }).error, "NOT_YOUR_GAME");
    assert.equal(playDailyMove(base, W, { from: "e2", to: "e5" }).error, "ILLEGAL_MOVE");
    assert.equal(playDailyMove({ ...base, status: "finished" }, W, { from: "e2", to: "e4" }).error, "GAME_NOT_ACTIVE");

    const ok = playDailyMove(base, W, { from: "e2", to: "e4" }, Date.parse("2026-11-01T12:00:00Z"));
    assert.equal(ok.update.move_count, 1);
    assert.equal(ok.nextTurn, "b");
    assert.equal(ok.update.deadline_at, "2026-11-02T12:00:00.000Z");
    assert.equal(ok.finished, false);
});

test("checkmate finishes the game", () => {
    let game = { ...base };
    const moves = [[W, "f2", "f3"], [B, "e7", "e5"], [W, "g2", "g4"], [B, "d8", "h4"]];
    let last;
    for (const [who, from, to] of moves) {
        last = playDailyMove(game, who, { from, to });
        assert.ok(!last.error, last.error);
        game = { ...game, ...last.update };
    }
    assert.equal(last.finished, true);
    assert.equal(last.result, "0-1");
    assert.equal(game.status, "finished");
});

test("timeout: the side to move loses", () => {
    assert.equal(timeoutResult(base), "0-1");
    const after = playDailyMove(base, W, { from: "e2", to: "e4" });
    assert.equal(timeoutResult({ ...base, ...after.update }), "1-0");
});
