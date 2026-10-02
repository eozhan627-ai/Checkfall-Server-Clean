import { Chess } from "chess.js";
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

const MOTIF_NAME = { fork: "a fork", pin: "a pin", skewer: "a skewer" };

// Turns the user's own mistakes into exercises: the position right before
// the mistake, with the engine's move as the solution. At most three, each
// from a different game where possible.
async function buildOwnExamples(rows) {
  const examples = [];
  const usedGames = new Set();

  // one row per game first, then fill up
  const ordered = [
    ...rows.filter((r) => !usedGames.has(r.game_id) && usedGames.add(r.game_id)),
    ...rows,
  ];

  const games = new Map();

  for (const row of ordered) {
    if (examples.length >= 3) break;
    if (examples.some((e) => e.gameId === row.game_id && e.moveIndex === row.move_index)) continue;

    if (!games.has(row.game_id)) {
      const { data } = await supabaseAdmin
        .from("games")
        .select("pgn, analysis")
        .eq("id", row.game_id)
        .maybeSingle();
      games.set(row.game_id, data || null);
    }

    const example = exampleFromGame(games.get(row.game_id), row);
    if (example) examples.push(example);
  }

  return examples;
}

function exampleFromGame(game, row) {
  const move = game?.analysis?.moves?.[row.move_index];
  if (!game?.pgn || !move?.bestMove) return null;

  try {
    const source = new Chess();
    source.loadPgn(game.pgn);
    const history = source.history({ verbose: true });

    if (row.move_index >= history.length) return null;

    const replay = new Chess();
    for (let i = 0; i < row.move_index; i++) {
      replay.move({ from: history[i].from, to: history[i].to, promotion: history[i].promotion });
    }

    const fen = replay.fen();
    const played = history[row.move_index];

    const best = replay.move({
      from: move.bestMove.slice(0, 2),
      to: move.bestMove.slice(2, 4),
      promotion: move.bestMove.length > 4 ? move.bestMove[4] : undefined,
    });

    // Nothing to learn if the engine's move is the one that was played.
    if (!best || best.san === played.san) return null;

    const motif = MOTIF_NAME[row.motif];

    return {
      source: "own",
      gameId: row.game_id,
      moveIndex: row.move_index,
      motif: row.motif ?? null,
      fen,
      moves: [move.bestMove],
      played: played.san,
      bestSan: best.san,
      intro: `This position is from one of your own games. You played ${played.san} here - find the better move.`,
      hint: motif
        ? `Look for ${motif}.`
        : `Look at checks, captures and threats first. ${played.san} was not the best choice.`,
      why: motif
        ? `${best.san} is ${motif} - much stronger than ${played.san}.`
        : `${best.san} was the engine's choice here instead of ${played.san}.`,
    };
  } catch {
    return null;
  }
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

  const ownExamples = await buildOwnExamples(rows);

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
