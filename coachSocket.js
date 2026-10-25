import { Chess } from "chess.js";
import { coachConfigured, requestCoachAnswer } from "./coachApi.js";
import { supabaseAdmin } from "./supabaseAdmin.js";

const DAILY_LIMIT = { silver: 5, gold: 20, diamond: 200 };

const COACH_NAME = "Uhu"; // NEU: hier den Namen des Maskottchens aendern, falls gewuenscht

// Position before a move, so the coach can talk about concrete squares.
function fenBeforeMove(pgn, index) {
    try {
        const source = new Chess();
        source.loadPgn(pgn);
        const history = source.history({ verbose: true });

        const replay = new Chess();
        for (let i = 0; i < index && i < history.length; i++) {
            replay.move({ from: history[i].from, to: history[i].to, promotion: history[i].promotion });
        }
        return replay.fen();
    } catch {
        return null;
    }
}

// Everything the review knows about the move, as plain text for the model.
function describeMoveForCoach({ move, game, index }) {
    const side = move.color === "b" || index % 2 === 1 ? "Black" : "White";
    const playerColor = game.analysis?.playerColor;
    const lines = [];

    lines.push(`Move ${move.moveNumber} by ${side}: ${move.san}. The review labels it "${move.classification}".`);

    if (playerColor) {
        lines.push(`The user played ${playerColor === "w" ? "White" : "Black"}.`);
    }

    const fen = fenBeforeMove(game.pgn, index);
    if (fen) lines.push(`Position before the move (FEN): ${fen}`);

    if (typeof move.mate === "number" && move.mateFor) {
        lines.push(
            move.mate === 0
                ? "The move is checkmate."
                : `After the move ${move.mateFor === "w" ? "White" : "Black"} has a forced mate in ${move.mate}.`
        );
    } else {
        lines.push(`Evaluation after the move: ${move.evalCp} centipawns (positive = advantage for White).`);
    }

    if (move.bestSan && move.bestSan !== move.san) {
        lines.push(`Engine's best move was ${move.bestSan}${move.bestLine?.length > 1 ? `, best line: ${move.bestLine.join(" ")}` : ""}.`);
    }

    if (move.reply?.length) {
        lines.push(`Best continuation after the move played: ${move.reply.join(" ")}.`);
    }

    return lines.join("\n");
}

export function setupCoachHandlers(io) {
    if (!coachConfigured()) {
        console.log("COACH: ANTHROPIC_API_KEY is not set - the coach cannot answer questions.");
    }

    io.on("connection", (socket) => {
        socket.on("coach_message", async (payload, ack) => {
            try {
                const { gameId, moveIndex, question, language } = payload ?? {};

                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");

                if (typeof question !== "string" || !question.trim() || question.length > 500) {
                    throw new Error("INVALID_QUESTION");
                }

                const { data: profile } = await supabaseAdmin
                    .from("profiles")
                    .select("vip_tier")
                    .eq("id", authId)
                    .maybeSingle();

                const tier = profile?.vip_tier || "none";
                const limit = DAILY_LIMIT[tier];
                if (!limit) throw new Error("NOT_VIP");

                const today = new Date().toISOString().slice(0, 10);

                const { data: usage } = await supabaseAdmin
                    .from("coach_usage")
                    .select("count")
                    .eq("user_id", authId)
                    .eq("usage_date", today)
                    .maybeSingle();

                const currentCount = usage?.count || 0;
                if (currentCount >= limit) throw new Error("LIMIT_REACHED");

                const { data: game } = await supabaseAdmin
                    .from("games")
                    .select("user_id, pgn, analysis")
                    .eq("id", gameId)
                    .maybeSingle();

                if (!game || game.user_id !== authId) throw new Error("GAME_NOT_FOUND");

                const moves = game.analysis?.moves || [];
                const move = typeof moveIndex === "number" && moveIndex > 0 ? moves[moveIndex - 1] : null;

                const contextText = move
                    ? describeMoveForCoach({ move, game, index: moveIndex - 1 })
                    : `General question about the game. PGN: ${game.pgn}`;

                // The app sends the language the player has chosen.
                const answerLanguage = language === "de" ? "German" : "English";

                const systemPrompt =
                    `You are ${COACH_NAME}, a friendly, encouraging chess coach in the app POVCheck. ` +
                    "Explain chess moves clearly for hobby players, concretely and briefly (max. 4 sentences), " +
                    `without too much jargon. Be encouraging, even about mistakes. Always answer in ${answerLanguage}, ` +
                    "but write the moves exactly in the notation you are given (e.g. Nf3). " +
                    "Rely on the engine information you are given and do not invent moves or evaluations.";

                // Throws when there is no real answer (see coachApi.js) - then
                // the question is not counted either.
                const answer = await requestCoachAnswer({
                    system: systemPrompt,
                    question: `${contextText}\n\nQuestion: ${question.trim()}`,
                });

                await supabaseAdmin
                    .from("coach_usage")
                    .upsert(
                        { user_id: authId, usage_date: today, count: currentCount + 1 },
                        { onConflict: "user_id,usage_date" }
                    );

                if (typeof ack === "function") {
                    ack({ ok: true, answer, remaining: limit - (currentCount + 1) });
                }
            } catch (error) {
                // `detail` is the real reason (e.g. what the API answered).
                console.log("COACH ERROR:", error.message, error.detail ? `- ${error.detail}` : "");
                if (typeof ack === "function") ack({ ok: false, error: error.message });
            }
        });
    });
}