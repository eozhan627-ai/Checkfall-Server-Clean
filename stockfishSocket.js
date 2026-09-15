import { Chess } from "chess.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { createAnalysisEngine, evaluatePosition, closeEngine } from "./stockfishEngine.js";

const DEPTH_BY_TIER = { silver: 14, gold: 14, diamond: 20 };

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

                if (!game || game.user_id !== authId) throw new Error("GAME_NOT_FOUND");

                const { data: profile } = await supabaseAdmin
                    .from("profiles")
                    .select("vip_tier")
                    .eq("id", authId)
                    .maybeSingle();

                const tier = profile?.vip_tier || "none";
                const depth = DEPTH_BY_TIER[tier];
                if (!depth) throw new Error("NOT_VIP");

                if (game.analyzed && game.analysis) {
                    if (typeof ack === "function") ack({ ok: true, started: false, cached: true });
                    socket.emit("analysis_complete", { gameId, analysis: game.analysis });
                    return;
                }

                if (typeof ack === "function") ack({ ok: true, started: true });

                runAnalysis({ socket, gameId, pgn: game.pgn, depth, tier }).catch((error) => {
                    console.log("ANALYSIS ERROR:", error);
                    socket.emit("analysis_error", { gameId, error: "ANALYSIS_FAILED" });
                });
            } catch (error) {
                console.log("ANALYZE_GAME ERROR:", error.message);
                if (typeof ack === "function") ack({ ok: false, error: error.message });
            }
        });
    });
}

function toWhiteEval(evalCp, fen) {
    const sideToMove = fen.split(" ")[1];
    return sideToMove === "w" ? evalCp : -evalCp;
}

function classifyMove({ evalBeforeWhite, secondEvalBeforeWhite, evalAfterWhite, mover }) {
    const loss =
        mover === "w" ? evalBeforeWhite - evalAfterWhite : evalAfterWhite - evalBeforeWhite;
    const clampedLoss = Math.max(0, loss);
    const moverEvalBefore = mover === "w" ? evalBeforeWhite : -evalBeforeWhite;

    let gapToSecond = null;
    if (secondEvalBeforeWhite !== null) {
        const moverBest = mover === "w" ? evalBeforeWhite : -evalBeforeWhite;
        const moverSecond = mover === "w" ? secondEvalBeforeWhite : -secondEvalBeforeWhite;
        gapToSecond = moverBest - moverSecond;
    }

    if (clampedLoss <= 10 && gapToSecond !== null && gapToSecond >= 150 && moverEvalBefore < 100) {
        return "only_move";
    }

    if (moverEvalBefore >= 300 && clampedLoss >= 150) return "missed_win";
    if (moverEvalBefore <= -150 && clampedLoss <= 10) return "precise_defense";

    if (clampedLoss <= 10) return "great";
    if (clampedLoss <= 30) return "good";
    if (clampedLoss <= 90) return "inaccuracy";
    if (clampedLoss <= 200) return "mistake";
    return "blunder";
}

async function runAnalysis({ socket, gameId, pgn, depth, tier }) {
    const source = new Chess();
    source.loadPgn(pgn);

    const verboseMoves = source.history({ verbose: true });

    const replay = new Chess();
    const positions = [];

    for (const move of verboseMoves) {
        replay.move({ from: move.from, to: move.to, promotion: move.promotion });
        positions.push({ san: move.san, fen: replay.fen(), piece: move.piece, to: move.to });
    }

    const engine = await createAnalysisEngine();

    const startFen = new Chess().fen();
    const startResult = await evaluatePosition(engine, startFen, depth);
    let prevWhiteEval = toWhiteEval(startResult.evalCp, startFen);
    let prevSecondWhiteEval =
        startResult.secondEvalCp !== null ? toWhiteEval(startResult.secondEvalCp, startFen) : null;

    const evaluations = [];
    const streaks = { w: 0, b: 0 };
    const counts = { w: {}, b: {} };
    const accuracySum = { w: 0, b: 0 };
    const moveCount = { w: 0, b: 0 };

    for (let i = 0; i < positions.length; i++) {
        const { san, fen, piece, to } = positions[i];
        const mover = i % 2 === 0 ? "w" : "b";

        const result = await evaluatePosition(engine, fen, depth);
        const whiteEval = toWhiteEval(result.evalCp, fen);

        let classification = classifyMove({
            evalBeforeWhite: prevWhiteEval,
            secondEvalBeforeWhite: prevSecondWhiteEval,
            evalAfterWhite: whiteEval,
            mover,
        });

        if (classification === "great") {
            const postMoveBoard = new Chess(fen);
            const opponentMoves = postMoveBoard.moves({ verbose: true });
            const isHanging = opponentMoves.some((m) => m.to === to && m.captured);
            if (isHanging && piece !== "p" && piece !== "k") classification = "brilliant";
        }

        if (classification === "inaccuracy" && streaks[mover] >= 3) classification = "slip";

        streaks[mover] = ["great", "brilliant", "good"].includes(classification) ? streaks[mover] + 1 : 0;

        counts[mover][classification] = (counts[mover][classification] || 0) + 1;

        const loss = mover === "w" ? prevWhiteEval - whiteEval : whiteEval - prevWhiteEval;
        const clampedLoss = Math.max(0, loss);
        accuracySum[mover] += 100 * Math.exp(-clampedLoss / 150);
        moveCount[mover] += 1;

        evaluations.push({
            moveNumber: Math.floor(i / 2) + 1,
            san,
            evalCp: whiteEval,
            bestMove: result.bestMove,
            classification,
        });

        prevWhiteEval = whiteEval;
        prevSecondWhiteEval =
            result.secondEvalCp !== null ? toWhiteEval(result.secondEvalCp, fen) : null;

        socket.emit("analysis_progress", { gameId, progress: i + 1, total: positions.length });
    }

    closeEngine(engine);
    const analysis = { depth, tier, moves: evaluations, accuracy, counts };

    await supabaseAdmin.from("games").update({ analyzed: true, analysis }).eq("id", gameId);

    // NEU: Fehler für den Personal Coach in user_mistakes speichern
    await saveMistakesForCoach({ authId: socket.data.authId, gameId, evaluations });

    socket.emit("analysis_complete", { gameId, analysis });
}

// NEU
const NEGATIVE_CLASSIFICATIONS = ["blunder", "mistake", "inaccuracy", "missed_win", "slip"];

function getPhase(moveNumber) {
    if (moveNumber <= 10) return "opening";
    if (moveNumber <= 25) return "middlegame";
    return "endgame";
}

async function saveMistakesForCoach({ authId, gameId, evaluations }) {
    if (!authId) return;

    const rows = evaluations
        .map((m, index) => ({ ...m, index }))
        .filter((m) => NEGATIVE_CLASSIFICATIONS.includes(m.classification))
        .map((m) => ({
            user_id: authId,
            mistake_type: m.classification,
            phase: getPhase(m.moveNumber),
            game_id: gameId,
            move_index: m.index,
            eval_loss_cp: null, // Verlust wird aktuell nicht pro Zug zurückgegeben — siehe Hinweis unten
        }));

    if (rows.length === 0) return;

    const { error } = await supabaseAdmin.from("user_mistakes").insert(rows);
    if (error) console.log("SAVE MISTAKES ERROR:", error.message);
}