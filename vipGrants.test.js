import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";

const {
    bestTier,
    cleanCode,
    effectiveTier,
    endFinishedGrants,
    liftVip,
    recomputeVip,
    redeemResponse,
    setupPromoRoutes,
} = await import("./vipGrants.js");

const NOW = Date.parse("2026-10-17T12:00:00Z");
const LATER = "2027-10-17T12:00:00Z";
const EARLIER = "2026-10-01T12:00:00Z";

// A tiny stand-in for the Supabase client: the few query methods used here,
// on tables in memory. rpc() answers with what the test passes in.
function fakeDb({ profiles = [], grants = [], redeem = null } = {}) {
    const tables = {
        profiles: profiles.map((row) => ({ ...row })),
        vip_grants: grants.map((row) => ({ ...row })),
    };

    class Query {
        constructor(table) {
            this.table = table;
            this.filters = [];
            this.values = null;
            this.max = Infinity;
            this.single = false;
        }
        select() {
            return this;
        }
        update(values) {
            this.values = values;
            return this;
        }
        eq(column, value) {
            this.filters.push((row) => row[column] === value);
            return this;
        }
        lte(column, value) {
            this.filters.push((row) => Date.parse(row[column]) <= Date.parse(value));
            return this;
        }
        in(column, values) {
            this.filters.push((row) => values.includes(row[column]));
            return this;
        }
        limit(count) {
            this.max = count;
            return this;
        }
        maybeSingle() {
            this.single = true;
            return this;
        }
        then(resolve) {
            const rows = tables[this.table];
            if (!rows) return resolve({ data: null, error: { code: "PGRST205", message: "no such table" } });

            const matching = rows.filter((row) => this.filters.every((keep) => keep(row)));

            if (this.values) {
                matching.forEach((row) => Object.assign(row, this.values));
                return resolve({ data: null, error: null });
            }

            const found = matching.slice(0, this.max).map((row) => ({ ...row }));
            resolve({ data: this.single ? found[0] ?? null : found, error: null });
        }
    }

    return {
        tables,
        rpcCalls: [],
        from(table) {
            return new Query(table);
        },
        async rpc(name, args) {
            this.rpcCalls.push({ name, args });
            if (!redeem) return { data: null, error: { code: "PGRST202", message: "function not found" } };
            return { data: redeem(args), error: null };
        },
    };
}

const plan = (db, id) => db.tables.profiles.find((row) => row.id === id).vip_tier;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test("codes are read the way players type them", () => {
    assert.equal(cleanCode(" tiktok100 "), "TIKTOK100");
    assert.equal(cleanCode("Tik Tok 100"), "TIKTOK100");
    assert.equal(cleanCode("tt-ab12cd34"), "TT-AB12CD34");
    assert.equal(cleanCode("ＴＩＫＴＯＫ１００"), "TIKTOK100"); // full-width keyboard
    assert.equal(cleanCode("abc"), null);
    assert.equal(cleanCode("x".repeat(25)), null);
    assert.equal(cleanCode("TIKTOK100!"), null);
    assert.equal(cleanCode("'; drop table--"), null);
    assert.equal(cleanCode(null), null);
    assert.equal(cleanCode(42), null);
});

test("the better plan wins", () => {
    assert.equal(bestTier([]), "none");
    assert.equal(bestTier(["silver", "gold", "none"]), "gold");
    assert.equal(bestTier(["diamond", "gold"]), "diamond");
    assert.equal(bestTier(["platinum", "silver"]), "silver");
});

test("only codes that are still running count", () => {
    const grants = [
        { tier: "diamond", ends_at: EARLIER },
        { tier: "gold", ends_at: LATER },
    ];

    assert.equal(effectiveTier("none", grants, NOW), "gold");
    assert.equal(effectiveTier("diamond", grants, NOW), "diamond");
    assert.equal(effectiveTier("silver", [{ tier: "gold", ends_at: EARLIER }], NOW), "silver");
    assert.equal(effectiveTier(null, [], NOW), "none");
});

test("every answer of the database becomes a clear answer for the app", () => {
    assert.deepEqual(redeemResponse({ status: "ok", tier: "gold", ends_at: LATER, place: 37, max_uses: 100 }), {
        status: 200,
        body: { success: true, tier: "gold", endsAt: LATER, place: 37, of: 100 },
    });
    assert.deepEqual(redeemResponse({ status: "already", tier: "gold", ends_at: LATER }), {
        status: 409,
        body: { error: "ALREADY_REDEEMED", tier: "gold", endsAt: LATER },
    });
    assert.equal(redeemResponse({ status: "used_up" }).body.error, "USED_UP");
    assert.equal(redeemResponse({ status: "expired" }).body.error, "EXPIRED");
    assert.equal(redeemResponse({ status: "not_started", starts_at: LATER }).body.startsAt, LATER);
    assert.equal(redeemResponse({ status: "invalid" }).status, 404);
    assert.equal(redeemResponse(null).body.error, "INVALID");
});

// ---------------------------------------------------------------------------
// Plans in the database
// ---------------------------------------------------------------------------

test("a code lifts the plan but never lowers it", async () => {
    const db = fakeDb({
        profiles: [
            { id: "a", vip_tier: "none", vip_base_tier: "none" },
            { id: "b", vip_tier: "diamond", vip_base_tier: "none" }, // set by hand
            { id: "c", vip_tier: "silver", vip_base_tier: "silver" },
        ],
    });

    assert.deepEqual(await liftVip("a", "gold", { db }), { tier: "gold", changed: true });
    assert.deepEqual(await liftVip("b", "gold", { db }), { tier: "diamond", changed: false });
    assert.deepEqual(await liftVip("c", "gold", { db }), { tier: "gold", changed: true });
    assert.equal(plan(db, "a"), "gold");
    assert.equal(plan(db, "b"), "diamond");
    await assert.rejects(liftVip("nobody", "gold", { db }), /PROFILE_NOT_FOUND/);
});

test("the plan is the better of the subscription and the running codes", async () => {
    const db = fakeDb({
        profiles: [{ id: "a", vip_tier: "gold", vip_base_tier: "none" }],
        grants: [{ id: 1, user_id: "a", tier: "gold", ends_at: LATER, ended: false }],
    });

    // The subscription becomes Diamond: Diamond.
    db.tables.profiles[0].vip_base_tier = "diamond";
    assert.equal((await recomputeVip("a", { db, now: NOW })).tier, "diamond");

    // The subscription ends: the code's Gold is still there.
    db.tables.profiles[0].vip_base_tier = "none";
    assert.equal((await recomputeVip("a", { db, now: NOW })).tier, "gold");

    // A year later the code is over too.
    assert.equal((await recomputeVip("a", { db, now: Date.parse(LATER) + 1000 })).tier, "none");
});

test("ended codes lower the plan again, once", async () => {
    const db = fakeDb({
        profiles: [
            { id: "a", vip_tier: "gold", vip_base_tier: "none" },
            { id: "s", vip_tier: "gold", vip_base_tier: "silver" },
            { id: "d", vip_tier: "diamond", vip_base_tier: "diamond" },
            { id: "r", vip_tier: "gold", vip_base_tier: "none" },
        ],
        grants: [
            { id: 1, user_id: "a", tier: "gold", ends_at: EARLIER, ended: false },
            { id: 2, user_id: "s", tier: "gold", ends_at: EARLIER, ended: false },
            { id: 3, user_id: "d", tier: "gold", ends_at: EARLIER, ended: false },
            { id: 4, user_id: "r", tier: "gold", ends_at: LATER, ended: false },
            { id: 5, user_id: "gone", tier: "gold", ends_at: EARLIER, ended: false },
        ],
    });

    assert.equal(await endFinishedGrants({ db, now: NOW }), 4);

    assert.equal(plan(db, "a"), "none"); // only had the code
    assert.equal(plan(db, "s"), "silver"); // back to the subscription
    assert.equal(plan(db, "d"), "diamond"); // had more than the code anyway
    assert.equal(plan(db, "r"), "gold"); // still running

    const ended = db.tables.vip_grants.filter((grant) => grant.ended).map((grant) => grant.id);
    assert.deepEqual(ended, [1, 2, 3, 5]);

    // Nothing left to do on the next check.
    assert.equal(await endFinishedGrants({ db, now: NOW }), 0);
});

test("a player whose plan could not be updated is tried again on the next check", async () => {
    const db = fakeDb({
        profiles: [{ id: "a", vip_tier: "gold", vip_base_tier: "none" }],
        grants: [{ id: 1, user_id: "a", tier: "gold", ends_at: EARLIER, ended: false }],
    });

    const original = db.from.bind(db);
    db.from = (table) => {
        const query = original(table);
        if (table === "profiles") query.update = () => ({ eq: async () => ({ error: { code: "08006", message: "connection lost" } }) });
        return query;
    };

    assert.equal(await endFinishedGrants({ db, now: NOW }), 0);
    assert.equal(db.tables.vip_grants[0].ended, false);
});

test("without the promo tables (script 006 not run) the hourly check does nothing", async () => {
    const db = fakeDb();
    delete db.tables.vip_grants;
    assert.equal(await endFinishedGrants({ db, now: NOW }), 0);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

async function withServer(db, run, now = () => NOW) {
    const app = express();
    app.use(express.json());

    setupPromoRoutes(app, {
        db,
        now,
        getAuthIdFromRequest: async (req) => /^Bearer (\w+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null,
    });

    const server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });

    const redeem = async (code, player = "a", address = "1.2.3.4") => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/promo/redeem`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": address,
                ...(player ? { Authorization: `Bearer ${player}` } : {}),
            },
            body: JSON.stringify({ code }),
        });
        return { status: response.status, body: await response.json() };
    };

    try {
        await run(redeem);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("redeeming a code gives the plan right away", async () => {
    const db = fakeDb({
        profiles: [{ id: "a", vip_tier: "none", vip_base_tier: "none" }],
        redeem: ({ p_code }) =>
            p_code === "TIKTOK100" ? { status: "ok", tier: "gold", ends_at: LATER, place: 1, max_uses: 100 } : { status: "invalid" },
    });

    await withServer(db, async (redeem) => {
        const result = await redeem(" tiktok100");

        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { success: true, tier: "gold", endsAt: LATER, place: 1, of: 100 });
        assert.deepEqual(db.rpcCalls.at(-1), { name: "redeem_promo_code", args: { p_user_id: "a", p_code: "TIKTOK100" } });
        assert.equal(plan(db, "a"), "gold");

        assert.equal((await redeem("WRONG1")).body.error, "INVALID");
        assert.equal(plan(db, "a"), "gold");
    });
});

test("guests, nonsense and too many tries are turned away", async () => {
    const db = fakeDb({ profiles: [{ id: "a", vip_tier: "none", vip_base_tier: "none" }], redeem: () => ({ status: "invalid" }) });

    await withServer(db, async (redeem) => {
        assert.deepEqual(await redeem("TIKTOK100", null), { status: 401, body: { error: "SIGN_IN_REQUIRED" } });

        const nonsense = await redeem("<script>");
        assert.deepEqual(nonsense, { status: 404, body: { error: "INVALID" } });
        assert.equal(db.rpcCalls.length, 0); // never reached the database

        for (let i = 0; i < 7; i++) assert.equal((await redeem(`GUESS${i}`)).status, 404);
        assert.deepEqual(await redeem("GUESS8"), { status: 429, body: { error: "TOO_MANY" } });

        // Someone else from another address is not affected.
        assert.equal((await redeem("GUESS9", "b", "5.6.7.8")).status, 404);
    });
});

test("many accounts guessing from one address are stopped", async () => {
    const db = fakeDb({ redeem: () => ({ status: "invalid" }) });

    await withServer(db, async (redeem) => {
        for (let i = 0; i < 30; i++) assert.equal((await redeem(`GUESS${i}`, `p${i}`)).status, 404);
        assert.equal((await redeem("GUESS30", "p30")).status, 429);
        assert.equal((await redeem("GUESS31", "q1", "9.9.9.9")).status, 404);
    });
});

test("the launch rush from one mobile network is not slowed down", async () => {
    const profiles = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, vip_tier: "none", vip_base_tier: "none" }));
    let place = 0;
    const db = fakeDb({ profiles, redeem: () => ({ status: "ok", tier: "gold", ends_at: LATER, place: ++place, max_uses: 100 }) });

    await withServer(db, async (redeem) => {
        for (let i = 0; i < 60; i++) assert.equal((await redeem("TIKTOK100", `p${i}`, "100.64.0.1")).status, 200);
        assert.ok(db.tables.profiles.every((row) => row.vip_tier === "gold"));
    });
});

test("a code redeemed before sets the plan again only while it is running", async () => {
    const running = fakeDb({
        profiles: [{ id: "a", vip_tier: "none", vip_base_tier: "none" }],
        redeem: () => ({ status: "already", tier: "gold", ends_at: LATER }),
    });

    await withServer(running, async (redeem) => {
        const result = await redeem("TIKTOK100");
        assert.deepEqual(result, { status: 409, body: { error: "ALREADY_REDEEMED", tier: "gold", endsAt: LATER } });
        assert.equal(plan(running, "a"), "gold");
    });

    const over = fakeDb({
        profiles: [{ id: "a", vip_tier: "none", vip_base_tier: "none" }],
        redeem: () => ({ status: "already", tier: "gold", ends_at: EARLIER }),
    });

    await withServer(over, async (redeem) => {
        assert.equal((await redeem("TIKTOK100")).body.error, "ALREADY_REDEEMED");
        assert.equal(plan(over, "a"), "none");
    });
});

test("all places taken, expired and not started are told apart", async () => {
    const answers = { USEDUP: { status: "used_up" }, OLDCODE: { status: "expired" }, SOON: { status: "not_started", starts_at: LATER } };
    const db = fakeDb({ profiles: [{ id: "a", vip_tier: "none", vip_base_tier: "none" }], redeem: ({ p_code }) => answers[p_code] });

    await withServer(db, async (redeem) => {
        assert.deepEqual(await redeem("USEDUP"), { status: 409, body: { error: "USED_UP" } });
        assert.deepEqual(await redeem("OLDCODE"), { status: 410, body: { error: "EXPIRED" } });
        assert.deepEqual(await redeem("SOON"), { status: 403, body: { error: "NOT_STARTED", startsAt: LATER } });
        assert.equal(plan(db, "a"), "none");
    });
});

test("before script 006 has run the app is told that codes are not set up yet", async () => {
    const db = fakeDb({ profiles: [{ id: "a", vip_tier: "none", vip_base_tier: "none" }] });

    await withServer(db, async (redeem) => {
        assert.deepEqual(await redeem("TIKTOK100"), { status: 503, body: { error: "NOT_SET_UP" } });
    });
});
