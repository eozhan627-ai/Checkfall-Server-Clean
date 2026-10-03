// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
    callerAddress,
    cleanText,
    createLimiter,
    validateClientError,
    validateReport,
    validateSupport,
} from "./feedbackRules.js";

test("text is trimmed, cut and freed from control characters", () => {
    assert.equal(cleanText("  hello\u0000 world\u0007  ", 50), "hello world");
    assert.equal(cleanText("line 1\nline 2", 50), "line 1\nline 2");
    assert.equal(cleanText("abcdef", 3), "abc");
    assert.equal(cleanText(42, 10), "");
    assert.equal(cleanText(null, 10), "");
});

test("a report needs a known reason", () => {
    assert.deepEqual(validateReport({ reason: "cheating" }), { ok: true, value: { reason: "cheating", details: "" } });
    assert.deepEqual(validateReport({ reason: "hacking" }), { ok: false, error: "INVALID_REASON" });
    assert.deepEqual(validateReport(undefined), { ok: false, error: "INVALID_REASON" });
    assert.deepEqual(validateReport({ reason: "other", details: " hm " }), { ok: false, error: "DETAILS_REQUIRED" });
    assert.equal(validateReport({ reason: "other", details: "kept insulting me in chat" }).ok, true);
    assert.equal(validateReport({ reason: "abuse", details: "x".repeat(5000) }).value.details.length, 1000);
});

test("a support request needs a real message", () => {
    assert.deepEqual(validateSupport({ message: "help" }), { ok: false, error: "MESSAGE_TOO_SHORT" });

    const result = validateSupport({ category: "nonsense", message: "  The app closes when I open a puzzle.  ", contact: "me@example.com", platform: "android" });
    assert.deepEqual(result, {
        ok: true,
        value: { category: "other", message: "The app closes when I open a puzzle.", contact: "me@example.com", platform: "android", appVersion: "" },
    });
    assert.equal(validateSupport({ category: "payment", message: "I paid but have no VIP." }).value.category, "payment");
});

test("error reports are cut to size", () => {
    assert.deepEqual(validateClientError({}), { ok: false, error: "MESSAGE_REQUIRED" });

    const result = validateClientError({ message: "m".repeat(900), stack: "s".repeat(9000), fatal: "yes", screen: 5 });
    assert.equal(result.value.message.length, 500);
    assert.equal(result.value.stack.length, 4000);
    assert.equal(result.value.fatal, false);
    assert.equal(result.value.screen, "");
    assert.equal(validateClientError({ message: "boom", fatal: true }).value.fatal, true);
});

test("the limiter allows a number of calls per window and key", () => {
    let time = 0;
    const allow = createLimiter(3, 1000, () => time);

    assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
    assert.equal(allow("b"), true);

    time = 999;
    assert.equal(allow("a"), false);

    time = 1000; // the first three are now outside the window
    assert.equal(allow("a"), true);
});

test("the caller's address is the one the proxy added", () => {
    assert.equal(callerAddress({ headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } }), "9.9.9.9");
    assert.equal(callerAddress({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
    assert.equal(callerAddress({}), "unknown");
});
