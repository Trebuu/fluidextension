/**
 * FluidTalk Characters Public API v1 client.
 *
 * Contract (backend/app/strategy_engine/characters_v1.py):
 *   POST {apiBase}/api/v1/characters/chat
 *   header: X-Connector-Token: ftc_…
 *   body:   {platform, handle, message, own_username?, session_id?, image_url?}
 *   200:    {data: {...}, request_id}
 *   error:  {error: {code, message, type, request_id}}
 *
 * Two things about the auth are load-bearing:
 *  - The token IS the character. There is no character_id field anywhere in
 *    this API; swapping the token swaps who replies.
 *  - The header is `X-Connector-Token` and nothing else — `bot_auth.py` reads a
 *    single APIKeyHeader with no Authorization fallback, so a Bearer token is a
 *    401 with no hint about why.
 */

export class FluidTalkError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = "FluidTalkError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * FluidTalk's developer test modes, selected per request.
 *
 *   live    (default) — production behaviour.
 *   mock              — no model call, fixtures picked by the lead HANDLE the way Stripe
 *                       picks a decline by card number. Free, instant, writes nothing.
 *   sandbox           — the real pipeline on a disposable lead. Billed, but the
 *                       duplicate-message guard is OFF and sessions are origin='test'.
 *
 * The safety rule is the API's, not ours: mock and sandbox REFUSE any handle
 * not starting `test_`, with a 400. That is what stops a mode left switched on
 * from serving a fixture to a real person — so passing a mode is never enough
 * on its own to endanger a live conversation.
 */
export const MODES = { LIVE: "live", MOCK: "mock", SANDBOX: "sandbox" };

async function post(settings, path, body, { mode } = {}) {
  let res;
  try {
    res = await fetch(`${settings.apiBase}/api/v1/characters${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Connector-Token": settings.connectorToken,
        ...(mode && mode !== MODES.LIVE ? { "X-FluidTalk-Mode": mode } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // fetch() rejects on DNS/TLS/offline — there is no status to report, and
    // "Failed to fetch" alone reads as an API outage rather than no network.
    throw new FluidTalkError(`cannot reach ${settings.apiBase}: ${cause.message}`);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = payload?.error ?? {};
    // NAME THE PLATFORM in the message. FluidTalk's own wording for the
    // commonest setup failure is "no workflow is bound for this platform on
    // this character" — which never says WHICH platform, so the log line reads
    // identically whichever one you are on, and the obvious reading ("but I'm
    // on Telegram") is indistinguishable from the actual fault ("you are on
    // Telegram, and the character has no Telegram workflow"). One clause here
    // makes every call site self-explanatory.
    const where = body?.platform ? ` [platform: ${body.platform}]` : "";
    throw new FluidTalkError(`${err.message || `HTTP ${res.status}`}${where}`, {
      status: res.status,
      code: err.code,
      requestId: err.request_id,
    });
  }
  return payload?.data ?? {};
}

/**
 * Send a lead's inbound message and get the character's reply bubbles.
 *
 * Resolves to the handler's own shape, verbatim:
 *   {session_id, bubbles: [{text, delay_ms, image_url}], deduped?, ignored?,
 *    ignore_reason?, paused?, pause_reason?}
 *
 * A reply of `bubbles: []` is a NORMAL outcome, not a failure — the character
 * deliberately stays silent when the turn was deduped, the lead is claimed by
 * another of the owner's accounts, or the plan is over its cap. The caller has
 * to distinguish "nothing to send" from "the call broke", so the flags come
 * back untouched instead of being collapsed into an array.
 */
export async function chat(settings, { handle, message, sessionId, imageUrl, mode }) {
  return post(
    settings,
    "/chat",
    {
      platform: settings.platform,
      handle,
      message,
      ...(settings.ownUsername ? { own_username: settings.ownUsername } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      // A photo the LEAD sent. Must be a URL the model provider can fetch —
      // Instagram's own CDN links are signed and expiring, so they fail, and
      // they fail SILENTLY: the reply still arrives, just blind. `vision.seen`
      // in the response is the only signal, which is why callers must read it.
      ...(imageUrl ? { image_url: imageUrl } : {}),
    },
    { mode },
  );
}

/**
 * Upload image bytes and get back a URL the model provider can actually fetch.
 *
 * This is the answer to Instagram's expiring CDN links: download the photo the
 * lead sent, post the bytes here, and pass the returned URL to `chat` as
 * `image_url`. Max 10 MB decoded.
 */
export async function inboundMedia(settings, { dataB64, filename, contentType, mode }) {
  return post(
    settings,
    "/inbound-media",
    {
      platform: settings.platform,
      data_b64: dataB64,
      ...(filename ? { filename } : {}),
      ...(contentType ? { content_type: contentType } : {}),
    },
    { mode },
  );
}

/**
 * Ask the character for a COLD OPEN to somebody who has not written to us.
 *
 * A different endpoint from `chat` on purpose. `chat` answers an inbound
 * message and needs one to exist; outreach has no inbound, so it fires the
 * character's built-in Outreach entry instead — `event_id: "outreach"` is a
 * reserved key, and an unknown one is a NO-OP rather than an error, so a typo
 * here returns success with no bubbles rather than sending something wrong.
 *
 * `external_event_id` is an idempotency key: the same value fires exactly once,
 * which is what stops a retry (or a second sweep) from opening the same person
 * twice.
 */
export async function outreach(settings, { handle, externalEventId, context }) {
  return post(settings, "/triggers", {
    platform: settings.platform,
    handle,
    event_id: "outreach",
    external_event_id: externalEventId,
    ...(settings.ownUsername ? { own_username: settings.ownUsername } : {}),
    ...(context ? { context } : {}),
  });
}

/**
 * Ask the character to QUEUE follow-ups for leads who have gone quiet.
 *
 * This is where the words come from. The extension decides *when* somebody is
 * due a nudge; FluidTalk decides what the nudge says, walking its own ladder of
 * prompts so a first nudge and a third do not read identically.
 *
 * Each queued follow-up is a generation, hence `limit`. The engine also applies
 * its own `min_spacing_hours` and `max_per_90d`, so a sweep can legitimately
 * queue nothing — that is the character declining, not a failure.
 */
export async function sweepFollowups(settings, { idleHours, limit }) {
  return post(settings, "/followups/sweep", {
    platform: settings.platform,
    ...(idleHours ? { idle_hours: idleHours } : {}),
    ...(limit ? { limit } : {}),
  });
}

/**
 * Pull the pending follow-ups, oldest first.
 *
 * Returns `{followups: [{id, handle, message, ...}]}`. A pulled follow-up stays
 * PENDING until acked, so a crash between pull and send loses nothing — it will
 * come back on the next pull rather than being silently dropped.
 */
/**
 * A queued follow-up's text, split back into the messages it actually is.
 *
 * `reengagement.py` joins a multi-message follow-up into ONE string with
 * " ||| ". The MCP surface splits it; the connector API deliberately does not,
 * because `message` is a published contract. Seen live in the queue:
 * "hey stranger ||| been thinking about you a bit lately, ngl" — sent as-is,
 * the lead receives the pipes.
 */
export function splitFollowupMessage(message) {
  return String(message ?? "")
    .split("|||")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A queued follow-up as bubbles, whichever shape it arrived in.
 *
 * Live returns `message` — one string, multi-part joined with " ||| ". Mock
 * returns a `bubbles` ARRAY instead. Reading only `message` meant every
 * follow-up under mock delivered nothing, silently, which is exactly the
 * failure mode the test surface exists to expose rather than create.
 */
export function followupBubbles(fu) {
  if (Array.isArray(fu?.bubbles) && fu.bubbles.length) {
    return fu.bubbles.map((b) => ({ text: b.text ?? "", delay_ms: b.delay_ms, image_url: b.image_url ?? null }));
  }
  return splitFollowupMessage(fu?.message).map((text) => ({ text }));
}

export async function listFollowups(settings, { limit = 50 } = {}) {
  const url = new URL(`${settings.apiBase}/api/v1/characters/followups`);
  url.searchParams.set("platform", settings.platform);
  url.searchParams.set("limit", String(limit));
  if (settings.ownUsername) url.searchParams.set("own_username", settings.ownUsername);

  let res;
  try {
    res = await fetch(url, { headers: { "X-Connector-Token": settings.connectorToken } });
  } catch (cause) {
    throw new FluidTalkError(`cannot reach ${settings.apiBase}: ${cause.message}`);
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new FluidTalkError(err.message || `HTTP ${res.status}`, {
      status: res.status,
      code: err.code,
      requestId: err.request_id,
    });
  }
  return payload?.data?.followups ?? [];
}

/**
 * Mark a follow-up delivered. PENDING -> DELIVERED, and idempotent.
 *
 * Only ever called once the message is CONFIRMED in the thread. Acking on the
 * attempt instead would quietly retire a follow-up that never arrived, and the
 * lead would simply never hear from us again.
 */
export async function ackFollowup(settings, id) {
  return post(settings, `/followups/${encodeURIComponent(id)}/ack`, {});
}

/**
 * Fire a CUSTOM event trigger — "something happened", as opposed to "they said
 * something".
 *
 * This is the honest way to tell the character about an event we cannot express
 * as the lead's words. Putting "[they sent a photo you cannot open]" through
 * /chat would record it as THEIR message, which is the fabrication problem all
 * over again; an entry point is the mechanism built for it.
 *
 * An unknown `event_id` is a fail-closed no-op, and in live mode the reply
 * lists the ids that WOULD have fired — which is also how you discover what a
 * character has configured.
 */
export async function fireTrigger(settings, { handle, eventId, externalEventId, context, mode }) {
  return post(
    settings,
    "/triggers",
    {
      platform: settings.platform,
      handle,
      event_id: eventId,
      external_event_id: externalEventId,
      ...(settings.ownUsername ? { own_username: settings.ownUsername } : {}),
      ...(context ? { context } : {}),
    },
    { mode },
  );
}

/**
 * Ask the character for a comment on a public post.
 *
 * COMMENTS ARE OFF BY DEFAULT, per workflow, and the endpoint FAILS CLOSED:
 * every call returns `ignore_reason: "comments_disabled"` with `comment: null`
 * until someone turns Comments on in the workflow's settings. FluidTalk's own
 * source notes the comment tables sat at zero rows all-time while an integrator
 * assumed the endpoint was broken — so the caller must read `ignore_reason`,
 * never just `ok`.
 *
 * `post.image_urls` feeds vision (up to 4 reach the model). An image that
 * cannot be fetched does NOT fail the call: the comment is written from the
 * caption alone and comes back blander, with `vision.seen: false` as the only
 * trace.
 */
export async function comment(settings, { postRef, caption, imageUrls, authorHandle, mode }) {
  return post(
    settings,
    "/comments",
    {
      platform: settings.platform,
      post_ref: postRef,
      post: {
        ...(caption ? { caption } : {}),
        ...(imageUrls?.length ? { image_urls: imageUrls.slice(0, 4) } : {}),
        ...(authorHandle ? { author_handle: authorHandle } : {}),
      },
    },
    { mode },
  );
}

/**
 * Reply to somebody who replied to our comment.
 *
 * Every stop rule returns `ok: true` with a `decision` — "skip", "bow_out" —
 * so a refusal looks exactly like a success unless `decision` is read. Post
 * nothing unless a `reply` actually came back.
 */
export async function commentReply(settings, { postRef, replierHandle, replyText, parentRef, mode }) {
  return post(
    settings,
    "/comments/reply",
    {
      platform: settings.platform,
      post_ref: postRef,
      replier_handle: replierHandle,
      reply_text: replyText ?? "",
      ...(parentRef ? { parent_comment_ref: parentRef } : {}),
    },
    { mode },
  );
}

/**
 * Cheapest call that proves the token is live and says which character it is.
 *
 * There is no /whoami on this API, so a zero-cost probe does not exist: any
 * check has to be a real request. `followups` is a GET that lists pending
 * proactive messages — it authenticates the token and starts no conversation,
 * which the chat endpoint cannot promise.
 */
export async function checkToken(settings) {
  const url = new URL(`${settings.apiBase}/api/v1/characters/followups`);
  url.searchParams.set("platform", settings.platform);
  url.searchParams.set("limit", "1");
  if (settings.ownUsername) url.searchParams.set("own_username", settings.ownUsername);

  let res;
  try {
    res = await fetch(url, { headers: { "X-Connector-Token": settings.connectorToken } });
  } catch (cause) {
    throw new FluidTalkError(`cannot reach ${settings.apiBase}: ${cause.message}`);
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new FluidTalkError(err.message || `HTTP ${res.status}`, {
      status: res.status,
      code: err.code,
      requestId: err.request_id,
    });
  }
  return payload?.data ?? {};
}
