import { Chess } from "chess.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { createAnalysisEngine, evaluatePosition, closeEngine } from "./stockfishEngine.js";

const DEPTH_BY_TIER = {
    silver: 14,
    gold: 14,
    diamond: 20,
};

export function setupAnalysisHandlers(io) {
    io.on("connection", (socket) => {
        socket.on("analyze_game", async ({ gameId }, ack) => {
            try {
                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");

                const { data: game } = await supabaseAdmin
                    .from("games")
                    .select("*")
                    .eq("id", gameId)
                    .maybeSingle();

                if (!game || game.user_id !== authId) {
                    throw new Error("GAME_NOT_FOUND");
                }

                const { data: profile } = await supabaseAdmin
                    .from("profiles")
                    .select("vip_tier")
                    .eq("id", authId)
                    .maybeSingle();

                const tier = profile?.vip_tier || "none";
                const depth = DEPTH_BY_TIER[tier];

                if (!depth) throw new Error("NOT_VIP");

                if (game.analyzed && game.analysis) {
                    if (typeof ack === "function") {
                        ack({ ok: true, started: false, cached: true });
                    }
                    socket.emit("analysis_complete", {
                        gameId,
                        analysis: game.analysis,
                    });
                    return;
                }

                if (typeof ack === "function") {
                    ack({ ok: true, started: true });
                }

                runAnalysis({ socket, gameId, pgn: game.pgn, depth, tier }).catch(
                    (error) => {
                        console.log("ANALYSIS ERROR:", error);
                        socket.emit("analysis_error", {
                            gameId,
                            error: "ANALYSIS_FAILED",
                        });
                    }
                );
            } catch (error) {
                console.log("ANALYZE_GAME ERROR:", error.message);
                if (typeof ack === "function") {
                    ack({ ok: false, error: error.message });
                }
            }
        });
    });
}

async function runAnalysis({ socket, gameId, pgn, depth, tier }) {
    const source = new Chess();
    source.loadPgn(pgn);

    const moves = source.history({ verbose: true });

    const replay = new Chess();
    const positions = [];

    for (const move of moves) {
        replay.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion,
        });
        positions.push({ san: move.san, fen: replay.fen() });
    }

    const engine = await createAnalysisEngine();
    const evaluations = [];

    for (let i = 0; i < positions.length; i++) {
        const { san, fen } = positions[i];
        const { evalCp, bestMove } = await evaluatePosition(engine, fen, depth);

        const sideToMove = fen.split(" ")[1];
        const normalizedEval = sideToMove === "w" ? evalCp : -evalCp;

        evaluations.push({
            moveNumber: Math.floor(i / 2) + 1,
            san,
            evalCp: normalizedEval,
            bestMove,
        });

        socket.emit("analysis_progress", {
            gameId,
            progress: i + 1,
            total: positions.length,
        });
    }

    closeEngine(engine);

    const analysis = { depth, tier, moves: evaluations };

    await supabaseAdmin
        .from("games")
        .update({ analyzed: true, analysis })
        .eq("id", gameId);

    socket.emit("analysis_complete", { gameId, analysis });
}