/**
 * Service worker — the only place that holds the connector token and the only
 * place that talks to FluidTalk.
 *
 * The token deliberately never reaches the content script. A content script
 * shares the page's DOM with Instagram, so anything it holds is one XSS away
 * from being readable by the page; the worker is a different world with its own
 * fetch, and `host_permissions` is what lets it call the API cross-origin
 * without CORS in the way.
 *
 * MV3 workers are killed whenever they go idle, so nothing durable may live in
 * a module-level variable — per-thread state goes to `chrome.storage.session`.
 */

import {
  chat,
  checkToken,
  outreach,
  sweepFollowups,
  listFollowups,
  ackFollowup,
  inboundMedia,
  fireTrigger,
  comment,
  commentReply,
  MODES,
  followupBubbles,
  FluidTalkError,
} from "./lib/fluidtalk.js";
import {
  loadStore,
  loadSettings,
  saveSettings,
  missingConfig,
  followupStages,
  platformConfigured,
  configuredPlatforms,
  setConfigured,
  handleOn,
  rememberHandle,
  exportPreset,
  validatePreset,
  applyPreset,
  listPresets,
  savePreset,
  deletePreset,
  pickFleetPreset,
  scheduleState,
} from "./lib/settings.js";
import { PLATFORMS, platformForUrl, platformById, platformNames, routeFor, supports } from "./lib/platforms.js";

const LOG_KEY = "fluidextension.log";
const REPLIED_KEY = "fluidextension.replied";
/**
 * Sixty lines was one platform's worth. Three run at once now and interleave,
 * so a live debugging run held about a minute of history — short enough that a
 * send scrolled away before it could be read.
 */
const LOG_LIMIT = 250;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  healOrphanedTabs("the extension was updated or reloaded");
});

// A browser restart re-creates the tabs from the session but not the content
// scripts inside them, so the same repair is owed here.
chrome.runtime.onStartup.addListener(() => healOrphanedTabs("the browser restarted"));

/**
 * The repair has to survive `chrome.runtime.reload()`, which fires NEITHER of
 * the hooks above — and that is the case this exists for, because reloading the
 * extension from `chrome://extensions` is exactly how a developer orphans every
 * content script.
 *
 * The worker's top level is not enough on its own: an MV3 worker is torn down
 * whenever it is idle, so this file runs many times an hour and almost none of
 * those are a new extension. The two are told apart by `storage.session`, which
 * is cleared when the EXTENSION restarts and survives a mere worker wake —
 * the same property that wipes the reply map. An absent flag therefore means a
 * generation of the extension that has not repaired its tabs yet.
 */
const GENERATION_KEY = "fluidextension.generation";

/**
 * THE FLEET FILE — one config for every browser profile that shares this
 * extension folder.
 *
 * An anti-detect browser (AdsPower and the like) runs many Chromium profiles,
 * each with its own `storage.local`, so there is nothing shared to configure —
 * except the unpacked extension folder itself, which they all load from. A
 * `presets.json` dropped in there is readable by every profile, and is the only
 * medium a fleet actually has in common.
 *
 * IT IS AUTHORITATIVE AND RE-APPLIED ON EVERY LAUNCH, at the owner's choice:
 * a rate cap changed centrally has to land on all fifty profiles, and a profile
 * that kept a hand-tweaked value would be the one that quietly does not. Local
 * edits therefore survive only until the next launch, which the panel says out
 * loud rather than leaving to be discovered.
 *
 * ABSENT IS THE NORMAL CASE. Most installs are one browser, and a missing file
 * means "not a fleet" — not an error, and nothing is logged about it.
 */
const FLEET_FILE = "presets.json";
const FLEET_STATE = "fluidextension.fleet";

/**
 * ABSENT AND BROKEN ARE DIFFERENT ANSWERS, and telling them apart is the whole
 * job of this function.
 *
 * Most installs are one browser with no fleet file at all — that is not an
 * error and must stay silent. A file that EXISTS and does not parse is the
 * opposite: fifty profiles are about to run on last launch's settings and
 * nobody would know unless it is said out loud.
 *
 * Chrome REJECTS `fetch` for a package file that is not there rather than
 * answering 404, so the two cases arrive as the same exception. They are
 * separated by reading the bytes first and parsing second: anything that fails
 * before we have text is "no fleet here"; a parse failure after is a real one.
 */
async function readFleetFile() {
  let text;
  try {
    const res = await fetch(chrome.runtime.getURL(FLEET_FILE));
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return { __error: err.message };
  }
}

async function fleetState() {
  return (await chrome.storage.session.get(FLEET_STATE))[FLEET_STATE] ?? null;
}

/**
 * Apply the fleet file, if there is one. Fails CLOSED.
 *
 * A malformed file does not break one browser — it would overwrite the working
 * configuration of every profile in the fleet at the same moment, unattended
 * and out of hours. So nothing is applied unless it validates whole, and a
 * refusal leaves the profile exactly as it was.
 */
async function applyFleetConfig(why, { handle = null } = {}) {
  const fleet = await readFleetFile();
  if (!fleet) return null;
  if (fleet.__error) {
    await log("error", `fleet config (${FLEET_FILE}) is not valid JSON — keeping the current settings: ${fleet.__error}`);
    await chrome.storage.session.set({ [FLEET_STATE]: { error: fleet.__error, at: Date.now() } });
    return null;
  }

  const chosen = pickFleetPreset(fleet, { handle });
  if (!chosen) {
    await log("error", `fleet config has no preset for this profile — keeping the current settings`);
    await chrome.storage.session.set({ [FLEET_STATE]: { error: "no preset matched", at: Date.now() } });
    return null;
  }
  const check = validatePreset(chosen);
  if (!check.ok) {
    await log("error", `fleet preset "${chosen.name ?? "?"}" is not usable, keeping the current settings: ${check.errors.join("; ")}`);
    await chrome.storage.session.set({ [FLEET_STATE]: { error: check.errors.join("; "), name: chosen.name, at: Date.now() } });
    return null;
  }

  await applyPreset(check.preset);
  await chrome.storage.session.set({
    [FLEET_STATE]: { name: check.preset.name, at: Date.now(), handle, why },
  });
  await log("info", `fleet config applied: "${check.preset.name}"${handle ? ` (for @${handle})` : ""} — ${why}`);
  return check.preset;
}

/**
 * THE SECOND STAGE, once we know which account this profile is signed in to.
 *
 * At launch the handle is unknown — no page has loaded — so the first pass can
 * only apply the fleet DEFAULT. A fleet running different characters keys its
 * presets by account handle, and that row can only be chosen once the adapter
 * has read the page. Re-applied then, and only if it resolves to a DIFFERENT
 * preset, so the ordinary one-preset fleet costs nothing.
 *
 * Not while a run is going: applying rebinds, and rebinding mid-sweep moves the
 * run onto another account mid-conversation — the same reason the panel refuses
 * it. It lands at the next launch instead.
 */
async function applyFleetForHandle(handle) {
  if (!handle) return;
  const state = await fleetState();
  if (!state || state.error) return;
  if (state.handle === handle) return;

  const fleet = await readFleetFile();
  if (!fleet || fleet.__error) return;
  const chosen = pickFleetPreset(fleet, { handle });
  if (!chosen || chosen.name === state.name) {
    // Same preset, nothing to do — just record that we now know the handle so
    // this does not re-run on every detection.
    await chrome.storage.session.set({ [FLEET_STATE]: { ...state, handle } });
    return;
  }
  if ((await sweepState()).running) {
    await log("info", `fleet: @${handle} wants preset "${chosen.name}" — applying after the run stops`);
    return;
  }
  await applyFleetConfig(`@${handle} signed in`, { handle });
}

(async () => {
  const { [GENERATION_KEY]: seen } = await chrome.storage.session.get(GENERATION_KEY);
  if (seen) return;
  await chrome.storage.session.set({ [GENERATION_KEY]: Date.now() });
  // BEFORE the tabs are healed and before anything can act: a profile must not
  // answer a single message on last launch's settings.
  await applyFleetConfig("the extension started");
  await healOrphanedTabs("the extension was restarted");
})();

/**
 * Put the content script back into tabs that lost it, without being asked.
 *
 * INSTALLING, UPDATING OR RELOADING THE EXTENSION ORPHANS EVERY CONTENT SCRIPT
 * ALREADY INJECTED. The page carries on looking completely normal — Instagram
 * still scrolls, the DMs are still there — while nothing in it can be reached
 * any more, so the platform simply goes quiet. The panel used to surface this
 * as "needs reload" and leave it to the user, which is a chore the extension is
 * in a better position to do: it knows exactly which tabs it just orphaned, and
 * it knows the moment it happened.
 *
 * A RELOAD, NOT A RE-INJECTION. `chrome.scripting.executeScript` would be
 * cheaper and would spare WhatsApp its re-sync — but nothing here guards
 * against being loaded twice. Only `media.js` does. A second copy of an adapter
 * registers a second `onMessage` listener and a second MAIN-world `fetch` patch
 * on top of the first, and the Instagram one REWRITES REQUEST BODIES, so
 * double-wrapping it risks corrupting what the page sends. Re-injection is the
 * better answer once those scripts are idempotent; until then a reload is the
 * honest one.
 *
 * Errors are swallowed per tab on purpose: this runs at startup for every
 * platform at once, and one closed tab must not stop the others being repaired.
 */
/**
 * Reload one unreachable tab — backing off hard when reloading does not help.
 *
 * A cooldown is needed at all because `ft:platforms` is a POLL: the panel asks
 * repeatedly, a page takes seconds to come back, and every poll in that window
 * still sees an unreachable tab. Without a gate each one fires another reload
 * and the page never finishes loading — a repair that prevents the recovery it
 * is trying to cause.
 *
 * ⚠ BUT A FLAT COOLDOWN IS WRONG, AND DANGEROUSLY SO. From the worker, a tab
 * whose content script was orphaned and a tab showing Chrome's error page look
 * IDENTICAL: both simply fail to answer. Content scripts cannot run on
 * `chrome-error://chromewebdata/`, and the tabs API still reports the original
 * URL, so there is nothing to tell them apart by. Measured here — the Instagram
 * tab was not orphaned at all:
 *
 *     heading   "This page isn't working right now"
 *     errorCode "HTTP ERROR 429"
 *
 * Instagram was RATE-LIMITING us. Reloading that every minute is precisely the
 * behaviour that deepens a rate limit, on the account the product depends on.
 *
 * So the schedule does the telling-apart instead of a test. An orphaned script
 * is cured by the FIRST reload and never comes back here. Anything still
 * unreachable afterwards was not an orphaned script, so each further attempt
 * waits twice as long — 1, 2, 4, 8 minutes, capped — which fixes the common
 * case at once and leaves a rate limit alone. `noteReachable` clears the count
 * so a tab that recovers starts fresh.
 */
const HEAL_BASE_MS = 60_000;
const HEAL_MAX_MS = 16 * 60_000;
const healAttempts = new Map();

function noteReachable(tabId) {
  healAttempts.delete(tabId);
}

/**
 * Bring a tab back — by NAVIGATING it, not by reloading it.
 *
 * ⚠ RELOADING CANNOT FIX THE COMMONEST CASE. A reload re-requests the URL the
 * tab is already on, and when that URL is what the site is refusing, the answer
 * is the same refusal every time. Measured here, stuck exactly like this:
 *
 *     tab  https://www.instagram.com/p/CxxxxxxxxxX/
 *     doc  chrome-error://chromewebdata/   HTTP ERROR 429
 *
 * Instagram was rate-limiting that post. The repair reloaded it, got another
 * 429, and the tab sat on an error page through every retry — which is the
 * "stuck asking to be reloaded" the user saw. Sending the same tab to
 * `/direct/inbox/` came back `ready: true` immediately, with no other change.
 *
 * So a repair goes to the page the product actually works from: a DIFFERENT
 * request rather than a retry of the one being refused, and it also rescues a
 * tab that simply wandered somewhere unworkable. Falls back to a plain reload
 * only when the tab is already there, where the two are the same thing anyway.
 */
/**
 * Put the adapter back into a tab WITHOUT reloading the page.
 *
 * An extension reload orphans every content script already injected, and the
 * only repair used to be a page load. On WhatsApp that is brutally expensive:
 * a reload costs a FULL HISTORY RE-DOWNLOAD — "Don't close this window. Your
 * messages are downloading." — measured at 3s to 99s, during which the store
 * honestly answers ZERO chats, so a cycle reads an empty inbox and does
 * nothing. Telegram pays a slower boot for the same reason. Instagram pays it
 * in requests against a site that answers 429 when pushed.
 *
 * None of that is necessary to get the adapter back: `chrome.scripting` can
 * inject it into the live page. It works here because NO adapter file depends
 * on running at `document_start` — Instagram's MAIN-world script patches the
 * page's `fetch` whenever it runs, Telegram's is an on-demand byte reader, and
 * WhatsApp's resolves its modules lazily precisely because the bundle has not
 * evaluated at document_start. Late injection is therefore the same script in
 * the same worlds, just later.
 *
 * The blocks come from the MANIFEST rather than a second list here, so the
 * files, their ORDER and their `world` cannot drift from what Chrome injects
 * normally.
 *
 * Returns false rather than throwing: every caller's fallback is the old
 * reload, and a repair that explodes is worse than one that declines.
 */
async function reinjectAdapter(target) {
  const { tab, platform } = target;
  try {
    const blocks = (chrome.runtime.getManifest().content_scripts ?? []).filter((cs) =>
      (cs.matches ?? []).some((m) => m.startsWith(platform.origin)),
    );
    if (!blocks.length) return false;
    for (const cs of blocks) {
      if (!cs.js?.length) continue;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: cs.js,
        world: cs.world === "MAIN" ? "MAIN" : "ISOLATED",
        injectImmediately: true,
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function reviveTab(target, attempt = 0) {
  const { tab, platform } = target;
  const to = routeFor(platform, "inbox") ?? routeFor(platform, "home");

  // LAST RESORT: A TAB CAN REACH A STATE NO NAVIGATION CLEARS. Measured on
  // WhatsApp — the page rendered, the content script loaded and logged
  // "adapter ready", and yet every single `ft:*` message went unanswered,
  // including ones that only hit a synchronous `default:` branch. Navigating
  // it and reloading it changed nothing. CLOSING the tab and opening a new one
  // answered `{ready: true}` in ONE MILLISECOND.
  //
  // The same thing is already written down for Telegram, whose shared workers
  // survive a reload and only go when the last client does; WhatsApp runs a
  // service worker and shared workers too, so it is the same shape of fault.
  // Without this step the repair loops on a tab it can never fix.
  if (attempt >= 2 && to) {
    const winId = tab.windowId;
    await chrome.tabs.remove(tab.id);
    const fresh = await chrome.tabs.create({ url: to, windowId: winId, active: false });
    target.tab = fresh;
    return `a new tab at ${to}`;
  }

  const here = (tab.url ?? "").split("#")[0];
  if (to && here !== to) {
    await chrome.tabs.update(tab.id, { url: to });
    return to;
  }

  // THE TAB IS ALREADY WHERE IT BELONGS — only our adapter is missing, which
  // is the whole of what an extension reload breaks. Put it back in place
  // first and only load the page if that did not take. Proof is the same
  // readiness probe that condemned the tab, so this can never report a repair
  // it did not achieve.
  if (await reinjectAdapter(target)) {
    const probe = await probeReady(target);
    if (probe.alive) return "re-injected without reloading it";
  }

  await chrome.tabs.reload(tab.id);
  return here || "the same page";
}

function healTabSoon(target) {
  const id = target.tab.id;

  // ⚠ A TAB IN THE MIDDLE OF A NAVIGATION IS NOT A BROKEN TAB. Its content
  // script is genuinely gone for a moment, which looks exactly like the fault
  // this repairs — and the sweep navigates constantly (inbox → requests →
  // thread). Measured live: the panel poll landed during the requests pass
  // three times in 27 seconds and yanked the tab back to the inbox each time,
  // so Instagram never finished a single cycle.
  if (target.tab.status === "loading") return;

  // And never while the sweep is driving this platform. It has its own repair
  // in `ensureAlive`, which runs between steps where it is safe; healing from
  // a status poll mid-step pulls the page out from under whatever the run is
  // doing — the same one-tab-two-drivers fault `platformBusy` exists to stop.
  if (platformBusy.has(target.platform.id)) return;

  const state = healAttempts.get(id) ?? { n: 0, at: 0 };
  const wait = state.n === 0 ? 0 : Math.min(HEAL_BASE_MS * 2 ** (state.n - 1), HEAL_MAX_MS);
  if (Date.now() - state.at < wait) return;
  healAttempts.set(id, { n: state.n + 1, at: Date.now() });

  const note =
    state.n === 0
      ? `${target.platform.label}: its tab cannot be reached — putting the adapter back automatically`
      : `${target.platform.label}: still unreachable after ${state.n} attempt(s) — the site may be refusing us ` +
        `(Instagram answers HTTP 429 when it is rate-limiting). Trying once more, then leaving it for ` +
        `${Math.round(Math.min(HEAL_BASE_MS * 2 ** state.n, HEAL_MAX_MS) / 60000)} min.`;
  log(state.n === 0 ? "info" : "error", note)
    .then(() => reviveTab(target, state.n))
    .catch(() => {});
}

/**
 * SINGLE-FLIGHT, because more than one trigger can be right at once.
 *
 * `onInstalled` does fire for an unpacked `chrome.runtime.reload()`, and so
 * does the session-flag path above — and they start together, so both probe
 * the same tabs before either has reloaded anything. Measured: Instagram was
 * reloaded twice by one extension reload. Harmless for a cheap page and not
 * harmless at all just after that same site answered HTTP 429.
 */
let healing = null;

function healOrphanedTabs(why) {
  if (healing) return healing;
  healing = runHeal(why).finally(() => {
    healing = null;
  });
  return healing;
}

async function runHeal(why) {
  for (const platform of PLATFORMS) {
    try {
      const tabs = await chrome.tabs.query({ url: `${platform.origin}/*` });
      for (const tab of tabs) {
        const probe = await probeReady({ tab, platform });
        if (probe.alive) continue;
        // Counts as the FIRST attempt in the shared backoff, so the panel path
        // cannot immediately reload the same tab again — and so a tab that is
        // unreachable for some other reason starts backing off from here.
        healAttempts.set(tab.id, { n: 1, at: Date.now() });
        await log("info", `${platform.label}: ${why} — bringing its tab back so it can be driven again`);
        await reviveTab({ tab, platform });
      }
    } catch {
      // The tab went away, or the platform has none open. Neither is a fault.
    }
  }
}

/**
 * The heartbeat that makes "runs until you stop it" survive the worker dying.
 *
 * An MV3 worker is torn down when idle, and the run is a plain async loop living
 * inside it — so if the worker goes, the loop goes with it while
 * `storage.session` still says `running: true`. The panel would show a run that
 * no longer exists, which is the worst of both: it looks like it is watching and
 * it is not.
 *
 * In practice the loop's own waiting keeps the worker up (`abortableSleep`
 * touches storage every 250ms, and each extension API call resets the idle
 * timer), so this should never fire. That is exactly why it is here: the case it
 * covers is the one nobody sees coming — a crash, an update, a browser deciding
 * otherwise — and an alarm is the one timer Chrome will restart the worker for.
 *
 * `lastTick` is what tells a live loop from a dead flag. A run that claims to be
 * running but has not ticked in three minutes is not running.
 */
const HEARTBEAT = "fluidextension.heartbeat";
const TICK_STALE_MS = 3 * 60_000;

/**
 * Which platforms have a loop running IN THIS WORKER INSTANCE?
 *
 * THE ONLY HONEST ANSWER TO "IS IT ALIVE". `lastTick` cannot give it: the
 * stamp is written inside `abortableSleep`, so it refreshes while the loop
 * WAITS and goes stale while the loop WORKS — and the work is the slow part.
 * A single Instagram cycle spends minutes in FluidTalk generations, page
 * reads and photo uploads without sleeping, so a perfectly healthy run went
 * stale and the watchdog started a second one on top of it. Measured: two
 * resumes in four minutes, the two loops then fighting over the same tab
 * ("no FluidExtension on this tab" while the other was mid-navigation).
 *
 * Module state is exactly the right signal because it dies with the worker.
 * Alive here ⇒ the loop is genuinely running and must not be duplicated;
 * missing ⇒ the worker really was torn down and the stored `running: true` is
 * a flag left behind, which is the case this watchdog exists for.
 */
const sweepLoopAlive = new Set();

chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT) return;
  (async () => {
    // THE SCHEDULE RIDES THIS ALARM RATHER THAN BRINGING ITS OWN.
    //
    // A minute is already the finest granularity Chrome gives an extension
    // alarm, which is exactly the granularity a schedule written in HH:MM
    // needs — and this alarm is the one thing in the extension Chrome will
    // restart a dead worker FOR. A second timer would have had to solve the
    // same problem again and could only drift out of step with this one.
    //
    // Before the resume check below, because the two are about different
    // things: this decides whether a run should exist at all, that one
    // notices a run that thinks it still does.
    await tickSchedule().catch((err) => log("error", `schedule tick failed: ${err.message}`));

    const s = await sweepState();
    if (!s.running || s.stopping) return;
    // Alive in this instance: nothing to resume, and say so by keeping the
    // stamp fresh — otherwise the panel shows a run that looks stuck whenever
    // a cycle takes longer than the staleness window.
    if (sweepLoopAlive.size > 0) {
      await chrome.storage.session.set({ [SWEEP_KEY]: { ...s, lastTick: Date.now() } });
      return;
    }
    if (Date.now() - (s.lastTick ?? 0) < TICK_STALE_MS) return;
    await log("error", "the run stopped ticking (the worker was probably restarted) — resuming");
    // ⚠ WHICH PLATFORM, explicitly. `runSweep()` used to be called with no
    // argument here, which reaches `platformLoop(undefined)` — and that asks
    // whether `undefined` is set up, decides it is not, and exits. So the
    // watchdog logged "resuming" and then quietly ended the run it was
    // resuming. The platform is in the state the dead loop left behind.
    const id = s.platforms?.[0] ?? (await boundPlatformId());
    if (!id) return;
    // Clear the flag first: runSweep refuses to start while one is "running",
    // and the whole point here is that this one is not.
    await setSweep({ running: false });
    runSweep(id).catch((err) => log("error", `resume failed: ${err.message}`));
  })();
});

// ── log ──────────────────────────────────────────────────────────────────────

/**
 * Append to the panel's activity log.
 *
 * This is the product's own account of what it did to a real Instagram account,
 * so it records refusals and silent outcomes too — "replied 0 times" and "never
 * ran" are different facts and the log is the only place they are told apart.
 */
async function log(level, message, detail) {
  const { [LOG_KEY]: entries = [] } = await chrome.storage.session.get(LOG_KEY);
  entries.unshift({ at: Date.now(), level, message, detail });
  await chrome.storage.session.set({ [LOG_KEY]: entries.slice(0, LOG_LIMIT) });
  chrome.runtime.sendMessage({ type: "ft:log-changed" }).catch(() => {});
}

async function readLog() {
  const { [LOG_KEY]: entries = [] } = await chrome.storage.session.get(LOG_KEY);
  return entries;
}

// ── talking to the page ──────────────────────────────────────────────────────

/**
 * THE BOUND PLATFORM — the one account this extension works.
 *
 * Exactly one platform can be bound at a time (see `setConfigured`), and bound
 * is the WHOLE answer to "which platform are we on". Everything — the sweep,
 * the auto-reply watcher, follow-ups, the budgets, every panel button — is
 * about that one.
 *
 * ⚠ IT USED TO BE CHOSEN BY FOCUS, and that is gone. Several platforms could be
 * set up at once, so the extension had to pick between them, and it did it by
 * remembering the last platform tab you focused — sticky, kept in
 * `chrome.storage.session`, refused mid-run, announced to the panel. With
 * binding exclusive there is nothing left to choose: the user names the account
 * by binding it. Deriving it from focus as well would mean the working platform
 * could change without anybody binding anything, which is precisely what an
 * explicit bind exists to prevent.
 *
 * So this reads the store, and the store is the only place it lives.
 */
async function boundPlatformId() {
  return configuredPlatforms(await loadStore())[0] ?? null;
}

/**
 * The bound platform and one of its tabs — or null.
 *
 * Every caller that passes no explicit `target` means "the platform I am
 * working", and this is that. Resolved through `targetFor`, so the tab is found
 * ANYWHERE in the browser rather than having to be the one in front: that is
 * what lets the panel's own buttons work while the panel itself has focus, and
 * what lets a run carry on while the user reads something else.
 */
async function boundTarget() {
  const id = await boundPlatformId();
  return id ? targetFor(id) : null;
}


/**
 * A named platform and one of its tabs — ANYWHERE in the browser.
 *
 * Addressed by URL rather than by focus, which is what lets the panel's own
 * buttons work while the panel itself is in front and lets a run carry on while
 * the user reads something else. Resolving the tab from focus instead served
 * one platform at a time and died if the user switched tabs mid-reply (seen
 * live: "auto-reply failed: the active tab is not Instagram, Telegram or
 * WhatsApp"). A background tab was measured reading, typing and SENDING
 * perfectly well.
 *
 * Tabs are matched on the platform's own `origin`, so Telegram's `/k` path is
 * respected and the Z client is not picked up by mistake.
 */
async function targetFor(platformId) {
  const platform = platformById(platformId);
  if (!platform) return null;
  const tabs = (await chrome.tabs.query({ url: `${platform.origin}/*` })).sort((a, b) => a.id - b.id);
  if (!tabs.length) return null;
  // The oldest tab wins, so repeated calls keep landing on the same one rather
  // than alternating between two.
  if (tabs.length === 1) return { tab: tabs[0], platform };

  // WITH SEVERAL OPEN, OLDEST IS THE WRONG RULE. Age says nothing about whether
  // a tab can be worked, and both ways it can fail were live here at once:
  // Instagram's oldest tab was parked on a POST page, where the DM adapter has
  // nothing to drive, and Telegram's was a background tab in a window fronted
  // by something else — so its SPA never booted and its chat list stayed empty.
  // The run then reports an empty inbox for ever while a perfectly good tab of
  // the same platform sits one window over.
  //
  // Only probed when there IS a choice, so the ordinary one-tab-per-platform
  // case costs nothing.
  //
  // ⚠ EXCEPT A SUSPENDED TAB, WHICH CANNOT ANSWER — SO PROBING IT COSTS THE
  // WHOLE DEADLINE. Edge's Sleeping Tabs (and Chrome's own freezing) park an
  // idle background tab with `frozen: true`: it keeps its title and its url,
  // reports `status: "complete"`, is NOT `discarded`, and its page renders
  // perfectly over CDP — the only thing that changes is that its content
  // script no longer runs, so `chrome.tabs.sendMessage` never settles. That is
  // indistinguishable from an orphaned script BY PROBING, which is exactly why
  // it was expensive: measured with a duplicate Threads tab asleep, it sorted
  // first by id and every resolution paid READY_PROBE_MS before falling
  // through to a working tab — 10s per call, 30s for one `ft:get-state`, and
  // the panel does several of those per refresh. Reloading it does not help
  // either; it simply goes back to sleep.
  //
  // The flag is READABLE, so ask rather than wait. Frozen and discarded tabs
  // drop to the back rather than out: if they are all we have, the old
  // behaviour still applies and the heal path gets its chance at them.
  const awake = tabs.filter((t) => !t.frozen && !t.discarded);
  const candidates = awake.length ? awake : tabs;
  for (const tab of candidates) {
    const probe = await probeReady({ tab, platform });
    if (probe.alive && probe.ready) return { tab, platform };
  }
  return { tab: candidates[0], platform };
}

/**
 * The active platform's settings — the globals plus ITS block, flat.
 *
 * `platform` comes from the id this was resolved for and is never read from
 * storage: everything the worker sends to FluidTalk goes out under a platform,
 * FluidTalk keys a lead by (character, platform, handle), and a stale stored
 * value would file a conversation under a platform it never happened on.
 *
 * `ownUsername` needs no special handling any more. It lives in the platform's
 * own block, so asking for Instagram's settings cannot hand back a WhatsApp
 * phone number — which is what the flat store used to do the moment a WhatsApp
 * tab was touched.
 */
async function currentSettings(target = null) {
  const id = target?.platform?.id ?? (await boundPlatformId());
  return loadSettings(id);
}

/**
 * Ask a platform's page something.
 *
 * `target` is explicit wherever the caller knows which platform it is working
 * — which, once several run at once, is everywhere that matters. It falls back
 * to the active tab so the panel's own buttons still mean "the platform I am
 * looking at".
 */
/**
 * How long any single page call may take before the run gives up on it.
 *
 * A content script whose handler never calls `respond` leaves
 * `chrome.tabs.sendMessage` UNSETTLED — not rejected, not errored — so the
 * sweep stops dead behind it with nothing in the log. Measured: a Telegram
 * `ft:open-thread` waiting on an IndexedDB cursor that never completed held a
 * whole run for over five minutes while every other op on that same adapter
 * answered in under a second.
 *
 * Generous enough for the slowest honest call (a video re-encode, a send that
 * polls eighteen seconds for its own bubble), short enough that one wedged
 * adapter costs a pass rather than the day.
 */
const PAGE_CALL_TIMEOUT_MS = 120_000;

/**
 * Rejects once a stop has been asked for, so `askPage` can lose the race.
 *
 * Polls rather than listens because the flag lives in session storage and the
 * worker that set it may not be the worker reading it. `done` is how the
 * caller calls it off: without that the poller outlives every completed call
 * and each one leaves a timer hitting storage twice a second forever.
 */
async function stopWatch(done) {
  while (!done.over) {
    await sleep(500);
    if (done.over) return await new Promise(() => {});
    if (await stopRequested()) throw new Error("stopped");
  }
  return await new Promise(() => {});
}

/**
 * ⚠ A TAB CAN FALL ASLEEP MID-CALL, AND THEN THE CALL COSTS THE FULL DEADLINE.
 *
 * `probeReady` already reads `frozen` before a run touches a tab, which is
 * cheap and correct — and useless here, because Edge freezes a backgrounded tab
 * WHILE the cycle is working it. What happens then is the worst version:
 * `chrome.tabs.sendMessage` to a frozen tab never settles, so the call waits
 * out `PAGE_CALL_TIMEOUT_MS` before anything notices.
 *
 * Measured over one unattended hour: cycles 11 through 16 each opened with
 * `the browser has put this tab to sleep`, then failed on a 120-second
 * `ft:list-threads`, repaired, and hit the same wall next cycle. The run's
 * `sent` count did not move after cycle 7 — the last third of the hour was
 * nothing but timeouts and reloads.
 *
 * `frozen` is READABLE, so this polls it instead of waiting. Two seconds of
 * latency instead of a hundred and twenty, and the heal path — which already
 * knows how to cure a sleeping tab — gets to run while the cycle still has
 * time to do something useful.
 */
async function sleepWatch(tabId, done) {
  while (!done.over) {
    await sleep(2000);
    if (done.over) return await new Promise(() => {});
    const asleep = await chrome.tabs.get(tabId).then(
      (t) => Boolean(t.frozen || t.discarded),
      // Gone entirely: let the other racers report it in their own words.
      () => false,
    );
    if (asleep) throw new Error("the browser put this tab to sleep mid-call");
  }
  return await new Promise(() => {});
}

/**
 * A page mid-navigation has no content script FOR A MOMENT.
 *
 * The sweep navigates all the time — inbox, requests, a post, a thread — and
 * a call that lands in the gap gets "no FluidExtension on this tab", which is
 * indistinguishable from a genuinely orphaned script. That error aborts the
 * whole cycle: measured as `Instagram cycle 2 failed: no FluidExtension on
 * this tab` after three replies had already gone out, throwing away the rest
 * of the pass over a gap that closes by itself in under a second.
 *
 * One retry tells them apart. A navigation settles well inside this; a script
 * that is really gone answers the same way twice and the error stands.
 */
const RESETTLE_MS = 2000;

async function askPage(type, extra = {}, target = null) {
  try {
    return await askPageOnce(type, extra, target);
  } catch (err) {
    if (!/no FluidExtension/.test(err?.message ?? "")) throw err;
    await sleep(RESETTLE_MS);
    return await askPageOnce(type, extra, target);
  }
}

async function askPageOnce(type, extra = {}, target = null) {
  const here = target ?? (await boundTarget());
  if (!here) throw new Error(`the active tab is not ${platformNames()}`);
  const { tab } = here;
  const done = { over: false };
  let reply;
  try {
    reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type, ...extra }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${here.platform.label} did not answer "${type}" in ${PAGE_CALL_TIMEOUT_MS / 1000}s`)),
          PAGE_CALL_TIMEOUT_MS,
        ),
      ),
      // Stop has to cut through an IN-FLIGHT call, not only the gaps between
      // them. Every stop check in the sweep sits between steps, so a tab that
      // has wedged mid-call holds the whole run up for the full two minutes —
      // per call. Observed: Stop pressed, loops still "busy" minutes later.
      stopWatch(done),
      // A tab that falls asleep mid-call never answers — see `sleepWatch`.
      sleepWatch(tab.id, done),
    ]);
  } catch (err) {
    // A timeout is OUR message and must survive: the catch below rewrites
    // everything into "no FluidExtension on this tab", which would turn a
    // wedged handler into a reload-the-tab suggestion that fixes nothing.
    // Same for a stop: rewritten, it would read as a dead content script and
    // send ensureAlive off to reload a perfectly healthy tab on every stop.
    // A sleeping tab likewise: the heal path cures that one, and calling it an
    // orphaned script would send it to the wrong repair.
    if (/did not answer|^stopped$|put this tab to sleep/.test(err?.message ?? "")) throw err;
    // The content script is absent on a tab that was open before the extension
    // loaded — a reload injects it. Saying so beats "could not establish
    // connection", which reads like a network fault.
    throw new Error(`no FluidExtension on this tab — reload the ${here.platform.label} tab`);
  } finally {
    done.over = true;
  }
  if (!reply?.ok) throw new Error(reply?.error ?? "the page did not answer");
  return reply.result;
}

/**
 * Which account we are logged in as, read from the page and cached.
 *
 * Asked fresh every time rather than trusted from storage, because the user
 * can switch accounts in the browser and a stale handle is worse than none: it
 * makes the lead reader treat our own profile link as the lead's. The cached
 * copy exists only so the panel can show something while Instagram is not open.
 */
async function resolveOwnHandle(target = null) {
  const here = target ?? (await boundTarget());
  try {
    const who = await askPage("ft:whoami", {}, target);
    if (who?.handle) {
      // ALWAYS recorded against its platform, never only when it differs from a
      // shared field. Gating the write on a flat `ownUsername` meant a platform
      // whose handle happened to match the last one detected was never stored
      // at all — Instagram's was skipped for exactly that reason, and once
      // WhatsApp had overwritten the flat field, Instagram and Telegram both
      // started reporting a phone number.
      //
      // `rememberHandle`, not `saveSettings`: a detected handle is a fact about
      // the page, not a setup step, and must not enrol a platform the user has
      // never configured.
      // A fleet keyed by account can only pick this profile's row once we know
      // which account it is, and this is the moment we learn it.
      await applyFleetForHandle(who.handle).catch(() => {});
      if (here && handleOn(await loadStore(), here.platform.id) !== who.handle) {
        await rememberHandle(here.platform.id, who.handle);
        // `via` is Instagram's account-detection route and does not exist on
        // every adapter — printing it unconditionally put "(detected undefined)"
        // in the Telegram log, which reads like a detection failure when the
        // handle right beside it is correct.
        await log(
          "info",
          `signed in to ${here.platform.label} as ${who.handle}${who.via ? ` (detected ${who.via})` : ""}`,
        );
      }
      return who.handle;
    }
  } catch {
    // Not on a supported tab — fall through to whatever we last saw THERE.
  }
  // Scoped to the platform when we know it: handing back another platform's
  // handle is worse than handing back nothing, because it is sent onward as
  // `own_username` and reads as a real answer.
  return here ? handleOn(await loadStore(), here.platform.id) : "";
}

// ── replying ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DRAFT_KEY = "fluidextension.drafts";

/**
 * Drafts already generated, keyed by thread + the exact message they answer.
 *
 * FluidTalk's duplicate guard counts DELIVERIES BY US, not messages from the
 * lead: posting one inbound text three times gets the third suppressed, and
 * "any different message resets it". So a second Generate on the same message
 * is not free — it spends one of two attempts, and a third permanently silences
 * that message until the lead says something new. Re-showing the draft we
 * already hold costs nothing and cannot burn the allowance.
 */
async function cachedDraft(threadId, inbound) {
  const { [DRAFT_KEY]: map = {} } = await chrome.storage.session.get(DRAFT_KEY);
  const row = map[`${threadId}::${inbound}`];
  return row ?? null;
}

async function cacheDraft(threadId, inbound, bubbles) {
  const { [DRAFT_KEY]: map = {} } = await chrome.storage.session.get(DRAFT_KEY);
  map[`${threadId}::${inbound}`] = { bubbles, at: Date.now() };
  await chrome.storage.session.set({ [DRAFT_KEY]: map });
}

/**
 * What identifies the message we last answered — NOT its text.
 *
 * Every media message has an empty text, so a photo and a sticker compare
 * EQUAL and the second is silently treated as already answered. Measured
 * exactly that way: the photo was answered, a sticker arrived, and the run
 * skipped it with no log line at all — indistinguishable from an inbox with
 * nothing new in it.
 *
 * Telegram gives every message a `data-mid`. Instagram gives none, and already
 * solves the same collision inside its own reader by keying a photo on its URL.
 * Same ladder here, best identifier first.
 */
function messageKey(m) {
  if (m?.id) return `id:${m.id}`;
  if (m?.imageUrl) return `img:${m.imageUrl}`;
  return m?.text ?? "";
}

/** Remember what we last answered per thread, so one message gets one reply. */
async function alreadyReplied(threadId, message) {
  const { [REPLIED_KEY]: map = {} } = await chrome.storage.session.get(REPLIED_KEY);
  return map[threadId] === messageKey(message);
}

async function markReplied(threadId, message) {
  const { [REPLIED_KEY]: map = {} } = await chrome.storage.session.get(REPLIED_KEY);
  map[threadId] = messageKey(message);
  await chrome.storage.session.set({ [REPLIED_KEY]: map });
}

/**
 * Generate a reply for the thread currently on screen.
 *
 * Refuses when there is no inbound message to answer. That is the reply-only
 * guarantee: with no message from them there is nothing to reply TO, and
 * generating anyway would be an opener — a different product with a different
 * risk profile.
 */
async function generate({ force = false, target = null } = {}) {
  const settings = await currentSettings(target);
  const missing = missingConfig(settings);
  if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
  const ownHandle = await resolveOwnHandle(target);
  if (!ownHandle) throw new Error(`could not tell which account is signed in — open ${platformNames()}`);
  settings.ownUsername = ownHandle;

  const thread = await readThread(ownHandle, target);
  if (!thread.ok) throw new Error(`no conversation on screen (${thread.reason})`);
  if (!thread.handle) throw new Error("could not read the lead's handle from the thread header");
  if (!thread.lastInbound) {
    throw new Error("the last message in this thread is ours — nothing to reply to");
  }
  // Media Instagram will not render here. The bytes genuinely do not reach a
  // browser (checked on desktop AND a mobile user-agent), so there is nothing
  // to look at — but the FACT that something arrived is true and worth telling
  // the character, or the conversation simply stalls.
  //
  // Measured, and the phrasing is not cosmetic: a terse THIRD-PERSON event
  // phrase ("sent a disappearing photo") is answered naturally — "i didn't even
  // get to see it! what was it, a secret?" — while anything explanatory
  // ("sent you a photo but it's view-once...") is read as the LEAD talking and
  // earns "i'm not going to keep explaining this". Short and event-shaped, like
  // Instagram's own "sent an attachment".
  //
  // NAMED PER KIND, because Telegram says which it is. Seven kinds used to be
  // described identically as "sent an attachment" — a voice note, a song, a
  // file, a poll, a location and a shared contact are all different events, and
  // a character who answers all six the same way is transparently not looking.
  const UNREADABLE_AS = {
    view_once: "sent a disappearing photo",
    round: "sent a video message",
    voice: "sent a voice message",
    audio: "sent a song",
    document: "sent a file",
    poll: "sent a poll",
    location: "shared their location",
    contact: "shared a contact",
    game: "sent a game",
    unsupported: "sent an attachment",
  };
  /**
   * A message with no words, but something we CAN show. A photo needs no
   * caption — the picture is the message, and Instagram already sends an empty
   * string with an image for exactly that. A sticker is different: it carries
   * meaning the model cannot read off the image alone, so it is named.
   *
   * Like the unreadable phrases below, this is recorded by FluidTalk as the
   * LEAD's message. It is a truthful description of an event rather than
   * invented speech — the same bargain, and worth knowing it is being made.
   */
  const MEDIA_AS = { sticker: "sent a sticker" };

  let inboundText = thread.lastInbound.text;
  if (!inboundText && MEDIA_AS[thread.lastInbound.kind]) {
    inboundText = thread.lastInbound.imageAlt
      ? `${MEDIA_AS[thread.lastInbound.kind]} ${thread.lastInbound.imageAlt}`
      : MEDIA_AS[thread.lastInbound.kind];
  }
  if (thread.lastInboundUnreadable) {
    // An unknown kind still falls back to the generic phrase — a new Telegram
    // media type must not turn into a thrown error on a live thread.
    const described =
      settings.describeUnreadable &&
      (UNREADABLE_AS[thread.unreadableKind] ?? UNREADABLE_AS.unsupported);
    if (!described) {
      throw new Error(
        `their last message is one ${platformById(settings.platform)?.label ?? "this app"} will not show on the web — open it in the app to read it`,
      );
    }
    // NOTE: this is recorded by FluidTalk as the LEAD's message. It is a
    // truthful description of an event, not invented speech, but it is not
    // their words either — which is why it is a setting and not a default
    // buried in the code.
    inboundText = described;
    await log("info", `${thread.handle}: unopenable ${thread.unreadableKind} — telling the character "${described}"`);
  }
  if (!force && (await alreadyReplied(thread.threadId, thread.lastInbound))) {
    return { skipped: "already replied to this message", thread };
  }

  // Hand back the draft we already have for this exact message rather than
  // asking again. `force` does NOT override this: the thing it was for —
  // re-answering a thread — is served by the cache just as well, and asking
  // twice is what silenced lead_c.
  const cached = await cachedDraft(thread.threadId, inboundText);
  if (cached) {
    return { thread, bubbles: cached.bubbles, cached: true, sessionId: cached.sessionId };
  }

  /**
   * The picture to answer, taken from the whole UNANSWERED RUN — not just the
   * last message.
   *
   * People send a picture and then talk about it: sticker, then "you know this
   * guy?". Reading only `lastInbound` gives the words and drops the image, so
   * the character is asked to identify somebody she was never shown and
   * answers around it — fluently, which is what hides it. Measured on a real
   * Telegram thread; the same shape happens on Instagram.
   *
   * Bounded by our own last message: anything older than that has been replied
   * to already, and dragging an old photo into a new turn would be worse than
   * missing a new one.
   */
  const since = [];
  for (let i = (thread.messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (thread.messages[i].side !== "in") break;
    since.unshift(thread.messages[i]);
  }
  const pictured = [...since].reverse().find((m) => m.imageUrl) ?? null;

  // THEY SENT A PICTURE AND WE COULD NOT GET IT. Said out loud, because the
  // alternative is the failure that has now cost two rounds on WhatsApp: a
  // video, then a photo, each reaching the character as nothing at all while
  // every log line looked healthy. Nothing FAILS in that shape — `imageUrl` is
  // simply never set — so the only trace is a reply that reads fine and quietly
  // answers a picture nobody saw. An adapter that knows why says so in
  // `mediaError`; one that does not still gets named here.
  const blind = [...since].reverse().find((m) => m.hasMedia && !m.imageUrl) ?? null;
  if (blind && blind !== pictured) {
    await log("error", `${thread.handle}: could NOT read their ${blind.kind ?? "media"} — ${blind.mediaError ?? "no reason given"}`);
  }

  // A photo they sent has to be re-hosted before the model can see it.
  let imageUrl;
  let imageMime;
  let imageFlattened = false;
  if (pictured?.imageUrl) {
    try {
      // BY ID, not by reference. `thread` crosses `chrome.tabs.sendMessage`,
      // which structured-clones it — so `thread.messages[i]` and
      // `thread.lastInbound` are different OBJECTS even when they are the same
      // message, and `!==` was therefore always true. The line then announced
      // "answering their sticker sent just before ..." about a sticker that
      // WAS the last message, quoting that message's own description back at
      // itself. It only ever meant to fire for the picture-then-talk shape.
      if (pictured.id !== thread.lastInbound.id) {
        await log("info", `${thread.handle}: answering their ${pictured.kind ?? "photo"} sent just before "${inboundText.slice(0, 30)}"`);
      }
      ({ url: imageUrl, mime: imageMime, flattened: imageFlattened } = await hostInboundPhoto(settings, pictured.imageUrl, {
        // The adapter is the only thing that knows a poster is a video.
        viaPage: pictured.kind === "video" || pictured.kind === "round" || Boolean(pictured.isVideo),
        // ...and the only thing that knows a webp is a STICKER rather than a
        // photograph: the mime cannot tell them apart, so the upload line said
        // "photo" one line above "saw the sticker".
        kind: pictured.kind,
        target,
      }));
    } catch (err) {
      // Answer anyway — a blind reply beats no reply — but say so, because the
      // API will not: an unfetchable image still returns a normal-looking turn.
      await log("error", `could not re-host their photo, replying without it: ${err.message}`);
    }
  }

  const data = await chat(settings, {
    handle: thread.handle,
    message: inboundText,
    imageUrl,
  });

  // vision.seen is the ONLY signal the picture was actually looked at. A false
  // here means the character answered a photo it never saw, in a reply that
  // reads perfectly normally.
  // Name what it actually was, INCLUDING when it was flattened. Saying "saw the
  // video" straight after "sent a still instead of the video" is the operator
  // reading two contradictory lines about one message; and "saw the photo"
  // about a video message whose `<video>` never mounted is a quiet lie, because
  // a poster still is indistinguishable from a real photo downstream.
  //
  // Decided from the BUBBLE'S KIND, not from `isVideo` and not from the shape
  // of FluidTalk's `vision.kind`. Both of those were wrong here: `isVideo` is a
  // Telegram detail the Instagram adapter has no reason to set, and the test
  // `/^video\//` never matched anything because FluidTalk answers `"video"`,
  // with no slash. Between them a real Instagram video logged as "saw the
  // photo" while the description plainly narrated motion.
  const shown = (() => {
    const kind = pictured?.kind;
    if (kind === "sticker") return imageFlattened ? "sticker's still" : "sticker";
    const wasVideo =
      Boolean(pictured?.isVideo) || kind === "video" || kind === "round" || /^video/.test(data.vision?.kind ?? "");
    if (!wasVideo) return pictured?.posterOnly ? "video's still" : "photo";
    return imageFlattened || (imageMime && !imageMime.startsWith("video/")) ? "video's still" : "video";
  })();
  if (imageUrl && data.vision && !data.vision.seen) {
    await log("error", `${thread.handle}: replied WITHOUT seeing the ${shown} (${data.vision.reason ?? "no reason"})`);
  } else if (imageUrl && data.vision?.seen) {
    await log("info", `${thread.handle}: saw the ${shown} — ${data.vision.description ?? "no description"}`);
  }

  const bubbles = data.bubbles ?? [];
  if (bubbles.length === 0) {
    // Silence is a decision FluidTalk made, and the reason is the only way to
    // tell "deduped" from "your plan is capped". It also ships a plain-English
    // `explain` for some of them — passing that through is the difference
    // between "duplicate_message" and knowing a different message resets it.
    // `silent` was MISSING from this chain, and it is the field FluidTalk
    // actually sets for the commonest case — posting the same inbound twice
    // comes back `bubbles: [], silent: "duplicate_message"`. Without it the
    // log said "no reason given" about a turn whose reason was right there in
    // the response, which is the one line an operator reads when nothing was
    // sent. Measured live on a Telegram thread.
    const why =
      data.silent ?? data.ignore_reason ?? data.pause_reason ?? (data.deduped ? "deduped" : "no reason given");
    // And `explain` is FluidTalk's own plain-English version — it was being
    // returned to the caller and thrown away by the log, which is where
    // anybody would actually look for it.
    const explain = data.explain ?? null;
    await log("info", `${thread.handle}: character stayed silent (${why})${explain ? ` — ${explain}` : ""}`);

    // ⚠ A DELIBERATE SILENCE IS AN ANSWER, so stop asking the same question.
    //
    // `markReplied` used to run only after bubbles were SENT, so a message the
    // character declined to answer stayed the newest inbound one for ever and
    // was resubmitted every cycle. Measured on a live Telegram thread: one
    // message, "Stupid?", sent to FluidTalk on all 96 cycles of a 3-hour run —
    // each time answered `duplicate_message`, each time left owed, each time
    // asked again ninety seconds later.
    //
    // Only for silences that are a decision ABOUT THIS MESSAGE, which will not
    // change on a retry. A transport failure or a missing binding throws
    // instead of landing here, so it still retries — which is what should
    // happen, because that one might succeed next time.
    await markReplied(thread.threadId, thread.lastInbound);
    return { thread, bubbles, silent: why, explain };
  }

  await cacheDraft(thread.threadId, inboundText, bubbles);
  await log("info", `${thread.handle}: generated ${bubbles.length} bubble(s)`);
  return { thread, bubbles, sessionId: data.session_id };
}

/**
 * Download an image and return it base64-encoded, with its type.
 *
 * A `blob:` url cannot be downloaded HERE. It is registered in the page that
 * created it and resolves nowhere else, so a worker fetch fails — and it fails
 * as a bare network error, which reads like the image was unavailable rather
 * than like it was never ours to fetch. Telegram serves every photo that way,
 * so those bytes come back from the page instead.
 */
async function downloadAsBase64(url, { viaPage = false, target = null } = {}) {
  // Telegram serves media as `blob:` (unfetchable here) and streams video from
  // its own service worker, so the page is the only place those bytes exist.
  //
  // `viaPage` covers the case the URL cannot reveal: an Instagram VIDEO, whose
  // url here is its POSTER — an ordinary, perfectly fetchable CDN image. Fetch
  // it and you get a still and no error, which is precisely the silent
  // downgrade this whole path exists to stop. Only the adapter knows the bubble
  // was a video, so it has to say so.
  if (viaPage || String(url).startsWith("blob:") || String(url).includes("/k/stream/")) {
    const got = await askPage("ft:media-bytes", { url }, target);
    if (!got?.ok) throw new Error(`the page could not read the media (${got?.reason ?? "no reason"})`);
    // Say when we settled for a still. A video the model could have WATCHED,
    // sent as one frame because the file was too big, is a quietly worse reply
    // — and the only place that decision is visible is here. A SHRUNK video is
    // reported too, but as a different thing: it still carries the motion.
    return {
      dataB64: got.b64,
      mime: got.mime,
      bytes: got.bytes,
      note: got.fellBackBecause ?? null,
      shrunk: got.shrunk ? { ...got.shrunk, because: got.shrunkBecause ?? null } : null,
    };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return {
    dataB64: btoa(binary),
    mime: res.headers.get("content-type") || "image/jpeg",
    bytes: buf.length,
  };
}

/**
 * Re-host a photo the LEAD sent, so the link outlives the turn.
 *
 * MEASURED, and not what was assumed: Instagram's CDN url is signed and
 * expiring (`…&oh=<sig>&oe=<exp>`), but it IS publicly fetchable while valid —
 * passing one straight to /chat returned `vision.seen: true` and a correct
 * description. So re-hosting is NOT required for the model to see the picture,
 * and any claim that it is would be wrong.
 *
 * It is still done, for the reason that survives measurement: `oe` is an
 * expiry, so the URL dies. FluidTalk keeps the image on the conversation, and a
 * transcript holding a link that 404s later is worse than one extra upload now.
 * /inbound-media returns a durable link on the owner's FluidCloud.
 */
/**
 * The file extension the stored media should carry.
 *
 * The name is not cosmetic: FluidTalk hands the bytes to Cloud, and the URL it
 * returns is what the model provider FETCHES. A webm saved as `.jpg` is asking
 * the far end to guess, and the whole reason to send video at all is that the
 * model now reads it.
 */
function mediaExtension(mime) {
  const known = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" };
  // PARAMETERS STRIPPED FIRST. A MediaRecorder blob's type carries its codecs
  // — `video/webm;codecs=vp9` — which matches no key here and fell through to
  // the `video/` catch-all, naming a webm `.mp4`. That is precisely the "asking
  // the far end to guess" this function exists to prevent.
  const base = String(mime ?? "").split(";")[0].trim().toLowerCase();
  return known[base] ?? (base.startsWith("video/") ? "mp4" : "jpg");
}

async function hostInboundPhoto(settings, cdnUrl, { viaPage = false, kind = null, target = null } = {}) {
  const { dataB64, mime, bytes, note, shrunk } = await downloadAsBase64(cdnUrl, { viaPage, target });
  if (note) await log("info", `sent a still instead of the video — ${note}`);
  if (shrunk) {
    await log(
      "info",
      `re-encoded the video to fit (${shrunk.size}${shrunk.speed > 1 ? `, ${shrunk.speed}× speed` : ""}` +
        `${shrunk.from ? `, from ${Math.round(shrunk.from / 1024)} KB` : ""}) — ${shrunk.because ?? "over the upload limit"}`,
    );
  }
  const data = await inboundMedia(settings, {
    dataB64,
    mime,
    contentType: mime,
    filename: `inbound-${Date.now()}.${mediaExtension(mime)}`,
  });
  if (!data?.url) throw new Error("inbound-media returned no url");
  await log(
    "info",
    // The adapter's word for it wins where it has one: a sticker is an
    // `image/webp`, so the mime alone calls it a photo and the operator reads
    // "uploaded a received photo" directly above "saw the sticker".
    `uploaded a received ${kind ?? (mime?.startsWith("video/") ? "video" : "photo")} (${Math.round(bytes / 1024)} KB) for vision`,
  );
  // The MIME travels back so the caller can say what was actually shown: a
  // video whose bytes ended up an `image/jpeg` frame was flattened, and only
  // this value knows it. `flattened` says whether WE reduced it to one frame —
  // which is not the same question as "is the mime a video". An Instagram
  // sticker is an ANIMATED image/webp: not video/*, and not a still either, and
  // calling it "the sticker's still" claimed we had dropped motion we had in
  // fact sent whole.
  return { url: data.url, mime, flattened: Boolean(note) };
}

/**
 * Fetch a photo and hand it to the page as bytes.
 *
 * The download happens HERE, not in the content script: the worker has
 * host_permissions and no page CSP, while a content script fetching a
 * cross-origin image from inside instagram.com is at the mercy of Instagram's
 * own policy. Bytes travel as base64 because chrome.runtime messages cannot
 * carry a Blob.
 */
async function sendPhotoBubble(bubble, target = null) {
  let res;
  try {
    res = await fetch(bubble.image_url);
  } catch (err) {
    // Almost always a missing host permission rather than a network fault: the
    // samples are served by the FRONTEND host (talk.fluidvip.com) while the API
    // lives on api-talk, and a photo from the vault comes from another host
    // again. "Failed to fetch" alone sends you looking at the network.
    let host = bubble.image_url;
    try {
      host = new URL(bubble.image_url).host;
    } catch {
      /* keep the raw value */
    }
    return {
      ok: false,
      reason: `could not download the photo from ${host} — ${err.message}. If this is a host the extension has no permission for, add it to host_permissions.`,
    };
  }
  if (!res.ok) return { ok: false, reason: `photo download failed: HTTP ${res.status}` };

  const buf = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a photo.
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }

  const mime = res.headers.get("content-type") || "image/png";
  const name = (() => {
    try {
      return new URL(bubble.image_url).pathname.split("/").pop() || "photo.png";
    } catch {
      return "photo.png";
    }
  })();

  return askPage("ft:send-photo", { dataB64: btoa(binary), filename: name, mime });
}

/**
 * Put the bubbles into the thread.
 *
 * Each one is confirmed to have appeared before the next is typed. Firing them
 * back to back would let a failed send be followed by three more into a
 * composer nobody is reading.
 */
async function sendBubbles(thread, bubbles, target = null) {
  const settings = await currentSettings(target);
  const sent = [];

  for (const [i, bubble] of bubbles.entries()) {
    const pause =
      i === 0
        ? settings.minReplyDelayMs +
          Math.random() * Math.max(0, settings.maxReplyDelayMs - settings.minReplyDelayMs)
        : (bubble.delay_ms ?? 1500);
    // Abortable so Stop lands during the pre-send wait too — that pause is
    // several seconds and is exactly when a user changes their mind.
    //
    // Say so when it fires. This returns an EMPTY result, and an empty result
    // with no log line is the one outcome that cannot be told from "nothing
    // was even attempted" — which is what a Send pressed while a stop is still
    // unwinding looks like from the panel.
    if (!(await abortableSleep(pause))) {
      await log("info", `${thread.handle}: send stopped before bubble ${i + 1} of ${bubbles.length}`);
      break;
    }

    // A photo bubble carries an image_url and an EMPTY text. It must go as a
    // PHOTO, not as a caption on the previous message — and typing "" would
    // now throw, so a missed branch here fails loudly rather than sending
    // nothing.
    const result = bubble.image_url
      ? await sendPhotoBubble(bubble, target)
      : await askPage("ft:send-bubble", { text: bubble.text, expectThreadId: thread.threadId }, target);
    sent.push({ text: bubble.text, ...result });
    if (!result.ok) {
      /**
       * SAY WHY. The adapter's reason names what it pressed, whether the box
       * still holds the text and how many bubbles were on screen — and this
       * line dropped all of it into the second argument, where the panel log
       * does not show it. "Did not appear in the thread" on its own cannot
       * distinguish a send that was accepted and never rendered from a click
       * that hit nothing, which is two days of guessing.
       */
      await log("error", `${thread.handle}: bubble ${i + 1} not confirmed — ${result.reason ?? "no reason given"}`, result);
      break;
    }
  }

  const okCount = sent.filter((s) => s.ok).length;
  if (okCount) {
    await markReplied(thread.threadId, thread.lastInbound);
    // Counted HERE, in the one place a message actually goes out, so the cap
    // reflects reality whether the send came from a sweep, auto mode or the
    // Send button. A manual send is recorded but never blocked — a human
    // choosing to answer somebody is not the burst the cap exists to prevent.
    if (thread.neverAnswered) await recordNewThread(target?.platform.id);
    await log("info", `${thread.handle}: sent ${okCount}/${bubbles.length}`);
  }
  return sent;
}

// ── the hourly cap on NEW conversations ──────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Rolling-window counters for the three things worth limiting.
 *
 * One implementation, three budgets: opening a NEW conversation, accepting a
 * message request, and cold outreach. They are separate because they are
 * different risks — answering somebody who wrote to us is not the same act as
 * messaging somebody who never did — and a single shared cap would let a burst
 * of one starve the others.
 *
 * `storage.local`, not `session`: an MV3 worker is torn down whenever it goes
 * idle, and a cap that forgets itself every few minutes is not a cap. Each read
 * prunes past the DAY window so the arrays cannot grow without bound.
 */
const COUNTERS = {
  newThread: { key: "fluidextension.newThreads", hour: "newThreadsPerHour", day: "newThreadsPerDay" },
  request: { key: "fluidextension.requests", hour: "requestsPerHour", day: "requestsPerDay" },
  outreach: { key: "fluidextension.outreach", hour: "outreachPerHour", day: "outreachPerDay" },
  comment: { key: "fluidextension.comments", hour: "commentsPerHour", day: "commentsPerDay" },
  commentReply: {
    key: "fluidextension.commentReplies",
    hour: "commentRepliesPerHour",
    day: "commentRepliesPerDay",
  },
};

/**
 * Budgets are PER PLATFORM, because the accounts are.
 *
 * One shared allowance was right while one platform ran at a time. With three
 * running at once it is actively wrong: Instagram's follow-ups would eat the
 * hourly budget and Telegram would be told "cap reached" having sent nothing.
 * The caps exist so ONE account does not look like a machine to the people
 * watching it, and nobody correlates the timing of three different accounts on
 * three different apps.
 *
 * Keyed by appending the platform, so each gets its own rolling window. The
 * legacy un-suffixed key is left alone rather than migrated: splitting one
 * history three ways would either triple-count it (every platform inheriting
 * every send) or discard it. The cost is that each platform starts with a full
 * budget once, which at three-to-five an hour is a small, one-off overspend.
 */
function counterKey(name, platformId) {
  const { key } = COUNTERS[name];
  return platformId ? `${key}.${platformId}` : key;
}

async function counterTimes(name, platformId = null) {
  const key = counterKey(name, platformId);
  const { [key]: times = [] } = await chrome.storage.local.get(key);
  const cutoff = Date.now() - DAY_MS;
  const live = times.filter((t) => t > cutoff);
  if (live.length !== times.length) await chrome.storage.local.set({ [key]: live });
  return live;
}

/**
 * How much of a budget is left. BOTH windows have to allow it, and the reported
 * `remaining` is the smaller — a caller that only looked at the hour would
 * happily blow through the day.
 */
async function quotaFor(name, settings, platformId = null) {
  const s = settings ?? (await currentSettings());
  const times = await counterTimes(name, platformId);
  const now = Date.now();
  const inHour = times.filter((t) => t > now - HOUR_MS);

  const hourLimit = s[COUNTERS[name].hour];
  const dayLimit = s[COUNTERS[name].day];
  const hourLeft = Math.max(0, hourLimit - inHour.length);
  const dayLeft = Math.max(0, dayLimit - times.length);

  return {
    usedHour: inHour.length,
    usedDay: times.length,
    hourLimit,
    dayLimit,
    hourLeft,
    dayLeft,
    remaining: Math.min(hourLeft, dayLeft),
    blockedBy: hourLeft <= dayLeft ? "hour" : "day",
    // These windows ROLL, so nothing ever "resets" wholesale: when the oldest
    // action ages out, exactly ONE slot frees. `resetsAt` is therefore when the
    // next slot comes back, not when the allowance is whole again — that is
    // `fullyResetsAt`, when the most recent action ages out. Reporting the
    // first as if it were the second would promise a full budget that is not
    // coming for another hour.
    resetsAt: inHour.length ? Math.min(...inHour) + HOUR_MS : null,
    fullyResetsAt: inHour.length ? Math.max(...inHour) + HOUR_MS : null,
    dayResetsAt: times.length ? Math.min(...times) + DAY_MS : null,
  };
}

/**
 * A cap, in words: "hourly cap 5/5" / "daily cap 30/30".
 *
 * WHICH window stopped you is the whole content of the message, and `remaining`
 * is the smaller of the two — so a run halted by the DAILY cap must not be
 * described as hourly, and a bare "(day)" does not say how close to the edge it
 * was. `blockedBy` is the only field that knows which one bit.
 */
function quotaSummary(q) {
  return q.blockedBy === "day"
    ? `daily cap ${q.usedDay}/${q.dayLimit}`
    : `hourly cap ${q.usedHour}/${q.hourLimit}`;
}

async function recordCounter(name, platformId = null) {
  const key = counterKey(name, platformId);
  const times = await counterTimes(name, platformId);
  times.push(Date.now());
  await chrome.storage.local.set({ [key]: times });
}

/** Every budget at once, for the panel. */
// The panel shows the budgets for the platform in front of you — a single
// set of numbers cannot describe three accounts, and the one the user is
// looking at is the one they mean.
async function allQuotas(platformId = null) {
  const settings = await currentSettings();
  const id = platformId ?? (await boundTarget())?.platform.id ?? null;
  return {
    platform: id,
    newThread: await quotaFor("newThread", settings, id),
    request: await quotaFor("request", settings, id),
    outreach: await quotaFor("outreach", settings, id),
    comment: await quotaFor("comment", settings, id),
    commentReply: await quotaFor("commentReply", settings, id),
  };
}

// Kept as the name the rest of the file already uses.
const newThreadQuota = (platformId = null) => quotaFor("newThread", null, platformId);
const recordNewThread = (platformId = null) => recordCounter("newThread", platformId);

// ── sweeping the inbox ───────────────────────────────────────────────────────

const SWEEP_KEY = "fluidextension.sweep";

async function sweepState() {
  const { [SWEEP_KEY]: s } = await chrome.storage.session.get(SWEEP_KEY);
  return s ?? { running: false, done: 0, skipped: 0, sent: 0, current: null, stopping: false, cycles: 0, waiting: false };
}

/** Has a stop been asked for? Read fresh — the worker may have been restarted. */
async function stopRequested() {
  return Boolean((await sweepState()).stopping);
}

/**
 * Sleep that gives up as soon as a stop is requested.
 *
 * Stop has to feel instant, and the sweep spends most of its wall clock asleep
 * — waiting for a thread to render, pausing before a reply so it does not land
 * instantly. A plain sleep makes Stop mean "in up to twenty seconds", which
 * reads as a button that does not work. Returns false if it was cut short.
 */
/**
 * How often a running loop stamps `lastTick` while it is asleep.
 *
 * `lastTick` is what tells a LIVE loop from a flag left behind by a worker that
 * died, and it was only stamped once per cycle — so during a 90-second idle,
 * and during any long cycle, a perfectly healthy run looked stale. Measured:
 * 640 seconds stale while `running: true`. The heartbeat then "resumed" a loop
 * that was never gone, and two loops driving one tab take turns opening
 * different chats — which is how a reply meant for one person gets typed into
 * somebody else's composer.
 */
const TICK_EVERY_MS = 20_000;

/**
 * Rows a platform's page has told us changed, waiting for that platform's loop
 * to pick them up.
 *
 * Module-level on purpose, exactly like `sweepLoopAlive`: this is a hint about
 * work to do NEXT, not state worth surviving a worker restart. If the worker
 * dies the hint dies with it and the ordinary sweep cycle finds the same
 * message a minute later — which is the whole reason the sweep still exists.
 */
const pendingWork = new Map();

function notePendingWork(platformId, ids) {
  if (!platformId || !ids?.length) return;
  const set = pendingWork.get(platformId) ?? new Set();
  for (const id of ids) set.add(String(id));
  pendingWork.set(platformId, set);
}

/**
 * Platforms told "something happened" WITHOUT being told what.
 *
 * `pendingWork` holds rows, because a page watcher knows which conversations
 * changed and a woken cycle can then work exactly those. Threads' doorbell
 * cannot: it hears a frame on a socket, and deliberately does not read it. So
 * it wakes the gap and the cycle does its ordinary full pass — late by one
 * navigation instead of by one idle gap.
 */
const wokenPlatforms = new Set();

function noteWake(platformId) {
  if (platformId) wokenPlatforms.add(platformId);
}

function hasPendingWork(platformId) {
  return Boolean(platformId && (pendingWork.get(platformId)?.size || wokenPlatforms.has(platformId)));
}

/** Claim the pending rows, clearing them: a woken cycle consumes its reason. */
function takePendingWork(platformId) {
  const set = pendingWork.get(platformId);
  pendingWork.delete(platformId);
  // The wake is consumed with them: a cycle that has started IS the answer to
  // the doorbell, and leaving the flag up would cut every later gap short for
  // the rest of the run.
  wokenPlatforms.delete(platformId);
  return set ?? new Set();
}

async function abortableSleep(ms, wakeFor = null) {
  const STEP = 250;
  let sinceTick = 0;
  for (let waited = 0; waited < ms; waited += STEP) {
    if (await stopRequested()) return false;
    // Woken by the page. The idle gap exists to stop an IDLE account being
    // touched on a metronome — it was never meant to make somebody who just
    // wrote to us wait out the rest of it.
    if (wakeFor && hasPendingWork(wakeFor)) return true;
    sinceTick += STEP;
    if (sinceTick >= TICK_EVERY_MS) {
      sinceTick = 0;
      const s = await sweepState();
      if (s.running) await chrome.storage.session.set({ [SWEEP_KEY]: { ...s, lastTick: Date.now() } });
    }
    await sleep(Math.min(STEP, ms - waited));
  }
  return !(await stopRequested());
}

/**
 * Patch the run's state — for ONE platform when `platformId` is given.
 *
 * With a loop per platform there is no single "current thread" or "cycle 3"
 * any more: three of them are true at once. Each platform keeps its own block
 * under `per`, and the top-level fields stay as the SUM, because that is what
 * the panel's Start button and progress line have always read and there is no
 * reason to make them wrong while the detail is added underneath.
 *
 * Three loops write this concurrently. A read-modify-write can therefore drop
 * a sibling's update — which is why each loop only ever touches its own block
 * and the totals are RECOMPUTED from all blocks rather than incremented.
 * Incrementing a shared counter from three places is how you get a run that
 * reports four replies after sending six.
 */
async function setSweep(patch, platformId = null) {
  const prev = await sweepState();
  const next = platformId
    ? { ...prev, per: { ...(prev.per ?? {}), [platformId]: { ...(prev.per?.[platformId] ?? {}), ...patch } } }
    : { ...prev, ...patch };

  const blocks = Object.values(next.per ?? {});
  if (blocks.length) {
    next.done = blocks.reduce((n, b) => n + (b.done ?? 0), 0);
    next.sent = blocks.reduce((n, b) => n + (b.sent ?? 0), 0);
    next.skipped = blocks.reduce((n, b) => n + (b.skipped ?? 0), 0);
    next.cycles = Math.max(0, ...blocks.map((b) => b.cycles ?? 0));
    // "What is it doing" is now several answers; show the ones actually busy.
    const busy = Object.entries(next.per ?? {}).filter(([, b]) => b.current);
    next.current = busy.length ? busy.map(([id, b]) => `${id}: ${b.current}`).join(" · ") : null;
    next.waiting = blocks.length > 0 && blocks.every((b) => b.waiting);
  }

  await chrome.storage.session.set({ [SWEEP_KEY]: next });
  chrome.runtime.sendMessage({ type: "ft:sweep-changed", sweep: next }).catch(() => {});
  return next;
}

// ── follow-ups ───────────────────────────────────────────────────────────────

const FOLLOWUP_LOG = "fluidextension.followups";

/** How many follow-ups each handle has had, and when the last one went. */
/**
 * ⚠ PER PLATFORM, because a rung spent on one site is not spent on another.
 *
 * Shared, this silences a platform before it has said anything: read live,
 * `another.lead` carried `count: 3` from Instagram, so on Threads — where the
 * character had just opened its FIRST conversation with them — every stage
 * already looked used and no nudge could ever be due. The ladder is per
 * conversation, and FluidTalk keys a session per platform for the same reason.
 */
async function followupHistory(platformId = null) {
  const key = outreachKey(FOLLOWUP_LOG, platformId);
  const { [key]: log = {} } = await chrome.storage.local.get(key);
  return log;
}

async function recordFollowup(handle, platformId = null) {
  const key = outreachKey(FOLLOWUP_LOG, platformId);
  const log = await followupHistory(platformId);
  const row = log[handle] ?? { count: 0, last: 0 };
  // `failures` is deliberately dropped: a confirmed send clears the doubt.
  log[handle] = { count: row.count + 1, last: Date.now() };
  await chrome.storage.local.set({ [key]: log });
}

/**
 * Count an attempt that was never confirmed in the thread, and PERSIST it.
 *
 * The count has to outlive the cycle or it is not a count. `followupHistory`
 * hands back a plain copy and only `recordFollowup` writes, so incrementing
 * the in-memory object would reset to one every ninety seconds — a limit that
 * reads correctly and never trips, which is exactly the shape of guard that
 * let sixteen copies of one message go out.
 */
async function recordFollowupFailure(handle, platformId = null) {
  const key = outreachKey(FOLLOWUP_LOG, platformId);
  const log = await followupHistory(platformId);
  const row = log[handle] ?? { count: 0, last: 0 };
  const failures = (row.failures ?? 0) + 1;
  log[handle] = { ...row, failures };
  await chrome.storage.local.set({ [key]: log });
  return failures;
}

/**
 * Is this lead due their NEXT nudge?
 *
 * Every stage is its OWN window: `stages[n]` is the wait before nudge n+1, not
 * a total elapsed since they went quiet. Stage 1 is measured from THEIR last
 * message; every later stage from OUR last nudge, which is the only clock we
 * reliably have once we are the ones who spoke last.
 *
 * Returns null when they are not due — including when they have had every rung
 * the ladder has, which is what bounds the whole thing.
 */
function followupDue(stages, history, handle, silentHours) {
  const row = history[handle] ?? { count: 0, last: 0 };
  if (row.count >= stages.length) return null; // ladder exhausted

  const waitHours = stages[row.count];

  if (row.count === 0) {
    // First nudge. Measuring their silence from the inbox row is unreliable —
    // the list is paged, and most queued leads are not on screen at all (the
    // character serves other accounts too). So the QUEUE is the evidence:
    // FluidTalk only queues leads already dormant past the idle_hours we swept
    // with. A readable row is used as a second opinion when we have one.
    if (silentHours !== null && silentHours < waitHours) return null;
    return { stage: 1, waitHours };
  }

  const sinceOurs = (Date.now() - (row.last || 0)) / 3_600_000;
  if (sinceOurs < waitHours) return null;
  return { stage: row.count + 1, waitHours };
}

/**
 * Nudge leads who went quiet after we spoke last.
 *
 * The extension decides WHO is due, from how long the thread has been silent;
 * FluidTalk writes the words, walking its own ladder of prompts. A follow-up is
 * only ever acked once it is CONFIRMED in the thread — acking on the attempt
 * would retire a nudge that never arrived and the lead would never hear from us
 * again.
 */
async function runFollowups(settings, { onlyHandle = null, dryRun = false, target = null } = {}) {
  const stages = followupStages(settings);
  if (stages.length === 0) {
    await log("error", "follow-ups: no valid stages configured");
    return;
  }

  // Ask the character to queue anything eligible. The FIRST window is the
  // earliest anyone can be due — nobody reaches a later rung without having had
  // the first — so sweeping at that threshold cannot miss one.
  try {
    await sweepFollowups(settings, { idleHours: stages[0], limit: 10 });
  } catch (err) {
    await log("error", `follow-up sweep: ${err.message}`);
    return;
  }

  let queued;
  try {
    queued = await listFollowups(settings, { limit: 50 });
  } catch (err) {
    await log("error", `follow-up list: ${err.message}`);
    return;
  }
  if (onlyHandle) {
    queued = queued.filter(
      (fu) => String(fu.handle ?? fu.lead_handle ?? "").toLowerCase() === onlyHandle.toLowerCase(),
    );
  }
  if (queued.length === 0) {
    await log("info", `follow-ups: the character queued none${onlyHandle ? ` for ${onlyHandle}` : ""}`);
    return { queued: 0, sent: 0 };
  }

  /**
   * ⚠ A LEAD WHO NEVER ACCEPTED THE REQUEST CAN NEVER RECEIVE A FOLLOW-UP.
   *
   * Instagram removes the composer on an unaccepted request, so there is no
   * message number two — this is not a rate limit or a risk to manage, it is
   * impossible. FluidTalk queues them anyway, because from its side they are
   * simply leads who have gone quiet, which is exactly what a follow-up is for.
   *
   * Dropped here, BEFORE the thread is opened: each attempt costs a page load
   * and a billed generate, and the send can only ever fail — which the retry
   * cap then counts as three strikes against a handle that did nothing wrong.
   */
  const unreachableNow = await unreachableProfiles(target?.platform.id);
  const blocked = queued.filter((fu) => unreachableNow.has(String(fu.handle ?? fu.lead_handle ?? "")));
  if (blocked.length) {
    queued = queued.filter((fu) => !unreachableNow.has(String(fu.handle ?? fu.lead_handle ?? "")));
    await log("info", `follow-ups: ${blocked.length} skipped — they never accepted the request, so nothing can be sent`);
  }
  if (queued.length === 0) {
    await log("info", "follow-ups: none left that can actually be delivered");
    return { queued: 0, sent: 0 };
  }

  await log("info", `follow-ups: ${queued.length} queued`);
  let sentCount = 0;
  /** Handles the queue holds that this browser has no conversation for. */
  const unknownHere = [];

  const history = await followupHistory(target?.platform.id);
  const rows = await askPage("ft:list-threads", { ownHandle: settings.ownUsername }, target);
  const known = await knownThreads(target?.platform.id);

  for (const fu of queued) {
    if (await stopRequested()) return;

    const handle = fu.handle ?? fu.lead_handle;
    if (!handle || !fu.message) continue;

    // Two ways to reach them, and the FIRST one is the one that works: a thread
    // id recorded the last time this conversation was read. The label match
    // below only ever succeeds for a lead whose FluidTalk handle happens to BE
    // their Instagram display name; for everybody else the row says one thing
    // and the queue says another.
    const seen = known[handle.toLowerCase()];
    /**
     * ⚠ THE ROW'S TEXT IS NOT IN THE SAME FIELD ON EVERY PLATFORM. Instagram
     * answers `{label: "<the whole row>", name}`; Threads answers
     * `{label: "<the index>", title: "<the whole row>"}` and NO `name` at all —
     * its rows carry no id until opened, so the label has to be something
     * `ft:open-thread` can use. Requiring `r.name` therefore matched nothing on
     * Threads, ever: the id path was the only way through, and a lead this
     * browser had not read before was collected as "unknown here" instead.
     *
     * `rowText` is what a reader sees, wherever it lives; `row.label` stays
     * what gets handed back to `ft:open-thread`, which is per-platform by
     * design.
     */
    const row = rows.find((r) => rowText(r).toLowerCase().includes(handle.toLowerCase()));
    // Silence is read off the row when we have one. With only a thread id there
    // is no age to read, which `followupDue` treats as "trust the queue" — and
    // the queue is only ever filled with leads FluidTalk already judged dormant.
    // The "· 1 tydz." stamp lives in the row's TEXT, which on Threads is not
    // `label` — reading it from there asked an index how old it was.
    const ageDays = row ? ageDaysFromLabel(rowText(row)) : null;
    const silentHours = ageDays === null ? null : ageDays * 24;

    const due = followupDue(stages, history, handle, silentHours);
    if (!due) {
      const sent = history[handle]?.count ?? 0;
      await log(
        "info",
        `follow-up ${handle}: not due (${sent}/${stages.length} sent, quiet ${
          silentHours === null ? "unknown" : `${Math.round(silentHours)}h`
        })`,
      );
      continue;
    }

    if (!seen && !row) {
      // Usually not a failure — the character serves several accounts and most
      // of the queue belongs to inboxes this browser is not signed into. But a
      // lead we have simply never opened HERE looks identical from the outside,
      // and dropping both in silence is how "follow-ups do nothing" reads from
      // the panel.
      //
      // COLLECTED, NOT LOGGED ONE BY ONE. Naming each handle on its own line
      // sounds more helpful and is the opposite: the queue holds every lead
      // the character knows, so fifteen identical lines land per cycle, every
      // cycle, and the log keeps only sixty. Measured during a live debugging
      // run — the skips had pushed out every send, every generation and every
      // error, which is exactly what the log existed to show. One line at the
      // end says the same thing and leaves room for the news.
      unknownHere.push(handle);
      continue;
    }

    let opened = null;
    if (seen?.threadId) {
      await goToRoute("thread", [seen.threadId], 7000, target);
    } else {
      opened = await askPage("ft:open-thread", { label: row.label }, target);
      if (!opened.clicked) continue;
      if (!(await abortableSleep(6000))) return;
    }

    // Confirm where we ACTUALLY are. Navigating by id proves itself — the id we
    // asked for is the id we must be on. Clicking a row only proves that the
    // thread CHANGED, which is the weaker of the two and why the id path exists.
    const where = await askPage("ft:where", {}, target);
    const landed = seen?.threadId
      ? where.threadId === seen.threadId
      : Boolean(where.threadId) && (where.threadId !== opened.before || opened.alreadyOpen);
    if (!landed) {
      await log("error", `follow-up ${handle}: could not open the thread`);
      continue;
    }

    // The thread is open now, so ask it directly rather than trusting the
    // ledger: a lead can accept a request at any time, and the ledger only
    // learns that the next time something reads the conversation. A miss here
    // is NOT counted as a failed attempt — the send never happened, and
    // burning a strike for it would eventually silence a lead who simply has
    // not opened Instagram yet.
    const state = await readThread(settings.ownUsername, target);
    if (state?.canSend === false) {
      await markUnreachable(handle, target?.platform.id);
      await log("info", `follow-up ${handle}: skipped — they never accepted the request, so nothing can be sent`);
      await goToRoute("inbox", [], 7000, target);
      continue;
    }

    if (dryRun) {
      await log(
        "info",
        `follow-up ${handle}: DRY RUN — on thread ${where.threadId}, would send ${JSON.stringify(
          followupBubbles(fu).map((b) => b.text),
        )}`,
      );
      await goToRoute("inbox", [], 7000, target);
      continue;
    }

    const sent = await sendBubbles(
      { threadId: where.threadId, handle, lastInbound: { text: "" }, neverAnswered: false },
      followupBubbles(fu),
      target,
    );
    if (sent.some((s) => s.ok)) {
      sentCount += 1;
      await recordFollowup(handle, target?.platform.id);
      history[handle] = { count: (history[handle]?.count ?? 0) + 1, last: Date.now() };
      await log(
        "info",
        `follow-up ${due.stage}/${stages.length} sent to ${handle} (quiet ${
          silentHours === null ? "unknown" : `${Math.round(silentHours)}h`
        })`,
      );
      try {
        await ackFollowup(settings, fu.id);
      } catch (err) {
        // It went out; failing to ack only risks a repeat, which the local
        // stage count still blocks. Worth saying so rather than swallowing.
        await log("error", `follow-up ${handle}: delivered but not acked — ${err.message}`);
      }
    } else {
      // ⚠ CAP THE RETRIES. "Left queued" means try again next cycle, and with
      // nothing counting the attempts that is an unbounded loop the moment
      // delivery confirmation is wrong about anything.
      //
      // It was. A thread whose messages are all the same length read as
      // `no_messages`, so every follow-up into it was reported undelivered and
      // sent again ninety seconds later. The messages WERE arriving. Counted
      // afterwards in the real conversations:
      //
      //     lead_handle       20 messages from us, 16 of them identical, 0 replies
      //     lead_b    20 messages from us, 14 identical
      //     lead_c   15 identical
      //
      // The reader is fixed, but a person receiving sixteen copies of one
      // sentence must not depend on a DOM heuristic being right. Three
      // unconfirmed attempts and this handle is left alone.
      const fails = await recordFollowupFailure(handle, target?.platform.id);
      if (fails >= MAX_UNCONFIRMED) {
        await recordFollowup(handle, target?.platform.id);
        await log(
          "error",
          `follow-up ${handle}: ${fails} attempts never confirmed in the thread — giving up on this one. ` +
            `If the messages are arriving, delivery confirmation is misreading the thread.`,
        );
      } else {
        await log("error", `follow-up ${handle}: did not appear in the thread (attempt ${fails}) — left queued`);
      }
    }

    await goToRoute("inbox", [], 7000, target);
  }

  if (unknownHere.length) {
    await log(
      "info",
      `follow-ups: ${unknownHere.length} queued lead(s) have no conversation in this inbox — skipped ` +
        `(${unknownHere.slice(0, 4).join(", ")}${unknownHere.length > 4 ? ", …" : ""})`,
    );
  }

  return { queued: queued.length, sent: sentCount };
}

// ── commenting on public posts ───────────────────────────────────────────────

const COMMENTED_KEY = "fluidextension.commented";

/**
 * Posts whose comments are turned off. Separate from COMMENTED_KEY, which also
 * serves as the fallback list of posts to check for REPLIES — we never
 * commented on these, so there is nothing to come back for.
 */
const UNCOMMENTABLE_KEY = "fluidextension.uncommentable";

/**
 * What we actually said on each post — the only way to recognise a reply to it
 * on Threads.
 *
 * ⚠ A THREADS NOTIFICATION ABOUT A REPLY TO OUR COMMENT CARRIES NO POST LINK.
 * Measured on the live /activity list: a row about somebody replying to our
 * comment on THEIR post holds exactly one anchor, `/@a_lead` — the actor's
 * profile — with no `role`, no wrapping link, and no post href anywhere; only
 * rows about OUR OWN posts carry `/@us/post/<code>`. So `readNotifications`
 * answers `code: null` for precisely the case `commentReplies` exists to
 * handle, and the pass opened the one older post that did have a code, found
 * no replies under our comments there, and reported zero.
 *
 * What the row DOES carry is the text of the comment that was replied to —
 * ours. We wrote it, so we can recognise it: recorded here at the moment it is
 * published, and matched back in `replyCandidatePosts`. That costs no page
 * load, where clicking each notification to discover where it leads costs one
 * apiece.
 *
 * Per platform, like every other ledger keyed by something a platform owns.
 */
const COMMENT_TEXTS_KEY = "fluidextension.commentTexts";
/** Enough to identify one comment, short enough to survive a truncated row. */
const COMMENT_TEXT_KEEP = 60;

async function commentTexts(platformId = null) {
  const key = outreachKey(COMMENT_TEXTS_KEY, platformId);
  const { [key]: map = {} } = await chrome.storage.local.get(key);
  return map;
}

/** The stored shape, tolerating the first version which was a bare string. */
function commentMemo(value) {
  if (!value) return null;
  return typeof value === "string" ? { text: value, author: null } : { text: value.text, author: value.author ?? null };
}

/**
 * `author` is what makes the post OPENABLE again.
 *
 * A Threads post opens only by clicking a link to it, and the notification the
 * reply arrives on has none — so falling back to /activity, which is what
 * `openPostByCode` does by default, looks for a link on the one page that
 * certainly lacks it: "no link to post C7aBcDeFgHi on this page". The author's
 * profile is a list that does have it, and we know who they are at the moment
 * we comment.
 */
async function rememberCommentText(code, text, author, platformId = null) {
  if (!code || !text) return;
  const key = outreachKey(COMMENT_TEXTS_KEY, platformId);
  const map = await commentTexts(platformId);
  map[code] = {
    text: String(text).replace(/\s+/g, " ").trim().slice(0, COMMENT_TEXT_KEEP),
    author: author ?? null,
  };
  // Bounded, like the other ledgers: only the recent tail can still get a reply.
  const codes = Object.keys(map);
  if (codes.length > 500) for (const c of codes.slice(0, codes.length - 500)) delete map[c];
  await chrome.storage.local.set({ [key]: map });
}

async function uncommentablePosts() {
  const { [UNCOMMENTABLE_KEY]: list = [] } = await chrome.storage.local.get(UNCOMMENTABLE_KEY);
  return new Set(list);
}

async function markUncommentable(code) {
  const set = await uncommentablePosts();
  set.add(code);
  await chrome.storage.local.set({ [UNCOMMENTABLE_KEY]: [...set].slice(-1000) });
}

/** Post codes we have already commented on. */
async function commentedPosts() {
  const { [COMMENTED_KEY]: list = [] } = await chrome.storage.local.get(COMMENTED_KEY);
  return new Set(list);
}

async function markCommented(code) {
  const done = new Set([...(await commentedPosts()), ...(await uncommentablePosts())]);
  done.add(code);
  // Bounded: this grows for ever otherwise, and only the recent tail matters.
  await chrome.storage.local.set({ [COMMENTED_KEY]: [...done].slice(-500) });
}

/**
 * Collect posts to consider commenting on.
 *
 * "feed" reads the home timeline. "followers" walks the people who follow us
 * and takes their most recent post — the same followers list outreach uses, so
 * the two agree on who "our followers" are.
 */
async function commentCandidates(settings, target = null) {
  const out = [];

  if (settings.commentSources !== "followers") {
    if (!(await goToRoute("home", [], 10000, target))) return out;

    // Instagram renders two or three posts on first paint and mounts the rest
    // as you scroll, so reading immediately sees almost nothing. Scroll, re-read,
    // and stop when a pass adds nothing new — a fixed number of scrolls would
    // either cut the feed short or spin at the bottom.
    // Instagram also VIRTUALISES the feed: articles above the viewport are
    // unmounted, so a later read can show fewer posts than an earlier one.
    // Accumulate across passes rather than trusting any single read.
    const seen = new Map();
    let stuck = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      for (const post of await askPage("ft:read-feed", {
        limit: 30,
        skipSponsored: settings.skipSponsored,
      }, target)) {
        if (!seen.has(post.code)) seen.set(post.code, { ...post, via: "feed" });
      }
      if (seen.size >= settings.feedScanLimit) break;

      const scrolled = await askPage("ft:scroll-page", { by: 1200 }, target);
      // One failure to move usually means the next page is still loading, not
      // that the feed ended — giving up on the first is what stops a run three
      // posts in. Two in a row is the end.
      stuck = scrolled.moved ? 0 : stuck + 1;
      if (stuck >= 2) break;
      if (!(await abortableSleep(2000))) break;
    }
    out.push(...seen.values());
  }

  if (settings.commentSources !== "feed") {
    const { ok, targets } = await outreachTargets(12, target);
    if (ok) {
      for (const handle of targets.slice(0, 6)) {
        if (await stopRequested()) break;
        if (!(await goToRoute("profile", [handle], 8000, target))) break;
        // A profile grid, NOT the feed reader: a profile page has no <article>,
        // so ft:read-feed returns an empty list there and this whole source
        // quietly contributed nothing.
        const posts = await askPage("ft:read-profile-posts", { limit: 1 }, target);
        if (!posts.length) await log("info", `comments: ${handle} has no readable posts`);
        for (const post of posts) out.push({ ...post, author: post.author ?? handle, via: "follower" });
      }
    }
  }
  return out;
}

/**
 * Comment on posts, from the feed and/or our followers.
 *
 * Every step is confirmed against the page, and the post is only recorded as
 * commented once our words are actually visible on it. A comment is PUBLIC, so
 * a false "sent" here is worse than in a DM.
 */
async function runComments(settings, { limit = Infinity, dryRun = false, target = null } = {}) {
  // Check the budget BEFORE gathering candidates. Gathering is the expensive
  // half — it loads a feed and scrolls it, or walks the followers list — and
  // with the run now looping every ninety seconds, doing that with nothing left
  // to spend would touch the account all day to reach a cap it already knows
  // about.
  {
    const q = await quotaFor("comment", settings, target?.platform.id);
    // A dry run spends nothing, so a spent budget must not block it — that is
    // the button you press precisely when the budget is gone and you want to
    // see what it WOULD have said.
    if (!dryRun && q.remaining <= 0) {
      await log("info", `comments: skipping this cycle — ${quotaSummary(q)}`);
      return;
    }
  }
  const candidates = await commentCandidates(settings, target);
  await log("info", `comments: ${candidates.length} candidate post(s)`);
  const done = await commentedPosts();
  let postedCount = 0;
  const summary = () => ({ candidates: candidates.length, posted: postedCount });

  for (const cand of candidates) {
    if (await stopRequested()) return summary();
    if (postedCount >= limit) break;
    if (done.has(cand.code)) continue;

    const quota = await quotaFor("comment", settings, target?.platform.id);
    if (quota.remaining <= 0) {
      await log("info", `comments: stopping — ${quotaSummary(quota)}`);
      return summary();
    }

    /**
     * ⚠ A POST IS NOT ALWAYS ADDRESSABLE, so it is opened BY CODE.
     *
     * This navigated to `cand.url`, which only exists because Instagram's feed
     * reader puts one there. Threads' does not — and Threads' post route
     * deliberately returns null, because `/@author/post/<code>` answers 302 and
     * lands on the HOME FEED. So this called `goTo(undefined)` and then read
     * whatever was on screen: the whole comments pass could never work there,
     * and the failure surfaced as "could not read <code>", which reads like a
     * slow page rather than a pass that never had a way in.
     *
     * `openPostByCode` already knows both routes — address it where one exists,
     * click the link where one does not — and `backTo` tells its retry which
     * list the code came from.
     */
    const backTo =
      cand.via === "follower" && cand.author
        ? { route: "profile", args: [cand.author] }
        : { route: "home", args: [] };
    /**
     * A candidate we cannot open is SKIPPED, not the end of the run.
     *
     * This returned, which is defensible where opening is a navigation: a
     * `goTo` that fails means something systemic. On Threads a post is opened
     * by clicking its link, the home feed is live, and candidates are all
     * gathered BEFORE any of them is opened — so by the time the pass reaches
     * one, the timeline may simply have moved on. Reproduced: a post that was
     * sixth of thirty-four answered `no link to post DdAaBbCcDdE on this page`
     * minutes later, after `openPostByCode` had already gone back to the feed
     * and rescanned it.
     *
     * One stale candidate therefore ended a pass holding twelve good ones, and
     * the run reported the posts it never looked at as though it had finished.
     */
    if (!(await openPostByCode(cand.code, 9000, target, { backTo }))) {
      await log("info", `comments: could not open ${cand.code} (${cand.via}) — skipping it`);
      continue;
    }
    const post = await askPage("ft:read-post", { ownHandle: settings.ownUsername }, target);
    if (!post.ok) {
      await log("error", `comments: could not read ${cand.code} (${post.reason})`);
      continue;
    }
    if (post.alreadyCommented) {
      await markCommented(cand.code);
      continue;
    }

    let data;
    try {
      data = await comment(settings, {
        postRef: post.postRef,
        caption: post.caption,
        imageUrls: post.imageUrls,
        authorHandle: post.author,
      });
    } catch (err) {
      await log("error", `comments ${cand.code}: ${err.message}`);
      continue;
    }

    // Comments are OFF by default per workflow and the endpoint fails CLOSED,
    // so a refusal arrives as ok:true with no comment. Say it once, loudly, and
    // stop — every further post would return the same thing.
    if (data.ignore_reason === "comments_disabled") {
      await log("error", `comments are switched OFF for this character in FluidTalk — ${data.explain ?? ""}`);
      return summary();
    }
    if (!data.comment) {
      await log("info", `comments ${cand.code}: nothing written (${data.ignore_reason ?? data.pause_reason ?? "no reason"})`);
      await markCommented(cand.code);
      continue;
    }
    // Optional, because an adapter that reports no images at all is a normal
    // platform rather than a broken one — this threw "Cannot read properties
    // of undefined (reading 'length')" and took the WHOLE comments pass down
    // AFTER the character had already written the comment.
    if (post.imageUrls?.length && data.vision && !data.vision.seen) {
      await log("error", `comments ${cand.code}: written WITHOUT seeing the picture (${data.vision.reason ?? "?"})`);
    }

    if (dryRun) {
      await log(
        "info",
        `comments ${cand.code} (${cand.via}, @${cand.author ?? "?"}): DRY RUN — would post “${data.comment}”`,
      );
      postedCount += 1;
      continue;
    }

    if (!(await abortableSleep(2000 + Math.random() * 4000))) return summary();
    /**
     * `ownHandle` is what makes the confirmation mean anything.
     *
     * The adapter confirms a publish by finding a block on the post that
     * CONTAINS our text — `includes`, because Threads appends its own furniture
     * inside the block. Without a handle to check it against, that match is
     * "somebody said something containing this", and a character's comment is
     * often a short generic line that really can sit inside a longer comment by
     * someone else. Then a publish that never happened is counted, recorded in
     * `commented`, and never retried. The reply path has always sent it; this
     * one did not, on either call site.
     */
    const posted = await askPage(
      "ft:post-comment",
      { text: data.comment, ownHandle: settings.ownUsername },
      target,
    );
    if (posted.ok) {
      postedCount += 1;
      await recordCounter("comment", target?.platform.id);
      await markCommented(cand.code);
      // What we said, so a reply to it can be recognised later — see
      // `COMMENT_TEXTS_KEY`. Recorded here because this is the only moment both
      // the post code and the published words are in hand.
      await rememberCommentText(cand.code, data.comment, post.author ?? cand.author, target?.platform.id);
      done.add(cand.code);
      await log("info", `commented on ${cand.author ?? cand.code} (${cand.via}): “${data.comment.slice(0, 60)}”`);
    } else {
      await log("error", `comments ${cand.code}: ${posted.reason}`);
      // A post with comments turned off does not turn them back on, and
      // finding out costs a PAGE LOAD plus a billed generation — the comment
      // is written before we discover there is nowhere to put it. Remembered
      // so neither is spent on it twice. Kept apart from `commentedPosts`,
      // which doubles as the fallback list of posts to check for replies: we
      // never commented here, so there is nothing to come back for.
      // The FLAG first, the sentence second. Matching `/no comment box/i` alone
      // is matching Instagram's exact wording, so Threads — which says "no
      // reply composer" — never memoed anything, and every cycle re-opened the
      // post and paid for another generation before failing the same way.
      if (posted.uncommentable || /no comment box/i.test(posted.reason ?? "")) {
        await markUncommentable(cand.code);
      }
    }
  }

  return summary();
}

// ── answering replies to our comments ────────────────────────────────────────

const ANSWERED_KEY = "fluidextension.answeredReplies";

/**
 * How many of the posts we have commented on to revisit for new replies.
 *
 * Only reached when the notification list cannot be read at all. Bounded
 * because every post is a page load: a comment made a month ago is unlikely to
 * gain its first reply now, and scanning the whole history would spend the run
 * navigating. Stated here rather than left implicit — a silent cap on coverage
 * reads as "we checked everywhere" when it is not.
 */
const REPLY_SCAN_POSTS = 8;

/**
 * Which posts to open, and why — the notification list, not our own history.
 *
 * Opening every post we have ever commented on is the expensive, incomplete
 * way round: a page load each, and it can only ever find replies under
 * comments this install made. `/notifications/` names the posts where
 * something actually happened, including ones we have no record of — measured,
 * it surfaced a reply on a post the commented list did not contain.
 *
 * The fallback fires only when the page is UNREADABLE, never when it is merely
 * empty. "Nobody has replied" is the normal outcome and must cost nothing;
 * treating it as a failure would re-open every commented post on every quiet
 * run, which is exactly the behaviour this replaces.
 */
async function replyCandidatePosts(settings, target = null) {
  if (!(await goToRoute("notifications", [], 10000, target))) return { via: "none", codes: [] };
  const notes = await askPage("ft:read-notifications", { ownHandle: settings.ownUsername, limit: 40 }, target);

  if (notes.ok && notes.readable) {
    // A reply names us with an @mention, so those rows come first; the rest are
    // likes and follows on posts we commented on, which is still a better place
    // to look than a post nobody has touched.
    /**
     * `repliedToUs` means "the post is OURS", which is the wrong question here.
     * A reply to our comment on somebody ELSE's post is the whole point of this
     * pass, and on Threads such a row carries no post link at all — see
     * `COMMENT_TEXTS_KEY`. It does quote the comment that was replied to, and
     * that comment is one we wrote, so the code comes back by recognising our
     * own words rather than by clicking every notification to find out where it
     * goes.
     */
    const ours = await commentTexts(target?.platform.id);
    const recovered = [];
    for (const r of notes.rows) {
      if (r.code || !r.text) continue;
      const hit = Object.entries(ours).find(([, v]) => commentMemo(v)?.text && r.text.includes(commentMemo(v).text));
      if (!hit) continue;
      recovered.push({
        ...r,
        code: hit[0],
        // Where to open it FROM — see `rememberCommentText`. The notification
        // itself has no link to the post.
        postAuthor: commentMemo(hit[1])?.author ?? r.postAuthor ?? null,
        repliedToUs: true,
        via: "quoted our comment",
      });
    }
    const replies = [...notes.rows.filter((r) => r.repliedToUs), ...recovered];

    // ⚠ ONLY POSTS WITH A NOTIFICATION WE HAVE NOT SEEN BEFORE.
    //
    // Notifications do not disappear once read, so the same handful of posts
    // came back every cycle and each one was NAVIGATED TO — a full page load
    // of `/p/<code>/` every few seconds, for ever, finding nothing new. That
    // is what Instagram rate-limits, and it is the whole reason a run dies
    // after a while: measured `https://www.instagram.com/p/DdGSHxvgCsv/ → 429`
    // leaving the tab on `chrome-error://chromewebdata/`, where no content
    // script can run and the platform goes silent.
    //
    // Fingerprinting the NOTIFICATION rather than cooling the post down is the
    // exact version: a genuinely new reply writes a new row, so it is visited
    // at once, while an unchanged row never costs another page load. A blunt
    // per-post cooldown would have delayed real replies by however long it ran.
    const seen = await seenNotifications();
    const fresh = replies.filter((r) => !seen.has(noteKey(r)));
    const codes = [...new Set(fresh.map((r) => r.code))];
    // Which profile each post can be reached FROM, when the notification has no
    // link to it — see `rememberCommentText`.
    const authors = Object.fromEntries(fresh.filter((r) => r.postAuthor).map((r) => [r.code, r.postAuthor]));
    const quiet = replies.length - fresh.length;
    await log(
      "info",
      `comment replies: ${notes.rows.length} notification(s), ${replies.length} naming us` +
        `${recovered.length ? ` (${recovered.length} matched by our own comment's text — the row carried no post link)` : ""}` +
        `${quiet ? `, ${quiet} already seen` : ""} — ${codes.length} post(s) to open`,
    );
    return { via: "notifications", codes, rows: fresh, authors };
  }

  await log("error", `comment replies: could not read notifications (${notes.reason ?? "unreadable"}) — falling back to the posts we commented on`);
  return { via: "commented", codes: [...(await commentedPosts())].slice(-REPLY_SCAN_POSTS).reverse() };
}

/**
 * Notification rows already acted on, so an unchanged one never costs a page
 * load again. Instagram gives them no id, but who + which post + the sentence
 * itself is stable per notification and changes the moment a new reply lands.
 */
const NOTIFIED_KEY = "fluidextension.notificationsSeen";

function noteKey(row) {
  return `${row.code}|${row.who ?? "?"}|${row.text ?? ""}`;
}

async function seenNotifications() {
  const { [NOTIFIED_KEY]: list = [] } = await chrome.storage.local.get(NOTIFIED_KEY);
  return new Set(list);
}

/**
 * Marked only AFTER the post has been read. Stamping them when the list is
 * built would retire a notification whose post we never managed to open —
 * which is exactly what happens when the navigation is the thing being
 * rate-limited, and the reply would then never be answered at all.
 */
async function markNotificationsSeen(rows) {
  if (!rows.length) return;
  const seen = await seenNotifications();
  for (const r of rows) seen.add(noteKey(r));
  await chrome.storage.local.set({ [NOTIFIED_KEY]: [...seen].slice(-500) });
}

/** Reply ids we have already answered. */
async function answeredReplies() {
  const { [ANSWERED_KEY]: list = [] } = await chrome.storage.local.get(ANSWERED_KEY);
  return new Set(list);
}

async function markAnswered(id) {
  const done = await answeredReplies();
  done.add(id);
  await chrome.storage.local.set({ [ANSWERED_KEY]: [...done].slice(-1000) });
}

/**
 * Did the reply we just posted actually land IN the thread?
 *
 * Reloading the post is the only way to know. Instagram draws a just-posted
 * comment inside whichever thread the composer was aimed at, so the page
 * immediately after Post agrees with what we intended whether or not the
 * server did — measured 2026-09-09, a reply confirmed as nested that way came
 * back as a plain top-level comment on the very next load.
 *
 * It cannot be undone from here, so this does not pretend to fix anything: it
 * says plainly what happened, because a comment that reads as an unprompted
 * top-level remark rather than an answer is a thing a human has to go and
 * delete.
 */
/**
 * Open one post by its code.
 *
 * Instagram ADDRESSES a post: `/p/<code>/` loads, so navigating is right there.
 * Threads does not — its post address answers 302 and lands on the home feed,
 * measured on the wire — so a worker that navigated would read whoever is at
 * the top of the feed as though it were the post it asked for.
 *
 * `routeFor` returning null is how a platform says "you cannot navigate to one
 * of these"; the adapter is then asked to open it the way a person does, by
 * clicking a link already on the page. That is why this has to be called while
 * still ON the page the code came from — the notifications list.
 */
async function openPostByCode(code, waitMs = 9000, target = null, { backTo = null } = {}) {
  const here = target ?? (await boundTarget());
  const url = routeFor(here?.platform, "post", code);
  if (url) return goTo(url, waitMs, target);

  const opened = await askPage("ft:open-post", { code }, target);
  if (opened?.ok) return true;

  // A CLICK NEEDS THE LINK TO BE ON SCREEN, and opening the previous post
  // navigated away from the list the codes came from. Every code after the
  // first would otherwise fail with "no link to post <code> on this page" —
  // which reads like the post vanished rather than like we moved.
  //
  // WHICH list to go back to depends on where the code came from: a post found
  // on the home feed is not linked from /activity, so the default would send a
  // feed candidate somewhere its link has never been. The caller knows; it says
  // so with `backTo`.
  const back = backTo ?? { route: "notifications", args: [] };
  if (!(await goToRoute(back.route, back.args ?? [], 10000, target))) return false;
  const retried = await askPage("ft:open-post", { code }, target);
  if (retried?.ok) return true;

  await log(
    "info",
    `${here?.platform?.label ?? "the page"} could not open post ${code}: ${retried?.reason ?? opened?.reason ?? "no way to open a post"}`,
  );
  return false;
}

async function confirmThreaded(code, sent, reply, target = null) {
  if (!sent.needsReloadCheck) return null;
  if (!(await openPostByCode(code, 9000, target))) return null;

  const again = await askPage("ft:read-comment-replies", { ownHandle: (await currentSettings(target)).ownUsername }, target);
  if (!again.ok) {
    await log("error", `comment replies ${code}: posted, but could not re-read the post to confirm it threaded`);
    return null;
  }
  const threaded = again.replies.some((r) => r.id === sent.id && r.isReply && r.replyTo === sent.replyTo);
  if (!threaded) {
    await log(
      "error",
      `comment replies ${code}: the reply to @${reply.author} is NOT threaded after reload — Instagram posted it as a TOP-LEVEL comment. It is public and only a human can remove it.`,
    );
  }
  return threaded;
}

/**
 * Answer the people who replied to our public comments.
 *
 * The source is the posts we have commented on — the extension already records
 * them, and a reply can only ever be under one of our own comments, so nothing
 * else has to be crawled. Instagram's notification list would reach further
 * back; it is also the one surface where a misread opens the wrong thing, and
 * this needs no such risk to work.
 *
 * FluidTalk owns the decision, not us. `/comments/reply` answers with a
 * `decision` — `comment_reply`, `drive_to_dm_nudge`, `skip`, `bow_out` — and
 * every stop rule returns ok:true with `reply: null`, so a refusal is
 * indistinguishable from a success unless the reply text itself is checked.
 * Nothing is posted unless words came back.
 */
async function runCommentReplies(settings, { limit = Infinity, dryRun = false, onlyHandle = null, target = null } = {}) {
  // Check the budget BEFORE gathering candidates. Gathering is the expensive
  // half — it loads a feed and scrolls it, or walks the followers list — and
  // with the run now looping every ninety seconds, doing that with nothing left
  // to spend would touch the account all day to reach a cap it already knows
  // about.
  {
    const q = await quotaFor("commentReply", settings, target?.platform.id);
    // See runComments: a dry run costs nothing and must stay usable.
    if (!dryRun && q.remaining <= 0) {
      await log("info", `comment replies: skipping this cycle — ${quotaSummary(q)}`);
      return;
    }
  }
  const { via, codes: posts, rows: noteRows = [], authors = {} } = await replyCandidatePosts(settings, target);

  let posted = 0;
  let seen = 0;
  const summary = () => ({ via, posts: posts.length, replies: seen, posted });
  if (!posts.length) return summary();
  const answered = await answeredReplies();

  for (const code of posts) {
    if (await stopRequested()) return summary();
    if (posted >= limit) break;

    /**
     * ⚠ NOT FROM /activity, WHEN THE NOTIFICATION HAD NO LINK TO THE POST.
     *
     * `openPostByCode` falls back to the notifications list, which is right on
     * Instagram and exactly wrong here: the Threads row that told us about the
     * reply is the one row with no post href, so the retry searches the single
     * page guaranteed not to contain it — "no link to post C7aBcDeFgHi on this
     * page", and a real reply sits unanswered. The author's profile is a list
     * that does have it.
     *
     * A failure is a SKIP, not the end of the pass, for the same reason as in
     * `runComments`: the next candidate may well be openable.
     */
    const backTo = authors[code] ? { route: "profile", args: [authors[code]] } : null;
    if (!(await openPostByCode(code, 9000, target, { backTo }))) {
      await log("info", `comment replies: could not open ${code} — skipping it`);
      continue;
    }
    const read = await askPage("ft:read-comment-replies", { ownHandle: settings.ownUsername }, target);
    if (!read.ok) {
      await log("error", `comment replies ${code}: ${read.reason}`);
      continue;
    }
    // The post opened and was read, so its notifications have done their job
    // and must not send us back here next cycle. Stamped HERE rather than at
    // the end of the loop body, which several branches skip past.
    await markNotificationsSeen(noteRows.filter((r) => r.code === code));
    const fresh = read.replies.filter(
      (r) =>
        !r.mine &&
        !r.answeredOnPage &&
        !answered.has(r.id) &&
        // Narrowing to ONE replier is how a real reply can be posted on purpose
        // without the same run also answering strangers on somebody else's post.
        (!onlyHandle || r.author === onlyHandle),
    );
    seen += fresh.length;
    if (!read.replies.length) continue;
    await log(
      "info",
      `comment replies ${code}: ${read.replies.length} reply/replies under our comment(s), ${fresh.length} unanswered`,
    );

    for (const reply of fresh) {
      if (await stopRequested()) return summary();
      if (posted >= limit) break;

      const quota = await quotaFor("commentReply", settings, target?.platform.id);
      if (quota.remaining <= 0) {
        await log("info", `comment replies: stopping — ${quotaSummary(quota)}`);
        return summary();
      }

      // A DRY RUN MUST NOT GENERATE, and this is not caution — it is what the
      // endpoint does. `/comments/reply` PERSISTS: it records their reply as
      // inbound, records our generated text as an OUTBOUND comment, and
      // increments the thread's reply count and the per-author count that the
      // stop rules are computed from. Measured 2026-09-09: two "dry runs" over
      // one real reply were enough for the third call to come back
      // `skip · max_replies_per_author` — the preview had spent the thread's
      // whole budget and left FluidTalk believing she had answered twice, in
      // public, when nothing was ever posted. Previewing the WORDS is what
      // `ft:comment-reply-generate` in mock mode is for: free, and it writes
      // nothing.
      if (dryRun) {
        await log(
          "info",
          `comment replies @${reply.author} on ${code}: DRY RUN — would ask FluidTalk about “${reply.text.slice(0, 60)}” (not asked: a generate is billed and counts against the thread's reply cap)`,
        );
        posted += 1;
        continue;
      }

      let data;
      try {
        data = await commentReply(settings, {
          postRef: read.postRef,
          replierHandle: reply.author,
          replyText: reply.text,
          // The THREAD's top-level comment — ours. FluidTalk hangs the exchange
          // off the thread it already knows from `/comments`, and a ref it has
          // never seen anchors a second thread, resetting the reply caps that
          // are the only thing stopping an endless public back-and-forth.
          parentRef: reply.replyTo,
        });
      } catch (err) {
        await log("error", `comment replies @${reply.author}: ${err.message}`);
        continue;
      }

      if (data.ignore_reason === "comments_disabled") {
        await log("error", `comments are switched OFF for this character in FluidTalk — ${data.explain ?? ""}`);
        return summary();
      }
      if (!data.reply) {
        // A stop rule, not a failure: comment_once, the thread's reply cap, a
        // hostile turn she bowed out of. Named, because "nothing happened" is
        // the one outcome that has to stay tellable from a broken call.
        await log(
          "info",
          `comment replies @${reply.author}: ${data.decision ?? "no decision"} (${data.reason ?? data.pause_reason ?? "no reason"})`,
        );
        await markAnswered(reply.id);
        answered.add(reply.id);
        continue;
      }

      if (!(await abortableSleep(2000 + Math.random() * 4000))) return summary();
      const sent = await askPage("ft:post-comment-reply", {
        commentId: reply.id,
        text: data.reply,
        ownHandle: settings.ownUsername,
      }, target);
      if (sent.ok) {
        posted += 1;
        await recordCounter("commentReply", target?.platform.id);
        await markAnswered(reply.id);
        answered.add(reply.id);
        await log("info", `replied to @${reply.author} on ${code} (${data.decision}): “${data.reply.slice(0, 60)}”`);
        await confirmThreaded(code, sent, reply, target);
      } else {
        await log("error", `comment replies @${reply.author}: ${sent.reason}`);
      }
    }
  }

  return summary();
}

// ── cold outreach to our own followers ───────────────────────────────────────

const OUTREACH_DONE = "fluidextension.outreachDone";

/**
 * Profiles that offer no way to message them — private accounts, accounts that
 * restrict DMs. Kept because the cost of finding out is a full PAGE LOAD, and
 * the answer does not change: these were being re-opened every cycle for ever,
 * which is most of what got Instagram to rate-limit the account.
 */
const OUTREACH_UNREACHABLE = "fluidextension.outreachUnreachable";

/**
 * ⚠ PER PLATFORM, because "no Message button" is a fact about a PAGE.
 *
 * This was one flat list shared by every platform, and the counters beside it
 * were already suffixed (`…outreach.instagram`) — so the memo that decides
 * WHETHER TO TRY was the one thing that leaked across sites. Measured on this
 * profile: 350 handles in the list, essentially all of them from Instagram,
 * where outreach failed 100% with "no Message button and no options menu".
 * Threads is a different site with a different profile layout — `openDm`
 * dry-ran `ok` on four of four profiles there — and it would have silently
 * skipped every one of those 350 people without a single page load to justify
 * it. A skip costs nothing and reports nothing, which is why this never showed
 * up as a failure.
 *
 * Same rule as `counterKey`: append the platform, and leave the legacy
 * un-suffixed key alone rather than migrate it. Splitting one history across
 * platforms would either copy Instagram's verdict onto Threads — exactly the
 * defect — or throw away a list that is still right for Instagram.
 */
function outreachKey(base, platformId) {
  return platformId ? `${base}.${platformId}` : base;
}

async function unreachableProfiles(platformId = null) {
  const key = outreachKey(OUTREACH_UNREACHABLE, platformId);
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  return new Set(list);
}

async function markUnreachable(handle, platformId = null) {
  const key = outreachKey(OUTREACH_UNREACHABLE, platformId);
  const set = await unreachableProfiles(platformId);
  set.add(handle);
  await chrome.storage.local.set({ [key]: [...set].slice(-2000) });
}

/**
 * How many times each handle has cost a page load and produced nothing.
 *
 * "Message did not open a thread" is not obviously permanent — it can be a
 * half-rendered page — so it was deliberately not treated as final. The run
 * then showed it is: the SAME five handles failed that way on every cycle,
 * five profile loads each time, for ever. Counting instead of guessing keeps a
 * genuinely transient failure retryable while a persistent one is retired.
 */
const OUTREACH_MISSES = "fluidextension.outreachMisses";
const GIVE_UP_AFTER = 3;

// Per platform for the same reason as `unreachableProfiles`: a profile that
// would not open a thread on one site says nothing about another.
async function countMiss(handle, platformId = null) {
  const key = outreachKey(OUTREACH_MISSES, platformId);
  const { [key]: map = {} } = await chrome.storage.local.get(key);
  const n = (map[handle] ?? 0) + 1;
  map[handle] = n;
  // Bounded: only the recent tail matters, and this would grow for ever.
  const keys = Object.keys(map);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete map[k];
  await chrome.storage.local.set({ [key]: map });
  return n;
}

/**
 * Handles we have already cold-opened, so a second run does not repeat them.
 *
 * DELIBERATELY NOT per-platform, unlike `unreachableProfiles` beside it. That
 * one is a fact about a page; this one is a fact about a PERSON — and on
 * Threads the sign-in IS the Instagram account, so the same persona
 * cold-opening the same human on both surfaces is one approach repeated, not
 * two conversations. FluidTalk would file them separately; the person would
 * not experience them separately.
 */
async function outreachDone() {
  const { [OUTREACH_DONE]: list = [] } = await chrome.storage.local.get(OUTREACH_DONE);
  return new Set(list);
}

async function markOutreached(handle) {
  const done = await outreachDone();
  done.add(handle);
  await chrome.storage.local.set({ [OUTREACH_DONE]: [...done] });
}

/**
 * Followers we could open, newest-listed first, minus everyone already done.
 *
 * Read-only — it opens the followers dialog and scrolls it, nothing else. This
 * is what the panel's preview calls, so the list can be inspected before a
 * single message is sent.
 */
async function outreachTargets(limit = 30, target = null) {
  const settings = await currentSettings(target);
  settings.ownUsername = (await resolveOwnHandle(target)) || settings.ownUsername;
  if (!settings.ownUsername) {
    throw new Error(`could not tell which account is signed in — open ${platformNames()}`);
  }

  const done = await outreachDone();
  const found = [];
  const keep = (h) => {
    if (!h) return;
    if (h.toLowerCase() === settings.ownUsername.toLowerCase()) return;
    if (done.has(h) || found.includes(h)) return;
    found.push(h);
  };

  /**
   * WHICH SOURCE, and why it is a choice rather than "everyone we can find".
   *
   * A follower chose us; the author of a post on the home timeline has never
   * heard of us. They are different acts with different risk, so they are
   * selectable and default to followers — see `outreachSources`.
   */
  const sources = String(settings.outreachSources ?? "followers");
  const wantFollowers = sources === "followers" || sources === "both";
  const wantFeed = sources === "feed" || sources === "both";
  let reached = false;

  if (wantFeed) {
    // The feed is read, never opened. `ft:read-feed` already drops sponsored
    // and suggested posts, which is what stops outreach cold-opening an
    // advertiser.
    if (await goToRoute("home", [], 9000, target)) {
      reached = true;
      for (let pass = 0; pass < 3 && found.length < limit; pass += 1) {
        const posts = await askPage("ft:read-feed", { limit: 25 }, target).catch(() => []);
        for (const p of posts ?? []) keep(p.author);
        // Scrolling costs nothing — no page load, so no re-bootstrap and none
        // of the route-resolution traffic a navigation brings.
        const moved = await askPage("ft:scroll-page", { by: 2000 }, target).catch(() => null);
        if (!moved?.moved) break;
        if (!(await abortableSleep(1500))) break;
      }
    }
  }

  if (wantFollowers && found.length < limit) {
    // The profile page, then a CLICK — the /followers/ URL alone leaves the
    // modal closed, so navigating there and reading finds nothing for ever.
    await goToRoute("profile", [settings.ownUsername], 8000, target);
    const opened = await askPage("ft:open-followers", { ownHandle: settings.ownUsername }, target);
    if (!opened.ok) {
      // With both sources asked for, a followers list that will not open is a
      // partial answer, not a failure — returning `ok:false` here would throw
      // away feed candidates already in hand.
      if (!reached) return { ok: false, reason: opened.reason, targets: [] };
      await log("error", `outreach: could not open the followers list (${opened.reason}) — using the feed only`);
      return { ok: true, targets: found.slice(0, limit) };
    }
    reached = true;
    if (!(await abortableSleep(4000))) return { ok: false, reason: "stopped", targets: [] };

    for (let page = 0; page < 6 && found.length < limit; page += 1) {
      const res = await askPage("ft:list-followers", {}, target);
      if (!res.ok) return { ok: false, reason: res.reason, targets: [] };
      for (const h of res.handles) keep(h);
      const scrolled = await askPage("ft:scroll-followers", {}, target);
      if (!scrolled.moved) break;
      if (!(await abortableSleep(1500))) break;
    }
  }

  // Neither source was asked for, or neither could be reached. Saying so beats
  // answering "no candidates", which reads as an empty account.
  if (!reached) return { ok: false, reason: `no usable outreach source (${sources})`, targets: [] };
  return { ok: true, targets: found.slice(0, limit) };
}

/**
 * Cold-open followers, within the outreach budget.
 *
 * This is the ONLY thing in the extension that messages somebody who has not
 * written to us, which is why it is off by default, has its own budget, and
 * uses the character's Outreach entry rather than `chat` — there is no inbound
 * message to answer, so pretending there is one would put a fabricated turn in
 * the transcript.
 *
 * Every step verifies before the next: the profile must yield a Message
 * button, the click must land us on a real thread, and the thread must be
 * EMPTY. That last check is what stops outreach walking into an existing
 * conversation and cold-opening somebody mid-chat.
 */
/**
 * `onlyHandle` / `limit` / `dryRun` exist for the same reason `runComments` has
 * them: this is the one pass that writes to somebody who never wrote to us, and
 * before today the only way to exercise it was to start a sweep and let it
 * message whoever came first. `onlyHandle` aims it at one account you control,
 * `limit` caps the sends below the hourly budget, and `dryRun` stops after the
 * character has written the opener — the thread is opened but nothing is sent,
 * which is not a message and reaches nobody.
 */
async function runOutreach(settings, target = null, { onlyHandle = null, limit = Infinity, dryRun = false } = {}) {
  // Check the budget BEFORE gathering candidates. Gathering is the expensive
  // half — it loads a feed and scrolls it, or walks the followers list — and
  // with the run now looping every ninety seconds, doing that with nothing left
  // to spend would touch the account all day to reach a cap it already knows
  // about.
  {
    const q = await quotaFor("outreach", settings, target?.platform.id);
    // A dry run spends nothing, so a spent budget must not block it — same rule
    // as the comments pass, and the same reason: that is the button you press
    // precisely when the budget is gone and you want to see what it would do.
    if (!dryRun && q.remaining <= 0) {
      await log("info", `outreach: skipping this cycle — ${quotaSummary(q)}`);
      return;
    }
  }
  const { ok, targets, reason } = await outreachTargets(50, target);
  if (!ok) {
    await log("error", `outreach: ${reason}`);
    return;
  }
  // Handles whose profile offers no way to message us are skipped without a
  // page load. A profile that has no Message button does not grow one, and
  // every one of these used to be re-opened on every cycle for ever.
  const unreachable = await unreachableProfiles(target?.platform.id);
  // Two filters, counted separately — the log below reports how many were
  // dropped as unmessageable, and folding `onlyHandle` into that number made a
  // run aimed at one account report the other eight as "no way to message
  // them", which is a sentence about THEIR profiles and was not true of any of
  // them.
  const reachable = targets.filter((h) => !unreachable.has(h));
  const fresh = reachable.filter((h) => !onlyHandle || h.toLowerCase() === String(onlyHandle).toLowerCase());
  if (onlyHandle && !fresh.length) {
    await log("error", `outreach: @${onlyHandle} is not among the ${reachable.length} reachable candidate(s) this pass found`);
    return;
  }
  // Name the SOURCE. "12 followers not yet opened" while the candidates came
  // off the home feed is the kind of log line that sends the next person
  // looking in the wrong place for an account they never followed.
  const sourceLabel =
    { followers: "follower(s)", feed: "feed author(s)", both: "candidate(s) (followers + feed)" }[
      String(settings.outreachSources ?? "followers")
    ] ?? "candidate(s)";
  await log(
    "info",
    `outreach: ${targets.length} ${sourceLabel} not yet opened` +
      `${targets.length - reachable.length ? `, ${targets.length - reachable.length} with no way to message them — skipped` : ""}` +
      `${onlyHandle ? `, aimed at @${onlyHandle} only` : ""}`,
  );

  /**
   * ⚠ A PASS THAT KEEPS FAILING MUST STOP, not keep going politely.
   *
   * Each attempt here is a full PROFILE PAGE LOAD, and they were failing 100%
   * of the time — seventeen in two minutes, every cycle, all with "no Message
   * button and no options menu on this profile". That was the single largest
   * source of the traffic that got Instagram to rate-limit us, and it is
   * self-feeding: the 429s make pages render incompletely, an incomplete
   * profile has no Message button, and the failure sends us to the next one.
   *
   * Consecutive failures are the signal. One failure is an odd account; five
   * in a row is the account being throttled or the markup having moved, and
   * neither is fixed by trying forty-five more.
   */
  let misses = 0;
  let posted = 0;
  const MAX_MISSES = 5;

  for (const handle of fresh) {
    if (await stopRequested()) return;
    if (misses >= MAX_MISSES) {
      await log(
        "error",
        `outreach: stopping this cycle — ${MAX_MISSES} profiles in a row offered no way to message them, ` +
          `which usually means Instagram is throttling us rather than that they all refuse DMs`,
      );
      return;
    }

    const quota = await quotaFor("outreach", settings, target?.platform.id);
    if (quota.remaining <= 0) {
      await log("info", `outreach: stopping — ${quotaSummary(quota)}`);
      return;
    }

    await setSweep({ current: `outreach → ${handle}` }, target?.platform.id);
    if (!(await goToRoute("profile", [handle], 7000, target))) return;

    const dm = await askPage("ft:open-dm", {}, target);
    if (!dm.ok) {
      misses += 1;
      await log("error", `outreach ${handle}: ${dm.reason}`);
      // Remembered so this profile is never loaded again. Only for the "no way
      // to message them" answer — a timeout or a half-rendered page is about
      // the moment, not about the account, and must stay retryable.
      // The FLAG first, the sentence second — same fix as `uncommentable`, and
      // the same reason: `/no Message button/i` is Instagram's wording, so
      // Threads memoed nothing and re-opened refused profiles every cycle.
      if (dm.unmessageable || /no Message button/i.test(dm.reason ?? "")) {
        await markUnreachable(handle, target?.platform.id);
      }
      continue;
    }
    if (!(await abortableSleep(6000))) return;

    const where = await askPage("ft:where", {}, target);
    if (!where.threadId) {
      // Counts against the breaker too. It is a different sentence but the
      // same waste — a profile page was loaded and no conversation came of it
      // — and leaving it uncounted let a run of failures walk straight past
      // the limit by alternating between the two.
      misses += 1;
      const n = await countMiss(handle, target?.platform.id);
      if (n >= GIVE_UP_AFTER) await markUnreachable(handle, target?.platform.id);
      await log(
        "error",
        `outreach ${handle}: Message did not open a thread${n >= GIVE_UP_AFTER ? ` — ${n} attempts, not trying again` : ""}`,
      );
      continue;
    }

    // ⚠ RESET ONLY HERE, where a conversation actually exists. It used to sit
    // one check earlier, right after `ft:open-dm` returned ok — which zeroed
    // the counter every single iteration BEFORE the "did a thread open" test
    // could increment it, so that failure mode could never reach the limit.
    // Eight consecutive failures walked past a limit of five that way.
    misses = 0;

    const thread = await readThread(settings.ownUsername, target);
    // A thread with history is NOT a cold open. Opening one would drop an
    // opener into the middle of a conversation.
    if (thread.ok && thread.messages.length > 0) {
      await log("info", `outreach ${handle}: skipped — this conversation already exists`);
      await markOutreached(handle);
      continue;
    }

    /**
     * ⚠ A DRY RUN STOPS HERE — asking the character for the opener IS the cold
     * open, so there is no way to preview the words without spending it.
     *
     * The first version of this generated first and skipped only the send,
     * copying `runComments`. That is safe for a comment, where the text comes
     * back from `/comments` and nothing is recorded until it is published. It
     * is NOT safe here: `/triggers` CREATES THE SESSION and writes the opener
     * into the transcript as an assistant turn, and its `external_event_id` is
     * a uniqueness constraint. Measured — one dry run left a live session
     * (`COLD`, one turn, "hey! your profile popped up lol…") for a message
     * nobody received, and the next run answered "character sent nothing"
     * because the key was already consumed. The preview would have quietly
     * eaten the real cold open and left the character believing it had spoken.
     *
     * So a dry run proves the PLATFORM path — the followers list, the profile,
     * the Message control, a real and empty thread — which is the half that
     * breaks. The words are the character's, and they cost one cold open.
     */
    if (dryRun) {
      await log(
        "info",
        `outreach ${handle}: DRY RUN — thread ${where.threadId} is open and empty. ` +
          `Not asking for an opener: that call is the cold open itself.`,
      );
      posted += 1;
      if (posted >= limit) return;
      continue;
    }

    try {
      const data = await outreach(settings, {
        handle,
        // Stable per (account, handle): the idempotency key is what makes a
        // retry after a crash a no-op instead of a second cold open.
        externalEventId: `fluidext:${settings.ownUsername}:${handle}`,
      });
      const bubbles = data.bubbles ?? [];
      if (bubbles.length === 0) {
        await log("info", `outreach ${handle}: character sent nothing (${data.ignore_reason ?? "no opener"})`);
        await markOutreached(handle);
        continue;
      }
      const sent = await sendBubbles(
        { threadId: where.threadId, handle, lastInbound: { text: "" }, neverAnswered: false },
        bubbles,
        target,
      );
      if (sent.some((s) => s.ok)) {
        await recordCounter("outreach", target?.platform.id);
        await markOutreached(handle);
        posted += 1;
        if (posted >= limit) return;
      }
    } catch (err) {
      await log("error", `outreach ${handle}: ${err.message}`);
    }
  }
}

// ── which conversation a handle lives in ─────────────────────────────────────

const THREADS_KEY = "fluidextension.threads";

/**
 * Read the open thread — and remember which conversation this handle is in.
 *
 * An inbox row shows a DISPLAY NAME. It carries no handle, no thread id and no
 * link (see `inboxRowElements`), so a lead FluidTalk knows as `lead_handle` is listed
 * as `𝕷𝖊𝖆𝖉` (a stylised display name) and looking for one inside the other
 * finds nothing. The only
 * moment both identities are visible at once is a thread that is already OPEN,
 * so that is where the pair gets recorded. Follow-ups then navigate straight to
 * the id instead of hunting the list for a label that was never going to match.
 *
 * `storage.local`, like every other ledger here: an MV3 worker is torn down when
 * idle, and an index that forgets is an index that silently stops working.
 */
async function readThread(ownHandle, target = null) {
  const thread = await askPage("ft:read", { ownHandle }, target);
  if (thread?.ok && thread.handle && thread.threadId) {
    // Recorded under THIS platform — the id means nothing on another one.
    const platformId = target?.platform.id ?? (await boundPlatformId());
    const key = outreachKey(THREADS_KEY, platformId);
    const index = await knownThreads(platformId);
    index[thread.handle.toLowerCase()] = { threadId: thread.threadId, seenAt: Date.now() };
    await chrome.storage.local.set({ [key]: index });
  }
  return thread;
}

/**
 * ⚠ PER PLATFORM — A THREAD ID IS ONLY VALID ON THE SITE IT CAME FROM.
 *
 * This was one map keyed by handle alone, and on Threads that is guaranteed to
 * collide: the sign-in IS the Instagram account, so the same person is the same
 * handle on both. Read live after a Threads conversation was opened:
 *
 *     a_lead     -> 900112233445566     (a THREADS id, overwriting Instagram's)
 *     another.lead  -> 17800112233445566   (an INSTAGRAM id, still there)
 *
 * Follow-ups navigate by this id, so each of those sends the pass to
 * `instagram.com/direct/t/<threads id>/` or `threads.com/messages/t/<instagram
 * id>/`. The `landed` check catches it — `ft:where` reports a different id and
 * the pass logs "could not open the thread" — so nobody is messaged in the
 * wrong conversation, but follow-ups simply stop working for every lead who
 * exists on both, silently, and the failure names the thread rather than the
 * ledger.
 */
async function knownThreads(platformId = null) {
  const key = outreachKey(THREADS_KEY, platformId);
  const { [key]: index = {} } = await chrome.storage.local.get(key);
  return index;
}

/** Point the platform tab at a URL and wait for it to settle. */
/**
 * ⚠ A NAVIGATION IS THE EXPENSIVE THING ON INSTAGRAM, so do not spend one to
 * arrive where we already are.
 *
 * `chrome.tabs.update({url})` is a FULL PAGE LOAD even when the URL is
 * identical — the SPA re-bootstraps and asks Instagram to resolve the routes
 * of every link it renders. Measured, one navigation to the inbox:
 *
 *     bulk-route-definitions requests: 9     (all 9 answered 429)
 *     reading the same page from the DOM: 0
 *
 * A cycle returns to the inbox constantly — at the start, between threads,
 * before follow-ups — and much of that is already where the tab is standing.
 * Over five and a half hours that came to 12,942 requests to that one
 * endpoint, rate-limited from eighteen minutes in and never recovering: a
 * sustained 46–130 per minute. With the sweep stopped the same page produced
 * ZERO in two minutes, which is what proves the traffic is ours.
 *
 * The hash is ignored on purpose — Telegram addresses a chat with `#@name`,
 * where changing it is the whole navigation and must not be skipped.
 */
async function goTo(url, waitMs = 8000, target = null) {
  const here = target ?? (await boundTarget());
  if (!here) throw new Error(`the active tab is not ${platformNames()}`);

  // Asked BY ID. `tabs.query` hands back whichever matching tab it likes, and
  // with a platform open twice that is often not ours — the comparison would
  // then be against a stale URL and quietly never match.
  const current = await chrome.tabs.get(here.tab.id).then((t) => t.url, () => here.tab.url);
  const sameHash = url.includes("#") || (current ?? "").includes("#");
  // ⚠ SKIPPING IS ONLY AN OPTIMISATION WHERE THE PAGE KEEPS ITSELF CURRENT.
  // A platform that never re-renders in place (Threads) gets nothing but a
  // stale snapshot out of it, cycle after cycle — see `rerenderOnRevisit`.
  if (!sameHash && current === url && !here.platform.rerenderOnRevisit) {
    await log("info", `already on ${url.replace(here.platform.origin, "")} — not reloading it`);
    return abortableSleep(400);
  }

  await chrome.tabs.update(here.tab.id, { url });
  return abortableSleep(waitMs);
}

/**
 * Navigate to one of the ACTIVE platform's named pages.
 *
 * The point is that the worker no longer knows any hostnames. A platform that
 * has no such page answers null, and this refuses rather than navigating: the
 * failure mode being avoided is a Telegram run quietly loading an Instagram URL
 * because the string was typed at the call site.
 */
async function goToRoute(name, args = [], waitMs = 8000, target = null) {
  const here = target ?? (await boundTarget());
  if (!here) throw new Error(`the active tab is not ${platformNames()}`);
  const url = routeFor(here.platform, name, ...args);
  if (!url) {
    await log("info", `${here.platform.label} has no "${name}" page — skipped`);
    return false;
  }
  return goTo(url, waitMs, target);
}

/**
 * Work the message-requests folder.
 *
 * Separate from the inbox pass and on its own budget: accepting a request is
 * not answering a message, it is letting somebody into the inbox, and the two
 * should not share a rate limit. Runs BEFORE the inbox pass so anything
 * accepted is answered by the same run.
 */
async function sweepRequests(settings, target = null) {
  if (!(await goToRoute("requests", [], 9000, target))) return;

  const rows = await askPage("ft:list-threads", { ownHandle: settings.ownUsername }, target);
  await log("info", `requests: ${rows.length} pending`);

  for (const row of rows) {
    if (await stopRequested()) return;

    const quota = await quotaFor("request", settings, target?.platform.id);
    if (quota.remaining <= 0) {
      await log("info", `requests: stopping — ${quotaSummary(quota)}`);
      return;
    }
    if (settings.maxThreadAgeDays > 0) {
      // The stamp is in the row's TEXT, which is not `label` on every platform.
      const age = ageDaysFromLabel(rowText(row));
      if (age !== null && age > settings.maxThreadAgeDays) continue;
    }

    /**
     * ⚠ NAVIGATE WHEN THE ROW HAS AN ID; CLICKING ONE IS WHAT LOOKED BROKEN.
     *
     * A Threads requests row is a real anchor to `/messages/t/<id>/`, and
     * clicking it lands somewhere with no composer, no Accept and no thread id
     * — which is why `requests` was written off as "the folder reads but a row
     * does not open into anything". Going to the address instead lands on a
     * working request, and navigating by id proves itself where a click can
     * only prove that something changed.
     */
    let landed = false;
    if (row.threadId) {
      if (await goToRoute("thread", [row.threadId], 9000, target)) {
        const where = await askPage("ft:where", {}, target);
        landed = where.threadId === row.threadId;
      }
      if (!landed) {
        await log("error", `requests: could not open ${rowText(row).slice(0, 30)}`);
        continue;
      }
    } else {
      const opened = await askPage("ft:open-thread", { label: row.label }, target);
      if (!opened.clicked) continue;
      if (!(await abortableSleep(5000))) return;
      landed = true;
    }

    const result = await askPage("ft:accept-request", { dryRun: false }, target);
    if (result.ok) {
      await recordCounter("request", target?.platform.id);
      await log("info", `accepted request from ${rowText(row).slice(0, 30)}${result.folder ? ` → ${result.folder}` : ""}`);
      if (!(await abortableSleep(2500))) return;

      /**
       * ⚠ ACCEPTING DOES NOT TURN THE PAGE INTO A NORMAL THREAD — on a platform
       * that re-renders nothing, it cannot. The request view has Accept, Block
       * and Delete and NO COMPOSER, and it still has none a moment after the
       * click, so the answer below was typed into a thread that could not take
       * it: "third.lead: bubble 1 did not appear in the thread", nothing
       * delivered, on a request that HAD been accepted. Navigating to the same
       * thread afterwards gives a composer and the identical send lands first
       * time — measured, 2/2 delivered and confirmed.
       *
       * Only where the platform says so. Instagram's accepted request is usable
       * on the spot, and a needless reload there is a page load this pass has
       * been beaten up for before.
       */
      if (target?.platform.rerenderOnRevisit && row.threadId) {
        await goToRoute("thread", [row.threadId], 9000, target);
        if (!(await abortableSleep(1500))) return;
      }

      // Answer it HERE, while we are standing in the thread. Leaving it to the
      // inbox pass was the other half of the bug: that pass takes its thread
      // list once, before this accept happened, so a just-accepted request was
      // not in it and went unanswered until some later run.
      try {
        const gen = await generate({ force: false, target });
        if (gen.bubbles?.length) {
          await sendBubbles(gen.thread, gen.bubbles, target);
        } else {
          await log("info", `${gen.thread?.handle ?? "request"}: accepted, nothing to say yet (${gen.silent ?? gen.skipped ?? "no reason"})`);
        }
      } catch (err) {
        await log("error", `accepted but could not reply: ${err.message}`);
      }
    } else {
      // Refusing is the designed outcome when the controls are ambiguous —
      // say so, because silence here would look like "no requests".
      await log("error", `request ${rowText(row).slice(0, 25)}: ${result.reason}`);
    }
    await goToRoute("requests", [], 7000, target);
  }
}

/**
 * Age of a conversation in days, read off the inbox row's own timestamp
 * ("· 1 tydz.", "· 17 tyg.", "· 5 min"), or null when it cannot be parsed.
 *
 * Instagram writes that stamp in the ACCOUNT'S language, so this is locale
 * bound like the placeholder patterns. It therefore fails OPEN: an age it
 * cannot read returns null and the thread is processed normally. The opposite
 * default would let one unrecognised locale silently filter out the whole
 * inbox while reporting a clean run.
 */
const AGE_UNITS = [
  { re: /^(min|m|mins?|minutes?)$/i, days: 1 / 1440 },
  { re: /^(godz|h|hr|hrs|hours?)$/i, days: 1 / 24 },
  { re: /^(d|dni|dzie[nń]|days?)$/i, days: 1 },
  { re: /^(tydz|tyg|w|wk|weeks?)$/i, days: 7 },
  { re: /^(mies|msc|mo|months?)$/i, days: 30 },
  { re: /^(rok|lat|lata|y|yr|years?)$/i, days: 365 },
];

/**
 * What a reader sees on an inbox row, wherever that platform puts it.
 *
 * Instagram's `label` IS the row text; Threads' `label` is the row's index (its
 * rows carry no id until opened, so `ft:open-thread` needs something it can
 * address) and the text is in `title`. Anything matching a handle or reading
 * the "· 1 tydz." stamp wants this, not `label`.
 */
function rowText(row) {
  return String(row?.title ?? row?.label ?? "");
}

function ageDaysFromLabel(label) {
  const m = String(label ?? "").match(/·\s*(\d+)\s*([\p{L}.]+)/u);
  if (!m) return null;
  const unit = m[2].replace(/\.+$/, "");
  const hit = AGE_UNITS.find((u) => u.re.test(unit));
  return hit ? Number(m[1]) * hit.days : null;
}

/**
 * Walk the inbox and answer what is owed a reply.
 *
 * Only ever replies to an EXISTING conversation whose newest message is theirs.
 * It cannot start one: there is no path here that opens a profile or composes
 * to somebody who has not written first.
 *
 * The order of the guards matters. Cheap, local refusals (nothing to reply to,
 * unreadable, over quota) come before `generate`, because generate is a billed
 * turn — deciding to skip after paying for a reply wastes the charge and puts a
 * conversation in FluidTalk's history that we never continued.
 */
async function runCycle(target = null, n = 1, { only = null } = {}) {
  // A TARGETED cycle: the page woke us naming the rows that changed, so this
  // pass is about those and nothing else. The expensive periodic passes below
  // (follow-ups, comments, outreach) stay on the scheduled cycles — they are
  // not what a new message is asking for, and running them on every inbound
  // would turn the cheapest path into the most expensive one.
  const targeted = Boolean(only?.size);
  const settings = await currentSettings(target);
  const ownHandle = await resolveOwnHandle(target);
  if (!ownHandle) throw new Error(`could not tell which account is signed in — open ${platformNames()}`);
  settings.ownUsername = ownHandle;

  // Two gates on every pass below, and they are different questions: the
  // SETTING is whether the user wants it, the CAPABILITY is whether the site in
  // front of us even has such a thing. Telegram has no feed, no followers, no
  // message-requests folder and no public comments, so without this a Telegram
  // run would attempt four passes that can only fail — and each would report
  // its failure as though something had gone wrong.
  const here = target ?? (await boundTarget());
  const can = (c) => supports(here?.platform, c);

  // Thread ids we have already visited THIS CYCLE — two inbox rows can resolve
  // to the same conversation, and answering it twice is a visible mistake. It
  // is deliberately per-cycle: across cycles the same thread SHOULD be revisited,
  // because by then it may hold a new message.
  const answered = new Set();

  {
    if (!targeted && settings.acceptRequests && can("requests")) await sweepRequests(settings, target);
    if (await stopRequested()) return;

    // Back to the inbox: the requests pass leaves the tab on /direct/requests/.
    await goToRoute("inbox", [], 9000, target);

    let threads = await askPage("ft:list-threads", { ownHandle: settings.ownUsername }, target);
    if (targeted) {
      const picked = threads.filter((t) => only.has(String(t.label)) || only.has(String(t.peerId ?? "")));
      // A MISS MEANS THE WATCHER AND THE LISTER DISAGREE about what a row is
      // called — the watcher reads the DOM directly, the lister may filter or
      // rename. Falling back to the whole inbox keeps that a latency bug rather
      // than a silent no-op that quietly answers nobody, which is exactly the
      // failure this whole change exists to remove.
      if (picked.length) {
        threads = picked;
        await log("info", `woken for ${picked.length} conversation(s) — opening just those`);
      } else {
        await log("error", `woken for ${only.size} row(s) but none matched the inbox — sweeping all`);
      }
    } else {
      await log("info", `sweep sees ${threads.length} conversation(s) in the inbox`);
    }

    for (const row of threads) {
      if (await stopRequested()) {
        await log("info", "sweep stopped");
        break;
      }
      await setSweep({ current: rowText(row).slice(0, 40) }, target?.platform.id);

      // Age filter, decided from the row itself so an over-old thread is never
      // even opened — opening it would mark it read for nothing.
      if (settings.maxThreadAgeDays > 0) {
        const age = ageDaysFromLabel(rowText(row));
        if (age !== null && age > settings.maxThreadAgeDays) {
          await bumpSweep("skipped", target?.platform.id);
          continue;
        }
      }

      const opened = await askPage("ft:open-thread", { label: row.label }, target);
      if (!opened.clicked) {
        await bumpSweep("skipped", target?.platform.id);
        continue;
      }
      // The thread renders asynchronously; reading too early looks like an
      // empty conversation, which is indistinguishable from a parse failure.
      if (!(await abortableSleep(6000))) break;

      // A click that did not land leaves the PREVIOUS thread on screen, and
      // everything below would then answer whoever that was — the sweep would
      // message the wrong person while reporting the row it meant to open. The
      // thread id has to have actually changed.
      // A click that did not land leaves the PREVIOUS thread on screen, so
      // "the thread changed" is the proof that it opened. With one exception,
      // and it was skipping people: if the row we want is ALREADY the open
      // chat, nothing changes and this read as a failure — so the conversation
      // the tab happened to be sitting on got skipped every single cycle, which
      // on a two-chat account is half the inbox. `alreadyOpen` is the adapter
      // saying it checked the open chat IS the one asked for: a different
      // proof, not a weaker one.
      const where = await askPage("ft:where", {}, target);
      if (!where.threadId || (where.threadId === opened.before && !opened.alreadyOpen)) {
        await log("error", `could not open "${rowText(row).slice(0, 30)}" — still on ${opened.before ?? "no thread"}`);
        await bumpSweep("skipped", target?.platform.id);
        continue;
      }
      if (answered.has(where.threadId)) {
        await bumpSweep("skipped", target?.platform.id);
        continue; // two rows resolved to one thread
      }
      answered.add(where.threadId);

      const thread = await readThread(settings.ownUsername, target);
      if (!thread.ok || !thread.lastInbound) {
        // Say WHY when the adapter refused on purpose. "3 skipped" is the same
        // number whether a conversation was simply up to date or whether we
        // declined to talk to a bot, and those are not the same fact — a run
        // that skipped everything for a deliberate reason has to be readable as
        // such. `no_messages` is left silent: it is the ordinary case.
        if (thread.reason && thread.reason !== "no_messages") {
          await log("info", `${rowText(row).slice(0, 30)}: skipped — ${thread.reason}`);
        }
        await bumpSweep("skipped", target?.platform.id);
        continue; // nothing owed: the last word is ours, or it did not load
      }
      // NOTHING CAN BE SENT HERE — checked BEFORE generating, because
      // `generate()` is a billed turn and this thread cannot receive its
      // result. On Instagram a message request the lead has not accepted has
      // no composer at all, so a reply, a follow-up and a retry are equally
      // impossible; the old order spent the money first and discovered it
      // afterwards as "composer not found".
      //
      // This is also what makes Instagram's system notices harmless without
      // matching their text in any locale: a thread we cannot answer is never
      // owed a reply, whatever the notice says.
      if (thread.canSend === false) {
        if (thread.handle) await markUnreachable(thread.handle, target?.platform.id);
        await log("info", `${thread.handle ?? rowText(row).slice(0, 30)}: skipped — they have not accepted the request, so nothing can be sent`);
        await bumpSweep("skipped", target?.platform.id);
        continue;
      }
      if (thread.lastInboundUnreadable && !settings.describeUnreadable) {
        await log("info", `${thread.handle}: skipped — their last message is one Instagram will not show us`);
        await bumpSweep("skipped", target?.platform.id);
        continue;
      }

      if (thread.neverAnswered) {
        const quota = await newThreadQuota(target?.platform.id);
        if (quota.remaining <= 0) {
          await log("info", `${thread.handle}: skipped — new conversations at their ${quotaSummary(quota)}`);
          await bumpSweep("skipped", target?.platform.id);
          continue;
        }
      }

      // Last gate before money is spent: generate is a billed turn, so a stop
      // pressed while the thread was loading must not still pay for a reply.
      if (await stopRequested()) {
        await log("info", "sweep stopped");
        break;
      }

      // THE SAME CLAIM THE AUTO-REPLY TAKES, and it has to be shared or it
      // guards nothing. The sweep answering a thread takes 4–12 seconds PER
      // BUBBLE, and our own bubbles landing mutate the page — which fires the
      // watcher, which calls `onThreadChanged`, which finds `alreadyReplied`
      // still false because that is only written after the LAST bubble. It
      // then calls `generate`, gets the CACHED draft back (no FluidTalk call,
      // so FluidTalk's own duplicate guard never sees it) and sends the very
      // same reply a second time. Measured on a live Telegram thread: the
      // lead received the identical answer twice.
      if (!claimReply(thread.threadId)) {
        await bumpSweep("skipped", target?.platform.id);
        continue;
      }
      try {
        const result = await generate({ force: false, target });
        if (result.skipped || !result.bubbles?.length) {
          await bumpSweep("skipped", target?.platform.id);
        } else {
          const sent = await sendBubbles(result.thread, result.bubbles, target);
          await bumpSweep(sent.some((s) => s.ok) ? "sent" : "skipped", target?.platform.id);
        }
      } catch (err) {
        await log("error", `${thread.handle}: ${err.message}`);
        await bumpSweep("skipped", target?.platform.id);
      } finally {
        releaseReply(thread.threadId);
      }

      // Off by default: the work between threads already takes several
      // seconds, so an extra wait mostly makes a run take all day.
      if (settings.pauseBetweenThreads && !(await abortableSleep(settings.betweenThreadsMs))) break;
    }

    // Then follow-ups: a nudge to someone who already knows us ranks above a
    // cold open to somebody who does not.
    if (!targeted && settings.followupsEnabled && can("followups") && !(await stopRequested())) {
      await goToRoute("inbox", [], 8000, target);
      await runFollowups(settings, { target });
    }

    // Replies to our comments BEFORE new comments: somebody who answered us in
    // public is owed a reply, and spending the run's remaining time on fresh
    // posts instead leaves that conversation visibly hanging.
    //
    // ⚠ BUT NOT EVERY CYCLE. Finding out whether anyone replied costs a load of
    // the NOTIFICATIONS page, and that page is by far the most expensive thing
    // this run touches: measured at ~40 requests to Instagram's
    // `bulk-route-definitions` per load, against 9 for the inbox. Paying it
    // every ninety seconds is most of the traffic that gets us rate-limited,
    // and almost all of it discovers nothing new.
    //
    // A DM is time-critical and still runs every cycle; a public comment reply
    // is not, and a few minutes later is indistinguishable to the person who
    // wrote it.
    if (
      !targeted &&
      settings.commentRepliesEnabled &&
      can("commentReplies") &&
      n % COMMENT_PASS_EVERY === 0 &&
      !(await stopRequested())
    ) {
      await runCommentReplies(settings, { target });
    }

    // Same cadence, and for the same reason: this pass loads a PROFILE page
    // per candidate author and a POST page per candidate post, and most of
    // those end in "has no readable posts" or "no comment box". Commenting on
    // a stranger's post is the least time-critical thing the run does.
    if (!targeted && settings.commentsEnabled && can("comments") && n % COMMENT_PASS_EVERY === 0 && !(await stopRequested())) {
      await runComments(settings, { target });
    }

    // Outreach LAST: answering people who are waiting always comes before
    // starting conversations with people who are not.
    if (!targeted && settings.outreachEnabled && can("outreach") && !(await stopRequested())) await runOutreach(settings, target);
  }
}

/**
 * How long to wait after a cycle finds nothing left to do.
 *
 * A cycle is not free — it reloads the inbox and opens threads — so this is the
 * floor on how often the account is touched, not a polling rate to minimise.
 * Jittered because a request landing on the same second of every minute is a
 * pattern, and this runs for hours.
 */
const IDLE_CYCLE_MS = 90_000;

/**
 * How often the public-comment passes run, in cycles.
 *
 * Five, because discovering whether anyone replied costs a load of the
 * notifications page — measured at ~40 `bulk-route-definitions` requests
 * against the inbox's 9 — and almost every one of those finds nothing new.
 */
const COMMENT_PASS_EVERY = 5;

/**
 * How many unconfirmed follow-up attempts before a handle is left alone.
 * Three, because the failure this guards against delivered sixteen copies of
 * one sentence to somebody who never replied.
 */
const MAX_UNCONFIRMED = 3;
const IDLE_JITTER_MS = 30_000;

/**
 * Run until the user stops, or the browser closes.
 *
 * A run used to be ONE pass: it answered everyone waiting and then reported
 * "finished", which is the wrong shape for what this is. Nobody wants a thing
 * that replies to the current inbox and then goes quiet — they want it watching.
 * So a cycle is now the unit of work and this is the loop around it, and
 * "finished" only ever means stopped.
 *
 * WHY THE BROWSER CLOSING IS THE OUTER BOUND, for free: `running` lives in
 * `chrome.storage.session`, which the browser clears on exit. So a run cannot
 * outlive the browser, and cannot silently resurrect on the next launch — that
 * is a property of where the flag is kept, not a rule anybody has to enforce.
 *
 * Errors inside a cycle end THAT CYCLE, not the run. A closed tab, a page that
 * stopped answering, a FluidTalk outage — every one of those is temporary, and a
 * watcher that exits on the first of them is a watcher you have to keep
 * restarting. They are logged and the next cycle tries again.
 */
/**
 * Work ONE platform until the run is stopped.
 *
 * The tab is re-resolved every cycle rather than captured once, so closing and
 * reopening a platform mid-run is picked up without restarting — and a
 * platform whose tab is gone waits for it to come back instead of killing the
 * loop. Whether it is still set up is re-read for the same reason: standing a
 * platform down in the panel has to stop it, not merely stop the next run.
 */
/**
 * Some platforms only finish loading while their tab is ON SCREEN.
 *
 * Measured, and the operator spotted it before I did: WhatsApp sits on "your
 * messages are downloading" indefinitely in a hidden tab and completes within
 * FIVE SECONDS of being shown (`ready:false, rows:0` → `ready:true, rows:3`).
 * Telegram is worse — it renders 21 divs and no chat list at all, for as long
 * as you leave it. Instagram does not care.
 *
 * Chrome starves a hidden tab on purpose and no content script can opt out of
 * it, so the only remedy is to show the tab. This shows it BRIEFLY and only
 * while the platform says it is not ready — once loaded, all three work
 * perfectly well hidden, so this costs one flash per platform per browser
 * session rather than a permanent claim on the screen.
 *
 * The previously-active tab is put back afterwards: a run that silently
 * steals what the user is looking at, every cycle, is its own kind of broken.
 */
const WAKE_TIMEOUT_MS = 45_000;

/**
 * Is the content script on this tab still there — and if not, put it back.
 *
 * RELOADING THE EXTENSION ORPHANS EVERY CONTENT SCRIPT ALREADY INJECTED. The
 * page keeps running, the tab looks perfectly normal, and `sendMessage` to it
 * fails with "Receiving end does not exist" for ever: nothing re-injects a
 * content script except a navigation. So after any extension restart, every
 * platform tab that was already open is silently dead, and the only symptom
 * is that that platform stops replying. Measured exactly that way — Instagram
 * orphaned mid-cycle while Telegram and WhatsApp carried on, with no error
 * anywhere the operator could see.
 *
 * It never self-heals, which is what makes it worth automating: one reload
 * fixes it, and the loop can do that itself rather than waiting for somebody
 * to notice. Reloading costs a page load — and on WhatsApp a history resync —
 * so it happens only when the script is actually confirmed absent.
 */
/**
 * A page that has stopped answering is not the same as a slow one.
 *
 * `askPage` waits two minutes before giving up, which is right for a real
 * call — a video re-encode takes a while — and badly wrong as a health check.
 * A tab that is wedged ("page unresponsive", a crashed renderer, a content
 * script orphaned by an extension restart) then costs 120 SECONDS PER CALL,
 * so a fifteen-thread Instagram cycle spends half an hour failing and the run
 * cannot even be stopped in between. Observed exactly that: the loops stayed
 * "busy" through a two-minute stop request.
 *
 * Readiness is a question the adapter answers immediately or not at all, so
 * it gets its own short deadline and a slow answer is treated as no answer.
 */
const READY_PROBE_MS = 10_000;

async function probeReady(target) {
  /**
   * ⚠ A SUSPENDED TAB CANNOT ANSWER, AND THE BROWSER WILL TELL YOU SO.
   *
   * `targetFor` already steps over a sleeping tab when a platform has several.
   * With only ONE it cannot — there is nothing else to pick — so the probe used
   * to spend its whole deadline on a question that was already answered, and
   * every later `askPage` to that tab then waited the full two-minute call
   * timeout. The platform simply goes quiet, which is the worst shape a failure
   * can take.
   *
   * Read FRESH rather than trusting the tab object this was resolved with: it
   * may be seconds old, and treating an awake tab as asleep would send the heal
   * off to navigate a page that was working — on Instagram that is exactly the
   * traffic that earns a 429.
   */
  const asleep = await chrome.tabs.get(target.tab.id).then((t) => Boolean(t.frozen || t.discarded), () => false);
  if (asleep) return { alive: false, ready: false, error: "the browser has put this tab to sleep" };

  const answer = await Promise.race([
    askPage("ft:ready", {}, target).then(
      (r) => ({ alive: true, ready: Boolean(r?.ready), why: r?.why, needsHuman: Boolean(r?.needsHuman) }),
      (err) => ({ alive: !/no FluidExtension/.test(err?.message ?? ""), error: err?.message }),
    ),
    new Promise((r) => setTimeout(() => r({ alive: false, error: "the page stopped answering" }), READY_PROBE_MS)),
  ]);
  return answer;
}

async function ensureAlive(target) {
  const label = target.platform.label;
  const probe = await probeReady(target);
  if (probe.alive) {
    noteReachable(target.tab.id);
    return probe;
  }

  // The same backoff the panel uses, for the same reason: a sweep runs a cycle
  // a minute, and a tab sitting on Instagram's HTTP 429 would be reloaded on
  // every one of them — hammering the rate limit that caused it. A platform
  // skipped for a few minutes is the correct outcome there.
  const state = healAttempts.get(target.tab.id) ?? { n: 0, at: 0 };
  const wait = state.n === 0 ? 0 : Math.min(HEAL_BASE_MS * 2 ** (state.n - 1), HEAL_MAX_MS);
  if (Date.now() - state.at < wait) {
    return { alive: false, error: `${probe.error ?? "not answering"} — waiting before reloading it again` };
  }
  healAttempts.set(target.tab.id, { n: state.n + 1, at: Date.now() });

  await log("error", `${label}: ${probe.error ?? "this tab is not answering"} — repairing it`);
  try {
    // Through `reviveTab`, which NAVIGATES to the inbox rather than
    // re-requesting whatever URL the tab is stuck on — a reload of a page the
    // site is refusing just earns the same refusal. And never `bypassCache`:
    // on Telegram that poisons the service-worker shell, so the app boots to a
    // 21-div skeleton with no chat list and no console error, indefinitely,
    // and only closing the tab clears it because the shared workers outlive a
    // reload. A heal that bricks the tab is worse than the fault.
    await reviveTab(target);
  } catch {
    return { alive: false, error: "the tab went away" };
  }
  // A reload is a page load; the script lands at document_idle and the app
  // behind it takes longer still.
  for (let waited = 0; waited < WAKE_TIMEOUT_MS; waited += 2000) {
    await sleep(2000);
    const again = await probeReady(target);
    if (again.alive) {
      // Recovered, so the backoff starts clean next time.
      noteReachable(target.tab.id);
      await log("info", `${label}: back after a reload`);
      return again;
    }
  }

  // NOW REPLACE THE TAB OUTRIGHT. A renderer wedged hard enough to ignore a
  // navigation is not going to honour a reload either, and there is a state
  // past that which nothing in the tab can clear: measured on WhatsApp, the
  // page rendered and the content script logged "adapter ready" while every
  // `ft:*` message went unanswered — including ones that only reach a
  // synchronous `default:`. A new tab answered in ONE MILLISECOND. Telegram is
  // already documented the same way: its shared workers survive a reload and
  // only go when the last client does.
  await log("error", `${label}: still unreachable after a reload — replacing the tab, which is the only thing that clears this`);
  try {
    await reviveTab(target, 2);
  } catch {
    return { alive: false, error: "the tab could not be replaced" };
  }
  for (let waited = 0; waited < WAKE_TIMEOUT_MS; waited += 2000) {
    await sleep(2000);
    const again = await probeReady(target);
    if (again.alive) {
      // Recovered, so the backoff starts clean next time.
      noteReachable(target.tab.id);
      await log("info", `${label}: back on a fresh tab`);
      return again;
    }
  }
  return { alive: false, error: "no extension on this tab after reloading it and replacing it" };
}

/**
 * How many times in a row a tab has been shown and still not become ready.
 * Keyed by tab id, cleared the moment it works.
 */
const notReadyRuns = new Map();

async function ensureReady(target) {
  const label = target.platform.label;
  const probe = await ensureAlive(target);
  if (!probe.alive) {
    await log("error", `${label}: ${probe.error}`);
    return false;
  }
  const ready = probe.ready ? { ready: true } : { ready: false, why: probe.why };
  if (ready.ready) return true;

  // SOME "NOT READY" IS A JOB FOR A HUMAN, and the worst thing to do is try.
  // A signed-out WhatsApp is the case: showing the tab changes nothing, and
  // the last-resort tab replacement would throw the QR code away every couple
  // of minutes — destroying the one thing the user has to scan. Report it and
  // leave the tab exactly as it is.
  if (probe.needsHuman) {
    await log("error", `${label}: ${ready.why}`);
    return false;
  }

  const [was] = await chrome.tabs.query({ active: true, windowId: target.tab.windowId });
  await log("info", `${label}: ${ready?.why ?? "not ready"} — showing its tab to let it finish`);
  try {
    await chrome.windows.update(target.tab.windowId, { focused: true });
    await chrome.tabs.update(target.tab.id, { active: true });
  } catch {
    // The tab went away between resolving it and showing it.
    return false;
  }

  let ok = false;
  for (let waited = 0; waited < WAKE_TIMEOUT_MS && !ok; waited += 1500) {
    await sleep(1500);
    ok = Boolean((await askPage("ft:ready", {}, target).catch(() => null))?.ready);
  }
  if (was && was.id !== target.tab.id) await chrome.tabs.update(was.id, { active: true }).catch(() => {});
  if (ok) {
    notReadyRuns.delete(target.tab.id);
    await log("info", `${label}: ready now`);
    return true;
  }

  // ⚠ REACHABLE BUT NEVER READY IS ITS OWN FAULT, and nothing above catches it.
  // `ensureAlive` only replaces a tab that stops ANSWERING; a wedged Telegram
  // answers `ft:ready` perfectly well and simply never renders — measured here
  // as `divs: 21, rows: 0` while its tab was focused and on screen, so it was
  // not a visibility problem either. Showing the tab cannot fix it: the shared
  // workers behind it survive a reload and only go when the last client does.
  //
  // Two failed wake attempts is the signal — one can be a slow boot, twice
  // while on screen is the wedge. Replacing the tab is the documented cure.
  const runs = (notReadyRuns.get(target.tab.id) ?? 0) + 1;
  notReadyRuns.set(target.tab.id, runs);
  if (runs < 2) {
    await log("error", `${label}: still not ready after showing its tab`);
    return false;
  }

  await log("error", `${label}: not ready twice while on screen — replacing the tab, which is the only thing that clears this`);
  notReadyRuns.delete(target.tab.id);
  try {
    await reviveTab(target, 2);
  } catch {
    return false;
  }
  for (let waited = 0; waited < WAKE_TIMEOUT_MS; waited += 2000) {
    await sleep(2000);
    if ((await probeReady(target)).ready) {
      await log("info", `${label}: ready on a fresh tab`);
      return true;
    }
  }
  return false;
}

async function platformLoop(platformId) {
  const label = platformById(platformId)?.label ?? platformId;
  sweepLoopAlive.add(platformId);
  try {
    while (!(await stopRequested())) {
      if (!platformConfigured(await loadStore(), platformId)) {
        await log("info", `${label}: not set up — stopping its loop`);
        break;
      }
      // THE BOUNDARY, CHECKED WHERE THE WORK IS, not only on the minute tick.
      // The tick is what normally closes a window, but it is a timer and this
      // is the loop that actually opens conversations: one missed alarm — a
      // suspended laptop, a worker restarting at the wrong moment — must not
      // buy a scheduled run another cycle on somebody's account. A manual run
      // is left alone here for the same reason the tick leaves it alone.
      if ((await sweepState()).reason === "schedule") {
        const st = scheduleState(await loadSettings(platformId), new Date());
        if (st.enabled && !st.open) {
          await log("info", `${label}: the schedule closed — stopping`);
          break;
        }
      }

      const target = await targetFor(platformId);
      if (!target) {
        await setSweep({ waiting: true, current: null }, platformId);
        await log("error", `${label}: no tab open — waiting for one`);
        if (!(await abortableSleep(IDLE_CYCLE_MS))) break;
        continue;
      }

      // Before anything is read: a platform still loading reports an empty
      // inbox, which a run cannot tell from an inbox with nobody in it.
      if (!(await ensureReady(target))) {
        await setSweep({ waiting: true, current: null }, platformId);
        if (!(await abortableSleep(IDLE_CYCLE_MS))) break;
        continue;
      }

      const n = ((await sweepState()).per?.[platformId]?.cycles ?? 0) + 1;
      await setSweep({ cycles: n, waiting: false, lastTick: Date.now() }, platformId);
      // Why this cycle is running. A cycle woken by the page knows exactly which
      // rows changed, so it works those and skips the rest of the inbox — the
      // difference between answering one person and re-opening every
      // conversation to discover that nothing else moved.
      const only = takePendingWork(platformId);
      // Held for the WHOLE cycle: opening, reading, generating and sending
      // all assume the conversation has not moved underneath them.
      const heldTab = claimPlatform(platformId);
      try {
        if (!heldTab) throw new Error("another run is already driving this tab");
        await runCycle(target, n, { only });
      } catch (err) {
        // One bad platform is not the end of the run, and naming it matters:
        // with three loops interleaving, "cycle 3 failed" says nothing.
        await log("error", `${label} cycle ${n} failed: ${err.message}`);
      } finally {
        if (heldTab) releasePlatform(platformId);
      }
      if (await stopRequested()) break;

      // Its OWN gap, jittered independently. A shared one would make three
      // platforms fire on the same second, which is the pattern the jitter
      // exists to break.
      const wait = IDLE_CYCLE_MS + Math.floor(Math.random() * IDLE_JITTER_MS);
      const mine = (await sweepState()).per?.[platformId] ?? {};
      await setSweep({ waiting: true, current: null, waitingUntil: Date.now() + wait, lastTick: Date.now() }, platformId);
      await log("info", `${label} cycle ${n} done — ${mine.sent ?? 0} replied there; watching`);
      // Cut short the moment the page reports a change, so the gap is the floor
      // on touching an IDLE account, not the latency of answering a live one.
      if (!(await abortableSleep(wait, platformId))) break;
    }
  } finally {
    sweepLoopAlive.delete(platformId);
    await setSweep({ waiting: false, current: null }, platformId);
  }
}

// ── the schedule ─────────────────────────────────────────────────────────────

/**
 * The window whose opening the user has already answered by pressing Stop.
 *
 * ⚠ THE SCHEDULE ACTS ON EDGES, NOT ON STATE, and this is what makes that true.
 * A tick that started a run whenever it found itself inside a window would
 * restart the run sixty seconds after anybody stopped one, for the rest of the
 * afternoon — the button would look broken, and the only way to actually stop
 * for the day would be to switch the whole schedule off.
 *
 * Kept in `storage.session`, which is deliberately weaker than it looks: it
 * survives the worker being torn down, and the browser clears it on exit. So
 * "I stopped this afternoon" lasts the afternoon, and a browser restarted
 * inside a window starts working again — which is the same rule as a browser
 * launched inside one for the first time.
 */
const SUPPRESS_KEY = "fluidextension.scheduleSuppressed";

async function suppressedWindow() {
  return (await chrome.storage.session.get(SUPPRESS_KEY))[SUPPRESS_KEY] ?? null;
}

/** Remember that this window has been stopped by hand. Cheap and idempotent. */
async function suppressWindow(platformId, startAt) {
  await chrome.storage.session.set({ [SUPPRESS_KEY]: { platform: platformId, startAt } });
}

/**
 * The last thing the schedule said, so it does not say it sixty times an hour.
 *
 * A tick runs every minute for as long as the browser is open. Every refusal it
 * can hit — no token, no tab, an unreadable week — is a standing condition
 * rather than an event, so logging one per tick would bury the actual work in a
 * day of identical lines. Module-level: it is a fact about this worker's
 * conversation with the user, not state worth surviving a restart.
 */
/**
 * ⚠ KEYED, because one slot is not a dedupe — it is two callers overwriting
 * each other. The tick says "nothing will run by itself" and the auto-reply
 * gate says "somebody wrote and got no answer": different facts, both worth
 * saying, and with a single slot they take turns clearing it and the pair goes
 * into the log every minute until morning. Found exactly that way.
 */
const scheduleNotes = new Map();

async function noteOnce(key, level, message) {
  if (scheduleNotes.get(key) === message) return;
  scheduleNotes.set(key, message);
  await log(level, message);
}

/**
 * One minute's worth of "should this account be awake".
 *
 * Reads the same `scheduleState` the panel and the auto-reply gate read, so
 * there is exactly one answer to that question in the extension.
 *
 * Deliberately does NOTHING to a run it did not start, in either direction: a
 * manual run is not stopped when the window closes, and a window opening while
 * one is already going is not a second start.
 */
async function tickSchedule() {
  const id = await boundPlatformId();
  if (!id) return;
  const settings = await loadSettings(id);
  const st = scheduleState(settings, new Date());
  if (!st.enabled) {
    scheduleNotes.clear();
    return;
  }

  let sweep = await sweepState();
  // A `stopping` flag with no loop behind it is one the worker was torn down
  // in the middle of. Clearing it here as well as in the Stop handler is not
  // belt-and-braces — this is the only path that can reach a flag left behind
  // by a worker that died, and every scheduled start refuses while it is set.
  if (!sweep.running && sweep.stopping) sweep = await setSweep({ stopping: false });
  const mine = sweep.running && sweep.reason === "schedule" && !sweep.stopping;

  // An unreadable week fails closed — see `parseSchedule`. Said once, and
  // loudly, because the symptom is an account that simply stops answering.
  if (st.broken) {
    await noteOnce("tick", "error", `the schedule cannot be read (${st.errors.join("; ")}) — nothing will run by itself until it is fixed`);
    if (mine) await setSweep({ stopping: true });
    return;
  }

  if (!st.open) {
    if (mine) {
      const until = st.next ? ` until ${dayName(st.next.day)} ${st.next.from}` : "";
      scheduleNotes.clear();
      await log("info", `the schedule closed — finishing the conversation on screen, then sleeping${until}`);
      await setSweep({ stopping: true });
    }
    return;
  }

  // Inside the hours. Anything already running — ours or the user's — is left
  // alone; this is not a second start.
  if (sweep.running || sweep.stopping) return;
  // The opening minute is spread across a fleet, so the window is open before
  // THIS account is due to wake.
  if (Date.now() < st.window.opensAt) return;
  const suppressed = await suppressedWindow();
  if (suppressed?.platform === id && suppressed.startAt === st.window.startAt) return;

  try {
    const started = await prepareSweep({ reason: "schedule", openTab: true });
    scheduleNotes.clear();
    runSweep(started).catch((err) => log("error", `the scheduled run failed: ${err.message}`));
  } catch (err) {
    // Standing conditions, once each: "configure connector token first" every
    // minute would be a log nobody can read the real events out of.
    await noteOnce("tick", "error", `the schedule is open but nothing can run — ${err.message}`);
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayName = (index) => DAY_NAMES[index] ?? "";

/**
 * Everything that can refuse a run, checked BEFORE one is reported as started.
 *
 * Split out because `ft:sweep-start` cannot await the run itself — a sweep
 * lasts for hours and the panel has to stay responsive enough to press Stop —
 * so it used to fire the whole thing off and answer `{started: true}` come what
 * may. Every refusal below then surfaced only as a line in the log, while the
 * button sat there saying Running. "Not set up yet" is exactly the message a
 * user needs in front of them, and it was the one place it could not appear.
 *
 * Returns the platform to work; throws the reason not to.
 */
async function prepareSweep({ reason = "manual", openTab = false } = {}) {
  const settings = await currentSettings();
  const missing = missingConfig(settings);
  if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
  if ((await sweepState()).running) throw new Error("a sweep is already running");

  // ONE PLATFORM: THE BOUND ONE.
  //
  // This used to start a loop per platform and run all of them at once. It no
  // longer does — exactly one platform can be bound, and a run is about that
  // one. Two consequences worth naming, because both were deliberate features
  // of the old shape and are gone: a lead who writes on a platform that is not
  // bound waits until it is, and the "one window per platform" arrangement
  // Chrome's hidden-tab starving forced is no longer needed for anything.
  //
  // No separate "is it set up" check: `boundPlatformId` only ever answers with
  // a bound platform, so the two questions have one answer now.
  const id = await boundPlatformId();
  if (!id) throw new Error("no platform is bound — bind one in Settings first");
  const platform = platformById(id);
  let target = await targetFor(id);

  // A SCHEDULED RUN OPENS ITS OWN TAB; a run somebody pressed Start for does
  // not. The difference is who is there: the panel can say "no Instagram tab is
  // open" to a person looking at it, and they open one. Nobody is looking at
  // 09:00 on an unattended profile, so a schedule that refused for want of a
  // tab would be a schedule that never ran — and the fleet case, where a
  // profile is launched and left alone, is the one this feature is for.
  //
  // Not awaited into readiness here: the loop already re-resolves the tab every
  // cycle and waits for one that is not ready yet, so a slow load is the
  // ordinary path rather than a special case.
  if (!target && openTab) {
    const url = routeFor(platform, "inbox") ?? routeFor(platform, "home");
    if (url) {
      // Never `active: true`. A profile a human is also using must not have the
      // page yanked out from under them at the top of every window.
      await chrome.tabs.create({ url, active: false }).catch(() => null);
      await log("info", `${platform.label}: opened a tab — the schedule says this account is awake`);
      target = await targetFor(id);
    }
  }
  if (!target && !openTab) throw new Error(`no ${platform.label} tab is open`);

  // Marked running HERE, inside the awaited half. Doing it in the loop would
  // leave a window where the panel has been told the run started and the state
  // still says idle, which repaints the button back to Start.
  await setSweep({
    running: true,
    stopping: false,
    done: 0,
    skipped: 0,
    sent: 0,
    current: null,
    cycles: 0,
    waiting: false,
    platforms: [id],
    // WHO STARTED THIS, and it decides who may stop it. The schedule closes
    // only the runs it opened: a run somebody pressed Start for is an explicit
    // override of the plan, and a plan that cut it off at 17:00 would be
    // overriding the person instead.
    reason,
    // Cleared, not merged: a block left over from a previous run on another
    // platform would keep contributing to the totals for ever.
    per: { [id]: { cycles: 0, done: 0, sent: 0, skipped: 0 } },
  });
  const sched = scheduleState(settings, new Date());
  await log(
    "info",
    reason === "schedule"
      ? `started on ${platform.label} — the schedule is open until ${sched.window?.to ?? "it closes"}`
      : `started on ${platform.label} — will keep watching until you press Stop${
          sched.enabled && !sched.open ? " (off-schedule: the plan will not stop this one)" : ""
        }`,
  );
  return id;
}

/** The long half: work the prepared platform until stopped. */
async function runSweep(id) {
  try {
    await platformLoop(id);
  } finally {
    const s = await setSweep({ running: false, stopping: false, current: null, waiting: false });
    await log("info", `stopped after ${s.cycles} cycle(s) — ${s.sent} replied, ${s.skipped} skipped`);
  }
  return sweepState();
}

/**
 * Credit one handled thread to ONE platform.
 *
 * Scoped, and incremented from that platform's own block rather than the
 * shared total: three loops read-modify-writing one number lose updates, and
 * a run that reports four replies after sending six is worse than no number.
 */
async function bumpSweep(field, platformId) {
  const mine = (await sweepState()).per?.[platformId] ?? {};
  await setSweep({ done: (mine.done ?? 0) + 1, [field]: (mine[field] ?? 0) + 1 }, platformId);
}

// ── auto mode ────────────────────────────────────────────────────────────────

/**
 * A new inbound message arrived on the open thread.
 *
 * Only `auto` acts on it. `draft` deliberately does nothing here — the panel
 * shows the new message and waits for a human, which is the difference between
 * the two modes.
 */
/**
 * Threads with an auto-reply ALREADY IN FLIGHT.
 *
 * `alreadyReplied` is not enough on its own and the gap is wide: it is checked
 * at the top of this function, but `markReplied` only runs once every bubble
 * has gone out — and sending deliberately takes 4–12 seconds PER BUBBLE so it
 * does not look like a machine. Any second `ft:thread-changed` inside that
 * window passes the check and sends the whole reply again.
 *
 * It is not hypothetical. Measured on a live WhatsApp thread:
 *
 *     12:35:44  generated 2 bubble(s)
 *     12:35:55  sent 2/2          <- eleven seconds of reply delays
 *     12:36:02  sent 2/2          <- a second run that began inside them
 *
 * The lead received every message twice. The page's mutation watcher fires
 * again the moment our OWN reply lands (the message count changes, so the
 * watcher's dedupe key changes while `lastInbound` does not), which makes this
 * the normal path rather than a rare race — and it is the same on all three
 * platforms, because they share this watcher shape.
 *
 * A plain Set is a real mutex here: the worker is one JavaScript context, so
 * two `onThreadChanged` calls cannot interleave between the check and the add.
 * If MV3 tears the worker down mid-reply the set dies with the run it was
 * guarding, which is the correct outcome rather than a stuck lock.
 */
const replyInFlight = new Set();

/**
 * Claim a thread for a reply, or refuse because one is already going out.
 *
 * Shared by BOTH senders — the sweep and the auto-reply watcher. Either alone
 * guards nothing: the two answer the same conversation from different entry
 * points, and the window between them is the whole length of a send.
 */
function claimReply(threadId) {
  if (!threadId || replyInFlight.has(threadId)) return false;
  replyInFlight.add(threadId);
  return true;
}

function releaseReply(threadId) {
  replyInFlight.delete(threadId);
}

/**
 * ONE DRIVER PER PLATFORM TAB.
 *
 * `replyInFlight` is keyed by THREAD, which is the wrong unit for this: the
 * sweep working conversation A and the watcher answering conversation B hold
 * different keys, both proceed, and they then take turns navigating and
 * typing into the SAME tab. That is how a reply written for one lead was
 * delivered to another — the sweep moved the tab to Simon while the composed
 * text was still on its way to the composer.
 *
 * A tab is a single physical resource, so the lock has to be per tab. Held
 * for the whole open-read-generate-send sequence, because every step of it
 * assumes the conversation has not moved underneath.
 *
 * The expectThreadId guard in each adapter is the second line of defence and
 * stays: this prevents the race, that one makes its consequence impossible.
 */
const platformBusy = new Set();

function claimPlatform(platformId) {
  if (!platformId || platformBusy.has(platformId)) return false;
  platformBusy.add(platformId);
  return true;
}

function releasePlatform(platformId) {
  platformBusy.delete(platformId);
}

/**
 * Hold the tab for a pass started from the PANEL.
 *
 * ⚠ THE SWEEP TAKES THIS LOCK AND THE PANEL'S OWN RUNNERS DID NOT, so the
 * auto-reply watcher — which claims it, finds it free, and then drives the same
 * tab — ran straight through the middle of them. Observed on a real outreach
 * run: the pass opened @a_lead's conversation to check whether it already
 * existed, that fired `onThreadChanged`, and while the watcher was generating
 * and sending a reply there the pass had already navigated on to the next
 * profile. TWO MESSAGES WERE LOST — the watcher's reply to a_lead and the cold
 * open to third.lead — both logged as "bubble 1 did not appear in the thread"
 * and neither delivered, while an isolated send into the same thread a minute
 * later worked first time.
 *
 * Same contract as the sweep's: held for the WHOLE pass, because every step of
 * open → read → generate → send assumes the conversation has not moved.
 */
async function drivingTheTab(what, fn) {
  const platformId = await boundPlatformId();
  if (!claimPlatform(platformId)) throw new Error(`another run is already driving this tab — ${what} did not start`);
  try {
    return await fn();
  } finally {
    releasePlatform(platformId);
  }
}

async function onThreadChanged(thread, tab = null) {
  // Which platform this is about, decided by the TAB THAT FIRED. Reading the
  // active platform instead is how a WhatsApp message could be answered by
  // reading Instagram.
  const platform = platformForUrl(tab?.url);
  if (!platform) return;
  // AND ONLY IF IT IS THE ACTIVE ONE. Every platform tab keeps its watcher
  // running whether or not we are working there, so without this the extension
  // would answer a DM on a platform the user has switched away from — which is
  // precisely the "one platform at a time" rule, broken by the one code path
  // nobody presses a button to reach.
  if (platform.id !== (await boundPlatformId())) return;
  const target = tab ? { tab, platform } : null;
  const settings = await currentSettings(target);
  // A platform that was never set up does not act, and that cannot have
  // exceptions or it is not a gate.
  if (!platformConfigured(await loadStore(), platform.id)) return;

  // ⚠ THE GATE THE SCHEDULE WOULD MOST EASILY HAVE MISSED.
  //
  // This path is not the sweep and is not reached by stopping one: the page's
  // own mutation watcher fires it, it is on by default, and it answers a DM
  // with no click anywhere. A schedule that only started and stopped runs would
  // have left a "9 to 5" account replying at 04:00 to anybody who wrote — and
  // it would have looked like it was working, because the sweep really would
  // have been asleep.
  const sched = scheduleState(settings, new Date());
  if (!sched.open) {
    // Once per sleep, not once per message. A busy account can take dozens of
    // messages overnight and every one of them would say the same thing.
    await noteOnce(
      "inbound",
      "info",
      sched.broken
        ? "a message arrived, and the schedule cannot be read — not answering"
        : `a message arrived outside the hours set for this account — not answering until ${
            sched.next ? `${dayName(sched.next.day)} ${sched.next.from}` : "the next window"
          }`,
    );
    return;
  }

  // The gate that matters most in the whole file: the page's mutation watcher
  // fires on its own, so with this on the extension answers somebody without a
  // click anywhere. ON by default since 2026-09-10 — see `settings.js`.
  //
  // It is NOT, however, "the send switch". A sweep sends by design and so do
  // follow-ups, neither of them through here, and `settings.mode` gates
  // nothing at all because nothing reads it. Turning this off does not make
  // the extension quiet.
  if (!settings.autoSend) return;
  if (!thread.ok || !thread.lastInbound) return;
  // Same gate as the sweep, and for the same reason: an unaccepted request has
  // no composer, so answering it is impossible and generating a reply for it
  // is a billed turn spent on nothing. The watcher reaches this path too — a
  // system notice landing in the thread fires it exactly like a real message.
  if (thread.canSend === false) return;
  if (await alreadyReplied(thread.threadId, thread.lastInbound)) return;
  // Unopenable media no longer stops us when it is going to be DESCRIBED to
  // the character instead of read.
  if (thread.lastInboundUnreadable && !settings.describeUnreadable) return;
  if (thread.neverAnswered && (await newThreadQuota(platform?.id)).remaining <= 0) {
    await log("info", "auto-reply held back — hourly cap on new conversations reached");
    return;
  }

  // The TAB lock first: the sweep may be driving this very platform, and two
  // drivers on one tab is how a reply reaches the wrong conversation.
  if (!claimPlatform(platform?.id)) return;
  // Claimed BEFORE generating, released only when the last bubble has landed.
  if (!claimReply(thread.threadId)) {
    releasePlatform(platform?.id);
    return;
  }
  try {
    const result = await generate({ target });
    if (result.bubbles?.length) {
      const sent = await sendBubbles(result.thread, result.bubbles, target);
      // COUNTED, or the panel reports a run that answered nobody while
      // answers are going out. This path used to send without counting, which
      // was invisible while the watcher was broken — it never ran at all, so
      // every reply came from the sweep and every reply was counted. With it
      // working again a growing share of replies arrive here, and "0 replied"
      // over a busy hour reads exactly like a product that is not working.
      //
      // `sent` only: `done` counts conversations a CYCLE worked through, and
      // this is not part of one.
      if (sent.some((s) => s.ok)) {
        const mine = (await sweepState()).per?.[platform?.id] ?? {};
        await setSweep({ sent: (mine.sent ?? 0) + 1 }, platform?.id);
      }
    }
  } catch (err) {
    await log("error", `auto-reply failed: ${err.message}`);
  } finally {
    releaseReply(thread.threadId);
    releasePlatform(platform?.id);
  }
}

/**
 * The page's chat LIST changed — somebody who is not on screen wrote to us.
 *
 * This is the other half of `onThreadChanged`, and the half that was missing.
 * That one answers the conversation in front of us the instant a message lands;
 * this one notices a conversation we are NOT looking at, which is every brand
 * new thread. Without it a new lead was invisible until a sweep cycle came
 * round — up to two minutes, and indefinitely if no run had been started.
 *
 * It deliberately does NOT send anything itself. Answering from here would mean
 * a second sender with its own copy of the age filter, the new-thread quota, the
 * bot refusal and the tab lock — and the one thing this file has learned the
 * hard way is that two senders with two copies of the rules eventually disagree.
 * So it only marks the rows as worth looking at and wakes the loop, which opens
 * them through the same path a scheduled cycle uses.
 */
/**
 * The Threads doorbell rang: something moved on the realtime socket.
 *
 * It carries NO content — see `threads-mainworld.js` for why that is deliberate
 * — so this cannot say who wrote or even that anybody did. All it does is cut
 * the idle gap short so the run's next cycle happens now instead of in a couple
 * of minutes. A false ring therefore costs one navigation, which is the whole
 * reason the signal is allowed to be imprecise.
 *
 * ⚠ ONLY WHILE A RUN IS GOING, by the owner's explicit choice. The same gates
 * as `onListChanged`, for the same reason: this makes the extension act without
 * a click, so every switch that governs acting has to govern it too. With
 * nothing running the ring is dropped rather than queued — by the time a run
 * starts, the inbox is read from scratch anyway.
 */
async function onRealtime(tab = null) {
  const platform = platformForUrl(tab?.url);
  if (!platform) return;
  if (platform.id !== (await boundPlatformId())) return;
  if (!platformConfigured(await loadStore(), platform.id)) return;
  const settings = await currentSettings(tab ? { tab, platform } : null);
  if (!settings.autoSend) return;
  const s = await sweepState();
  if (!s.running || s.stopping) return;
  // Nothing to do if the cycle is already awake — it will read the inbox when
  // it gets there, and a log line per frame would bury the run's own story.
  if (hasPendingWork(platform.id)) return;

  noteWake(platform.id);
  await log("info", `${platform.label}: the page says something arrived — looking now`);
}

async function onListChanged(peers, tab = null) {
  // THE TAB THAT FIRED, for the same reason as `onThreadChanged`: each
  // platform's watcher runs in its own page.
  const platform = platformForUrl(tab?.url);
  if (!platform) return;
  if (platform.id !== (await boundPlatformId())) return;
  if (!platformConfigured(await loadStore(), platform.id)) return;
  // Same gate as the auto-reply: this makes the extension act without a click,
  // so the switch that governs that has to govern this too.
  const settings = await currentSettings(tab ? { tab, platform } : null);
  if (!settings.autoSend) return;
  // Nothing to wake if no run is going. The rows are dropped rather than
  // queued: by the time a run is started the inbox is re-read from scratch, and
  // a stale queue would only make cycle 1 open whatever was new hours ago.
  const s = await sweepState();
  if (!s.running || s.stopping) return;

  notePendingWork(platform.id, peers);
  await log("info", `${platform.label}: ${peers.length} conversation(s) changed — looking now`);
}

// ── panel RPC ────────────────────────────────────────────────────────────────

const handlers = {
  /**
   * Every platform: is it set up, is its tab open, and which one is active.
   *
   * The panel needs all three at once. "Set up" is what the user controls,
   * "open/reachable" is what the browser says, and `active` is which of them
   * the extension is actually working — and only the last of those is derivable
   * from the tab in front, which is why it is reported rather than guessed.
   */
  "ft:platforms": async () => {
    const store = await loadStore();
    const active = await boundPlatformId();
    const rows = await Promise.all(
      PLATFORMS.map(async (p) => {
        const t = await targetFor(p.id);
        // DOES THE TAB STILL HAVE OUR CONTENT SCRIPT? An extension restart
        // orphans every one already injected, and the page looks completely
        // normal afterwards — so "open" is not the same as "reachable", and
        // the difference is the whole reason a platform goes quiet. Probed
        // rather than assumed, and reported so the panel can say it out loud
        // instead of showing a healthy green dot over a dead tab.
        // Through `probeReady`, so one wedged tab cannot freeze the panel: the
        // rows are gathered together, and on the full call timeout a single
        // unresponsive page would leave the whole platform list blank for two
        // minutes — exactly when the user most needs it to say what is wrong.
        const alive = t
          ? await probeReady(t).then((r) => ({ reachable: r.alive, ready: Boolean(r.ready), why: r.why ?? r.error ?? null }))
          : { reachable: false, ready: false, why: null };
        // Found one the startup repair did not catch — a tab restored from a
        // crash, say. Repair it here rather than reporting "needs reload" and
        // waiting to be told, but do NOT await it: the panel polls this, and a
        // status read must stay a status read.
        if (t && alive.reachable) noteReachable(t.tab.id);
        if (t && !alive.reachable) healTabSoon(t);
        return {
          id: p.id,
          label: p.label,
          open: Boolean(t),
          reachable: alive.reachable,
          ready: alive.ready,
          notReadyWhy: alive.why,
          tabId: t?.tab.id ?? null,
          windowId: t?.tab.windowId ?? null,
          activeInWindow: Boolean(t?.tab.active),
          configured: platformConfigured(store, p.id),
          active: p.id === active,
          handle: handleOn(store, p.id) || null,
          capabilities: p.capabilities,
        };
      }),
    );
    return { active, rows };
  },

  // ── presets ────────────────────────────────────────────────────────────
  //
  // Saving writes to THIS profile's storage. Making a preset fleet-wide is an
  // export-and-drop-the-file step, because an extension cannot write to its own
  // package — the panel says so rather than implying otherwise.
  "ft:presets-list": async () => ({
    presets: await listPresets(),
    current: await exportPreset("current", { includeToken: false }),
    fleet: await fleetState(),
    fleetPresent: Boolean(await readFleetFile()),
  }),

  "ft:preset-save": async ({ name, includeToken = true }) => {
    if (!String(name ?? "").trim()) throw new Error("give the preset a name");
    return savePreset(name, { includeToken });
  },

  "ft:preset-delete": ({ name }) => deletePreset(name),

  /** The current install as a preset, for Export. */
  "ft:preset-export": ({ name = "preset", includeToken = true } = {}) =>
    exportPreset(name, { includeToken }),

  /**
   * Apply a saved preset, or one pasted in.
   *
   * REFUSED WHILE A RUN IS GOING: applying rebinds, and rebinding mid-sweep
   * moves the run onto another account mid-conversation.
   */
  "ft:preset-apply": async ({ name = null, preset = null }) => {
    if ((await sweepState()).running) throw new Error("stop the run before applying a preset");
    const chosen = preset ?? (await listPresets()).find((p) => p.name === name);
    if (!chosen) throw new Error(`no preset called "${name}"`);
    const result = await applyPreset(chosen);
    await log("info", `preset "${chosen.name}" applied — ${result.bound ? `bound ${platformById(result.bound)?.label}` : "nothing bound"}`);
    chrome.runtime.sendMessage({ type: "ft:active-changed", platform: result.bound }).catch(() => {});
    return result;
  },

  /**
   * Check a pasted preset WITHOUT applying it.
   *
   * A preset carries a token and rebinds the extension, so "what is in this
   * blob" has to be answerable before it takes effect.
   */
  "ft:preset-check": ({ json }) => {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      return { ok: false, errors: [`not valid JSON: ${err.message}`] };
    }
    const r = validatePreset(parsed);
    return r.ok
      ? {
          ok: true,
          errors: [],
          preset: r.preset,
          summary: {
            name: r.preset.name,
            bind: r.preset.bind,
            hasToken: Boolean(r.preset.token),
            platforms: Object.keys(r.preset.platforms),
          },
        }
      : r;
  },

  /** Import a pasted preset into this profile's saved list. */
  "ft:preset-import": async ({ json }) => {
    const parsed = JSON.parse(json);
    const r = validatePreset(parsed);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const all = (await listPresets()).filter((p) => p.name !== r.preset.name);
    all.push(r.preset);
    await chrome.storage.local.set({ "fluidextension.presets": all });
    return r.preset;
  },

  /**
   * ONE NAMED PLATFORM's settings, whether or not it is the bound one.
   *
   * The settings form is per platform and can be opened for any of them — that
   * is the normal way to set up a platform before binding it. `ft:get-state`
   * answers about the BOUND platform, which is the right answer for the budgets
   * and for what Start will do, and the wrong one for a form opened on another
   * account.
   */
  "ft:platform-settings": async ({ platform }) => {
    if (!platformById(platform)) throw new Error(`unknown platform "${platform}"`);
    return loadSettings(platform);
  },

  /**
   * Bind a platform, or unbind it. Binding is exclusive — see `setConfigured`.
   *
   * REFUSED WHILE A RUN IS GOING, because binding is now the only way to change
   * which platform is worked, and doing that mid-run would move the run to a
   * different account underneath itself. A sweep holds a tab through
   * open → read → generate → send and every step assumes the conversation has
   * not moved; the same reasoning that used to freeze the focus-driven switch.
   */
  "ft:set-configured": async ({ platform, on }) => {
    if (!platformById(platform)) throw new Error(`unknown platform "${platform}"`);
    if ((await sweepState()).running) throw new Error("stop the run before changing which platform is bound");
    const was = await boundPlatformId();
    await setConfigured(platform, on);
    const label = platformById(platform).label;
    if (!on) await log("info", `${label} unbound — nothing is running now`);
    else if (was && was !== platform) {
      await log("info", `now working ${label} — ${platformById(was).label} was unbound`);
    } else await log("info", `now working ${label}`);
    // The panel repaints from this rather than racing a poll for it.
    chrome.runtime.sendMessage({ type: "ft:active-changed", platform: on ? platform : null }).catch(() => {});
    return { platform, configured: Boolean(on) };
  },

  "ft:get-state": async () => {
    const id = await boundPlatformId();
    return {
      settings: await currentSettings(),
      log: await readLog(),
      // THE ACTIVE PLATFORM, not the tab in front. Everything the panel paints
      // — the budgets, the settings form, what Start will do — is about the
      // platform being worked, and that deliberately does not change just
      // because the user clicked into the panel itself.
      platform: platformById(id),
      quotas: await allQuotas(),
      sweep: await sweepState(),
      // The run bar's own state. Asleep is not idle: one is a plan waiting for
      // its hour, the other is nothing set up at all, and the bar has to say
      // which without the panel working out the week for itself.
      schedule: id ? { ...scheduleState(await loadSettings(id), new Date()), day: DAY_NAMES } : null,
      ownHandle: await resolveOwnHandle(),
    };
  },
  /**
   * Refusals are AWAITED; the run itself is not.
   *
   * A sweep lasts for hours and the panel must stay responsive enough to press
   * Stop, so the loop is fired off. But everything that can say no — no active
   * platform, not set up, no tab, no token, already running — is checked first
   * and thrown back to the button, where the user is looking.
   */
  "ft:sweep-start": async () => {
    const id = await prepareSweep({ reason: "manual" });
    runSweep(id).catch((err) => log("error", `sweep failed: ${err.message}`));
    return { started: true, platform: id };
  },
  // Logged because a sweep that halts itself is indistinguishable, in the
  // result, from one that finished — and "stopped by the user" is a lie worth
  // catching if nobody pressed anything.
  "ft:sweep-stop": async () => {
    // ⚠ NOTHING RUNNING MEANS NOTHING TO STOP, and setting the flag anyway is
    // a trap rather than a harmless no-op: `stopping` is only ever cleared by
    // a loop finishing, so with no loop alive it stays true for the rest of
    // the browser session. The panel then reads "Stopping" for ever, and —
    // worse — every scheduled start refuses, because a run that is stopping is
    // one the tick must not interrupt. The schedule would simply never fire
    // again, with nothing in the log.
    if (!(await sweepState()).running) return setSweep({ stopping: false });

    // STOPPING INSIDE THE HOURS MEANS "NOT THIS AFTERNOON", not "for the next
    // sixty seconds". Without this the tick finds itself inside an open window
    // with nothing running and starts again, and the button reads as broken.
    // Recorded before the stop so a tick landing in between cannot slip past.
    const id = await boundPlatformId();
    if (id) {
      const st = scheduleState(await loadSettings(id), new Date());
      if (st.enabled && st.open) {
        await suppressWindow(id, st.window.startAt);
        await log("info", `stop requested — asleep until ${st.next ? `${dayName(st.next.day)} ${st.next.from}` : "the next window"}`);
        return setSweep({ stopping: true });
      }
    }
    await log("info", "stop requested");
    return setSweep({ stopping: true });
  },
  /**
   * What the panel's schedule card reads back — for ANY platform, not just the
   * bound one, because a week is set up on a platform before it is bound.
   *
   * The panel computes none of this. "Opens Monday at 09:04" has to be the same
   * sentence the tick is acting on, and two implementations of a calendar are
   * two answers to when an account wakes up.
   */
  "ft:schedule-preview": async ({ platform = null }) => {
    // RESOLVED EXACTLY AS `ft:save-settings` RESOLVES IT, and that symmetry is
    // the point: the panel sends the form's platform, which is null while no
    // row is open, and a save falls back to the bound one. A preview that
    // refused where the save succeeded meant the panel could write a week it
    // could not then read back — which shows up as a readout that is blank for
    // no reason anybody can see.
    const id = platform ?? (await boundPlatformId());
    if (!id) return null;
    if (!platformById(id)) throw new Error(`unknown platform "${id}"`);
    const st = scheduleState(await loadSettings(id), new Date());
    return { ...st, platform: id, day: DAY_NAMES, now: Date.now() };
  },
  "ft:quota": () => allQuotas(),
  // Pass-throughs to the page, so the sweep's own steps can be driven one at a
  // time when it misbehaves. Without these the only way to exercise them is to
  // run a whole sweep and read the log.
  "ft:list-threads": async () =>
    askPage("ft:list-threads", { ownHandle: (await currentSettings()).ownUsername }),
  /**
   * Send a real photo into the open thread, using FluidTalk's own mock fixture.
   *
   * Whether the character sends a photo live depends on the strategist picking
   * a photo move and a vault photo surviving several gates — so the path cannot
   * be reached on demand. `mode: mock` with handle `test_photo` returns the
   * exact bubble shape a live photo reply uses, pointing at a real downloadable
   * sample, with no model call and nothing written. The DELIVERY it exercises
   * is entirely real.
   */
  "ft:photo-selftest": async ({ two }) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);

    const data = await chat(settings, {
      handle: two ? "test_photos" : "test_photo",
      message: "hey",
      mode: MODES.MOCK,
    });
    const photos = (data.bubbles ?? []).filter((b) => b.image_url);
    if (!photos.length) throw new Error("the mock fixture returned no photo bubble");

    const thread = await askPage("ft:read", { ownHandle: settings.ownUsername });
    if (!thread.ok) throw new Error(`no conversation on screen (${thread.reason})`);

    await log("info", `photo self-test: sending ${photos.length} photo(s) to ${thread.handle}`);
    const sent = await sendBubbles(
      { ...thread, lastInbound: thread.lastInbound ?? { text: "" }, neverAnswered: false },
      photos,
    );
    return { handle: thread.handle, urls: photos.map((b) => b.image_url), sent };
  },
  /**
   * Prove the RECEIVING path: a photo in this thread → re-hosted → actually
   * seen by the model.
   *
   * Runs in SANDBOX, not mock: mock returns a canned `vision` block, which
   * would report success without anything ever fetching the image — the exact
   * class of lie this check exists to catch. Sandbox is the real pipeline on a
   * disposable `test_` lead, so `vision.seen` means what it says.
   */
  "ft:vision-selftest": async ({ url, raw = false }) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);

    let source = url;
    if (!source) {
      const photos = await askPage("ft:read-photos");
      if (!photos.length) throw new Error("no photo in this thread to test with");
      source = photos[photos.length - 1].src;
    }

    // `raw` skips the re-hosting, to check whether it is doing anything. It
    // was this that showed the assumption was wrong: a fresh Instagram CDN
    // link IS fetchable by the model provider (`seen: true`). Keep the switch —
    // when a link has expired, this is how you tell an unfetchable image from a
    // broken upload, and `seen: false` is the only signal either way.
    const hosted = raw ? source : (await hostInboundPhoto(settings, source)).url;
    const data = await chat(settings, {
      handle: "test_vision_selftest",
      message: "what do you think of this?",
      imageUrl: hosted,
      mode: MODES.SANDBOX,
    });
    return {
      from: source.slice(0, 80),
      hosted,
      vision: data.vision ?? null,
      bubbles: (data.bubbles ?? []).map((b) => b.text),
    };
  },
  /**
   * What event triggers does this character have configured?
   *
   * An unknown `event_id` is a fail-closed no-op, and live mode answers with
   * the ids that WOULD have fired — so this discovers the entry points without
   * firing any of them.
   */
  "ft:trigger-probe": async ({ handle }) => {
    const settings = await currentSettings();
    return fireTrigger(settings, {
      handle: handle || "test_probe",
      eventId: "__which_events_exist__",
      externalEventId: `probe-${Date.now()}`,
    });
  },
  /**
   * Fire a named event trigger. Used to prototype how the character reacts to
   * something that is not a message — e.g. media we were handed but cannot open.
   */
  "ft:fire-trigger": async ({ handle, eventId, context, mode, message }) => {
    const settings = await currentSettings();
    if (message !== undefined) {
      return chat(settings, { handle, message, mode });
    }
    return fireTrigger(settings, {
      handle,
      eventId,
      externalEventId: `fx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      context,
      mode,
    });
  },
  /**
   * Write a comment for the post on screen WITHOUT posting it.
   *
   * A comment is public, so the generate and the publish steps are separate
   * controls — you can read what it wants to say before anyone else can.
   */
  "ft:comment-generate": async ({ post }) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    const p = post ?? (await askPage("ft:read-post", { ownHandle: settings.ownUsername }));
    if (!p?.ok) throw new Error(`not on a post (${p?.reason ?? "unknown"})`);

    const data = await comment(settings, {
      postRef: p.postRef,
      caption: p.caption,
      imageUrls: p.imageUrls,
      authorHandle: p.author,
    });
    return {
      author: p.author,
      caption: (p.caption ?? "").slice(0, 80),
      images: p.imageUrls?.length ?? 0,
      comment: data.comment ?? null,
      ignore_reason: data.ignore_reason ?? null,
      vision: data.vision ?? null,
      explain: data.explain ?? null,
    };
  },
  /** Run ONLY the comment pass, so it can be exercised without a full sweep. */
  "ft:comments-run": async () => {
    const settings = await currentSettings();
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    await setSweep({ running: true, stopping: false, done: 0, skipped: 0, sent: 0, current: null });
    try {
      /**
       * "The platform I am looking at" is right, and OMITTING THE TARGET IS NOT
       * HOW YOU SAY IT. `askPage` does fall back to `boundTarget()` for the
       * page, which is what the old comment here was about — but every ledger
       * and quota keys off `target?.platform.id`, so leaving it out silently
       * moves them to the shared, un-suffixed keys. `boundTarget()` names the
       * same tab and keeps the per-platform bookkeeping intact.
       */
      await runComments(settings, { target: await boundTarget() });
    } finally {
      await setSweep({ running: false, stopping: false, current: null });
    }
    return { done: true };
  },
  "ft:scroll-page": ({ by }) => askPage("ft:scroll-page", { by }),
  "ft:read-feed": async ({ limit }) => {
    const s = await currentSettings();
    return askPage("ft:read-feed", { limit, skipSponsored: s.skipSponsored });
  },
  "ft:read-profile-posts": ({ limit }) => askPage("ft:read-profile-posts", { limit }),
  "ft:read-post": async () =>
    askPage("ft:read-post", { ownHandle: (await currentSettings()).ownUsername }),
  // `ownHandle` for the same reason the sweep sends it: without it a publish is
  // confirmed by finding ANY block containing our text.
  "ft:post-comment": async ({ text }) =>
    askPage("ft:post-comment", { text, ownHandle: (await currentSettings()).ownUsername }),
  /** Are comments even switched on for this character? Fail-closed and OFF by default. */
  "ft:comment-status": async () => {
    const settings = await currentSettings();
    const r = await comment(settings, {
      postRef: "https://www.instagram.com/p/__status_probe__/",
      caption: "probe",
    });
    return { enabled: !r.ignore_reason, ignore_reason: r.ignore_reason ?? null, explain: r.explain ?? null };
  },
  /**
   * Run the requests pass on its own — the counterpart of `ft:run-comments`
   * and `ft:run-outreach`, and the only one of the five that had no runner.
   * Accepting a request lets somebody into the inbox, so being able to exercise
   * it once, deliberately, is worth more here than anywhere else.
   */
  "ft:run-requests": async () => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    const target = await boundTarget();
    return drivingTheTab("requests", async () => {
      await sweepRequests(settings, target);
      return { ok: true };
    });
  },
  "ft:outreach-preview": () => outreachTargets(),
  /**
   * Run the outreach pass on its own — the counterpart of `ft:run-comments`.
   *
   * Until now the only way to exercise this was to start a whole sweep, which
   * cold-opens whoever the followers list happens to offer first. `onlyHandle`
   * aims it at one account you control, `limit` caps the sends, and `dryRun`
   * stops after the character has written the opener.
   */
  "ft:run-outreach": async ({ onlyHandle = null, limit = 1, dryRun = false } = {}) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    /**
     * ⚠ THE TARGET IS WHAT MAKES THE PER-PLATFORM KEYS PER-PLATFORM. Passing
     * null here sends `unreachableProfiles`, `countMiss` and `recordCounter`
     * back to the legacy un-suffixed keys — so a panel-started run reads
     * Instagram's unmessageable list again and its sends never reach the
     * Threads budget. Caught in a live run: the log said "1 with no way to
     * message them" while `outreachUnreachable.threads` was empty, and a
     * delivered DM left `outreach.threads` on zero.
     */
    const target = await boundTarget();
    return drivingTheTab("outreach", () =>
      runOutreach(settings, target, { onlyHandle, limit, dryRun }).then(() => ({ ok: true, onlyHandle, limit, dryRun })),
    );
  },
  /**
   * Run the follow-up pass on its own.
   *
   * A sweep also answers threads, comments and cold-opens, so it is not a way
   * to exercise ONE of those: this is. `onlyHandle` narrows the queue to a
   * single lead, and `dryRun` stops after the conversation has actually been
   * opened but before anything is sent — which keeps the half that goes wrong
   * (finding the right thread) under test while nothing reaches a real person.
   * Same shape, and the same reasoning, as `ft:accept-request`.
   */
  /**
   * Run the comment pass on its own, for the same reason `ft:run-followups`
   * exists: a sweep also answers threads, nudges and cold-opens.
   *
   * `source` overrides `commentSources` for this run only — testing the home
   * feed should not also walk followers — and `limit` caps how many posts are
   * commented on, because the hourly cap (3) is a rate limit, not a blast
   * radius. `dryRun` stops after the character has written the comment and
   * before it is posted; a comment is PUBLIC and cannot be quietly taken back.
   */
  "ft:run-comments": async ({ source = null, limit = 1, dryRun = false } = {}) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    const use = source ? { ...settings, commentSources: source } : settings;
    // Holds the tab for the whole pass — see `drivingTheTab`. This one walks
    // the feed and opens posts, so the auto-reply watcher navigating underneath
    // it is the same collision. The TARGET is passed for the same reason as in
    // `ft:run-outreach`: without it the quota and the commented memo use the
    // legacy un-suffixed keys and this platform's budget is never touched.
    const target = await boundTarget();
    return drivingTheTab(
      "comments",
      async () => (await runComments(use, { limit, dryRun, target })) ?? { candidates: 0, posted: 0 },
    );
  },
  /**
   * Run ONLY the comment-reply pass, same reasoning as `ft:run-comments`.
   *
   * `dryRun` stops BEFORE asking FluidTalk, not after: the generate is the
   * irreversible half on FluidTalk's side, because it counts against the
   * thread's reply cap and files an outbound comment we never posted. So a dry
   * run answers "who would be replied to", and mock mode answers "what would it
   * say". `onlyHandle` narrows it to one replier, which is how a single real
   * reply can be posted deliberately.
   */
  "ft:run-comment-replies": async ({ limit = 1, dryRun = false, onlyHandle = null } = {}) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    // Target and tab lock, like every other panel-started pass — see
    // `drivingTheTab`. Without the target this reads `commentTexts` and the
    // quota from the shared keys, which is how the reply-code recovery found an
    // empty ledger and answered "0 post(s) to open" with a reply on screen.
    const target = await boundTarget();
    return drivingTheTab(
      "comment replies",
      async () =>
        (await runCommentReplies(settings, { limit, dryRun, onlyHandle, target })) ?? {
          via: "none",
          posts: 0,
          replies: 0,
          posted: 0,
        },
    );
  },
  /** What the notification list says without acting on it. */
  "ft:read-notifications": async () => {
    const settings = await currentSettings();
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    await goToRoute("notifications", [], 10000);
    return askPage("ft:read-notifications", { ownHandle: settings.ownUsername, limit: 40 });
  },
  /** Read the replies under our comments on the post on screen, and post nothing. */
  "ft:read-comment-replies": async () =>
    askPage("ft:read-comment-replies", { ownHandle: (await currentSettings()).ownUsername }),
  /**
   * Ask FluidTalk what it would reply to one comment. Generates, posts nothing.
   *
   * `mode` is passed straight through, which is what makes every branch of the
   * contract reachable on demand: in `mock`, the post_ref picks the fixture
   * (`test_dm` → drive_to_dm_nudge, `test_hostile` → bow_out, `test_once` /
   * `test_maxed` / `test_stranger` → the stop rules), so the caller's handling
   * of a refusal can be exercised without needing a real thread to have hit its
   * cap. The API refuses any non-`test_` post_ref in those modes, so a mode
   * left switched on cannot answer a real person with a fixture.
   */
  "ft:comment-reply-generate": async ({ postRef, replierHandle, replyText, parentRef, mode }) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    const data = await commentReply(settings, { postRef, replierHandle, replyText, parentRef, mode });
    return {
      decision: data.decision ?? null,
      reply: data.reply ?? null,
      reason: data.reason ?? null,
      ignore_reason: data.ignore_reason ?? null,
      thread_warmth: data.thread_warmth ?? null,
      recognized_lead: data.recognized_lead ?? null,
    };
  },
  "ft:run-followups": async ({ onlyHandle = null, dryRun = false } = {}) => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    settings.ownUsername = (await resolveOwnHandle()) || settings.ownUsername;
    // Same tab lock as the other panel-started passes — see `drivingTheTab` —
    // and the same TARGET, without which `followupHistory`, `recordFollowup`
    // and `knownThreads` all fall back to the shared keys. Caught live: a
    // follow-up delivered on Threads wrote `count: 1` into the global history
    // while `followups.threads` stayed empty, so the per-platform ladder this
    // pass is supposed to climb was never touched.
    const target = await boundTarget();
    return drivingTheTab("follow-ups", async () => {
      await goToRoute("inbox", [], 8000, target);
      return (await runFollowups(settings, { onlyHandle, dryRun, target })) ?? { queued: 0, sent: 0 };
    });
  },
  // dryRun defaults TRUE here: this pass-through exists to inspect the accept
  // control, and a diagnostic that accepts a stranger by default is a trap.
  "ft:accept-request": ({ dryRun = true }) => askPage("ft:accept-request", { dryRun }),
  "ft:open-dm": () => askPage("ft:open-dm"),
  "ft:open-thread": ({ label }) => askPage("ft:open-thread", { label }),
  "ft:where": () => askPage("ft:where"),
  "ft:read-photos": () => askPage("ft:read-photos"),
  "ft:whoami": () => resolveOwnHandle().then((handle) => ({ handle })),
  /**
   * Save against the ACTIVE platform — or against a named one.
   *
   * `platform` is accepted explicitly because the settings form can be open for
   * a platform whose tab is not in front (that is the normal way to set a new
   * one up), and resolving it from focus at save time would write the values
   * onto whichever platform happened to be active instead. The panel always
   * sends the platform it painted the form for.
   *
   * Global keys route themselves — see `saveSettings` — so nothing here has to
   * know that the token is install-wide and the rate caps are not.
   */
  "ft:save-settings": async ({ patch, platform = null }) => {
    const id = platform ?? (await boundPlatformId());
    const next = await saveSettings(id, patch);
    const where = platformById(id)?.label ?? "the install";
    await log("info", `${where}: settings updated (${Object.keys(patch).join(", ")})`);
    return next;
  },
  "ft:read-thread": async () => readThread((await currentSettings()).ownUsername),
  "ft:probe": async () => askPage("ft:probe", { ownHandle: (await currentSettings()).ownUsername }),
  "ft:check-token": async () => {
    const settings = await currentSettings();
    const missing = missingConfig(settings);
    if (missing.length) throw new Error(`configure ${missing.join(" and ")} first`);
    const data = await checkToken(settings);
    await log("info", "connector token accepted by FluidTalk");
    return data;
  },
  "ft:generate": ({ force }) => generate({ force }),
  "ft:type": ({ text }) => askPage("ft:type", { text }),
  "ft:send": ({ thread, bubbles }) => sendBubbles(thread, bubbles),
  "ft:clear-log": async () => {
    await chrome.storage.session.remove(LOG_KEY);
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === "ft:thread-changed") {
    // THE TAB THAT FIRED, not the one in front. The watcher runs in each
    // platform's own page, so `sender.tab` is the only thing that says which
    // platform this message is about — and reading the active tab instead is
    // how a WhatsApp message could be answered by reading Instagram.
    onThreadChanged(msg.thread, sender?.tab ?? null);
    // Let the panel repaint from the same event rather than polling the page.
    chrome.runtime.sendMessage({ type: "ft:thread-updated", thread: msg.thread }).catch(() => {});
    return false;
  }

  if (msg?.type === "ft:realtime") {
    onRealtime(sender?.tab ?? null);
    return false;
  }

  if (msg?.type === "ft:list-changed") {
    // Same rule: the tab that fired says which platform this is about.
    onListChanged(msg.peers ?? [], sender?.tab ?? null);
    return false;
  }

  const handler = handlers[msg?.type];
  if (!handler) return false;

  (async () => {
    try {
      respond({ ok: true, result: await handler(msg) });
    } catch (err) {
      respond({
        ok: false,
        error: err.message,
        // A FluidTalk request_id is what support can actually look up.
        ...(err instanceof FluidTalkError ? { requestId: err.requestId, code: err.code } : {}),
      });
    }
  })();
  return true;
});
