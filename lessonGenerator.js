import { supabaseAdmin } from "./supabaseAdmin.js";

const MIN_OWN_EXAMPLES = 2;

// GEÄNDERT: Schlüssel sind jetzt die tatsächlichen mistake_type-Werte aus
// stockfishSocket.js (blunder/mistake/inaccuracy/missed_win/slip) - vorher
// fälschlich phasenpräfigiert ("opening_blunder"), was nie traf, weil
// mistake_type in Wirklichkeit keine Phase enthält (die steht separat in phase).
const SEVERITY_TEXT = {
  blunder: {
    title: "Patzer",
    explanation:
      "Ein Patzer bedeutet meist, dass eine taktische Erwiderung des Gegners übersehen wurde - " +
      "eine Figur hängt, oder ein Gabel-/Fesselungs-/Spieß-Motiv wurde nicht gesehen.",
  },
  mistake: {
    title: "Fehler",
    explanation:
      "Kein sofortiger Materialverlust, aber ein spürbarer Stellungsnachteil - meist ein " +
      "strategischer Fehlgriff oder ein zu früh erzwungener Abtausch.",
  },
  inaccuracy: {
    title: "Ungenauigkeit",
    explanation:
      "Eine kleine Abweichung vom besten Zug, die die Stellung noch nicht entscheidend verschlechtert, " +
      "aber Zug für Zug Substanz kostet.",
  },
  missed_win: {
    title: "Gewinn verpasst",
    explanation:
      "Die Stellung war klar gewonnen, der gespielte Zug hat den Vorteil aber deutlich verkleinert. " +
      "Typisch dafür: zu schnell gespielt, statt die klarste Fortsetzung zu suchen.",
  },
  slip: {
    title: "Ausrutscher in einer Serie guter Züge",
    explanation:
      "Nach mehreren starken Zügen in Folge kommt hier eine kleine Ungenauigkeit - oft ein " +
      "Konzentrationsabfall, wenn die Stellung schon gut aussieht.",
  },
};

const MOTIF_TEXT = {
  fork: "Der verpasste Zug hätte eine Gabel ausgenutzt - eine Figur hätte gleichzeitig zwei gegnerische Ziele angegriffen.",
  pin: "Der verpasste Zug hätte eine Fesselung ausgenutzt - eine gegnerische Figur konnte sich nicht bewegen, ohne eine wertvollere Figur (oder den König) dahinter preiszugeben.",
  skewer: "Der verpasste Zug hätte einen Spieß ausgenutzt - die wertvollere gegnerische Figur stand vorne und musste ausweichen, wodurch die Figur dahinter angreifbar wurde.",
};

const PHASE_LABEL = { opening: "in der Eröffnung", middlegame: "im Mittelspiel", endgame: "im Endspiel" };

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
    explanation += ` Bei dir passiert das am häufigsten ${PHASE_LABEL[phase] ?? phase}.`;
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
