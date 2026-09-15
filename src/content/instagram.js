/**
 * Instagram DM adapter — the only file that knows what Instagram's DOM looks
 * like. Everything above it works in terms of {handle, messages, bubbles}.
 *
 * Instagram ships obfuscated, per-build class names, so NOTHING here may match
 * on a class. The three signals that have survived redesigns are the ARIA roles
 * (`grid`/`row`/`textbox`), `contenteditable`, and the visual LAYOUT. Where a
 * heuristic is unavoidable it is stated as one, and `probe()` reports what it
 * actually matched so a break is diagnosable from the side panel instead of
 * from a stack trace.
 *
 * Scope: this file only ever READS the thread the user has open and writes into
 * that thread's composer. It cannot open a thread, search, or start a
 * conversation — replying to existing conversations is the whole product.
 */
(() => {
  "use strict";

  const MAX_HISTORY = 40;

  // ── where are we ───────────────────────────────────────────────────────────

  /**
   * The open thread's id, or null if this is not a thread page.
   *
   * Every read below refuses a null: on the inbox, a profile or the feed there
   * is no conversation on screen, and answering one the user is not looking at
   * is how you message the wrong person.
   */
  function threadId() {
    const m = location.pathname.match(/^\/direct\/t\/([^/]+)/);
    return m ? m[1] : null;
  }

  /**
   * The handle we are logged in as, read off the page.
   *
   * Asking the user to type it was a footgun: it has to match EXACTLY or the
   * lead-handle reader picks our own account as the lead, and a typo shows up
   * as bizarre replies rather than as an error.
   *
   * The nav is no use — the DM view collapses it and it carries no profile
   * link. Two signals that do work, measured on both the inbox and a thread:
   *  - the first `"username":"…"` in the page's embedded JSON is the VIEWER,
   *  - on the inbox (no thread open) the only profile link on the page is ours.
   * The first is used when the second confirms it, so a page whose JSON order
   * changes cannot silently hand back a lead's handle.
   */
  function readOwnHandle() {
    const hrefs = new Set();
    for (const a of document.querySelectorAll('a[href^="/"]')) {
      const m = a.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/$/);
      if (m && !ROUTES.has(m[1].toLowerCase())) hrefs.add(m[1]);
    }

    let fromJson = null;
    for (const s of document.querySelectorAll("script")) {
      const m = s.textContent.match(/"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/);
      if (m) {
        fromJson = m[1];
        break;
      }
    }

    if (fromJson && hrefs.has(fromJson)) return { handle: fromJson, via: "json+link" };
    if (hrefs.size === 1) return { handle: [...hrefs][0], via: "only-link" };
    if (fromJson) return { handle: fromJson, via: "json" };
    return { handle: null, via: "none" };
  }

  const ROUTES = new Set([
    "direct", "explore", "reels", "stories", "p", "accounts", "about",
    "legal", "privacy", "terms", "your_activity",
  ]);

  /**
   * The lead's handle.
   *
   * The thread URL carries only a numeric thread id, so the handle comes off
   * the page's profile links — but OUR OWN handle is one of them: the left nav
   * links to the logged-in account on every page. Taking "the first profile
   * link that is not a route" therefore resolves to US, and the character would
   * be handed its own account as the lead.
   *
   * Two things separate them. `ownHandle` (the configured username) is excluded
   * outright, and the remaining handles are ranked by how often they appear —
   * a thread links the other party from the header, the avatar and every
   * message group, so they win by a wide margin over any stray link.
   */
  function readHandle(ownHandle) {
    const own = (ownHandle ?? "").toLowerCase();
    const counts = new Map();

    for (const a of document.querySelectorAll('a[href^="/"]')) {
      const m = a.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
      if (!m) continue;
      const handle = m[1];
      if (ROUTES.has(handle.toLowerCase())) continue;
      if (own && handle.toLowerCase() === own) continue;
      counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }

    let best = null;
    for (const [handle, n] of counts) {
      if (!best || n > best.n) best = { handle, n };
    }
    return best?.handle ?? null;
  }

  // ── reading the conversation ───────────────────────────────────────────────

  const norm = (s) => (s ?? "").replace(/[\s ]+/g, " ").trim();

  /**
   * The conversation column — the horizontal band messages are laid out in.
   *
   * Measured 2026-09-07 against a real thread: there is NO `role="grid"` and no
   * `role="row"` anywhere in a DM. Message text sits in `span[dir="auto"]`
   * under `role="presentation"` / `role="none"` wrappers whose classes are
   * per-build noise, so there is nothing to select the list by.
   *
   * The composer is the anchor instead. It stretches the full width of the
   * conversation pane, so its box gives both edges and its top separates the
   * transcript from the input — and unlike the transcript, it is findable
   * (`contenteditable`).
   */
  /**
   * The span the message bubbles actually occupy.
   *
   * ⚠ MEASURED FROM THE MESSAGES, NOT FROM THE COMPOSER. The composer only
   * approximates the column at a comfortable window width, and when it stops
   * approximating it the reader does not degrade — it INVENTS. Measured in a
   * 624px-wide window:
   *
   *     composer            386 → 461   (75px)
   *     derived column      346 → 501
   *     a real message      432 → 578   — overhangs the right edge by 77px
   *
   * Every real bubble then sat roughly equidistant from both edges, which is
   * the test for a date divider, so EVERY MESSAGE WAS DISCARDED. What got
   * through instead was the Notes carousel, whose bubbles happen to fall
   * inside those bounds — so the thread read as a single inbound message
   * saying "Jean Carlo Azofeifa", a stranger's note, and the character
   * answered it: "hey jean carlo, where are you from?" to somebody called
   * Arman.
   *
   * The messages know where they are. Asking them removes the width
   * assumption entirely.
   */
  function conversationColumn() {
    const arts = [...document.querySelectorAll('div[role="article"]')].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 15 && r.height > 12;
    });
    if (arts.length) {
      const bottom = composer()?.getBoundingClientRect().top ?? window.innerHeight;
      // ⚠ THE ROW, NOT THE BUBBLE. Each message sits in a `role="group"` row
      // that spans the whole pane, and the bubble hugs one end of it — which is
      // the only thing that says who sent it.
      //
      // Measuring the column from the BUBBLES instead makes the widest bubble
      // define the column, so it fills 100% of it. In a thread where every
      // message is the same length — fifteen copies of one follow-up — every
      // bubble then sat flush against BOTH edges, `toLeft` and `toRight` were
      // both 0, and our own outgoing messages were reported as INBOUND. The
      // sweep would have answered its own follow-up.
      const rows = arts.map((a) => (a.closest('div[role="group"]') ?? a).getBoundingClientRect());
      return {
        left: Math.min(...rows.map((r) => r.left)),
        right: Math.max(...rows.map((r) => r.right)),
        bottom,
        top: 60,
      };
    }
    // No messages on screen yet — fall back to the composer so an empty
    // conversation still reports a column rather than nothing.
    const el = composer();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left - 40, right: r.right + 40, bottom: r.top, top: 60 };
  }

  /**
   * Which side a message is on.
   *
   * Incoming and outgoing messages carry identical roles and classes, so the
   * only signal is alignment — and the reliable form of that is EDGE distance,
   * not centre-of-column. A short message sits near its own edge while its
   * centre is nowhere near the column's, so comparing centres misreads every
   * brief reply; comparing which edge the bubble hugs is exactly what the
   * underlying flex alignment does.
   *
   * A bubble that hugs neither edge is centred — a date divider or an "unread"
   * marker — and is reported as such so the caller can drop it. Under an RTL
   * locale the two sides swap, which is why the account language is a
   * documented requirement (see README).
   */
  function sideOf(rect, col) {
    const toLeft = Math.abs(rect.left - col.left);
    const toRight = Math.abs(rect.right - col.right);
    if (toLeft > 60 && toRight > 60 && Math.abs(toLeft - toRight) < 60) return "divider";
    return toRight < toLeft ? "out" : "in";
  }

  /**
   * The thread as an ordered list of {side, text}, oldest first.
   *
   * Instagram virtualises long threads, so this is only ever what is currently
   * rendered — the recent tail, never full history. FluidTalk keeps the real
   * transcript server-side, so the tail is all this side needs.
   */
  function readMessages(limit = MAX_HISTORY) {
    const col = conversationColumn();
    if (!col) return [];
    const main = document.querySelector('div[role="main"]') ?? document.body;

    // PASS 1 — collect candidates, bounded on the LEFT only.
    //
    // The right edge must NOT be taken from the composer: an outgoing bubble
    // overhangs it (measured: composer ends at 2389, our own message ends at
    // 2506). Bounding by the composer therefore discarded every OUTGOING
    // message while keeping every incoming one — which is why direction looked
    // like "everything is inbound" in each thread sampled, and why a message
    // that really had been delivered was reported as never arriving.
    const cands = [];
    for (const el of main.querySelectorAll("div")) {
      // A message bubble is the element that DIRECTLY wraps the text span;
      // going deeper gets the span (often zero-width when it wraps) and going
      // shallower gets a container spanning the whole column.
      const span = el.querySelector(':scope > span[dir="auto"], :scope > div > span[dir="auto"]');
      if (!span) continue;

      // Every thread opens with the other party's PROFILE CARD ("<handle> ·
      // Instagram", follower count, View profile). It looks exactly like a
      // message bubble to a geometry test and was being reported as an
      // OUTGOING one — which is the worst possible misread, because a thread
      // whose last entry looks like ours is a thread we decide needs no reply.
      // The card is the only bubble that links to a profile, so the anchor is
      // what separates it, in any locale. It must be looked for UPWARDS: the
      // card wraps its text in the <a>, so querySelector (which only searches
      // descendants) finds nothing and the card survives the filter.
      if (el.closest('a[href^="/"]')) continue;

      // ⚠ A MESSAGE LIVES INSIDE role="article". Nothing else in this view
      // does, and geometry alone cannot tell them apart: the NOTES CAROUSEL
      // renders bubbles of message-like size and position, as `role="button"`,
      // and one of them was read as the lead's only message — the character
      // then addressed a man called Arman as "jean carlo", the name on
      // somebody else's note. The text even changed between reads, because
      // the carousel rotates.
      if (!el.closest('div[role="article"]')) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 15 || r.height < 12) continue;
      if (r.top < col.top || r.bottom > col.bottom) continue;
      // Left bound only — it is what excludes the inbox list beside us.
      if (r.left < col.left - 40) continue;

      const text = norm(el.innerText);
      if (!text) continue;
      cands.push({ rect: r, text });
    }

    // Photo bubbles carry no text at all, so the text pass above skips them
    // entirely — a lead who sends only a picture produced NO message, and the
    // thread looked like it ended on whatever they last typed. Merged in by
    // vertical position, which is chronological order in a thread.
    // A VIDEO IS A POSTER PLUS A PLAY BUTTON, and nothing else — there is no
    // `<video>` element in the thread at all until you press play (measured
    // 2026-09-10). So a video message has always been read here as an ordinary
    // photo of its own first frame, silently: the character answered a still
    // and nothing said the motion had been dropped.
    //
    // Instagram's play overlay is a plain `<img>` at a fixed URL, which is what
    // makes the two tellable apart without a class name.
    const playCentres = [...main.querySelectorAll('img[src*="playButton"]')].map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    for (const im of main.querySelectorAll("img")) {
      const r = im.getBoundingClientRect();
      // The play overlay is ~45px and would otherwise be dropped by the size
      // gate below anyway; skip it explicitly so it can never become a message.
      if ((im.src ?? "").includes("playButton")) continue;
      // Same rule as the text pass: a message lives inside `role="article"`.
      // Without it any decoration of the right size becomes a photo the lead
      // supposedly sent — measured here as INSTAGRAM'S OWN APP ICON,
      // `instagram.com/images/instagram/xig/ico/xxhdpi_launcher.png`, read as
      // an inbound photo. That alone made the thread look owed a reply, and
      // the character would have been asked to comment on a logo.
      if (!im.closest('div[role="article"]')) continue;
      // Second guard, because the first depends on markup: a real DM photo is
      // always served from the CDN. Instagram's own static assets are not.
      if (/\/images\/instagram\//.test(im.src ?? "")) continue;
      if (r.width < 60 || r.height < 60) continue;
      if (r.top < col.top || r.bottom > col.bottom) continue;
      if (r.left < col.left - 40) continue;
      const alt = (im.getAttribute("alt") ?? "").toLowerCase();
      if (alt.includes("profile-picture") || alt.includes("zdjęcie profilowe")) continue;
      // A play button sitting INSIDE this image's box makes it a video poster.
      const isVideo = playCentres.some((c) => c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom);
      // A STICKER (Instagram's GIF picker) is an ordinary `<img>` and would
      // otherwise be answered as a photograph. It matters that it is named: a
      // sticker carries meaning the picture alone does not, which is why
      // `MEDIA_AS` tells the character "sent a sticker" rather than handing
      // over an empty message.
      //
      // Two signals, because neither is comfortable alone. `alt="Sticker"` came
      // back in ENGLISH on a Polish UI (measured 2026-09-10), so it looks
      // unlocalised — but "looks unlocalised" is exactly the assumption that
      // broke the Send button here before. The url is the second opinion:
      // Instagram proxies the Giphy file through its external-media gateway,
      // `external-*.xx.fbcdn.net/emg1/…?url=…giphy…`, which an uploaded photo
      // never uses. Measured: it serves `image/webp`, 68674 bytes, and the
      // worker can fetch it directly (host_permissions already covers fbcdn).
      const src = im.currentSrc || im.src || "";
      const isSticker = !isVideo && (alt === "sticker" || /\/emg1\//.test(src));
      cands.push({
        rect: r,
        text: "",
        imageUrl: src,
        kind: isVideo ? "video" : isSticker ? "sticker" : "photo",
        isVideo,
      });
    }
    cands.sort((a, b) => a.rect.top - b.rect.top);

    if (cands.length === 0) return [];

    // PASS 2 — the column's true right edge is the furthest any bubble reaches,
    // so the reference calibrates itself instead of trusting the composer.
    const bounds = {
      left: col.left,
      right: Math.max(...cands.map((c) => c.rect.right)),
    };

    const out = [];
    const seen = new Set();
    for (const c of cands) {
      // The date separator, the "unread" marker and the profile card used to be
      // told apart by spanning the full column, on the reasoning that a message
      // bubble never does. `role="article"` identifies them properly now, and
      // the width test has to GO rather than merely be redundant:
      //
      // the column is measured from the articles themselves, so the widest
      // bubble defines the column and is therefore 100% of it. In a thread
      // where every message is the same length — fifteen copies of one
      // follow-up, which is exactly the thread that exposed this — EVERY
      // message spans the full column and every one was dropped. The thread
      // then read as `no_messages`, which is also why the follow-up was sent
      // fifteen times: delivery is confirmed by reading the thread back, and
      // the confirmation could not see anything.
      // Photos are deduped by URL — every one has the same empty text, so
      // keying on text alone would collapse a whole album into one message.
      const key = c.imageUrl ? `img:${c.imageUrl}` : c.text;
      if (seen.has(key)) continue;
      seen.add(key);

      const side = sideOf(c.rect, bounds);
      if (side === "divider") continue;
      out.push({
        side,
        text: c.text,
        ...(c.imageUrl ? { imageUrl: c.imageUrl, kind: c.kind ?? "photo", isVideo: Boolean(c.isVideo) } : { kind: "text" }),
      });
    }
    return out.slice(-limit);
  }

  /** /inbound-media refuses anything larger. */
  const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  /**
   * The bytes of a VIDEO message, which on Instagram cannot simply be fetched.
   *
   * Three facts, all measured live 2026-09-10, and each one rules out the
   * obvious approach:
   *
   *   1. A video bubble contains NO `<video>` element. It is a poster `<img>`
   *      plus a `playButton.png` overlay, and the element only mounts when the
   *      play button is actually pressed.
   *   2. Once mounted, its src is a `blob:` — so the WORKER cannot fetch it
   *      (a blob url resolves only in the page that made it).
   *   3. That blob is MediaSource-backed, so **the page cannot fetch it
   *      either**: `fetch(blob)` answers "Failed to fetch". There is no file
   *      anywhere to download.
   *
   * So the only thing that exists is decoded frames, and re-encoding them is
   * the primary path here rather than the fallback it is on Telegram. Same
   * helpers, same measurements — see `media.js`.
   *
   * The poster is passed in as `url`, because that is what `readMessages` saw;
   * it is used to find the right bubble, not to download anything.
   */
  async function mediaBytes(url) {
    if (!url) return { ok: false, reason: "no url" };

    const poster = [...document.querySelectorAll("img")].find((i) => (i.currentSrc || i.src) === url);
    if (!poster) return { ok: false, reason: "that media is no longer on screen" };

    const box = poster.getBoundingClientRect();
    const play = [...document.querySelectorAll('img[src*="playButton"]')].find((p) => {
      const r = p.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
    });

    // No play button: an ordinary photo, and the CDN link IS fetchable.
    if (!play) {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const type = blob.type || res.headers.get("content-type") || "";
        if (!/^(image|video)\//.test(type)) {
          return { ok: false, reason: `not image or video (${type || "no type"}, ${blob.size} bytes)` };
        }
        if (blob.size > MAX_MEDIA_BYTES) return { ok: false, reason: `too large (${blob.size} bytes)` };
        return window.__ftMedia.toB64(blob, type);
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    }

    const video = await mountVideo(poster, play);
    if (!video) return { ok: false, reason: "pressing play never produced a video element" };

    const small = await window.__ftMedia.shrinkVideo(video, MAX_MEDIA_BYTES);
    if (small.ok) return { ...small, shrunkBecause: "Instagram has no downloadable file for a DM video" };

    const frame = await window.__ftMedia.captureVideoFrame(video, "video");
    return frame.ok
      ? { ...frame, fellBackBecause: small.reason }
      : { ...frame, reason: `${frame.reason} (after: ${small.reason})` };
  }

  /**
   * Press play and wait for the element to exist AND be decodable.
   *
   * The click has to be a real pointer sequence at the button's centre — the
   * same lesson as opening a chat. Scrolled into view first, because a bubble
   * off-screen is not laid out where its rect says it is.
   */
  async function mountVideo(poster, play) {
    poster.scrollIntoView({ block: "center" });
    await sleep(400);

    const known = new Set([...document.querySelectorAll("video")]);
    const r = play.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      button: 0,
    };
    const target = document.elementFromPoint(opts.clientX, opts.clientY) ?? play;
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const C = t.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      target.dispatchEvent(new C(t, opts));
    }

    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const fresh = [...document.querySelectorAll("video")].find((v) => !known.has(v) || v.videoWidth > 0);
      if (fresh?.videoWidth) return fresh;
    }
    return null;
  }

  /**
   * Instagram's "this message can't be shown here" placeholder.
   *
   * The web client cannot render some message types and substitutes its own
   * copy. That text is INSTAGRAM'S, not the lead's — feeding it to the
   * character makes it answer a sentence nobody sent, and the reply comes back
   * plausible and generic, which is exactly what hides the mistake. Seen live:
   * a lead sent two such messages and the character replied "hey you sent that
   * twice lol".
   *
   * There is no structural marker to match on — the bubble looks like any
   * other — so this is a text heuristic and therefore locale-bound. It lists
   * the phrasings actually observed; a locale not covered here falls through
   * and is treated as a real message. That is why the caller REFUSES a thread
   * whose newest inbound is a placeholder rather than skipping back to an older
   * message: when we cannot read what they last said, we do not answer.
   */
  const PLACEHOLDER_PATTERNS = [
    /nieobsługiwana wiadomość/i, // pl — "unsupported message"
    /unsupported message/i, // en
    /aby wyświetlić tę wiadomość/i, // pl — "to view this message…"
    /to view this message/i, // en
    // VIEW-ONCE media. Instagram does not deliver the bytes to the web client
    // at all — there is no <img>, only this sentence — so it can never be
    // collected from a browser, and the sentence is Instagram's, not theirs.
    // Measured live: "To zdjęcie można odtworzyć ponownie tylko raz. Użyj
    // aplikacji mobilnej, aby je wyświetlić."
    /u[żz]yj aplikacji mobilnej/i, // pl — "use the mobile app"
    /use the (instagram |mobile )?app to (view|see|play)/i, // en
    /odtworzy[ćc] ponownie tylko raz/i, // pl — "can only be replayed once"
    /(view|play)ed once|only be (replayed|played|viewed) once/i, // en
    /aplikacji mobilnej instagram/i, // pl — older wording
  ];

  function isPlaceholder(text) {
    return PLACEHOLDER_PATTERNS.some((re) => re.test(text));
  }

  /**
   * WHAT kind of unopenable thing this is.
   *
   * Worth separating, because the two deserve different words: we know a
   * view-once photo WAS a photo, and that is enough for the character to react
   * to naturally. "Unsupported" could be anything, so it is described as an
   * attachment and nothing more.
   */
  const VIEW_ONCE_PATTERNS = [
    /odtworzy[ćc] ponownie tylko raz/i,
    /(view|play)ed once|only be (replayed|played|viewed) once/i,
    /u[żz]yj aplikacji mobilnej/i,
    /use the (instagram |mobile )?app to (view|see|play)/i,
  ];

  function placeholderKind(text) {
    if (!isPlaceholder(text)) return null;
    return VIEW_ONCE_PATTERNS.some((re) => re.test(text)) ? "view_once" : "unsupported";
  }

  /** The newest message, only if THEY sent it — i.e. the one owed a reply. */
  function lastInbound(messages) {
    const last = messages[messages.length - 1];
    return last && last.side === "in" ? last : null;
  }

  function readThread(ownHandle) {
    const id = threadId();
    if (!id) return { ok: false, reason: "not_on_thread" };
    const messages = readMessages();
    if (messages.length === 0) return { ok: false, reason: "no_messages", threadId: id };
    const last = lastInbound(messages);
    return {
      ok: true,
      threadId: id,
      handle: readHandle(ownHandle),
      messages,
      lastInbound: last,
      // Their newest message is one Instagram would not show us.
      lastInboundUnreadable: Boolean(last && isPlaceholder(last.text)),
      unreadableKind: last ? placeholderKind(last.text) : null,
      // "Never answered before" — what the hourly cap is counted against.
      // The profile card used to make every thread look answered; it is
      // filtered out of `messages` now, so this means what it says.
      neverAnswered: !messages.some((m) => m.side === "out"),
      /**
       * MAY WE SEND HERE AT ALL?
       *
       * On a message REQUEST the recipient has not accepted, Instagram does not
       * disable the input — it removes it outright. Measured on four live
       * threads 2026-09-14: `hey!` sent and unanswered gave no
       * `[contenteditable]`, no `<textarea>` and an empty footer, while two
       * threads where the lead HAD replied both carried a composer with
       * placeholder "Wyślij wiadomość…". So the composer's mere presence is a
       * structural, locale-independent answer to "can this thread receive
       * anything", and it is the only honest one available before a send.
       *
       * Why it is reported rather than discovered at send time: `generate()` is
       * a BILLED FluidTalk turn and runs first, so a thread that could never
       * accept a message still cost money on every cycle and failed afterwards
       * with "composer not found". The worker can now skip before spending.
       *
       * It also disarms Instagram's system NOTICES without matching any of
       * their text. "To konto nie może odebrać Twojej wiadomości…" and "Masz
       * nieodebrane połączenie wideo" both render inside `role="article"` and
       * are read as the lead's newest message — the refusal one measured
       * spanning the full column (423→1050 against a 423→1050 column), so both
       * insets are 0, the divider test needs >60 on each side, and it falls
       * through to `"in"`. Rather than chase each string in each locale, a
       * thread we cannot answer is simply never treated as owed a reply.
       *
       * `ok:true` already implies at least one rendered message, so a missing
       * composer here cannot be a half-loaded page — which is the difference
       * between this and a heal loop that condemns a tab mid-navigation.
       */
      canSend: Boolean(composer()),
    };
  }

  // ── writing into the composer ──────────────────────────────────────────────

  function composer() {
    const scope = document.querySelector('div[role="main"]') ?? document;
    return (
      scope.querySelector('div[contenteditable="true"][role="textbox"]') ??
      scope.querySelector('div[contenteditable="true"]')
    );
  }

  /**
   * Put text in the composer so Instagram's editor actually registers it.
   *
   * The composer is a Lexical editor: it keeps its own model and repaints the
   * DOM from it. Assigning `textContent` changes what you SEE and leaves that
   * model empty — the Send button stays disabled and Enter sends nothing, with
   * no error anywhere. `insertText` is deprecated but is the one path that
   * still emits the real `beforeinput`/`input` pair Lexical commits on.
   */
  function typeIntoComposer(text) {
    const el = composer();
    if (!el) throw new Error("composer not found");
    // Empty text CANNOT clear this editor, and pretending otherwise is the
    // dangerous half: measured, `insertText` with "" no-ops and returns
    // success, as does execCommand("delete") — Lexical only honours real key
    // events, which a content script cannot synthesise as trusted. A caller
    // that thought it had emptied the box would leave a draft behind for the
    // next Enter to send.
    if (!text) throw new Error("cannot clear the composer — type real text, or clear it by hand");
    el.focus();
    // Replace whatever is there — a half-typed draft would be prefixed onto us.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) throw new Error("execCommand(insertText) refused");
    return el;
  }

  /**
   * Instagram's Send control — it exists only once there is text to send.
   *
   * Matching the WORD "send" was the original bug: it finds nothing outside
   * English, and this account runs Polish ("Wyślij").
   *
   * What identifies it in any language is a STATE CHANGE in the composer row.
   * Empty, the row ends in three media controls (mic, photo, GIF) and there is
   * no Send at all; with text, Instagram collapses those three into a single
   * Send button. So "exactly one control to the right of a NON-EMPTY composer"
   * is unambiguous, and any other count refuses rather than guessing — which is
   * what keeps an empty-composer call from clicking the microphone.
   */
  function sendButton({ allowEmpty = false } = {}) {
    const el = composer();
    if (!el) return null;
    // Nothing typed => no Send exists. `allowEmpty` is for the photo path: an
    // attached image makes Send appear with the text box still empty, and the
    // media controls collapse the same way, so the one-control rule still holds.
    if (!allowEmpty && !norm(el.innerText)) return null;
    const box = el.getBoundingClientRect();
    const scope = document.querySelector('div[role="main"]') ?? document;

    const toTheRight = [];
    for (const b of scope.querySelectorAll('div[role="button"], button')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.top < box.bottom + 24 && r.bottom > box.top - 24 && r.left >= box.right - 8) {
        toTheRight.push(b);
      }
    }
    return toTheRight.length === 1 ? toTheRight[0] : null;
  }

  /**
   * Send what is in the composer.
   *
   * Both paths are known to work against the live site — a synthesised Enter
   * delivered a message here, as did the button. The button is preferred only
   * because clicking the control a person would click runs Instagram's own
   * handler, where Enter depends on their key handling staying as it is.
   */
  function sendComposer({ allowEmpty = false } = {}) {
    const btn = sendButton({ allowEmpty });
    if (btn) {
      btn.click();
      return "button";
    }
    const el = composer();
    if (!el) throw new Error("composer not found");
    el.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return "enter";
  }

  /**
   * Send one bubble and confirm it landed.
   *
   * A click that Instagram ignored looks exactly like one it accepted, so the
   * oracle is the thread itself: the message is sent only once it appears as an
   * OUTGOING row. Returning ok on the click alone is how a "sent" counter runs
   * ahead of what the lead actually received.
   */
  async function sendBubble(text, expectThreadId = null) {
    // The thread must still be the one this reply was written for — see the
    // Telegram adapter for the incident that made this necessary. Instagram
    // puts the thread id in the path, so it is cheap to check and there is no
    // excuse for sending into whatever conversation the tab drifted onto.
    if (expectThreadId && threadId() !== expectThreadId) {
      return {
        ok: false,
        reason: `the open conversation changed (wanted ${expectThreadId}, on ${threadId() ?? "nothing"}) — not sending`,
      };
    }
    // ⚠ COUNTED, NOT MATCHED, and counted on the RAW thread.
    //
    // `readMessages` deduplicates by text — it has to, or a photo album
    // becomes one message — so a second copy of a sentence already in the
    // thread is collapsed into the first and cannot be seen arriving. Asking
    // "is this text present?" then answers about the OLD copy: it says yes
    // before the send has landed, and says nothing useful after.
    //
    // That matters most in exactly the threads this went wrong in. Counting
    // outgoing bubbles carrying the text, before and against after, tests the
    // one thing that matters — that ONE MORE now exists.
    // ⚠ THE NEWEST MESSAGE MUST BE THIS ONE. Neither of the obvious oracles
    // survives a real thread:
    //
    //   "is the text present?"  — `readMessages` DEDUPLICATES by text, so a
    //   second copy of a sentence already in the thread collapses into the
    //   first. It answers about the old copy: yes before the send lands.
    //
    //   "did the count go up?"  — the thread is VIRTUALISED at about twenty
    //   rendered bubbles, so a new message pushes the oldest out. Measured on
    //   a thread holding fifteen copies of one follow-up: total stayed at 20,
    //   the arriving copy replaced a departing one, and the count never moved
    //   while the message was plainly being delivered.
    //
    // Position is immune to both. The bubble we just sent is at the bottom,
    // and its being ours is what separates delivery from the lead happening to
    // have said the same thing.
    const newestIsOurs = () => {
      const arts = [...document.querySelectorAll('div[role="article"]')];
      if (!arts.length) return false;
      const last = arts.reduce((a, b) => (b.getBoundingClientRect().top > a.getBoundingClientRect().top ? b : a));
      // NORMALISED on both sides. Raw `innerText` carries the line breaks the
      // bubble wrapped at, so a sentence that wrapped never matches the single
      // line we sent — the check then fails for every message long enough to
      // wrap, which is most of them.
      if (!norm(last.innerText).includes(norm(text).slice(0, 40))) return false;
      const r = last.getBoundingClientRect();
      const row = (last.closest('div[role="group"]') ?? last).getBoundingClientRect();
      return Math.abs(r.right - row.right) < Math.abs(r.left - row.left);
    };

    typeIntoComposer(text);
    // Let Lexical commit before the click reads its state.
    await sleep(120);
    const via = sendComposer();

    for (let i = 0; i < 40; i += 1) {
      await sleep(150);
      if (newestIsOurs()) return { ok: true, via };
    }
    return { ok: false, via, reason: "not_visible_after_send" };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── photos ─────────────────────────────────────────────────────────────────

  /**
   * Instagram's own file input for the composer.
   *
   * It exists in the DOM, hidden, next to the composer —
   * `accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg"`, multiple. That is what makes
   * sending a photo possible at all: clicking "Add photo" opens a NATIVE file
   * dialog, which a content script cannot drive, but handing files straight to
   * the input skips the dialog entirely.
   */
  function composerFileInput() {
    const el = composer();
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter((i) => {
      const accept = (i.getAttribute("accept") ?? "").toLowerCase();
      return accept.includes("png") || accept.includes("jpg") || accept.includes("image");
    });
    if (inputs.length === 0) return null;
    if (inputs.length === 1) return inputs[0];
    // More than one: take the one nearest the composer rather than guessing.
    return inputs
      .map((i) => ({ i, d: Math.abs(i.getBoundingClientRect().top - box.top) }))
      .sort((a, b) => a.d - b.d)[0].i;
  }

  /** Photos currently rendered in the thread, by side. Avatars are excluded. */
  function readPhotos() {
    const col = conversationColumn();
    if (!col) return [];
    const main = document.querySelector('div[role="main"]') ?? document.body;
    const out = [];
    for (const im of main.querySelectorAll("img")) {
      const r = im.getBoundingClientRect();
      // An avatar is small and square; a photo bubble is not.
      if (r.width < 60 || r.height < 60) continue;
      if (r.top < col.top || r.bottom > col.bottom) continue;
      if (r.left < col.left - 40) continue;
      const alt = (im.getAttribute("alt") ?? "").toLowerCase();
      if (alt.includes("profile-picture") || alt.includes("zdjęcie profilowe")) continue;
      out.push({ side: sideOf(r, { left: col.left, right: Math.max(col.right, r.right) }), src: im.currentSrc || im.src });
    }
    return out;
  }

  /**
   * Put a photo in the composer and send it.
   *
   * Confirmed against the thread, like text: the count of OUTGOING photos has
   * to grow. Instagram shows an upload preview the moment the file is accepted,
   * so reporting success there would claim a delivery that is still in flight.
   */
  async function sendPhoto({ dataB64, filename, mime }) {
    const input = composerFileInput();
    if (!input) return { ok: false, reason: "no file input in the composer" };

    const before = readPhotos().filter((p) => p.side === "out").length;

    const bin = atob(dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename || "photo.png", { type: mime || "image/png" });

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // The preview has to appear before there is anything to send.
    let ready = false;
    for (let i = 0; i < 50 && !ready; i += 1) {
      await sleep(200);
      ready = Boolean(sendButton({ allowEmpty: true })) || readPhotos().filter((p) => p.side === "out").length > before;
    }
    if (!ready) return { ok: false, reason: "the photo never appeared in the composer" };

    const via = sendComposer({ allowEmpty: true });

    for (let i = 0; i < 75; i += 1) {
      await sleep(200);
      if (readPhotos().filter((p) => p.side === "out").length > before) return { ok: true, via };
    }
    return { ok: false, via, reason: "photo not visible in the thread after sending" };
  }

  // ── the inbox list ─────────────────────────────────────────────────────────

  /**
   * The conversation rows in the inbox column.
   *
   * The rows are neither anchors nor `role=link` and carry no thread id, so
   * there is nothing to address them BY except their own text — which is what
   * `label` is, and what `openThread` matches on. Geometry picks them out: the
   * inbox is the narrow left column, and a row is one avatar tall.
   *
   * Deliberately does NOT decide whether a thread has been answered. The inbox
   * preview shows a localised "you:" prefix which would be a cheap way to guess
   * it, but a preview is a truncated summary of one message — the honest answer
   * needs the thread open, which is where `neverAnswered` is computed.
   */
  /**
   * The row ELEMENTS, as one definition both listing and opening share.
   *
   * Having two of these was a bug that cost a whole sweep: the list labelled
   * rows with `innerText` while the opener matched against `textContent`, and
   * those are not the same string even after normalising — `innerText` inserts
   * separators between block elements, `textContent` concatenates with none
   * ("…contractor Okay · 1 tydz." vs "…contractorOkay·1 tydz."). Nothing ever
   * matched, and the sweep skipped an inbox it had just finished counting.
   * One definition, one label, no chance of drift.
   */
  function inboxRowElements() {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("div")) {
      const r = el.getBoundingClientRect();
      if (r.left > 520 || r.width < 200) continue;
      if (r.height < 55 || r.height > 105) continue;
      const raw = el.innerText;
      const label = norm(raw);
      if (!label || label.length < 4 || seen.has(label)) continue;
      seen.add(label);
      // The first line is the conversation's NAME, and it is the only part
      // that survives inside a single text node — which is what the click
      // needs to locate, since a row's own box is not the click target.
      rows.push({ el, label, name: norm(raw.split("\n")[0]) });
    }
    return rows;
  }

  /**
   * The inbox rows that are actually CONVERSATIONS.
   *
   * The strip at the top of the list is our OWN account — the note bubble — and
   * it matches every geometric test a conversation row does. Clicking it does
   * not open a thread; it reaches into our own account UI, which is where an
   * account switcher / login screen comes from. It was row 0 of every sweep.
   *
   * Two filters, because either alone leaves a hole: our own handle (which the
   * worker supplies, since the page cannot know it), and the requirement that a
   * row carry a "· <age>" stamp — every real conversation has one and the note
   * strip has none.
   */
  function listThreads(ownHandle) {
    const own = (ownHandle ?? "").toLowerCase();
    return inboxRowElements()
      .filter(({ label, name }) => {
        if (own && name.toLowerCase() === own) return false;
        return /·\s*\d/.test(label);
      })
      .map(({ label, name }) => ({
        label,
        name,
        unread: /\bUnread\b|\bNieprzeczytan/i.test(label),
      }));
  }

  /**
   * Open the inbox row whose label matches.
   *
   * Clicking the row's own container does NOTHING — it reports success and the
   * page does not move. Instagram puts the handler on an element between the
   * row box and the text, so the click has to start from the DEEPEST node
   * carrying the name and walk UP to the first interactive ancestor. Walking
   * up from the row container goes the wrong way entirely.
   */
  function openThread(label) {
    const before = threadId();
    const row = inboxRowElements().find((r) => r.label === label);
    if (!row) return { clicked: false, reason: "row not found", before };

    const deepest = [...row.el.querySelectorAll("span, div")].filter(
      (e) => e.offsetParent !== null && norm(e.textContent).includes(row.name),
    );
    let node = deepest[deepest.length - 1] ?? row.el;
    for (let i = 0; i < 9 && node && node !== row.el.parentElement; i += 1) {
      if (node.getAttribute?.("role") === "button" || node.tagName === "A") break;
      node = node.parentElement;
    }
    (node ?? row.el).click();
    return { clicked: true, before };
  }

  // ── message requests ───────────────────────────────────────────────────────

  /**
   * Accepting a request is the one action here that sits next to a DESTRUCTIVE
   * one. The same row offers Delete and Block, so a loose match does not fail
   * by doing nothing — it fails by throwing somebody away permanently.
   *
   * Three rules follow, and all three are load-bearing:
   *  1. Match only an exact, whole-label accept word. Never position.
   *  2. Reject outright anything carrying a destructive word, before matching.
   *  3. Require EXACTLY ONE candidate. Ambiguity refuses rather than picks.
   *
   * Locale-bound like the placeholder patterns; an unlisted language finds
   * nothing and accepts nothing, which is the safe direction to fail.
   */
  const ACCEPT_PATTERNS = [/^accept$/i, /^akceptuj$/i, /^zaakceptuj$/i, /^allow$/i, /^zezw[oó]l$/i];
  const DESTRUCTIVE_PATTERNS = [
    /delete/i, /usu[nń]/i, /odrzu/i, /decline/i, /block/i, /zablokuj/i,
    /report/i, /zg[lł]o/i, /spam/i,
  ];

  function acceptCandidates() {
    const scope = document.querySelector('div[role="main"]') ?? document;
    const hits = [];
    for (const b of scope.querySelectorAll('div[role="button"], button')) {
      if (b.offsetParent === null) continue;
      const label = norm(b.getAttribute("aria-label") || b.textContent);
      if (!label || label.length > 24) continue;
      if (DESTRUCTIVE_PATTERNS.some((re) => re.test(label))) continue;
      if (ACCEPT_PATTERNS.some((re) => re.test(label))) hits.push({ el: b, label });
    }
    return hits;
  }

  /**
   * Accept the request whose thread is open. `dryRun` reports the control it
   * WOULD press without pressing it — the only way to check this against a real
   * request without spending one.
   */
  /**
   * Accepting takes TWO presses, and missing the second silently un-does the
   * first.
   *
   * Pressing Accept opens "Move messages from <them> to: Primary / General /
   * Cancel". Until that is answered the request is NOT accepted — navigating
   * away is the same as cancelling. Measured on a real request: one press,
   * `ok: true` reported, and the request still sat in the folder afterwards.
   *
   * Cancel is never a candidate: it aborts the very thing being attempted.
   */
  const FOLDER_CHOICES = [
    [/^primary$/i, /folder podstawowy/i, /^podstawowy$/i],
    [/^general$/i, /informacje og[oó]lne/i, /^og[oó]lne$/i],
  ];
  const FOLDER_CANCEL = [/^anuluj$/i, /^cancel$/i, /^zamknij$/i, /^close$/i];

  function chooseFolder() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { picked: null, reason: "no folder dialog" };
    const options = [...dialog.querySelectorAll('div[role="button"], button')]
      .filter((b) => b.offsetParent !== null)
      .map((el) => ({ el, label: norm(el.getAttribute("aria-label") || el.textContent) }))
      .filter((o) => o.label && o.label.length < 40)
      .filter((o) => !FOLDER_CANCEL.some((re) => re.test(o.label)));

    for (const group of FOLDER_CHOICES) {
      const hit = options.find((o) => group.some((re) => re.test(o.label)));
      if (hit) {
        hit.el.click();
        return { picked: hit.label };
      }
    }
    return { picked: null, reason: `no folder option matched (${options.map((o) => o.label).join(", ")})` };
  }

  async function acceptRequest({ dryRun = false } = {}) {
    const hits = acceptCandidates();
    if (hits.length === 0) return { ok: false, reason: "no accept control found" };
    if (hits.length > 1) {
      return { ok: false, reason: `ambiguous (${hits.map((h) => h.label).join(", ")})` };
    }
    if (dryRun) return { ok: true, dryRun: true, wouldClick: hits[0].label };

    hits[0].el.click();

    // The dialog is rendered asynchronously; answering it is step two.
    let folder = { picked: null };
    for (let i = 0; i < 25 && !folder.picked; i += 1) {
      await sleep(200);
      folder = chooseFolder();
    }
    if (!folder.picked) return { ok: false, reason: folder.reason ?? "the folder dialog never appeared" };

    // The oracle is the thread itself: a request has no composer, an accepted
    // conversation does. Reporting success off the click would claim an accept
    // that the dialog may still have refused.
    for (let i = 0; i < 40; i += 1) {
      await sleep(200);
      if (composer()) return { ok: true, clicked: hits[0].label, folder: folder.picked };
    }
    return { ok: false, reason: `chose "${folder.picked}" but no composer appeared`, folder: folder.picked };
  }

  // ── followers, for outreach ────────────────────────────────────────────────

  /**
   * Handles listed in the followers dialog that is currently open.
   *
   * Only reads what is rendered — the dialog virtualises, so this is a page of
   * followers, not all of them. The caller scrolls and asks again.
   */
  /**
   * Open the followers dialog on our own profile.
   *
   * Navigating straight to /<handle>/followers/ does NOT open it — Instagram
   * renders the profile and leaves the modal closed, so a reader that just
   * waits there sees "dialog is not open" for ever. The modal is client-side
   * only: the followers COUNT has to be clicked.
   */
  const FOLLOWERS_PATTERNS = [
    /\bfollowers?\b/i, /obserwuj[ąa]cych/i, /seguidores/i, /abonn[ée]s/i, /подписчик/i,
  ];

  function openFollowers(ownHandle) {
    if (document.querySelector('div[role="dialog"]')) return { ok: true, already: true };

    // Some builds link it as /<handle>/followers/; this one renders
    // <a role="link" href="#">413 obserwujących</a>, so href alone finds
    // nothing and the text is the only remaining handle — locale-bound again.
    const byHref = document.querySelector(`a[href="/${ownHandle}/followers/"]`);
    if (byHref) {
      byHref.click();
      return { ok: true, via: "href" };
    }

    const hits = [];
    for (const el of document.querySelectorAll('a, div[role="button"]')) {
      if (el.offsetParent === null) continue;
      const txt = norm(el.textContent);
      if (!txt || txt.length > 40) continue;
      if (FOLLOWERS_PATTERNS.some((re) => re.test(txt))) hits.push({ el, txt });
    }
    if (hits.length === 0) return { ok: false, reason: "no followers control found" };
    // "Following" sits right next to it, so prefer the real anchor and report
    // what was pressed — a mis-click here reads the wrong list entirely.
    const pick = hits.find((h) => h.el.tagName === "A") ?? hits[0];
    pick.el.click();
    return { ok: true, via: "text", label: pick.txt };
  }

  function listFollowers() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return { ok: false, reason: "followers dialog is not open" };

    const handles = [];
    const seen = new Set();
    for (const a of dialog.querySelectorAll('a[href^="/"]')) {
      const m = a.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/$/);
      if (!m || ROUTES.has(m[1].toLowerCase())) continue;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      handles.push(m[1]);
    }
    return { ok: true, handles };
  }

  /** Scroll the followers dialog to load more. Returns whether it moved. */
  function scrollFollowers() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return { moved: false };
    let box = null;
    for (const d of dialog.querySelectorAll("div")) {
      if (d.scrollHeight > d.clientHeight + 40 && d.clientHeight > 120) { box = d; break; }
    }
    if (!box) return { moved: false };
    const before = box.scrollTop;
    box.scrollTop = box.scrollHeight;
    return { moved: box.scrollTop !== before };
  }

  /**
   * Open a DM with the profile currently on screen.
   *
   * The Message button is text-matched and therefore locale-bound, like the
   * accept control. It refuses on ambiguity rather than guessing, because the
   * wrong button on a profile is Follow, Unfollow or Block.
   */
  const MESSAGE_PATTERNS = [
    /^message$/i, /^wy[sś]lij wiadomo[sś][cć]$/i, /^wiadomo[sś][cć]$/i,
  ];
  const PROFILE_DANGER = [
    /follow/i, /obserwuj/i, /block/i, /zablokuj/i, /report/i, /zg[lł]o/i,
    // Restrict sits directly beside Send message in the options menu and is
    // every bit as destructive as Block from the lead's side.
    /restrict/i, /ogranicz/i,
  ];

  /** Message, wherever it is — the profile header or an open menu. */
  function messageControls(scope) {
    const hits = [];
    for (const b of scope.querySelectorAll('div[role="button"], button, a, [tabindex="0"]')) {
      if (b.offsetParent === null) continue;
      const label = norm(b.getAttribute("aria-label") || b.textContent);
      if (!label || label.length > 30) continue;
      if (PROFILE_DANGER.some((re) => re.test(label))) continue;
      if (MESSAGE_PATTERNS.some((re) => re.test(label))) hits.push({ el: b, label });
    }
    return hits;
  }

  /**
   * The profile's "..." control, found BY SHAPE.
   *
   * Its `aria-label` is localised ("Opcje" on this account) and its classes are
   * per-build noise, so neither can be matched. The icon is three dots, which
   * in the DOM is an `<svg>` whose only children are three `<circle>`s — that
   * survives both translation and a rebuild. `aria-haspopup="dialog"` narrows
   * it further: the similar-accounts chevron beside it is the same size and
   * would otherwise be a coin toss.
   */
  function moreButton() {
    const scope = document.querySelector("header") ?? document.body;
    for (const b of scope.querySelectorAll('div[role="button"][aria-haspopup="dialog"], button[aria-haspopup="dialog"]')) {
      if (b.offsetParent === null) continue;
      const svg = b.querySelector("svg");
      if (svg && svg.querySelectorAll("circle").length === 3) return b;
    }
    return null;
  }

  /**
   * Open a DM with the profile currently on screen.
   *
   * ⚠ **THE MESSAGE BUTTON ONLY EXISTS ON PROFILES WE FOLLOW.** On everybody
   * else the profile header holds Follow, the similar-accounts chevron and a
   * "..." — and Message lives inside that menu. Outreach is by definition
   * aimed at people we have NOT messaged, so this was the ordinary case, not
   * the edge one: measured on a live run, 50 of 50 followers failed with "no
   * Message button on this profile" and cold outreach had never once worked.
   *
   * The menu is opened only after the direct button has been ruled out, and if
   * Message is not in it the menu is closed again with Escape. Nothing else in
   * there is safe to press: Block, Restrict and Report sit in the same list,
   * which is why the danger patterns are checked FIRST and a match on more
   * than one candidate refuses rather than guessing.
   */
  async function openDm() {
    const direct = messageControls(document);
    if (direct.length === 1) {
      direct[0].el.click();
      return { ok: true, clicked: direct[0].label, via: "profile" };
    }
    if (direct.length > 1) {
      return { ok: false, reason: `ambiguous (${direct.map((h) => h.label).join(", ")})` };
    }

    const more = moreButton();
    if (!more) return { ok: false, reason: "no Message button and no options menu on this profile" };
    more.click();

    let dialog = null;
    for (let waited = 0; waited < 4000 && !dialog; waited += 200) {
      await sleep(200);
      dialog = document.querySelector('div[role="dialog"]');
    }
    if (!dialog) return { ok: false, reason: "the options menu did not open" };

    const inMenu = messageControls(dialog);
    if (inMenu.length !== 1) {
      // Leave the profile as we found it. A menu left hanging open is one
      // stray click away from Block.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      const seen = [...dialog.querySelectorAll('button, div[role="button"], [tabindex="0"]')]
        .map((e) => norm(e.getAttribute("aria-label") || e.textContent))
        .filter((t) => t && t.length < 40);
      return {
        ok: false,
        reason: inMenu.length
          ? `ambiguous in the options menu (${inMenu.map((h) => h.label).join(", ")})`
          : `no Message in the options menu (${[...new Set(seen)].join(" | ").slice(0, 120)})`,
      };
    }
    inMenu[0].el.click();
    return { ok: true, clicked: inMenu[0].label, via: "options menu" };
  }

  // ── posts and comments ─────────────────────────────────────────────────────

  /**
   * The permalink shortcode of a post page, or null if this is not one.
   *
   * TWO shapes in the wild: `/p/<code>/` from the feed, and
   * `/<author>/p/<code>/` from a profile grid. Matching only the first meant
   * every post opened from somebody's profile read as "not a post page".
   */
  const POST_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel)\/([^/]+)/;

  function postCode() {
    return location.pathname.match(POST_PATH)?.[1] ?? null;
  }

  /**
   * The post's reference as FluidTalk keys it — CANONICAL, not `location.origin`.
   *
   * `post_ref` is the identity of a comment THREAD on FluidTalk's side: a reply
   * arriving under a ref it has not seen anchors a brand-new thread, losing the
   * reply count, the per-author counts and the warmth that the stop rules are
   * computed from. Reading it off the current origin means the same post is two
   * threads if it is ever opened on `instagram.com` instead of `www.` — the
   * reply cap then never fires, and the character answers the same person for
   * ever. Pinning the host is what makes the ref the same string every time.
   */
  function postRef(code) {
    return `https://www.instagram.com/p/${code}/`;
  }

  /**
   * Posts visible in the home feed.
   *
   * Each `<article>` carries the permalink and the author's profile link. The
   * feed itself has NO comment box — the button there opens the post — so this
   * only collects references; commenting happens on the post page.
   */
  /**
   * Paid and suggested posts, which we should not comment on.
   *
   * The feed mixes them in and an ad reads exactly like a friend's photo apart
   * from one line of label. Commenting on a brand's ad spends the budget on
   * nobody, and "Suggested for you" is not our audience either.
   */
  const SPONSORED = [/^sponsorowane$/i, /^sponsored$/i, /^partnerstwo p[lł]atne\b/i, /^paid partnership\b/i];
  const SUGGESTED = [/^propozycje dla ciebie$/i, /^suggested for you$/i, /^sugerowane\b/i, /^suggested post$/i];

  /**
   * Every short LEAF of the post — one of them is Instagram's own label.
   *
   * Instagram writes "Sponsorowane" / "Propozycje dla Ciebie" into a <span> of
   * its own, so the label is matched WHOLE against that span and can never
   * collide with prose. Two earlier attempts read it out of concatenated text
   * and both failed on real posts:
   *
   *  - the first 120 characters of the article, which sounds like the header
   *    and is not: the text runs author → controls → likes → caption, and the
   *    caption starts near character 110, so a post captioned "i hate
   *    sponsored content on here lately" was skipped as an ad;
   *  - climbing five levels from the author link, which assumes a fixed depth:
   *    the handle sits inside EIGHT single-purpose wrappers on some posts and
   *    fewer on others, so the climb stopped inside the handle and a real
   *    "Propozycje dla Ciebie" post was read as organic and left commentable.
   */
  function feedLabels(art) {
    const out = [];
    for (const el of art.querySelectorAll("span, div, a, h1, h2, h3")) {
      if (el.children.length) continue; // leaves only: no concatenated text
      const text = norm(el.textContent);
      if (text && text.length <= 60) out.push(text);
    }
    return out;
  }

  function readFeed(limit = 12, opts = {}) {
    const { skipSponsored = true } = opts;
    const out = [];
    const seen = new Set();
    for (const art of document.querySelectorAll("article")) {
      const labels = feedLabels(art);
      const sponsored = labels.some((t) => SPONSORED.some((re) => re.test(t)));
      if (skipSponsored && sponsored) continue;
      // Suggested is unconditional: we comment on posts from people we follow,
      // and nothing labelled "Propozycje dla Ciebie" is that.
      if (labels.some((t) => SUGGESTED.some((re) => re.test(t)))) continue;

      const link = [...art.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
        .map((a) => a.getAttribute("href"))
        .find((h) => /\/(p|reel)\/[^/]+/.test(h));
      if (!link) continue;
      const code = link.match(/\/(?:p|reel)\/([^/]+)/)?.[1];
      if (!code || seen.has(code)) continue;

      const author = [...art.querySelectorAll('a[href^="/"]')]
        .map((a) => a.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/$/)?.[1])
        .find((h) => h && !ROUTES.has(h.toLowerCase()));

      seen.add(code);
      out.push({ code, url: `https://www.instagram.com/p/${code}/`, author: author ?? null, sponsored });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * The posts on a PROFILE page.
   *
   * `readFeed` cannot do this: it walks `<article>` elements, and a profile grid
   * has none — measured on a real profile, 52 posts and 8+ visible `/p/` links
   * under ZERO articles. That is why the "followers" comment source produced no
   * candidates and said nothing about it.
   *
   * The grid is in DOM order, newest first. Its links carry the owner's handle
   * (`/lead_handle/p/<code>/`), so the code comes from the `/p/` or `/reel/` segment
   * and never from the first path segment. Nothing here is filtered as an ad:
   * every post on a profile belongs to that profile.
   */
  function readProfilePosts(limit = 12) {
    const root = document.querySelector("main") ?? document.body;
    const owner = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\//)?.[1] ?? null;
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const code = (a.getAttribute("href") ?? "").match(/\/(?:p|reel)\/([^/]+)/)?.[1];
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        url: `https://www.instagram.com/p/${code}/`,
        author: owner && !ROUTES.has(owner.toLowerCase()) ? owner : null,
        sponsored: false,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * The post on screen: who wrote it, what it says, and its pictures.
   *
   * The caption comes from `og:description`, not the rendered DOM. That meta
   * tag is written in ENGLISH regardless of the interface language
   * (`19 likes, 1 comments - author – date: "caption".`), so parsing it does
   * not break the moment the account switches locale — unlike scraping the
   * caption out of a layout that also contains suggested posts and comments.
   */
  function readPost() {
    const code = postCode();
    if (!code) return { ok: false, reason: "not_on_post" };

    const og = document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? "";
    const caption = og.match(/:\s*"([\s\S]*)"\.?\s*$/)?.[1] ?? "";
    const author =
      og.match(/-\s*([A-Za-z0-9._]{1,30})\s*[–-]/)?.[1] ??
      [...document.querySelectorAll('a[href^="/"]')]
        .map((a) => a.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/$/)?.[1])
        .find((h) => h && !ROUTES.has(h.toLowerCase())) ??
      null;

    // The post's own media, by DISPLAYED size — a post page also renders a
    // "more posts from…" grid, whose thumbnails are large naturally but small
    // on screen.
    const images = [...document.querySelectorAll("img")]
      .filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 280 && r.height > 200;
      })
      .map((i) => i.currentSrc || i.src)
      .filter(Boolean);

    return {
      ok: true,
      code,
      postRef: postRef(code),
      author,
      caption,
      imageUrls: [...new Set(images)].slice(0, 4),
      alreadyCommented: ourCommentPresent(),
    };
  }

  /** Have we already commented here? Cheap guard against commenting twice. */
  function ourCommentPresent(ownHandle) {
    if (!ownHandle) return null;
    const links = [...document.querySelectorAll('a[href^="/"]')]
      .map((a) => a.getAttribute("href"))
      .filter((h) => h === `/${ownHandle}/`);
    // Our own handle appears once in the nav; more than that means we are in
    // the comment list too.
    return links.length > 1;
  }

  function commentBox() {
    return (
      document.querySelector('textarea[aria-label*="koment" i]') ??
      document.querySelector('textarea[aria-label*="comment" i]') ??
      document.querySelector("textarea")
    );
  }

  /**
   * Instagram's "post this comment" control.
   *
   * Matching /post/i is a TRAP: the same row carries **Repostuj** (Repost),
   * which contains "post" and shares the creator's content to our own account.
   * So the match is whole-label and exact, and anything resembling repost or
   * share is excluded outright before matching.
   *
   * Like Send in a DM, it only appears once the box has text.
   */
  const COMMENT_SUBMIT = [/^opublikuj$/i, /^post$/i, /^publish$/i];
  const COMMENT_NOT_SUBMIT = [/repost/i, /udost[eę]pnij/i, /share/i, /zapisz/i, /save/i];

  function commentSubmit() {
    const scope = document.querySelector("article") ?? document;
    const hits = [];
    for (const b of scope.querySelectorAll('div[role="button"], button')) {
      if (b.offsetParent === null) continue;
      const label = norm(b.getAttribute("aria-label") || b.textContent);
      if (!label || label.length > 24) continue;
      if (COMMENT_NOT_SUBMIT.some((re) => re.test(label))) continue;
      if (COMMENT_SUBMIT.some((re) => re.test(label))) hits.push({ el: b, label });
    }
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * Put a comment on the post and confirm it landed.
   *
   * The box is a real <textarea>, not the DM's Lexical editor, so it needs the
   * NATIVE value setter plus an input event — assigning `.value` directly
   * leaves React's state empty and the Post button never appears.
   */
  async function postComment(text) {
    if (!postCode()) return { ok: false, reason: "not on a post page" };
    const ta = commentBox();
    if (!ta) return { ok: false, reason: "no comment box (comments may be off for this post)" };
    if (!text) return { ok: false, reason: "refusing to post an empty comment" };

    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));

    let submit = null;
    for (let i = 0; i < 30 && !submit; i += 1) {
      await sleep(200);
      submit = commentSubmit();
    }
    if (!submit) return { ok: false, reason: "the Post control never appeared" };

    submit.el.click();

    // The oracle is the page: our words have to show up in the comment list.
    const needle = text.slice(0, 30);
    for (let i = 0; i < 50; i += 1) {
      await sleep(200);
      if (norm(document.body.innerText).includes(needle)) {
        return { ok: true, via: submit.label, box: norm(ta.value) };
      }
    }
    return { ok: false, reason: "comment not visible on the post after posting" };
  }

  // ── replies under our comments ─────────────────────────────────────────────

  /**
   * A comment's own id, read off the permalink Instagram wraps its TIMESTAMP in.
   *
   * This is the one place on Instagram where a comment has a stable identity in
   * the DOM: `<a href="/p/<code>/c/<commentId>/"><time datetime=…></a>`. Measured
   * 2026-09-09 on a live post — every comment and every threaded reply carried
   * one, and the post CAPTION's own `<time>` is not wrapped in such a link,
   * which is what keeps the caption out of the comment list for free.
   *
   * Everything downstream depends on it. Without an id, "have we answered this
   * reply?" has to be keyed on the reply's TEXT, and two people saying "😍" under
   * the same comment are then one reply — so one of them never gets an answer.
   */
  const COMMENT_ID = /\/(?:p|reel)\/[^/]+\/c\/(\d+)/;

  /** How many `<ul>` ancestors an element has. */
  function ulDepth(el) {
    let n = 0;
    for (let e = el; e; e = e.parentElement) if (e.tagName === "UL") n += 1;
    return n;
  }

  /**
   * Every comment on the post, in DOM order, top-level and threaded alike.
   *
   * NESTING IS READ FROM `<ul>` CONTAINMENT, not from indentation and not from a
   * depth count. Measured on a live post: the top-level comment list is NOT a
   * `<ul>`, and each expanded reply group IS one — so `ulDepth > 0` means "this
   * is a reply", exactly, whatever the layout does. The visual indent agrees
   * (a reply's author sits 44px right of a top-level author) and is reported as
   * `indentX` so a future break is visible in the probe rather than silent.
   *
   * Climbing a fixed number of levels was rejected outright: the same mistake
   * cost a debugging cycle on the feed's ad labels, where the author handle
   * turned out to sit inside eight single-purpose wrappers on some posts and
   * fewer on others.
   */
  /**
   * Each comment as {id, author, block, time}, in DOM order.
   *
   * The block is grown from the timestamp OUTWARDS until it holds the author's
   * handle and the comment's words — the smallest ancestor carrying handle and
   * time holds no text at all, which is what made the first version report
   * every comment as empty. The growth is bounded by a hard rule rather than a
   * level count: **stop before an ancestor contains a second comment's id**,
   * because that is exactly the point at which one comment's words become two.
   */
  function commentBlocks() {
    const out = [];
    for (const time of document.querySelectorAll("time")) {
      const link = time.closest("a");
      const id = link?.getAttribute("href")?.match(COMMENT_ID)?.[1];
      if (!id) continue; // the caption's timestamp, or a post link

      let best = null;
      for (let el = link.parentElement, i = 0; el && i < 14; el = el.parentElement, i += 1) {
        const ids = [...el.querySelectorAll("a[href]")].filter((a) =>
          COMMENT_ID.test(a.getAttribute("href") ?? ""),
        );
        if (ids.length > 1) break; // one level too far: the next comment is in
        const named = [...el.querySelectorAll('a[href^="/"]')].find((a) => {
          const h = a.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/$/)?.[1];
          return h && !ROUTES.has(h.toLowerCase()) && norm(a.innerText) === h;
        });
        if (!named) continue;
        const author = named.getAttribute("href").slice(1, -1);
        best = { id, author, block: el, time, text: commentText(el, author, time) };
        if (best.text) break; // words found: no reason to grow further
      }
      if (best) out.push(best);
    }
    return out;
  }

  function readComments() {
    const out = [];
    let lastTopLevel = null;
    for (const { id, author, block, time, text } of commentBlocks()) {
      const isReply = ulDepth(block) > 0;
      out.push({
        id,
        author,
        text,
        at: time.getAttribute("datetime") ?? null,
        isReply,
        // A reply's parent is the top-level comment it is nested inside, which
        // in DOM order is always the last one we passed.
        replyTo: isReply ? lastTopLevel : null,
        indentX: Math.round(block.getBoundingClientRect().x),
      });
      if (!isReply) lastTopLevel = id;
    }
    return out;
  }

  /**
   * A comment's words, with the furniture removed.
   *
   * Taken by EXCLUSION rather than by picking the longest span: a one-word
   * comment is shorter than the handle above it, so "longest" answers with the
   * handle and the character then replies to somebody's username.
   */
  function commentText(block, author, timeEl) {
    const spans = [...block.querySelectorAll('span[dir="auto"]')].filter(
      (s) =>
        !s.contains(timeEl) &&
        norm(s.innerText) !== author &&
        !s.querySelector(`a[href="/${author}/"]`),
    );
    // Innermost only — a nested pair would count the same words twice.
    const inner = spans.filter((s) => !spans.some((o) => o !== s && s.contains(o)));
    return norm(inner.map((s) => s.innerText).join(" "));
  }

  /**
   * "View all N replies" — the control that mounts a comment's replies.
   *
   * Replies are NOT in the DOM until this is pressed, so a reader that skips it
   * reports every thread as unanswered-and-empty, which is indistinguishable
   * from nobody having replied. Matched as a leaf carrying BOTH a digit and a
   * reply-word, which separates it from the two neighbours that would otherwise
   * collide: the bare "Odpowiedz" / "Reply" button on every comment (no digit)
   * and "Ukryj wszystkie odpowiedzi" / "Hide all replies" (no digit either, and
   * pressing it would UNDO the expansion).
   */
  const REPLY_WORD = /odpowied|repl/i;

  function replyExpanders() {
    const out = [];
    for (const el of document.querySelectorAll("span, div")) {
      if (el.children.length) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 60) continue;
      if (!REPLY_WORD.test(t) || !/\d/.test(t)) continue;
      if (!el.getBoundingClientRect().width) continue;
      out.push(el.closest('[role="button"], button') ?? el);
    }
    return out;
  }

  async function expandReplies({ rounds = 6 } = {}) {
    let pressed = 0;
    for (let i = 0; i < rounds; i += 1) {
      const buttons = replyExpanders();
      if (!buttons.length) break;
      for (const b of buttons) b.click();
      pressed += buttons.length;
      await sleep(1200);
    }
    return pressed;
  }

  /**
   * The Reply control belonging to one comment.
   *
   * The button is NOT inside the comment's own block — likes / Reply / translate
   * sit in a sibling row one level up — so this climbs until exactly ONE reply
   * control is in scope. One level further up and a comment's own thread is
   * included too, which means two Reply buttons and no way to tell whose is
   * whose; that ambiguity is refused rather than guessed.
   */
  const REPLY_BUTTON = [/^odpowiedz$/i, /^reply$/i, /^responder$/i, /^répondre$/i, /^antworten$/i];

  function replyButtonFor(block) {
    for (let el = block, i = 0; el && i < 6; el = el.parentElement, i += 1) {
      const hits = [];
      for (const leaf of el.querySelectorAll("span, div, button")) {
        if (leaf.children.length) continue;
        const t = norm(leaf.textContent);
        if (!t || !REPLY_BUTTON.some((re) => re.test(t))) continue;
        if (!leaf.getBoundingClientRect().width) continue;
        hits.push(leaf.closest('[role="button"], button') ?? leaf);
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null; // ambiguous: this level holds a thread
    }
    return null;
  }

  /** The block of one comment, found by its id. */
  function commentBlockById(id) {
    return commentBlocks().find((c) => c.id === id)?.block ?? null;
  }

  /**
   * Replies under OUR comments that somebody else wrote.
   *
   * Expands every thread first, then keeps the replies whose parent is a
   * top-level comment of ours. Our own replies are returned with `mine: true`
   * rather than dropped — the caller needs them to know a reply has already been
   * answered, and hiding them here would make "we already spoke" invisible.
   */
  async function readCommentReplies(ownHandle) {
    const code = postCode();
    if (!code) return { ok: false, reason: "not_on_post" };
    if (!ownHandle) return { ok: false, reason: "own_handle_unknown" };

    const expanded = await expandReplies();
    const all = readComments();
    const ours = new Set(all.filter((c) => !c.isReply && c.author === ownHandle).map((c) => c.id));

    return {
      ok: true,
      code,
      postRef: postRef(code),
      expanded,
      comments: all.length,
      ourComments: [...ours],
      replies: all
        .filter((c) => c.isReply && ours.has(c.replyTo))
        .map((c) => ({
          ...c,
          mine: c.author === ownHandle,
          // Answering the same public reply twice is the failure this exists to
          // prevent, and the worker's own "already answered" list cannot prevent
          // it alone: an MV3 worker is killed when idle, so a crash between
          // posting and recording loses the fact. The PAGE still knows — our
          // reply is in the same thread, it is newer, and it opens with their
          // @mention because that is what Instagram's Reply prefills. That is
          // recoverable evidence; a list in storage is not.
          answeredOnPage: all.some(
            (r) =>
              r.author === ownHandle &&
              r.isReply &&
              r.replyTo === c.replyTo &&
              r.at > c.at &&
              new RegExp(`@${c.author}\\b`, "i").test(r.text),
          ),
        })),
    };
  }

  /**
   * Instagram's notification list, read as "posts worth opening".
   *
   * This is the answer to "how do we know somebody replied without opening
   * every post we ever commented on". `/notifications/` (which is where
   * `/accounts/activity/` redirects) lists replies, likes and follows in one
   * page, and it reaches back further than our own record of what we commented
   * on — measured 2026-09-09 it surfaced a reply on a post the extension had
   * never recorded, which the post-by-post scan could not have found at all.
   *
   * It is an INDEX, not the truth. A row carries the post's permalink but no
   * comment id, so nothing here decides what gets answered; it decides which
   * page to open, and `readCommentReplies` on that page decides the rest. That
   * split is deliberate — a misread row costs one page visit, whereas trusting
   * a row would mean replying to text scraped out of a notification.
   *
   * Two matching rules, and both avoid reading Instagram's PROSE. The account's
   * interface language is not ours to choose (this one is Polish: "Użytkownik
   * lead_handle odpowiedział na Twój komentarz…"), and matching an English word is
   * not a selector — that mistake already cost a debugging cycle on the DM Send
   * button. So: a row is a notification because it links to a POST, and it is a
   * reply to us because it links to OUR OWN handle — Instagram's Reply prefills
   * "@us", so their reply renders our handle as a mention. A "likes your
   * comment" row quotes our comment as plain text and carries no such link.
   */
  const NOTIFICATIONS_PATH = /^\/notifications\/?$/;

  function readNotifications(ownHandle, limit = 30) {
    if (!NOTIFICATIONS_PATH.test(location.pathname)) return { ok: false, reason: "not_on_notifications" };
    if (!ownHandle) return { ok: false, reason: "own_handle_unknown" };

    const rows = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const code = (a.getAttribute("href") ?? "").match(/\/(?:p|reel)\/([^/]+)/)?.[1];
      if (!code || !a.getBoundingClientRect().width) continue;

      // The row: the smallest ancestor carrying the sentence, not just the link.
      let row = null;
      for (let el = a; el && !row; el = el.parentElement) {
        if (norm(el.innerText).length > 40) row = el;
      }
      if (!row || seen.has(row)) continue;
      seen.add(row);

      const profiles = [...row.querySelectorAll('a[href^="/"]')]
        .map((x) => x.getAttribute("href").match(/^\/([A-Za-z0-9._]{1,30})\/$/)?.[1])
        .filter((h) => h && !ROUTES.has(h.toLowerCase()));
      // The actor is named first — every one of these sentences opens with who
      // did it, in every language, so the first profile link that is not ours
      // is them.
      const who = profiles.find((h) => h !== ownHandle) ?? null;

      rows.push({
        code,
        who,
        text: norm(row.innerText).slice(0, 200),
        // A reply to us renders our handle as a mention; a like does not.
        repliedToUs: profiles.includes(ownHandle),
      });
      if (rows.length >= limit) break;
    }

    return {
      ok: true,
      rows,
      // Told apart on purpose: an empty list means nothing new, while an
      // unreadable page means the markup moved. Falling back to re-opening
      // every commented post on "nothing new" would reopen them for ever.
      readable: rows.length > 0 || document.querySelectorAll("li").length > 0,
    };
  }

  /**
   * Post a threaded reply to one comment, and confirm it landed as a reply.
   *
   * Pressing "Odpowiedz" is what makes the comment box a REPLY box — Instagram
   * holds the thread in its own state, and the `@handle ` it prefills is the
   * only visible trace of it. So this refuses to post unless that prefill
   * arrives: with an empty box the same Publish click posts a brand-new
   * TOP-LEVEL comment on somebody's post, publicly, addressed to nobody.
   *
   * The prefill is also kept, not overwritten. `postComment` sets the value
   * wholesale through the native setter, which is right for a fresh comment and
   * would erase the mention here.
   */
  async function postCommentReply({ commentId, text, ownHandle }) {
    if (!postCode()) return { ok: false, reason: "not on a post page" };
    if (!text) return { ok: false, reason: "refusing to post an empty reply" };

    const before = readComments();
    const target = before.find((c) => c.id === commentId);
    if (!target) return { ok: false, reason: `comment ${commentId} is not on screen` };
    // Replying to a reply lands under the same top-level comment, so that is
    // the parent to expect back — not the reply we answered.
    const expectParent = target.replyTo ?? target.id;

    const block = commentBlockById(commentId);
    if (!block) return { ok: false, reason: "lost the comment's block" };
    const button = replyButtonFor(block);
    if (!button) return { ok: false, reason: "no unambiguous Reply control for that comment" };

    button.click();

    const ta = () => commentBox();
    let prefill = "";
    for (let i = 0; i < 25; i += 1) {
      await sleep(200);
      const v = ta()?.value ?? "";
      if (v.trim().startsWith("@")) {
        prefill = v;
        break;
      }
    }
    if (!prefill) {
      return { ok: false, reason: "Reply did not arm the composer (no @mention prefill) — refusing to post a top-level comment instead" };
    }
    // WHOSE reply did we arm? "starts with @" is not enough: the Reply controls
    // of a comment and of the replies beneath it sit 44px apart in one column,
    // so picking the wrong one prefills a different handle — including OUR OWN,
    // when the control belongs to our top-level comment. That posts a public
    // reply addressed to ourselves under a stranger's photo, and it reads
    // exactly like a bot. The prefill has to name the person we meant.
    if (!new RegExp(`^@${target.author}\\b`, "i").test(prefill.trim())) {
      return {
        ok: false,
        reason: `Reply armed the composer for “${prefill.trim()}”, not @${target.author} — refusing to answer the wrong person`,
      };
    }

    // One mention, at the front, in Instagram's own form. FluidTalk's reply
    // often opens with "@them" itself, and two mentions read as a bot.
    const body = String(text).replace(new RegExp(`^\\s*@${target.author}\\b[,\\s]*`, "i"), "");

    // TYPED, not assigned. `postComment` sets the value wholesale through the
    // native setter, which is correct for a fresh comment and wrong here:
    // measured 2026-09-09, a reply written that way was posted as a brand-new
    // TOP-LEVEL comment that merely began with "@them" — Instagram keeps the
    // thread it is replying to in its own state, and replacing the value drops
    // it. `execCommand("insertText")` appends the way a keystroke does, leaving
    // that state intact; it is the same reason the DM composer cannot be
    // written to by assignment either.
    const box = ta();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    document.execCommand("insertText", false, body);
    if (!box.value.startsWith(prefill.trim())) {
      return { ok: false, reason: "typing the reply cleared the @mention — refusing to post" };
    }

    let submit = null;
    for (let i = 0; i < 30 && !submit; i += 1) {
      await sleep(200);
      submit = commentSubmit();
    }
    if (!submit) return { ok: false, reason: "the Post control never appeared" };

    // Tell the page-world patch which comment this is, so it can undo the
    // rounding Instagram's own client applies to the id (see
    // instagram-mainworld.js). Without it the reply is filed as a top-level
    // comment, which is what the reload check below would then report.
    let repaired = null;
    const onRepair = (ev) => {
      if (ev.source === window && ev.data?.source === "fluidextension-page" && ev.data.kind === "reply-target-repaired") {
        repaired = { from: ev.data.from, to: ev.data.to };
      }
    };
    window.addEventListener("message", onRepair);
    window.postMessage({ source: "fluidextension", kind: "reply-target", id: commentId }, "*");
    await sleep(50);

    submit.el.click();

    // The oracle is the page: our words have to come back as a REPLY, nested
    // under the expected parent and authored by us. Text appearing "somewhere
    // on the post" would also match a top-level comment we did not mean to
    // write.
    //
    // THIS IS NOT PROOF ON ITS OWN, and saying so is the point. Instagram
    // renders a just-posted comment optimistically INSIDE the thread you were
    // replying to, so this check passed for a comment that a reload then showed
    // as top-level. `needsReloadCheck` is why the caller reloads the post and
    // reads it back — the same rule as everywhere else here: confirm from the
    // system that stores it, not from the screen that just drew it.
    const needle = body.slice(0, 24) || prefill.trim();
    for (let i = 0; i < 60; i += 1) {
      await sleep(300);
      const mine = readComments().find(
        (c) => c.isReply && c.replyTo === expectParent && c.author === ownHandle && c.text.includes(needle),
      );
      if (mine) {
        window.removeEventListener("message", onRepair);
        return {
          ok: true,
          id: mine.id,
          replyTo: expectParent,
          text: mine.text,
          mention: prefill.trim(),
          // null here means the page sent an id we did not recognise as this
          // comment's rounded form — the reply will have landed top-level, and
          // the caller's reload check is what will say so.
          repaired,
          needsReloadCheck: true,
          needle,
        };
      }
    }
    window.removeEventListener("message", onRepair);
    // Say what the page looked like when it did not work. "Not visible after
    // posting" covers three very different things — the submit did nothing, it
    // posted somewhere else, or the read broke — and without these fields the
    // next person has to reproduce it live to tell them apart.
    return {
      ok: false,
      reason: "the reply is not visible as a threaded reply after posting",
      expectParent,
      submitLabel: submit.label,
      repaired,
      composerAfter: norm(ta()?.value ?? ""),
      sentText: `${prefill}${body}`.slice(0, 80),
      onPage: readComments()
        .filter((c) => c.author === ownHandle)
        .map((c) => ({ id: c.id, isReply: c.isReply, replyTo: c.replyTo, text: c.text.slice(0, 40) })),
    };
  }

  // ── diagnostics ────────────────────────────────────────────────────────────

  /**
   * What each selector matched, for the side panel's Diagnose button.
   *
   * When Instagram changes its markup every read here returns empty, which is
   * indistinguishable from an empty conversation. This says WHICH step went
   * blind.
   */
  function probe(ownHandle) {
    const col = conversationColumn();
    const msgs = readMessages();
    return {
      url: location.href,
      threadId: threadId(),
      handle: readHandle(ownHandle),
      columnFound: Boolean(col),
      column: col && { left: Math.round(col.left), right: Math.round(col.right) },
      messagesParsed: msgs.length,
      incoming: msgs.filter((m) => m.side === "in").length,
      outgoing: msgs.filter((m) => m.side === "out").length,
      composerFound: Boolean(composer()),
      // What the composer currently holds, so "typed but not sent" is visible.
      composerText: composer() ? norm(composer().innerText) : null,
      lastMessage: msgs[msgs.length - 1] ?? null,
      tail: msgs.slice(-4),
    };
  }

  // ── new-message watch ──────────────────────────────────────────────────────

  /**
   * Tell the background when the thread gains a new inbound message.
   *
   * Debounced because one arriving message mutates the grid many times (bubble,
   * timestamp, read receipt, avatar), and each mutation would otherwise be a
   * separate turn — i.e. several replies to one message.
   */
  let watchTimer = null;
  let lastSeen = "";

  function startWatch() {
    const observer = new MutationObserver(() => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const thread = readThread();
        if (!thread.ok) return;
        const key = `${thread.threadId}:${thread.messages.length}:${
          thread.lastInbound?.text ?? ""
        }`;
        if (key === lastSeen) return;
        lastSeen = key;
        chrome.runtime.sendMessage({ type: "ft:thread-changed", thread }).catch(() => {
          // No receiver while the panel is closed and the worker is asleep.
          // Dropping it is correct: the panel re-reads on open.
        });
      }, 700);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    (async () => {
      try {
        switch (msg?.type) {
          // ownHandle comes from settings, held by the worker: the page cannot
          // know which account it is without it, and our own profile link is
          // in the nav on every page waiting to be mistaken for the lead.
          case "ft:read":
            return respond({ ok: true, result: readThread(msg.ownHandle) });
          case "ft:probe":
            return respond({ ok: true, result: probe(msg.ownHandle) });
          case "ft:list-threads":
            return respond({ ok: true, result: listThreads(msg.ownHandle) });
          case "ft:open-followers":
            return respond({ ok: true, result: openFollowers(msg.ownHandle) });
          case "ft:list-followers":
            return respond({ ok: true, result: listFollowers() });
          case "ft:scroll-followers":
            return respond({ ok: true, result: scrollFollowers() });
          case "ft:open-dm":
            return respond({ ok: true, result: await openDm() });
          case "ft:open-thread":
            return respond({ ok: true, result: openThread(msg.label) });
          // Instagram works perfectly well in a hidden tab; the only thing
          // that stops it is not being signed in.
          case "ft:ready": {
            const me = readOwnHandle();
            return respond({ ok: true, result: me?.handle ? { ready: true } : { ready: false, why: "not signed in" } });
          }
          case "ft:whoami":
            return respond({ ok: true, result: readOwnHandle() });
          case "ft:where":
            return respond({ ok: true, result: { threadId: threadId(), url: location.href } });
          case "ft:accept-request":
            return respond({ ok: true, result: await acceptRequest({ dryRun: msg.dryRun }) });
          case "ft:type":
            typeIntoComposer(msg.text);
            return respond({ ok: true, result: { typed: true } });
          case "ft:send-bubble":
            return respond({ ok: true, result: await sendBubble(msg.text, msg.expectThreadId ?? null) });
          case "ft:send-photo":
            return respond({ ok: true, result: await sendPhoto(msg) });
          case "ft:media-bytes":
            return respond({ ok: true, result: await mediaBytes(msg.url) });
          case "ft:read-photos":
            return respond({ ok: true, result: readPhotos() });
          case "ft:read-feed":
            return respond({ ok: true, result: readFeed(msg.limit, msg) });
          case "ft:read-profile-posts":
            return respond({ ok: true, result: readProfilePosts(msg.limit) });
          case "ft:scroll-page": {
            // The FEED scrolls the window; the followers list scrolls a box
            // inside a dialog. Using the dialog scroller on the feed found no
            // dialog, moved nothing, and left us reading only the two or three
            // posts Instagram renders on first paint.
            const before = window.scrollY;
            window.scrollBy(0, msg.by ?? 900);
            return respond({ ok: true, result: { moved: window.scrollY !== before, y: window.scrollY } });
          }
          case "ft:read-post":
            return respond({
              ok: true,
              result: { ...readPost(), alreadyCommented: ourCommentPresent(msg.ownHandle) },
            });
          case "ft:post-comment":
            return respond({ ok: true, result: await postComment(msg.text) });
          case "ft:read-comments":
            return respond({ ok: true, result: readComments() });
          case "ft:read-notifications":
            return respond({ ok: true, result: readNotifications(msg.ownHandle, msg.limit) });
          case "ft:read-comment-replies":
            return respond({ ok: true, result: await readCommentReplies(msg.ownHandle) });
          case "ft:post-comment-reply":
            return respond({ ok: true, result: await postCommentReply(msg) });
          default:
            return respond({ ok: false, error: `unknown message ${msg?.type}` });
        }
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
    })();
    return true; // keep the channel open for the async respond
  });

  startWatch();
  console.debug("[FluidExtension] Instagram adapter ready");
})();
