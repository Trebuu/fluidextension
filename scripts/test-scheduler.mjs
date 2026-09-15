/**
 * Scheduler tests — run with `node scripts/test-scheduler.mjs`.
 *
 * `test-schedule.mjs` checks the CALENDAR: given a week and a moment, is this
 * account awake. This file checks what the worker DOES about the answer, which
 * is a different set of mistakes entirely — starting a run twice, restarting one
 * the user just stopped, stopping one they started by hand, or leaving the
 * auto-reply watcher live all night while the sweep sleeps and the panel says
 * Asleep.
 *
 * The real `src/background.js` is imported and driven through the real
 * `chrome.alarms` listener and the real `chrome.runtime.onMessage` listener —
 * the same two entry points Chrome uses. Nothing private is reached into.
 *
 * THE CLOCK IS THE FIXTURE. `Date` is replaced with one that answers a time the
 * test chooses, so "it is 08:59 on Monday" is a variable rather than a wait.
 * Every `new Date(...)` with arguments still builds a real date, which is what
 * the schedule's own calendar arithmetic needs.
 */

import assert from "node:assert/strict";

// ── the clock, faked ─────────────────────────────────────────────────────────

const RealDate = Date;
let NOW = new RealDate(2026, 8, 14, 12, 0, 0, 0).getTime(); // Monday 2026-09-14, noon
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FakeDate;
/** Move the clock. Local time, written the way a person reads it. */
const setClock = (y, m, d, hh, mm) => void (NOW = new RealDate(y, m - 1, d, hh, mm, 0, 0).getTime());

// ── the browser, faked ───────────────────────────────────────────────────────

const listeners = { message: [], alarm: [] };
let local = {};
let session = {};
let tabs = [];
let created = [];
let fetches = [];
let pageAnswers = {};

const evt = (bucket) => ({ addListener: (fn) => listeners[bucket].push(fn) });

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: evt("message"),
    sendMessage: async () => {},
    reload: () => {},
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    query: async ({ url }) => {
      if (!url) return tabs;
      const re = new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}`);
      return tabs.filter((t) => re.test(t.url));
    },
    get: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error("no such tab")),
    sendMessage: async (_id, msg) => {
      if (!(msg.type in pageAnswers)) throw new Error("Could not establish connection.");
      return { ok: true, result: pageAnswers[msg.type] };
    },
    create: async (opts) => {
      created.push(opts);
      const tab = { id: 100 + created.length, windowId: 1, url: opts.url, active: Boolean(opts.active) };
      tabs.push(tab);
      return tab;
    },
    reload: async () => {},
    remove: async () => {},
    update: async () => {},
  },
  windows: { onFocusChanged: { addListener: () => {} }, update: async () => {} },
  storage: {
    local: {
      get: async (k) => (k in local ? { [k]: local[k] } : {}),
      set: async (o) => void Object.assign(local, o),
      remove: async (k) => void delete local[k],
    },
    session: {
      get: async (k) => (k in session ? { [k]: session[k] } : {}),
      set: async (o) => void Object.assign(session, o),
      remove: async (k) => void delete session[k],
    },
  },
  alarms: { create: () => {}, onAlarm: evt("alarm") },
  scripting: { executeScript: async () => [] },
  sidePanel: { setPanelBehavior: async () => {} },
};

/**
 * FluidTalk, faked — and it is an ORACLE, not scaffolding.
 *
 * "Did the extension try to answer this person" has exactly one honest answer
 * in the worker: did anything go to the API. A gate that returns early cannot
 * reach here, so counting calls is what separates "held back" from "the stub
 * happened to fail afterwards".
 */
globalThis.fetch = async (url, init) => {
  fetches.push({ url: String(url), body: init?.body });
  return { ok: true, status: 200, json: async () => ({ bubbles: [], silent: "test" }), text: async () => "{}" };
};

await import("../src/background.js");

const IG = { id: 1, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: true };

function ask(type, extra = {}) {
  return new Promise((resolve, reject) => {
    let answered = false;
    for (const fn of listeners.message) {
      const kept = fn({ type, ...extra }, { tab: extra.__sender ?? null }, (reply) => {
        answered = true;
        reply?.ok ? resolve(reply.result) : reject(new Error(reply?.error ?? "no error given"));
      });
      if (kept) {
        setTimeout(() => answered || reject(new Error(`"${type}" never answered`)), 2000);
        return;
      }
    }
    if (!answered) reject(new Error(`no handler for "${type}"`));
  });
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** One minute of Chrome's alarm, which is where the scheduler lives. */
async function tick() {
  for (const fn of listeners.alarm) fn({ name: "fluidextension.heartbeat" });
  await settle();
}

/** A message landing in the thread on screen, the way the page reports it. */
async function inboundMessage(threadId = "t1") {
  for (const fn of listeners.message) {
    fn(
      { type: "ft:thread-changed", thread: { ok: true, threadId, canSend: true, lastInbound: { text: "hey" } } },
      { tab: IG },
      () => {},
    );
  }
  await settle();
}

const sweep = async () => (await ask("ft:get-state")).sweep;
// The log lives in `storage.session` — it is this worker's account of what it
// did, not settings, and it goes when the browser does.
const logLines = () => (session["fluidextension.log"] ?? []).map((e) => e.message);
const said = (re) => logLines().some((m) => re.test(m));

/** Stop anything running and wait for the loop to actually be gone. */
async function quiesce() {
  if ((await sweep()).running) await ask("ft:sweep-stop");
  for (let i = 0; i < 40 && (await sweep()).running; i++) await settle(50);
}

const NINE_TO_FIVE = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
};

/** A bound, token-carrying Instagram with a week — the state every test starts in. */
async function setUp({ schedule = NINE_TO_FIVE, enabled = true, jitter = 0 } = {}) {
  local = {};
  session = {};
  tabs = [IG];
  created = [];
  fetches = [];
  pageAnswers = {
    "ft:ready": { ready: true },
    "ft:whoami": { handle: "our_account" },
    // Enough of a conversation for the auto-reply path to reach FluidTalk —
    // which is the only thing these tests measure about it.
    "ft:read": {
      ok: true,
      handle: "a_lead",
      threadId: "t1",
      canSend: true,
      messages: [{ direction: "in", text: "hey" }],
      lastInbound: { text: "hey" },
    },
  };
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await ask("ft:save-settings", {
    platform: "instagram",
    patch: { schedule, scheduleEnabled: enabled, scheduleJitterMin: jitter, ownUsername: "our_account" },
  });
  await ask("ft:set-configured", { platform: "instagram", on: true });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── opening ──────────────────────────────────────────────────────────────────

test("the window opening starts a run, and it is the schedule's run", async () => {
  setClock(2026, 9, 14, 8, 59);
  await setUp();
  await tick();
  assert.equal((await sweep()).running, false, "started a minute early");

  setClock(2026, 9, 14, 9, 0);
  await tick();
  const s = await sweep();
  assert.equal(s.running, true, "the window opened and nothing started");
  assert.equal(s.reason, "schedule", "a scheduled run must be marked as one, or nothing may close it");
  await quiesce();
});

test("a run already going is not started a second time", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp();
  await tick();
  const first = await sweep();
  await tick();
  await tick();
  const now = await sweep();
  assert.equal(now.running, true);
  assert.equal(now.cycles >= 0 && now.reason, "schedule");
  assert.deepEqual(now.platforms, first.platforms, "a second loop was started on top of the first");
  await quiesce();
});

test("the jittered minute is waited out, then the run starts", async () => {
  setClock(2026, 9, 14, 9, 0);
  // A jitter this size cannot resolve to zero for every account, and this one's
  // offset is fixed by (handle, platform, window) — so the wait is real.
  await setUp({ jitter: 30 });
  const st = await ask("ft:schedule-preview", { platform: "instagram" });
  const offsetMin = Math.round((st.window.opensAt - st.window.startAt) / 60000);
  assert.ok(offsetMin > 0, `this account's offset came out as ${offsetMin}; pick another handle for the fixture`);

  await tick();
  assert.equal((await sweep()).running, false, "started before its own opening minute");
  setClock(2026, 9, 14, 9, offsetMin);
  await tick();
  assert.equal((await sweep()).running, true, "never started at its opening minute");
  await quiesce();
});

test("a scheduled run opens a tab when there is none — in the background", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp();
  tabs = [];
  await tick();
  assert.equal(created.length, 1, "nobody is there to open a tab at 09:00 on an unattended profile");
  assert.match(created[0].url, /instagram\.com\/direct\/inbox/);
  assert.equal(Boolean(created[0].active), false, "it must not yank the page away from a human using the profile");
  assert.equal((await sweep()).running, true);
  await quiesce();
});

test("pressing Start with no tab still refuses, because somebody is looking", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp({ enabled: false });
  tabs = [];
  await assert.rejects(() => ask("ft:sweep-start"), /no Instagram tab is open/);
  assert.equal(created.length, 0);
});

// ── closing ──────────────────────────────────────────────────────────────────

test("the window closing stops the run — by asking, not by killing", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp();
  await tick();
  assert.equal((await sweep()).running, true);

  setClock(2026, 9, 14, 17, 0);
  await tick();
  // `stopping` is the same flag the Stop button sets: the cycle finishes the
  // conversation it is on. A run cut off mid-send is the failure this avoids.
  assert.ok((await sweep()).stopping || !(await sweep()).running, "the window closed and the run carried on");
  assert.ok(said(/schedule closed/), logLines().join(" | "));
  await quiesce();
});

test("A RUN SOMEBODY STARTED IS NOT STOPPED BY THE PLAN", async () => {
  setClock(2026, 9, 14, 20, 0); // outside the hours entirely
  await setUp();
  await ask("ft:sweep-start");
  await settle();
  assert.equal((await sweep()).reason, "manual");
  assert.ok(said(/off-schedule/), "the log should say this run is overriding the plan");

  await tick();
  await tick();
  const s = await sweep();
  assert.equal(s.running, true, "the plan stopped a run it did not start");
  assert.equal(s.stopping, false);
  await quiesce();
});

// ── the edge, which is the whole design ──────────────────────────────────────

test("STOPPING INSIDE A WINDOW STAYS STOPPED — the tick must not restart it", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp();
  await tick();
  assert.equal((await sweep()).running, true);

  setClock(2026, 9, 14, 10, 0);
  await quiesce(); // the user presses Stop, mid-window
  assert.equal((await sweep()).running, false);

  for (const hour of [10, 11, 14, 16]) {
    setClock(2026, 9, 14, hour, 30);
    await tick();
    assert.equal((await sweep()).running, false, `the tick restarted the run at ${hour}:30`);
  }
});

test("…but the NEXT window still opens", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp();
  await tick();
  setClock(2026, 9, 14, 10, 0);
  await quiesce();

  setClock(2026, 9, 15, 9, 0); // Tuesday
  await tick();
  assert.equal((await sweep()).running, true, "a stop yesterday afternoon silenced the account for good");
  await quiesce();
});

test("a run whose alarm never fires still stops at the boundary", async () => {
  setClock(2026, 9, 14, 16, 59);
  await setUp();
  await tick();
  assert.equal((await sweep()).running, true);

  // The clock crosses the close and NO tick happens — a suspended laptop, a
  // worker restarting at the wrong moment, an alarm Chrome decided to skip.
  // The loop is what actually opens conversations, so it has to refuse a cycle
  // on its own rather than trust that something told it to stop.
  setClock(2026, 9, 14, 17, 1);
  // Waking it is how a cycle is reached inside a test: the page reports a
  // changed row, which is the same path a live inbox uses.
  for (const fn of listeners.message) {
    fn({ type: "ft:list-changed", peers: ["a_lead"] }, { tab: IG }, () => {});
  }
  // Generous: the cycle already in flight has to finish first, and against a
  // stubbed page that means waiting out the adapter's own retries.
  for (let i = 0; i < 400 && (await sweep()).running; i++) await settle(50);
  assert.equal((await sweep()).running, false, "it worked another cycle after the window closed");
  assert.ok(said(/the schedule closed — stopping/), logLines().join(" | "));
});

test("a stop with nothing running does not wedge the schedule for the session", async () => {
  setClock(2026, 9, 14, 8, 0);
  await setUp();
  // Nothing is running — the panel only offers Stop during a run, but the tick
  // can reach this the moment a worker dies mid-stop, and the flag is only
  // ever cleared by a loop finishing. Left set, every scheduled start refuses
  // for the rest of the browser session with nothing in the log.
  await ask("ft:sweep-stop");
  assert.equal((await sweep()).stopping, false, "a stop with no run left the flag set");

  setClock(2026, 9, 14, 9, 0);
  await tick();
  assert.equal((await sweep()).running, true, "the window opened and the schedule was wedged");
  await quiesce();
});

test("a stopping flag left behind by a dead worker is cleared by the tick", async () => {
  setClock(2026, 9, 14, 9, 0);
  await setUp();
  // Exactly what a worker torn down mid-stop leaves in session storage.
  session["fluidextension.sweep"] = { running: false, stopping: true, done: 0, sent: 0, skipped: 0, cycles: 0 };
  await tick();
  assert.equal((await sweep()).running, true, "the run never started again after a half-finished stop");
  await quiesce();
});

// ── the gate the sweep does not cover ────────────────────────────────────────

test("OUTSIDE THE HOURS THE AUTO-REPLY WATCHER IS SILENT TOO", async () => {
  setClock(2026, 9, 14, 3, 0); // 3am Monday
  await setUp();
  await inboundMessage();
  assert.equal(fetches.length, 0, "a DM at 3am reached FluidTalk on an account set to 9–5");
  assert.ok(said(/outside the hours/), logLines().join(" | "));

  // Once per sleep, not once per message: a busy night would otherwise be a log
  // of nothing but this line.
  const before = logLines().filter((m) => /outside the hours/.test(m)).length;
  await inboundMessage("t2");
  await inboundMessage("t3");
  assert.equal(logLines().filter((m) => /outside the hours/.test(m)).length, before);
});

test("inside the hours the same message is answered", async () => {
  setClock(2026, 9, 14, 12, 0);
  await setUp();
  await inboundMessage();
  assert.ok(fetches.length > 0, "the gate held back a message during the hours it is meant to work");
  assert.match(fetches[0].url, /api-talk\.fluidvip\.com/);
});

test("with no schedule at all nothing is gated", async () => {
  setClock(2026, 9, 14, 3, 0);
  await setUp({ enabled: false });
  await inboundMessage();
  assert.ok(fetches.length > 0, "an account with no schedule stopped answering at night");
});

// ── failing closed ───────────────────────────────────────────────────────────

test("an unreadable week runs nothing and says so once", async () => {
  setClock(2026, 9, 14, 12, 0);
  await setUp({ schedule: { mon: [["09:00", "5pm"]] } });
  await tick();
  await tick();
  assert.equal((await sweep()).running, false, "a week nobody can read must not be treated as 'always'");
  await inboundMessage();
  assert.equal(fetches.length, 0);
  // TWO facts, each said once: nothing will run by itself, and somebody wrote
  // and got no answer. They are deduped independently — sharing one slot made
  // them take turns clearing it, which put the pair in the log every minute.
  assert.equal(logLines().filter((m) => /nothing will run by itself/.test(m)).length, 1, logLines().join(" | "));
  assert.equal(logLines().filter((m) => /a message arrived, and the schedule/.test(m)).length, 1);
  await tick();
  await inboundMessage("t9");
  await tick();
  assert.equal(logLines().filter((m) => /nothing will run by itself/.test(m)).length, 1, "the tick repeated itself");
  assert.equal(logLines().filter((m) => /a message arrived, and the schedule/.test(m)).length, 1, "the gate repeated itself");
});

test("the panel is told the same thing the tick acted on", async () => {
  setClock(2026, 9, 14, 12, 0);
  await setUp();
  const st = await ask("ft:schedule-preview", { platform: "instagram" });
  assert.equal(st.enabled, true);
  assert.equal(st.open, true);
  assert.equal(st.window.to, "17:00");
  assert.equal(new Date(st.next.startAt).getDate(), 15, "the next opening is Tuesday");
  // And `ft:get-state` carries it for the run bar.
  const state = await ask("ft:get-state");
  assert.equal(state.schedule.open, true);
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
  } finally {
    await quiesce().catch(() => {});
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
