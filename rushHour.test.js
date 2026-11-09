// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { currentOrNextRushHour, zonedTime } from "./rushHour.js";

const berlin = (text) => {
    const [d, t] = text.split(" ");
    const [y, m, day] = d.split("-").map(Number);
    const [h, min] = t.split(":").map(Number);
    return zonedTime(y, m - 1, day, h, min, "Europe/Berlin");
};

test("Berlin wall-clock times in winter and summer", () => {
    assert.equal(new Date(berlin("2026-11-01 19:00")).toISOString(), "2026-11-01T18:00:00.000Z");
    assert.equal(new Date(berlin("2026-07-05 19:00")).toISOString(), "2026-07-05T17:00:00.000Z");
});

test("next Rush Hour is the coming Sunday 19:00 Berlin", () => {
    // Wednesday 4 Nov 2026, noon
    const next = currentOrNextRushHour(berlin("2026-11-04 12:00"));
    assert.equal(new Date(next.startsAt).toISOString(), "2026-11-08T18:00:00.000Z");
    assert.equal(next.live, false);
});

test("on Sunday before 19:00 it is the same day", () => {
    const next = currentOrNextRushHour(berlin("2026-11-01 12:15"));
    assert.equal(new Date(next.startsAt).toISOString(), "2026-11-01T18:00:00.000Z");
    assert.equal(next.live, false);
});

test("during the hour it is live", () => {
    const now = berlin("2026-11-01 19:30");
    const event = currentOrNextRushHour(now);
    assert.equal(event.live, true);
    assert.equal(event.endsAt - event.startsAt, 60 * 60_000);
});

test("after the hour it is next week", () => {
    const next = currentOrNextRushHour(berlin("2026-11-01 20:00"));
    assert.equal(new Date(next.startsAt).toISOString(), "2026-11-08T18:00:00.000Z");
});

test("Sunday of the clock change in March", () => {
    const next = currentOrNextRushHour(berlin("2027-03-27 10:00"));
    assert.equal(new Date(next.startsAt).toISOString(), "2027-03-28T17:00:00.000Z");
});
