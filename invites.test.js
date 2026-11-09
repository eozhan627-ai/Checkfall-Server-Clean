// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { INVITE_TTL_MS, inviteCode, inviteExpired, invitePage, normalizeInviteCode } from "./invites.js";

test("invite codes are 6 easy-to-type characters", () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
        const code = inviteCode();
        assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.equal(normalizeInviteCode(code.toLowerCase()), code);
        seen.add(code);
    }
    assert.ok(seen.size > 490);
});

test("bad codes are rejected", () => {
    for (const bad of ["", "ABC", "ABCDEFG", "ABCD0O", "../../x", null, 42]) {
        assert.equal(normalizeInviteCode(bad), null, String(bad));
    }
});

test("invites expire", () => {
    const now = Date.now();
    assert.equal(inviteExpired({ createdAt: now }, now), false);
    assert.equal(inviteExpired({ createdAt: now - INVITE_TTL_MS - 1 }, now), true);
    assert.equal(inviteExpired(null, now), true);
});

test("the landing page escapes the host's name", () => {
    const html = invitePage({ code: "ABCDEF", hostName: "<script>x</script>", timeControl: "5+2", open: true, downloadUrl: "https://example.com" });
    assert.ok(!html.includes("<script>x"));
    assert.ok(html.includes("povcheck://invite/ABCDEF"));
});
