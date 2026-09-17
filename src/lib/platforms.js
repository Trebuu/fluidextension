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
    // instead of skipping them. `followups` is here but RISKY — see below.
    capabilities: ["dm", "followups"],

    /**
     * Capabilities that work, and can cost you the account.
     *
     * ⚠ A FOLLOW-UP ON WHATSAPP SIGNED THE ACCOUNT OUT, measured 2026-09-15.
     *
     * A follow-up is an UNSOLICITED outbound message — we start it; the lead
     * did not just write. WhatsApp treats one of those from a linked web
     * session as abuse and drops the session: the account was signed out, and
     * it took exactly one message.
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
     * ⚠ THIS WAS A BLOCKED CAPABILITY AND IS NOT ANY MORE — the owner's call,
     * 2026-09-17. Declaring it absent meant the settings block was hidden
     * outright, so the one measurement that matters here was invisible to the
     * person deciding: the switch was missing with no explanation, which reads
     * as "WhatsApp cannot do this" rather than "this cost us an account". It is
     * now a real capability, DEFAULT OFF for WhatsApp alone (see
     * `PLATFORM_OVERRIDES` in settings.js) and labelled Risky in the panel with
     * this sentence on its info tip. Off-by-default plus a stated reason beats
     * an absent control: whoever turns it on has read why not to.
     */
    riskyCapabilities: {
      followups:
        "WhatsApp can sign your account out for this. A follow-up is a message nobody asked for, and one of them cost a linked session on 2026-09-15 — the account was logged out after a single nudge. Replying to people who wrote to you is unaffected.",
    },
    routes: {
      home: () => "https://web.whatsapp.com/",
    },
  },
  {
    /**
     * Threads.
     *
     * ⚠ `threads.net` IS NOT THE ORIGIN ANY MORE. It 301s to `threads.com`,
     * measured 2026-09-16 — so a manifest match or a `startsWith` on the old
     * domain would put the adapter on a page that immediately navigates away,
     * and `platformForUrl` would answer null for every real Threads tab.
     *
     * IT HAS ITS OWN DM SURFACE, which is the thing worth checking before
     * building anything here: Threads shipped without direct messages and sent
     * people to Instagram for them. It does not any more. `/messages/` is a
     * first-party inbox on threads.com, no iframe, with its own Requests and
     * Hidden folders.
     *
     * The sign-in is Instagram's, so a browser already signed in to Instagram
     * is usually signed in here too — which also means a ban here is a ban on
     * the same identity Instagram uses. Treat it with Instagram's caution, not
     * Telegram's.
     */
    id: "threads",
    label: "Threads",
    origin: "https://www.threads.com",

    /**
     * ⚠ THIS CLIENT NEVER RE-RENDERS WHAT IS ALREADY ON SCREEN.
     *
     * Measured on the wire 2026-09-16: an inbound message arrives perfectly —
     * 7 large frames over `wss://gateway.threads.com/ws/lightspeed` while the
     * conversation was open and visible — and Threads draws NONE of it. The
     * bubble count stayed at 4 for four minutes. Scrolling the pane, and
     * blur/focus/visibilitychange, changed nothing. Nor is it only the open
     * thread: a list left sitting on `/messages/` kept showing `a_lead Hey`
     * while a fresh render of the same URL read `a_lead What's time is it?`.
     *
     * So a MutationObserver cannot see an incoming Threads message — there is
     * no mutation — and `goTo`'s "already on that URL, not reloading it" skip
     * turns a cycle into re-reading one stale snapshot for ever. That skip
     * exists for a real reason (Instagram's re-bootstrap earned 12,942
     * rate-limited requests), so it stays everywhere else and is turned off
     * here, where a navigation is the only thing that refreshes anything.
     */
    rerenderOnRevisit: true,

    /**
     * `dm` only. Everything else is IMPLEMENTED AND GATED, which is not the
     * same as missing — see `blockedCapabilities` for why each one is off.
     *
     * `requests` was declared for a while on the strength of `acceptRequest`
     * having been run for real against a pending request. It was taken back
     * after the WHOLE flow was traced instead of just that step: the worker
     * does list -> open -> accept, and clicking a request row from
     * /messages/requests navigates to `/<8 chars>/messages`, a page with no
     * composer, no accept control and no thread id. The accept works; there is
     * no way to get standing in front of one.
     *
     * `outreach` WAS off by choice and is now declared, at the owner's request
     * (2026-09-16). The thing that made it worthless on Instagram — profiles
     * offering no way to message us, failing 100% and earning a sustained 429 —
     * does not happen here. Dry-run probed against four real profiles, two of
     * them strangers taken from the home feed: every one offered exactly one
     * message control ("Wyślij wiadomość"). Both candidate sources read too:
     * the feed gave 8 posts / 8 distinct authors with sponsored already
     * filtered, and the followers dialog gave 9 handles.
     *
     * ⚠ It is still the only thing here that writes to somebody who never
     * wrote to us, on an identity that is Instagram's — a ban here is a ban
     * there. It stays behind `outreachEnabled`, its own hourly/daily budget,
     * and the consecutive-failure breaker.
     */
    capabilities: ["dm", "followups", "requests", "comments", "commentReplies", "outreach"],

    /**
     * Implemented, verified as far as it could be verified, and NOT declared.
     *
     * The adapter answers every one of these (`ft:read-feed`, `ft:read-post`,
     * `ft:read-comments`, `ft:post-comment`, `ft:post-comment-reply`,
     * `ft:list-followers`, `ft:open-dm`, …) and the read paths are all
     * verified against the live site. What is missing in each case is a
     * publish or an outbound message that has actually landed, and every one
     * of those is an action against somebody else.
     */
    /*
     * The long version, kept here rather than in the strings — these render as
     * a note in the side panel, where the standing instruction is one short
     * sentence:
     *
     *   requests        /messages/requests lists correctly and ft:list-threads
     *                   returns the pending row. acceptRequest itself works —
     *                   it has been run for real. What does not work is GETTING
     *                   THERE: clicking the row navigates to `/<8 chars>/
     *                   messages`, which renders no composer, no Accept, no
     *                   Block and no thread id, and stays that way. Until a
     *                   request can be opened, declaring this would list the
     *                   folder and accept nothing.
     *   comments        Publishing is proven: a top-level comment was posted
     *                   and confirmed on OUR OWN post (ft:post-comment ->
     *                   {ok:true, id}). What has never been done is publish on
     *                   a STRANGER's post, which is what the capability does.
     *                   Same mechanism, different blast radius.
     *   commentReplies  A threaded reply publishes but is not CONFIRMED: it
     *                   does not come back from readComments on the post it was
     *                   written from, so the adapter reports
     *                   not_visible_after_publishing and the worker would post
     *                   it a second time. Find where Threads renders a
     *                   reply-to-a-reply first.
     *   followups       An unsolicited outbound message, and one of those cost
     *                   a linked WhatsApp session on 2026-09-15. Threads is the
     *                   same company and — because the sign-in is Instagram's —
     *                   the same identity. ft:open-dm is built and dry-run
     *                   verified; nothing has been sent.
     *   outreach        The same, more so: it messages people who never wrote.
     *                   The followers list it would draw from reads correctly
     *                   (8 handles out of the profile dialog).
     */
    /**
     * NOTHING IS BLOCKED ANY MORE — parity with Instagram, at the owner's
     * request (2026-09-16). Each of the four reasons that used to live here was
     * retired by doing the thing it described, not by deciding it was fine:
     *
     *   requests        "a request row does not open into anything" — it does,
     *                   if you NAVIGATE instead of clicking. A requests row is
     *                   a real anchor to `/messages/t/<id>/`; going there gives
     *                   a thread id, `is_request`, and Accept sitting next to
     *                   Block and Delete. Verified on a live pending request.
     *   comments        Published on two strangers' posts and confirmed on a
     *                   fresh render.
     *   commentReplies  "cannot be confirmed on the page" — because Threads
     *                   NEVER renders a reply-to-a-reply on the parent post at
     *                   all; it lives on `/@us/replies`. Confirmation now comes
     *                   from the composer clearing itself, and a real reply was
     *                   published and answered exactly once (a re-run reported
     *                   "0 unanswered").
     *   followups       Was off by choice while outreach was too. Outreach is
     *                   declared now, and a follow-up only reaches somebody
     *                   already in a conversation — strictly less exposure than
     *                   the cold open beside it. One was delivered.
     *
     * ⚠ The caution that motivated those entries has NOT gone away: the sign-in
     * is Instagram's, so a ban here is a ban there. What changed is that each
     * path is now exercised end to end rather than assumed.
     */
    blockedCapabilities: {},

    routes: {
      home: () => "https://www.threads.com/",
      inbox: () => "https://www.threads.com/messages/",
      requests: () => "https://www.threads.com/messages/requests",
      notifications: () => "https://www.threads.com/activity",
      profile: (handle) => `https://www.threads.com/@${String(handle).replace(/^@/, "")}`,
      /**
       * A post is `/@author/post/<code>`, so the code alone cannot address one
       * — the author is part of the path. Callers that hold only a code have
       * nothing to navigate to, which is why this takes both.
       *
       * ⚠ THIS ADDRESS DOES NOT SURVIVE A COLD LOAD. Navigating to it answers
       * **302** to `/?…=["<id>"]`, and the app then rewrites history to `/` —
       * measured on the wire, twice, on fresh targets. So a worker that
       * "navigates to a post" lands on the HOME FEED and reads whatever is at
       * the top of it, which is somebody else's post entirely.
       *
       * A post opens by CLICKING its link from a list (feed, profile,
       * /activity): that is an in-app navigation, the address then becomes this
       * one, and the reply composer mounts. `ft:open-post` does exactly that.
       * This route is kept because it is the right address to RECOGNISE and to
       * show a human — it is not a route to navigate to.
       *
       * It returns NULL when called the way the worker calls it — `goToRoute
       * ("post", [code])` passes one argument, so `code` is undefined here. A
       * null route makes goToRoute log "Threads has no post page — skipped" and
       * stop, which is the honest outcome: building a URL out of the code alone
       * would navigate somewhere that redirects to the feed and then read a
       * stranger's post as though it were the one asked for.
       */
      post: (handle, code) =>
        code ? `https://www.threads.com/@${String(handle).replace(/^@/, "")}/post/${code}` : null,
      /**
       * A THREAD IS ADDRESSABLE: `/messages/t/<id>/`, and navigating straight
       * to one opens it with no click on the list at all. Verified by loading
       * the URL in a fresh tab — the address holds and the conversation
       * renders. That puts Threads with Instagram rather than WhatsApp, and it
       * is the difference between a thread the worker can OPEN and one it can
       * only hope it clicked.
       *
       * ⚠ An earlier reading of this was WRONG and said so in a commit: the
       * first probe clicked the list HEADER rather than a conversation row, saw
       * the URL stay on `/messages/`, and concluded there was no route. The
       * rows are the elements whose clickable ancestor is a `role=link`.
       */
      thread: (id) => `https://www.threads.com/messages/t/${id}/`,
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
