/**
 * Settings: the single definition of what the side panel can change.
 *
 * TWO LEVELS, because a platform is a separate SETUP and not a mode of one.
 *
 * Everything here used to be flat, and shared: one `autoSend`, one set of rate
 * caps, one follow-up ladder, applied to whichever platform happened to be in
 * front. That is wrong in both directions. A WhatsApp account and an Instagram
 * account are different accounts with different audiences, different risk and
 * different pacing — and the panel was already apologising for it in code,
 * greying out controls whose values it had nonetheless saved and would never
 * act on. So each platform now carries its own block, and the user sets each
 * one up separately.
 *
 * WHAT STAYS GLOBAL is deliberately small: the API base (pinned) and the
 * connector token. The token IS the character — it resolves a FluidTalk
 * `StrategyBinding` of (owner, character, engine, platform) — and one token
 * already carries a binding for every platform, so one character spread across
 * Instagram, Telegram and WhatsApp is the normal case and should not be three
 * pastes of the same string.
 *
 * BUT THE RESOLVED VALUE IS FLAT. `loadSettings(platformId)` hands back one
 * plain object with the globals and that platform's values merged — which is
 * exactly the shape `fluidtalk.js` and every `settings.<key>` read in the
 * worker already expect. The nesting is a property of the STORE, not of the
 * thing anybody uses, and that is what keeps this from touching 35 call sites.
 *
 * Stored under one key so a read is one round-trip and a write is atomic — a
 * partial write would be able to leave the connector token pointing at a
 * different API base than the one it was issued for, which fails as a 401 that
 * looks like a bad token.
 */

import { PLATFORMS, platformById } from "./platforms.js";

const KEY = "fluidextension.settings";

/**
 * Store format version.
 *
 * Exists so the migration from the flat store CANNOT RUN TWICE. Re-running it
 * would take the old flat `newThreadsPerHour` and lay it back over a value the
 * user has since changed per platform — a settings change silently reverting,
 * with nothing thrown and nothing logged. The version is what makes "already
 * migrated" a fact rather than a guess.
 */
const VERSION = 2;

/** The only FluidTalk deployment this ships against. */
export const API_BASE = "https://api-talk.fluidvip.com";

/**
 * Settings that belong to the INSTALL, not to a platform.
 *
 * Keep this list short and justify every entry: anything here is a value the
 * user cannot vary per account, and the default assumption is now the opposite.
 */
export const GLOBAL_DEFAULTS = {
  apiBase: API_BASE,
  /**
   * The connector token — and therefore the character.
   *
   * Global because a token resolves (owner, character, engine, PLATFORM) and a
   * single token already carries a binding per platform, so one character
   * running on three platforms is the ordinary case. Making it per-platform
   * would mean pasting the same string three times to get the default
   * behaviour.
   */
  connectorToken: "",
  /** How many past messages of a thread the panel shows. A display choice. */
  historyLimit: 12,
};

/**
 * Settings that belong to ONE platform.
 *
 * Every one of these is a decision about a specific account: how fast it may
 * act, what it is allowed to do, who it is. A platform with no block of its own
 * falls back to these defaults — but it is not RUN until it has been set up
 * (see `platformConfigured`), so defaults are a starting point for the setup
 * form rather than behaviour anybody gets by accident.
 */
export const PLATFORM_DEFAULTS = {
  /**
   * Our own handle on this platform, sent as `own_username` so FluidTalk knows
   * which account received the DM. DETECTED from the page, never typed — a
   * typed value has to match exactly or the lead reader picks our own account
   * as the lead, and that shows up as strange replies rather than as an error.
   *
   * Per platform because one field cannot hold an Instagram handle and a phone
   * number at once, and it was measured flipping from `our_account` to
   * `15550123456` merely by activating the WhatsApp tab.
   */
  ownUsername: "",

  /**
   * THE HOURS THIS ACCOUNT IS AWAKE, and what "awake" covers.
   *
   * Off by default, and off means exactly what it did before: the run starts
   * and stops when somebody presses the button.
   *
   * ON, IT GATES EVERY UNATTENDED SEND, NOT JUST THE SWEEP — the sweep, the
   * page's own auto-reply watcher, and the follow-up / comment / outreach
   * passes that ride inside a cycle. Bounding the sweep alone would have left
   * the most autonomous path in the extension running all night: the watcher
   * answers a DM with no click anywhere and is ON by default, so a "9 to 5"
   * account would still have been typing at 04:00. What is NOT gated is the
   * panel's own Send and Generate — a person pressing a button is not the
   * extension acting by itself, and refusing them would only make the panel
   * look broken out of hours.
   *
   * `schedule` is keyed by `SCHEDULE_DAYS` and each entry is a list of
   * `["HH:MM", "HH:MM"]` windows. An END EARLIER THAN ITS START RUNS INTO THE
   * NEXT DAY — "22:00"–"02:00" on `fri` is Friday night, and it belongs to the
   * day it OPENS. Without that rule the obvious way to say "late Friday" is
   * silently an empty window, i.e. an account that never wakes and nothing
   * anywhere saying why.
   *
   * `{}` means no day is set. With the switch ON that is a real, honest state —
   * nothing runs by itself — and the panel says so rather than inventing hours
   * nobody chose.
   *
   * `scheduleJitterMin` spreads the opening minute. A fleet of anti-detect
   * profiles shares ONE preset, so without it every account in it wakes on the
   * same second of the same minute, which is a pattern that outlives any single
   * account. The offset is DERIVED, not drawn — see `scheduleJitter`.
   */
  scheduleEnabled: false,
  schedule: {},
  scheduleJitterMin: 10,

  /**
   * Reply by itself when a new message arrives in the thread on screen.
   *
   * ON by default. The page's mutation watcher is enough to make the extension
   * answer somebody with no click anywhere, which is the point: unattended
   * running is what this is for, and a lead who writes and gets nothing back is
   * the failure that matters.
   *
   * Know what it does NOT cover: only the thread actually OPEN in the tab. The
   * watcher is per-page, so everyone else in the inbox is still reached by a
   * sweep, not by this. It is also not the only thing that sends — a sweep
   * sends by design, and so do follow-ups. Do not take this flag being off to
   * mean nothing will be sent.
   */
  autoSend: true,
  /** Floor on how long we wait before sending a reply, on top of the per-bubble
   *  `delay_ms` FluidTalk returns. An instant answer to a DM is the single most
   *  obvious tell that nobody is typing. */
  minReplyDelayMs: 4000,
  maxReplyDelayMs: 12000,

  /**
   * Cap on opening NEW conversations per rolling hour — threads we have never
   * replied in. Answering someone who is already talking to us is not rate
   * limited: that is a reply they are waiting for, and throttling it just makes
   * the account look unresponsive. Starting conversations is the thing that
   * looks automated when it comes in bursts, so that is what is counted.
   */
  newThreadsPerHour: 5,
  newThreadsPerDay: 30,

  /**
   * Accepting message requests — the same shape, its own budget.
   *
   * ON by default: a request is somebody who has already written to us and is
   * sitting in a folder nobody looks at. Leaving it off means the whole funnel
   * silently stops at the door, and the rate is bounded below anyway. It stays
   * on its own budget because letting somebody INTO the inbox is not the same
   * act as answering somebody already there.
   */
  acceptRequests: true,
  requestsPerHour: 5,
  requestsPerDay: 25,

  /**
   * Cold outreach to our own followers. Kept on its own budget because it is
   * the only thing here that starts a conversation with somebody who never
   * wrote to us — a different risk from answering a DM.
   */
  outreachEnabled: true,
  outreachPerHour: 3,
  outreachPerDay: 15,

  /**
   * WHERE the cold-open candidates come from — same vocabulary as
   * `commentSources`: "followers" (people who follow us), "feed" (the authors
   * of posts on the home timeline), or "both".
   *
   * Defaults to "followers", which is exactly what this did before the setting
   * existed. That is deliberate: outreach is ON by default, so a default of
   * "both" would silently start messaging strangers on every platform that
   * declares the capability, and the two sources are not the same act. A
   * follower CHOSE us; a feed author has never heard of us and is the colder,
   * riskier open — worth having, worth opting into.
   */
  outreachSources: "followers",

  /**
   * When they send media the web cannot open — a view-once photo, an
   * unsupported attachment — tell the character an event happened instead of
   * skipping the thread.
   *
   * The bytes genuinely never reach a browser, so nobody can look at it. But
   * silence is the worst answer: they sent something and got nothing back.
   * With this on, FluidTalk is told "sent a disappearing photo", which it
   * answers naturally ("i didn't even get to see it! what was it, a secret?").
   *
   * The cost, stated plainly: that phrase is recorded as the LEAD's message. It
   * is a truthful description of an event rather than invented speech, but it
   * is not their words — which is why it is a switch and not a silent default.
   */
  describeUnreadable: true,

  /**
   * Commenting on public posts.
   *
   * `commentSources`: "feed" (posts from the home timeline), "followers"
   * (recent posts by people who follow us), or "both" — the default, because
   * the two reach different people. The feed is who we already follow; a
   * follower's post is somebody who chose us and is the likelier lead.
   *
   * ON by default, but that switch is not the only one: FluidTalk keeps
   * Comments OFF per workflow and fails closed, so nothing is written until it
   * is enabled there too. A comment is PUBLIC — a bad DM is seen by one person,
   * a bad comment by everyone who looks at the post — and that risk is carried
   * by the ad/suggested filters and the per-hour cap below, not by leaving the
   * feature off in a build nobody ships.
   */
  commentsEnabled: true,
  commentSources: "both",
  commentsPerHour: 3,
  commentsPerDay: 5,
  /** Skip posts older than this when commenting. 0 = no limit. */
  maxPostAgeDays: 7,

  /**
   * Answering the people who reply to our public comments.
   *
   * Its own budget, and a bigger one than commenting, for the same reason a DM
   * reply is not rate limited the way a new conversation is: somebody replied
   * to us in public and is waiting where everyone can see it. Starting threads
   * is what looks automated in bursts; finishing one does not.
   *
   * Which of them actually gets an answer is FluidTalk's decision, not this
   * setting's — the thread has its own reply caps, it bows out of a hostile
   * turn, and it nudges a warmed replier to the DMs instead. This only bounds
   * how many times a day we are willing to speak in public at all.
   */
  commentRepliesEnabled: true,
  commentRepliesPerHour: 4,
  commentRepliesPerDay: 12,

  /**
   * Paid placements. An ad reads exactly like a friend's photo apart from one
   * line of label, so without this the character spends the budget commenting
   * on brands.
   *
   * "Suggested for you" has no switch: it is skipped ALWAYS, in `readFeed`.
   * Whatever Instagram attaches that label to — a follow suggestion, or a post
   * from an account we do not follow — it is not our audience, and a setting
   * only offered a way to turn that guarantee off.
   */
  skipSponsored: true,

  /** How many feed posts to gather per run before picking from them. */
  feedScanLimit: 12,

  /**
   * Follow-ups: nudging a lead who went quiet after WE spoke last.
   *
   * `followupStagesHours` is the ladder, and each entry is its OWN window — the
   * wait before that nudge, not a total elapsed since they went quiet.
   * "12,24,48" means: nudge once they have been silent 12h, the next 24h after
   * that one, the third 48h after THAT, and then nothing. Its LENGTH is how many
   * follow-ups anyone can ever receive.
   *
   * Each entry standing alone is what makes the field editable: a lengthening
   * ladder is the normal shape (chase, then back off), and expressing it as
   * running totals means every number after the first has to be recomputed by
   * hand to change one gap.
   *
   * The extension owns the timing; FluidTalk owns the words. That split is
   * forced: the connector API can queue and pull follow-ups but cannot set the
   * engine's own `min_spacing_hours`, so a schedule expressed only there could
   * not be honoured from here.
   *
   * There is deliberately NO hourly or daily cap here, unlike new conversations,
   * requests and outreach. Those are unbounded acts that a cap has to bound; a
   * follow-up is already bounded twice over — a lead can only ever receive
   * `followupStagesHours.length` of them, each one after its own wait. A rate
   * cap on top of that would not prevent anything, it would only decide which
   * due lead gets postponed, i.e. quietly break the schedule that was asked for.
   */
  followupsEnabled: true,
  followupStagesHours: "12,24,48",

  /**
   * Pause between threads in a sweep. OFF by default — the work between
   * threads (page load, a generation, the pre-send delay) is already several
   * seconds, so an extra wait mostly makes a run take all day.
   */
  pauseBetweenThreads: false,
  betweenThreadsMs: 20000,

  /**
   * Ignore conversations whose last activity is older than this. 0 = no limit.
   * Answering a four-month-old "hey" reads as a bot working a backlog.
   */
  maxThreadAgeDays: 0,
};

/** Is this setting an install-wide one, or one platform's? */
export function isGlobalKey(key) {
  return Object.hasOwn(GLOBAL_DEFAULTS, key);
}

/**
 * The old flat store, turned into the two-level one.
 *
 * THE RULE IS "NOBODY'S SETUP CHANGES". An install that was answering DMs on
 * Instagram and WhatsApp this morning must still be doing it after the update,
 * with the same caps and the same ladder — so every platform the user had left
 * switched ON inherits the old flat values and comes across already set up.
 * Anything in `disabledPlatforms` was explicitly switched off and stays off;
 * arriving back as "set up" would restart a platform somebody had stopped.
 *
 * THE ONE THING NOT COPIED FLAT IS THE HANDLE. `ownUsername` held whichever
 * platform was detected LAST — a WhatsApp phone number, for an install whose
 * last active tab was WhatsApp. Copying that onto Instagram and Telegram offers
 * a phone number as their handle, and it goes out to FluidTalk as
 * `own_username`, filing a real conversation under an account it never happened
 * on. So it is read from the per-platform `ownUsernames` map instead, and a
 * platform absent from it gets NOTHING: empty fails loudly ("could not tell
 * which account is signed in") where a wrong one fails silently. The flat value
 * is used only for the platform it was actually detected on.
 */
function migrate(old) {
  const platformKeys = Object.keys(PLATFORM_DEFAULTS);
  // Whatever of the old flat object was a real per-platform setting. Read by
  // key rather than by exclusion, so a removed setting (`multiplatform`,
  // `disabledPlatforms`, `mode`) is dropped rather than carried as a dead field
  // that later reads as configuration.
  const inherited = {};
  for (const k of platformKeys) {
    if (k !== "ownUsername" && Object.hasOwn(old, k)) inherited[k] = old[k];
  }

  const disabled = new Set(old.disabledPlatforms ?? []);
  const handles = old.ownUsernames ?? {};

  /**
   * EXACTLY ONE PLATFORM COMES ACROSS BOUND, because only one can be.
   *
   * The old build ran every enabled platform at once, so an install can have
   * three of them switched on and no statement anywhere about which the user
   * considers theirs. `platform` is the last one actually worked, which is the
   * only signal the old store carries — so that wins, provided it had not been
   * switched off. Otherwise the first still-enabled one, in registry order, so
   * the choice is at least deterministic rather than whatever the object
   * happened to enumerate first. Everything off means nothing bound.
   */
  /**
   * ⚠ ONLY PLATFORMS THE OLD STORE KNEW ABOUT ARE ELIGIBLE.
   *
   * Filtering the CURRENT registry by `disabledPlatforms` looks right and is
   * not: a platform added after that store was written cannot possibly appear
   * in the disabled list, so it counts as enabled — and on an install where
   * everything had been switched off it then becomes the BOUND one. Adding
   * Threads bound Threads on every such install, silently, and binding is what
   * decides which account gets worked.
   *
   * "Knew about" is the union of the three places the old store names a
   * platform: the one it was working, the handles it had detected, and the ones
   * explicitly switched off. A platform in none of them did not exist yet, and
   * a migration must not make a decision on the user's behalf about software
   * they have never seen.
   */
  const known = new Set(
    [...disabled, ...Object.keys(handles), old.platform].filter(Boolean),
  );
  const enabled = PLATFORMS.filter((p) => known.has(p.id) && !disabled.has(p.id)).map((p) => p.id);
  const bound = enabled.includes(old.platform) ? old.platform : (enabled[0] ?? null);

  const platforms = {};
  for (const p of PLATFORMS) {
    platforms[p.id] = {
      ...inherited,
      // The per-platform map first; the flat field ONLY for the platform it was
      // actually detected on (very old builds had no map at all).
      ownUsername: handles[p.id] ?? (old.platform === p.id ? (old.ownUsername ?? "") : "") ?? "",
      configured: p.id === bound,
    };
  }

  return {
    version: VERSION,
    apiBase: API_BASE,
    connectorToken: old.connectorToken ?? "",
    historyLimit: old.historyLimit ?? GLOBAL_DEFAULTS.historyLimit,
    platforms,
  };
}

/** An empty store — a fresh install, with nothing set up. */
function emptyStore() {
  return { version: VERSION, ...GLOBAL_DEFAULTS, platforms: {} };
}

/**
 * The raw two-level store, migrated if it needs it.
 *
 * Migration is PERSISTED here rather than left to the next write, so "has this
 * install been migrated" stops depending on whether anybody has saved a setting
 * since. Nothing is written for a fresh install: there is no old configuration
 * to preserve, and writing on every read would turn a status poll into a write.
 */
export async function loadStore() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  if (!stored) return emptyStore();
  if (stored.version === VERSION) {
    return { ...emptyStore(), ...stored, platforms: { ...(stored.platforms ?? {}) }, apiBase: API_BASE };
  }
  const migrated = migrate(stored);
  await chrome.storage.local.set({ [KEY]: migrated });
  return migrated;
}

/**
 * One platform's settings, FLAT — globals and that platform's values merged.
 *
 * This is the shape everything downstream already reads, which is the whole
 * reason the nesting stops at the store. `platform` is set from the id rather
 * than stored, because FluidTalk keys a lead by (character, platform, handle)
 * and a stored value could disagree with the tab it was read for.
 *
 * `platformId` may be null, for the calls that genuinely have no platform —
 * checking the token, painting the panel before anything is open. That answer
 * carries the globals and the DEFAULTS only: handing back one platform's values
 * because it happened to be first would be a wrong answer dressed as a real one.
 */
export async function loadSettings(platformId = null) {
  const store = await loadStore();
  const { configured: _configured, ...mine } = platformId ? (store.platforms?.[platformId] ?? {}) : {};
  return {
    ...PLATFORM_DEFAULTS,
    ...GLOBAL_DEFAULTS,
    connectorToken: store.connectorToken ?? "",
    historyLimit: store.historyLimit ?? GLOBAL_DEFAULTS.historyLimit,
    ...mine,
    apiBase: API_BASE,
    platform: platformId ?? null,
  };
}

/**
 * Save a patch, routing each key to where it belongs.
 *
 * The caller does not have to know which settings are global — the panel binds
 * a control to a key and this decides. That matters because the split is not
 * visible in the UI and never should be: "the token is install-wide but the
 * rate cap is per account" is a fact about the product, not a thing to make
 * somebody remember while typing in a form.
 *
 * SAVING A SETTING DOES NOT BIND A PLATFORM. Binding is its own explicit act
 * (`setConfigured`, the Bind button) and deliberately not a side effect of
 * touching a control: settings can be read and adjusted on a platform you have
 * not decided to run, and enrolling an account because somebody nudged a number
 * while looking at it is not a decision anybody made.
 */
export async function saveSettings(platformId, patch = {}) {
  const store = await loadStore();
  const mine = { ...(store.platforms?.[platformId] ?? {}) };

  for (const [k, v] of Object.entries(patch)) {
    if (isGlobalKey(k)) store[k] = v;
    else if (platformId) mine[k] = v;
    // A per-platform key with no platform is dropped rather than written
    // somewhere arbitrary: there is no "current platform" to fall back to, and
    // guessing one writes a real setting onto an account nobody named.
  }

  if (platformId) store.platforms = { ...store.platforms, [platformId]: mine };
  // apiBase is PINNED on write, not merely defaulted. A default only applies to
  // a fresh install; settings written by an earlier build are already stored,
  // and merging them over the defaults could point a live account at staging.
  store.apiBase = API_BASE;
  store.version = VERSION;
  await chrome.storage.local.set({ [KEY]: store });
  return loadSettings(platformId);
}

/**
 * Record the handle we DETECTED on a platform.
 *
 * Deliberately not `saveSettings`: a detected fact is not a setup step. Opening
 * a WhatsApp tab tells us the number signed in there, and if that marked
 * WhatsApp as set up, merely having the tab open would enrol it — which is
 * exactly the "user must set up each platform" rule, broken by a side effect.
 */
export async function rememberHandle(platformId, handle) {
  if (!platformId) return;
  const store = await loadStore();
  const mine = { ...(store.platforms?.[platformId] ?? {}) };
  if (mine.ownUsername === handle) return;
  mine.ownUsername = handle;
  store.platforms = { ...store.platforms, [platformId]: mine };
  await chrome.storage.local.set({ [KEY]: store });
}

/** The handle detected on a platform, straight off the store. */
export function handleOn(store, platformId) {
  return store?.platforms?.[platformId]?.ownUsername || "";
}

/**
 * Has the user BOUND this platform? (The panel calls it "bind"; the stored flag
 * is still `configured`, and the two words mean the same thing — it is kept as
 * `configured` only because renaming a persisted key would silently unbind
 * every platform anybody has already set up.)
 *
 * The gate on everything: an unbound platform is not merely skipped by the
 * sweep, the extension does not act on it at all — no auto-reply, no
 * follow-ups, and the panel's own buttons refuse. Opt-IN rather than the old
 * opt-out `disabledPlatforms`, because a platform you have never bound is one
 * whose caps, ladder and account you have never looked at, and running it on
 * defaults is not something anybody asked for.
 */
export function platformConfigured(store, platformId) {
  return Boolean(store?.platforms?.[platformId]?.configured);
}

/** Every platform id the user has set up. */
export function configuredPlatforms(store) {
  return PLATFORMS.filter((p) => platformConfigured(store, p.id)).map((p) => p.id);
}

/**
 * Bind a platform, or unbind it.
 *
 * BINDING IS EXCLUSIVE: at most one platform is bound at any time, so binding
 * one unbinds whatever was bound before. One account is worked at a time, and
 * "bound" is now the whole answer to which — there is no second switch and no
 * way for two to be live at once by accident.
 *
 * Unbinding binds nothing in its place. Falling back to another platform would
 * quietly start running an account the user had not chosen, which is the exact
 * thing an explicit bind exists to prevent.
 *
 * Every platform keeps its own settings either way — unbinding is not a reset,
 * so rebinding later picks up where it left off.
 */
export async function setConfigured(platformId, on) {
  const store = await loadStore();
  const platforms = {};
  for (const [id, block] of Object.entries(store.platforms ?? {})) {
    platforms[id] = { ...block, configured: false };
  }
  platforms[platformId] = { ...(platforms[platformId] ?? {}), configured: Boolean(on) };
  store.platforms = platforms;
  store.version = VERSION;
  await chrome.storage.local.set({ [KEY]: store });
  return store;
}

// ── presets ──────────────────────────────────────────────────────────────────

/**
 * A PRESET is a whole-extension snapshot: the token, which platform is bound,
 * and every platform's settings.
 *
 * It exists because a fleet of anti-detect browser profiles (AdsPower and the
 * like) is otherwise configured one panel at a time. Every profile is a
 * separate Chromium user-data-dir with its own `chrome.storage.local`, so there
 * is no shared state to configure — but the profiles DO share one unpacked
 * extension folder, and a file inside that folder is readable by all of them.
 * That file is the only medium a fleet actually has in common.
 *
 * ⚠ AN EXTENSION CANNOT WRITE TO ITS OWN PACKAGE. Saving a preset therefore
 * writes to `storage.local` (this profile only); making one fleet-wide is an
 * explicit export-and-drop-the-file step. There is no way around that, and a UI
 * that implies otherwise would be lying.
 */
export const PRESET_FORMAT = 1;

const PRESETS_KEY = "fluidextension.presets";

/**
 * Settings a preset must NEVER carry, however it was produced.
 *
 * `ownUsername` is DETECTED from the page. Shipping one profile's handle to
 * fifty others would send `own_username` for an account they are not signed in
 * to, and FluidTalk keys a lead by (character, platform, handle) — so it files
 * real conversations under accounts they never happened on. This is the single
 * most damaging thing a shared config could do, so it is stripped on the way
 * out AND on the way in rather than trusted at either end.
 */
const NEVER_IN_A_PRESET = new Set(["ownUsername"]);

/** This install, as a preset. */
export async function exportPreset(name, { includeToken = true } = {}) {
  const store = await loadStore();
  const platforms = {};
  for (const p of PLATFORMS) {
    const { configured: _c, ...mine } = store.platforms?.[p.id] ?? {};
    for (const k of NEVER_IN_A_PRESET) delete mine[k];
    // Every platform, not just the bound one: a preset is the whole install, so
    // rebinding later must not find the others reverted to defaults.
    platforms[p.id] = mine;
  }
  const preset = {
    fluidextension: PRESET_FORMAT,
    name: String(name ?? "").trim() || "preset",
    bind: configuredPlatforms(store)[0] ?? null,
    platforms,
  };
  // OMITTED, not empty. An empty string would overwrite a good token with
  // nothing on the profile this preset is applied to.
  if (includeToken && store.connectorToken) preset.token = store.connectorToken;
  return preset;
}

/**
 * Is this a preset we can safely apply, and what does it reduce to?
 *
 * FAILS CLOSED, and that is the whole point of it. The fleet file is
 * authoritative and re-applied on every launch, so a malformed one does not
 * break a browser — it overwrites the working configuration of every profile in
 * the fleet at once, unattended and at the same moment. Nothing is applied
 * unless it validates whole.
 *
 * Unknown SETTING keys are dropped rather than rejected: a preset written by a
 * newer build must still load on an older one, and a stray key is not a reason
 * to refuse a fleet's configuration. Unknown PLATFORMS are rejected, because
 * that is a preset meant for something this build cannot drive.
 */
export function validatePreset(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["not an object"] };
  }
  if (obj.fluidextension !== PRESET_FORMAT) {
    errors.push(
      obj.fluidextension === undefined
        ? "missing the `fluidextension` format marker — this is not a FluidExtension preset"
        : `preset format ${obj.fluidextension}, but this build reads format ${PRESET_FORMAT}`,
    );
  }
  const name = String(obj.name ?? "").trim();
  if (!name) errors.push("missing a name");

  if (obj.token !== undefined && obj.token !== null) {
    if (typeof obj.token !== "string" || !obj.token.startsWith("ftc_")) {
      errors.push("token is not a connector token (must start with ftc_)");
    }
  }
  if (obj.bind !== undefined && obj.bind !== null && !platformById(obj.bind)) {
    errors.push(`binds "${obj.bind}", which is not a platform this build knows`);
  }

  const platforms = {};
  const given = obj.platforms;
  if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) {
    errors.push("`platforms` is not an object");
  } else {
    for (const [id, block] of Object.entries(given ?? {})) {
      if (!platformById(id)) {
        errors.push(`unknown platform "${id}"`);
        continue;
      }
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        errors.push(`settings for "${id}" are not an object`);
        continue;
      }
      const kept = {};
      for (const [k, v] of Object.entries(block)) {
        if (NEVER_IN_A_PRESET.has(k)) continue;
        if (Object.hasOwn(PLATFORM_DEFAULTS, k)) kept[k] = v;
      }
      // ⚠ THE ONLY SETTING WHOSE VALUE IS CHECKED, and it earns the exception.
      // Everything else here is a number or a flag: a bad one costs one
      // platform one wrong cap. A malformed week is applied to the whole fleet
      // at once and fails CLOSED — every profile silently stops acting — so
      // this is the last point at which anybody can be told why.
      if (Object.hasOwn(kept, "schedule")) {
        const parsed = parseSchedule(kept.schedule);
        for (const e of parsed.errors) errors.push(`${id} schedule: ${e}`);
      }
      platforms[id] = kept;
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    preset: {
      fluidextension: PRESET_FORMAT,
      name,
      bind: obj.bind ?? null,
      platforms,
      ...(obj.token ? { token: obj.token } : {}),
    },
  };
}

/**
 * Apply a preset over this install: token, every platform's settings, binding.
 *
 * OVERWRITES LOCAL EDITS BY DESIGN. The fleet file is the authority; a rate cap
 * changed centrally has to land on every profile, and a profile that kept a
 * hand-tweaked value would be the one that quietly does not.
 *
 * Two things are deliberately NOT overwritten:
 * - the DETECTED handle, which belongs to the page and not to the config;
 * - the token, when the preset does not carry one — a preset exported without
 *   it is "these settings", not "these settings and no character".
 *
 * All-or-nothing: it validates first and throws before writing anything, so a
 * bad preset cannot leave a profile half-configured.
 */
export async function applyPreset(preset) {
  const { ok, errors, preset: clean } = validatePreset(preset);
  if (!ok) throw new Error(`preset "${preset?.name ?? "?"}" is not usable: ${errors.join("; ")}`);

  const store = await loadStore();
  const platforms = {};
  for (const p of PLATFORMS) {
    const existing = store.platforms?.[p.id] ?? {};
    platforms[p.id] = {
      ...(clean.platforms[p.id] ?? {}),
      // Kept from THIS profile, whatever the preset says.
      ...(existing.ownUsername ? { ownUsername: existing.ownUsername } : {}),
      configured: p.id === clean.bind,
    };
  }
  store.platforms = platforms;
  if (clean.token) store.connectorToken = clean.token;
  store.apiBase = API_BASE;
  store.version = VERSION;
  await chrome.storage.local.set({ [KEY]: store });
  return { bound: clean.bind, platforms: Object.keys(clean.platforms) };
}

/** Presets saved in THIS profile. */
export async function listPresets() {
  const stored = (await chrome.storage.local.get(PRESETS_KEY))[PRESETS_KEY];
  return Array.isArray(stored) ? stored : [];
}

/** Snapshot the current install under `name`, replacing any preset of that name. */
export async function savePreset(name, { includeToken = true } = {}) {
  const preset = await exportPreset(name, { includeToken });
  const all = (await listPresets()).filter((p) => p.name !== preset.name);
  all.push(preset);
  await chrome.storage.local.set({ [PRESETS_KEY]: all });
  return preset;
}

/** Store a preset somebody handed us (an import), after validating it. */
export async function storePreset(preset) {
  const { ok, errors, preset: clean } = validatePreset(preset);
  if (!ok) throw new Error(errors.join("; "));
  const all = (await listPresets()).filter((p) => p.name !== clean.name);
  all.push(clean);
  await chrome.storage.local.set({ [PRESETS_KEY]: all });
  return clean;
}

export async function deletePreset(name) {
  const all = (await listPresets()).filter((p) => p.name !== name);
  await chrome.storage.local.set({ [PRESETS_KEY]: all });
  return all;
}

/**
 * Which preset out of a fleet file applies to THIS profile.
 *
 * Three sources, most specific first: an explicitly named one, the row for the
 * account actually signed in here, then the fleet default. The handle-keyed row
 * is what lets one identical file serve a fleet running different characters —
 * every profile reads the same bytes and selects its own.
 *
 * An unrecognised handle falls back to the default rather than to nothing: a
 * new account added to the fleet should start working, not sit unconfigured
 * until somebody edits the file.
 *
 * A bare preset object is accepted as a one-preset fleet, because that is what
 * an Export produces and making people wrap it by hand is a papercut that will
 * be got wrong.
 */
export function pickFleetPreset(fleet, { handle = null, name = null } = {}) {
  if (!fleet || typeof fleet !== "object") return null;
  const all = Array.isArray(fleet.presets) ? fleet.presets : fleet.platforms ? [fleet] : [];
  if (!all.length) return null;
  const byName = (n) => all.find((p) => p && p.name === n) ?? null;

  if (name) return byName(name);
  if (handle) {
    const mapped = (fleet.accounts ?? {})[handle];
    const hit = mapped ? byName(mapped) : null;
    if (hit) return hit;
  }
  return byName(fleet.default) ?? all[0] ?? null;
}

/**
 * The follow-up ladder as hours — each entry the wait before that nudge.
 *
 * Parsed leniently because it is a free-text field, but the ORDER IS KEPT AS
 * TYPED and repeats are kept. Each number is an independent window, so "48,12"
 * is a perfectly good ladder (wait two days, then chase a day later) and
 * "24,24,24" is three nudges a day apart. Sorting or de-duplicating here would
 * silently rewrite both into something else — that was only defensible while the
 * numbers were running totals, where an out-of-order entry really did mean two
 * nudges at once.
 */
export function followupStages(settings) {
  return String(settings.followupStagesHours ?? "")
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// ── the schedule ─────────────────────────────────────────────────────────────

/**
 * Day keys, INDEXED THE WAY `Date.getDay()` IS — Sunday first.
 *
 * The panel shows Monday first, because a working week does; the store is
 * indexed by what the clock actually returns, so nothing has to add six and
 * take a modulus at the one point where being a day out means an account acts
 * on the wrong evening.
 */
export const SCHEDULE_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "09:30" → 570. Null for anything that is not a time. */
function minuteOfDay(hhmm) {
  const m = HHMM.exec(String(hhmm ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 570 → "09:30". Minutes past 1440 wrap, so an overnight end prints as itself. */
export function clockOf(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The stored week, as minutes — or a list of what is wrong with it.
 *
 * STRICT, AND THAT IS THE POINT. Every other parser here is lenient because it
 * reads something a user typed into a text box; this one also reads a FLEET
 * FILE that is applied unattended to every profile at once, and the two ways of
 * being wrong are not symmetrical. A schedule silently treated as "no windows"
 * takes a fleet dark with nothing in the log; one silently treated as "always"
 * runs fifty real accounts around the clock. So a malformed week is an ERROR
 * that `validatePreset` can refuse and the panel can show, never a value.
 *
 * `from === to` is rejected rather than read as 24 hours: with `to < from`
 * already meaning "into tomorrow", a zero-length window is the one input whose
 * intent genuinely cannot be guessed.
 */
export function parseSchedule(value) {
  const days = SCHEDULE_DAYS.map(() => []);
  const errors = [];
  if (value === undefined || value === null) return { ok: true, days, errors };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, days, errors: ["the schedule is not a set of days"] };
  }

  for (const [key, windows] of Object.entries(value)) {
    const index = SCHEDULE_DAYS.indexOf(String(key).toLowerCase());
    if (index < 0) {
      errors.push(`"${key}" is not a day`);
      continue;
    }
    if (!Array.isArray(windows)) {
      errors.push(`${key}: the windows are not a list`);
      continue;
    }
    for (const window of windows) {
      if (!Array.isArray(window) || window.length !== 2) {
        errors.push(`${key}: a window must be a [from, to] pair`);
        continue;
      }
      const from = minuteOfDay(window[0]);
      const to = minuteOfDay(window[1]);
      if (from === null || to === null) {
        errors.push(`${key}: "${window[0]}"–"${window[1]}" is not a pair of times`);
        continue;
      }
      if (from === to) {
        errors.push(`${key}: ${window[0]}–${window[1]} is a window of no length`);
        continue;
      }
      days[index].push([from, to]);
    }
    days[index].sort((a, b) => a[0] - b[0]);
  }

  return { ok: errors.length === 0, days, errors };
}

/**
 * Local midnight `ahead` days from `now`, plus `minutes`.
 *
 * BUILT FROM CALENDAR FIELDS, NEVER BY ADDING MILLISECONDS. A day is not
 * reliably 86,400,000ms — twice a year it is an hour more or less — so
 * `now + 24h` lands at 08:00 or 10:00 on the days either side of a clock
 * change, and a "09:00" window would open an hour late for half the year.
 * Going through the calendar keeps 09:00 meaning 09:00.
 *
 * `minutes` may exceed 1440: `setMinutes` carries into the next day, which is
 * exactly how an overnight window's end is expressed.
 */
function localAt(now, ahead, minutes) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, 0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.getTime();
}

/**
 * How many minutes after the hour this account opens.
 *
 * DERIVED FROM WHO AND WHEN, NOT DRAWN. A random offset has to be remembered or
 * it is re-rolled on every tick — and a start time re-rolled every minute is
 * one that wanders, and that fires the moment a small number comes up rather
 * than at the minute it chose. Hashing (account, platform, this window's
 * opening) gives a number that is stable for as long as it has to be, different
 * for every profile in a fleet sharing one preset, and needs nothing stored.
 */
export function scheduleJitter(settings, windowStartMs) {
  const span = Math.max(0, Math.min(60, Math.round(Number(settings.scheduleJitterMin) || 0)));
  if (!span) return 0;
  const seed = `${settings.platform ?? ""}|${settings.ownUsername ?? ""}|${windowStartMs}`;
  // FNV-1a. Not a security hash — it only has to spread a fleet out.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % (span + 1);
}

/**
 * Where this platform stands against its own week, right now.
 *
 * ONE ANSWER, READ BY EVERYTHING — the minute tick that starts and stops a run,
 * the auto-reply gate, and the panel's readout. Three implementations of "are
 * we inside the hours" is three chances for the panel to say Asleep while the
 * worker is sending.
 *
 * `open` is what every caller actually asks, so a platform with no schedule
 * answers `true`: "may it act" is the question, and the answer for an account
 * nobody has given hours to is yes.
 *
 * `broken` FAILS CLOSED. An unreadable week is the one case where the two
 * mistakes are not equal — see `parseSchedule` — so nothing acts until it is
 * fixed, and the reason travels in `errors` so the panel and the log can say
 * which day is wrong rather than going quiet.
 */
export function scheduleState(settings, now = new Date()) {
  const base = { enabled: Boolean(settings?.scheduleEnabled), broken: false, errors: [], window: null, next: null };
  if (!base.enabled) return { ...base, open: true };

  const { ok, days, errors } = parseSchedule(settings?.schedule);
  if (!ok) return { ...base, broken: true, open: false, errors };

  const today = now.getDay();
  const at = now.getHours() * 60 + now.getMinutes();

  // Yesterday's windows are checked too, and only ever because one of them can
  // still be open: a window that started at 22:00 belongs to yesterday and runs
  // until 02:00 today.
  let window = null;
  for (const back of [0, 1]) {
    const day = (today - back + 7) % 7;
    for (const [from, to] of days[day]) {
      const end = to > from ? to : to + 1440;
      const minute = at + back * 1440;
      if (minute >= from && minute < end) {
        window = {
          day,
          from: clockOf(from),
          to: clockOf(to),
          startAt: localAt(now, -back, from),
          endAt: localAt(now, -back, end),
        };
        break;
      }
    }
    if (window) break;
  }

  // The next OPENING, which is a different question from "the next window":
  // inside one, this is when it wakes again after this one closes.
  let next = null;
  for (let ahead = 0; ahead <= 7 && !next; ahead++) {
    const day = (today + ahead) % 7;
    for (const [from] of days[day]) {
      const startAt = localAt(now, ahead, from);
      if (startAt > now.getTime()) {
        next = { day, from: clockOf(from), startAt, opensAt: startAt + scheduleJitter(settings, startAt) * 60_000 };
        break;
      }
    }
  }

  return {
    ...base,
    open: Boolean(window),
    window: window && { ...window, opensAt: window.startAt + scheduleJitter(settings, window.startAt) * 60_000 },
    next,
  };
}

/**
 * What is missing before this can talk to FluidTalk.
 *
 * Returned as a list rather than a boolean so the panel can name the field —
 * "not configured" sends the user hunting through three inputs.
 */
export function missingConfig(settings) {
  const missing = [];
  if (!settings.connectorToken) missing.push("connector token");
  else if (!settings.connectorToken.startsWith("ftc_")) {
    missing.push("connector token (must start with ftc_)");
  }
  // ownUsername is NOT listed: it is detected from the page, so a missing one
  // means the platform is not open yet, which is a different problem with a
  // different message.
  return missing;
}
