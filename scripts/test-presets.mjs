/**
 * Preset tests — run with `node scripts/test-presets.mjs`.
 *
 * A preset is a whole-extension snapshot: the token, which platform is bound,
 * and every platform's settings. It exists so a fleet of AdsPower profiles can
 * be configured once instead of fifty times.
 *
 * WHY THIS IS TESTED HARDER THAN IT LOOKS: the fleet file is AUTHORITATIVE and
 * re-applied on every launch. A preset that half-applies, or a malformed file
 * that applies anyway, does not break one browser — it overwrites the working
 * configuration of every profile in the fleet at the same moment, unattended.
 * So the rules are: validate first, apply all-or-nothing, and never bind more
 * than the one platform the preset names.
 *
 * `chrome.storage.local` is stubbed; the real settings module is imported.
 */

import assert from "node:assert/strict";

let backing = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in backing ? { [key]: backing[key] } : {}),
      set: async (obj) => void Object.assign(backing, obj),
    },
  },
};

const S = await import("../src/lib/settings.js");
const {
  PRESET_FORMAT,
  loadStore,
  loadSettings,
  saveSettings,
  setConfigured,
  configuredPlatforms,
  exportPreset,
  validatePreset,
  applyPreset,
  savePreset,
  listPresets,
  deletePreset,
  pickFleetPreset,
} = S;

const reset = () => {
  backing = {};
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A configured install to export from. */
async function seed() {
  reset();
  await saveSettings("telegram", { connectorToken: "ftc_live", newThreadsPerHour: 9, autoSend: false });
  await saveSettings("instagram", { newThreadsPerHour: 2, followupStagesHours: "6,36" });
  await setConfigured("telegram", true);
}

// ── export ───────────────────────────────────────────────────────────────────

test("an export captures the token, the binding and EVERY platform's settings", async () => {
  await seed();
  const p = await exportPreset("fleet a");
  assert.equal(p.fluidextension, PRESET_FORMAT);
  assert.equal(p.name, "fleet a");
  assert.equal(p.token, "ftc_live");
  assert.equal(p.bind, "telegram");
  // Not only the bound one: a preset is the whole install, so rebinding later
  // must not find the other platforms reverted to defaults.
  assert.equal(p.platforms.telegram.newThreadsPerHour, 9);
  assert.equal(p.platforms.instagram.newThreadsPerHour, 2);
  assert.equal(p.platforms.instagram.followupStagesHours, "6,36");
});

test("the token can be left out, and then it is ABSENT rather than empty", async () => {
  await seed();
  const p = await exportPreset("no token", { includeToken: false });
  // Absent, not "" — an empty string would overwrite a good token with nothing
  // when the preset is applied somewhere else.
  assert.equal("token" in p, false);
});

test("an export never carries the detected handle", async () => {
  await seed();
  await S.rememberHandle("telegram", "tg_account");
  const p = await exportPreset("x");
  // ownUsername is read from the page. Shipping one profile's handle to fifty
  // others would send `own_username` for an account they are not signed in to.
  assert.equal("ownUsername" in (p.platforms.telegram ?? {}), false);
});

// ── validation, which is what stops a bad file wrecking a fleet ──────────────

test("validation rejects anything that is not a preset", async () => {
  for (const junk of [null, 42, "hello", [], {}, { name: "x" }]) {
    assert.equal(validatePreset(junk).ok, false, `accepted ${JSON.stringify(junk)}`);
  }
});

test("validation rejects a preset from a newer format", async () => {
  const r = validatePreset({ fluidextension: 99, name: "x", platforms: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /format/i);
});

test("validation rejects an unknown platform and a bad bind", async () => {
  assert.equal(validatePreset({ fluidextension: 1, name: "x", platforms: { myspace: {} } }).ok, false);
  assert.equal(validatePreset({ fluidextension: 1, name: "x", bind: "myspace", platforms: {} }).ok, false);
});

test("validation rejects a token that is not a connector token", async () => {
  const r = validatePreset({ fluidextension: 1, name: "x", token: "nope", platforms: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /ftc_/);
});

test("validation DROPS unknown setting keys instead of failing", async () => {
  // A preset written by a newer build must still load on an older one, and a
  // stray key is not a reason to refuse the whole fleet's configuration.
  const r = validatePreset({
    fluidextension: 1, name: "x", bind: null,
    platforms: { telegram: { newThreadsPerHour: 3, somethingNew: true } },
  });
  assert.equal(r.ok, true, r.errors.join(" "));
  assert.equal(r.preset.platforms.telegram.somethingNew, undefined);
  assert.equal(r.preset.platforms.telegram.newThreadsPerHour, 3);
});

test("validation refuses to let a preset carry a handle", async () => {
  const r = validatePreset({
    fluidextension: 1, name: "x", platforms: { telegram: { ownUsername: "someone_else" } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.preset.platforms.telegram.ownUsername, undefined, "a handle rode in on a preset");
});

// ── apply ────────────────────────────────────────────────────────────────────

test("applying a preset sets the token, the settings and the binding", async () => {
  await seed();
  const p = await exportPreset("fleet a");
  reset(); // a fresh profile
  await applyPreset(p);
  assert.equal((await loadSettings("telegram")).connectorToken, "ftc_live");
  assert.equal((await loadSettings("telegram")).newThreadsPerHour, 9);
  assert.equal((await loadSettings("instagram")).newThreadsPerHour, 2);
  assert.deepEqual(configuredPlatforms(await loadStore()), ["telegram"]);
});

test("applying OVERWRITES local edits — the fleet file is authoritative", async () => {
  await seed();
  const p = await exportPreset("fleet a");
  // Somebody tweaked this one profile by hand.
  await saveSettings("telegram", { newThreadsPerHour: 1, autoSend: true });
  await setConfigured("instagram", true);
  await applyPreset(p);
  assert.equal((await loadSettings("telegram")).newThreadsPerHour, 9);
  assert.equal((await loadSettings("telegram")).autoSend, false);
  assert.deepEqual(configuredPlatforms(await loadStore()), ["telegram"], "the hand-bound platform survived");
});

test("a preset that binds nothing unbinds everything", async () => {
  await seed();
  const p = await exportPreset("idle");
  p.bind = null;
  await applyPreset(p);
  assert.deepEqual(configuredPlatforms(await loadStore()), []);
});

test("applying a preset WITHOUT a token leaves the existing one alone", async () => {
  await seed();
  const p = await exportPreset("no token", { includeToken: false });
  reset();
  await saveSettings("telegram", { connectorToken: "ftc_already_here" });
  await applyPreset(p);
  assert.equal((await loadSettings("telegram")).connectorToken, "ftc_already_here");
});

test("applying never overwrites the DETECTED handle", async () => {
  await seed();
  const p = await exportPreset("fleet a");
  reset();
  await S.rememberHandle("telegram", "tg_account");
  await applyPreset(p);
  assert.equal((await loadSettings("telegram")).ownUsername, "tg_account");
});

test("applying an invalid preset changes NOTHING, and says why", async () => {
  await seed();
  const before = JSON.stringify(backing);
  // The MESSAGE is asserted, not merely that it rejected. Without validation
  // this still rejects — with a TypeError deeper in — so a bare
  // `assert.rejects` passes whether the guard exists or not, which is a test
  // that cannot fail for the reason it was written.
  await assert.rejects(
    () => applyPreset({ fluidextension: 1, name: "bad", bind: "myspace", platforms: {} }),
    /is not usable.*myspace/,
  );
  assert.equal(JSON.stringify(backing), before, "a rejected preset still wrote something");
});

// ── saved presets ────────────────────────────────────────────────────────────

test("presets can be saved, listed, re-applied and deleted", async () => {
  await seed();
  await savePreset("tg fleet");
  await saveSettings("telegram", { newThreadsPerHour: 1 });
  await savePreset("slow");
  assert.deepEqual((await listPresets()).map((p) => p.name), ["tg fleet", "slow"]);

  await applyPreset((await listPresets()).find((p) => p.name === "tg fleet"));
  assert.equal((await loadSettings("telegram")).newThreadsPerHour, 9);

  await deletePreset("slow");
  assert.deepEqual((await listPresets()).map((p) => p.name), ["tg fleet"]);
});

test("saving under an existing name replaces it rather than duplicating", async () => {
  await seed();
  await savePreset("one");
  await saveSettings("telegram", { newThreadsPerHour: 4 });
  await savePreset("one");
  const all = await listPresets();
  assert.equal(all.length, 1);
  assert.equal(all[0].platforms.telegram.newThreadsPerHour, 4);
});

test("saved presets survive applying another preset", async () => {
  // They live under their own key, not inside the settings the apply rewrites.
  await seed();
  await savePreset("keep me");
  await applyPreset(await exportPreset("other"));
  assert.deepEqual((await listPresets()).map((p) => p.name), ["keep me"]);
});

// ── the fleet file ───────────────────────────────────────────────────────────

const FLEET = {
  fluidextension: 1,
  default: "tg",
  accounts: { tg_account: "tg", our_account: "ig" },
  presets: [
    { fluidextension: 1, name: "tg", bind: "telegram", token: "ftc_tg", platforms: { telegram: { newThreadsPerHour: 5 } } },
    { fluidextension: 1, name: "ig", bind: "instagram", token: "ftc_ig", platforms: { instagram: { newThreadsPerHour: 7 } } },
  ],
};

test("with no handle known yet, the fleet default is chosen", async () => {
  assert.equal(pickFleetPreset(FLEET, {})?.name, "tg");
});

test("a known handle picks ITS row, not the default", async () => {
  assert.equal(pickFleetPreset(FLEET, { handle: "our_account" })?.name, "ig");
  assert.equal(pickFleetPreset(FLEET, { handle: "tg_account" })?.name, "tg");
});

test("an unrecognised handle falls back to the default rather than nothing", async () => {
  assert.equal(pickFleetPreset(FLEET, { handle: "a_stranger" })?.name, "tg");
});

test("a named preset beats both", async () => {
  assert.equal(pickFleetPreset(FLEET, { handle: "tg_account", name: "ig" })?.name, "ig");
});

test("a bare preset object is accepted as a one-preset fleet", async () => {
  const bare = { fluidextension: 1, name: "solo", bind: "telegram", platforms: {} };
  assert.equal(pickFleetPreset(bare, {})?.name, "solo");
});

test("a fleet file with no usable preset picks nothing, rather than guessing", async () => {
  assert.equal(pickFleetPreset({ fluidextension: 1, presets: [] }, {}), null);
  assert.equal(pickFleetPreset(null, {}), null);
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
