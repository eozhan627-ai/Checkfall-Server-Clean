// Daily Chess: correspondence games with days per move instead of a clock.
// Nobody has to be online at the same time - each player moves when they
// have time and gets a push notification when it is their turn. That makes
// it work even with very few players.
//
// Games are unrated. Signed-in players only (the game is stored).
// Table: supabase/007_daily_chess_and_push.sql

import { Chess } from "chess.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { pushToUsers } from "./push.js";

export const DAYS_PER_MOVE = [1, 2, 3];
export const MAX_ACTIVE_GAMES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// =============================
// RULES (pure, tested in dailyChess.test.js)
// =============================

export function deadlineFrom(daysPerMove, now = Date.now()) {
    return new Date(now + daysPerMove * DAY_MS).toISOString();
}

export function normalizeDays(value) {
    const days = Number(value);
    return DAYS_PER_MOVE.includes(days) ? days : 1;
}

export function colorOf(game, userId) {
    if (game.white_id === userId) return "w";
    if (game.black_id === userId) return "b";
    return null;
}

function loadBoard(game) {
    const chess = new Chess();
    if (game.pgn) chess.loadPgn(game.pgn);
    return chess;
}

/**
 * Plays a move for userId. Returns { error } or { update, finished, result }.
 * update is what to write into the row.
 */
export function playDailyMove(game, userId, move, now = Date.now()) {
    if (game.status !== "active") return { error: "GAME_NOT_ACTIVE" };

    const color = colorOf(game, userId);
    if (!color) return { error: "NOT_YOUR_GAME" };

    let chess;
    try {
        chess = loadBoard(game);
    } catch {
        return { error: "BROKEN_GAME" };
    }

    if (chess.turn() !== color) return { error: "NOT_YOUR_TURN" };

    let played;
    try {
        played = chess.move({ from: move?.from, to: move?.to, promotion: move?.promotion || undefined });
    } catch {
        played = null;
    }
    if (!played) return { error: "ILLEGAL_MOVE" };

    const update = {
        pgn: chess.pgn(),
        fen: chess.fen(),
        move_count: chess.history().length,
        last_move_at: new Date(now).toISOString(),
        deadline_at: deadlineFrom(game.days_per_move, now),
        updated_at: new Date(now).toISOString(),
    };

    let result = null;
    let reason = null;

    if (chess.isCheckmate()) {
        result = color === "w" ? "1-0" : "0-1";
        reason = "checkmate";
    } else if (chess.isGameOver()) {
        result = "1/2-1/2";
        reason = chess.isStalemate() ? "stalemate" : chess.isThreefoldRepetition() ? "repetition" : chess.isInsufficientMaterial() ? "material" : "draw";
    }

    if (result) {
        Object.assign(update, { status: "finished", result, end_reason: reason, deadline_at: null });
    }

    return { update, finished: Boolean(result), result, san: played.san, nextTurn: chess.turn() };
}

/** Result when the player to move ran out of time. */
export function timeoutResult(game) {
    const chess = loadBoard(game);
    return chess.turn() === "w" ? "0-1" : "1-0";
}

// =============================
// DATABASE
// =============================

async function profilesById(ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (wanted.length === 0) return new Map();

    const { data } = await supabaseAdmin.from("profiles").select("id, username, avatar, rating").in("id", wanted);
    return new Map((data || []).map((p) => [p.id, { id: p.id, username: p.username, avatar: p.avatar || "", rating: p.rating }]));
}

function publicGame(game, userId, profiles) {
    const color = colorOf(game, userId);
    const opponentId = color === "w" ? game.black_id : color === "b" ? game.white_id : null;
    const turn = game.fen?.split(" ")[1] === "b" ? "b" : "w";

    return {
        id: game.id,
        status: game.status,
        daysPerMove: game.days_per_move,
        pgn: game.pgn,
        fen: game.fen,
        moveCount: game.move_count,
        result: game.result,
        endReason: game.end_reason,
        lastMoveAt: game.last_move_at,
        deadlineAt: game.deadline_at,
        createdAt: game.created_at,
        myColor: color,
        myTurn: game.status === "active" && color === turn,
        white: profiles.get(game.white_id) || null,
        black: profiles.get(game.black_id) || null,
        opponent: profiles.get(opponentId) || null,
    };
}

async function loadGame(id) {
    const { data, error } = await supabaseAdmin.from("daily_games").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error("NOT_AVAILABLE");
    return data;
}

async function countActive(userId) {
    const { count } = await supabaseAdmin
        .from("daily_games")
        .select("id", { count: "exact", head: true })
        .in("status", ["open", "active"])
        .or(`white_id.eq.${userId},black_id.eq.${userId},creator_id.eq.${userId}`);
    return count || 0;
}

function resultText(result, color) {
    if (result === "1/2-1/2") return "Remis";
    return (result === "1-0") === (color === "w") ? "Du hast gewonnen 🎉" : "Du hast verloren";
}

export function setupDailyRoutes(app, { getAuthIdFromRequest, areFriends, emitToUser }) {
    const notifyUpdate = (userIds, gameId) => {
        for (const id of userIds) if (id) emitToUser(id, "daily_update", { id: gameId });
    };

    // All handlers: signed in, table present.
    const route = (handler) => async (req, res) => {
        try {
            const authId = await getAuthIdFromRequest(req).catch(() => null);
            if (!authId) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
            if (!supabaseAdmin) return res.status(503).json({ error: "NOT_AVAILABLE" });

            await handler(req, res, authId);
        } catch (error) {
            const code = error?.message || "UNKNOWN_ERROR";
            res.status(code === "NOT_AVAILABLE" ? 503 : 400).json({ error: code });
        }
    };

    // My games (running, the open search, the last finished ones).
    app.get("/daily", route(async (req, res, authId) => {
        const { data, error } = await supabaseAdmin
            .from("daily_games")
            .select("*")
            .or(`white_id.eq.${authId},black_id.eq.${authId},creator_id.eq.${authId}`)
            .in("status", ["open", "active", "finished"])
            .order("updated_at", { ascending: false })
            .limit(40);

        if (error) throw new Error("NOT_AVAILABLE");

        const games = (data || []).filter((g) => g.status !== "open" || g.creator_id === authId);
        const profiles = await profilesById(games.flatMap((g) => [g.white_id, g.black_id]));

        res.json({ games: games.map((g) => publicGame(g, authId, profiles)) });
    }));

    app.get("/daily/:id", route(async (req, res, authId) => {
        if (!UUID.test(req.params.id)) throw new Error("GAME_NOT_FOUND");

        const game = await loadGame(req.params.id);
        if (!game || (!colorOf(game, authId) && game.creator_id !== authId)) throw new Error("GAME_NOT_FOUND");

        const profiles = await profilesById([game.white_id, game.black_id]);
        res.json({ game: publicGame(game, authId, profiles) });
    }));

    // Find an opponent: join the oldest open search of someone else, or
    // open one of my own.
    app.post("/daily/seek", route(async (req, res, authId) => {
        const days = normalizeDays(req.body?.daysPerMove);

        if ((await countActive(authId)) >= MAX_ACTIVE_GAMES) throw new Error("TOO_MANY_GAMES");

        const { data: open } = await supabaseAdmin
            .from("daily_games")
            .select("*")
            .eq("status", "open")
            .eq("days_per_move", days)
            .neq("creator_id", authId)
            .order("created_at", { ascending: true })
            .limit(1);

        const seek = open?.[0];

        if (seek) {
            const creatorWhite = Math.random() < 0.5;
            const now = Date.now();

            // Only if it is still open (someone else may have taken it).
            const { data: taken } = await supabaseAdmin
                .from("daily_games")
                .update({
                    status: "active",
                    white_id: creatorWhite ? seek.creator_id : authId,
                    black_id: creatorWhite ? authId : seek.creator_id,
                    deadline_at: deadlineFrom(days, now),
                    last_move_at: new Date(now).toISOString(),
                    updated_at: new Date(now).toISOString(),
                })
                .eq("id", seek.id)
                .eq("status", "open")
                .select("*")
                .maybeSingle();

            if (taken) {
                const profiles = await profilesById([taken.white_id, taken.black_id]);
                const me = profiles.get(authId);

                notifyUpdate([seek.creator_id], taken.id);
                pushToUsers([seek.creator_id], "daily", {
                    title: "Fernschach: Gegner gefunden ♟️",
                    body: `${me?.username || "Jemand"} spielt gegen dich.${creatorWhite ? " Du bist am Zug." : ""}`,
                    data: { url: `/daily/${taken.id}` },
                }).catch(() => { });

                return res.json({ game: publicGame(taken, authId, profiles) });
            }
        }

        // One open search per player and tempo is enough.
        const { data: mine } = await supabaseAdmin
            .from("daily_games")
            .select("*")
            .eq("status", "open")
            .eq("creator_id", authId)
            .eq("days_per_move", days)
            .limit(1);

        if (mine?.[0]) return res.json({ game: publicGame(mine[0], authId, new Map()) });

        const { data: created, error } = await supabaseAdmin
            .from("daily_games")
            .insert({ creator_id: authId, status: "open", days_per_move: days, fen: START_FEN })
            .select("*")
            .single();

        if (error) throw new Error("NOT_AVAILABLE");

        res.json({ game: publicGame(created, authId, new Map()) });
    }));

    // Challenge a friend directly - the game starts right away.
    app.post("/daily/challenge", route(async (req, res, authId) => {
        const friendId = req.body?.friendId;
        const days = normalizeDays(req.body?.daysPerMove);

        if (!UUID.test(String(friendId)) || friendId === authId) throw new Error("INVALID_TARGET");
        if (!(await areFriends(authId, friendId))) throw new Error("NOT_ALLOWED");
        if ((await countActive(authId)) >= MAX_ACTIVE_GAMES) throw new Error("TOO_MANY_GAMES");

        const meWhite = Math.random() < 0.5;
        const now = Date.now();

        const { data: created, error } = await supabaseAdmin
            .from("daily_games")
            .insert({
                creator_id: authId,
                white_id: meWhite ? authId : friendId,
                black_id: meWhite ? friendId : authId,
                status: "active",
                days_per_move: days,
                fen: START_FEN,
                last_move_at: new Date(now).toISOString(),
                deadline_at: deadlineFrom(days, now),
            })
            .select("*")
            .single();

        if (error) throw new Error("NOT_AVAILABLE");

        const profiles = await profilesById([authId, friendId]);

        notifyUpdate([friendId], created.id);
        pushToUsers([friendId], "daily", {
            title: "Fernschach-Herausforderung ♟️",
            body: `${profiles.get(authId)?.username || "Ein Freund"} hat eine Fernschach-Partie mit dir gestartet.${meWhite ? "" : " Du bist am Zug."}`,
            data: { url: `/daily/${created.id}` },
        }).catch(() => { });

        res.json({ game: publicGame(created, authId, profiles) });
    }));

    app.post("/daily/:id/move", route(async (req, res, authId) => {
        if (!UUID.test(req.params.id)) throw new Error("GAME_NOT_FOUND");

        const game = await loadGame(req.params.id);
        if (!game) throw new Error("GAME_NOT_FOUND");

        const outcome = playDailyMove(game, authId, req.body);
        if (outcome.error) throw new Error(outcome.error);

        // Written only if nobody changed the game in the meantime.
        const { data: saved } = await supabaseAdmin
            .from("daily_games")
            .update(outcome.update)
            .eq("id", game.id)
            .eq("move_count", game.move_count)
            .eq("status", "active")
            .select("*")
            .maybeSingle();

        if (!saved) throw new Error("GAME_CHANGED");

        const color = colorOf(game, authId);
        const opponentId = color === "w" ? game.black_id : game.white_id;
        const profiles = await profilesById([game.white_id, game.black_id]);
        const me = profiles.get(authId);

        notifyUpdate([opponentId], game.id);
        pushToUsers([opponentId], "daily", outcome.finished
            ? {
                title: "Fernschach: Partie beendet",
                body: `${me?.username || "Dein Gegner"} spielte ${outcome.san}. ${resultText(outcome.result, color === "w" ? "b" : "w")}.`,
                data: { url: `/daily/${game.id}` },
            }
            : {
                title: "Du bist am Zug ♟️",
                body: `${me?.username || "Dein Gegner"} spielte ${outcome.san}.`,
                data: { url: `/daily/${game.id}` },
            }).catch(() => { });

        res.json({ game: publicGame(saved, authId, profiles) });
    }));

    app.post("/daily/:id/resign", route(async (req, res, authId) => {
        if (!UUID.test(req.params.id)) throw new Error("GAME_NOT_FOUND");

        const game = await loadGame(req.params.id);
        const color = game ? colorOf(game, authId) : null;
        if (!game || !color || game.status !== "active") throw new Error("GAME_NOT_FOUND");

        const result = color === "w" ? "0-1" : "1-0";

        const { data: saved } = await supabaseAdmin
            .from("daily_games")
            .update({ status: "finished", result, end_reason: "resign", deadline_at: null, updated_at: new Date().toISOString() })
            .eq("id", game.id)
            .eq("status", "active")
            .select("*")
            .maybeSingle();

        if (!saved) throw new Error("GAME_CHANGED");

        const opponentId = color === "w" ? game.black_id : game.white_id;
        const profiles = await profilesById([game.white_id, game.black_id]);

        notifyUpdate([opponentId], game.id);
        pushToUsers([opponentId], "daily", {
            title: "Fernschach: Gegner hat aufgegeben",
            body: `${profiles.get(authId)?.username || "Dein Gegner"} hat aufgegeben. Du hast gewonnen 🎉`,
            data: { url: `/daily/${game.id}` },
        }).catch(() => { });

        res.json({ game: publicGame(saved, authId, profiles) });
    }));

    // Withdraw my open search.
    app.post("/daily/:id/cancel", route(async (req, res, authId) => {
        if (!UUID.test(req.params.id)) throw new Error("GAME_NOT_FOUND");

        await supabaseAdmin
            .from("daily_games")
            .update({ status: "cancelled", updated_at: new Date().toISOString() })
            .eq("id", req.params.id)
            .eq("creator_id", authId)
            .eq("status", "open");

        res.json({ success: true });
    }));
}

// Players who let the time for a move run out lose the game. Also reminds
// players whose time runs out within the next few hours (once).
const reminded = new Set();

async function checkDeadlines(emitToUser) {
    if (!supabaseAdmin) return;

    const now = Date.now();

    const { data: expired, error } = await supabaseAdmin
        .from("daily_games")
        .select("*")
        .eq("status", "active")
        .lt("deadline_at", new Date(now).toISOString())
        .limit(100);

    if (error) return;

    for (const game of expired || []) {
        let result;
        try {
            result = timeoutResult(game);
        } catch {
            continue;
        }

        const { data: saved } = await supabaseAdmin
            .from("daily_games")
            .update({ status: "finished", result, end_reason: "timeout", deadline_at: null, updated_at: new Date(now).toISOString() })
            .eq("id", game.id)
            .eq("status", "active")
            .select("id")
            .maybeSingle();

        if (!saved) continue;

        for (const id of [game.white_id, game.black_id]) emitToUser(id, "daily_update", { id: game.id });

        pushToUsers([game.white_id, game.black_id], "daily", {
            title: "Fernschach: Zeit abgelaufen",
            body: "Eine Partie ist wegen Zeitüberschreitung beendet.",
            data: { url: `/daily/${game.id}` },
        }).catch(() => { });
    }

    // Reminder 3 hours before the time runs out.
    const { data: soon } = await supabaseAdmin
        .from("daily_games")
        .select("id, fen, white_id, black_id, deadline_at")
        .eq("status", "active")
        .lt("deadline_at", new Date(now + 3 * 60 * 60 * 1000).toISOString())
        .limit(200);

    for (const game of soon || []) {
        const key = `${game.id}:${game.deadline_at}`;
        if (reminded.has(key)) continue;
        reminded.add(key);

        const toMove = game.fen?.split(" ")[1] === "b" ? game.black_id : game.white_id;

        pushToUsers([toMove], "daily", {
            title: "Fernschach: Zeit läuft bald ab ⏳",
            body: "Du hast nur noch wenige Stunden für deinen Zug.",
            data: { url: `/daily/${game.id}` },
        }).catch(() => { });
    }

    if (reminded.size > 20000) reminded.clear();
}

export function startDailyJobs({ emitToUser }) {
    setInterval(() => checkDeadlines(emitToUser).catch(() => { }), 5 * 60 * 1000);
}
