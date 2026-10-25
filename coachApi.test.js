import test from "node:test";
import assert from "node:assert/strict";
import { CoachError, requestCoachAnswer } from "./coachApi.js";

const ask = { system: "You are a chess coach.", question: "Why is Nf3 good?" };

// A fetch that answers with the given status and JSON body.
const fakeFetch = (status, body, calls = []) => async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
};

async function failure(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    assert.fail("expected the request to fail");
}

test("the answer of the model is returned as text", async () => {
    const calls = [];
    const fetchFn = fakeFetch(200, { content: [{ type: "text", text: " Nf3 develops " }, { type: "text", text: "a piece." }] }, calls);

    const answer = await requestCoachAnswer({ ...ask, apiKey: "key-123", fetchFn });

    assert.equal(answer, "Nf3 develops a piece.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers["x-api-key"], "key-123");

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.system, ask.system);
    assert.deepEqual(body.messages, [{ role: "user", content: ask.question }]);
});

test("without a key nothing is sent", async () => {
    const calls = [];
    const error = await failure(requestCoachAnswer({ ...ask, apiKey: "", fetchFn: fakeFetch(200, {}, calls) }));

    assert.ok(error instanceof CoachError);
    assert.equal(error.message, "COACH_NOT_CONFIGURED");
    assert.equal(calls.length, 0);
});

test("a refused request is an error, not an answer", async () => {
    const wrongKey = await failure(
        requestCoachAnswer({
            ...ask,
            apiKey: "wrong",
            fetchFn: fakeFetch(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
        })
    );
    assert.equal(wrongKey.message, "COACH_UNAVAILABLE");
    assert.match(wrongKey.detail, /401 authentication_error: invalid x-api-key/);

    const noCredit = await failure(
        requestCoachAnswer({
            ...ask,
            apiKey: "key",
            fetchFn: fakeFetch(400, { error: { type: "invalid_request_error", message: "Your credit balance is too low" } }),
        })
    );
    assert.equal(noCredit.message, "COACH_UNAVAILABLE");
    assert.match(noCredit.detail, /credit balance is too low/);
});

test("an answer without text is an error", async () => {
    const error = await failure(
        requestCoachAnswer({ ...ask, apiKey: "key", fetchFn: fakeFetch(200, { content: [], stop_reason: "max_tokens" }) })
    );
    assert.equal(error.message, "COACH_UNAVAILABLE");
    assert.match(error.detail, /max_tokens/);
});

test("a broken connection and a slow API do not hang the question", async () => {
    const offline = await failure(
        requestCoachAnswer({
            ...ask,
            apiKey: "key",
            fetchFn: async () => {
                throw new Error("getaddrinfo ENOTFOUND");
            },
        })
    );
    assert.equal(offline.message, "COACH_UNAVAILABLE");
    assert.match(offline.detail, /ENOTFOUND/);

    // never answers until the request is cancelled
    const slowFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
                const aborted = new Error("aborted");
                aborted.name = "AbortError";
                reject(aborted);
            });
        });

    const slow = await failure(requestCoachAnswer({ ...ask, apiKey: "key", fetchFn: slowFetch, timeoutMs: 20 }));
    assert.equal(slow.message, "COACH_UNAVAILABLE");
    assert.match(slow.detail, /no answer after 20 ms/);
});
