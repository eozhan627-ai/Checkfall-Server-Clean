// Computer opponents in matchmaking ("house players").
//
// When no human opponent in range is found, the player is OFFERED a computer
// opponent of about the same rating. It is always shown as a bot ("POVCheck
// Bot"), the player has to accept it, and the game does not count for the
// rating. It plays on the normal game clock with a natural pace, so the game
// feels like a real blitz game.
//
// Only rules live here (pure functions, tested in housePlayer.test.js). The
// engine is in houseEngine.js, the wiring in index.js.

import crypto from "crypto";

// How long a player searches before the app offers a bot game, when no
// human in reach is searching. The search keeps running after the offer.
export const BOT_OFFER_AFTER_MS = 6_500; // same as the offer card in the app (app/game/waiting.tsx)

export function houseWaitMs() {
    return BOT_OFFER_AFTER_MS;
}

// Same shape as a socket.io connection id.
export function houseId() {
    return crypto.randomBytes(15).toString("base64url");
}

// Shown everywhere as a bot - never as a person.
export const BOT_NAME = "POVCheck Bot";

export function houseName() {
    return BOT_NAME;
}

// Close to the player's rating, but not identical.
export function houseRating(playerRating, rng = Math.random) {
    const base = Number.isFinite(playerRating) ? playerRating : 1000;
    let offset = Math.round((rng() * 2 - 1) * 70);
    if (offset === 0) offset = rng() < 0.5 ? -7 : 9;

    return Math.max(100, Math.min(3000, Math.round(base + offset)));
}

// How long the computer opponent "thinks" about one move.
//
//   ply          half-moves played so far
//   remainingMs  its own clock
//   baseMs       starting time of the time control
//   incrementMs  increment per move
//   legalMoves   number of legal moves
//   recapture    the opponent just captured something
//   inCheck      it is in check
export function thinkTimeMs({
    ply = 0,
    remainingMs,
    baseMs,
    incrementMs = 0,
    legalMoves = 20,
    recapture = false,
    inCheck = false,
    rng = Math.random,
}) {
    // Roughly what a player can spend per move in this time control.
    const pace = Math.min(11_000, baseMs / 50 + incrementMs * 0.7);

    let time;

    if (legalMoves <= 1) {
        // Only one move: played quickly.
        time = Math.min(1300, pace * (0.08 + rng() * 0.15));
    } else if (ply < 10) {
        // Opening moves come from memory.
        time = Math.min(3000, pace * (0.12 + rng() * 0.3));
    } else if (recapture || inCheck || legalMoves <= 3) {
        // Obvious replies.
        time = Math.min(3500, pace * (0.12 + rng() * 0.4));
    } else {
        const kind = rng();

        if (kind < 0.55) time = pace * (0.2 + rng() * 0.5); // normal move
        else if (kind < 0.88) time = pace * (0.7 + rng() * 0.9); // has to look twice
        else time = pace * (1.6 + rng() * 2.2); // a real think
    }

    // Never burn the clock: at most a share of what is left ...
    const ceiling = remainingMs * 0.12 + incrementMs * 0.5;
    time = Math.min(time, ceiling);

    // ... and in time trouble the moves come fast.
    if (remainingMs < 10_000) {
        time = Math.min(time, 200 + rng() * 500);
    }
    if (remainingMs < 3000) {
        time = Math.min(time, 100 + rng() * 150);
    }

    const floor = baseMs <= 120_000 ? 250 : 400;

    return Math.round(Math.max(Math.min(floor, remainingMs * 0.5), time));
}

// Answer to a draw offer. scoreCp is the engine's view for the computer
// opponent (positive = it is better), null when unknown.
export function acceptsDraw({ scoreCp, ply }) {
    if (!Number.isFinite(scoreCp)) return false;
    if (scoreCp <= -150) return true; // clearly worse: glad to take it
    return ply >= 30 && scoreCp <= 40; // level game that has gone on a while
}

// Stronger players give up lost games, beginners play on until mate.
export function resigns({ rating, lostTurns, ply, rng = Math.random }) {
    if (rating < 1200) return false;
    if (ply < 30 || lostTurns < 3) return false;
    return rng() < 0.5;
}

// The score at which a position counts as lost for the resign rule above.
export const LOST_SCORE_CP = -900;

// Share of rematch requests the computer opponent accepts (a bot always
// plays another game).
export const REMATCH_ACCEPT_CHANCE = 1;
