/**
 * Settings store tests — run with `node scripts/test-settings.mjs`.
 *
 * WHY THIS FILE EXISTS AT ALL, in a repo with no other tests: the settings
 * store now MIGRATES. Every existing install holds one flat settings object
 * written by an earlier build, and the two-level per-platform store has to
 * carry it across without losing a token, silently switching a platform off,
 * or — worst — handing one platform another platform's `ownUsername`, which is
 * sent to FluidTalk as `own_username` and files a real conversation under an
 * account it never happened on.
 *
 * None of that throws. A migration that drops a field looks exactly like a
 * fresh install, and the only symptom is somebody's configuration quietly
 * reverting to defaults. So it is asserted rather than eyeballed.
 *
 * `chrome.storage.local` is stubbed, because the store is the thing under test
 * and Chrome's is not. Nothing else here is mocked: the real `settings.js` is
 * imported and the real `PLATFORMS` registry drives the per-platform loop.
 */

import assert from "node:assert/strict";

// Must exist BEFORE settings.js is imported — it reads `chrome` at call time,
// but keeping this first means an accidental top-level read fails loudly here
// rather than in a browser.
let backing = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in backing ? { [key]: backing[key] } : {}),
      set: async (obj) => void Object.assign(backing, obj),
    },
  },
};

const settings = await import("../src/lib/settings.js");
const { PLATFORMS } = await import("../src/lib/platforms.js");
const {
  API_BASE,
  loadSettings,
  loadStore,
  saveSettings,
  setConfigured,
  platformConfigured,
  configuredPlatforms,
  followupStages,
  missingConfig,
} = settings;

const KEY = "fluidextension.settings";
const reset = (stored) => {
  backing = stored ? { [KEY]: stored } : {};
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── fresh install ────────────────────────────────────────────────────────────

test("a fresh install resolves defaults, flat, tagged with its platform", async () => {
  reset(null);
  const s = await loadSettings("instagram");
  assert.equal(s.platform, "instagram");
  assert.equal(s.apiBase, API_BASE);
  assert.equal(s.connectorToken, "");
  assert.equal(s.autoSend, true);
  assert.equal(s.ownUsername, "");
  // Flat at the point of use is the whole point: `fluidtalk.js` and 35 call
  // sites in the worker read `settings.<key>` directly and must not change.
  assert.equal(typeof s.newThreadsPerHour, "number");
});

test("nothing is set up until the user sets it up", async () => {
  reset(null);
  const store = await loadStore();
  for (const p of PLATFORMS) {
    assert.equal(platformConfigured(store, p.id), false, `${p.id} should start unconfigured`);
  }
});

// ── migration from the old flat store ────────────────────────────────────────

/** What an install written by the pre-per-platform build actually looks like. */
const OLD = {
  apiBase: API_BASE,
  connectorToken: "ftc_realtoken",
  platform: "whatsapp",
  ownUsername: "15550123456",
  ownUsernames: { instagram: "our_account", whatsapp: "15550123456" },
  disabledPlatforms: ["telegram"],
  multiplatform: true,
  autoSend: false,
  newThreadsPerHour: 9,
  followupStagesHours: "6,36",
  commentsEnabled: false,
};

test("migration keeps the token global", async () => {
  reset({ ...OLD });
  for (const p of PLATFORMS) {
    const s = await loadSettings(p.id);
    assert.equal(s.connectorToken, "ftc_realtoken", `${p.id} lost the token`);
  }
});

test("migration carries the old behaviour onto every platform", async () => {
  reset({ ...OLD });
  for (const p of PLATFORMS) {
    const s = await loadSettings(p.id);
    assert.equal(s.autoSend, false, `${p.id} did not inherit autoSend`);
    assert.equal(s.newThreadsPerHour, 9, `${p.id} did not inherit the rate cap`);
    assert.equal(s.followupStagesHours, "6,36", `${p.id} did not inherit the ladder`);
    assert.equal(s.commentsEnabled, false, `${p.id} did not inherit commentsEnabled`);
  }
});

test("migration binds EXACTLY ONE, and it is the one last worked", async () => {
  reset({ ...OLD });
  const store = await loadStore();
  // The old build ran several at once, so several were "enabled" — but only one
  // can be bound now. `platform` is the last one that was actually active, which
  // is the only signal in the old store about which the user was on.
  assert.deepEqual(configuredPlatforms(store), ["whatsapp"]);
  // It was in `disabledPlatforms`, i.e. the user had switched it off. Coming
  // back bound would start running a platform they had turned off.
  assert.equal(platformConfigured(store, "telegram"), false);
});

test("migration falls back to an enabled platform when the last-active one was off", async () => {
  reset({ ...OLD, platform: "telegram" }); // telegram is in disabledPlatforms
  assert.deepEqual(configuredPlatforms(await loadStore()), ["instagram"]);
});

test("migration binds nothing when everything was switched off", async () => {
  reset({ ...OLD, disabledPlatforms: ["instagram", "telegram", "whatsapp"] });
  assert.deepEqual(configuredPlatforms(await loadStore()), []);
});

test("each platform keeps ITS OWN handle, and never inherits another's", async () => {
  reset({ ...OLD });
  assert.equal((await loadSettings("instagram")).ownUsername, "our_account");
  assert.equal((await loadSettings("whatsapp")).ownUsername, "15550123456");
  // THE ONE THAT MATTERS. The old flat `ownUsername` held a WhatsApp phone
  // number at migration time; copying it onto Telegram would offer a phone
  // number as a Telegram handle, and it is sent onward as `own_username`.
  // Empty fails loudly; wrong files a conversation under the wrong account.
  assert.equal((await loadSettings("telegram")).ownUsername, "");
});

test("migration is idempotent — it cannot re-run over a later edit", async () => {
  reset({ ...OLD });
  await loadStore(); // migrate
  await saveSettings("instagram", { newThreadsPerHour: 2 });
  // A second load must not re-apply OLD.newThreadsPerHour = 9 over the edit.
  assert.equal((await loadSettings("instagram")).newThreadsPerHour, 2);
  assert.equal((await loadSettings("whatsapp")).newThreadsPerHour, 9);
});

// ── per-platform independence ────────────────────────────────────────────────

test("saving a per-platform key touches only that platform", async () => {
  reset(null);
  await saveSettings("telegram", { autoSend: false, newThreadsPerHour: 1 });
  assert.equal((await loadSettings("telegram")).autoSend, false);
  assert.equal((await loadSettings("telegram")).newThreadsPerHour, 1);
  assert.equal((await loadSettings("instagram")).autoSend, true, "instagram was changed too");
  assert.equal((await loadSettings("whatsapp")).autoSend, true, "whatsapp was changed too");
});

test("saving the token reaches every platform, because it is global", async () => {
  reset(null);
  await saveSettings("telegram", { connectorToken: "ftc_shared" });
  for (const p of PLATFORMS) {
    assert.equal((await loadSettings(p.id)).connectorToken, "ftc_shared", `${p.id} did not see the token`);
  }
});

test("apiBase is pinned on write, not merely defaulted", async () => {
  reset(null);
  await saveSettings("instagram", { apiBase: "https://staging.example.com" });
  assert.equal((await loadSettings("instagram")).apiBase, API_BASE);
});

test("setConfigured is the bind gate, both ways", async () => {
  reset(null);
  await setConfigured("instagram", true);
  assert.equal(platformConfigured(await loadStore(), "instagram"), true);
  assert.equal(platformConfigured(await loadStore(), "telegram"), false);
  await setConfigured("instagram", false);
  assert.equal(platformConfigured(await loadStore(), "instagram"), false);
});

test("BINDING IS EXCLUSIVE — binding one unbinds the others", async () => {
  reset(null);
  await setConfigured("instagram", true);
  await setConfigured("telegram", true);
  assert.deepEqual(configuredPlatforms(await loadStore()), ["telegram"]);
  await setConfigured("whatsapp", true);
  assert.deepEqual(configuredPlatforms(await loadStore()), ["whatsapp"]);
});

test("unbinding leaves nothing bound, rather than falling back to another", async () => {
  reset(null);
  await setConfigured("telegram", true);
  await setConfigured("telegram", false);
  assert.deepEqual(configuredPlatforms(await loadStore()), []);
});

test("rebinding keeps every platform's own settings", async () => {
  reset(null);
  await saveSettings("instagram", { newThreadsPerHour: 7 });
  await saveSettings("telegram", { newThreadsPerHour: 2 });
  await setConfigured("instagram", true);
  await setConfigured("telegram", true); // unbinds instagram
  await setConfigured("instagram", true); // and back
  assert.equal((await loadSettings("instagram")).newThreadsPerHour, 7);
  assert.equal((await loadSettings("telegram")).newThreadsPerHour, 2);
});

test("changing a setting does NOT bind a platform — binding is its own act", async () => {
  reset(null);
  // Binding is an explicit button now. Making it a side effect of touching any
  // control meant reading a platform's settings and nudging a number by
  // accident enrolled an account nobody had decided to run.
  await saveSettings("whatsapp", { autoSend: false });
  assert.equal((await loadSettings("whatsapp")).autoSend, false, "the setting was not saved");
  assert.equal(platformConfigured(await loadStore(), "whatsapp"), false);
});

test("settings survive being changed BEFORE the platform is bound", async () => {
  reset(null);
  await saveSettings("whatsapp", { newThreadsPerHour: 2 });
  await setConfigured("whatsapp", true);
  assert.equal((await loadSettings("whatsapp")).newThreadsPerHour, 2);
  assert.equal(platformConfigured(await loadStore(), "whatsapp"), true);
});

test("detecting a handle does NOT set a platform up", async () => {
  reset(null);
  // Merely having the tab open is what detects the handle. If that enrolled the
  // platform, "the user sets each one up" would be broken by a side effect.
  await settings.rememberHandle("telegram", "lead_handle");
  assert.equal((await loadSettings("telegram")).ownUsername, "lead_handle");
  assert.equal(platformConfigured(await loadStore(), "telegram"), false);
});

test("a global-only save does NOT set a platform up", async () => {
  reset(null);
  // Pasting the shared token is not "I want it running on WhatsApp too".
  await saveSettings("whatsapp", { connectorToken: "ftc_x" });
  assert.equal(platformConfigured(await loadStore(), "whatsapp"), false);
});

// ── no platform in front ─────────────────────────────────────────────────────

test("loadSettings(null) still answers, for calls with no platform", async () => {
  reset(null);
  await saveSettings("instagram", { connectorToken: "ftc_y" });
  const s = await loadSettings(null);
  assert.equal(s.platform, null);
  assert.equal(s.connectorToken, "ftc_y");
  // No per-platform overrides applied — it is nobody's settings, so it must not
  // silently answer with one platform's.
  assert.equal(s.ownUsername, "");
});

// ── things that must not have changed ────────────────────────────────────────

test("followupStages still keeps order and repeats", async () => {
  assert.deepEqual(followupStages({ followupStagesHours: "48,12" }), [48, 12]);
  assert.deepEqual(followupStages({ followupStagesHours: "24,24,24" }), [24, 24, 24]);
});

test("missingConfig still names the token", async () => {
  assert.deepEqual(missingConfig({ connectorToken: "" }), ["connector token"]);
  assert.deepEqual(missingConfig({ connectorToken: "nope" }), ["connector token (must start with ftc_)"]);
  assert.deepEqual(missingConfig({ connectorToken: "ftc_ok" }), []);
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
