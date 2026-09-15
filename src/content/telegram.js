/**
 * Telegram Web (K client) adapter — the same `ft:*` contract the Instagram
 * adapter answers, so the worker above it does not change.
 *
 * K ONLY. `web.telegram.org` serves two unrelated applications, K at `/k/` and
 * Z at `/a/`, sharing nothing but the domain. Every selector here is K's; the
 * manifest match carries the path so the adapter is absent on Z rather than
 * present and blind.
 *
 * Measured against a real logged-in account 2026-09-09, and it is worth saying
 * plainly how much friendlier this DOM is than Instagram's, because it changes
 * what the code has to do:
 *
 *   - Direction is a CLASS (`.bubble.is-out` / `.is-in`), not geometry. The
 *     Instagram adapter has to bound a column by pixel and drop full-width rows
 *     to tell whose message is whose; none of that is needed here, and the
 *     right-to-left-locale hazard that comes with it does not exist.
 *   - Every message carries `data-mid` and `data-timestamp`, so "have we seen
 *     this" is an id, not a text comparison.
 *   - Every chat row carries `data-peer-id`, and opening a chat puts the
 *     handle in the URL as `#@username` — the exact value FluidTalk keys a lead
 *     by, handed over rather than scraped.
 *
 * What is NOT easier: opening a chat. `.click()` on the row does nothing and
 * setting `location.hash` does nothing either — measured, both silently. Only a
 * full pointer-event sequence lands, which is why `openThread` sends one and
 * then verifies the hash actually changed.
 */
(() => {
  "use strict";

  const MAX_HISTORY = 40;
  const norm = (s) => (s ?? "").replace(/[\s ]+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── where are we ───────────────────────────────────────────────────────────

  /**
   * The open chat, as Telegram itself names it in the URL.
   *
   * Two shapes, both real: `#@username` for a user with a public handle, and
   * `#<peerId>` (negative for groups and channels) for everyone else. The
   * handle is what FluidTalk keys a lead by, so a chat with NO username is a
   * conversation we cannot file — `peerId` is stable but private to this
   * account, and inventing a handle from the display name is how one human
   * becomes two leads.
   */
  function chatRef() {
    const hash = decodeURIComponent(location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    if (hash.startsWith("@")) return { handle: hash.slice(1), peerId: null, ref: hash };
    if (/^-?\d+$/.test(hash)) return { handle: null, peerId: hash, ref: hash };
    return null;
  }

  /**
   * Telegram Web holds several accounts at once, one database per slot, and
   * which slot holds which is not knowable up front — so every read searches
   * all of them. See `number_of_accounts`.
   */
  const ACCOUNT_DBS = ["tweb-account-1", "tweb-account-2", "tweb-account-3", "tweb-account-4"];

  /**
   * Accounts this adapter will never answer. NOT a setting, and deliberately so.
   *
   * A character replying to a bot is never what anyone wanted: it is two
   * programs talking, it burns the plan's generations, and every reply is
   * logged against a "lead" that is not a person. There is no configuration in
   * which the right answer is "yes, chat to the bots", so offering a switch
   * would only offer a way to break it.
   *
   * BOTS ARE IDENTIFIED BY TELEGRAM'S OWN FLAG. The user record in the `users`
   * store — the one this file already opens to read our username — carries
   * `pFlags.bot` on a bot and nothing of the sort on a person. Measured on the
   * live store:
   *
   *   example_bot          pFlags {bot: true, ...}        bot_info_version: 6
   *   a_person             pFlags {apply_min_photo, ...}  bot_info_version: undefined
   *   our_tg_account (us)  pFlags {apply_min_photo, ...}  bot_info_version: undefined
   *
   * This used to be a guess at the USERNAME instead — "a bot's username must
   * end in bot" — which is Telegram's registration rule and does hold, but is
   * only readable once the chat is OPEN. That is the whole problem: the sweep
   * had to navigate into every bot conversation before it could refuse it, and
   * a chat that is open is a chat something else can type into. A bot chat
   * collected a draft that way.
   *
   * The flag is keyed by peer id, and a chat row carries its peer id, so the
   * question can now be asked one step earlier — before the bot is ever opened.
   * `bot_info_version` is checked too: same record, second marker, free.
   */
  const BOT_HANDLE = /bot$/i;

  /**
   * Is this peer a bot? Answered from Telegram's own user record.
   *
   * Unknown peers answer FALSE, not "maybe": the record is missing for someone
   * we have never exchanged a message with, and refusing every stranger would
   * empty the queue the sweep exists to work. A bot we have a conversation with
   * — which is the only kind that reaches this — is always in the store.
   *
   * ONE READ FOR THE WHOLE LIST, not one per row. Opening the database per peer
   * looked harmless on a warm cache — measured at 0ms — and is not what it costs
   * COLD: `openDb` waits up to 2.5s per slot when Telegram is holding the
   * database through a version change, which it does constantly while booting,
   * and the sidebar is listed immediately after a reload. The first sweep cycle
   * after a reload spent its whole budget in here and processed no threads at
   * all. Every id is read once, in one pass, and the rest of the record is
   * dropped on the spot so a large contact list costs no memory.
   *
   * AND IT MUST NEVER HOLD THE LIST UP. Right after a tab reload Telegram is
   * still opening its own database, so every `openDb` here waits out its full
   * timeout — measured: `ft:list-threads` went from 2ms warm to over 40 SECONDS
   * cold, and the sweep's first Telegram cycle processed nothing at all.
   *
   * So the load is bounded, and a load that does not finish in time simply
   * means NO FILTERING THIS PASS: the rows go back unfiltered and the index is
   * retried later. That is safe because the list filter was never the only
   * guard — `readThread` refuses a bot too, which is exactly where the refusal
   * lived before. Worst case after a reload we open one bot chat once, the same
   * as the old behaviour; every pass after that is warm and filters properly.
   */
  const BOT_INDEX_TTL_MS = 60_000;
  const BOT_INDEX_LOAD_MS = 3000;
  const BOT_INDEX_RETRY_MS = 15_000;
  let botIndex = null;
  let botIndexAt = 0;
  let botIndexTriedAt = 0;

  async function loadBotIndex() {
    const index = new Map();
    for (const name of ACCOUNT_DBS) {
      const db = await openDb(name);
      if (!db) continue;
      if (!db.objectStoreNames.contains("users")) {
        db.close();
        continue;
      }
      const all = await withDeadline(
        new Promise((resolve) => {
          try {
            const rq = db.transaction("users", "readonly").objectStore("users").getAll();
            rq.onsuccess = () => resolve(rq.result ?? []);
            rq.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        }),
        IDB_READ_TIMEOUT_MS,
        [],
      );
      db.close();
      for (const u of all) {
        if (u?.id === undefined) continue;
        index.set(String(u.id), u?.pFlags?.bot === true || u?.bot_info_version !== undefined);
      }
    }
    return index;
  }

  async function isBotPeer(peerId) {
    const id = String(peerId ?? "");
    if (!id || !/^\d+$/.test(id)) return false;

    const stale = !botIndex || Date.now() - botIndexAt > BOT_INDEX_TTL_MS;
    // The retry gate is per ATTEMPT, not per row: without it a sidebar of
    // twenty rows would each pay the full deadline on a cold database.
    if (stale && Date.now() - botIndexTriedAt > BOT_INDEX_RETRY_MS) {
      botIndexTriedAt = Date.now();
      const loaded = await withDeadline(loadBotIndex(), BOT_INDEX_LOAD_MS, null);
      if (loaded) {
        botIndex = loaded;
        botIndexAt = Date.now();
      }
    }
    return botIndex?.get(id) ?? false;
  }

  /**
   * Telegram's own service account — login codes and security notices, from a
   * peer id that is the same for every account on the platform.
   */
  const SERVICE_PEERS = new Set(["777000"]);

  /**
   * Our own @username — the same kind of name a lead is keyed by.
   *
   * `localStorage.user_auth` gives our numeric id and nothing else, which is why
   * this used to send `own_username: "id1234567890"`. Stable, but not a handle:
   * it is what FluidTalk records against every conversation, and nobody reading
   * it later can tell which account that was.
   *
   * The username lives in Telegram's own IndexedDB — `tweb-account-<n>`, store
   * `users`, keyed by the id AS A STRING. Which account slot is not knowable up
   * front (Telegram Web holds several at once, see `number_of_accounts`), so
   * every slot is searched and the record must both match our id and carry
   * `pFlags.self` — two conditions, because one of them alone would happily
   * match another account's copy of us.
   *
   * Falls back to `id<n>` when the account genuinely has no username. That is a
   * real Telegram state, not a failure, and an id is better than nothing —
   * `own_username` only has to identify WHICH of our accounts received the DM.
   */
  let ownCache = null;

  /**
   * Open one of Telegram's databases, or give up quickly.
   *
   * `indexedDB.open` has a THIRD outcome besides success and error: `blocked`,
   * when another connection is holding the database through a version change —
   * and Telegram is that other connection, constantly. A promise that only
   * settles on success or error simply never settles there, and because
   * `whoami` reads the username from this store, the hang travels all the way
   * up: the adapter stops answering, every worker call behind it stops, and a
   * run freezes with no error anywhere. That is what happened here.
   *
   * So: handle `blocked`, and put a deadline on the whole thing. Failing to
   * read our own username costs a fallback to the numeric id; hanging costs the
   * run.
   */
  const DB_OPEN_TIMEOUT_MS = 2500;

  function openDb(name) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (db) => {
        if (settled) return;
        settled = true;
        resolve(db);
      };
      let rq;
      try {
        rq = indexedDB.open(name);
      } catch {
        return done(null);
      }
      rq.onsuccess = () => done(rq.result);
      rq.onerror = () => done(null);
      rq.onblocked = () => done(null);
      setTimeout(() => {
        // Close it if it turns up late, so we do not leak a connection that
        // would then block TELEGRAM's own upgrade.
        rq.onsuccess = () => rq.result?.close();
        done(null);
      }, DB_OPEN_TIMEOUT_MS);
    });
  }

  /**
   * Never let an IndexedDB read outlive its usefulness.
   *
   * `openDb` already has a deadline; the READS did not, and that was the hole.
   * A request whose transaction stalls simply never fires `onsuccess` or
   * `onerror` — no throw, no rejection — so the promise never settles and
   * everything awaiting it stops. Measured: a sweep sat on Telegram for over
   * five minutes with the adapter otherwise perfectly responsive (`ft:where`,
   * `ft:whoami`, `ft:list-threads` and `ft:read` all answered in under a
   * second) because `ft:open-thread` was waiting on a cursor that never
   * completed. The whole run stops behind it, and nothing in the log says so.
   *
   * The fallback is always "we could not find out", which every caller here
   * already handles: a missing peer id refuses the chat, which is the right
   * way to fail.
   */
  const IDB_READ_TIMEOUT_MS = 4000;

  function withDeadline(promise, ms, fallback) {
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  }

  function idbGet(db, store, key) {
    return withDeadline(
      new Promise((resolve) => {
        try {
          const rq = db.transaction(store, "readonly").objectStore(store).get(key);
          rq.onsuccess = () => resolve(rq.result ?? null);
          rq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
      IDB_READ_TIMEOUT_MS,
      null,
    );
  }

  async function lookupOwnUsername(id) {
    for (const name of ACCOUNT_DBS) {
      const db = await openDb(name);
      if (!db) continue;
      const rec = db.objectStoreNames.contains("users") ? await idbGet(db, "users", String(id)) : null;
      db.close();
      if (rec?.pFlags?.self && String(rec.id) === String(id) && rec.username) return rec.username;
    }
    return null;
  }

  async function readOwnHandle() {
    let id = null;
    try {
      id = JSON.parse(localStorage.getItem("user_auth") ?? "null")?.id ?? null;
    } catch {
      id = null;
    }
    if (!id) return null;
    if (ownCache?.userId === String(id)) return ownCache;

    const username = await lookupOwnUsername(id);
    ownCache = { handle: username ?? `id${id}`, userId: String(id), username: username ?? null };
    return ownCache;
  }

  // ── reading a conversation ─────────────────────────────────────────────────

  /**
   * A bubble's text, with Telegram's own furniture removed and its emoji put
   * back.
   *
   * Two things `textContent` gets wrong here, both measured on live messages:
   *
   *  - The timestamp is a CHILD of the message element, so it yields
   *    "Hey hey14:26" — the time glued to the last word. It reads like part of
   *    the sentence and would reach the character as something the lead typed.
   *  - **Every emoji is an `<img class="emoji" alt="👋">`, not a character.**
   *    `textContent` drops them silently, which is worse than it sounds: an
   *    emoji-only message reads as EMPTY and is dropped as scaffolding, so a
   *    lead who answered with a single 👍 looks like they said nothing at all;
   *    and inside a sentence the meaning quietly changes — "i'm a 💙 but…"
   *    arrives as "i'm a but…". The `alt` is the real character, so it is
   *    substituted before the text is read.
   */
  function bubbleText(bubble) {
    const el = bubble.querySelector(".message");
    if (!el) return "";
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".time, .bubble-time, .message-time, .reply-markup").forEach((n) => n.remove());
    for (const img of copy.querySelectorAll("img[alt], .custom-emoji[alt]")) {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") ?? ""));
    }
    return norm(copy.textContent);
  }

  /**
   * The messages on screen, oldest first.
   *
   * `is-out` is Telegram's own word for "we sent this", so direction needs no
   * measuring. Bubbles with no `data-mid` are the client's own scaffolding
   * (date separators, the sponsored slot, unmounted placeholders) and are
   * dropped — they have no text and would read as empty messages.
   */
  /**
   * What KIND of message a bubble is — read from the bubble's own class list.
   *
   * Telegram names the media on the bubble (`bubble … photo`, `… video`,
   * `… sticker`), and that is the only place it is unambiguous. Looking for
   * media ELEMENTS instead is a trap that measures nothing: `img.media-sticker`
   * appears four to six times inside almost every bubble, because that is also
   * how emoji REACTIONS are drawn — so "this bubble contains a sticker image"
   * is true of ordinary text messages. Measured on a live channel: 14 photo, 4
   * video, 3 text, and every one of the 21 carried sticker images.
   */
  const MEDIA_KINDS = [
    "photo", "video", "sticker", "round", "voice", "audio", "document", "poll", "contact", "location", "game",
  ];

  function bubbleKind(b) {
    return MEDIA_KINDS.find((k) => b.classList.contains(k)) ?? "text";
  }

  /**
   * What kind of message a media element belongs to, so a failure can name it.
   * "the sticker never produced a frame" about a video note is a wrong answer
   * to the only question the log line is asked.
   */
  function bubbleKindOf(el) {
    const b = el?.closest?.(".bubble");
    return b ? bubbleKind(b) : null;
  }

  /**
   * The picture in a bubble, if there is one we can actually show the character.
   *
   * Scoped to the media element for the kind, never "the first image": the
   * avatar and the reaction stickers are images too, and answering a photo with
   * a description of somebody's avatar is the kind of wrong that reads as
   * plausible.
   *
   * The src is a `blob:` URL — same-origin to the page and NOT fetchable from
   * the worker, which is why the bytes are read here (`ft:media-bytes`) instead
   * of being downloaded up there like Instagram's CDN links.
   */
  function bubbleImage(b, kind) {
    // An `<img>` and nothing else. Two neighbours in the same bubble look like
    // the picture and are not, and both were measured feeding rubbish forward:
    //
    //  - `video.media-video`'s src is a STREAM endpoint
    //    (`/k/stream/{…}`), and fetching it returns `text/html`, 1587 bytes —
    //    an error page. Uploaded as the lead's photo, the character would be
    //    answering an HTML document. A video's still is its poster `<img>`,
    //    which is already covered by the selector below.
    //  - `canvas.canvas-thumbnail.thumbnail.media-photo` is Telegram's BLURRED
    //    placeholder, drawn until the real photo downloads. It reads as a
    //    successful image and would show the model a smudge — the worst shape
    //    of failure, because the reply comes back perfectly plausible.
    // THE VIDEO WINS WHERE THERE IS ONE. The model reads video now and reads it
    // better than any still — a sticker that a frame rendered as "a cartoon
    // robot head" came back from the video as "gives a thumbs up and winks".
    // A video bubble also carries a poster `<img class="media-photo">`, which
    // used to be what we sent; it is now only the fallback, taken inside
    // `mediaBytes` as a frame when the file itself cannot be had.
    //
    // A STICKER is either shape: static ones are `<img class="media-sticker">`,
    // animated ones (`bubble … sticker-animated`) a `<video>` playing a webm.
    //
    // ASKED FOR SEPARATELY, because `querySelector("video…, img…")` returns the
    // first match in DOCUMENT ORDER — not the first selector that matches. The
    // poster `<img>` is written BEFORE the `<video>` in a video bubble, so the
    // one call could never return the video however long it waited, and every
    // video was silently downgraded to its still. `waitForBubbleImage`'s
    // `requireVideo` then span for its full 8s on a condition that could not
    // come true. Measured on a live bubble: docOrder [IMG, VIDEO].
    const pick = (...sels) => sels.reduce((found, s) => found ?? b.querySelector(s), null);
    const el =
      kind === "sticker"
        ? pick("video.media-sticker", "img.media-sticker")
        : pick("video.media-video", "img.media-photo");
    if (!el) return null;
    const src = el.currentSrc || el.src || "";
    return src ? { src, alt: el.getAttribute("alt") || null, isVideo: el.tagName === "VIDEO" } : null;
  }

  /**
   * Wait for a message's picture to actually load before reading it.
   *
   * Telegram renders media lazily: the bubble exists, and for a while the only
   * thing in it is that blurred canvas. A read taken in that window reports
   * "media we cannot see" about a photo that arrives a second later — the
   * conversation then gets an "I can't open that" answer to a picture that was
   * perfectly fine.
   *
   * Scrolling it into view is what makes Telegram fetch it at all.
   */
  async function waitForBubbleImage(mid, kind, ms = 6000, requireVideo = false) {
    const find = () => [...document.querySelectorAll(".bubble")].find((b) => b.dataset?.mid === String(mid));
    const first = find();
    if (!first) return null;
    first.scrollIntoView({ block: "center" });
    let best = null;
    for (let waited = 0; waited < ms; waited += 300) {
      const b = find();
      if (!b) return best;
      const found = bubbleImage(b, kind);
      if (found) {
        best = found;
        // Keep waiting for the video when a poster is all we have — but hand
        // the poster back if it never mounts, because a still beats nothing.
        if (!requireVideo || found.isVideo) return found;
      }
      await sleep(300);
    }
    return best;
  }

  function readMessages(limit = MAX_HISTORY) {
    const out = [];
    for (const b of document.querySelectorAll(".bubble")) {
      const mid = b.dataset?.mid;
      if (!mid || mid === "0") continue;
      const text = bubbleText(b);
      const kind = bubbleKind(b);
      const image = kind === "text" ? null : bubbleImage(b, kind);
      if (!text && kind === "text") continue;
      out.push({
        id: mid,
        side: b.classList.contains("is-out") ? "out" : "in",
        text,
        kind,
        // The worker's contract is `imageUrl`, the same field Instagram fills —
        // it just happens to be a blob here, which is what makes it OUR job to
        // read the bytes rather than the worker's.
        ...(image ? { imageUrl: image.src, imageAlt: image.alt, isVideo: Boolean(image.isVideo) } : {}),
        // Nothing to read and nothing to look at. The character is told an
        // event happened rather than being handed an empty message, which is
        // the same treatment Instagram gives media the web will not render.
        // A CAPTION IS THE LEAD TALKING. `unreadable` replaces their words with
        // "sent an attachment" downstream, so a document or a video with a
        // caption used to have a real sentence thrown away and be answered as a
        // silent attachment. Unreadable means nothing to read AND nothing to
        // show — not merely nothing to show.
        unreadable: kind !== "text" && !image && !text,
        at: b.dataset?.timestamp ? Number(b.dataset.timestamp) * 1000 : null,
      });
    }
    out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || Number(a.id) - Number(b.id));
    return out.slice(-limit);
  }

  /**
   * The bytes behind a `blob:` URL, as base64.
   *
   * A blob URL is registered in THIS page and resolvable nowhere else, so the
   * worker cannot download it the way it downloads an Instagram CDN link. The
   * page reads it and hands the bytes over. Measured on a live photo: fetching
   * the blob returns image/jpeg, ~63 KB.
   */
  /**
   * Reading a video out of the page — frame capture and re-encoding — lives in
   * `media.js`, because Instagram needs exactly the same three steps and for a
   * harder reason: its DM video is a MediaSource blob with no fetchable file at
   * all. See that file for the measurements behind every constant in it.
   */
  const { toB64, captureVideoFrame, shrinkVideo } = window.__ftMedia;

  async function mediaBytes(url) {
    if (!url) return { ok: false, reason: "no url" };

    // An ANIMATED STICKER is a looping webm. SEND IT WHOLE — the model reads
    // video now, and reads it better than any still: the same file that used to
    // come back `vision_failed` was described as "a bald man with a beard,
    // smiling in a shower, gives a thumbs up and winks". A thumbs up and a wink
    // are motion; a frame cannot carry them.
    //
    // THREE STEPS DOWN, and only the last one loses the motion. The whole file
    // is best. Failing that a re-encode keeps it a VIDEO — which matters far
    // more than it sounds, because the 10 MB ceiling is reached at about twelve
    // seconds, so "too large" is the ordinary case for a real video. Only when
    // that fails too does a still frame beat telling her an attachment arrived.
    const video = [...document.querySelectorAll("video")].find((v) => (v.currentSrc || v.src) === url);
    if (video) {
      const raw = await rawBytes(url);
      if (raw.ok && raw.bytes <= MAX_MEDIA_BYTES) return { ...raw, fromVideo: true };
      const why = raw.ok ? `too large (${raw.bytes} bytes)` : raw.reason;

      const small = await shrinkVideo(video, MAX_MEDIA_BYTES);
      if (small.ok) {
        // `raw.bytes` is present on the too-large REFUSAL as well as on success
        // — that is the number worth reporting, since it is what we shrank from.
        return { ...small, shrunkBecause: why, shrunk: { ...small.shrunk, from: raw.bytes ?? null } };
      }

      const frame = await captureVideoFrame(video, bubbleKindOf(video) ?? "video");
      return frame.ok
        ? { ...frame, fellBackBecause: `${why}; ${small.reason}` }
        : { ...frame, reason: `${frame.reason} (after: ${why}; ${small.reason})` };
    }

    const raw = await rawBytes(url);
    if (!raw.ok) return raw;
    if (raw.bytes > MAX_MEDIA_BYTES) return { ok: false, reason: `too large (${raw.bytes} bytes)` };
    return raw;
  }

  /** /inbound-media refuses anything larger. */
  const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  /**
   * Ask the page for a `/k/stream/` file, as a blob url we can actually read.
   *
   * A content script's fetch is NOT intercepted by Telegram's service worker,
   * and that worker is the only thing that can serve a stream URL — so from
   * here the same URL answers `text/html`, 1587 bytes, the SPA shell. The read
   * happens in `telegram-mainworld.js`; see that file for the measurement.
   *
   * A blob url crosses back because it is keyed by ORIGIN, not by world.
   */
  const STREAM_TIMEOUT_MS = 30000;
  let streamSeq = 0;

  function streamBlobViaPage(url) {
    return new Promise((resolve) => {
      const id = `s${(streamSeq += 1)}`;
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(v);
      };
      const onMessage = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (d?.source !== "fluidextension-page" || d.kind !== "stream-bytes-result" || d.id !== id) return;
        done(d);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "fluidextension", kind: "stream-bytes", id, url }, "*");
      // A page script that never answers — not injected, threw on load — must
      // not hold the whole read open: a still beats a conversation that stalls.
      setTimeout(() => done({ ok: false, reason: "the page did not answer for the video bytes" }), STREAM_TIMEOUT_MS);
    });
  }

  /**
   * The bytes behind a url, with the one guard that matters.
   *
   * IMAGE OR VIDEO, nothing else. Without this check an error page would be
   * uploaded and handed to the model AS THE LEAD'S MEDIA. The reply comes back
   * reading perfectly normally, which is exactly why it is worth failing on
   * rather than hoping.
   */
  async function rawBytes(url) {
    try {
      // Streamed video: read it in the page, then carry on with the blob url it
      // hands back. Chunking lives there because every chunk needs the same
      // interception — Telegram answers 206 with 512 KB however much is asked
      // for, so one fetch yields a truncated file that would upload happily.
      if (String(url).includes("/k/stream/")) {
        const got = await streamBlobViaPage(url);
        if (!got.ok) return got;
        return rawBytes(got.blobUrl);
      }

      const res = await fetch(url);
      const blob = await res.blob();
      const type = blob.type || res.headers.get("content-type") || "";
      if (!/^(image|video)\//.test(type)) {
        return { ok: false, reason: `not image or video (${type || "no type"}, ${blob.size} bytes)` };
      }
      if (blob.size > MAX_MEDIA_BYTES) return { ok: false, reason: `too large (${blob.size} bytes)`, bytes: blob.size };
      return toB64(blob, type);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }


  /**
   * The message we owe a reply to — or null, when we owe none.
   *
   * ONLY THE NEWEST MESSAGE COUNTS. This used to scan backwards past our own
   * messages until it found any inbound one, which means a conversation we
   * answered hours ago still reported a message to answer. The only thing
   * standing between that and a second reply was the worker's `alreadyReplied`
   * map — and that lives in `chrome.storage.session`, which an extension
   * reload wipes. Reload, sweep, and every up-to-date thread gets answered
   * again.
   *
   * It happened here too: `our_tg_account` said "Hey how are you" at 09:09, was
   * answered at 09:15, and was answered a second time at 09:47 — the character
   * opening with "hey! i just answered you lol". Nobody had written.
   *
   * Read from the CONVERSATION, not from storage, so it cannot be forgotten.
   * If the last message is ours we are up to date, full stop. Matches what the
   * Instagram adapter has always done.
   */
  function lastInbound(messages) {
    const last = messages[messages.length - 1];
    return last && last.side === "in" ? last : null;
  }

  /**
   * The open conversation, in the shape the worker expects from every adapter.
   *
   * Refuses a chat with no username for the reason given on `chatRef`, and
   * refuses a group outright: `peerId` is negative for groups and channels, and
   * a character answering into a group would be talking to everyone in it.
   */
  async function readThread() {
    const ref = chatRef();
    if (!ref) return { ok: false, reason: "not_on_thread" };
    if (ref.peerId && Number(ref.peerId) < 0) return { ok: false, reason: "group_or_channel" };
    if (ref.peerId && SERVICE_PEERS.has(ref.peerId)) return { ok: false, reason: "telegram_service_account" };
    if (!ref.handle) return { ok: false, reason: "no_username_on_this_chat" };
    // A NEGATIVE peer id is not enough to catch a channel: a PUBLIC one opens
    // as `#@name` exactly like a person, so the id test never runs. Measured —
    // opening a channel by its peer id put `#@a_channel` in the hash and the
    // whole thread read as a lead. Telegram keeps people in `users` and channels
    // in `chats`, so "does this handle belong to a user" is the real question,
    // and it is the one asked here. Replying into a channel would broadcast to
    // everybody subscribed to it.
    if (!(await peerIdForHandle(ref.handle))) return { ok: false, reason: "not_a_user_chat" };
    // Refused HERE too, not only in `listThreads`: a follow-up arrives as a
    // remembered handle and never goes near the sidebar, so the list filter
    // cannot see it. This is the last point at which a bot conversation is
    // still just a page we looked at — everything past it, the generation and
    // the send, costs something real.
    //
    // Both tests, and they catch different things. The flag is Telegram's own
    // and needs the peer to be in the store; the username rule is a guess that
    // holds for any bot at all, including one we have no record of yet.
    if (BOT_HANDLE.test(ref.handle)) return { ok: false, reason: "bot_account" };
    if (await isBotPeer(await peerIdForHandle(ref.handle))) return { ok: false, reason: "bot_account" };

    const messages = readMessages();
    if (!messages.length) return { ok: false, reason: "no_messages" };

    // The message we are about to answer is the one that has to be read
    // properly, so it gets the wait. Everything above it is history and can
    // stay as-is — spending six seconds per old photo would make a read of a
    // long thread take minutes.
    let last = lastInbound(messages);
    // Two reasons to wait on the message we are about to answer. Nothing at all
    // yet — Telegram draws a blurred canvas until the photo downloads. Or only
    // the POSTER of a video: the `<video>` element mounts when the bubble comes
    // into view, so a video message read from a distance offers a still and
    // hides the thing the model can now actually watch.
    // THE MEDIA TO WAIT FOR IS NOT ALWAYS THE LAST MESSAGE. People send the
    // picture and then talk about it — sticker, then "you know this guy?" — and
    // the worker answers the newest picture in the UNANSWERED RUN, not the last
    // message. Waiting only on `last` meant that in exactly that shape nothing
    // was ever scrolled to or waited for: the media kept whatever `readMessages`
    // happened to scrape in passing, and if the bubble was off-screen that was
    // NOTHING — a fluent reply to a picture nobody saw, with an empty log.
    const run = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].side === "in"; i -= 1) run.unshift(messages[i]);
    const target = [...run].reverse().find((m) => m.kind !== "text") ?? last;

    const wantsVideo = ["video", "round", "sticker"].includes(target?.kind ?? "");
    if (target && target.kind !== "text" && (!target.imageUrl || (wantsVideo && !target.isVideo))) {
      const found = await waitForBubbleImage(target.id, target.kind, wantsVideo ? 8000 : 6000, wantsVideo);
      if (found) {
        Object.assign(target, {
          imageUrl: found.src,
          imageAlt: found.alt,
          isVideo: Boolean(found.isVideo),
          unreadable: false,
          // A video that never mounted its `<video>` leaves only the poster.
          // Downstream has no other way to tell that apart from a real photo,
          // and "saw the photo" about a video message is a quiet lie.
          posterOnly: wantsVideo && !found.isVideo,
        });
      }
    }
    return {
      ok: true,
      threadId: ref.ref,
      handle: ref.handle,
      own: (await readOwnHandle())?.handle ?? null,
      messages,
      lastInbound: last,
      // No outgoing message ever = we have not spoken here, which is what the
      // hourly cap on NEW conversations counts.
      neverAnswered: !messages.some((m) => m.side === "out"),
      // A voice note, a document, a poll: something arrived, we cannot read it
      // and cannot show it. Saying so lets the character answer the EVENT
      // instead of being handed an empty message — the same treatment Instagram
      // gives media the web will not render.
      lastInboundUnreadable: Boolean(last?.unreadable),
      // THE REAL KIND, not the word "unsupported". Telegram names it on the
      // bubble and it was being thrown away one line before it was needed, so a
      // voice note, a document, a poll and a location were all described to the
      // character identically as "sent an attachment".
      unreadableKind: last?.unreadable ? (last.kind ?? "unsupported") : null,
    };
  }

  // ── the chat list ──────────────────────────────────────────────────────────

  function chatRows() {
    return [...document.querySelectorAll(".chatlist-chat")].filter((r) => r.dataset?.peerId);
  }

  /**
   * Which peer an @handle belongs to, from Telegram's own user store.
   *
   * Needed because a chat row exposes a peer id and a display name and nothing
   * else — the username exists only once the chat is open, in the URL. Follow-ups
   * arrive holding a handle, so without this they could reach nobody.
   *
   * Cached per handle: the store is small but this is called inside a loop over
   * the follow-up queue.
   */
  const peerCache = new Map();

  async function peerIdForHandle(handle) {
    const want = String(handle).replace(/^@/, "").toLowerCase();
    if (!want) return null;
    if (peerCache.has(want)) return peerCache.get(want);

    for (const name of ACCOUNT_DBS) {
      const db = await openDb(name);
      if (!db) continue;
      if (!db.objectStoreNames.contains("users")) {
        db.close();
        continue;
      }
      // A CURSOR IS THE WORST OFFENDER: it settles only when it walks off the
      // end, so a stalled transaction leaves it mid-scan for ever. This is the
      // one that froze a live sweep on `ft:open-thread`.
      const found = await withDeadline(
        new Promise((resolve) => {
          try {
            const rq = db.transaction("users", "readonly").objectStore("users").openCursor();
            rq.onsuccess = () => {
              const cur = rq.result;
              if (!cur) return resolve(null);
              const u = cur.value;
              if (u?.username && String(u.username).toLowerCase() === want) return resolve(String(u.id));
              cur.continue();
            };
            rq.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        }),
        IDB_READ_TIMEOUT_MS,
        null,
      );
      db.close();
      if (found) {
        peerCache.set(want, found);
        return found;
      }
    }
    peerCache.set(want, null);
    return null;
  }

  /**
   * The conversations in the sidebar.
   *
   * `label` is what the worker opens a row BY, so it has to be something
   * `openThread` can find again — the peer id, not the display name. Instagram
   * forced text matching because its rows carry no id; Telegram does, and using
   * it removes the whole class of bug where a row is listed by one string and
   * matched by another.
   *
   * Groups and channels (negative peer id) are dropped here rather than later:
   * they are not conversations this product has any business answering.
   */
  async function listThreads() {
    // Wait for the list to exist before reporting on it. Telegram boots slowly
    // and an empty sidebar is indistinguishable from an empty account — a read
    // taken during the boot says "0 conversations", which the run treats as a
    // finished inbox rather than as a page that has not arrived yet.
    for (let i = 0; i < 30 && chatRows().length === 0; i += 1) await sleep(500);

    const own = (await readOwnHandle())?.userId ?? null;
    const rows = chatRows()
      .map((r) => ({
        label: r.dataset.peerId,
        peerId: r.dataset.peerId,
        title: norm(r.querySelector(".peer-title")?.textContent),
        unread: Number(norm(r.querySelector(".dialog-subtitle-badge, .badge")?.textContent)) || 0,
      }))
      // Groups and channels, ourselves, and Telegram's service account are
      // dropped before the sweep can open them.
      .filter((r) => Number(r.peerId) > 0 && r.peerId !== own && !SERVICE_PEERS.has(r.peerId));

    // BOTS TOO, and here rather than in `readThread`, which is the whole point:
    // dropped one step later the bot still gets OPENED first, and an open chat
    // is one that a concurrent send can type into. That is how a bot chat
    // ended up holding a draft written for somebody else.
    //
    // Sequential, not `Promise.all`: each miss opens Telegram's database, and
    // four slots times a sidebar full of rows all at once is what the deadline
    // in `idbGet` exists to survive, not something to go looking for. The cache
    // makes every later pass free.
    const people = [];
    for (const r of rows) {
      if (await isBotPeer(r.peerId)) continue;
      people.push(r);
    }
    return people;
  }

  /**
   * Open a chat, and prove it opened.
   *
   * `.click()` and assigning `location.hash` were both measured doing NOTHING
   * — no error, no navigation — so a run built on either would report every
   * conversation as opened while sitting on the same screen, which is the
   * failure that messages the wrong person. Only a full pointer sequence lands.
   *
   * The check is the URL: Telegram writes the open chat into the hash, so
   * "did it change" is a real answer rather than an inspection of the thing we
   * just clicked.
   */
  async function openThread(label) {
    const before = location.hash;
    // A label may be a peer id (what `listThreads` hands out) or an @handle —
    // the follow-up pass remembers a thread BY ITS ID, and on Telegram a
    // thread's id IS `@username`. Without this that pass could only ever reach
    // people it had just listed, which is not what a follow-up is.
    const want = String(label ?? "").replace(/^#/, "");
    const byHandle = want.startsWith("@") ? want.slice(1) : null;
    // A chat row carries a peer id and a DISPLAY NAME — never the username — so
    // a handle has to be resolved through Telegram's own user store before a row
    // can be picked. Matching the display name instead is the mistake that made
    // Instagram's follow-ups miss everyone whose name is not their handle.
    const peerId = byHandle ? await peerIdForHandle(byHandle) : want;

    // Already there. The proof this function relies on is that the hash
    // CHANGES, so opening the chat you are standing in looks exactly like a
    // click that failed — and the caller treats that as "could not open" and
    // skips somebody it is already looking at.
    const here = chatRef();
    const already = byHandle
      ? here?.handle?.toLowerCase() === byHandle.toLowerCase()
      : Boolean(peerId) && (here?.peerId === String(peerId) || (await peerIdForHandle(here?.handle ?? "")) === String(peerId));
    if (already) return { clicked: true, before, hash: location.hash, alreadyOpen: true };

    const row = peerId ? chatRows().find((r) => r.dataset.peerId === String(peerId)) : null;
    if (!row) return { clicked: false, before, reason: byHandle ? "no open chat for that handle" : "no such row" };

    const box = row.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
      button: 0,
    };
    const target = row.querySelector(".peer-title") ?? row;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, opts));
    }

    for (let i = 0; i < 30; i += 1) {
      await sleep(200);
      if (location.hash && location.hash !== before) return { clicked: true, before, hash: location.hash };
    }
    return { clicked: false, before, reason: "the chat did not open" };
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /**
   * The CHAT's composer — never a dialog's.
   *
   * The "Send Photo" dialog carries its own `.input-message-input` for the
   * caption, so while it is open a bare selector returns two and the first may
   * be either. Typing a reply into the dialog's field would attach it to the
   * photo as a caption, or leave it behind when the dialog closes.
   */
  function composer() {
    return [...document.querySelectorAll(".input-message-input[contenteditable=true]")].find(
      (el) => !el.closest('[class*="popup"]'),
    ) ?? null;
  }

  /**
   * Type into the composer the way a keystroke does.
   *
   * The same rule as Instagram's Lexical editor and for the same reason:
   * Telegram keeps its own model of the draft, so assigning `textContent`
   * changes what is on screen and leaves the model empty — the send button
   * never arms and Enter sends nothing, silently. `insertText` emits the
   * `beforeinput`/`input` pair the editor commits on.
   */
  function typeIntoComposer(text) {
    const box = composer();
    if (!box) return false;
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, text);
    return norm(box.textContent).includes(norm(text).slice(0, 20));
  }

  /**
   * The send control — only once there is something to send.
   *
   * The same button is the voice-recorder when the composer is empty (it wears
   * a `record` class then), exactly like Instagram collapsing its three media
   * controls into Send. Pressing it with an empty box starts recording audio,
   * so emptiness is checked first rather than discovered afterwards.
   */
  function sendButton() {
    const btn = document.querySelector(".btn-send");
    if (!btn) return null;
    if (btn.classList.contains("record")) return null;
    return btn;
  }

  /**
   * Send one message and confirm it against the conversation.
   *
   * Confirmed by the text appearing as an OUTGOING bubble, never by the click
   * returning — a click Telegram ignored looks exactly like one it accepted.
   */
  async function sendBubble(text, expectThreadId = null) {
    const ref = chatRef();
    if (!ref) return { ok: false, reason: "not on a chat" };
    // ⚠ THE CHAT MUST STILL BE THE ONE THIS REPLY WAS WRITTEN FOR.
    //
    // A reply is composed for a thread and sent seconds later, and in between
    // anything may have navigated this tab — the sweep moving to the next
    // conversation, the auto-reply watcher answering a different one. Nothing
    // used to check, so the text simply went wherever the tab happened to be.
    // Measured live: a CROSSOVER line written for an established lead was
    // delivered to Simon, a brand-new one, and left as a draft in two other
    // chats on the way past.
    //
    // The caller names the thread; if it is not the one on screen we refuse.
    // A missed reply is recoverable. A message to the wrong person is not.
    if (expectThreadId && ref.ref !== expectThreadId) {
      return {
        ok: false,
        reason: `the open conversation changed (wanted ${expectThreadId}, on ${ref.ref ?? "nothing"}) — not sending`,
      };
    }
    if (!text) return { ok: false, reason: "refusing to send an empty message" };
    if (!composer()) return { ok: false, reason: "no composer on this screen" };

    const before = new Set(readMessages().map((m) => m.id));
    if (!typeIntoComposer(text)) return { ok: false, reason: "the composer did not take the text" };

    let btn = null;
    for (let i = 0; i < 25 && !btn; i += 1) {
      await sleep(200);
      btn = sendButton();
    }
    if (!btn) return { ok: false, reason: "the send control never armed" };
    btn.click();

    const needle = norm(text).slice(0, 30);
    for (let i = 0; i < 60; i += 1) {
      await sleep(300);
      const landed = readMessages().find((m) => m.side === "out" && !before.has(m.id) && m.text.includes(needle));
      if (landed) return { ok: true, id: landed.id, text: landed.text };
    }
    return { ok: false, reason: "the message is not visible as an outgoing bubble after sending" };
  }

  /**
   * Send a photo, by handing the bytes to Telegram's own hidden file input.
   *
   * The attach button opens a NATIVE file dialog no script can drive, so the
   * input is addressed directly — the same move the Instagram adapter makes, and
   * for the same reason: it is the one path that skips the dialog entirely.
   *
   * Telegram then shows a CONFIRM step (a preview with its own send button)
   * rather than sending immediately, which is the real difference from
   * Instagram. So this waits for that button and presses it, and confirms the
   * result against the conversation like every other send here.
   */
  async function sendPhoto({ dataB64, filename, mime, caption }) {
    if (!chatRef()) return { ok: false, reason: "not on a chat" };
    if (!composer()) return { ok: false, reason: "no composer on this screen" };

    const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
    const file = new File([bytes], filename || "photo.jpg", { type: mime || "image/jpeg" });
    const before = new Set(readMessages().map((m) => m.id));

    // PASTED, not handed to the file input. There IS a hidden
    // `input[type=file]` beside the composer — the same shape Instagram uses,
    // where assigning `.files` and firing `change` is exactly what works — and
    // measured here it does NOTHING: no popup, no error, the body does not even
    // change. Telegram listens for a PASTE instead, and that opens the same
    // "Send Photo" dialog a human gets.
    const dt = new DataTransfer();
    dt.items.add(file);
    const box = composer();
    box.focus();
    box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));

    // Telegram does not send on paste — it opens a CONFIRM dialog with its own
    // caption field and its own send button. That is the real difference from
    // Instagram, where the photo goes the moment the input takes it.
    let popup = null;
    for (let i = 0; i < 40 && !popup; i += 1) {
      await sleep(250);
      popup = document.querySelector(".popup-send-photo.active, .popup-new-media.active, .popup-send-photo");
    }
    if (!popup) return { ok: false, reason: "the Send Photo dialog never appeared" };

    // The caption goes in the DIALOG's own input, not the chat's. Both carry
    // `.input-message-input`, so writing to the wrong one leaves the caption
    // sitting in the chat composer to be sent later as a stray message.
    if (caption) {
      const capBox = popup.querySelector(".input-message-input[contenteditable=true]");
      if (capBox) {
        capBox.focus();
        document.execCommand("insertText", false, caption);
      }
    }

    const confirm = popup.querySelector(".simple-message-input-confirm, .btn-primary");
    if (!confirm) return { ok: false, reason: "the dialog has no send control" };
    confirm.click();

    for (let i = 0; i < 60; i += 1) {
      await sleep(300);
      const landed = readMessages().find((m) => m.side === "out" && !before.has(m.id) && m.kind !== "text");
      if (landed) return { ok: true, id: landed.id, kind: landed.kind };
    }
    return { ok: false, reason: "the photo is not visible as an outgoing message after sending" };
  }

  // ── diagnostics ────────────────────────────────────────────────────────────

  async function probe() {
    const msgs = readMessages();
    return {
      url: location.href,
      client: "k",
      chat: chatRef(),
      own: await readOwnHandle(),
      rows: chatRows().length,
      messagesParsed: msgs.length,
      incoming: msgs.filter((m) => m.side === "in").length,
      outgoing: msgs.filter((m) => m.side === "out").length,
      composerFound: Boolean(composer()),
      composerText: composer() ? norm(composer().textContent) : null,
      sendArmed: Boolean(sendButton()),
      // What KINDS are on screen, and whether each one yielded an image. When a
      // photo reaches the character as an empty message this is the line that
      // says whether the reader saw a photo at all or saw one and could not get
      // at the picture — two different faults that look identical from the log.
      kinds: msgs.reduce((acc, m) => {
        const key = `${m.kind}${m.imageUrl ? "+img" : m.unreadable ? "+unreadable" : ""}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      firstImage: msgs.find((m) => m.imageUrl)?.imageUrl ?? null,
      tail: msgs.slice(-4),
    };
  }

  // ── new-message watch ──────────────────────────────────────────────────────

  let watchTimer = null;
  let lastSeen = "";
  let lastList = null;

  /**
   * A cheap, SYNCHRONOUS snapshot of the chat list: `peerId -> unread count`.
   *
   * Deliberately not `listThreads()`, which is the correct answer and the wrong
   * tool here — that one waits up to fifteen seconds for the sidebar to boot and
   * opens Telegram's IndexedDB once per unknown peer to drop bots. This runs
   * inside a MutationObserver callback that fires on essentially every change to
   * the page, so it has to be a handful of DOM reads and nothing else.
   *
   * The only filters applied are the ones needing no IO: a negative id is a group
   * or a channel, and 777000 is Telegram's service account. Everything finer —
   * bots, ourselves — is re-applied by `ft:list-threads` when the worker actually
   * acts on this. A false positive here therefore costs one wasted look, never a
   * message to somebody who should not get one.
   */
  function listSnapshot() {
    const out = new Map();
    for (const r of chatRows()) {
      const id = r.dataset.peerId;
      if (!(Number(id) > 0) || SERVICE_PEERS.has(id)) continue;
      out.set(id, Number(norm(r.querySelector(".dialog-subtitle-badge, .badge")?.textContent)) || 0);
    }
    return out;
  }

  /**
   * Which rows are worth waking the worker for: ones that were not in the list
   * at all, and ones whose unread count went UP.
   *
   * A count going DOWN is us opening the chat, so it is not a change anybody
   * needs to act on — without that asymmetry the sweep would wake itself every
   * time it read a thread, forever.
   *
   * `lastList === null` is the first snapshot after injection. Every row looks
   * new then, and firing would ask the worker to open the whole inbox at page
   * load — which the first sweep cycle already does. So the first snapshot only
   * ever establishes the baseline.
   */
  function changedPeers(now) {
    if (lastList === null) return [];
    const out = [];
    for (const [id, unread] of now) {
      const before = lastList.get(id);
      if (before === undefined || unread > before) out.push(id);
    }
    return out;
  }

  function startWatch() {
    const observer = new MutationObserver(() => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
        /**
         * THE LIST FIRST, and independently of the open conversation.
         *
         * This is the half that notices somebody who is NOT on screen, and it is
         * why a brand-new thread used to be invisible until a sweep cycle came
         * round: the observer already fired on it, and then `readThread` below
         * looked at whatever chat happened to be open and threw the signal away.
         * It must therefore run before, and survive, every `return` below.
         */
        const now = listSnapshot();
        // An empty list is Telegram not having rendered yet (see `ft:ready` —
        // it renders NOTHING in a hidden tab). Taking that as the truth would
        // make every row look new the moment the sidebar finally arrives.
        if (now.size) {
          const changed = changedPeers(now);
          lastList = now;
          if (changed.length) {
            chrome.runtime.sendMessage({ type: "ft:list-changed", peers: changed }).catch(() => {});
          }
        }

        const thread = await readThread();
        if (!thread.ok) return;
        const key = `${thread.threadId}:${thread.messages.length}:${thread.lastInbound?.id ?? ""}`;
        if (key === lastSeen) return;
        lastSeen = key;
        chrome.runtime.sendMessage({ type: "ft:thread-changed", thread }).catch(() => {});
      }, 700);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ft:read":
            return respond({ ok: true, result: await readThread() });
          // Telegram renders NOTHING in a hidden tab — 21 divs, no chat list,
          // indefinitely. So "is the list there" is the readiness question,
          // and the honest answer lets the worker show the tab rather than
          // reporting an empty account.
          case "ft:ready":
            return respond({
              ok: true,
              result: chatRows().length
                ? { ready: true }
                : { ready: false, why: "the chat list has not rendered — Telegram only boots while its tab is on screen" },
            });
          case "ft:probe":
            return respond({ ok: true, result: await probe() });
          case "ft:list-threads":
            return respond({ ok: true, result: await listThreads() });
          case "ft:open-thread":
            return respond({ ok: true, result: await openThread(msg.label) });
          case "ft:whoami":
            return respond({ ok: true, result: await readOwnHandle() });
          case "ft:where":
            return respond({ ok: true, result: { threadId: chatRef()?.ref ?? null, url: location.href } });
          case "ft:type":
            return respond({ ok: true, result: { typed: typeIntoComposer(msg.text) } });
          case "ft:send-bubble":
            return respond({ ok: true, result: await sendBubble(msg.text, msg.expectThreadId ?? null) });
          case "ft:send-photo":
            return respond({ ok: true, result: await sendPhoto(msg) });
          case "ft:media-bytes":
            return respond({ ok: true, result: await mediaBytes(msg.url) });
          // Everything else the worker can send belongs to a capability
          // Telegram does not declare — a feed, followers, a requests folder,
          // public comments. Saying which is missing beats a generic refusal:
          // reaching here at all means a capability gate upstream is wrong.
          default:
            return respond({ ok: false, error: `Telegram has no ${msg?.type}` });
        }
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
    })();
    return true;
  });

  startWatch();
  console.debug("[FluidExtension] Telegram adapter ready");
})();
