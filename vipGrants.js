// Free VIP from promo codes - e.g. the TikTok launch promo: the first 100
// players who enter the code get Gold VIP for one year.
//
// The codes and who redeemed them are in the database
// (supabase/006_promo_codes.sql):
//   promo_codes   one row per code: plan, number of days, how many players
//   vip_grants    one row per redemption: player, plan, until when
//
// profiles.vip_tier stays the one plan the rest of the server and the app
// read. It is the better of
//   profiles.vip_base_tier   the plan without codes (the store subscription,
//                            see vipSubscriptions.js, or set by hand)
//   the player's codes that are still running
//
// Route:
//   POST /promo/redeem  { code }   redeems a code for the signed-in player
//
// Once an hour the server ends the codes whose time is up and lowers the
// plans again - and once shortly after it starts, because a server that was
// asleep missed the hourly checks.

import { supabaseAdmin } from "./supabaseAdmin.js";
import { callerAddress, createLimiter } from "./feedbackRules.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const TIER_RANK = { none: 0, silver: 1, gold: 2, diamond: 3 };

// Postgres / PostgREST answers that mean "supabase/006 has not run yet".
const NOT_SET_UP = new Set(["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"]);

/** The best of several plans ("none" when there is none). */
export function bestTier(tiers) {
    let best = "none";

    for (const tier of tiers) {
        if (TIER_RANK[tier] > TIER_RANK[best]) best = tier;
    }

    return best;
}

/**
 * A code as the player typed it -> as it is stored (" tiktok 100" ->
 * "TIKTOK100"), or null when it cannot be a code at all.
 */
export function cleanCode(input) {
    if (typeof input !== "string" || input.length > 64) return null;

    const code = input.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
    return /^[A-Z0-9-]{4,24}$/.test(code) ? code : null;
}

/** The plans of the codes that are still running at `now`. */
export function runningTiers(grants, now = Date.now()) {
    return (grants ?? []).filter((grant) => Date.parse(grant?.ends_at) > now).map((grant) => grant.tier);
}

/** The plan a player has: the plan without codes or a running code, whichever is better. */
export function effectiveTier(baseTier, grants, now = Date.now()) {
    return bestTier([baseTier || "none", ...runningTiers(grants, now)]);
}

/** HTTP status and body for each answer of redeem_promo_code(). */
export function redeemResponse(result) {
    switch (result?.status) {
        case "ok":
            return {
                status: 200,
                body: {
                    success: true,
                    tier: result.tier,
                    endsAt: result.ends_at ?? null,
                    place: result.place ?? null,
                    of: result.max_uses ?? null,
                },
            };
        case "already":
            return { status: 409, body: { error: "ALREADY_REDEEMED", tier: result.tier, endsAt: result.ends_at ?? null } };
        case "used_up":
            return { status: 409, body: { error: "USED_UP" } };
        case "expired":
            return { status: 410, body: { error: "EXPIRED" } };
        case "not_started":
            return { status: 403, body: { error: "NOT_STARTED", startsAt: result.starts_at ?? null } };
        default:
            return { status: 404, body: { error: "INVALID" } };
    }
}

function dbError(error) {
    const wrapped = new Error(error?.message || "DATABASE_ERROR");
    wrapped.code = error?.code;
    return wrapped;
}

async function readPlan(db, authId) {
    const { data, error } = await db.from("profiles").select("vip_tier, vip_base_tier").eq("id", authId).maybeSingle();

    if (error) throw dbError(error);
    if (!data) throw new Error("PROFILE_NOT_FOUND");

    return data;
}

async function writePlan(db, authId, tier, previous, reason) {
    const { error } = await db.from("profiles").update({ vip_tier: tier }).eq("id", authId);
    if (error) throw dbError(error);

    console.log("VIP CHANGED:", { authId, from: previous, to: tier, reason });
}

/**
 * Sets profiles.vip_tier to the better of the plan without codes and the
 * player's running codes (after the store plan changed or a code ended).
 */
export async function recomputeVip(authId, { db = supabaseAdmin, now = Date.now() } = {}) {
    if (!db) throw new Error("NOT_SET_UP");

    const profile = await readPlan(db, authId);

    const { data: grants, error } = await db.from("vip_grants").select("tier, ends_at").eq("user_id", authId);
    if (error) throw dbError(error);

    const current = profile.vip_tier || "none";
    const tier = effectiveTier(profile.vip_base_tier, grants, now);

    if (tier !== current) await writePlan(db, authId, tier, current, "plan or codes changed");

    return { tier, changed: tier !== current };
}

/**
 * Right after a redemption: the code's plan, unless the player already has
 * a better one. Never lowers a plan (one set by hand stays).
 */
export async function liftVip(authId, tier, { db = supabaseAdmin } = {}) {
    if (!db) throw new Error("NOT_SET_UP");

    const profile = await readPlan(db, authId);
    const current = profile.vip_tier || "none";
    const next = bestTier([current, tier]);

    if (next !== current) await writePlan(db, authId, next, current, "promo code");

    return { tier: next, changed: next !== current };
}

/**
 * Ends the codes whose time is up and lowers the players' plans again.
 * @returns {Promise<number>} how many redemptions ended
 */
export async function endFinishedGrants({ db = supabaseAdmin, now = Date.now() } = {}) {
    if (!db) return 0;

    const { data, error } = await db
        .from("vip_grants")
        .select("id, user_id")
        .eq("ended", false)
        .lte("ends_at", new Date(now).toISOString())
        .limit(500);

    if (error) {
        if (NOT_SET_UP.has(error.code)) return 0;
        throw dbError(error);
    }

    const byPlayer = new Map();

    for (const grant of data ?? []) {
        if (!byPlayer.has(grant.user_id)) byPlayer.set(grant.user_id, []);
        byPlayer.get(grant.user_id).push(grant.id);
    }

    const ended = [];

    for (const [authId, ids] of byPlayer) {
        try {
            await recomputeVip(authId, { db, now });
            ended.push(...ids);
        } catch (failure) {
            // A deleted account has no plan to lower any more.
            if (failure.message === "PROFILE_NOT_FOUND") ended.push(...ids);
            else console.error("VIP CODE END ERROR:", { authId, message: failure.message });
        }
    }

    if (ended.length > 0) {
        const { error: updateError } = await db.from("vip_grants").update({ ended: true }).in("id", ended);
        if (updateError) throw dbError(updateError);
    }

    return ended.length;
}

/** Checks for ended codes shortly after the start and then every hour. */
export function startGrantChecks({ db = supabaseAdmin, firstAfterMs = 30 * 1000, everyMs = HOUR } = {}) {
    if (!db) return () => undefined;

    const run = () =>
        endFinishedGrants({ db })
            .then((count) => {
                if (count > 0) console.log("VIP CODES ENDED:", count);
            })
            .catch((error) => console.error("VIP CODE CHECK ERROR:", error?.message));

    const first = setTimeout(run, firstAfterMs);
    const timer = setInterval(run, everyMs);

    first.unref?.();
    timer.unref?.();

    return () => {
        clearTimeout(first);
        clearInterval(timer);
    };
}

/** Counts events per key in a time window (here: wrong codes per address). */
export function createCounter(max, windowMs, now = () => Date.now()) {
    const events = new Map();

    const recent = (key) => (events.get(key) ?? []).filter((at) => now() - at < windowMs);

    return {
        full: (key) => recent(key).length >= max,
        add: (key) => {
            events.set(key, [...recent(key), now()]);
            if (events.size > 5000) events.clear();
        },
    };
}

export function setupPromoRoutes(app, { getAuthIdFromRequest, db = supabaseAdmin, now = () => Date.now() }) {
    // Enough for typos, far too few to guess codes. Per address only wrong
    // codes count: many players share one mobile network address, and at the
    // launch a lot of them redeem the same code within minutes.
    const playerAllowed = createLimiter(8, 10 * MINUTE, now);
    const wrongCodes = createCounter(30, HOUR, now);

    app.post("/promo/redeem", async (req, res) => {
        const authId = await getAuthIdFromRequest(req).catch(() => null);
        if (!authId) return res.status(401).json({ error: "SIGN_IN_REQUIRED" });

        const address = callerAddress(req);

        if (wrongCodes.full(address) || !playerAllowed(authId)) {
            return res.status(429).json({ error: "TOO_MANY" });
        }

        const code = cleanCode(req.body?.code);

        if (!code) {
            wrongCodes.add(address);
            return res.status(404).json({ error: "INVALID" });
        }

        if (!db) return res.status(503).json({ error: "NOT_SET_UP" });

        try {
            const { data, error } = await db.rpc("redeem_promo_code", { p_user_id: authId, p_code: code });

            if (error) {
                if (NOT_SET_UP.has(error.code)) return res.status(503).json({ error: "NOT_SET_UP" });
                throw dbError(error);
            }

            // The plan follows right away. "already": the app may not have got
            // the answer of an earlier try - the plan is set again, as long as
            // the code is still running.
            const running = data?.status === "already" && Date.parse(data.ends_at) > now();

            if (data?.status === "ok" || running) await liftVip(authId, data.tier, { db });

            if (data?.status === "ok") {
                console.log("PROMO CODE REDEEMED:", { code, authId, tier: data.tier, place: data.place });
            }

            const { status, body } = redeemResponse(data);
            if (body.error === "INVALID") wrongCodes.add(address);

            res.status(status).json(body);
        } catch (error) {
            console.error("PROMO CODE ERROR:", { code, authId, message: error?.message });
            res.status(500).json({ error: "FAILED" });
        }
    });
}
