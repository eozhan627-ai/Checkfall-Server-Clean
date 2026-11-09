// Push notifications through Expo's push service.
//
// The app registers its Expo push token (POST /push/token) and the player's
// choices; the server sends:
//   - Daily Chess: "your move", game started / ended        (notify_daily)
//   - "Someone is looking for an opponent"                    (notify_searching)
//   - Rush Hour starts in 15 minutes                          (notify_events)
//
// Optional on the server (Render -> Environment):
//   EXPO_ACCESS_TOKEN   only needed if "Enhanced push security" is switched
//                       on for the project at expo.dev
//
// Until supabase/007_daily_chess_and_push.sql has run, nothing is sent.

import { supabaseAdmin } from "./supabaseAdmin.js";
import { currentOrNextRushHour } from "./rushHour.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN || "";

const TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,}\]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Someone is searching": each player at most once in this time, never
// at night, and at most one round of such messages per ROUND_GAP.
export const SEARCH_NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000;
export const SEARCH_ROUND_GAP_MS = 10 * 60 * 1000;
export const SEARCH_NOTIFY_MAX = 40;
const QUIET_FROM_HOUR = 22;
const QUIET_UNTIL_HOUR = 9;

export function isValidPushToken(token) {
    return typeof token === "string" && TOKEN.test(token);
}

/** Hour of the day in Berlin (players are mostly German). */
export function berlinHour(now = Date.now()) {
    return Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(now)
    );
}

export function isQuietTime(now = Date.now()) {
    const hour = berlinHour(now);
    return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

async function sendMessages(messages) {
    if (messages.length === 0) return;

    for (const batch of chunk(messages, 100)) {
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    ...(ACCESS_TOKEN ? { Authorization: `Bearer ${ACCESS_TOKEN}` } : {}),
                },
                body: JSON.stringify(batch),
            });

            const body = await response.json().catch(() => null);
            const tickets = Array.isArray(body?.data) ? body.data : [];

            // Phones that uninstalled the app: forget their token.
            const gone = tickets
                .map((ticket, index) => (ticket?.details?.error === "DeviceNotRegistered" ? batch[index].to : null))
                .filter(Boolean);

            if (gone.length && supabaseAdmin) {
                await supabaseAdmin.from("push_tokens").delete().in("token", gone);
            }
        } catch (error) {
            console.log("PUSH SEND ERROR:", error?.message);
        }
    }
}

function message(token, { title, body, data }) {
    return { to: token, title, body, data: data || {}, sound: "default", channelId: "default", priority: "high" };
}

/**
 * Sends one notification to all phones of these players that want this kind.
 * kind: "daily" | "searching" | "events"
 */
export async function pushToUsers(userIds, kind, content) {
    if (!supabaseAdmin) return;

    const ids = [...new Set(userIds)].filter((id) => UUID.test(String(id)));
    if (ids.length === 0) return;

    const { data, error } = await supabaseAdmin
        .from("push_tokens")
        .select("token")
        .in("user_id", ids)
        .eq(`notify_${kind}`, true);

    if (error) return;

    await sendMessages((data || []).map((row) => message(row.token, content)));
}

let lastSearchRound = 0;

/**
 * "Someone is looking for an opponent" to players who are not in the app,
 * want it, and did not get one lately.
 *
 * searcher: { authId, name, timeControl }
 * onlineUserIds: players connected right now (they do not need a push)
 */
export async function notifySearching(searcher, onlineUserIds, now = Date.now()) {
    if (!supabaseAdmin) return false;
    if (isQuietTime(now)) return false;
    if (now - lastSearchRound < SEARCH_ROUND_GAP_MS) return false;

    lastSearchRound = now;

    const since = new Date(now - SEARCH_NOTIFY_COOLDOWN_MS).toISOString();

    const { data, error } = await supabaseAdmin
        .from("push_tokens")
        .select("token, user_id")
        .eq("notify_searching", true)
        .or(`last_search_notify_at.is.null,last_search_notify_at.lt.${since}`)
        .order("updated_at", { ascending: false })
        .limit(SEARCH_NOTIFY_MAX * 2);

    if (error) return false;

    const online = new Set(onlineUserIds);
    const rows = (data || [])
        .filter((row) => row.user_id !== searcher.authId && !online.has(row.user_id))
        .slice(0, SEARCH_NOTIFY_MAX);

    if (rows.length === 0) return false;

    await supabaseAdmin
        .from("push_tokens")
        .update({ last_search_notify_at: new Date(now).toISOString() })
        .in("token", rows.map((row) => row.token));

    await sendMessages(
        rows.map((row) =>
            message(row.token, {
                title: "Gegner gesucht ♟️",
                body: `Jemand sucht gerade eine ${searcher.timeControl}-Partie. Jetzt spielen?`,
                data: { url: "/" },
            })
        )
    );

    return true;
}

// Rush Hour reminder, 15 minutes before the start (checked every minute).
let remindedFor = 0;

async function remindRushHour(now = Date.now()) {
    if (!supabaseAdmin) return;

    const event = currentOrNextRushHour(now);
    const until = event.startsAt - now;

    if (event.live || until > 15 * 60_000 || until < 10 * 60_000) return;
    if (remindedFor === event.startsAt) return;

    remindedFor = event.startsAt;

    const { data, error } = await supabaseAdmin.from("push_tokens").select("token").eq("notify_events", true);
    if (error) return;

    await sendMessages(
        (data || []).map((row) =>
            message(row.token, {
                title: "Rush Hour in 15 Minuten ⚡",
                body: `Gleich spielen alle gleichzeitig (${event.timeControl}). Sei dabei!`,
                data: { url: "/" },
            })
        )
    );

    console.log("RUSH HOUR REMINDER SENT:", (data || []).length);
}

export function startPushJobs() {
    setInterval(() => remindRushHour().catch(() => { }), 60_000);
}

export function setupPushRoutes(app, { getAuthIdFromRequest }) {
    // The app registers its token and the player's choices.
    app.post("/push/token", async (req, res) => {
        const authId = await getAuthIdFromRequest(req).catch(() => null);
        if (!authId) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
        if (!supabaseAdmin) return res.status(503).json({ error: "NOT_AVAILABLE" });

        const token = req.body?.token;
        if (!isValidPushToken(token)) return res.status(400).json({ error: "INVALID_TOKEN" });

        const row = {
            token,
            user_id: authId,
            platform: typeof req.body?.platform === "string" ? req.body.platform.slice(0, 20) : "",
            updated_at: new Date().toISOString(),
        };

        for (const key of ["daily", "searching", "events"]) {
            const value = req.body?.preferences?.[key];
            if (typeof value === "boolean") row[`notify_${key}`] = value;
        }

        const { error } = await supabaseAdmin.from("push_tokens").upsert(row, { onConflict: "token" });
        if (error) return res.status(503).json({ error: "NOT_AVAILABLE" });

        res.json({ success: true });
    });

    // Sign-out: this phone gets nothing any more.
    app.post("/push/token/remove", async (req, res) => {
        const token = req.body?.token;
        if (!isValidPushToken(token) || !supabaseAdmin) return res.json({ success: true });

        await supabaseAdmin.from("push_tokens").delete().eq("token", token);
        res.json({ success: true });
    });
}
