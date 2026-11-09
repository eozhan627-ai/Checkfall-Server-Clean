// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { isQuietTime, isValidPushToken } from "./push.js";

test("only Expo push tokens are accepted", () => {
    assert.equal(isValidPushToken("ExponentPushToken[abcdefghij1234567890]"), true);
    assert.equal(isValidPushToken("ExponentPushToken[]"), false);
    assert.equal(isValidPushToken("https://evil.example"), false);
    assert.equal(isValidPushToken(null), false);
});

test("no 'someone is searching' messages at night (Berlin)", () => {
    assert.equal(isQuietTime(Date.parse("2026-11-01T22:30:00Z")), true); // 23:30
    assert.equal(isQuietTime(Date.parse("2026-11-01T06:00:00Z")), true); // 07:00
    assert.equal(isQuietTime(Date.parse("2026-11-01T17:00:00Z")), false); // 18:00
});
