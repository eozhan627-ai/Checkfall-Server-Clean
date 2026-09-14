import { supabaseAdmin } from "./supabaseAdmin.js";

export async function getTopWeaknesses(userId, limit = 3) {
    const { data } = await supabaseAdmin
        .from("user_mistakes")
        .select("mistake_type, phase")
        .eq("user_id", userId);

    const counts = {};
    for (const row of data || []) {
        counts[row.mistake_type] = (counts[row.mistake_type] || 0) + 1;
    }

    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([mistake_type, count]) => ({ mistake_type, count }));
}