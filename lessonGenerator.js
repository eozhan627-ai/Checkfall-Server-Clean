import { supabaseAdmin } from "./supabaseAdmin.js";

const MIN_OWN_EXAMPLES = 2;

// GEÄNDERT: Schlüssel sind jetzt die tatsächlichen mistake_type-Werte aus
// stockfishSocket.js (blunder/mistake/inaccuracy/missed_win/slip) - vorher
// fälschlich phasenpräfigiert ("opening_blunder"), was nie traf, weil
// mistake_type in Wirklichkeit keine Phase enthält (die steht separat in phase).
const SEVERITY_TEXT = {
  blunder: {
    title: "Blunder",
    explanation:
      "A blunder usually means a tactical reply by the opponent was overlooked - " +
      "a piece is hanging, or a fork, pin or skewer was missed.",
  },
  mistake: {
    title: "Mistake",
    explanation:
      "No immediate loss of material, but a noticeable positional disadvantage - usually a " +
      "strategic misjudgement or an exchange that was forced too early.",
  },
  inaccuracy: {
    title: "Inaccuracy",
    explanation:
      "A small deviation from the best move that does not decisively worsen the position yet, " +
      "but costs a little with every move.",
  },
  missed_win: {
    title: "Missed win",
    explanation:
      "The position was clearly winning, but the move played reduced the advantage considerably. " +
      "Typical cause: playing too fast instead of looking for the clearest continuation.",
  },
  slip: {
    title: "Slip in a series of good moves",
    explanation:
      "After several strong moves in a row comes a small inaccuracy - often a " +
      "drop in concentration once the position already looks good.",
  },
};

const MOTIF_TEXT = {
  fork: "The missed move would have used a fork - one piece attacking two enemy targets at the same time.",
  pin: "The missed move would have used a pin - an enemy piece could not move without exposing a more valuable piece (or the king) behind it.",
  skewer: "The missed move would have used a skewer - the more valuable enemy piece stood in front and had to move away, leaving the piece behind it open to attack.",
};

const PHASE_LABEL = { opening: "in the opening", middlegame: "in the middlegame", endgame: "in the endgame" };

function dominantPhase(rows) {
  const counts = {};
  for (const r of rows) counts[r.phase] = (counts[r.phase] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function selectMistakeRows(userId, mistakeType) {
  const { data } = await supabaseAdmin
    .from("user_mistakes")
    .select("game_id, move_index, phase, motif")
    .eq("user_id", userId)
    .eq("mistake_type", mistakeType)
    .limit(20); // genug für eine verlässliche Phasen-/Motiv-Auswertung

  return data || [];
}

export async function generateLesson(userId, mistakeType) {
  const rows = await selectMistakeRows(userId, mistakeType);
  const severity = SEVERITY_TEXT[mistakeType];

  if (!severity) {
    throw new Error(`UNKNOWN_MISTAKE_TYPE: ${mistakeType}`);
  }

  const phase = dominantPhase(rows);
  const motifCounts = {};
  for (const r of rows) if (r.motif) motifCounts[r.motif] = (motifCounts[r.motif] || 0) + 1;
  const dominantMotif = Object.entries(motifCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let explanation = severity.explanation;
  if (phase) {
    explanation += ` For you this happens most often ${PHASE_LABEL[phase] ?? phase}.`;
  }
  if (dominantMotif && MOTIF_TEXT[dominantMotif]) {
    explanation += ` ${MOTIF_TEXT[dominantMotif]}`;
  }

  const ownExamples = rows
    .slice(0, 3)
    .map((r) => ({ source: "own", gameId: r.game_id, moveIndex: r.move_index, motif: r.motif }));

  let examples = ownExamples;
  if (examples.length < MIN_OWN_EXAMPLES) {
    const { data: generic } = await supabaseAdmin
      .from("generic_positions")
      .select("fen, solution, comment")
      .eq("mistake_type", mistakeType)
      .limit(3 - examples.length);
    examples = [...examples, ...(generic || []).map((g) => ({ source: "generic", ...g }))];
  }

  const lesson = {
    user_id: userId,
    mistake_type: mistakeType,
    title: severity.title,
    explanation,
    example_fens: examples,
  };

  const { data, error } = await supabaseAdmin.from("personal_lessons").insert(lesson).select().maybeSingle();
  if (error) throw error;
  return data;
}
