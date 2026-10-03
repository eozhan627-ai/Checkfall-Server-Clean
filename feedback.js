// Player reports, support requests and error reports of the app.
//
// Everything lands in three database tables (see supabase/005_feedback.sql)
// that only this server can read and write. Look at them in the Supabase
// dashboard: Table Editor -> player_reports / support_requests / client_errors.
//
// The rules (what is accepted, how much per person) are in feedbackRules.js.

import { supabaseAdmin } from "./supabaseAdmin.js";
import {
    LIMITS,
    callerAddress,
    cleanPgn,
    cleanText,
    createLimiter,
    validateClientError,
    validateReport,
    validateSupport,
} from "./feedbackRules.js";

const HOUR = 60 * 60 * 1000;

const reportAllowed = createLimiter(LIMITS.reportsPerDay, 24 * HOUR);
const supportAllowed = createLimiter(LIMITS.supportPerHour, HOUR);
const errorAllowed = createLimiter(LIMITS.errorsPerHour, HOUR);

// One report per player and game. (The table has the same rule; this saves
// the round trip and also works before the table exists.)
const reported = new Set();

async function insert(table, row) {
    if (!supabaseAdmin) return { ok: false, error: "NOT_SET_UP" };

    try {
        const { error } = await supabaseAdmin.from(table).insert(row);

        if (error) {
            // 23505 = already there (the same report twice).
            if (error.code === "23505") return { ok: true };

            console.error("FEEDBACK SAVE ERROR:", { table, code: error.code, message: error.message });
            return { ok: false, error: "NOT_SAVED" };
        }

        return { ok: true };
    } catch (error) {
        console.error("FEEDBACK SAVE ERROR:", { table, message: error?.message });
        return { ok: false, error: "NOT_SAVED" };
    }
}

/**
 * Saves a report about the opponent of a game.
 * game: { reporterId, reportedId, reportedName, roomId, pgn, computerOpponent }
 * input: what the app sent ({ reason, details })
 */
export async function saveReport(game, input) {
    if (!game?.reporterId) return { ok: false, error: "SIGN_IN_REQUIRED" };

    const checked = validateReport(input);
    if (!checked.ok) return checked;

    const key = `${game.reporterId}:${game.roomId}`;
    if (reported.has(key)) return { ok: true, already: true };

    if (!reportAllowed(game.reporterId)) return { ok: false, error: "TOO_MANY" };

    const result = await insert("player_reports", {
        reporter_id: game.reporterId,
        reported_id: game.reportedId ?? null,
        reported_name: cleanText(game.reportedName, 60),
        room_id: cleanText(game.roomId, 200),
        reason: checked.value.reason,
        details: checked.value.details,
        pgn: cleanPgn(game.pgn),
        computer_opponent: Boolean(game.computerOpponent),
    });

    if (result.ok) {
        reported.add(key);
        if (reported.size > 20000) reported.clear();

        console.log("PLAYER REPORTED:", { reason: checked.value.reason, reported: game.reportedId ?? game.reportedName });
    }

    return result;
}

export function setupFeedbackRoutes(app, { getAuthIdFromRequest }) {
    // Support form of the app. Works without an account too.
    app.post("/support", async (req, res) => {
        const checked = validateSupport(req.body);
        if (!checked.ok) return res.status(400).json({ error: checked.error });

        if (!supportAllowed(callerAddress(req))) return res.status(429).json({ error: "TOO_MANY" });

        const authId = await getAuthIdFromRequest(req).catch(() => null);

        const result = await insert("support_requests", {
            user_id: authId,
            category: checked.value.category,
            message: checked.value.message,
            contact: checked.value.contact,
            platform: checked.value.platform,
            app_version: checked.value.appVersion,
        });

        if (!result.ok) return res.status(503).json({ error: result.error });

        console.log("SUPPORT REQUEST:", { category: checked.value.category, user: authId });
        res.json({ success: true });
    });

    // Errors the app ran into, sent automatically.
    app.post("/client-error", async (req, res) => {
        const checked = validateClientError(req.body);
        if (!checked.ok) return res.status(400).json({ error: checked.error });

        // Over the limit: say yes and drop it - an app in an error loop
        // must not keep retrying.
        if (!errorAllowed(callerAddress(req))) return res.json({ success: true, dropped: true });

        const authId = await getAuthIdFromRequest(req).catch(() => null);

        await insert("client_errors", {
            user_id: authId,
            message: checked.value.message,
            stack: checked.value.stack,
            screen: checked.value.screen,
            platform: checked.value.platform,
            app_version: checked.value.appVersion,
            fatal: checked.value.fatal,
        });

        res.json({ success: true });
    });
}
