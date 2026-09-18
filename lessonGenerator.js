import { supabaseAdmin } from "./supabaseAdmin.js";

const MIN_OWN_EXAMPLES = 2;

// NEU: statische Titel/Erklärungen je mistake_type (Phase + Schweregrad).
// Ersetzt den bisherigen Platzhalter "TODO: Erklärungstext". Deckt die
// mistake_types ab, die mistakeExtractor.js erzeugt (Phase x
// "blunder"/"mistake" - "inaccuracy" wird dort aktuell nicht gespeichert).
const MISTAKE_PATTERNS = {
  opening_blunder: {
    title: "Patzer in der Eröffnung",
    explanation:
      "In der Eröffnung geht es vor allem um schnelle Entwicklung, Königssicherheit und Zentrumskontrolle. " +
      "Ein Patzer hier bedeutet meist: eine taktische Erwiderung wurde übersehen, eine Figur hängt, oder eine bekannte Falle wurde nicht erkannt. " +
      "Übe, nach jedem eigenen Zug kurz zu prüfen, ob der Gegner eine Figur gewinnen oder einen Doppelangriff starten kann, bevor du ziehst.",
  },
  opening_mistake: {
    title: "Ungenauigkeit in der Eröffnung",
    explanation:
      "Kein Materialverlust, aber eine Abweichung von soliden Eröffnungsprinzipien - zum Beispiel ein zu früh vorgeschobener Bauer, " +
      "vernachlässigte Entwicklung oder ein Zug ohne klaren Plan. Achte darauf, in den ersten 10-12 Zügen jede Figur nur einmal zu bewegen " +
      "und den König rechtzeitig in Sicherheit zu bringen.",
  },
  middlegame_blunder: {
    title: "Patzer im Mittelspiel",
    explanation:
      "Im Mittelspiel sind Patzer meist taktischer Natur: eine Gabel, ein Spieß, ein Abzugsangriff oder eine offene Linie wurden übersehen. " +
      "Das ist der Bereich, in dem am meisten konkret gerechnet werden muss. Nimm dir vor jedem Zug bewusst Zeit, die unmittelbaren Antworten " +
      "des Gegners auf Schach-, Schlag- und Drohzüge durchzugehen.",
  },
  middlegame_mistake: {
    title: "Ungenauigkeit im Mittelspiel",
    explanation:
      "Kein sofortiger Materialverlust, aber ein strategischer Fehler - ein unpassender Plan, ein zugelassenes schwaches Feld oder ein " +
      "Abtausch zur falschen Zeit. Frag dich vor jedem Zug: Verbessert das meine schlechteste Figur oder schwächt es meine Stellung langfristig?",
  },
  endgame_blunder: {
    title: "Patzer im Endspiel",
    explanation:
      "Im Endspiel entscheiden oft kleine Details: Opposition, Zugzwang oder eine falsch berechnete Bauernvariante. Ein Patzer hier kostet " +
      "meist direkt die Partie, weil es kaum noch Ausgleichschancen gibt. Übe Grundtechniken wie Königsopposition und einfache Turmendspiele, " +
      "bis sie automatisch sitzen.",
  },
  endgame_mistake: {
    title: "Ungenauigkeit im Endspiel",
    explanation:
      "Keine sofortige Katastrophe, aber suboptimale Technik - zum Beispiel ein zu passiver König oder eine ungünstig gewählte Bauernstruktur. " +
      "Im Endspiel ist der König eine aktive Figur: Bring ihn frühzeitig ins Zentrum, sobald die Damen vom Brett sind.",
  },
};

const FALLBACK_PATTERN = {
  title: "Wiederkehrender Fehler",
  explanation:
    "Dieser Fehlertyp ist bei dir häufiger aufgetreten. Schau dir die Beispielstellungen unten genau an und versuche, das gemeinsame Muster zu erkennen.",
};

async function selectPositions(userId, mistakeType) {
  const { data: ownMistakes } = await supabaseAdmin
    .from("user_mistakes")
    .select("game_id, move_index")
    .eq("user_id", userId)
    .eq("mistake_type", mistakeType)
    .limit(3);

  const ownExamples = (ownMistakes || []).map((m) => ({
    source: "own",
    gameId: m.game_id,
    moveIndex: m.move_index,
  }));

  if (ownExamples.length >= MIN_OWN_EXAMPLES) return ownExamples;

  const { data: generic } = await supabaseAdmin
    .from("generic_positions")
    .select("fen, solution, comment")
    .eq("mistake_type", mistakeType)
    .limit(3 - ownExamples.length);

  return [...ownExamples, ...(generic || []).map((g) => ({ source: "generic", ...g }))];
}

export async function generateLesson(userId, mistakeType) {
  const examples = await selectPositions(userId, mistakeType);

  // GEÄNDERT: Titel/Erklärung kommen jetzt aus MISTAKE_PATTERNS statt aus
  // dem TODO-Platzhalter. Fällt auf einen generischen Text zurück, falls
  // mistakeType (noch) nicht in der Map steht.
  const pattern = MISTAKE_PATTERNS[mistakeType] || FALLBACK_PATTERN;

  const lesson = {
    user_id: userId,
    mistake_type: mistakeType,
    title: pattern.title,
    explanation: pattern.explanation,
    example_fens: examples,
  };

  const { data, error } = await supabaseAdmin.from("personal_lessons").insert(lesson).select().maybeSingle();
  if (error) throw error;
  return data;
}
