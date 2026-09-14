import { supabaseAdmin } from "./supabaseAdmin.js";

const MIN_OWN_EXAMPLES = 2;

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
    // Titel/Erklärungstext: entweder statisch aus einer mistakePatterns-Map, oder per Claude generiert
    const lesson = {
        user_id: userId,
        mistake_type: mistakeType,
        title: `Lektion: ${mistakeType}`,
        explanation: "TODO: Erklärungstext (statisch oder via Claude generiert)",
        example_fens: examples,
    };

    const { data, error } = await supabaseAdmin.from("personal_lessons").insert(lesson).select().maybeSingle();
    if (error) throw error;
    return data;
}