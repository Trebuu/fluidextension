/**
 * Every platform this extension can drive.
 *
 * ONE registry, for a reason: the platform is not a preference, it is a fact
 * about the tab in front of you. Storing it as a setting would let the panel
 * claim "instagram" while the user is on another site, and `platform` is not a
 * label — FluidTalk keys a lead by (character, platform, handle), so a wrong
 * value files a real conversation under a platform it did not happen on. It is
 * therefore DETECTED, never typed, the same way `ownUsername` already is.
 *
 * `id` is what FluidTalk is told and must match its own platform vocabulary.
 * `origin` is matched against the tab URL and is the only place a host appears.
 *
 * Adding a platform is this entry, a content script in `content/` implementing
 * the `ft:*` messages the worker sends, and its `matches` / `host_permissions`
 * in the manifest.
 */

/**
 * `routes` — every URL the worker navigates to, per platform.
 *
 * These used to be spelled out at each call site, and that was the single
 * biggest reason a second platform could not exist: twenty-one literal
 * `https://www.instagram.com/...` strings inside the worker, each one a silent
 * assumption that the tab was Instagram. Naming them here turns "go to the
 * inbox" into something a platform can answer differently — and a platform that
 * has no such page simply does not define the route, which the caller can then
 * refuse honestly instead of navigating somewhere wrong.
 *
 * `capabilities` — what a run may attempt.
 *
 * Telegram has no feed, no followers, no message requests and no public
 * comments, so a sweep must skip those passes BY DECLARATION rather than by
 * failing four times per run. The list is what has actually been implemented
 * and exercised on that platform, not what the site theoretically supports:
 * claiming a capability that has never been run is how "it's supported" becomes
 * a silent no-op.
 */
export const PLATFORMS = [
  {
    id: "instagram",
    label: "Instagram",
    origin: "https://www.instagram.com",
    capabilities: ["dm", "followups", "requests", "comments", "commentReplies", "outreach"],
    routes: {
      home: () => "https://www.instagram.com/",
      inbox: () => "https://www.instagram.com/direct/inbox/",
      requests: () => "https://www.instagram.com/direct/requests/",
      notifications: () => "https://www.instagram.com/notifications/",
      thread: (id) => `https://www.instagram.com/direct/t/${id}/`,
      profile: (handle) => `https://www.instagram.com/${handle}/`,
      post: (code) => `https://www.instagram.com/p/${code}/`,
    },
  },
  {
    /**
     * Telegram Web, K CLIENT ONLY.
     *
     * `web.telegram.org` serves two entirely different applications — K at
     * `/k/` and Z at `/a/` — that share nothing but the domain. The adapter is
     * written against K's markup, so the origin carries the path and the
     * manifest match does too; on `/a/` the extension must be absent rather
     * than present and blind.
     *
     * A chat is addressed by its hash: `#<peerId>` or `#@username`. Opening one
     * still needs a real pointer-event sequence on the chat list — setting the
     * hash alone does nothing, measured — so `thread` is where the worker lands
     * the tab and the adapter does the rest.
     */
    id: "telegram",
    label: "Telegram",
    origin: "https://web.telegram.org/k",
    // No `outreach`: that pass walks a FOLLOWERS list, which Telegram has no
    // equivalent of — there is no set of people who have opted into hearing
    // from us and have not written yet.
    capabilities: ["dm", "followups"],
    routes: {
      home: () => "https://web.telegram.org/k/",
      /**
       * NO `inbox` ROUTE, and that is the fix rather than an omission.
       *
       * Telegram's chat list is not a page — it is always in the DOM beside
       * whatever chat is open, so there is nowhere to navigate TO. Pointing
       * `inbox` at `/k/` looked harmless and was not: from `/k/#@someone` that
       * is a different URL, so the tab performs a real load, the whole SPA
       * re-boots (measured at 20s+, far past the 9s the sweep waits), and the
       * chat list is then read while it is still empty. The run reports
       * "sees 0 conversation(s)" and does nothing, every cycle, for ever.
       *
       * With no route, `goToRoute` refuses and says so, and the pass simply
       * reads the list that was already on screen.
       */
      thread: (id) => `https://web.telegram.org/k/#${id}`,
      profile: (handle) => `https://web.telegram.org/k/#@${String(handle).replace(/^@/, "")}`,
    },
  },
  {
    /**
     * WhatsApp Web.
     *
     * THE HANDLE IS A PHONE NUMBER. WhatsApp has no @username, so the only
     * thing that identifies a person across sessions is their number, in the
     * digits-only form WhatsApp itself uses in a JID (`15550123456@c.us` →
     * `15550123456`). That is what FluidTalk keys the lead by.
     *
     * NO ROUTES AT ALL, and that is the fix rather than an omission. WhatsApp
     * Web is a single URL: the chat list, the open conversation and everything
     * else live at `https://web.whatsapp.com/` with no path and no hash, so
     * there is nowhere to navigate TO. Pointing `inbox` or `thread` at `/`
     * would make the tab perform a real load and re-boot the whole SPA — the
     * same trap Telegram's `inbox` route sprang, where the run then reads an
     * empty chat list and reports "0 conversations" for ever. A chat is opened
     * through the adapter instead, which can do it exactly (see below).
     *
     * `home` exists only so a run that finds itself on the wrong page can get
     * back; nothing in the DM path uses it.
     */
    id: "whatsapp",
    label: "WhatsApp",
    origin: "https://web.whatsapp.com",
    /**
     * A STUCK "Your messages are downloading" IS CURED BY ANOTHER RELOAD.
     *
     * Worth writing down because it invites the opposite conclusion. Seen here
     * for twenty minutes — `progress: 0`, still logged in, browser online, tab
     * on screen and focused — which reads exactly like WhatsApp waiting on a
     * phone that is not answering, and that is what it was taken for. It is
     * not: reloading the tab again brought the chat list straight back with
     * the phone untouched. So the sync had wedged, and a reload is the repair
     * rather than the cause. This platform heals like the others.
     */
    // No `outreach`, `requests`, `comments` or `commentReplies`: WhatsApp has
    // no followers list, no message-requests folder and nothing public to
    // comment on. Declaring them would make a sweep fail four passes a run
    // instead of skipping them.
    //
    // ⚠ `followups` IS ABSENT ON PURPOSE, AND THE ADAPTER CAN DO IT.
    // It is recorded in `blockedCapabilities` below rather than simply deleted,
    // so the reason travels with the decision and turning it back on is one
    // line rather than an archaeology exercise.
    capabilities: ["dm"],

    /**
     * Capabilities this adapter implements but must not use here.
     *
     * WHY FOLLOW-UPS ARE BLOCKED ON WHATSAPP, measured 2026-09-15.
     *
     * A follow-up is an UNSOLICITED outbound message — we start it; the lead
     * did not just write. WhatsApp treats one of those from a linked web
     * session as abuse and drops the session: the account is signed out, and it
     * took exactly one message.
     *
     * The extension's own log of the run that did it:
     *
     *     sweep sees 2 conversation(s) in the inbox
     *     follow-ups: 2 queued
     *     <lead>: sent 1/1
     *     follow-up 1/3 sent to <lead> (quiet unknown)
     *     WhatsApp cycle 1 done — 0 replied there; watching
     *
     * `0 replied` is the whole point: the sweep answered nobody. The only
     * message that left was the nudge, and the session went with it.
     *
     * REPLYING IS UNAFFECTED — that is what `dm` covers, and it ran for days
     * without trouble. The difference is who starts the conversation.
     *
     * Note `(quiet unknown)`: it could not even establish how long that lead
     * had been silent, so the nudge fired without the silence it is named for.
     *
     * Instagram keeps follow-ups; it tolerates them. If WhatsApp ever changes,
     * move "followups" back into `capabilities` and delete this entry.
     */
    blockedCapabilities: {
      followups:
        "WhatsApp signs the account out for an unsolicited message — one follow-up cost a linked session on 2026-09-15.",
    },
    routes: {
      home: () => "https://web.whatsapp.com/",
    },
  },
];

/** The platform a URL belongs to, or null. */
export function platformForUrl(url) {
  if (!url) return null;
  return PLATFORMS.find((p) => url.startsWith(`${p.origin}/`)) ?? null;
}

export function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) ?? null;
}

/** Can this platform do `capability`? */
export function supports(platform, capability) {
  return Boolean(platform?.capabilities?.includes(capability));
}

/**
 * A platform's URL for `name`, or null when it has no such page.
 *
 * Null is a real answer, not a failure: Telegram has no notifications page we
 * drive and no message-requests folder, and the caller is expected to skip that
 * pass rather than navigate somewhere that does not exist.
 */
export function routeFor(platform, name, ...args) {
  const fn = platform?.routes?.[name];
  return typeof fn === "function" ? fn(...args) : null;
}

/** "Instagram" / "Instagram or Telegram" — for the one message that names them. */
export function platformNames() {
  const names = PLATFORMS.map((p) => p.label);
  if (names.length <= 1) return names[0] ?? "a supported platform";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
