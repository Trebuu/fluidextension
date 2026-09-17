/**
 * Update-check tests — run with `node scripts/test-update-check.mjs`.
 *
 * WHAT IS UNDER TEST is the decision "is there a newer release", which is the
 * whole of the notifier. It is worth testing out of proportion to its size for
 * one reason: EVERY WAY IT CAN FAIL IS SILENT. A comparison that never returns
 * true shows no banner, which is indistinguishable from being up to date. A
 * comparison that returns true too often nags on every open. Neither throws,
 * neither logs, and nobody reports either.
 *
 * WHAT IS STUBBED is `chrome` and `fetch` — the browser and the network, not
 * the thing under test. The real `compareVersions` and `checkForUpdate` are
 * imported from src/lib/update.js.
 */

import assert from "node:assert/strict";
import { compareVersions, isNewer, checkForUpdate, FEED_URL } from "../src/lib/update.js";

const ok = (name) => console.log(`  ok — ${name}`);

// ── the comparison itself ────────────────────────────────────────────────────
{
  assert.equal(compareVersions("0.2.1", "0.2.1"), 0);
  assert.equal(compareVersions("0.3.0", "0.2.1"), 1);
  assert.equal(compareVersions("0.2.1", "0.3.0"), -1);
  ok("equal, newer and older compare correctly");

  // 10 > 9 numerically, "10" < "9" as strings. A string compare here would stop
  // every install upgrading past x.9 and nothing would say why.
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "0.10.0 is newer than 0.9.0");
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  ok("compares numerically, not as strings (0.10.0 > 0.9.0)");

  // Manifest versions may be 2, 3 or 4 parts. A missing part is zero, not a
  // reason to give up.
  assert.equal(compareVersions("0.3", "0.3.0"), 0);
  assert.equal(compareVersions("0.3.1", "0.3"), 1);
  assert.equal(compareVersions("1.2.3.4", "1.2.3"), 1);
  ok("tolerates 2, 3 and 4 part versions");

  // The feed is authored by hand at some point. A stray "v" must not silently
  // disable updates for everyone.
  assert.equal(compareVersions("v0.3.0", "0.2.1"), 1, "a leading v is tolerated");
  assert.equal(compareVersions(" 0.3.0 ", "0.2.1"), 1, "whitespace is tolerated");
  ok("tolerates a leading v and surrounding whitespace");

  assert.equal(isNewer("0.3.0", "0.2.1"), true);
  assert.equal(isNewer("0.2.1", "0.2.1"), false);
  assert.equal(isNewer("0.2.0", "0.2.1"), false, "an OLDER feed must never offer a downgrade");
  ok("isNewer refuses equal and older");
}

// ── garbage in must not become a banner ──────────────────────────────────────
{
  for (const bad of [null, undefined, "", "latest", "not.a.version", {}, []]) {
    assert.equal(isNewer(bad, "0.2.1"), false, `isNewer(${JSON.stringify(bad)}) must be false`);
  }
  ok("junk versions never claim an update");
}

// ── the fetch path ───────────────────────────────────────────────────────────
const withChrome = (opts = {}) => {
  let local = { ...(opts.storage ?? {}) };
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: opts.current ?? "0.2.1" }) },
    storage: {
      local: {
        get: async (k) => (typeof k === "string" ? { [k]: local[k] } : { ...local }),
        set: async (o) => { local = { ...local, ...o }; },
      },
    },
  };
  return () => local;
};

{
  const read = withChrome({ current: "0.2.1" });
  let called = 0;
  globalThis.fetch = async (url) => {
    called += 1;
    assert.equal(url, FEED_URL, "asks the feed, not something else");
    return { ok: true, json: async () => ({ version: "0.3.0", download: "https://x/y.zip" }) };
  };
  const r = await checkForUpdate({ now: 1_000_000 });
  assert.equal(r.newer, true);
  assert.equal(r.latest, "0.3.0");
  assert.equal(r.current, "0.2.1");
  assert.equal(r.download, "https://x/y.zip");
  assert.equal(called, 1);
  ok("a newer feed reports an update, with its download link");

  // Throttled: a second call inside the window must not hit the network again.
  const r2 = await checkForUpdate({ now: 1_000_000 + 60_000 });
  assert.equal(called, 1, "did not re-fetch inside the throttle window");
  assert.equal(r2.newer, true, "still reports the cached answer");
  ok("throttles repeat checks, and still answers from cache");

  // Past the window it asks again.
  await checkForUpdate({ now: 1_000_000 + 7 * 60 * 60 * 1000 });
  assert.equal(called, 2, "re-fetched after the window");
  ok("re-checks once the window has passed");
  void read;
}

// ── the network failing must never look like an update ───────────────────────
{
  withChrome({ current: "0.2.1" });
  globalThis.fetch = async () => { throw new Error("offline"); };
  const r = await checkForUpdate({ now: 2_000_000 });
  assert.equal(r.newer, false, "offline is not an update");
  assert.ok(r.error, "and it says it failed rather than pretending it is current");
  ok("an offline check reports an error, never an update");

  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r2 = await checkForUpdate({ now: 3_000_000 });
  assert.equal(r2.newer, false);
  assert.ok(r2.error);
  ok("a 500 reports an error, never an update");

  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error("not json"); } });
  const r3 = await checkForUpdate({ now: 4_000_000 });
  assert.equal(r3.newer, false);
  assert.ok(r3.error);
  ok("an unparseable feed reports an error, never an update");
}

// ── the feed points at our own origin, which is already permitted ────────────
{
  assert.match(FEED_URL, /^https:\/\/[a-z]+\.fluidvip\.com\//,
    "the feed is on fluidvip.com — host_permissions already covers it, so no new permission prompt");
  ok(`the feed is on an already-permitted origin (${FEED_URL})`);
}

console.log("\nupdate-check: all assertions passed");
