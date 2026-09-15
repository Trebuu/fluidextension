/**
 * Schedule tests — run with `node scripts/test-schedule.mjs`.
 *
 * WHAT MAKES THIS TESTABLE AT ALL: `scheduleState(settings, now)` takes the
 * clock as an argument. Every question the scheduler asks is answered by that
 * one pure function, so the whole of "is this account awake" can be checked
 * against an arbitrary Monday without a browser, a tab or a machine whose clock
 * has to be moved.
 *
 * The cases here are the ones where a wrong answer is SILENT. A schedule that
 * is an hour out, a Friday-night window that reads as empty, a week that stops
 * working in November — none of them throw. They surface as an account that did
 * not answer anybody last night, which is indistinguishable from a quiet inbox.
 *
 * `chrome` is stubbed only because settings.js is imported whole; nothing below
 * touches storage.
 */

import assert from "node:assert/strict";

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };

const { parseSchedule, scheduleState, scheduleJitter, clockOf, validatePreset, SCHEDULE_DAYS } = await import(
  "../src/lib/settings.js"
);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A local-time date, written the way a person reads one. */
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);

/** Mon 2026-09-14 is a Monday; the week below is anchored on it. */
const NINE_TO_FIVE = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
};
const on = (schedule, extra = {}) => ({ scheduleEnabled: true, schedule, scheduleJitterMin: 0, ...extra });

// ── the week, parsed ─────────────────────────────────────────────────────────

test("days are indexed the way Date.getDay() is", () => {
  assert.equal(SCHEDULE_DAYS[0], "sun");
  assert.equal(SCHEDULE_DAYS[new Date(2026, 8, 14).getDay()], "mon");
});

test("a malformed week is an error, never an empty week", () => {
  // Each of these used to be a candidate for "just drop it" — and dropping it
  // is what takes a fleet dark with nothing in the log.
  assert.equal(parseSchedule({ mon: [["09:00", "17:00"]] }).ok, true);
  assert.equal(parseSchedule({ funday: [] }).ok, false);
  assert.equal(parseSchedule({ mon: "09:00-17:00" }).ok, false);
  assert.equal(parseSchedule({ mon: [["9am", "5pm"]] }).ok, false);
  assert.equal(parseSchedule({ mon: [["24:00", "25:00"]] }).ok, false);
  assert.equal(parseSchedule({ mon: [["09:00"]] }).ok, false);
  assert.equal(parseSchedule([]).ok, false);
  // A window of no length is the one input whose intent cannot be guessed:
  // with `to < from` already meaning "into tomorrow", 09:00–09:00 is either
  // nothing or the whole day.
  assert.equal(parseSchedule({ mon: [["09:00", "09:00"]] }).ok, false);
  // Nothing set is a perfectly good week.
  assert.equal(parseSchedule({}).ok, true);
  assert.equal(parseSchedule(undefined).ok, true);
});

test("windows come back sorted, in minutes", () => {
  const { days } = parseSchedule({ mon: [["19:00", "22:00"], ["09:00", "17:00"]] });
  assert.deepEqual(days[1], [[540, 1020], [1140, 1320]]);
});

// ── open and shut ────────────────────────────────────────────────────────────

test("inside the hours it is open, outside it is not", () => {
  const s = on(NINE_TO_FIVE);
  assert.equal(scheduleState(s, at(2026, 9, 14, 12, 0)).open, true, "Monday noon");
  assert.equal(scheduleState(s, at(2026, 9, 14, 8, 59)).open, false, "a minute early");
  assert.equal(scheduleState(s, at(2026, 9, 14, 9, 0)).open, true, "on the minute");
  // The end is EXCLUSIVE: 17:00 is when it stops, not a last minute of work.
  assert.equal(scheduleState(s, at(2026, 9, 14, 17, 0)).open, false, "on the closing minute");
  assert.equal(scheduleState(s, at(2026, 9, 19, 12, 0)).open, false, "Saturday");
});

test("a platform with no schedule is always open", () => {
  const s = { scheduleEnabled: false, schedule: NINE_TO_FIVE };
  assert.equal(scheduleState(s, at(2026, 9, 14, 3, 0)).open, true);
  assert.equal(scheduleState(s, at(2026, 9, 14, 3, 0)).enabled, false);
});

test("an unreadable week fails CLOSED and says why", () => {
  const st = scheduleState(on({ mon: [["nope", "17:00"]] }), at(2026, 9, 14, 12, 0));
  assert.equal(st.broken, true);
  assert.equal(st.open, false, "nothing acts on a week nobody can read");
  assert.ok(st.errors.length, "and the reason is carried, not swallowed");
});

// ── the ones that fail silently ──────────────────────────────────────────────

test("an end before its start runs into the next day", () => {
  // Friday night. The window belongs to the day it OPENS, so Saturday 01:00 is
  // inside FRIDAY's window — and Saturday itself has none.
  const s = on({ fri: [["22:00", "02:00"]] });
  assert.equal(scheduleState(s, at(2026, 9, 18, 21, 59)).open, false, "just before");
  assert.equal(scheduleState(s, at(2026, 9, 18, 23, 30)).open, true, "Friday night");
  assert.equal(scheduleState(s, at(2026, 9, 19, 1, 0)).open, true, "Saturday small hours");
  assert.equal(scheduleState(s, at(2026, 9, 19, 2, 0)).open, false, "closing time");
  assert.equal(scheduleState(s, at(2026, 9, 19, 23, 30)).open, false, "Saturday night is not Friday's");
  // And the window it reports is the one that opened yesterday.
  const st = scheduleState(s, at(2026, 9, 19, 1, 0));
  assert.equal(st.window.from, "22:00");
  assert.equal(new Date(st.window.endAt).getDate(), 19);
  assert.equal(new Date(st.window.startAt).getDate(), 18);
});

test("the clock change does not move the hours", () => {
  // Europe ends summer time on 2026-10-25. A window computed by adding
  // 24h × 60 × 60 × 1000 to yesterday opens an hour out on exactly this day;
  // one computed through the calendar does not. (On a machine with no DST this
  // passes trivially and costs nothing.)
  const s = on(NINE_TO_FIVE);
  assert.equal(scheduleState(s, at(2026, 10, 26, 9, 30)).open, true, "09:30 the Monday after");
  assert.equal(scheduleState(s, at(2026, 10, 26, 8, 30)).open, false, "08:30 is still early");
  const next = scheduleState(s, at(2026, 10, 25, 12, 0)).next;
  assert.equal(new Date(next.startAt).getHours(), 9, "and the next opening is at nine, not eight or ten");
});

test("the next opening is the next one, not today's that has been and gone", () => {
  const s = on({ ...NINE_TO_FIVE, thu: [["09:00", "17:00"], ["19:00", "22:00"]] });
  // Inside Monday's window, the next opening is TUESDAY.
  const mon = scheduleState(s, at(2026, 9, 14, 12, 0));
  assert.equal(mon.open, true);
  assert.equal(new Date(mon.next.startAt).getDate(), 15);
  // A second window the same day is the next opening.
  const thu = scheduleState(s, at(2026, 9, 17, 12, 0));
  assert.equal(thu.next.from, "19:00");
  assert.equal(new Date(thu.next.startAt).getDate(), 17);
  // Friday evening rolls over the weekend to Monday.
  const fri = scheduleState(s, at(2026, 9, 18, 18, 0));
  assert.equal(new Date(fri.next.startAt).getDate(), 21);
});

test("a week with no days never opens, and says so rather than guessing", () => {
  const st = scheduleState(on({}), at(2026, 9, 14, 12, 0));
  assert.equal(st.open, false);
  assert.equal(st.broken, false, "empty is not malformed");
  assert.equal(st.next, null);
});

// ── jitter ───────────────────────────────────────────────────────────────────

test("the opening minute is stable for a window and differs across a fleet", () => {
  const start = at(2026, 9, 14, 9, 0).getTime();
  const acctA = { scheduleJitterMin: 10, platform: "instagram", ownUsername: "our_account" };
  const acctB = { scheduleJitterMin: 10, platform: "instagram", ownUsername: "other_account" };
  // Stable: this is what makes it a start time rather than a random walk.
  assert.equal(scheduleJitter(acctA, start), scheduleJitter(acctA, start));
  // Different per profile — a fleet sharing one preset must not wake together.
  assert.notEqual(scheduleJitter(acctA, start), scheduleJitter(acctB, start));
  // Different per window, or every day opens on the same minute for ever.
  assert.notEqual(scheduleJitter(acctA, start), scheduleJitter(acctA, start + 86_400_000));
  // In range, inclusive of both ends.
  for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    const n = scheduleJitter({ ...acctA, ownUsername: seed }, start);
    assert.ok(n >= 0 && n <= 10, `${n} is outside 0–10`);
  }
  assert.equal(scheduleJitter({ ...acctA, scheduleJitterMin: 0 }, start), 0);
});

test("the jittered opening is never before the window itself", () => {
  const s = on(NINE_TO_FIVE, { scheduleJitterMin: 10, ownUsername: "our_account", platform: "instagram" });
  const st = scheduleState(s, at(2026, 9, 14, 8, 0));
  assert.ok(st.next.opensAt >= st.next.startAt);
  assert.ok(st.next.opensAt <= st.next.startAt + 10 * 60_000);
});

// ── the fleet file ───────────────────────────────────────────────────────────

test("a preset carrying a malformed week is refused whole", () => {
  const preset = {
    fluidextension: 1,
    name: "fleet",
    platforms: { instagram: { schedule: { mon: [["09:00", "9pm"]] } } },
  };
  const { ok, errors } = validatePreset(preset);
  assert.equal(ok, false, "a fleet file is applied unattended to every profile at once");
  assert.ok(errors.some((e) => e.includes("instagram schedule")), errors.join("; "));
  // And a good one still goes through, carrying the week.
  const good = validatePreset({
    fluidextension: 1,
    name: "fleet",
    platforms: { instagram: { schedule: NINE_TO_FIVE, scheduleEnabled: true } },
  });
  assert.equal(good.ok, true, good.errors.join("; "));
  assert.deepEqual(good.preset.platforms.instagram.schedule, NINE_TO_FIVE);
});

test("clockOf prints an overnight end as a time of day", () => {
  assert.equal(clockOf(540), "09:00");
  assert.equal(clockOf(1440 + 120), "02:00");
});

// ── run ──────────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message.split("\n").join("\n       ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
