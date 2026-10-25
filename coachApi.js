// The coach's answers come from the Anthropic API (Claude).
//
// Only the HTTP call lives here - no database and no socket - so it can be
// tested with a fake fetch (coachApi.test.js). coachSocket.js does the rest.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 400;
const TIMEOUT_MS = 25000;

// Thrown when no answer could be fetched. `message` is the code the app gets,
// `detail` the real reason - that one only goes into the server log.
export class CoachError extends Error {
    constructor(code, detail) {
        super(code);
        this.name = "CoachError";
        this.detail = detail;
    }
}

// Without the key every question fails; coachSocket.js says so in the log
// when the server starts.
export function coachConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Sends one question to the model and returns its answer as text.
 *
 * Never returns a made-up answer. If there is none it throws a CoachError:
 *   COACH_NOT_CONFIGURED  ANTHROPIC_API_KEY is missing on the server
 *   COACH_UNAVAILABLE     the API refused the request (wrong key, no credit
 *                         left, rate limit ...), took too long or sent no text
 *
 * @param {object} p
 * @param {string} p.system    who the coach is and how it should answer
 * @param {string} p.question  the position / move and the player's question
 */
export async function requestCoachAnswer({
    system,
    question,
    apiKey = process.env.ANTHROPIC_API_KEY,
    fetchFn = fetch,
    timeoutMs = TIMEOUT_MS,
}) {
    if (!apiKey) {
        throw new CoachError("COACH_NOT_CONFIGURED", "ANTHROPIC_API_KEY is not set");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let data = null;

    try {
        response = await fetchFn(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system,
                messages: [{ role: "user", content: question }],
            }),
            signal: controller.signal,
        });

        // An error page that is not JSON is handled below through response.ok.
        data = await response.json().catch(() => null);
    } catch (error) {
        const reason = error?.name === "AbortError" ? `no answer after ${timeoutMs} ms` : error?.message;
        throw new CoachError("COACH_UNAVAILABLE", `request failed: ${reason}`);
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        // e.g. 401 authentication_error (wrong key) or
        //      400 invalid_request_error "Your credit balance is too low ..."
        const type = data?.error?.type ?? "error";
        const message = data?.error?.message ?? "no details";
        throw new CoachError("COACH_UNAVAILABLE", `API answered ${response.status} ${type}: ${message}`);
    }

    const answer = (Array.isArray(data?.content) ? data.content : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();

    if (!answer) {
        throw new CoachError("COACH_UNAVAILABLE", `API sent no text (stop_reason: ${data?.stop_reason ?? "unknown"})`);
    }

    return answer;
}
