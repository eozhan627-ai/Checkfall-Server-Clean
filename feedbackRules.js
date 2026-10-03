// Player reports, support requests and error reports: what is accepted.
// Pure functions (tested in feedbackRules.test.js). Saving is in feedback.js.

export const REPORT_REASONS = ["cheating", "abuse", "stalling", "name", "other"];
export const SUPPORT_CATEGORIES = ["bug", "account", "payment", "player", "idea", "other"];

// How much one person may send.
export const LIMITS = {
    reportsPerDay: 10,
    supportPerHour: 5,
    errorsPerHour: 20,
};

const MAX = { details: 1000, message: 3000, contact: 200, short: 120, errorMessage: 500, stack: 4000, pgn: 20000 };

/** Text as people typed it: trimmed, without control characters, cut to max. */
export function cleanText(value, max) {
    if (typeof value !== "string") return "";

    return value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
        .slice(0, max);
}

/** @returns {{ ok: true, value: object } | { ok: false, error: string }} */
export function validateReport(input) {
    const reason = input?.reason;

    if (!REPORT_REASONS.includes(reason)) return { ok: false, error: "INVALID_REASON" };

    const details = cleanText(input?.details, MAX.details);

    // "Other" without a word of explanation helps nobody.
    if (reason === "other" && details.length < 5) return { ok: false, error: "DETAILS_REQUIRED" };

    return { ok: true, value: { reason, details } };
}

export function validateSupport(input) {
    const category = SUPPORT_CATEGORIES.includes(input?.category) ? input.category : "other";
    const message = cleanText(input?.message, MAX.message);

    if (message.length < 10) return { ok: false, error: "MESSAGE_TOO_SHORT" };

    return {
        ok: true,
        value: {
            category,
            message,
            contact: cleanText(input?.contact, MAX.contact),
            platform: cleanText(input?.platform, MAX.short),
            appVersion: cleanText(input?.appVersion, MAX.short),
        },
    };
}

export function validateClientError(input) {
    const message = cleanText(input?.message, MAX.errorMessage);

    if (!message) return { ok: false, error: "MESSAGE_REQUIRED" };

    return {
        ok: true,
        value: {
            message,
            stack: cleanText(input?.stack, MAX.stack),
            screen: cleanText(input?.screen, MAX.short),
            platform: cleanText(input?.platform, MAX.short),
            appVersion: cleanText(input?.appVersion, MAX.short),
            fatal: input?.fatal === true,
        },
    };
}

export function cleanPgn(value) {
    return cleanText(value, MAX.pgn);
}

/**
 * Counts per key inside a time window.
 * limiter(key) returns true while the key is inside its allowance.
 */
export function createLimiter(max, windowMs, now = () => Date.now()) {
    const hits = new Map();

    return (key) => {
        const time = now();
        const recent = (hits.get(key) ?? []).filter((at) => time - at < windowMs);

        if (recent.length >= max) {
            hits.set(key, recent);
            return false;
        }

        recent.push(time);
        hits.set(key, recent);

        // Forget keys that have gone quiet, so the map cannot grow forever.
        if (hits.size > 5000) {
            for (const [other, times] of hits) {
                if (times.every((at) => time - at >= windowMs)) hits.delete(other);
            }
        }

        return true;
    };
}

/**
 * The address of the caller behind the hosting proxy. The proxy appends the
 * real address at the end of x-forwarded-for; anything before it can be
 * made up by the caller.
 */
export function callerAddress(req) {
    const forwarded = String(req?.headers?.["x-forwarded-for"] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    return forwarded.at(-1) || req?.socket?.remoteAddress || "unknown";
}
