// Elo calculation for rated PvP games. Kept in its own module so it can
// be unit-tested without starting the server.

export const ELO_K_FACTOR = 32;

/**
 * @param {number} playerRating
 * @param {number} opponentRating
 * @param {"win" | "loss" | "draw"} result result from the player's point of view
 * @returns {number} the player's new rating
 */
export function calculateElo(playerRating, opponentRating, result) {
    const expectedScore =
        1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));

    const actualScore = result === "win" ? 1 : result === "draw" ? 0.5 : 0;

    const change = Math.round(ELO_K_FACTOR * (actualScore - expectedScore));

    return Math.max(0, playerRating + change);
}

/**
 * New ratings for both sides of a finished game.
 *
 * @param {{ w: number, b: number }} ratings
 * @param {"w" | "b" | null} winnerColor null = draw
 */
export function calculateGameRatings(ratings, winnerColor) {
    const resultFor = (color) =>
        winnerColor === null ? "draw" : winnerColor === color ? "win" : "loss";

    return {
        w: calculateElo(ratings.w, ratings.b, resultFor("w")),
        b: calculateElo(ratings.b, ratings.w, resultFor("b")),
    };
}
