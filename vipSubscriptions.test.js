import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";

const { tierFromSubscriber } = await import("./vipSubscriptions.js");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const future = "2026-11-03T12:00:00Z";
const past = "2026-09-03T12:00:00Z";

test("a player who never bought anything is left alone", () => {
    assert.deepEqual(tierFromSubscriber({ entitlements: {} }, NOW), { known: false, tier: "none", expiresAt: null });
    assert.equal(tierFromSubscriber(null, NOW).known, false);
});

test("an active subscription (also during the free trial) gives the plan", () => {
    const state = tierFromSubscriber({ entitlements: { diamond: { expires_date: future } } }, NOW);
    assert.deepEqual(state, { known: true, tier: "diamond", expiresAt: future });
});

test("an expired subscription ends VIP", () => {
    const state = tierFromSubscriber({ entitlements: { gold: { expires_date: past } } }, NOW);
    assert.deepEqual(state, { known: true, tier: "none", expiresAt: null });
});

test("the best active plan wins", () => {
    const state = tierFromSubscriber(
        { entitlements: { silver: { expires_date: future }, diamond: { expires_date: past }, gold: { expires_date: future } } },
        NOW
    );
    assert.equal(state.tier, "gold");
});

test("a purchase without expiry date never ends", () => {
    assert.equal(tierFromSubscriber({ entitlements: { diamond: { expires_date: null } } }, NOW).tier, "diamond");
});

test("unknown entitlements do not give VIP", () => {
    assert.deepEqual(tierFromSubscriber({ entitlements: { something: { expires_date: future } } }, NOW), { known: true, tier: "none", expiresAt: null });
});
