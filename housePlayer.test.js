// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { acceptsDraw, houseId, houseName, houseRating, houseWaitMs, resigns, thinkTimeMs } from "./housePlayer.js";

// Deterministic random numbers for the tests.
function seeded(seed = 1) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

test("a computer opponent steps in after 24 to 36 seconds", () => {
    const rng = seeded(7);
    for (let i = 0; i < 200; i++) {
        const wait = houseWaitMs(rng);
        assert.ok(wait >= 24_000 && wait <= 36_000, String(wait));
    }
});

test("names look like ordinary nicknames", () => {
    const rng = seeded(3);
    const names = new Set();

    for (let i = 0; i < 500; i++) {
        const name = houseName(rng);
        names.add(name);
        assert.match(name, /^[A-Za-z0-9_.]{3,20}$/, name);
        assert.doesNotMatch(name, /bot|computer|engine|stockfish|house/i, name);
    }

    assert.ok(names.size > 300, `only ${names.size} different names`);
    assert.equal(houseId().length, 20);
    assert.notEqual(houseId(), houseId());
});

test("the rating is close to the player's, never the same", () => {
    const rng = seeded(11);
    for (const rating of [100, 400, 1000, 1500, 2000, 3000]) {
        for (let i = 0; i < 100; i++) {
            const value = houseRating(rating, rng);
            assert.ok(Math.abs(value - rating) <= 70, `${rating} -> ${value}`);
            assert.ok(value >= 100 && value <= 3000);
            if (rating > 100 && rating < 3000) assert.notEqual(value, rating);
        }
    }
});

test("thinking times vary and fit the time control", () => {
    const rng = seeded(5);
    const blitz = { baseMs: 300_000, incrementMs: 2000 };
    const times = [];

    for (let i = 0; i < 400; i++) {
        times.push(thinkTimeMs({ ...blitz, ply: 24, remainingMs: 240_000, legalMoves: 30, rng }));
    }

    const min = Math.min(...times);
    const max = Math.max(...times);
    const average = times.reduce((a, b) => a + b, 0) / times.length;

    assert.ok(min >= 400, `min ${min}`);
    assert.ok(max >= 12_000, `no long think: max ${max}`);
    assert.ok(max <= 240_000 * 0.12 + 1000, `max ${max}`);
    assert.ok(average > 3000 && average < 9000, `average ${average}`);
    assert.ok(new Set(times).size > 300, "times repeat too often");
});

test("opening moves and forced moves are quick", () => {
    const rng = seeded(9);
    const blitz = { baseMs: 300_000, incrementMs: 2000, remainingMs: 290_000 };

    for (let i = 0; i < 200; i++) {
        assert.ok(thinkTimeMs({ ...blitz, ply: 4, legalMoves: 28, rng }) <= 3000);
        assert.ok(thinkTimeMs({ ...blitz, ply: 30, legalMoves: 1, rng }) <= 1300);
        assert.ok(thinkTimeMs({ ...blitz, ply: 30, legalMoves: 25, recapture: true, rng }) <= 3600);
    }
});

test("it does not lose on time by thinking", () => {
    const rng = seeded(13);

    for (const [baseMs, incrementMs] of [[60_000, 0], [180_000, 0], [300_000, 2000], [1_800_000, 0]]) {
        // A whole game: 60 own moves from a full clock.
        let remaining = baseMs;
        for (let move = 0; move < 60; move++) {
            const time = thinkTimeMs({ baseMs, incrementMs, ply: move * 2, remainingMs: remaining, legalMoves: 30, rng });
            assert.ok(time < remaining, `${baseMs}+${incrementMs}: ${time} >= ${remaining} at move ${move}`);
            remaining = remaining - time + incrementMs;
        }
        assert.ok(remaining > 0);
    }

    for (let i = 0; i < 200; i++) {
        assert.ok(thinkTimeMs({ baseMs: 300_000, incrementMs: 0, ply: 80, remainingMs: 6000, legalMoves: 30, rng }) <= 700);
        assert.ok(thinkTimeMs({ baseMs: 60_000, incrementMs: 0, ply: 80, remainingMs: 300, legalMoves: 30, rng }) <= 250);
    }
});

test("bullet is played faster than rapid", () => {
    const average = (baseMs) => {
        const rng = seeded(21);
        let sum = 0;
        for (let i = 0; i < 300; i++) sum += thinkTimeMs({ baseMs, incrementMs: 0, ply: 30, remainingMs: baseMs * 0.7, legalMoves: 30, rng });
        return sum / 300;
    };

    assert.ok(average(60_000) < 1500);
    assert.ok(average(600_000) > average(60_000) * 4);
});

test("draw offers: taken when worse or level late in the game", () => {
    assert.equal(acceptsDraw({ scoreCp: null, ply: 50 }), false);
    assert.equal(acceptsDraw({ scoreCp: 0, ply: 12 }), false);
    assert.equal(acceptsDraw({ scoreCp: 0, ply: 44 }), true);
    assert.equal(acceptsDraw({ scoreCp: 200, ply: 44 }), false);
    assert.equal(acceptsDraw({ scoreCp: -300, ply: 12 }), true);
});

test("only stronger players resign, and only lost games", () => {
    const always = () => 0;
    assert.equal(resigns({ rating: 900, lostTurns: 9, ply: 60, rng: always }), false);
    assert.equal(resigns({ rating: 1500, lostTurns: 2, ply: 60, rng: always }), false);
    assert.equal(resigns({ rating: 1500, lostTurns: 3, ply: 20, rng: always }), false);
    assert.equal(resigns({ rating: 1500, lostTurns: 3, ply: 60, rng: always }), true);
    assert.equal(resigns({ rating: 1500, lostTurns: 3, ply: 60, rng: () => 0.9 }), false);
});
