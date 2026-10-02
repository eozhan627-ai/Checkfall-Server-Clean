import { supabaseAdmin } from "./supabaseAdmin.js";

import {
    createEnginePool,
    closeEnginePool,
    evaluatePositionsInParallel,
    getPoolSize,
} from "./stockfishEngine.js";
import {
    ANALYSIS_VERSION,
    buildGame,
    buildReview,
    scoreToCp,
    terminalEvaluation,
} from "./analysisCore.js";

// =============================
// SPEED / QUALITY PER VIP TIER
// =============================
// The engine gets a time budget for the WHOLE game instead of a fixed time
// per move: short games are analysed deeper, long games do not take forever.
//   depth      upper limit for the search depth
//   budgetMs   target duration of the whole analysis
//   maxMs      upper limit per position
const PROFILE_BY_TIER = {
    silver: { depth: 14, budgetMs: 18000, maxMs: 700 },
    gold: { depth: 16, budgetMs: 22000, maxMs: 900 },
    diamond: { depth: 22, budgetMs: 30000, maxMs: 1500 },
};

const MIN_MOVETIME_MS = 200;
// Positions that are still opening theory only need a quick look.
const BOOK_MOVETIME_MS = 150;

// > 1 = slower but deeper, < 1 = faster. For tuning on the real server.
const TIME_FACTOR = Number(process.env.ANALYSIS_TIME_FACTOR) || 1;

// How many games may be analysed at the same time. Every analysis starts
// its own engines, so this protects small servers.
const MAX_CONCURRENT = Number(process.env.ANALYSIS_MAX_CONCURRENT) || 2;

// =============================
// QUEUE
// =============================

let activeCount = 0;
const waiting = [];

function acquireSlot(onQueued) {
    if (activeCount < MAX_CONCURRENT) {
        activeCount += 1;
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        waiting.push(resolve);
        onQueued?.(waiting.length);
    });
}

function releaseSlot() {
    const next = waiting.shift();
    if (next) next();
    else activeCount -= 1;
}

// gameId -> Set of sockets waiting for the result. A second request for a
// game that is already being analysed just joins the first one.
const running = new Map();

function emitToGame(gameId, event, payload) {
    const sockets = running.get(gameId);
    if (!sockets) return;

    for (const socket of sockets) {
        if (socket.connected) socket.emit(event, payload);
    }
}

// =============================
// SOCKET HANDLER
// =============================

export function setupAnalysisHandlers(io) {
    io.on("connection", (socket) => {
        socket.on("analyze_game", async (payload, ack) => {
            const gameId = payload?.gameId;

            try {
                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");
                if (typeof gameId !== "string" || !gameId) throw new Error("GAME_NOT_FOUND");

                const { data: game } = await supabaseAdmin
                    .from("games")
                    .select("*")
                    .eq("id", gameId)
                    .maybeSingle();

                if (!game || game.user_id !== authId) throw new Error("GAME_NOT_FOUND");

                const { data: profile } = await supabaseAdmin
                    .from("profiles")
                    .select("vip_tier, username, rating, avatar")
                    .eq("id", authId)
                    .maybeSingle();

                const tier = profile?.vip_tier || "none";
                const settings = PROFILE_BY_TIER[tier];
                if (!settings) throw new Error("NOT_VIP");

                // Stored result in the current format: nothing to compute.
                if (
                    game.analyzed &&
                    game.analysis &&
                    game.analysis.version === ANALYSIS_VERSION &&
                    !payload?.force
                ) {
                    if (typeof ack === "function") ack({ ok: true, started: false, cached: true });
                    socket.emit("analysis_complete", { gameId, analysis: game.analysis });
                    return;
                }

                // Already running (e.g. the screen was opened twice): join it.
                if (running.has(gameId)) {
                    running.get(gameId).add(socket);
                    if (typeof ack === "function") ack({ ok: true, started: true, joined: true });
                    return;
                }

                running.set(gameId, new Set([socket]));

                if (typeof ack === "function") ack({ ok: true, started: true });

                // The colour the user played. Older games do not have it
                // stored, then the app sends it along.
                const playerColor = ["w", "b"].includes(game.player_color)
                    ? game.player_color
                    : ["w", "b"].includes(payload?.playerColor)
                        ? payload.playerColor
                        : null;

                runAnalysis({ gameId, game, authId, profile, settings, tier, playerColor })
                    .catch((error) => {
                        console.log("ANALYSIS ERROR:", error);
                        emitToGame(gameId, "analysis_error", { gameId, error: "ANALYSIS_FAILED" });
                    })
                    .finally(() => {
                        running.delete(gameId);
                    });
            } catch (error) {
                console.log("ANALYZE_GAME ERROR:", error.message);
                if (typeof ack === "function") ack({ ok: false, error: error.message });
            }
        });

        socket.on("disconnect", () => {
            for (const sockets of running.values()) sockets.delete(socket);
        });
    });
}

// =============================
// PLAYER NAMES FOR THE REVIEW
// =============================

async function loadPlayers({ game, profile, playerColor }) {
    if (!playerColor) return null;

    const me = {
        name: profile?.username || "You",
        rating: profile?.rating ?? null,
        avatar: profile?.avatar || null,
        isUser: true,
    };

    let opponent = { name: "Opponent", rating: null, avatar: null, isUser: false };

    if (game.mode === "bot") {
        opponent.name = game.opponent_name || "Stockfish";
    } else if (game.opponent_id) {
        const { data } = await supabaseAdmin
            .from("profiles")
            .select("username, rating, avatar")
            .eq("id", game.opponent_id)
            .maybeSingle();

        if (data) {
            opponent = {
                name: data.username || "Opponent",
                rating: data.rating ?? null,
                avatar: data.avatar || null,
                isUser: false,
            };
        }
    } else if (game.opponent_name) {
        opponent.name = game.opponent_name;
    }

    return playerColor === "w"
        ? { white: me, black: opponent }
        : { white: opponent, black: me };
}

// =============================
// ANALYSIS
// =============================

async function runAnalysis({ gameId, game, authId, profile, settings, tier, playerColor }) {
    const parsed = buildGame(game.pgn);
    const { positions, moves, opening } = parsed;

    if (moves.length === 0) throw new Error("EMPTY_GAME");

    const total = positions.length;

    // What the app shows next to the progress bar for a position.
    const describe = (index) => {
        if (index === 0) return { ply: -1, moveNumber: 0, color: "w", san: "Start" };
        const move = moves[index - 1];
        return { ply: move.ply, moveNumber: move.moveNumber, color: move.color, san: move.san };
    };

    await acquireSlot((position) => {
        emitToGame(gameId, "analysis_progress", {
            gameId,
            progress: 0,
            total,
            queued: true,
            queuePosition: position,
            active: [],
        });
    });

    let evaluations;
    let reachedDepth = 0;

    try {
        emitToGame(gameId, "analysis_progress", { gameId, progress: 0, total, active: [] });

        const engines = await createEnginePool();

        try {
            // Share the time budget between the positions that need a real search.
            const searchPositions = positions.filter(
                (p, index) => !p.terminal && index >= opening.plies
            ).length;

            const perPosition =
                (settings.budgetMs * TIME_FACTOR * engines.length) / Math.max(1, searchPositions);

            const movetime = Math.round(
                Math.max(MIN_MOVETIME_MS, Math.min(settings.maxMs * TIME_FACTOR, perPosition))
            );

            const tasks = positions.map((position, index) => {
                if (position.terminal) {
                    return { fen: position.fen, skip: terminalEvaluation(position.terminal) };
                }

                // Position `index` is the one BEFORE move `index`. It only
                // decides the label of a book move, so a short look is enough.
                const isBook = index < opening.plies;

                return {
                    fen: position.fen,
                    depth: isBook ? Math.min(settings.depth, 12) : settings.depth,
                    movetime: isBook ? Math.min(movetime, BOOK_MOVETIME_MS) : movetime,
                };
            });

            const active = new Map(); // engine index -> position index
            let depthSum = 0;
            let depthCount = 0;

            evaluations = await evaluatePositionsInParallel(engines, tasks, {
                onStart: (index, engineIndex) => {
                    active.set(engineIndex, index);
                },
                onResult: (index, result, done) => {
                    if (result.depth) {
                        depthSum += result.depth;
                        depthCount += 1;
                    }

                    for (const [engineIndex, activeIndex] of active) {
                        if (activeIndex === index) active.delete(engineIndex);
                    }

                    const sideToMove = index % 2 === 0 ? "w" : "b";
                    const cp = scoreToCp(result);

                    emitToGame(gameId, "analysis_progress", {
                        gameId,
                        progress: done,
                        total,
                        active: [...active.values()].map(describe),
                        last: {
                            ...describe(index),
                            evalCp: sideToMove === "w" ? cp : -cp,
                            mate: result.mate !== null && result.mate !== undefined,
                        },
                    });
                },
            });

            reachedDepth = depthCount ? Math.round(depthSum / depthCount) : settings.depth;
        } finally {
            closeEnginePool(engines);
        }
    } finally {
        releaseSlot();
    }

    const analysis = buildReview(parsed, evaluations, { depth: reachedDepth, tier });

    analysis.playerColor = playerColor;
    analysis.players = await loadPlayers({ game, profile, playerColor }).catch(() => null);
    analysis.result = game.result ?? null;
    analysis.mode = game.mode ?? null;

    const update = { analyzed: true, analysis };

    const { error } = await supabaseAdmin.from("games").update(update).eq("id", gameId);
    if (error) console.log("SAVE ANALYSIS ERROR:", error.message);

    await saveMistakesForCoach({ authId, gameId, moves: analysis.moves, playerColor });

    emitToGame(gameId, "analysis_complete", { gameId, analysis });
}

// =============================
// COACH: remember the user's own mistakes
// =============================

// Review label -> category the coach lessons are built on.
const MISTAKE_TYPE = {
    blunder: "blunder",
    mistake: "mistake",
    inaccuracy: "inaccuracy",
    miss: "missed_win",
};

async function saveMistakesForCoach({ authId, gameId, moves, playerColor }) {
    if (!authId) return;

    const rows = moves
        .filter((m) => MISTAKE_TYPE[m.classification])
        // Only the user's own moves - the opponent's mistakes say nothing
        // about the user's weaknesses. (Unknown colour: keep all, as before.)
        .filter((m) => !playerColor || m.color === playerColor)
        .map((m) => ({
            user_id: authId,
            mistake_type: MISTAKE_TYPE[m.classification],
            phase: m.phase,
            game_id: gameId,
            move_index: m.ply,
            eval_loss_cp: m.cpLoss ?? null,
            best_move: m.bestMove ?? null,
            motif: m.motif ? m.motif.type : null,
        }));

    // A game that is analysed again must not count twice.
    const { error: deleteError } = await supabaseAdmin
        .from("user_mistakes")
        .delete()
        .eq("user_id", authId)
        .eq("game_id", gameId);

    if (deleteError) console.log("CLEAR MISTAKES ERROR:", deleteError.message);

    if (rows.length === 0) return;

    const { error } = await supabaseAdmin.from("user_mistakes").insert(rows);
    if (error) console.log("SAVE MISTAKES ERROR:", error.message);
}
