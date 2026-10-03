// Computer opponents in matchmaking ("house players").
//
// When no human opponent in range is found, the player gets a computer
// opponent of about the same rating. It plays on the normal game clock and
// takes a different amount of time for each move, like a person would.
// The app's Terms tell players that computer opponents may be used.
//
// Only rules live here (pure functions, tested in housePlayer.test.js). The
// engine is in houseEngine.js, the wiring in index.js.

import crypto from "crypto";

// How long a player searches before a computer opponent steps in, when no
// human in reach is searching. Only a few seconds - while the app is young
// there is often nobody else - and not a fixed number, so the start of such
// a game is not recognisable by its timing.
export function houseWaitMs(rng = Math.random) {
    return Math.round(3000 + rng() * 4000); // 3 - 7 s
}

// Same shape as a socket.io connection id.
export function houseId() {
    return crypto.randomBytes(15).toString("base64url");
}

const NAMES = [
    "milo", "jonas", "lena", "finn", "nora", "timo", "sami", "lars", "mira", "pablo",
    "enzo", "kaya", "leo", "ines", "omar", "yuki", "tara", "niko", "ben", "alex",
    "malik", "elif", "jan", "sofia", "kian", "luca", "emre", "noah", "ida", "ravi",
];

const WORDS = [
    "knight", "rook", "gambit", "blitz", "pawn", "bishop", "castle", "tempo", "fork", "endgame",
    "check", "sicilian", "zugzwang", "fianchetto", "queen", "tactics",
];

const pick = (list, rng) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
const digits = (count, rng) => String(Math.floor(rng() * 10 ** count)).padStart(count, "0");
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// An ordinary-looking nickname, at most 20 characters.
export function houseName(rng = Math.random) {
    const name = pick(NAMES, rng);
    const word = pick(WORDS, rng);
    const style = rng();

    let result;

    if (style < 0.3) result = name + digits(2, rng);
    else if (style < 0.45) result = capitalize(name) + digits(rng() < 0.6 ? 2 : 3, rng);
    else if (style < 0.6) result = name + "_" + word;
    else if (style < 0.72) result = capitalize(word) + capitalize(name);
    else if (style < 0.84) result = word + digits(2, rng);
    else if (style < 0.93) result = name + "." + word + digits(1, rng);
    else result = capitalize(name) + "_" + digits(2, rng);

    return result.slice(0, 20);
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

// Share of rematch requests the computer opponent accepts.
export const REMATCH_ACCEPT_CHANCE = 0.5;
