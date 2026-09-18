import { supabaseAdmin } from "./supabaseAdmin.js";

const PHASE_MOVE_THRESHOLD = { opening: 12, endgame: 30 }; // grobe Heuristik, ggf. anpassen

function classifyPhase(moveNumber, totalMoves) {
  if (moveNumber <= PHASE_MOVE_THRESHOLD.opening) return "opening";
  if (totalMoves - moveNumber <= 10) return "endgame";
  return "middlegame";
}

function guessMistakeType(move, phase) {
  const severity = move.classification; // "blunder" | "mistake" | "inaccuracy"
  return `${phase}_${severity}`;
}

export async function extractMistakesFromGame(gameId) {
  const { data: game } = await supabaseAdmin
    .from("games")
    .select("user_id, analysis")
    .eq("id", gameId)
    .maybeSingle();

  if (!game?.analysis?.moves) return;

  const moves = game.analysis.moves;

  const rows = moves
    .map((m, i) => ({ move: m, index: i })) // GEÄNDERT: echten Index VOR dem Filtern sichern (vorher: Index im gefilterten Array)
    .filter(({ move: m }) => m.classification === "blunder" || m.classification === "mistake")
    .map(({ move: m, index }) => {
      const phase = classifyPhase(m.moveNumber, moves.length); // GEÄNDERT: einmal berechnen und weiterreichen
      return {
        user_id: game.user_id,
        mistake_type: guessMistakeType(m, phase), // GEÄNDERT: phase wird jetzt übergeben (vorher: undefined -> "undefined_blunder" etc.)
        phase,
        game_id: gameId,
        move_index: index, // GEÄNDERT: echter Index in game.analysis.moves statt Index im gefilterten Array
        eval_loss_cp: m.evalLossCp || null,
      };
    });

  if (rows.length) {
    await supabaseAdmin.from("user_mistakes").insert(rows);
  }
}
