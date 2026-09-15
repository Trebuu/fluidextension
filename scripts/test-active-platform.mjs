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
    sendMessage: async (_id, msg) => {
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
function ask(type, extra = {}) {
  return new Promise((resolve, reject) => {
    let answered = false;
    for (const fn of listeners.message) {
      const kept = fn({ type, ...extra }, { tab: extra.__sender ?? null }, (reply) => {
        answered = true;
        reply?.ok ? resolve(reply.result) : reject(new Error(reply?.error ?? "no error given"));
      });
      if (kept) {
        // Async handler: give it a turn to settle before declaring it missing.
        setTimeout(() => answered || reject(new Error(`"${type}" never answered`)), 2000);
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
  assert.deepEqual(rows.map((r) => r.configured), [false, false, false]);
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
