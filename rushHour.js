// Rush Hour: a fixed weekly time when everybody plays at once, so the
// small player base meets in one place. All players use the same time
// control, which keeps them in one queue.
//
// Change the time here (and announce it on TikTok / Instagram). The app
// reads it from GET /events/rush-hour, so no app update is needed.

export const RUSH_HOUR = {
    // 0 = Sunday ... 6 = Saturday, in TIME_ZONE.
    weekday: 0,
    hour: 19,
    minute: 0,
    durationMinutes: 60,
    timeZone: "Europe/Berlin",
    timeControl: "3+2",
};

// Offset of a time zone at a moment, in minutes (Berlin: 60 or 120).
function offsetMinutes(timeZone, date) {
    const text = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value || "GMT";

    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(text);
    if (!match) return 0;

    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

// The moment at which the clock in timeZone shows this local date and time.
export function zonedTime(year, month, day, hour, minute, timeZone) {
    const guess = Date.UTC(year, month, day, hour, minute);
    let result = guess - offsetMinutes(timeZone, new Date(guess)) * 60_000;
    // Around a clock change the offset may differ at the real moment.
    result = guess - offsetMinutes(timeZone, new Date(result)) * 60_000;
    return result;
}

// Local calendar date in timeZone.
function localDate(timeZone, date) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" })
            .formatToParts(date)
            .map((part) => [part.type, part.value])
    );

    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day), weekday: weekdays[parts.weekday] };
}

/**
 * The current or next Rush Hour.
 * @returns {{ startsAt: number, endsAt: number, live: boolean, timeControl: string }}
 */
export function currentOrNextRushHour(now = Date.now(), config = RUSH_HOUR) {
    const today = localDate(config.timeZone, new Date(now));
    const durationMs = config.durationMinutes * 60_000;

    const base = (config.weekday - today.weekday + 7) % 7;

    // Last week's date too, so a Rush Hour that runs past midnight is found.
    for (const daysAhead of [base - 7, base, base + 7]) {

        const startsAt = zonedTime(today.year, today.month, today.day + daysAhead, config.hour, config.minute, config.timeZone);
        const endsAt = startsAt + durationMs;

        if (endsAt > now) {
            return { startsAt, endsAt, live: startsAt <= now, timeControl: config.timeControl };
        }
    }

    throw new Error("unreachable");
}

export function isRushHour(now = Date.now(), config = RUSH_HOUR) {
    return currentOrNextRushHour(now, config).live;
}
