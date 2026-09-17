/**
 * Launch a browser with FluidExtension loaded, for development.
 *
 * FluidCode's own `browser_open` cannot do this: `apps/browser-host/src/launch.ts`
 * builds a fixed argument list whose only `extraArgs` are CloakBrowser's
 * fingerprint switches, so there is no `--load-extension` route through it.
 *
 * The profile directory is DURABLE and outside the repo, so the Instagram login
 * survives restarts — logging in on every run is what makes a checkpoint fire.
 *
 * ONE WINDOW: the platform tab, with the side panel DOCKED beside it. Not two
 * tabs — the panel is not a page you switch to, and the front tab of the window
 * is what decides which platform the extension works.
 *
 * Usage:
 *   node scripts/dev-browser.mjs                      # CloakBrowser if installed, else Edge
 *   node scripts/dev-browser.mjs --platform telegram  # instagram (default) | telegram | whatsapp
 *   node scripts/dev-browser.mjs --url https://…      # anything else
 *   node scripts/dev-browser.mjs --channel edge --port 9333
 *   node scripts/dev-browser.mjs --no-panel           # leave the panel to the toolbar icon
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The one list of platforms, so a fifth one does not have to be remembered here.
import { PLATFORMS, routeFor } from "../src/lib/platforms.js";

const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(flag("port", 9333));
const PROFILE = flag("profile", join(tmpdir(), "fluidextension-dev-profile"));

/**
 * WHICH PLATFORM TO OPEN, and only that one.
 *
 * This used to hard-code Instagram's inbox. That was fine while the extension
 * worked every platform at once; it is actively wrong now that it works ONE —
 * the tab it lands on decides which platform goes active, so launching always
 * put you on Instagram whatever you were actually there to do.
 *
 * Derived from `PLATFORMS` rather than listed here, because a hand-written copy
 * drifts: this map had no `threads` entry, so `--platform threads` silently fell
 * back to Instagram's inbox — which then BOUND Instagram, the exact failure the
 * flag was added to prevent. `inbox` where a platform has one, `home` otherwise
 * (Telegram has no inbox route on purpose; see platforms.js).
 */
const PLATFORM_URLS = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, routeFor(p, "inbox") ?? routeFor(p, "home")]),
);
const PLATFORM = flag("platform", "instagram");
const START_URL = flag("url", PLATFORM_URLS[PLATFORM] ?? PLATFORM_URLS.instagram);
/** Dock the side panel next to that tab, rather than leaving it to be clicked. */
const DOCK_PANEL = !args.includes("--no-panel");
/** Force the worker to re-read from disk — see `dockSidePanel`. */
const RELOAD_EXT = !args.includes("--no-reload");

/**
 * CloakBrowser is not in a program-files tree and its version folder MOVES on
 * every update, so discovery scans and sorts rather than using a fixed path.
 * Pro builds first, then highest version — the same order FluidCode uses.
 */
function findCloak() {
  if (process.env.CLOAKBROWSER_BINARY_PATH) return process.env.CLOAKBROWSER_BINARY_PATH;
  const cache = process.env.CLOAKBROWSER_CACHE_DIR ?? join(homedir(), ".cloakbrowser");
  if (!existsSync(cache)) return null;

  const exe = process.platform === "win32" ? "chrome.exe" : "chrome";
  const candidates = readdirSync(cache)
    .filter((d) => d.startsWith("chromium-"))
    .map((d) => {
      const m = d.match(/^chromium-([\d.]+)(-pro)?$/);
      return {
        path: join(cache, d, exe),
        pro: Boolean(m?.[2]),
        version: (m?.[1] ?? "0").split(".").map(Number),
      };
    })
    .filter((c) => existsSync(c.path))
    .sort((a, b) => {
      if (a.pro !== b.pro) return a.pro ? -1 : 1;
      for (let i = 0; i < 4; i += 1) {
        const d = (b.version[i] ?? 0) - (a.version[i] ?? 0);
        if (d) return d;
      }
      return 0;
    });
  return candidates[0]?.path ?? null;
}

function findEdge() {
  const paths = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return paths.find(existsSync) ?? null;
}

/** A 5-digit seed derived from the profile, so the fingerprint is stable per jar. */
function fingerprintSeed(profile) {
  let hash = 2166136261;
  for (let i = 0; i < profile.length; i += 1) {
    hash ^= profile.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 10000 + (Math.abs(hash) % 90000);
}

const wanted = flag("channel", "cloak");
let binary = wanted === "cloak" ? findCloak() : null;
let channel = "cloak";
if (!binary) {
  binary = findEdge();
  channel = "edge";
}
if (!binary) {
  console.error("no browser found. Install CloakBrowser with: npx cloakbrowser install");
  process.exit(1);
}

mkdirSync(PROFILE, { recursive: true });

/**
 * Tell the profile never to sleep the platform tabs.
 *
 * ⚠ THE LAUNCH FLAGS BELOW DO NOT TURN EDGE'S SLEEPING TABS OFF. Measured over
 * three hour-long unattended runs on Edge 152: with the whole
 * `--disable-features=SleepingTabs,msSleepingTabs,TabFreeze,…` list plus
 * `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`
 * in place, run 2 still spent its last third asleep — 25 sleep events, cycles
 * 18 through 24 each `failed: the browser put this tab to sleep mid-call`.
 *
 * Sleeping Tabs is a PROFILE SETTING on Edge, not a feature flag, so it is read
 * from `Preferences` and a command line cannot reach it. The per-site exception
 * list is what the "never put these sites to sleep" box in Settings writes, and
 * `setting: 2` (BLOCK) is what "never sleep" means there. With these four
 * entries written, run 3 slept zero times.
 *
 * Written BEFORE launch on purpose: the browser rewrites `Preferences` when it
 * exits, so an edit made while it is running is discarded. A profile that has
 * never been launched has no `Preferences` yet — starting from `{}` is correct,
 * Chromium fills in the rest.
 */
function neverSleep(profile) {
  const file = join(profile, "Default", "Preferences");
  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // No profile yet, or one we cannot parse. Either way the launch below
    // recreates it, and a sleeping tab is not worth failing a launch over.
    if (existsSync(file)) return console.log("sleeping tabs: Preferences unreadable, left alone");
  }
  const settings = ((((prefs.profile ??= {}).content_settings ??= {}).exceptions ??= {}).sleeping_tabs ??= {});
  // Chromium timestamps are microseconds since 1601-01-01.
  const stamp = String((Date.now() + 11644473600000) * 1000);
  for (const p of PLATFORMS) {
    // ⚠ `p.origin` IS NOT ALWAYS AN ORIGIN. Telegram's is
    // `https://web.telegram.org/k` — the K client's path is part of it, because
    // `platformForUrl` matches on it. Pasted into a content-setting pattern
    // that produced `https://web.telegram.org/k:443,*`, which Chromium rejects
    // as an invalid pattern and drops on load, silently and only for Telegram.
    const { origin } = new URL(p.origin);
    settings[`${origin}:443,*`] = { last_modified: stamp, setting: 2 };
  }
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(file, JSON.stringify(prefs));
  console.log(`sleeping tabs: blocked for ${PLATFORMS.length} platform origin(s)`);
}

neverSleep(PROFILE);

const launchArgs = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  // Both flags are required together: --load-extension alone is ignored by
  // recent Chromium unless the extension is also allowlisted.
  `--disable-extensions-except=${EXT_ROOT}`,
  `--load-extension=${EXT_ROOT}`,
  "--no-first-run",
  "--no-default-browser-check",
  // ⚠ WITHOUT THESE, A COVERED WINDOW IS A STOPPED WINDOW.
  //
  // Chrome on Windows marks a fully-covered window as OCCLUDED and reports
  // `document.visibilityState === "hidden"` for it — the same state as a
  // background tab. Telegram will not boot its chat list while hidden and
  // WhatsApp will not finish syncing, so the run reads an empty inbox and
  // reports nothing to do.
  //
  // Measured here: three platforms, each alone in its own window, all three
  // still `hidden` — because the user's editor and terminal were in front.
  // Giving each platform its own window is necessary (one tab per window can
  // be on screen) but NOT sufficient; occlusion has to be off as well, or the
  // moment anything covers the browser the run goes quiet again.
  "--disable-backgrounding-occluded-windows",
  /**
   * ⚠ AND SLEEPING TABS, or the tab the sweep drives goes to sleep under it.
   *
   * Measured over one unattended hour: from cycle 11 on, every cycle opened
   * with "the browser has put this tab to sleep", failed a page call on the
   * full 120-second deadline, repaired the tab, and hit the same wall next
   * time. The run answered nobody after cycle 7 — the last third of the hour
   * was timeouts and reloads.
   *
   * ONE `--disable-features` FLAG ONLY: a second occurrence REPLACES the first
   * rather than adding to it, so the occlusion switch has to live in this list
   * too. The names differ by build (Edge ships it as Sleeping Tabs, Chromium
   * as tab freezing/high-efficiency), so all of them are named — an unknown
   * feature name is ignored, an omitted one is not.
   *
   * ⚠ AND ON EDGE NONE OF IT WORKS — see `neverSleep()` below, which is what
   * actually stopped it. The flags stay because they are what Chromium reads.
   */
  "--disable-features=CalculateNativeWinOcclusion,SleepingTabs,msSleepingTabs,TabFreeze,HighEfficiencyModeAvailable,IntensiveWakeUpThrottling",
  // Belt and braces: these stop the renderer being throttled while backgrounded,
  // which is the same failure one layer down.
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  START_URL,
];

if (channel === "cloak") {
  // CloakBrowser's anti-bot patches are compiled in but sit INERT until
  // --fingerprint arms them; without these it is just an old Chromium.
  launchArgs.unshift(
    "--no-sandbox",
    `--fingerprint=${fingerprintSeed(PROFILE)}`,
    `--fingerprint-platform=${process.platform === "darwin" ? "macos" : "windows"}`,
  );
}

console.log(`channel : ${channel}`);
console.log(`binary  : ${binary}`);
console.log(`profile : ${PROFILE}`);
console.log(`devtools: http://127.0.0.1:${PORT}/json`);

const child = spawn(binary, launchArgs, { stdio: "inherit", detached: false });
child.on("exit", (code) => process.exit(code ?? 0));

/**
 * Dock the side panel beside the platform tab — ONE window, no extra tabs.
 *
 * The panel is an ordinary extension page, so it CAN be opened as a tab, and
 * that is what every harness here did. It is a bad way to look at the product:
 * you get two tabs that have to be switched between, the panel is not where it
 * lives, and the platform tab stops being the front tab of its window — which
 * matters, because the front tab is what decides the active platform.
 *
 * ⚠ `chrome.sidePanel.open()` MAY ONLY BE CALLED IN RESPONSE TO A USER GESTURE,
 * and CDP's `Runtime.evaluate({userGesture: true})` does NOT satisfy it — tried,
 * it throws that exact message. Nor can a content script do it: `sidePanel` is
 * not exposed there, and `Runtime.evaluate` lands in the page's MAIN world where
 * there is no `chrome.runtime` at all.
 *
 * What DOES work: an extension page has the full API, and a mouse event
 * dispatched through `Input.dispatchMouseEvent` is TRUSTED. So open the panel
 * page in a throwaway tab, click a real button in it, and close the tab again —
 * the panel is left docked in the window and the tab count is back to one.
 */
async function dockSidePanel() {
  const base = `http://127.0.0.1:${PORT}`;
  const targets = async () => (await (await fetch(`${base}/json/list`)).json());

  // The worker's presence is also the proof the manifest parsed, so waiting for
  // it is worth doing on its own.
  let sw = null;
  for (let i = 0; i < 40 && !sw; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    sw = (await targets().catch(() => [])).find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
  }
  if (!sw) return console.error("side panel: the extension's service worker never appeared");
  const ext = new URL(sw.url).host;

  const version = await (await fetch(`${base}/json/version`)).json();
  const ws = await new Promise((res, rej) => {
    const s = new WebSocket(version.webSocketDebuggerUrl);
    s.addEventListener("open", () => res(s));
    s.addEventListener("error", rej);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = (id += 1);
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => pending.has(n) && (pending.delete(n), reject(new Error(`${method} timed out`))), 15000);
    });

  /** A throwaway extension page, attached and focused. */
  async function scratchPage() {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${ext}/src/sidepanel/sidepanel.html` });
    await new Promise((r) => setTimeout(r, 1200));
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Target.activateTarget", { targetId });
    return { targetId, sessionId };
  }

  try {
    /**
     * ⚠ A BROWSER YOU JUST LAUNCHED CAN STILL BE RUNNING THE PREVIOUS BUILD.
     *
     * Chromium caches the service worker SCRIPT per profile, so an unpacked
     * extension whose files have changed on disk keeps answering with the old
     * ones — and it does not look like a stale build, it looks like a broken
     * one: handlers that "do not exist", fields coming back `undefined`. Hit
     * twice here, both times mistaken for a bug in the new code.
     *
     * `chrome.runtime.reload()` re-reads from disk. Doing it unconditionally on
     * launch costs a couple of seconds and removes the entire failure mode,
     * which is the right trade for a dev harness. `fetch`ing the source proves
     * the FILES are current and says nothing about the worker — only the worker
     * reappearing after this does.
     */
    if (RELOAD_EXT) {
      const first = await scratchPage();
      // Not awaited: this tears the page down, so the call never settles.
      send("Runtime.evaluate", { expression: `chrome.runtime.reload()` }, first.sessionId).catch(() => {});
      let back = null;
      for (let i = 0; i < 30 && !back; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        back = (await targets().catch(() => [])).find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
      }
      if (!back) return console.error("side panel: the worker did not come back after reload");
      console.log("extension: re-read from disk");
      await send("Target.closeTarget", { targetId: first.targetId }).catch(() => {});
    }

    const { targetId, sessionId } = await scratchPage();
    await send(
      "Runtime.evaluate",
      {
        expression: `(() => { const b = document.createElement("button");
          b.id = "__dock"; b.style.cssText = "position:fixed;inset:0;opacity:0";
          b.onclick = async () => { const w = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: w.id }); };
          document.body.appendChild(b); })()`,
      },
      sessionId,
    );
    await new Promise((r) => setTimeout(r, 300));
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: 40, y: 40, button: "left", clickCount: 1 }, sessionId);
    }
    await new Promise((r) => setTimeout(r, 1200));
    // The throwaway tab goes, leaving the platform tab alone in its window with
    // the panel docked beside it.
    await send("Target.closeTarget", { targetId });
    console.log("side panel: docked");
  } catch (err) {
    console.error(`side panel: could not dock it (${err.message}) — click the toolbar icon instead`);
  } finally {
    ws.close();
  }
}

if (DOCK_PANEL) dockSidePanel();
