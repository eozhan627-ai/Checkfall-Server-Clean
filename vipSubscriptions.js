// VIP subscriptions (Google Play / App Store, managed through RevenueCat).
//
// The app buys the subscription in the store. RevenueCat keeps track of it
// (free trial, monthly renewal, cancellation, expiry) and is the source of
// truth. This file asks RevenueCat which plan a player currently has and
// writes it to profiles.vip_tier - the app itself can never set that column.
//
// Needed on the server (Render -> Environment):
//   REVENUECAT_SECRET_KEY     secret API key of the RevenueCat project (sk_...)
//   REVENUECAT_WEBHOOK_AUTH   any long random text; the same text is entered
//                             in RevenueCat as the webhook's "Authorization
//                             header value"

import { supabaseAdmin } from "./supabaseAdmin.js";

const SECRET_KEY = process.env.REVENUECAT_SECRET_KEY || "";
const WEBHOOK_AUTH = process.env.REVENUECAT_WEBHOOK_AUTH || "";

// Names of the entitlements in RevenueCat, best plan first.
export const TIERS = ["diamond", "gold", "silver"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function subscriptionsConfigured() {
    return Boolean(SECRET_KEY);
}

/**
 * The plan that is active according to RevenueCat's subscriber data.
 *
 * @returns {{ known: boolean, tier: string, expiresAt: string | null }}
 *   known = false: this player never bought anything (leave the profile alone)
 */
export function tierFromSubscriber(subscriber, now = Date.now()) {
    const entitlements = subscriber?.entitlements ?? {};
    const names = Object.keys(entitlements);

    if (names.length === 0) return { known: false, tier: "none", expiresAt: null };

    for (const tier of TIERS) {
        const entitlement = entitlements[tier];
        if (!entitlement) continue;

        // No expiry date = lifetime purchase.
        const expires = entitlement.expires_date ? Date.parse(entitlement.expires_date) : null;

        if (expires === null || expires > now) {
            return { known: true, tier, expiresAt: entitlement.expires_date ?? null };
        }
    }

    return { known: true, tier: "none", expiresAt: null };
}

async function fetchSubscriber(authId) {
    const response = await fetch(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(authId)}`,
        { headers: { Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" } }
    );

    if (!response.ok) throw new Error(`REVENUECAT_${response.status}`);

    const body = await response.json();
    return body?.subscriber ?? null;
}

/**
 * Reads the player's subscription and stores the plan in the profile.
 * @returns {Promise<{ tier: string, expiresAt: string | null, changed: boolean }>}
 */
export async function syncVip(authId) {
    if (!subscriptionsConfigured()) throw new Error("SUBSCRIPTIONS_NOT_CONFIGURED");
    if (!UUID.test(String(authId))) throw new Error("INVALID_USER");

    const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("vip_tier")
        .eq("id", authId)
        .maybeSingle();

    if (!profile) throw new Error("PROFILE_NOT_FOUND");

    const current = profile.vip_tier || "none";
    const state = tierFromSubscriber(await fetchSubscriber(authId));

    // Never bought anything: a plan that was set by hand (testers, gifts)
    // stays as it is.
    if (!state.known) return { tier: current, expiresAt: null, changed: false };

    let { error } = await supabaseAdmin
        .from("profiles")
        .update({ vip_tier: state.tier, vip_expires_at: state.expiresAt })
        .eq("id", authId);

    // Column "vip_expires_at" not there yet (supabase/004 not run): the plan
    // itself is what matters.
    if (error && ["42703", "PGRST204"].includes(error.code)) {
        ({ error } = await supabaseAdmin.from("profiles").update({ vip_tier: state.tier }).eq("id", authId));
    }

    if (error) throw new Error(error.message);

    if (state.tier !== current) console.log("VIP CHANGED:", { authId, from: current, to: state.tier });

    return { tier: state.tier, expiresAt: state.expiresAt, changed: state.tier !== current };
}

/**
 * Routes:
 *   POST /vip/sync             the app calls this after a purchase / on the VIP page
 *   POST /revenuecat/webhook   RevenueCat calls this on renewals, cancellations, expiry
 */
export function setupVipRoutes(app, { getAuthIdFromRequest }) {
    app.post("/vip/sync", async (req, res) => {
        try {
            const authId = await getAuthIdFromRequest(req);
            if (!authId) return res.status(401).json({ error: "Not signed in" });

            if (!subscriptionsConfigured()) {
                return res.status(503).json({ error: "Subscriptions are not set up yet" });
            }

            const result = await syncVip(authId);
            res.json({ success: true, tier: result.tier, expiresAt: result.expiresAt });
        } catch (error) {
            console.error("VIP SYNC ERROR:", error?.message);
            res.status(500).json({ error: "The subscription could not be checked" });
        }
    });

    app.post("/revenuecat/webhook", async (req, res) => {
        // Only RevenueCat knows this value.
        if (!WEBHOOK_AUTH || req.headers.authorization !== WEBHOOK_AUTH) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const event = req.body?.event ?? {};

        // The ids of the player this event is about (after a login the
        // anonymous id and the account id are both listed).
        const ids = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])];
        const players = [...new Set(ids.filter((id) => UUID.test(String(id))))];

        try {
            // The event only says THAT something changed - what the player
            // has now is always read fresh from RevenueCat.
            for (const authId of players) {
                await syncVip(authId).catch((error) => {
                    if (error.message !== "PROFILE_NOT_FOUND") throw error;
                });
            }

            res.json({ success: true });
        } catch (error) {
            console.error("REVENUECAT WEBHOOK ERROR:", error?.message);
            // An error status makes RevenueCat try again later.
            res.status(500).json({ error: "Could not process the event" });
        }
    });
}
