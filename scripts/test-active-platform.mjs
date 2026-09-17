/**
 * Active-platform tests — run with `node scripts/test-active-platform.mjs`.
 *
 * WHAT IS UNDER TEST is the worker's answer to "which platform am I working",
 * and the rules built on it: exactly one platform may be BOUND, the bound one
 * is the only one worked, focus changes nothing, rebinding is refused mid-run,
 * and an unbound platform is never acted on.
 *
 * WHAT IS STUBBED is `chrome` — the browser, not the thing under test. The real
 * `src/background.js` is imported and evaluated, which is itself worth
 * something: a module-level ReferenceError in an MV3 worker does not throw
 * anywhere you can see it, it just leaves `chrome.runtime.sendMessage` NEVER
 * SETTLING, which reads like a slow network call. Importing it here turns that
 * class of mistake into a stack trace.
 *
 * The handlers are driven through the real `chrome.runtime.onMessage` listener
 * the worker registers, i.e. the same entry point the side panel uses — not by
 * reaching into private functions.
 *
 * This does NOT replace loading the extension in a browser. Chrome's own tab
 * and window semantics are exactly what is faked here, so a green run means the
 * logic is right, not that the extension works.
 */

import assert from "node:assert/strict";

// ── the browser, faked ───────────────────────────────────────────────────────

const listeners = { tabActivated: [], windowFocus: [], tabUpdated: [], message: [] };
let local = {};
let session = {};
let tabs = [];
/** Which tab the user is looking at. `null` = something that is not a tab. */
let focusedTabId = null;
/** What each content script answers, by message type. */
let pageAnswers = {};
/** Tab ids the browser has frozen — their content scripts do not run. */
let asleep = new Set();

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
    onActivated: evt("tabActivated"),
    onUpdated: evt("tabUpdated"),
    query: async ({ url, active, lastFocusedWindow }) => {
      let out = tabs;
      if (url) {
        const re = new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}`);
        out = out.filter((t) => re.test(t.url));
      }
      // The focused tab, for the `{active, lastFocusedWindow}` form.
      if (active && lastFocusedWindow) out = out.filter((t) => t.id === focusedTabId);
      return out;
    },
    get: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error("no such tab")),
    sendMessage: async (id, msg) => {
      // A SUSPENDED TAB NEVER ANSWERS — it does not reject, which is the whole
      // difficulty. Modelled here rather than as a rejection because a
      // rejection is the one behaviour the worker already handles well.
      if (asleep.has(id)) return new Promise(() => {});
      if (!(msg.type in pageAnswers)) throw new Error("Could not establish connection.");
      return { ok: true, result: pageAnswers[msg.type] };
    },
    create: async () => {},
    reload: async () => {},
    remove: async () => {},
    update: async () => {},
  },
  windows: { onFocusChanged: evt("windowFocus"), update: async () => {} },
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
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  scripting: { executeScript: async () => [] },
  sidePanel: { setPanelBehavior: async () => {} },
};

// Importing the REAL worker. A module-level error surfaces here.
await import("../src/background.js");
const { PLATFORMS } = await import("../src/lib/platforms.js");
const store = await import("../src/lib/settings.js");

/** Call a worker handler the way the side panel does. */
/**
 * `waitMs` exists for the passes that NAVIGATE. `goToRoute` sleeps 8–9 seconds
 * per page load by design (a real SPA needs it), and those sleeps are real here
 * — so an outreach preview legitimately takes longer than the default deadline,
 * and the default must stay short or a handler that never answers looks like a
 * slow one.
 */
function ask(type, extra = {}, waitMs = 2000) {
  return new Promise((resolve, reject) => {
    let answered = false;
    for (const fn of listeners.message) {
      const kept = fn({ type, ...extra }, { tab: extra.__sender ?? null }, (reply) => {
        answered = true;
        reply?.ok ? resolve(reply.result) : reject(new Error(reply?.error ?? "no error given"));
      });
      if (kept) {
        // Async handler: give it a turn to settle before declaring it missing.
        setTimeout(() => answered || reject(new Error(`"${type}" never answered`)), waitMs);
        return;
      }
    }
    if (!answered) reject(new Error(`no handler for "${type}"`));
  });
}

const fireFocus = async (tabId) => {
  focusedTabId = tabId;
  for (const fn of listeners.tabActivated) await fn({ tabId });
};

const IG = { id: 1, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: true };
const TG = { id: 2, windowId: 2, url: "https://web.telegram.org/k/#@someone", active: true };
const WA = { id: 3, windowId: 3, url: "https://web.whatsapp.com/", active: true };
const PANEL = { id: 9, windowId: 1, url: "chrome-extension://abc/src/sidepanel/sidepanel.html", active: true };

function reset() {
  local = {};
  session = {};
  tabs = [IG, TG, WA, PANEL];
  focusedTabId = null;
  asleep = new Set();
  // Every platform answers readiness, so `targetFor` can pick a tab.
  pageAnswers = { "ft:ready": { ready: true }, "ft:whoami": { handle: "someone" } };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const activeId = async () => (await ask("ft:platforms")).active;

// ── the bound platform IS the platform ─────────────────────────────────────

test("nothing bound means no platform, however tabs are focused", async () => {
  reset();
  await fireFocus(IG.id);
  assert.equal(await activeId(), null);
});

test("the bound platform is the one worked", async () => {
  reset();
  await ask("ft:set-configured", { platform: "telegram", on: true });
  assert.equal(await activeId(), "telegram");
});

test("FOCUS NO LONGER SWITCHES ANYTHING", async () => {
  reset();
  await ask("ft:set-configured", { platform: "telegram", on: true });
  // Under the old rule this made Instagram the working platform. Binding is now
  // the only way to say which account is worked, and a focus change must not
  // quietly override a decision the user made explicitly.
  await fireFocus(IG.id);
  assert.equal(await activeId(), "telegram");
  await fireFocus(WA.id);
  assert.equal(await activeId(), "telegram");
});

test("binding is exclusive through the worker too", async () => {
  reset();
  await ask("ft:set-configured", { platform: "instagram", on: true });
  await ask("ft:set-configured", { platform: "telegram", on: true });
  const { rows } = await ask("ft:platforms");
  assert.deepEqual(rows.filter((r) => r.configured).map((r) => r.id), ["telegram"]);
  assert.equal((await ask("ft:platforms")).active, "telegram");
});

// ── the setup gate ───────────────────────────────────────────────────────────

test("a run refuses when nothing is bound", async () => {
  reset();
  await fireFocus(IG.id);
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await assert.rejects(() => ask("ft:sweep-start"), /no platform is bound/);
});

test("binding Instagram binds only Instagram", async () => {
  reset();
  await fireFocus(IG.id);
  await ask("ft:set-configured", { platform: "instagram", on: true });
  const { rows } = await ask("ft:platforms");
  assert.equal(rows.find((r) => r.id === "instagram").configured, true);
  assert.equal(rows.find((r) => r.id === "telegram").configured, false);
  assert.equal(rows.find((r) => r.id === "whatsapp").configured, false);
});

test("changing a setting binds NOTHING", async () => {
  reset();
  await fireFocus(IG.id);
  await ask("ft:save-settings", { patch: { newThreadsPerHour: 7 } });
  const { rows } = await ask("ft:platforms");
  // Count-agnostic on purpose: the assertion is "none of them", and writing it
  // as a literal [false, false, false] made adding a fourth platform look like
  // a regression in binding rather than what it was.
  assert.deepEqual(rows.map((r) => r.configured), rows.map(() => false));
});

test("unbinding stops a platform being acted on again", async () => {
  reset();
  await fireFocus(IG.id);
  await ask("ft:set-configured", { platform: "instagram", on: true });
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await ask("ft:set-configured", { platform: "instagram", on: false });
  await assert.rejects(() => ask("ft:sweep-start"), /no platform is bound/);
});

test("the settings the panel gets are the BOUND platform's", async () => {
  reset();
  await ask("ft:save-settings", { platform: "instagram", patch: { newThreadsPerHour: 7 } });
  await ask("ft:save-settings", { platform: "telegram", patch: { newThreadsPerHour: 2 } });

  await ask("ft:set-configured", { platform: "instagram", on: true });
  assert.equal((await ask("ft:get-state")).settings.newThreadsPerHour, 7);
  await ask("ft:set-configured", { platform: "telegram", on: true });
  assert.equal((await ask("ft:get-state")).settings.newThreadsPerHour, 2);
});

test("a save names its platform, so a form open for one cannot write to another", async () => {
  reset();
  await fireFocus(IG.id);
  // The panel painted WhatsApp's form while Instagram is active — the normal
  // way to set up a platform you have not opened yet.
  await ask("ft:save-settings", { platform: "whatsapp", patch: { newThreadsPerHour: 4 } });
  assert.equal((await ask("ft:get-state")).settings.newThreadsPerHour, 5, "instagram was written to");
  assert.equal((await ask("ft:platform-settings", { platform: "whatsapp" })).newThreadsPerHour, 4);
});

// ── the freeze while running ─────────────────────────────────────────────────

test("REBINDING IS REFUSED WHILE A RUN IS GOING", async () => {
  reset();
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await ask("ft:set-configured", { platform: "instagram", on: true });
  await ask("ft:sweep-start");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ask("ft:get-state")).sweep.running, true, "the run did not start");

  // Binding is the only way to change which platform is worked, so this is the
  // one path that could move a run onto another account mid-conversation.
  await assert.rejects(() => ask("ft:set-configured", { platform: "telegram", on: true }), /stop the run/);
  assert.equal(await activeId(), "instagram", "the run migrated to another platform mid-flight");
  await ask("ft:sweep-stop");
});

// ── the auto-reply watcher ───────────────────────────────────────────────────

test("a message on a NON-BOUND platform is ignored", async () => {
  reset();
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await ask("ft:set-configured", { platform: "instagram", on: true });

  // Telegram's page watcher fires — its tab keeps running whether or not we are
  // working there. Under "one platform at a time" it must reach nothing.
  const before = JSON.stringify(session);
  for (const fn of listeners.message) {
    fn({ type: "ft:thread-changed", thread: { ok: true, threadId: "t1", lastInbound: { text: "hi" } } }, { tab: TG }, () => {});
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.stringify(session), before, "the worker acted on a platform it is not working");
});

// ── where outreach candidates come from ──────────────────────────────────────

/**
 * Both sources are stubbed at once, so each test proves which one was actually
 * READ — not merely that some handles came back. A source that is not asked for
 * must not even be visited: the followers list costs a profile load and a
 * dialog, and doing that for a feed-only run is the waste this setting exists
 * to avoid.
 */
async function previewWith(sources) {
  reset();
  // Parked ON the home route, so the feed pass's `goToRoute("home")` is the
  // no-op branch rather than a nine-second page load. The followers pass still
  // navigates for real, which is why the deadline below is generous.
  tabs = [{ ...IG, url: "https://www.instagram.com/" }, PANEL];
  const visited = [];
  pageAnswers = {
    "ft:ready": { ready: true },
    "ft:whoami": { handle: "me" },
    get "ft:read-feed"() {
      visited.push("feed");
      return [{ author: "feedguy" }, { author: "feedgal" }, { author: "me" }];
    },
    "ft:scroll-page": { moved: false },
    get "ft:open-followers"() {
      visited.push("followers");
      return { ok: true };
    },
    "ft:list-followers": { ok: true, handles: ["followerone", "followertwo"] },
    "ft:scroll-followers": { moved: false },
  };
  // BIND FIRST. A save names the platform it is for, so patching before there
  // is a bound platform writes the per-platform keys somewhere this run will
  // never read them — and the preview then quietly uses the defaults, which is
  // what made this test pass followers back when it asked for the feed.
  await ask("ft:set-configured", { platform: "instagram", on: true });
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test", outreachSources: sources } });
  const res = await ask("ft:outreach-preview", {}, 40000);
  return { targets: res.targets ?? [], visited };
}

test("outreach from FOLLOWERS never opens the feed", async () => {
  const { targets, visited } = await previewWith("followers");
  assert.deepEqual(targets, ["followerone", "followertwo"]);
  assert.ok(!visited.includes("feed"), "it read the feed for a followers-only run");
});

test("outreach from the FEED never opens the followers dialog", async () => {
  const { targets, visited } = await previewWith("feed");
  // Our own handle is dropped: the feed contains our own posts, and cold-opening
  // ourselves is the first thing an untested source does.
  assert.deepEqual(targets, ["feedguy", "feedgal"]);
  assert.ok(!visited.includes("followers"), "it opened the followers dialog for a feed-only run");
});

test("outreach from BOTH reads both, without duplicates", async () => {
  const { targets, visited } = await previewWith("both");
  assert.deepEqual(targets, ["feedguy", "feedgal", "followerone", "followertwo"]);
  assert.ok(visited.includes("feed") && visited.includes("followers"), `only read ${JSON.stringify(visited)}`);
});

// ── the Threads doorbell ─────────────────────────────────────────────────────

/**
 * The worker's log, newest first — where a doorbell ring is observable.
 *
 * It lives in storage.SESSION and its field is `message`. Reading the wrong one
 * makes every assertion below pass against an empty array, which is exactly how
 * a test that proves nothing looks.
 */
const logLines = async () => (session["fluidextension.log"] ?? []).map((l) => l.message ?? "");

/** Drive the realtime signal the way the page's own listener does. */
const rang = async (tab) => {
  for (const fn of listeners.message) fn({ type: "ft:realtime", reason: "payload" }, { tab }, () => {});
  await new Promise((r) => setTimeout(r, 60));
};

const THREADS = { id: 7, windowId: 1, url: "https://www.threads.com/messages/", active: true };

test("THE DOORBELL IS IGNORED WITH NO RUN GOING", async () => {
  reset();
  tabs = [THREADS, PANEL];
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await ask("ft:set-configured", { platform: "threads", on: true });

  // The owner's explicit choice: the socket may cut a run's gap short, but it
  // must never make the extension act when nothing was started. Anything else
  // answers a stranger at 3am with nobody watching.
  await rang(THREADS);
  const said = await logLines();
  assert.ok(
    !said.some((l) => /something arrived/.test(l)),
    `the doorbell acted with no run going: ${JSON.stringify(said.slice(0, 3))}`,
  );
});

test("the doorbell wakes a run that IS going", async () => {
  reset();
  tabs = [THREADS, PANEL];
  await ask("ft:save-settings", { patch: { connectorToken: "ftc_test" } });
  await ask("ft:set-configured", { platform: "threads", on: true });
  await ask("ft:sweep-start");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ask("ft:get-state")).sweep.running, true, "the run did not start");

  await rang(THREADS);
  const said = await logLines();
  assert.ok(
    said.some((l) => /something arrived/.test(l)),
    `a ring during a run did nothing: ${JSON.stringify(said.slice(0, 3))}`,
  );
  await ask("ft:sweep-stop");
});

// ── tabs the browser has put to sleep ────────────────────────────────────────

/**
 * Edge's Sleeping Tabs — and Chrome's own freezing — suspend an idle background
 * tab. It keeps its title and url, reports `status: "complete"` and is NOT
 * `discarded`; its page renders perfectly. The only thing that changes is that
 * its content script stops running, so a probe NEVER SETTLES rather than
 * failing. Measured live on a duplicate Threads tab: it sorted first by id, so
 * every resolution paid the full 10s readiness deadline before falling through
 * to a working tab, and one `ft:get-state` cost 30 seconds.
 */
test("a frozen tab is never the one worked, even though it looks fine", async () => {
  reset();
  // Two Instagram tabs, the ASLEEP one first by id — the order that used to
  // decide it. It answers here, so this fails on the choice rather than on a
  // timeout: age and readiness both said yes, and both were wrong.
  const SLEEPING = { id: 1, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: false, frozen: true };
  const AWAKE = { id: 5, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: true };
  tabs = [SLEEPING, AWAKE, PANEL];

  const row = (await ask("ft:platforms")).rows.find((r) => r.id === "instagram");
  assert.equal(row.tabId, AWAKE.id, "the worker picked a tab the browser had suspended");
  assert.equal(row.reachable, true);
});

test("resolving a platform does not WAIT on a frozen tab", async () => {
  reset();
  const SLEEPING = { id: 1, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: false, frozen: true };
  const AWAKE = { id: 5, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: true };
  tabs = [SLEEPING, AWAKE, PANEL];
  asleep.add(SLEEPING.id);

  // The cost, not the choice. `frozen` is readable, so the answer must not
  // depend on waiting out a probe that can never come back — the panel makes
  // several of these calls on every refresh, which is what turned a suspended
  // background tab into an extension nobody could click.
  const t0 = Date.now();
  const row = (await ask("ft:platforms")).rows.find((r) => r.id === "instagram");
  const ms = Date.now() - t0;
  assert.equal(row.tabId, AWAKE.id);
  assert.ok(ms < 1000, `resolving took ${ms}ms — it waited on the sleeping tab`);
});

test("the LAST tab falling asleep is reported, not waited out", async () => {
  reset();
  // One tab, and it is asleep — `targetFor` has nothing else to choose, so this
  // is the case that used to cost the probe deadline and then a two-minute call
  // timeout per `askPage`, leaving the platform silent with nothing in the log.
  const ONLY = { id: 1, windowId: 1, url: "https://www.instagram.com/direct/inbox/", active: true, frozen: true };
  tabs = [ONLY, PANEL];
  asleep.add(ONLY.id);

  const t0 = Date.now();
  const row = (await ask("ft:platforms")).rows.find((r) => r.id === "instagram");
  const ms = Date.now() - t0;
  assert.equal(row.open, true, "the tab is still open — asleep is not closed");
  assert.equal(row.reachable, false, "a sleeping tab cannot be driven and must not read as reachable");
  assert.ok(ms < 1000, `took ${ms}ms — it waited on a tab the browser had already declared asleep`);
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
    console.log(`       ${String(err.message).split("\n").join("\n       ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
