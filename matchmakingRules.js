// Who may be paired with whom in "Find an Opponent".
// Pure functions, so they can be tested without a running server.

// Players further apart than this are never paired with each other. When no
// human fits, a computer opponent takes the seat (see housePlayer.js).
export const MAX_RATING_DIFFERENCE = 600;

// The allowed rating difference grows while a player waits.
export function matchRange(waitedSeconds) {
    if (waitedSeconds < 5) return 100;
    if (waitedSeconds < 10) return 150;
    if (waitedSeconds < 15) return 250;
    if (waitedSeconds < 20) return 400;
    return MAX_RATING_DIFFERENCE;
}

function waitedSeconds(player, now) {
    return Math.max(0, (now - player.joinedAt) / 1000);
}

// Two players fit when the rating difference is inside the range of the one
// who has waited longer. A real opponent now is worth more than a slightly
// closer one later - the app is still small.
export function ratingsFit(a, b, now = Date.now()) {
    const waited = Math.max(waitedSeconds(a, now), waitedSeconds(b, now));
    return Math.abs(a.rating - b.rating) <= matchRange(waited);
}

// Of all fitting candidates, the one closest in rating; on a tie the one who
// has waited longest. Returns null when nobody fits.
export function pickOpponent(player, candidates, now = Date.now()) {
    let best = null;

    for (const candidate of candidates) {
        if (candidate.id === player.id) continue;
        if (candidate.timeControl !== player.timeControl) continue;
        if (!ratingsFit(player, candidate, now)) continue;

        if (!best) {
            best = candidate;
            continue;
        }

        const difference = Math.abs(player.rating - candidate.rating);
        const bestDifference = Math.abs(player.rating - best.rating);

        if (difference < bestDifference || (difference === bestDifference && candidate.joinedAt < best.joinedAt)) {
            best = candidate;
        }
    }

    return best;
}
