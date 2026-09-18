import { supabaseAdmin } from "./supabaseAdmin.js";

// Je kleiner, desto staerker verlieren aeltere Fehler an Gewicht (in Tagen).
// Ein Fehler von vor HALF_LIFE_DAYS Tagen zaehlt nur noch halb so viel wie einer von heute.
const HALF_LIFE_DAYS = 30;

function recencyWeight(createdAt) {
  if (!createdAt) return 1; // Fallback, falls created_at fehlt
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

// ANNAHME: user_mistakes hat eine "created_at"-Spalte (Supabase-Standard,
// default now()). Falls die Spalte anders heisst, hier anpassen.
export async function getTopWeaknesses(userId, limit = 3) {
  const { data } = await supabaseAdmin
    .from("user_mistakes")
    .select("mistake_type, phase, created_at")
    .eq("user_id", userId);

  const stats = {};
  for (const row of data || []) {
    if (!stats[row.mistake_type]) {
      stats[row.mistake_type] = { count: 0, score: 0 };
    }
    stats[row.mistake_type].count += 1;
    // GEAENDERT: statt reiner Haeufigkeit fliesst jetzt auch das Alter ein,
    // damit ein laengst behobener Fehler nicht dauerhaft oben bleibt.
    stats[row.mistake_type].score += recencyWeight(row.created_at);
  }

  return Object.entries(stats)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([mistake_type, { count }]) => ({ mistake_type, count }));
}
