// Daily analysis allowance for players without VIP.
//
//   - FREE_PER_DAY analyses a day are free.
//   - After that, every further analysis has to be unlocked by watching an
//     ad (at most ADS_PER_DAY a day, so the engine time stays bounded).
//
// The counters live in the table "analysis_usage" (see
// supabase/003_daily_limits.sql). Until that script has run they are kept
// in memory, which is good enough but forgets them when the server restarts.

import { supabaseAdmin } from "./supabaseAdmin.js";

export const FREE_PER_DAY = Number(process.env.FREE_ANALYSES_PER_DAY) || 1;
export const ADS_PER_DAY = Number(process.env.AD_ANALYSES_PER_DAY) || 5;

const memory = new Map(); // "user|date" -> { free, ad }
let tableMissing = false;

// The day changes at midnight UTC.
const today = () => new Date().toISOString().slice(0, 10);

function isMissingSchema(error) {
    return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code);
}

function fromMemory(authId) {
    return memory.get(`${authId}|${today()}`) ?? { free: 0, ad: 0 };
}

/** @returns {Promise<{ free: number, ad: number }>} analyses used today */
export async function getUsage(authId) {
    if (tableMissing) return fromMemory(authId);

    const { data, error } = await supabaseAdmin
        .from("analysis_usage")
        .select("free_count, ad_count")
        .eq("user_id", authId)
        .eq("usage_date", today())
        .maybeSingle();

    if (error) {
        if (isMissingSchema(error)) {
            tableMissing = true;
            console.log('Table "analysis_usage" is missing - counting analyses in memory. Run supabase/003_daily_limits.sql.');
        } else {
            console.log("ANALYSIS USAGE ERROR:", error.message);
        }
        return fromMemory(authId);
    }

    return { free: data?.free_count ?? 0, ad: data?.ad_count ?? 0 };
}

/**
 * Adds to today's counters (delta may be negative to give one back).
 * @param {"free" | "ad"} kind
 */
export async function addUsage(authId, kind, delta = 1) {
    const current = await getUsage(authId);
    const next = { ...current, [kind]: Math.max(0, current[kind] + delta) };

    // Keep the in-memory copy as well: it is the fallback if the write fails.
    memory.set(`${authId}|${today()}`, next);
    if (memory.size > 5000) memory.clear();

    if (tableMissing) return next;

    const row = { free_count: next.free, ad_count: next.ad };

    const { data: existing } = await supabaseAdmin
        .from("analysis_usage")
        .select("user_id")
        .eq("user_id", authId)
        .eq("usage_date", today())
        .maybeSingle();

    const { error } = existing
        ? await supabaseAdmin.from("analysis_usage").update(row).eq("user_id", authId).eq("usage_date", today())
        : await supabaseAdmin.from("analysis_usage").insert({ user_id: authId, usage_date: today(), ...row });

    if (error && !isMissingSchema(error)) console.log("SAVE ANALYSIS USAGE ERROR:", error.message);

    return next;
}

/** What the app shows: how many analyses are left today. */
export function quotaFor(usage) {
    return {
        freePerDay: FREE_PER_DAY,
        freeLeft: Math.max(0, FREE_PER_DAY - usage.free),
        adsLeft: Math.max(0, ADS_PER_DAY - usage.ad),
    };
}
