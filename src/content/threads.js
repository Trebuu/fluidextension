/**
 * Threads adapter — the same `ft:*` contract the other three answer.
 *
 * EVERYTHING BELOW WAS MEASURED against a real signed-in account on
 * 2026-09-16, not inferred from Instagram. Threads is Meta's and looks like
 * Instagram, which is exactly why it is worth writing down where it is NOT:
 *
 *   - **A thread IS addressable.** `/messages/t/<id>/` opens a conversation
 *     from a cold load, no click on the list. That puts Threads with Instagram
 *     rather than WhatsApp, and it is the difference between a thread the
 *     worker can OPEN and one it can only hope it clicked.
 *   - **`threads.net` is gone.** It 301s to `threads.com`; the old domain as an
 *     origin lands the adapter on a page that immediately navigates away.
 *   - **A request has no composer at all.** Accept / Block / Delete and nothing
 *     to type into, so a reply into a request is not "blocked", it is
 *     impossible. That is why `readThread` reports `is_request`.
 *   - **The Send control does not exist until the composer is non-empty**, the
 *     same as Instagram — and its label is localised ("Wyślij" on this
 *     account), so it can only be found by position.
 *
 * THE UI IS LOCALISED. This account renders Polish. Nothing here matches an
 * English word: that mistake cost a debugging cycle on Instagram's Send button
 * and is not repeated.
 */
(() => {
  "use strict";

  const MAX_HISTORY = 40;
  const norm = (s) => (s ?? "").replace(/[\s ]+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── where are we ───────────────────────────────────────────────────────────

  /**
   * The open conversation's id, from the URL.
   *
   * `/messages/t/<digits>/`. Reading it from the address bar rather than from
   * the page is what makes an open self-verifying: `openThread` can refuse
   * unless the id actually CHANGED, which is the guard that stops a run
   * answering whoever was already on screen.
   */
  function threadRef() {
    const m = /^\/messages\/t\/(\d+)\/?/.exec(location.pathname);
    return m ? m[1] : null;
  }

  const onInbox = () => /^\/messages\/?$/.test(location.pathname);
  const onRequests = () => /^\/messages\/requests/.test(location.pathname);

  // ── the conversation list ──────────────────────────────────────────────────

  /** How far from the leftmost anchor still counts as the same rail. */
  const RAIL_SLOP_PX = 20;

  /**
   * The right edge of the left navigation, MEASURED rather than assumed.
   *
   * The nav's own links are the only fixed landmark on the page, and they are
   * addressable by href in every language. A hard-coded 235 was right on the
   * window it was written against and is a guess on any other — and the failure
   * is silent: the row filter simply matches nothing and the inbox reports
   * itself empty, which a run treats as "finished".
   */
  function navRight() {
    const rects = [...document.querySelectorAll('a[href="/"], a[href="/search"], a[href="/messages/"], a[href="/activity"]')]
      .map((a) => a.getBoundingClientRect())
      .filter((r) => r.width > 0);
    if (!rects.length) return 235;

    /**
     * ⚠ THE RAIL IS THE LEFTMOST STACK — NOT EVERY MATCH.
     *
     * The conversation list has its own "Messages" heading, and that heading is
     * ANOTHER `a[href="/messages/"]` sitting INSIDE the column this is supposed
     * to be bounding. Taking the furthest-right match therefore measures the
     * column, not the nav, and the bound lands to the RIGHT of the rows.
     *
     * Measured at innerWidth 857, where the rail collapses to icons: the rail
     * anchors are 54px wide at 7–61 and the heading is 112px at 123–235. The
     * old max() returned 235, every row starts at 101, so `left >= navRight()`
     * matched NOTHING — one real conversation, discarded, and the sweep logged
     * "sees 0 conversation(s) in the inbox" and called the cycle done. It does
     * not fail at a wide window because the expanded rail reaches past the
     * heading, which is why deriving the number was not enough on its own.
     *
     * The rail is a vertical stack, so its items share one left edge; the
     * heading is alone at its own. Take the cluster at the minimum left.
     */
    const minLeft = rects.reduce((m, r) => Math.min(m, r.left), Infinity);
    const rail = rects.filter((r) => r.left <= minLeft + RAIL_SLOP_PX);
    return rail.reduce((m, r) => Math.max(m, r.right), 0) || 235;
  }

  /**
   * The rows in the list column.
   *
   * A row is not a link, a listitem or a row — Threads ships none of those
   * roles here. What every row DOES have is a `role=link` ancestor within a
   * step or two, and that ancestor is also the thing that opens it. So the
   * clickable IS the row, which removes the "click the deepest node and walk
   * up" dance the Instagram adapter needs.
   *
   * Bounded to the list column by x, but both edges are DERIVED: the nav on the
   * left, the message pane on the right. Geometry rather than a class because
   * Threads ships obfuscated per-build class names like the rest of Meta's
   * estate — but geometry read off the page, not typed into it.
   */
  function conversationRows() {
    const left = navRight();
    const right = paneLeft();
    return [...document.querySelectorAll('[role="link"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 150 && r.height > 30 && r.height < 140 && r.left >= left && r.left < right;
    });
  }

  /**
   * A row's handle, if it shows one.
   *
   * ⚠ A ROW SHOWS A DISPLAY NAME, NOT A HANDLE — the same trap that made
   * Instagram's follow-ups miss everybody whose handle is not their name. The
   * only reliable identity is the thread id, which a row does not carry either.
   * So a row is addressed by the id it NAVIGATES to, discovered by opening it,
   * and `listThreads` reports the label for a human to read and the id for the
   * worker to act on.
   */
  function rowLabel(el) {
    return norm(el.innerText).split("\n")[0] ?? "";
  }

  function listThreads() {
    const rows = conversationRows();
    return rows.map((el, i) => ({
      // Threads' rows carry no id until opened, so the label is the index —
      // stable for the length of one pass, which is all `openThread` needs.
      label: String(i),
      title: rowLabel(el),
      /**
       * ⚠ WHAT THE WATCHER CALLS THIS ROW — without it, a wake can never be
       * narrowed to the rows that changed.
       *
       * `listSnapshot` keys rows by their FIRST LINE, the cycle matches a woken
       * row with `only.has(t.label) || only.has(t.peerId)`, and Threads' label
       * is the row's INDEX. So nothing ever matched: an unattended hour logged
       * `woken for 34 row(s) but none matched the inbox — sweeping all` over
       * and over. It fails safe — the whole inbox gets swept — but sweeping all
       * is precisely the re-open-everything traffic the wake path exists to
       * avoid, and that traffic is what rate-limits an account.
       */
      peerId: rowLabel(el),
      /**
       * ⚠ A REQUESTS ROW DOES CARRY AN ID, and that is the whole reason
       * `requests` looked impossible.
       *
       * In the inbox a row is an idless `[role=link]`. In /messages/requests it
       * is a real anchor: `/messages/t/1680011223344556/?inbox_override=requests`.
       * CLICKING it goes somewhere useless — that is the "`/<8 chars>/messages`
       * with no composer, no Accept and no thread id" this adapter gave up on —
       * but NAVIGATING to it lands on a working request: `ft:where` answers the
       * id, `ft:read` says `is_request`, and the Accept control is right there
       * next to Block and Delete. Measured on a live pending request.
       *
       * Handing the id up lets the worker navigate, which proves itself: the id
       * asked for is the id it must be on.
       */
      threadId: /\/messages\/t\/(\d+)/.exec(el.getAttribute?.("href") ?? el.querySelector?.('a[href*="/messages/t/"]')?.getAttribute("href") ?? "")?.[1] ?? null,
      unread: null,
      refusal: null,
    }));
  }

  /**
   * Open row `label` and confirm the conversation actually changed.
   *
   * A click Threads ignored looks exactly like one it accepted, and the cost of
   * getting it wrong is answering the wrong person — so this reads the thread
   * id back and refuses unless it moved.
   */
  async function openThread(label) {
    const before = threadRef();
    const rows = conversationRows();
    const row = rows[Number(label)];
    if (!row) return { ok: false, clicked: false, reason: "no such row" };

    row.click();
    for (let waited = 0; waited < 8000; waited += 250) {
      await sleep(250);
      const now = threadRef();
      /**
       * ⚠ `clicked` IS THE FIELD THE WORKER ACTUALLY READS.
       *
       * Three call sites do `if (!opened.clicked) continue;` — the inbox pass,
       * the targeted pass and the requests pass — and none of them looks at
       * `ok`. Returning only `{ok:true, threadId}` meant every one of them
       * skipped every conversation, so a Threads run would have opened the
       * inbox, listed it, and answered nobody, with nothing in the log to say
       * why. Found by reading the caller rather than the adapter.
       *
       * It is set true ONLY when the conversation really changed. Reporting a
       * click that opened nothing would send the worker on to read whatever
       * thread happens to be on screen — and answer that person instead.
       */
      if (now && now !== before) return { ok: true, clicked: true, threadId: now, ...(await settleThread(now)) };
    }
    return { ok: false, clicked: false, reason: "the conversation did not change" };
  }

  /**
   * ⚠ THE ADDRESS CHANGES BEFORE THE MESSAGES ARRIVE.
   *
   * The third time this exact shape has bitten — openPost had it with replies,
   * openFollowers with the people in the dialog. Returning on the id alone made
   * the very next `ft:read` answer `no_messages` on a conversation that plainly
   * had some, and the worker cannot tell that from a genuinely empty thread: it
   * would file the lead as having said nothing and move on.
   *
   * Waits for the bubble count to stop moving, capped — a thread really can be
   * empty, and a request has no bubbles at all.
   */
  async function settleThread() {
    let settled = 0;
    let last = -1;
    for (let waited = 0; waited < 8000; waited += 500) {
      await sleep(500);
      const n = bubbles().length;
      settled = n === last && n > 0 ? settled + 1 : 0;
      last = n;
      if (settled >= 1) return { messages: n };
    }
    return { messages: Math.max(0, last), settled: false };
  }

  // ── reading a conversation ─────────────────────────────────────────────────

  /**
   * The message pane's left edge, derived rather than assumed.
   *
   * The composer spans the pane, so its box IS the pane's geometry — which
   * survives a window resize and a collapsed nav, where a hard-coded 640 does
   * not. Falls back to the widest thing on the page when there is no composer
   * (a request thread has none).
   */
  function paneLeft() {
    const box = composer();
    if (box) return box.getBoundingClientRect().left - 120;
    // No composer (the inbox with nothing open, or a request): the list column
    // still has rows, and the far edge of the widest one is where the pane
    // begins. Derived from `role=link` directly rather than from
    // `conversationRows`, which asks THIS function for its bound.
    let edge = 0;
    for (const el of document.querySelectorAll('[role="link"]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 150 && r.height > 30 && r.height < 140 && r.left >= navRight()) edge = Math.max(edge, r.right);
    }
    return edge || Math.max(navRight() + 400, Math.min(640, window.innerWidth * 0.5));
  }

  /**
   * Which side a bubble is on, read from the CSS THAT PERFORMS THE ALIGNMENT.
   *
   * Every bubble sits in a flex wrapper two steps above its text span, and that
   * wrapper's `justify-content` is `flex-end` for ours and `flex-start` for
   * theirs. Measured on two live conversations, and the background agrees
   * independently every time (ours rgb(52,52,52), theirs rgb(24,24,24)) — the
   * colour is not used, because a palette is one redesign away from changing
   * and a layout rule is not.
   *
   * This is a POSITIVE, PER-BUBBLE fact. That is the whole point: the rule it
   * replaces compared a bubble to where the other bubbles happened to land, so
   * a thread could not be read one message at a time, and a thread with nothing
   * to compare against got an answer anyway. See `withSide`.
   *
   * Returns null when no flex ancestor within 8 steps resolves to a side, which
   * is the signal to fall back rather than guess. `justify-content` is reported
   * by `getComputedStyle` for non-flex elements too, where it means nothing, so
   * the display check is load-bearing.
   */
  const SIDE_BY_JUSTIFY = {
    "flex-end": "out",
    end: "out",
    right: "out",
    "flex-start": "in",
    start: "in",
    left: "in",
  };

  function alignedSide(el) {
    for (let n = el, i = 0; n && i < 8; n = n.parentElement, i += 1) {
      const s = getComputedStyle(n);
      if (s.display !== "flex" && s.display !== "inline-flex") continue;
      const side = SIDE_BY_JUSTIFY[s.justifyContent];
      if (side) return side;
    }
    return null;
  }

  /**
   * Message bubbles.
   *
   * ⚠ A BUBBLE IS NOT "ANY dir=auto SPAN IN THE PANE". The profile card at the
   * top of a conversation — display name, follower count, a Follow button — is
   * made of exactly those, and counting it as a message feeds the character a
   * line nobody wrote. Measured: a real bubble has an ancestor within two steps
   * carrying a non-transparent background; the profile card's is transparent
   * all the way up.
   */
  function bubbles() {
    const left = paneLeft();
    return [...document.querySelectorAll("span[dir=auto]")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        if (!norm(el.innerText) || r.left < left || r.width < 8) return null;
        let bg = null;
        for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) {
          const b = getComputedStyle(n).backgroundColor;
          if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") { bg = b; break; }
        }
        if (!bg) return null;
        return { el, rect: r, text: norm(el.innerText), align: alignedSide(el) };
      })
      .filter(Boolean)
      .sort((a, b) => a.rect.top - b.rect.top);
  }

  /**
   * The bubble column's edges, from a set of rects.
   *
   * Pulled out of `withSide` because photos have to be classified against the
   * SAME column as text — computing one column from bubbles and another from
   * images puts a photo and the message that came with it on opposite sides.
   */
  function columnEdges(rects) {
    if (!rects.length) return null;
    const right = Math.max(...rects.map((r) => r.right));
    const left = Math.min(...rects.map((r) => r.left));
    return { left, right, span: right - left };
  }

  /**
   * Which side of the column a rect sits on. See the warning on `withSide`:
   * "outgoing is right" is Instagram's rule, carried over and still unconfirmed
   * here by a real outgoing message.
   */
  /**
   * How far two edges may differ and still count as the same column edge.
   * Meta aligns these exactly; this only absorbs sub-pixel rounding.
   */
  const ALIGN_TOL_PX = 6;

  function sideFor(rect, edges) {
    if (!edges || edges.span <= 40) return "in";

    /**
     * ⚠ THE SHARE OF THE SPAN WAS THE WRONG MEASURE, AND IT FAILED ON LENGTH.
     *
     * The old rule wanted the right edge near the maximum AND the left edge
     * more than a quarter-span in from the minimum. The second half is a
     * statement about how WIDE a bubble is, not about which side it is on, so
     * the longer our own message the more likely it read as theirs. Measured
     * live on a real two-sided thread (window 857):
     *
     *     in   left=172  right=188..284      (six of them, one left edge)
     *     out  left=287..645  right=686      (four of them, one right edge)
     *
     * `edges.left=172, edges.right=686, span=514` put the old threshold at
     * left > 300 — so "lol i'm good! just thinking about what to shoot this
     * weekend" (left 287) was classified INCOMING. It is ours. Two things
     * follow, and both were live: it became `lastInbound`, so the character
     * was about to answer herself; and `sendBubble` could not find its own
     * text as an outgoing row, so a delivered message logged "bubble 1 did not
     * appear in the thread" and the run counted a success as a failure — the
     * same pair of symptoms Instagram produced when its column was bounded by
     * the composer.
     *
     * What is actually invariant is ALIGNMENT, not width: incoming bubbles all
     * share one LEFT edge, outgoing all share one RIGHT edge. Measured colours
     * agree independently (incoming rgb(24,24,24), outgoing rgb(52,52,52)) but
     * a palette is a theme away from changing, so alignment is what is used.
     *
     * The all-inbound case stays correct for free: the widest incoming bubble
     * defines `edges.right`, but it also sits ON `edges.left`, and a bubble at
     * both edges is not treated as ours.
     */
    const atRight = edges.right - rect.right <= ALIGN_TOL_PX;
    const atLeft = rect.left - edges.left <= ALIGN_TOL_PX;
    return atRight && !atLeft ? "out" : "in";
  }

  /**
   * Direction.
   *
   * ⚠ THE WARNING THAT USED TO BE HERE CAME TRUE, WORD FOR WORD. It read:
   * "CONFIRM THIS ON THE FIRST REAL SEND. If it is wrong, every message
   * classifies the same way and the character answers itself." It was wrong,
   * and she did — fifteen messages deep in one conversation before anybody
   * looked at the screen:
   *
   *     OUT hey! nice to meet you, where are you from?
   *     OUT hey! nice to meet you too :)
   *     OUT i'm from here in lisbon. hbu, where are you from?
   *     OUT lol wild, a local then! didn't expect that honestly
   *     OUT lol you sent that twice! it's okay, i get it ...
   *
   * The mechanism is worth stating exactly, because it is not "the rule is
   * approximate": `sideFor` is a statement about a bubble RELATIVE TO THE OTHER
   * BUBBLES, and in a thread where every message is ours they are all at the
   * right edge, so `edges.left` is set by the WIDEST of our own messages. That
   * one bubble then satisfies `atLeft`, and an all-outgoing thread yields
   * exactly one phantom inbound — reliably, every time, always the longest
   * message. The worker answers it, the answer changes the thread, the next
   * cycle finds another phantom, and it does not stop.
   *
   * The old comment noted the all-INBOUND case "stays correct for free" and
   * concluded the rule was safe. That was the wrong half: all-inbound is the
   * harmless direction. All-outgoing is the one that talks to strangers.
   *
   * So alignment is now read PER BUBBLE from the flex wrapper that performs it
   * (`alignedSide`), and the column comparison survives only as a fallback for
   * a bubble whose wrapper says nothing. Measured against both threads before
   * it was kept: the all-ours conversation goes from 14 out + 1 phantom to 15
   * out, and a genuinely two-sided one is classified identically to before —
   * zero disagreements, so this fixes the broken case without disturbing the
   * case that worked.
   */
  function withSide(list) {
    if (!list.length) return [];
    const edges = columnEdges(list.map((b) => b.rect));
    return list.map((b) => ({ ...b, side: b.align ?? sideFor(b.rect, edges) }));
  }

  function readThread() {
    const id = threadRef();
    if (!id) return { ok: false, reason: "not_on_thread" };

    // A REQUEST HAS NO COMPOSER, so a reply is impossible rather than merely
    // refused. Saying which lets the worker skip it cheaply instead of
    // generating a billed reply it could never deliver.
    if (!composer()) return { ok: false, reason: "is_request", threadId: id };

    const msgs = withSide(bubbles()).slice(-MAX_HISTORY).map((b) => ({ side: b.side, text: b.text }));
    if (!msgs.length) return { ok: false, reason: "no_messages", threadId: id };

    const lastInbound = [...msgs].reverse().find((m) => m.side === "in") ?? null;
    return { ok: true, threadId: id, handle: leadHandle(), messages: msgs, lastInbound };
  }

  /**
   * The lead's handle, from the conversation header.
   *
   * This was `null` — hard-coded, not a detection that failed — and the worker
   * throws `could not read the lead's handle from the thread header` on a falsy
   * one, so no Threads conversation could ever have been answered. It never
   * surfaced because the inbox filter discarded every row first, and a run that
   * sees no conversations never reaches a read.
   *
   * Unlike Instagram, Threads puts a real `/@handle` on the header, so there is
   * no display-name problem here. Two rules make it safe:
   *  - OURS IS EXCLUDED BY NAME, not only by position. The nav's profile link
   *    is ours and sits left of the column, but a lead's own profile card
   *    inside the thread is not, and "the first profile link that is not a
   *    route" is exactly what made Instagram answer itself.
   *  - MORE THAN ONE DISTINCT HANDLE MEANS A GROUP, so refuse rather than pick.
   *    Falling back to the worker's existing error is the right outcome: it
   *    stops the reply instead of sending one person's message to a room.
   */
  function leadHandle() {
    const ours = (readOwnHandle().handle ?? "").toLowerCase();
    const edge = navRight();
    const found = new Set();
    for (const a of document.querySelectorAll('a[href^="/@"]')) {
      const r = a.getBoundingClientRect();
      if (r.width <= 0 || r.right <= edge + 1) continue;
      const m = /^\/@([A-Za-z0-9._]+)/.exec(a.getAttribute("href") || "");
      if (m && m[1].toLowerCase() !== ours) found.add(m[1]);
    }
    return found.size === 1 ? [...found][0] : null;
  }

  // ── writing ────────────────────────────────────────────────────────────────

  const composer = () =>
    document.querySelector('[contenteditable="true"][data-lexical-editor="true"]') ??
    document.querySelector('[contenteditable="true"][role="textbox"]');

  /**
   * The Send control.
   *
   * ⚠ NOT BY LABEL. Its accessible name is localised — "Wyślij" on this
   * account — and matching an English word is not a selector. It is also not on
   * the button: the button is an unlabelled `div[role=button]` whose SVG CHILD
   * carries the label.
   *
   * What is stable is position and existence: it appears only once the composer
   * has text, and it sits immediately to the right of it on the same row. So
   * "the role=button to the right of the composer, vertically overlapping it"
   * identifies it in any language, and its absence is the honest signal that
   * the composer is still empty.
   */
  function sendButton() {
    const box = composer();
    if (!box) return null;
    const c = box.getBoundingClientRect();
    const cands = [...document.querySelectorAll('[role="button"]')].filter((b) => {
      const r = b.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.left >= c.right - 4 &&
        r.top < c.bottom + 40 &&
        r.bottom > c.top - 40 &&
        r.left - c.right < 200
      );
    });
    // Nearest to the composer, so a second control further right cannot win.
    cands.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return cands[0] ?? null;
  }

  /**
   * Type into the Lexical composer.
   *
   * Assigning `textContent` updates what you see and leaves Lexical's own model
   * empty — the Send control never appears and Enter sends nothing, silently.
   * `execCommand("insertText")` is deprecated and is the one path still
   * emitting the beforeinput/input pair Lexical commits on.
   *
   * ⚠ A READ TAKEN ON THE NEXT LINE SEES THE OLD CONTENT. Measured here:
   * insertText("x") then reading immediately returned the PREVIOUS value, and
   * the value after a clear was the text from before it. So anything that
   * checks what the composer holds has to yield first, which is why this
   * returns a promise rather than a boolean.
   */
  async function typeIntoComposer(text) {
    const box = composer();
    if (!box) return false;
    box.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    await sleep(60);
    return norm(box.innerText) === norm(text);
  }

  /**
   * Every clickable control on the composer's row, keyed by position and size.
   *
   * The key is geometric on purpose: the labels are localised and most of these
   * controls are unlabelled `div[role=button]`s whose SVG child carries the
   * name, so position is the only thing that identifies one across two reads.
   */
  /**
   * ⚠ THE ELEMENTS THEMSELVES, and only the ones on the composer's OWN ROW.
   *
   * This returned a map keyed by `left,top WxH`, and both halves of that were
   * wrong in the same failure. Measured on a live post, through the product:
   *
   *     pressed "Więcej" (of Więcej, Odpowiedz, Rozwiń edytor)
   *
   * "Więcej" is the post's ⋯ menu, up in the card header. It appeared in the
   * FRESH set because typing grows the composer by a line and everything below
   * shifts — so a position key identifies a control that MOVED as a control
   * that APPEARED. And it won "rightmost" because the ⋯ sits further right than
   * the publish button. The click opened a menu, the composer kept the text,
   * and the only symptom was a comment that never arrived.
   *
   * Node identity fixes the first half: a button that moved is the same button.
   * The row band fixes the second: the publish control is on the composer's own
   * row, and the card's furniture is not. The row is measured from the BOTTOM
   * edges, because a composer that has taken text is taller than an empty one
   * while its button row stays aligned with its bottom (measured: composer
   * bottom 325, button row bottom 333).
   */
  const ROW_TOL_PX = 80;
  function composerControls() {
    const box = composer();
    const out = [];
    if (!box) return out;
    const c = box.getBoundingClientRect();
    for (const b of document.querySelectorAll('[role="button"],button')) {
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (Math.abs(r.bottom - c.bottom) > ROW_TOL_PX) continue;
      if (r.right < c.left - 220 || r.left > c.right + 420) continue;
      out.push(b);
    }
    return out;
  }

  /**
   * Type, then find the control that PUBLISHES it.
   *
   * ⚠ NOT "the nearest control to the right of the composer". That rule holds
   * in a DM, where the attach and emoji buttons sit to the LEFT — and it is
   * wrong on a post page, where "add photo", "add GIF" and "add poll" sit
   * BETWEEN the composer and the publish control. Measured: composer right
   * edge 1459, attach buttons at 1471/1503/1535, publish at 1527. The nearest
   * control to the right is the photo picker, and clicking it is how
   * `ft:post-comment` reported "published" having published nothing — the
   * comment count never moved and the confirmation timed out.
   *
   * What actually identifies it, on both surfaces and in any language, is that
   * IT DOES NOT EXIST UNTIL THE COMPOSER HAS TEXT. So the controls are counted
   * while the box is empty and again once it is not, and the publish control is
   * the one that appeared. Where more than one appears (a post composer adds
   * two), the rightmost is taken — publish is the last thing on the row.
   */
  async function typeAndArm(text) {
    const box = composer();
    if (!box) return { ok: false, reason: "no composer" };

    await clearComposer();
    const before = new Set(composerControls());

    if (!(await typeIntoComposer(text))) return { ok: false, reason: "the composer did not take the text" };

    for (let waited = 0; waited < 8000; waited += 250) {
      await sleep(250);
      const fresh = composerControls().filter((el) => !before.has(el));
      if (!fresh.length) continue;
      fresh.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
      /**
       * SAY WHAT WAS PICKED. A publish that does nothing is indistinguishable
       * from a publish that pressed the wrong control — and this rule has
       * already been wrong once on a post page, where the photo picker sits
       * between the composer and the publish button. The label is only for the
       * log (it is localised, and nothing branches on it), but it turns "the
       * reply is not visible" into "it pressed Rozwiń edytor".
       */
      const label = (el) =>
        el.querySelector("svg[aria-label]")?.getAttribute("aria-label") ?? norm(el.innerText).slice(0, 24) ?? "?";
      return {
        ok: true,
        button: fresh[0],
        appeared: fresh.length,
        pressed: label(fresh[0]),
        candidates: fresh.map(label),
      };
    }
    return { ok: false, reason: "no control appeared when the composer took the text" };
  }

  /**
   * ⚠ THIS DOES NOT ACTUALLY EMPTY A LEXICAL EDITOR — measured on a live post
   * composer holding text: `selectAll`+`delete`, `selectAll`+`insertText("")`
   * and a real Range over the editor's contents followed by `insertText("")`
   * all left the text exactly where it was. Only leaving the page discards it.
   *
   * It is kept because it costs nothing and does empty the DM composer, and
   * because `publishComposer` now relies on the fact that WE cannot clear the
   * box: a composer that empties itself after a publish click is Threads
   * accepting the text, and that is the only unlocalised success signal there
   * is. Returns whether the box is empty, so a caller can tell.
   *
   * Nothing is protected by this returning false, because `typeIntoComposer`
   * verifies what the box holds AFTER typing — text appended to a leftover
   * draft fails that check rather than being published.
   */
  async function clearComposer() {
    const box = composer();
    if (!box) return false;
    box.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");
    await sleep(60);
    return !norm(box.innerText);
  }

  /**
   * Send one bubble, and confirm it against the THREAD rather than the click.
   *
   * `expectThreadId` is the guard against the conversation moving underneath a
   * queued send — the failure that let a reply reach the wrong lead on the
   * multiplatform build. A send into a thread that is no longer the one the
   * reply was written for is refused, not delivered.
   */
  async function sendBubble(text, expectThreadId = null) {
    const here = threadRef();
    if (!here) return { ok: false, reason: "not_on_thread" };
    if (expectThreadId && here !== expectThreadId) {
      return { ok: false, reason: "thread_changed_under_us", threadId: here };
    }
    if (!composer()) return { ok: false, reason: "is_request" };

    // Same rule as a post reply: the send control is the one that APPEARS when
    // the composer takes text, not the nearest one to its right. In a DM the
    // attach and emoji buttons happen to sit on the left, so "nearest to the
    // right" also worked here — but it silently picked the photo picker on a
    // post page, and one rule that is true on both surfaces is worth more than
    // two that are each true on one.
    /**
     * ⚠ AN EMPTY THREAD CANNOT CONFIRM BY DIRECTION, which is exactly the case
     * outreach is in.
     *
     * `sideFor` decides direction by comparing a bubble to the column's other
     * bubbles: incoming share a left edge, outgoing share a right one. With ONE
     * bubble on the page that bubble is at BOTH edges, and "a bubble at both
     * edges is not ours" makes it INCOMING. So the first message of any new
     * conversation is unconfirmable — measured on a real cold open: the DM was
     * delivered (`@a_lead` replied to it) while the run logged "bubble 1 did
     * not appear in the thread", so `markOutreached` never ran and the next
     * cycle would have cold-opened the same person again.
     *
     * Into an empty thread, direction is not needed and asking for it is the
     * bug: nobody else has said anything, so OUR TEXT BEING THERE AT ALL is the
     * delivery. The count is taken before the click so this cannot be satisfied
     * by something already on screen.
     */
    const before = bubbles();
    const wasEmpty = before.length === 0;

    const armed = await typeAndArm(text);
    if (!armed.ok) return armed;
    armed.button.click();

    // Delivery is confirmed by the text arriving as an OUTGOING bubble, never
    // by the click returning — a click Threads ignored looks identical to one
    // it accepted.
    for (let waited = 0; waited < 9000; waited += 300) {
      await sleep(300);
      if (threadRef() !== here) return { ok: false, reason: "thread_changed_during_send" };
      const now = bubbles();
      // Best evidence first: our text, on our side, on the page.
      const out = withSide(now).filter((b) => b.side === "out");
      if (!wasEmpty && out.some((b) => b.text === norm(text))) return { ok: true, threadId: here };
      if (wasEmpty && now.some((b) => b.text === norm(text))) {
        return { ok: true, threadId: here, via: "first message in an empty thread" };
      }
      /**
       * ⚠ THE COMPOSER CLEARING ITSELF IS EVIDENCE IN ANY THREAD, not just an
       * empty one.
       *
       * This fallback was scoped to empty threads on the assumption that
       * direction works everywhere else. It does not: an unattended run
       * reported `another.lead: sent 1/2` with the second bubble "not confirmed —
       * pressed 'Wyślij', composer is empty, 9 bubble(s) on screen". Pressed the
       * right control, Threads took the text, and `sideFor` still could not find
       * our own message among nine — which is the direction rule being shakier
       * than its comment claims (measured: at one width both sides share a right
       * edge AND a colour).
       *
       * An under-reported send is the expensive direction: the worker counts a
       * delivered message as failed and sends it again. The box cannot be
       * cleared by us — `clearComposer` is a no-op against Lexical — so an empty
       * box after a click is Threads having accepted it.
       *
       * Still second, so a thread that DOES render our bubble yields the
       * stronger answer and an id.
       */
      const box = composer();
      if (box && box.isConnected && !norm(box.innerText) && threadRef() === here) {
        return { ok: true, threadId: here, via: "composer cleared" };
      }
    }
    /**
     * Say WHAT WAS PRESSED and whether the box still holds the text — the same
     * telemetry the post composer needed. "not_visible_after_send" alone cannot
     * distinguish a send Threads accepted and never rendered, a click that hit
     * the wrong control, and a thread where our own bubble was misclassified as
     * theirs; those want three different fixes.
     */
    return {
      ok: false,
      reason: `not_visible_after_send — pressed "${armed.pressed ?? "?"}"${
        armed.candidates?.length > 1 ? ` (of ${armed.candidates.join(", ")})` : ""
      }, composer ${norm(composer()?.innerText ?? "") ? "still holds the text" : "is empty"}, ${
        wasEmpty ? "thread was empty" : `${bubbles().length} bubble(s) on screen`
      }`,
      threadId: here,
    };
  }

  // ── media ──────────────────────────────────────────────────────────────────

  const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  /**
   * An avatar, not a message.
   *
   * Threads labels every profile picture, and the label is localised — the
   * conversation on the test account renders "Zdjęcie profilowe … Threads".
   * Size alone does NOT separate them: the profile card at the head of a
   * conversation carries an 80×80 avatar, comfortably over any "a photo is
   * bigger than an avatar" threshold.
   */
  const AVATAR_ALT = /(profile[- ]picture|zdjęcie profilowe|foto de perfil|photo de profil|profilbild)/i;

  /**
   * The file input that attaches to a DM.
   *
   * Measured on `/messages/`: exactly ONE `input[type=file]`, already in the
   * DOM before the attach menu is ever opened, 0×0 and hidden, with
   * `accept="image/avif,image/jpeg,image/png,image/webp,video/mp4,
   * video/quicktime,video/…,image/gif"` and `multiple=false`. So the file can
   * be handed over directly and the menu never has to be driven.
   *
   * It is found by its ACCEPT list rather than by position, because a 0×0
   * element has no position to match on.
   */
  function composerFileInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter((i) =>
      /image\//i.test(i.getAttribute("accept") || ""),
    );
    // More than one means a second uploader mounted (a profile picture picker,
    // a post composer) and picking the wrong one puts the photo somewhere else
    // entirely. Prefer one that also takes video — the DM input does.
    if (inputs.length > 1) {
      const withVideo = inputs.filter((i) => /video\//i.test(i.getAttribute("accept") || ""));
      if (withVideo.length === 1) return withVideo[0];
      return null;
    }
    return inputs[0] ?? null;
  }

  /**
   * Photos rendered in the open conversation, by side. Avatars excluded.
   *
   * Classified against the same column as the text bubbles, so a photo and the
   * message that came with it cannot land on opposite sides.
   */
  function readPhotos() {
    const left = paneLeft();
    const shots = [];
    for (const im of document.querySelectorAll("img")) {
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      if (r.left < left) continue;
      if (AVATAR_ALT.test(im.getAttribute("alt") || "")) continue;
      shots.push({ el: im, rect: r, src: im.currentSrc || im.src });
    }
    if (!shots.length) return [];
    const edges = columnEdges([...bubbles().map((b) => b.rect), ...shots.map((s) => s.rect)]);
    // Same order of preference as `withSide`: the wrapper that aligns it first,
    // the column only when the wrapper says nothing.
    return shots.map((s) => ({ side: alignedSide(s.el) ?? sideFor(s.rect, edges), src: s.src }));
  }

  /**
   * The bytes behind one piece of media, read HERE because the worker cannot.
   *
   * A photo is an ordinary CDN url and is fetched. The host is
   * `*.cdninstagram.com` — Threads serves media off Instagram's CDN, which is
   * already in `host_permissions` for the Instagram adapter.
   *
   * ⚠ VIDEO IS NOT MAPPED. On Instagram a DM video is a MediaSource-backed
   * `blob:` that neither the worker nor the page can fetch, and the only path
   * is re-encoding the decoded element after pressing a play button found by a
   * selector that is Instagram's. No conversation on this account has ever
   * carried a video, so there is nothing here to measure that against. Rather
   * than click blindly at the middle of a bubble on a real conversation — which
   * on the wrong guess opens a profile, or a forward dialog — this refuses and
   * says so. A named refusal is recoverable; a wrong click is not.
   */
  async function mediaBytes(url) {
    if (!url) return { ok: false, reason: "no url" };

    const el = [...document.querySelectorAll("img,video")].find((n) => (n.currentSrc || n.src) === url);
    if (!el) return { ok: false, reason: "that media is no longer on screen" };

    if (el.tagName === "VIDEO") {
      const small = await window.__ftMedia.shrinkVideo(el, MAX_MEDIA_BYTES);
      if (small.ok) return { ...small, shrunkBecause: "a Threads DM video has no downloadable file" };
      const frame = await window.__ftMedia.captureVideoFrame(el, "video");
      return frame.ok ? { ...frame, fellBackBecause: small.reason } : frame;
    }

    if (/^blob:/.test(url)) {
      return { ok: false, reason: "Threads DM video is not mapped yet — no sample has ever existed on this account" };
    }

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

  /**
   * Attach a photo and send it.
   *
   * Confirmed against the THREAD, like text: the count of outgoing photos has
   * to grow. The attachment preview appears the moment the file is accepted, so
   * reporting success there would claim a delivery still in flight.
   *
   * ⚠ NEVER EXERCISED END TO END. The account has no conversation to send a
   * photo into that would not be an unsolicited message to a stranger. The
   * input, its accept list and the send control are all measured; the sequence
   * is Instagram's, which is the same company's uploader. First real send is
   * the thing to watch.
   */
  async function sendPhoto({ dataB64, filename, mime }) {
    const here = threadRef();
    if (!here) return { ok: false, reason: "not_on_thread" };
    if (!composer()) return { ok: false, reason: "is_request" };
    const input = composerFileInput();
    if (!input) return { ok: false, reason: "no file input for the composer" };

    const before = readPhotos().filter((p) => p.side === "out").length;

    const bin = atob(dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename || "photo.png", { type: mime || "image/png" });

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // Nothing can be sent until the preview exists.
    let armed = false;
    for (let i = 0; i < 50 && !armed; i += 1) {
      await sleep(200);
      armed = Boolean(sendButton()) || readPhotos().filter((p) => p.side === "out").length > before;
    }
    if (!armed) return { ok: false, reason: "the photo never appeared in the composer" };

    const btn = sendButton();
    if (btn) btn.click();

    for (let i = 0; i < 75; i += 1) {
      await sleep(200);
      if (threadRef() !== here) return { ok: false, reason: "thread_changed_during_send" };
      if (readPhotos().filter((p) => p.side === "out").length > before) return { ok: true, threadId: here };
    }
    return { ok: false, reason: "photo not visible in the thread after sending", threadId: here };
  }

  // ── requests ───────────────────────────────────────────────────────────────

  /**
   * Accept the request this thread is.
   *
   * ACCEPT SITS BESIDE BLOCK AND DELETE, so the match is deliberately timid:
   * destructive labels are rejected FIRST, the accept word must be the whole
   * label rather than a substring, and more than one candidate refuses instead
   * of guessing. Pressing the wrong one here blocks a real person.
   *
   * ⚠ The labels are localised, so this list is not a selector — it is a
   * DENY list plus an exact-match allow list, and an unknown language falls
   * through to "no candidate" and does nothing, which is the safe direction.
   * A dryRun reports what it WOULD press, which is the only way to check it
   * against a real request without spending one.
   */
  const ACCEPT_WORDS = /^(zaakceptuj|accept|accepter|aceptar|akzeptieren|accetta)$/i;
  const DESTRUCTIVE = /(zablokuj|usu|block|delete|remove|report|zgłoś|bloquear|supprimer|löschen)/i;

  function acceptRequest({ dryRun = false } = {}) {
    const label = (b) => norm(`${b.innerText || ""} ${b.getAttribute("aria-label") || ""}`);
    const buttons = [...document.querySelectorAll('[role="button"],button')].filter(
      (b) => b.getBoundingClientRect().width > 0,
    );
    const candidates = buttons.filter((b) => ACCEPT_WORDS.test(norm(b.innerText)) && !DESTRUCTIVE.test(label(b)));
    if (candidates.length !== 1) {
      return { ok: false, reason: `refusing — ${candidates.length} accept candidates`, threadId: threadRef() };
    }
    if (dryRun) return { ok: true, wouldClick: norm(candidates[0].innerText), threadId: threadRef() };
    candidates[0].click();
    return { ok: true, threadId: threadRef() };
  }

  // ── posts, the feed, and replies ───────────────────────────────────────────

  const POST_PATH = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/;
  const POST_HREF = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)\/?$/;

  /** The open post, from the URL. Null anywhere else. */
  function postRef() {
    const m = POST_PATH.exec(location.pathname);
    return m ? { handle: m[1], code: m[2] } : null;
  }

  /**
   * A post's or reply's BODY, without the furniture.
   *
   * `innerText` on the block also carries the author, the timestamp and three
   * counts, and handing that to a character as "what they said" is how it ends
   * up answering the like count. The body is the `dir=auto` spans that are not
   * inside a link or a button — and only the OUTERMOST of those, because
   * Threads nests spans and joining all of them repeats the text.
   *
   * ⚠ THE VISIBLE TIMESTAMP IS NOT INSIDE `<time>`. Excluding `closest("time")`
   * looked right and changed nothing: measured, the `<time>` element sits
   * inside an anchor and the text a reader sees ("8 godz.") is a SEPARATE span
   * beside it, outside that anchor, which sails through both filters. The first
   * version of this shipped bodies reading "8 godz.\nFamily really is
   * everything".
   *
   * What identifies it exactly, in any language, is that its text EQUALS the
   * `<time>` element's own text. That is used rather than a pattern for
   * relative times, because those are localised and matching a word is not a
   * selector.
   */
  /**
   * `innerText`, MINUS the controls nested inside it.
   *
   * ⚠ A CONTROL INSIDE THE BODY SPAN IS NOT EXCLUDED BY EXCLUDING CONTROLS.
   * `blockBody` rejects a span that SITS INSIDE a `[role=button]`; Threads puts
   * its Translate control INSIDE the body span instead — measured on a live
   * feed post: `<span dir=auto>…just when we needed it.<div role=button
   * tabindex=0><span>Przetłumacz</span></div></span>` — so `innerText` on the
   * one we keep swallows it. EVERY post and EVERY comment in a four-post
   * sample came back ending in "Przetłumacz", and that is what went to the
   * character as the words it is answering. A localised UI string reads as part
   * of somebody's sentence, so nothing downstream can catch it.
   *
   * A `[role=link]` is NOT stripped: an @mention is inside one and the author
   * really did write it.
   *
   * Block children still start a new line, the way `innerText` does — dropping
   * to `textContent` to get a clean walk would run "Really agree." and the
   * paragraph after it together, which is the trap the inbox rows already hit.
   */
  function textWithoutControls(el) {
    let out = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // Translate, "more", and anything else the page offers rather than says.
      if (node.matches('[role="button"]')) continue;
      if (node.getAttribute("aria-hidden") === "true") continue;
      const inner = textWithoutControls(node);
      if (!inner.trim()) continue;
      const display = getComputedStyle(node).display;
      const inline = display.startsWith("inline") || display === "contents";
      out += inline || !out || out.endsWith("\n") ? inner : `\n${inner}`;
    }
    return out;
  }

  /**
   * The top of a card's ACTION BAR — like / reply / repost / share.
   *
   * ⚠ THE BLOCK IS BIGGER THAN THE POST. On a permalink page the ancestor that
   * first measures 380×55 wraps the card AND the replies area AND the composer,
   * so a post with no replies handed the character its own caption followed by
   * "Nie ma jeszcze odpowiedzi" ("no replies yet"). That line has no role, no
   * aria-hidden and no attribute of any kind — measured; it is an ordinary
   * `span[dir=auto]`, indistinguishable from the caption by anything except
   * WHERE IT IS.
   *
   * The bar is the boundary, because a card is always text-then-controls:
   * measured on a live post, caption at y=157, the four-icon bar at y=186, the
   * empty state at 251, the composer at 304. Anything at or below the bar
   * belongs to the page, not to the author.
   *
   * Identified as a ROW — three or more icon buttons sharing a top — rather
   * than by label, because every label here is localised. The composer's own
   * attach/GIF/expand row is also three, which is why the SMALLEST qualifying
   * row wins: that is the post's, and the composer's is further down anyway.
   * A comment's smaller bar (two icons) does not qualify and nothing is cut,
   * which is the safe direction: today's behaviour.
   */
  const BAR_TOL_PX = 6;
  function actionBarTop(el) {
    const tops = [];
    for (const b of el.querySelectorAll('[role="button"]')) {
      if (!b.querySelector("svg[aria-label]")) continue;
      const r = b.getBoundingClientRect();
      if (r.height <= 0) continue;
      tops.push(r.top);
    }
    const rows = tops.filter((t) => tops.filter((o) => Math.abs(o - t) <= BAR_TOL_PX).length >= 3);
    return rows.length ? Math.min(...rows) : Infinity;
  }

  /**
   * ⚠ A BADGE ON THE HEADER LINE IS NOT SOMETHING ANYBODY SAID.
   *
   * Threads marks the post's author on their own replies with an "Autor" pill,
   * and it is an ordinary `span[dir=auto]` — not a control, not aria-hidden —
   * so it went to the character as part of the reply: the lead's words arrived
   * as `"Autor\nThanks I think"`. Matching the word is not a selector; it is
   * localised, and Meta can add "Zweryfikowany", "Edytowano" or anything else
   * to the same row tomorrow.
   *
   * What separates them is the LINE. Measured on a real reply: `<time>` at
   * y=937, the visible stamp at 940, the "Autor" pill at 939 — and the body at
   * 961. Everything on the timestamp's own line is header; the body starts
   * below it. This also covers the visible timestamp itself, which is why the
   * text-equality trick below is now belt-and-braces rather than the only
   * defence.
   */
  const HEADER_TOL_PX = 10;
  function headerLines(el) {
    return [...el.querySelectorAll("time")].map((t) => t.getBoundingClientRect().top);
  }

  function blockBody(el) {
    const stamps = new Set([...el.querySelectorAll("time")].map((t) => norm(t.innerText)).filter(Boolean));
    const lines = headerLines(el);
    const bar = actionBarTop(el);
    return [...el.querySelectorAll('span[dir="auto"]')]
      .filter((s) => s.getBoundingClientRect().top < bar)
      .filter((s) => {
        const top = s.getBoundingClientRect().top;
        return !lines.some((y) => Math.abs(top - y) <= HEADER_TOL_PX);
      })
      .filter((s) => !s.closest("a[href]") && !s.closest('[role="button"]'))
      /**
       * ⚠ THE REPLY COMPOSER IS INSIDE THE ROOT BLOCK on a post page, and its
       * PLACEHOLDER is an ordinary span — so the root post's caption arrived at
       * FluidTalk as "…just when we needed it.\nOdpowiedz użytkownikowi
       * raniakhalek…", i.e. the character was asked to comment on a post whose
       * text ends with our own composer's prompt. Measured: the placeholder
       * span sits under `div[aria-hidden="true"]` and its text is exactly the
       * editor's `aria-placeholder`. Excluded by the hidden flag rather than by
       * that string, because aria-hidden means "not content" for every other
       * piece of furniture Threads mounts in a card as well.
       */
      .filter((s) => !s.closest('[aria-hidden="true"]'))
      .filter((s) => !s.parentElement?.closest('span[dir="auto"]'))
      .map((s) => norm(textWithoutControls(s)))
      .filter((t) => t && !stamps.has(t))
      .join("\n");
  }

  /**
   * Every post-or-reply block on the page, anchored by its own `<time>`.
   *
   * A block is the nearest ancestor of a `<time>` that is wide and tall enough
   * to be a card. There is no role, no class and no data attribute to key off —
   * Threads ships obfuscated per-build class names — but every post and every
   * reply has exactly one timestamp, which makes `<time>` the one reliable
   * anchor on the page.
   *
   * On Threads a REPLY IS ITSELF A POST: it carries its own
   * `/@author/post/<code>`, which is why a comment id here is a post code and
   * is stable across reloads, unlike a list index.
   */
  function postBlocks() {
    const seen = new Set();
    const out = [];
    for (const tm of document.querySelectorAll("time")) {
      let el = tm;
      let block = null;
      for (let i = 0; i < 10 && el; i += 1, el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width > 380 && r.height > 55) { block = el; break; }
      }
      if (!block || seen.has(block)) continue;
      seen.add(block);

      const hrefs = [...block.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "");
      const postHref = hrefs.find((h) => POST_HREF.test(h)) ?? null;
      const m = postHref ? POST_HREF.exec(postHref) : null;
      const author = m ? m[1] : (hrefs.find((h) => /^\/@[A-Za-z0-9._]+$/.test(h)) || "").slice(2) || null;

      out.push({
        el,
        block,
        rect: block.getBoundingClientRect(),
        id: m ? m[2] : null,
        author,
        // The DISPLAY NAME, which is what the reply composer's placeholder
        // uses. It is not the handle, and on most accounts the two differ —
        // checking only the handle made the aiming interlock refuse a reply it
        // should have allowed.
        name: norm([...block.querySelectorAll('a[href^="/@"]')].map((a) => a.innerText)[0] || ""),
        at: tm.getAttribute("datetime") || null,
        text: blockBody(block),
        /**
         * `media` was a COUNT and nothing carried the urls, so a post with a
         * picture reached the character as caption-only — and a blind comment
         * on an image post reads perfectly naturally, which is exactly why it
         * has to be fixed rather than noticed. Over 60px excludes avatars and
         * the little inline icons.
         */
        media: blockImages(block).length,
        imageUrls: blockImages(block)
          .map((i) => i.currentSrc || i.src)
          .filter(Boolean)
          .slice(0, 4),
        videos: block.querySelectorAll("video").length,
      });
    }
    out.sort((a, b) => a.rect.top - b.rect.top);

    // Depth by INDENTATION: a reply to a reply is inset (measured: 974 for the
    // root and its direct replies, 1015 for one nested under a reply). There is
    // no other signal on the page — no ul, no aria-level, no id relationship.
    const leftmost = Math.min(...out.map((b) => b.rect.left));
    for (const b of out) b.depth = Math.max(0, Math.round((b.rect.left - leftmost) / 36));
    return out;
  }

  /**
   * Open the post with this code by CLICKING a link to it.
   *
   * Its address answers 302 and lands on the home feed (see `routes.post`), so
   * navigating is not an option and a worker that tried would read a stranger's
   * post as though it were this one. The link has to already be on the page —
   * the feed, a profile, /activity — which is where the worker finds the code
   * in the first place.
   */
  /**
   * The link to one post, SCROLLING TO FIND IT.
   *
   * ⚠ "not on this page" is almost always "not on this page YET". The feed
   * virtualises — a post is unmounted once it is scrolled past — and the
   * comments pass gathers candidates by scrolling the whole feed and only then
   * starts opening them, by which point the first candidate's link is long
   * gone. Measured: 14 candidates gathered, then
   * `no link to post DdVQADLDdL5 on this page`, and the pass ended having
   * commented on nothing.
   *
   * Back to the top first, because that is where a candidate read early in the
   * scan was seen, then scan downwards. Scrolling costs no page load, so this
   * is cheap in the way a navigation is not.
   */
  async function findPostLink(code) {
    const find = () =>
      [...document.querySelectorAll("a[href]")].find((a) => {
        const m = POST_HREF.exec(a.getAttribute("href") || "");
        return m && m[2] === code && a.getBoundingClientRect().width > 0;
      }) ?? null;

    let link = find();
    if (link) return link;

    window.scrollTo(0, 0);
    await sleep(700);
    link = find();

    for (let i = 0; i < 14 && !link; i += 1) {
      const before = window.scrollY;
      window.scrollBy(0, 1200);
      await sleep(500);
      // The bottom: scrolling stopped moving, so there is nothing further to
      // mount and the post genuinely is not in this list.
      if (window.scrollY === before) break;
      link = find();
    }
    return link;
  }

  async function openPost(code) {
    if (!code) return { ok: false, reason: "no post code" };
    if (postRef()?.code === code) return { ok: true, code, via: "already open" };

    const link = await findPostLink(code);
    if (!link) return { ok: false, reason: `no link to post ${code} on this page` };

    link.scrollIntoView({ block: "center" });
    await sleep(300);
    link.click();

    let arrived = false;
    for (let waited = 0; waited < 9000 && !arrived; waited += 300) {
      await sleep(300);
      arrived = postRef()?.code === code;
    }
    if (!arrived) return { ok: false, reason: "the click did not open that post" };

    /**
     * ⚠ THE ADDRESS CHANGES BEFORE THE REPLIES EXIST.
     *
     * Returning as soon as the URL matched made every post look like it had
     * none: seven posts in a row read back "0 replies" while the same posts
     * showed eleven blocks when a probe waited. A post with no replies and a
     * post whose replies have not arrived are the same page for a moment, and
     * the worker cannot tell them apart afterwards.
     *
     * So: wait for the root block to be the post that was asked for, then let
     * the block count settle — two equal reads in a row — before saying the
     * page is readable. Capped, because a post really can have no replies.
     */
    let settled = 0;
    let last = -1;
    for (let waited = 0; waited < 9000; waited += 600) {
      await sleep(600);
      const blocks = postBlocks();
      // The addressed post, wherever it sits — a chained post has its author's
      // earlier ones above it (see `rootIndex`), and demanding index 0 meant
      // this loop ran its full nine seconds on every one of them and then said
      // `settled: false`, which nothing downstream treats as a failure.
      const at = rootIndex(blocks, code);
      if (at < 0) continue;
      const n = blocks.length - at;
      settled = n === last ? settled + 1 : 0;
      last = n;
      if (settled >= 1) return { ok: true, code, via: "click", blocks: n, replies: n - 1 };
    }
    return { ok: true, code, via: "click", blocks: last, replies: Math.max(0, last - 1), settled: false };
  }

  /**
   * An ad.
   *
   * Matched on a LEAF span: the label sits in its own node, and testing a whole
   * post's text for the word finds every post that merely mentions it.
   */
  const SPONSORED = /^(sponsorowane|sponsored|patrocinado|commandité|gesponsert|sponsorizzato)$/i;
  function isSponsored(block) {
    return [...block.querySelectorAll("span")].some(
      (s) => !s.querySelector("span") && SPONSORED.test(norm(s.innerText)),
    );
  }

  function readFeed(limit = 12, { skipSponsored = true } = {}) {
    const out = [];
    for (const b of postBlocks()) {
      if (!b.id) continue;
      if (skipSponsored && isSponsored(b.block)) continue;
      out.push({ code: b.id, author: b.author, at: b.at, text: b.text, media: b.media, videos: b.videos });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * ⚠ AN ARRAY, because that is what the CALLER reads.
   *
   * This answered `{ok, posts}` and `commentCandidates` does
   * `for (const post of posts)` on whatever comes back — so the followers
   * source threw "posts is not iterable" and took the whole comments pass with
   * it. `commentSources` DEFAULTS TO "both", so that was the default path, and
   * the `if (!posts.length)` guard above it read `undefined` and logged "has no
   * readable posts" first, which is what made it look like an empty profile
   * rather than a shape mismatch. Instagram's returns a bare array; the
   * contract was always the array.
   *
   * Not on a profile ⇒ empty, not an error object: the caller navigated to the
   * profile route one line earlier and `goToRoute` already reported a failure
   * to arrive, so there is nothing a reason here could add that is not already
   * in the log.
   */
  function readProfilePosts(limit = 12) {
    if (!/^\/@[A-Za-z0-9._]+/.test(location.pathname)) return [];
    return readFeed(limit, { skipSponsored: false });
  }

  /**
   * WHICH block is the post the address points at.
   *
   * ⚠ IT IS NOT ALWAYS THE TOPMOST ONE. A post that continues an earlier post
   * of its author's — Threads renders those as a numbered chain, "1 / 2" — is
   * shown with its PARENT ABOVE IT on its own permalink page. Measured on
   * `/@our_account/post/DdFfGgHhIiJ`: blocks[0] is `DdKkLlMmNnO` at y=8 and
   * the addressed post is blocks[1] at y=108.
   *
   * Assuming index 0 broke three things at once, and none of them said so:
   * `readPost` answered "the root post has not rendered yet" for ever, so the
   * comments pass logged "could not read <code>" and skipped every chained post
   * — silently, because an unreadable post is a `continue`; `openPost` waited
   * out its full settle timeout on each one; and `readComments` dropped the
   * chain's first post as "the root" and then reported THE POST ITSELF as a
   * comment by its own author, which is what made `alreadyCommented` true on a
   * post nobody had commented on.
   *
   * Matching the code keeps the guarantee that motivated index 0 — we only ever
   * read the post we asked for, never whatever the page happens to be showing.
   */
  function rootIndex(blocks, code) {
    return blocks.findIndex((b) => b.id === code);
  }

  /** The root post of the open post page. */
  function readPost() {
    const ref = postRef();
    if (!ref) return { ok: false, reason: "not_on_post" };
    const blocks = postBlocks();
    const at = rootIndex(blocks, ref.code);
    const root = at >= 0 ? blocks[at] : null;
    if (!root) return { ok: false, reason: "the root post has not rendered yet" };
    return {
      ok: true,
      code: ref.code,
      // ⚠ REQUIRED BY FLUIDTALK, AND IT WAS MISSING. `post_ref` is the key the
      // comment thread is filed under, and the endpoint rejects the whole call
      // without it: `{'type': 'missing', 'loc': ('body', 'post_ref')}`. It read
      // like a FluidTalk problem; it was this object simply not carrying the
      // field. The name is the trap — `postRef()` here parses the ADDRESS into
      // {handle, code}, while Instagram's `postRef(code)` builds the permalink
      // STRING that goes on the wire. Same name, different things.
      postRef: permalink(ref.handle, ref.code),
      author: root.author,
      at: root.at,
      caption: root.text,
      // The contract field the worker and FluidTalk both read. Threads calls it
      // `media` internally and that is a COUNT, so this is the array.
      imageUrls: root.imageUrls ?? [],
      media: root.media,
      videos: root.videos,
      // Only what is BELOW the addressed post. The chain above it is its
      // author's own earlier posts, and counting those as comments would make a
      // lone post look like a conversation.
      comments: blocks.length - 1 - at,
    };
  }

  /**
   * The canonical permalink for a post — what FluidTalk keys the thread on.
   *
   * The HOST IS PINNED rather than taken from `location.origin`, for the reason
   * Instagram's equivalent spells out: the same post reached on another host
   * (threads.net redirects here, and a bare threads.com is not www) would
   * become a second thread, losing the reply count and the per-author counts
   * the stop rules are computed from — so the character would answer the same
   * person for ever.
   */
  /** The images in a post block, big enough not to be an avatar or an icon. */
  function blockImages(block) {
    return [...block.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 60);
  }

  function permalink(handle, code) {
    return `https://www.threads.com/@${String(handle).replace(/^@/, "")}/post/${code}`;
  }

  /**
   * The replies on the open post page.
   *
   * `id` is the reply's own post code — stable, unlike an index. `replyTo` is
   * the nearest preceding block one level shallower, which is the only thing
   * the page encodes: the nesting is visual.
   */
  function readComments() {
    const ref = postRef();
    if (!ref) return [];
    const blocks = postBlocks();
    // Everything ABOVE the addressed post is its author's own chain, not a
    // reply to it — see `rootIndex`. Starting at 0 made the post itself the
    // first "comment" on a chained page.
    const at = rootIndex(blocks, ref.code);
    if (at < 0) return [];
    const out = [];
    const stack = [];
    for (let i = at; i < blocks.length; i += 1) {
      const b = blocks[i];
      stack[b.depth] = b;
      if (i === at) continue; // the root post is not a comment
      out.push({
        id: b.id,
        author: b.author,
        text: b.text,
        at: b.at,
        isReply: b.depth > 0,
        replyTo: b.depth > 0 ? stack[b.depth - 1]?.id ?? null : null,
      });
    }
    return out;
  }

  /**
   * Have we already commented on the open post?
   *
   * ⚠ THE WORKER HAS ALWAYS READ THIS AND THIS ADAPTER NEVER SENT IT.
   * `runComments` does `if (post.alreadyCommented)` and Threads' `ft:read-post`
   * answered an object without the field, so it was `undefined` on every post
   * and the ONLY thing standing between the character and a second public
   * comment was `fluidextension.commented` in this profile's local storage —
   * a list that is capped at 500 and starts empty in a fresh profile. Nothing
   * fails when it is wrong; we simply comment twice, in public, on a stranger.
   *
   * Cheaper and stronger here than Instagram's version, which counts how many
   * times our own handle appears in the page's links: on Threads a reply IS a
   * post and carries its author's handle, so the comment list answers directly.
   * The root post is not in `readComments()`, so commenting on OUR OWN post
   * does not make it look answered.
   *
   * `null` (not `false`) when we do not know who we are — the caller treats
   * unknown as "go ahead", and saying `false` would claim we checked.
   */
  function ourCommentPresent(ownHandle) {
    if (!ownHandle) return null;
    const me = String(ownHandle).replace(/^@/, "").toLowerCase();
    return readComments().some((c) => (c.author || "").toLowerCase() === me);
  }

  async function readCommentReplies(ownHandle) {
    const ref = postRef();
    if (!ref) return { ok: false, reason: "not_on_post" };
    if (!ownHandle) return { ok: false, reason: "own_handle_unknown" };

    const all = readComments();
    const ours = new Set(all.filter((c) => !c.isReply && c.author === ownHandle).map((c) => c.id));

    return {
      ok: true,
      code: ref.code,
      // Pinned host, not `location.origin` — see `permalink`. Built from the
      // same helper so a post cannot be one ref here and another there, which
      // would file our own comment under a thread the reply cap never sees.
      postRef: permalink(ref.handle, ref.code),
      expanded: 0,
      comments: all.length,
      ourComments: [...ours],
      replies: all
        .filter((c) => c.isReply && ours.has(c.replyTo))
        .map((c) => ({
          ...c,
          mine: c.author === ownHandle,
          /**
           * ⚠ WEAKER THAN INSTAGRAM'S, and deliberately so rather than
           * pretending otherwise. There, our reply opens with "@them" because
           * Instagram's Reply control prefills the mention, so a reply can be
           * matched to the person it answers. Threads prefills NOTHING —
           * measured: pressing Reply leaves the composer empty and only changes
           * the placeholder. So the best the page can say is "we have already
           * replied under this parent, after them". Two of our replies under
           * one parent are indistinguishable.
           */
          answeredOnPage: all.some(
            (r) => r.author === ownHandle && r.isReply && r.replyTo === c.replyTo && r.at > c.at,
          ),
        })),
    };
  }

  /**
   * The reply composer, and WHO IT IS AIMED AT.
   *
   * This is the safety interlock for publishing. Pressing "Odpowiedź" inside a
   * particular reply re-aims the one composer on the page, and the ONLY visible
   * trace of that is its placeholder, which then names that person — measured
   * by pressing Reply on a reply whose author differs from the root author and
   * watching the placeholder change from one to the other.
   *
   * Without this check the same publish click posts a brand-new top-level
   * comment on a stranger's post, publicly, addressed to nobody — the exact
   * failure the Instagram adapter's @mention check exists to prevent.
   */
  function replyComposer() {
    return document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  }

  function composerAimedAt() {
    const box = replyComposer();
    if (!box) return null;
    return norm(box.getAttribute("aria-placeholder") || box.getAttribute("data-placeholder") || "");
  }

  /** Does the composer's placeholder name this person (handle or display name)? */
  function aimedAt(author, displayName) {
    const ph = (composerAimedAt() || "").toLowerCase();
    if (!ph) return false;
    if (author && ph.includes(String(author).toLowerCase())) return true;
    if (displayName && displayName.length > 2 && ph.includes(String(displayName).toLowerCase())) return true;
    return false;
  }

  /**
   * Publish whatever the composer currently holds, and confirm it against the
   * PAGE — a new block, authored by us, carrying our text.
   */
  async function publishComposer(text, ownHandle, expectParent) {
    const before = readComments().length;
    const armed = await typeAndArm(text);
    if (!armed.ok) return armed;
    const box = composer();
    armed.button.click();

    for (let waited = 0; waited < 12000; waited += 400) {
      await sleep(400);
      const now = readComments();
      /**
       * ⚠ A SUCCESSFUL PUBLISH IS INVISIBLE HERE, so waiting for the block
       * alone can only ever time out.
       *
       * Threads does not re-render what is already on screen — the same fact
       * that makes an incoming DM unobservable ([[rerenderOnRevisit]]) applies
       * to our own comment. Watched across the click on a live post: the status
       * region went "Publikowanie…" → "Opublikowano", the composer emptied
       * ITSELF, and the page's `<time>` count never moved off nine. The comment
       * was genuinely live — a fresh render of the post showed it — while this
       * loop ran its full twelve seconds and reported "not visible on the post
       * after publishing". The worker treats that as a failure, which is the
       * expensive direction: a real, public comment counted as not sent, the
       * post never marked commented, and a duplicate written next cycle.
       *
       * THE COMPOSER EMPTYING ITSELF IS THE ACCEPT SIGNAL, and it is the one
       * signal here that is not localised — the status text is Polish on this
       * account. It is trustworthy precisely BECAUSE we cannot clear the box
       * ourselves: `clearComposer` is a no-op against Lexical (measured: three
       * different execCommand routes all left the text in place), so an empty
       * box after a click is Threads having consumed it.
       *
       * The rendered block is still preferred when it appears, because it
       * carries an id. Confirming by the composer cannot produce one, so the
       * threading check a reply would need is not available on that path —
       * `postCommentReply` is not declared, and this is one of the reasons.
       */
      if (now.length <= before) {
        /**
         * ⚠ `isConnected`, because AN UNMOUNTED COMPOSER ALSO READS EMPTY.
         *
         * Pressing "Rozwiń edytor" (expand editor) opens a modal and takes the
         * inline composer out of the document — `innerText` on the detached
         * node is "", which is indistinguishable from Threads having accepted
         * the text unless the node is checked for still being in the page. That
         * reported a publish that had not happened: `ok: true, via: "composer
         * cleared"` on a post whose fresh render showed no comment of ours.
         *
         * A dialog on screen is the same event seen from the other side, and it
         * is not a publish either.
         */
        const cleared = box && box.isConnected && !norm(box.innerText);
        const dialog = document.querySelector('[role="dialog"]');
        if (cleared && !dialog) {
          return { ok: true, id: null, parent: null, threaded: null, via: "composer cleared", pressed: armed.pressed };
        }
        continue;
      }
      /**
       * CONTAINS, not equals.
       *
       * A published block's body is not character-identical to what was typed:
       * Threads appends its own furniture inside the same block (a "see
       * translation" control, an empty-state line), and `blockBody` joins the
       * remaining spans with newlines. Requiring equality reported "the reply
       * is not visible on the post" about a reply that was sitting on the page,
       * authored by us — which would have made the worker post it a second time.
       */
      const want = norm(text);
      const mine = now.find((c) => norm(c.text).includes(want) && (!ownHandle || c.author === ownHandle));
      if (mine) {
        return {
          ok: true,
          id: mine.id,
          parent: mine.replyTo,
          // Said rather than assumed: the worker's confirmThreaded decides what
          // to do about a reply that landed at the wrong level.
          threaded: expectParent ? mine.replyTo === expectParent : null,
        };
      }
    }
    /**
     * Neither signal arrived. Report WHAT WAS PRESSED and whether the composer
     * still holds the text, because those separate the two very different
     * failures: a publish that was accepted and simply never rendered (the box
     * would be empty — handled above), and a click that did nothing at all (the
     * box still holds it, and no status ever appeared).
     */
    return {
      ok: false,
      reason: `the publish did not take — pressed "${armed.pressed ?? "?"}"${
        armed.candidates?.length > 1 ? ` (of ${armed.candidates.join(", ")})` : ""
      }, composer ${box && norm(box.innerText) ? "still holds the text" : "is empty"}`,
    };
  }

  /**
   * A top-level comment on the open post.
   *
   * Refuses unless the composer is aimed at the ROOT author. The composer is
   * shared with the per-reply Reply control, so if anything re-aimed it earlier
   * this would publish under a reply instead of on the post.
   */
  async function postComment(text, ownHandle) {
    const ref = postRef();
    if (!ref) return { ok: false, reason: "not on a post page" };
    if (!norm(text)) return { ok: false, reason: "refusing to post an empty comment" };
    // The block the ADDRESS points at (see `rootIndex`) — this is the interlock
    // that decides the composer is aimed at the right author, so "whatever is
    // at the top of the page" is not good enough to publish on.
    const blocks = postBlocks();
    const root = blocks[rootIndex(blocks, ref.code)] ?? null;
    if (!root) return { ok: false, reason: "the post has not rendered" };
    /**
     * No composer means we CANNOT reply here — measured on a live post whose
     * author restricts replies: zero `[contenteditable]` anywhere on the page
     * while 26 per-comment Reply controls rendered and eight replies were
     * visible, and scrolling down and back mounted nothing.
     *
     * It is waited for rather than asked once, because this answer is the basis
     * for `uncommentable`: the worker remembers the post and never spends
     * another page load or another BILLED generation on it, so "not mounted
     * yet" must never be mistaken for "not allowed". Absent after four seconds
     * on a page whose blocks have already settled is the real thing.
     *
     * `uncommentable` is a FLAG rather than wording the worker greps for. It
     * matched `/no comment box/i` — Instagram's exact sentence — so on Threads
     * the memo never fired at all, and the pass would re-open and re-generate
     * for this post on every cycle, for ever.
     */
    let composer = replyComposer();
    for (let waited = 0; waited < 4000 && !composer; waited += 400) {
      await sleep(400);
      composer = replyComposer();
    }
    if (!composer) {
      return {
        ok: false,
        uncommentable: true,
        reason: "no reply composer (replies are restricted on this post)",
      };
    }
    if (!aimedAt(root.author, root.name)) {
      return { ok: false, reason: "the composer is not aimed at the post author — refusing to publish somewhere else" };
    }
    return publishComposer(text, ownHandle, null);
  }

  /**
   * A threaded reply to one specific comment.
   *
   * Presses that comment's own Reply control and then REFUSES unless the
   * composer's placeholder starts naming its author. That placeholder is the
   * only evidence Threads gives that the composer was re-aimed.
   */
  async function postCommentReply({ commentId, text, ownHandle }) {
    const ref = postRef();
    if (!ref) return { ok: false, reason: "not on a post page" };
    if (!norm(text)) return { ok: false, reason: "refusing to post an empty reply" };

    const target = postBlocks().find((b) => b.id === commentId);
    if (!target) return { ok: false, reason: `comment ${commentId} is not on screen` };

    const svg = [...target.block.querySelectorAll("svg[aria-label]")].find((s) =>
      /odpowied|repl|respond|responder|antwort|rispond/i.test(s.getAttribute("aria-label") || ""),
    );
    if (!svg) return { ok: false, reason: "no Reply control inside that comment" };

    const before = composerAimedAt();
    (svg.closest('[role="button"]') || svg.parentElement).click();

    /**
     * ⚠ "THE PLACEHOLDER CHANGED" IS NOT ALWAYS AVAILABLE.
     *
     * It is the strongest evidence when the comment's author differs from the
     * post's author: the placeholder moves from one name to the other. When
     * they are the SAME person — replying to a comment on our own post, which
     * is exactly the case a self-test can exercise — the placeholder is already
     * that name and never moves, and requiring a change refuses a correctly
     * aimed composer.
     *
     * So the change is required only where it can happen; the name check
     * always is. And it checks the DISPLAY NAME as well as the handle, because
     * the placeholder uses the display name and the two are usually different.
     */
    const all = postBlocks();
    const root = all[rootIndex(all, ref.code)] ?? null;
    const sameAsRoot = Boolean(root && root.author && root.author === target.author);

    let aimed = false;
    for (let waited = 0; waited < 6000 && !aimed; waited += 250) {
      await sleep(250);
      aimed = aimedAt(target.author, target.name) && (sameAsRoot || composerAimedAt() !== before);
    }
    if (!aimed) {
      return {
        ok: false,
        reason: "Reply did not aim the composer at that comment — refusing to publish a top-level comment instead",
      };
    }

    // Replying to a reply lands under the same parent, so that is what to
    // expect back — not the reply we answered.
    const expectParent = target.depth > 0 ? readComments().find((c) => c.id === commentId)?.replyTo ?? commentId : commentId;
    return publishComposer(text, ownHandle, expectParent);
  }

  /**
   * Scroll to bring more in.
   *
   * The feed and a post page scroll the WINDOW; the followers list scrolls its
   * own box inside a dialog, which `scrollFollowers` handles separately.
   */
  function scrollPage(by = 900) {
    const before = window.scrollY;
    window.scrollBy(0, by);
    return { moved: window.scrollY !== before, y: window.scrollY };
  }

  // ── notifications ──────────────────────────────────────────────────────────

  const ACTIVITY_PATH = /^\/activity(\/|$)/;

  /** A handle and post code out of an href, relative or absolute. */
  function parseHref(href) {
    if (!href) return null;
    let path = href;
    if (/^https?:\/\//i.test(href)) {
      try { path = new URL(href).pathname; } catch (_) { return null; }
    }
    const post = POST_HREF.exec(path);
    if (post) return { handle: post[1], code: post[2] };
    const prof = /^\/@([A-Za-z0-9._]+)\/?$/.exec(path);
    if (prof) return { handle: prof[1], code: null };
    return null;
  }

  /**
   * `/activity`, read as "posts worth opening".
   *
   * An INDEX, not the truth: a row decides which page to open, and
   * `readCommentReplies` on that page decides the rest. A misread row costs one
   * page visit; trusting a row would mean replying to text scraped out of a
   * notification.
   *
   * Nothing here matches Threads' PROSE. The interface language is not ours to
   * choose (this account renders Polish), so a row is a notification because it
   * owns a `<time>`, and it is about us because of WHOSE POST it links to.
   *
   * ⚠ `repliedToUs` USES A DIFFERENT SIGNAL FROM INSTAGRAM'S, because the
   * Instagram one does not exist here. There, a reply renders our handle as an
   * @mention because Reply prefills it, so "the row links to our handle" works.
   * Threads prefills nothing. What a Threads href does carry is the POST'S
   * AUTHOR — `/@author/post/<code>` — so a reply on something of ours is a row
   * whose post link is authored by us. A reply to a comment we left on somebody
   * else's post is NOT caught by that and will be found only by opening the
   * post; that is the known gap, not an oversight.
   *
   * ⚠ UNEXERCISED AGAINST A REAL REPLY NOTIFICATION. The account has two
   * notifications, a follow and a system message, and neither is a reply.
   */
  function readNotifications(ownHandle, limit = 30) {
    if (!ACTIVITY_PATH.test(location.pathname)) return { ok: false, reason: "not_on_notifications" };
    if (!ownHandle) return { ok: false, reason: "own_handle_unknown" };

    const rows = [];
    const seen = new Set();
    const mine = String(ownHandle).toLowerCase();

    for (const tm of document.querySelectorAll("time")) {
      let el = tm;
      let row = null;
      for (let i = 0; i < 9 && el; i += 1, el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 30 && r.height < 300) { row = el; break; }
      }
      if (!row || seen.has(row)) continue;
      seen.add(row);

      const refs = [...row.querySelectorAll("a[href]")].map((a) => parseHref(a.getAttribute("href"))).filter(Boolean);
      const post = refs.find((r) => r.code) ?? null;
      // The actor is named first — every one of these sentences opens with who
      // did it, in every language — so the first profile that is not ours.
      const who = refs.find((r) => r.handle && r.handle.toLowerCase() !== mine)?.handle ?? null;

      rows.push({
        code: post?.code ?? null,
        postAuthor: post?.handle ?? null,
        who,
        at: tm.getAttribute("datetime") || null,
        text: norm(row.innerText).slice(0, 200),
        repliedToUs: Boolean(post && String(post.handle).toLowerCase() === mine),
      });
      if (rows.length >= limit) break;
    }

    return {
      ok: true,
      rows,
      // Told apart on purpose: an empty list means nothing new, an unreadable
      // page means the markup moved. Treating the second as the first would
      // re-open every commented post on every quiet run.
      readable: rows.length > 0 || Boolean(document.querySelector('a[href="/activity"]')),
    };
  }

  // ── people: followers, and opening a DM ────────────────────────────────────

  /**
   * Words that must NEVER be clicked by something looking for a message button.
   *
   * The profile header puts Follow immediately beside Send message — two
   * controls of identical size on one row — so the same care the requests
   * folder needs applies here. Following a stranger is not undoable from the
   * worker's side and is an action against a real person.
   */
  const NOT_A_MESSAGE = /(obserwuj|follow|seguir|folgen|suivre|segui|zablokuj|block|zgłoś|report|usuń|delete|wycisz|mute|udostępnij|share)/i;
  const IS_A_MESSAGE = /(wiadomoś|message|mensaje|nachricht|messaggio|mensagem)/i;

  function profileRef() {
    const m = /^\/@([A-Za-z0-9._]+)\/?$/.exec(location.pathname);
    return m ? m[1] : null;
  }

  /**
   * Open a DM with the person whose profile is on screen.
   *
   * Deny list first, allow list second, and exactly one survivor or nothing
   * happens — the same shape as `acceptRequest`, for the same reason. The
   * result is then confirmed against the ADDRESS: pressing the message control
   * navigates to `/messages/t/<id>/`, and pressing Follow does not, so a
   * mis-click cannot be reported as success. It would still have followed
   * somebody, which is why the deny list runs first rather than relying on the
   * confirmation.
   */
  async function openDm({ dryRun = false } = {}) {
    const handle = profileRef();
    if (!handle) return { ok: false, reason: "not on a profile" };

    const controls = [...document.querySelectorAll('[role="button"],button')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 120 && r.height > 24 && r.height < 60 && r.top < 560;
    });
    const labelled = controls.map((b) => ({ el: b, label: norm(`${b.innerText || ""} ${b.getAttribute("aria-label") || ""}`) }));
    const candidates = labelled.filter((c) => c.label && IS_A_MESSAGE.test(c.label) && !NOT_A_MESSAGE.test(c.label));

    if (candidates.length !== 1) {
      /**
       * `unmessageable` is a FLAG, not a sentence for the worker to grep.
       *
       * It memoed this by matching `/no Message button/i` — Instagram's exact
       * words — so on Threads nothing was ever remembered and the same profiles
       * were re-opened every cycle. Seen in an unattended hour: `one_profile`
       * and `another_profile` refused on one cycle and were loaded again on the
       * next, which is the repeated-pointless-page-load pattern that earned
       * Instagram a sustained 429.
       *
       * Only when the profile offers NOTHING. More than one candidate is an
       * ambiguous page, not a profile that cannot be messaged, and retiring a
       * handle for that would lose somebody reachable.
       */
      return {
        ok: false,
        unmessageable: candidates.length === 0,
        reason: `refusing — ${candidates.length} message candidates on this profile`,
        handle,
      };
    }
    if (dryRun) return { ok: true, wouldClick: candidates[0].label, handle };

    candidates[0].el.click();
    for (let waited = 0; waited < 9000; waited += 300) {
      await sleep(300);
      const id = threadRef();
      if (id) return { ok: true, handle, threadId: id, via: "profile" };
    }
    return { ok: false, reason: "the message control did not open a conversation", handle };
  }

  /** The followers/following dialog, if it is open. */
  const followersDialog = () => document.querySelector('[role="dialog"]');

  /**
   * Open the followers list.
   *
   * ⚠ IT IS A DIALOG, NOT A PAGE. Instagram has `/<handle>/followers/`;
   * Threads has no such address — the count in the profile header is a
   * `div[role=button]` and pressing it opens a modal with two tabs
   * ("Obserwujący N" / "Obserwujesz N"). A worker that tried to navigate
   * somewhere would find nothing.
   */
  async function openFollowers() {
    if (followersDialog()) return { ok: true, via: "already open" };
    if (!profileRef()) return { ok: false, reason: "not on a profile" };

    // The counts control is the header control whose label STARTS with a
    // number. Matching the word for "followers" would be matching prose.
    const btn = [...document.querySelectorAll('[role="button"],button')]
      .map((b) => ({ el: b, r: b.getBoundingClientRect(), label: norm(b.innerText) }))
      .filter((c) => c.r.width > 0 && c.r.top < 560 && /^\d/.test(c.label) && c.label.length < 30)
      .sort((a, b) => a.r.top - b.r.top)[0];
    if (!btn) return { ok: false, reason: "no followers control on this profile" };

    btn.el.click();
    let appeared = false;
    for (let waited = 0; waited < 8000 && !appeared; waited += 300) {
      await sleep(300);
      appeared = Boolean(followersDialog());
    }
    if (!appeared) return { ok: false, reason: "the followers dialog did not open" };

    /**
     * ⚠ THE DIALOG EXISTS BEFORE THE PEOPLE IN IT DO.
     *
     * Returning on the box alone made `ft:list-followers` answer
     * `{ok:true, handles:[]}` on an account with eight followers — and an empty
     * list is not an error anywhere downstream, it is "this account has nobody
     * to reach", which ends the outreach pass quietly and for the wrong reason.
     * The same mistake openPost made with replies.
     */
    let settled = 0;
    let last = -1;
    for (let waited = 0; waited < 9000; waited += 500) {
      await sleep(500);
      const n = (listFollowers().handles || []).length;
      settled = n === last && n > 0 ? settled + 1 : 0;
      last = n;
      if (settled >= 1) return { ok: true, via: "click", rows: n };
    }
    return { ok: true, via: "click", rows: Math.max(0, last), settled: false };
  }

  function listFollowers() {
    const dialog = followersDialog();
    if (!dialog) return { ok: false, reason: "followers dialog is not open" };

    const handles = [];
    const seen = new Set();
    for (const a of dialog.querySelectorAll('a[href^="/@"]')) {
      if (!a.getBoundingClientRect().width) continue;
      const m = /^\/@([A-Za-z0-9._]+)\/?$/.exec(a.getAttribute("href") || "");
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      handles.push(m[1]);
    }
    return { ok: true, handles };
  }

  /**
   * Page the followers list.
   *
   * The dialog scrolls its OWN box, not the window — scrolling the window here
   * moves the page behind the modal and the list never advances, which reads as
   * "there are only eight followers".
   */
  function scrollFollowers(by = 600) {
    const dialog = followersDialog();
    if (!dialog) return { ok: false, moved: false, reason: "followers dialog is not open" };
    const box = [...dialog.querySelectorAll("*")].find(
      (el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 120,
    );
    if (!box) return { ok: true, moved: false, reason: "nothing to scroll — the whole list fits" };
    const before = box.scrollTop;
    box.scrollTop = before + by;
    return { ok: true, moved: box.scrollTop !== before, top: box.scrollTop };
  }

  // ── identity ───────────────────────────────────────────────────────────────

  /**
   * Our own handle, from the nav's profile link.
   *
   * `/@handle` in the left navigation is ours — it is the only profile link on
   * the page that is not inside the conversation, and it survives a thread
   * being open. Read rather than typed, for the reason the settings store
   * spells out: a typed handle that does not match exactly makes the lead
   * reader treat our own profile as the lead's.
   */
  function readOwnHandle() {
    const edge = navRight();
    for (const a of document.querySelectorAll('a[href^="/@"]')) {
      const r = a.getBoundingClientRect();
      if (r.width > 0 && r.right <= edge + 1) {
        const m = /^\/@([A-Za-z0-9._]+)/.exec(a.getAttribute("href") || "");
        if (m) return { handle: m[1], via: "nav" };
      }
    }
    return { handle: null, via: "not found" };
  }

  // ── readiness ──────────────────────────────────────────────────────────────

  /**
   * Is this page usable yet?
   *
   * An empty inbox and a still-loading one look identical, and taking the
   * second for the first is how a run reports "0 conversations", treats the
   * inbox as finished and does nothing for ever. The nav is the thing that is
   * always present once the app has booted, so it — not a chat count — is the
   * readiness question.
   */
  function ready() {
    const nav = document.querySelector('a[href="/messages/"], a[href^="/@"]');
    if (!nav) return { ready: false, why: "Threads has not rendered its navigation yet" };
    return { ready: true };
  }

  function probe() {
    return {
      url: location.href,
      threadId: threadRef(),
      onInbox: onInbox(),
      onRequests: onRequests(),
      rows: conversationRows().length,
      bubbles: bubbles().length,
      hasComposer: Boolean(composer()),
      sendControlVisible: Boolean(sendButton()),
      own: readOwnHandle(),
      watch: { ...watch, rowsKnown: lastList ? lastList.size : null },
    };
  }

  // ── watching for new messages ──────────────────────────────────────────────

  /**
   * A snapshot of the conversation list, keyed by the row's NAME.
   *
   * Not by index: a row with a new message jumps to the top, so index 0 means
   * a different conversation one second later and every row below it looks
   * changed. The name is the only thing a Threads row carries that survives
   * reordering — it has no id, and no unread count was ever found on it (see
   * `listThreads`, which reports `unread: null` rather than inventing one).
   *
   * The value is the row's whole text, which contains the message preview, so a
   * new message changes it. Opening a conversation does not: Threads restyles
   * the row rather than rewriting it.
   */
  function listSnapshot() {
    const map = new Map();
    for (const el of conversationRows()) {
      const raw = norm(el.innerText);
      const name = raw.split("\n")[0] || raw.slice(0, 40);
      if (name) map.set(name, raw);
    }
    return map;
  }

  let lastList = null;
  let lastSeen = null;
  let watchTimer = null;
  /**
   * Counters, reported by `ft:probe`.
   *
   * "The watcher did not fire" has three quite different causes — never
   * installed, installed but the observer never ran, ran but sent nothing —
   * and from outside the page they look identical. Without these the only way
   * to tell them apart is to guess.
   */
  const watch = { installed: false, ran: 0, listSent: 0, threadSent: 0, baselineRows: null, lastError: null };

  /**
   * ⚠ THE FIRST SNAPSHOT ONLY EVER ESTABLISHES A BASELINE.
   *
   * Every row looks new after injection, and firing then would ask the worker
   * to open the entire inbox at page load — which the first sweep cycle already
   * does.
   */
  function changedRows(now) {
    if (lastList === null) return [];
    const out = [];
    for (const [name, text] of now) {
      const before = lastList.get(name);
      if (before === undefined || before !== text) out.push(name);
    }
    return out;
  }

  /**
   * A busy page needs a ceiling on the debounce: quiet for 700ms runs it, and
   * so does 2.5s elapsed however busy the page gets. Threads' inbox happens to
   * be idle — measured, zero mutations in six seconds with a conversation
   * list on screen — but /messages/ with a thread open is not, and a plain
   * debounce that keeps being reset never fires at all.
   */
  const WATCH_QUIET_MS = 700;
  const WATCH_MAX_MS = 2500;
  let watchFirstQueued = 0;

  /**
   * ⚠ THE BASELINE CANNOT WAIT FOR THE FIRST MUTATION.
   *
   * `changedRows` returns nothing while `lastList` is null, which is right —
   * every row looks new at injection. But taking that baseline inside the
   * observer means the FIRST DOM CHANGE AFTER LOAD only establishes it, and
   * sends nothing. On a busy page that first change is some repaint and no harm
   * is done; on this one it is THE FIRST INCOMING MESSAGE, because the inbox
   * emits no mutations at all until something actually happens.
   *
   * Measured: a main-world observer on the same page counted 0 callbacks in six
   * idle seconds, then exactly 1 when a row's text was rewritten — so the very
   * first real message would have been swallowed as "the baseline" and the
   * watcher would have looked broken until a second one arrived.
   *
   * So the baseline is taken here, as soon as the list has rendered, and the
   * observer only ever compares against it.
   */
  async function takeBaseline() {
    for (let waited = 0; waited < 25000; waited += 500) {
      if (lastList !== null) return; // the observer got there first
      const now = listSnapshot();
      if (now.size) { lastList = now; watch.baselineRows = now.size; return; }
      await sleep(500);
    }
    watch.baselineRows = 0;
  }

  /**
   * The doorbell, heard from the page world.
   *
   * A MutationObserver is blind here: Threads re-renders nothing in place, so
   * an incoming message produces no DOM change at all and every other adapter's
   * instant path simply does not exist on this one. `threads-mainworld.js`
   * watches the realtime socket instead and posts when a payload frame that is
   * not presence arrives — it says only that SOMETHING happened, never what.
   *
   * Forwarded straight to the worker, which decides whether to act: it wakes a
   * run that is already going and does nothing otherwise, by the owner's
   * choice. Nothing here is trusted as content.
   */
  function listenForRealtime() {
    window.addEventListener("message", (ev) => {
      // Same window only, and our own envelope: every script on the page can
      // post, and a message that is merely SHAPED right is not from us.
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== "fluidextension" || d.kind !== "threads-realtime") return;
      chrome.runtime.sendMessage({ type: "ft:realtime", reason: d.reason ?? null }).catch(() => {});
    });
  }

  function startWatch() {
    listenForRealtime();
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (!watchFirstQueued) watchFirstQueued = now;
      if (now - watchFirstQueued >= WATCH_MAX_MS) {
        clearTimeout(watchTimer);
        watchTimer = null;
        watchFirstQueued = 0;
        return runWatch();
      }
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchFirstQueued = 0;
        runWatch();
      }, WATCH_QUIET_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    watch.installed = true;
    takeBaseline();
  }

  function runWatch() {
    watch.ran += 1;
    try {
      /**
       * THE LIST FIRST, and independently of the open conversation. This is the
       * half that notices somebody who is NOT on screen; the Telegram adapter
       * learned that the hard way, where a brand-new thread stayed invisible
       * until a sweep came round because the observer fired, then `readThread`
       * looked at whatever was open and threw the signal away.
       */
      const now = listSnapshot();
      // An empty list is Threads not having rendered yet, not an empty inbox.
      if (now.size) {
        const changed = changedRows(now);
        lastList = now;
        if (changed.length) {
          watch.listSent += 1;
          chrome.runtime.sendMessage({ type: "ft:list-changed", peers: changed }).catch(() => {});
        }
      }

      const thread = readThread();
      if (!thread.ok) return;
      // No message ids exist here, so the fingerprint is the count plus the
      // last inbound text — enough to tell a new message from a repaint.
      const key = `${thread.threadId}:${thread.messages.length}:${thread.lastInbound?.text ?? ""}`;
      if (key === lastSeen) return;
      lastSeen = key;
      watch.threadSent += 1;
      chrome.runtime.sendMessage({ type: "ft:thread-changed", thread }).catch(() => {});
    } catch (err) {
      // A throw inside an observer callback is swallowed by the platform: the
      // watcher simply stops noticing things and nothing anywhere says so.
      // Recording it is what makes that visible to ft:probe.
      watch.lastError = err.message;
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ft:read":
            return respond({ ok: true, result: readThread() });
          case "ft:ready":
            return respond({ ok: true, result: ready() });
          case "ft:probe":
            return respond({ ok: true, result: probe() });
          case "ft:list-threads":
            return respond({ ok: true, result: listThreads() });
          case "ft:open-thread":
            return respond({ ok: true, result: await openThread(msg.label) });
          case "ft:whoami":
            return respond({ ok: true, result: readOwnHandle() });
          case "ft:where":
            return respond({ ok: true, result: { threadId: threadRef(), url: location.href } });
          case "ft:type":
            return respond({ ok: true, result: { typed: await typeIntoComposer(msg.text) } });
          case "ft:send-bubble":
            return respond({ ok: true, result: await sendBubble(msg.text, msg.expectThreadId ?? null) });
          case "ft:accept-request":
            return respond({ ok: true, result: acceptRequest({ dryRun: msg.dryRun }) });
          case "ft:read-photos":
            return respond({ ok: true, result: readPhotos() });
          case "ft:open-post":
            return respond({ ok: true, result: await openPost(msg.code) });
          case "ft:read-feed":
            return respond({ ok: true, result: readFeed(msg.limit, msg) });
          case "ft:read-post":
            // Same shape Instagram answers with — the worker reads
            // `alreadyCommented` off this object.
            return respond({ ok: true, result: { ...readPost(), alreadyCommented: ourCommentPresent(msg.ownHandle) } });
          case "ft:read-profile-posts":
            return respond({ ok: true, result: readProfilePosts(msg.limit) });
          case "ft:read-comments":
            return respond({ ok: true, result: readComments() });
          case "ft:read-comment-replies":
            return respond({ ok: true, result: await readCommentReplies(msg.ownHandle) });
          case "ft:post-comment":
            return respond({ ok: true, result: await postComment(msg.text, msg.ownHandle) });
          case "ft:post-comment-reply":
            return respond({ ok: true, result: await postCommentReply(msg) });
          case "ft:scroll-page":
            return respond({ ok: true, result: scrollPage(msg.by) });
          case "ft:read-notifications":
            return respond({ ok: true, result: readNotifications(msg.ownHandle, msg.limit) });
          case "ft:open-dm":
            return respond({ ok: true, result: await openDm({ dryRun: msg.dryRun }) });
          case "ft:open-followers":
            return respond({ ok: true, result: await openFollowers() });
          case "ft:list-followers":
            return respond({ ok: true, result: listFollowers() });
          case "ft:scroll-followers":
            return respond({ ok: true, result: scrollFollowers(msg.by) });
          case "ft:media-bytes":
            return respond({ ok: true, result: await mediaBytes(msg.url) });
          case "ft:send-photo":
            return respond({ ok: true, result: await sendPhoto(msg) });
          case "ft:clear-composer":
            return respond({ ok: true, result: (await clearComposer(), { cleared: true }) });
          // Naming the missing capability beats a generic refusal: reaching
          // here at all means a gate upstream let through a pass this platform
          // does not declare.
          default:
            return respond({ ok: false, error: `Threads has no ${msg?.type}` });
        }
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
    })();
    return true;
  });

  startWatch();
  console.debug("[FluidExtension] Threads adapter ready");
})();
