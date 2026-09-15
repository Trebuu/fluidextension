/**
 * WhatsApp Web adapter — the same `ft:*` contract the Instagram and Telegram
 * adapters answer, so the worker above it does not change.
 *
 * THE SPLIT, and why it is not the same as the other two. Everything that has
 * to be RIGHT — who sent a message, which conversation is open, what to key the
 * lead by — comes from WhatsApp's own store through `whatsapp-mainworld.js`,
 * because the DOM genuinely does not contain those facts (see that file for the
 * measurements; the headline is that `.message-in`/`.message-out` do not exist
 * in this build and no JID appears anywhere on the page). Everything that has
 * to HAPPEN — typing, pressing send, reading the picture out of a bubble —
 * stays here, driving the real UI the way a person does.
 *
 * The two halves are joined by one key: a message's `data-id` attribute in the
 * DOM is exactly `msg.id.id` in the store. Verified on live messages.
 *
 * Measured against a real logged-in account 2026-09-11:
 *   - The composer is a **Lexical** editor, like Instagram's, so
 *     `execCommand("insertText")` is the one path that commits (assigning
 *     `textContent` leaves the model empty and Send never arms).
 *   - The send control appears only once there IS text — the same shape as
 *     Instagram collapsing its media buttons into Send, and Telegram's button
 *     being the voice recorder when empty. Its `aria-label` is localised
 *     ("Send"), so it is found by `data-icon`, which is not.
 *   - `.click()` does NOTHING on a chat-list row. It does not matter here,
 *     because a chat is opened through the store instead.
 */
(() => {
  "use strict";

  const MAX_HISTORY = 40;
  const norm = (s) => (s ?? "").replace(/[\s ]+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Frame capture and re-encoding, shared with the other two adapters. */
  const { toB64, captureVideoFrame, shrinkVideo } = window.__ftMedia;

  /** `/inbound-media` refuses anything larger. */
  const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  // ── the bridge to WhatsApp's own model ─────────────────────────────────────

  /**
   * Ask the page-world script for something only it can see.
   *
   * Generous timeout because the first call can land while WhatsApp's bundle is
   * still evaluating — the page script waits for `window.require` rather than
   * failing, and a boot on a cold profile is slow.
   */
  const STORE_TIMEOUT_MS = 40000;

  /**
   * How long `ft:ready` may take to say "not yet".
   *
   * Comfortably under the worker's own 10s readiness deadline, because the
   * worker reads silence as a dead tab and now repairs dead tabs by itself.
   */
  const READY_ANSWER_MS = 4000;
  let storeSeq = 0;

  /**
   * Is this tab showing the QR login screen rather than an account?
   *
   * Read from the DOM rather than the store, because the store is exactly what
   * a signed-out page does not have — asking it produces the same silence as a
   * slow boot. `[data-ref]` is the QR canvas's own container; the text checks
   * are the fallback for when WhatsApp renames it, and are matched against
   * BOTH strings it shows so a relinking page counts too.
   */
  function signedOut() {
    if (document.querySelector("[data-ref]")) return true;
    const text = document.body?.innerText ?? "";
    return /scan the qr code|log in with phone number|link with phone number/i.test(text);
  }

  function askStore(op, args = {}) {
    return new Promise((resolve) => {
      const id = `w${(storeSeq += 1)}`;
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
        if (d?.source !== "fluidextension-page" || d.kind !== "wa-store-result" || d.id !== id) return;
        done(d);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "fluidextension", kind: "wa-store", id, op, args }, "*");
      // A page script that never answers — not injected, or threw while
      // loading — must not hold the whole run open. Saying which op stalled is
      // the difference between a diagnosable failure and a frozen sweep.
      setTimeout(() => done({ ok: false, reason: `WhatsApp's data model did not answer "${op}"` }), STORE_TIMEOUT_MS);
    });
  }

  /** The same, but throwing — for the places where a refusal IS the answer. */
  async function store(op, args) {
    const r = await askStore(op, args);
    if (!r.ok) throw new Error(r.reason);
    return r.result;
  }

  // ── the conversation on screen ─────────────────────────────────────────────

  function conversation() {
    return document.querySelector("#main");
  }

  function composer() {
    // Scoped to the conversation's footer on purpose. The search box is also a
    // text input and the media editor grows its own caption field; writing a
    // reply into either sends it nowhere, or attaches it to a photo.
    return conversation()?.querySelector('footer [contenteditable="true"][data-tab="10"]') ?? null;
  }

  /**
   * A message's picture or video.
   *
   * **PHOTOS AND VIDEOS LIVE IN DIFFERENT PLACES, and each is empty where the
   * other one is.** Both halves of that were measured the hard way, on two
   * real inbound messages a few minutes apart:
   *
   *  - **A VIDEO bubble contains no media element at all** until it is played.
   *    The row was in the DOM holding no `<video>`, no `<img>`, no canvas —
   *    only a `media-play` icon and the duration. Pressing play does nothing
   *    either. But the store has it: `mediaData.renderableUrl` is a `blob:`
   *    that fetches back the whole file.
   *  - **A PHOTO has no `renderableUrl`** — `mediaStage` reads `"RESOLVED"`
   *    and the url is `undefined`, `mediaBlob` is absent, and forcing
   *    `downloadMedia` does not create one. RESOLVED means the metadata
   *    resolved, not that there are bytes. But the rendered bubble DOES carry
   *    the full-resolution picture as a `blob:` `<img>` (measured 900×1600,
   *    the photo's real dimensions).
   *
   * So the store is asked first and the DOM is the fallback — and BOTH are
   * needed. Using either alone silently drops the other kind, which is exactly
   * what happened: the DOM-only version answered a video from its caption, and
   * the store-only version that fixed it then answered a photo with "what is
   * it haha".
   */
  async function mediaFor(id, kind) {
    const got = await askStore("media", { id });
    if (got.ok && got.result?.ok) return got.result;

    const fromDom = await mediaFromDom(id);
    if (fromDom) return { ok: true, ...fromDom, via: "dom" };

    return { ok: false, reason: got.result?.reason ?? got.reason ?? "no media found", kind };
  }

  /** The bubble's own rendered copy, for the kinds the store will not hand over. */
  async function mediaFromDom(id) {
    const rowFor = () => conversation()?.querySelector(`[data-id="${CSS.escape(id)}"]`) ?? null;

    // THE MESSAGE LIST IS VIRTUALISED — an older message has no row at all, so
    // there is nothing to read and nothing to scroll to. The run we answer sits
    // at the bottom, so going there is what mounts it.
    if (!rowFor()) {
      const pane = conversation()?.querySelector('[role="application"]') ?? conversation();
      pane?.scrollTo?.({ top: pane.scrollHeight });
      for (let waited = 0; waited < 3000 && !rowFor(); waited += 250) await sleep(250);
    }
    const row = rowFor();
    if (!row) return null;
    // Scrolling it into view is what makes WhatsApp paint the full picture; a
    // read taken before that finds only the tiny placeholder.
    row.scrollIntoView({ block: "center" });

    for (let waited = 0; waited < 8000; waited += 300) {
      const here = rowFor();
      const video = here?.querySelector("video");
      const src = video?.currentSrc || video?.src || "";
      if (src) return { url: src, isVideo: true, mime: null, bytes: null, durationS: null, kind: "video" };

      // A `blob:` only, and the BIGGEST one. The bubble also carries a 72×72
      // `data:` placeholder, and handing the model that instead of the photo
      // is the kind of wrong whose reply reads perfectly normally.
      const img = [...(here?.querySelectorAll("img") ?? [])]
        .filter((i) => String(i.src || "").startsWith("blob:") && i.naturalWidth > 0)
        .sort((a, b) => b.naturalWidth - a.naturalWidth)[0];
      if (img) return { url: img.src, isVideo: false, mime: null, bytes: null, durationS: null, kind: "photo" };

      await sleep(300);
    }
    return null;
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
   * It happened: two WhatsApp leads were re-answered at 10:00 on messages last
   * spoken at 07:56 and 09:11, and the character narrated the repeat herself —
   * "again!", "lol deja vu! still good." Nobody had written; there was nothing
   * to reply to.
   *
   * Read from the CONVERSATION, not from storage, so it cannot be forgotten.
   * If the last message is ours we are up to date, full stop.
   */
  function lastInbound(messages) {
    const last = messages[messages.length - 1];
    return last && last.side === "in" ? last : null;
  }

  /**
   * The open conversation, in the shape the worker expects from every adapter.
   *
   * The store decides everything about WHO and WHAT; this adds only the
   * picture, which is the one thing that lives in the page.
   */
  async function readThread() {
    const got = await askStore("thread", { limit: MAX_HISTORY });
    if (!got.ok) return { ok: false, reason: got.reason };
    const thread = got.result;
    if (!thread.ok) return thread;

    const { messages } = thread;
    const last = lastInbound(messages);

    // THE MEDIA TO READ IS NOT ALWAYS THE LAST MESSAGE. People send the picture
    // and then talk about it — video, then "what do you think?" — and the
    // worker answers the newest picture in the UNANSWERED RUN. Taking only the
    // last message means that in exactly that shape nothing is fetched at all,
    // and a fluent reply goes out about a picture nobody saw.
    const run = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].side === "in"; i -= 1) run.unshift(messages[i]);
    const target = [...run].reverse().find((m) => m.hasMedia) ?? null;

    if (target) {
      const found = await mediaFor(target.id, target.kind);
      if (found.ok) {
        Object.assign(target, {
          imageUrl: found.url,
          imageAlt: null,
          isVideo: Boolean(found.isVideo),
          mime: found.mime,
          bytes: found.bytes,
          durationS: found.durationS,
          unreadable: false,
        });
      } else {
        // Say WHY rather than letting a real picture read as an empty message.
        // `mediaError` travels up so the worker can LOG it: "they sent nothing"
        // and "they sent something we could not read" produced identical output
        // before, and that silence is what let a video and then a photo both
        // reach the character as blanks without one line anywhere saying so.
        target.unreadable = !target.text;
        target.mediaError = found.reason ?? "the media could not be read";
      }
    }

    return {
      ...thread,
      lastInbound: last,
      lastInboundUnreadable: Boolean(last?.unreadable),
      // THE REAL KIND, not the word "unsupported" — a voice note, a document, a
      // poll and a location are four different events and the character can
      // answer each of them naturally only if it is told which one happened.
      unreadableKind: last?.unreadable ? (last.kind ?? "unsupported") : null,
    };
  }

  // ── the chat list ──────────────────────────────────────────────────────────

  /**
   * The conversations worth opening.
   *
   * Read from the store, not the sidebar: the rendered list is VIRTUALISED, so
   * the DOM holds only the rows currently on screen and names them
   * `list-item-0…n` BY POSITION — the same element is a different conversation
   * a moment later. The store also sees the ones scrolled out of view.
   *
   * Refusals are applied here so a sweep never opens a group, a channel, our
   * own chat or a thread we are not allowed to write in.
   */
  async function listThreads() {
    const rows = await store("chats");
    return rows.filter((r) => !r.refusal);
  }

  async function openThread(label) {
    const got = await askStore("open", { jid: String(label ?? "") });
    if (!got.ok) return { clicked: false, before: null, reason: got.reason };
    const r = got.result;
    // `clicked` is the worker's word for "the open succeeded"; on this platform
    // nothing is clicked at all, the store is asked directly.
    return { clicked: Boolean(r.ok), before: r.before ?? null, reason: r.reason, alreadyOpen: Boolean(r.alreadyOpen) };
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /**
   * Type into the composer the way a keystroke does.
   *
   * WhatsApp's composer carries `data-lexical-editor="true"` — the same editor
   * Instagram uses, and the same rule follows: assigning `textContent` changes
   * what is on screen and leaves the editor's own model empty, so Send never
   * arms and Enter sends nothing, silently. `insertText` is deprecated and is
   * still the only path emitting the `beforeinput`/`input` pair Lexical commits
   * on.
   *
   * THREE THINGS THIS LEARNED THE HARD WAY, all from live messages.
   *
   * **It REPLACES whatever is in the box rather than appending.** A previous
   * attempt that inserted its text and then failed its own check leaves that
   * text sitting there, and a plain insert APPENDS: measured, two sends
   * produced the single delivered message "adapter send test 67762adapter send
   * test 84716". Nothing reported a problem — the second send verified happily,
   * because its own text really was in there. A reply carrying the wreckage of
   * an abandoned one is not something the reader can be asked to spot. The cost
   * is a human's unsent draft in that chat, which is the lesser harm and only
   * arises in a conversation we are already driving.
   *
   * **Clearing it needs `execCommand("selectAll")`, not a Range.** Lexical
   * keeps its own selection and ignores one built with `selectNodeContents` —
   * so the obvious "select the contents, then insert over them" is a silent
   * no-op, measured twice: the box still read LEFTOVER-DRAFT-XYZ and the
   * message went out concatenated anyway. `execCommand("delete")` is a no-op
   * here for the same reason. Four approaches were tried against a live
   * composer; `selectAll` + `insertText` and a run of Backspace keydowns are
   * the two that actually empty it.
   *
   * **The check has to wait.** Lexical re-renders asynchronously, so reading
   * `textContent` on the line after `execCommand` sees the OLD content and
   * reports failure for an insert that worked perfectly — which is how the
   * first leftover came to exist in the first place.
   */
  async function typeIntoComposer(text) {
    const box = composer();
    if (!box) return false;

    // Read first: this is what the check below proves we got RID of.
    const had = norm(box.textContent);

    box.focus();
    // Scoped by the focus above: `selectAll` acts on the focused editable, and
    // an insert into an unfocused page simply does nothing, which the check
    // below then reports honestly rather than sending something unexpected.
    document.execCommand("selectAll");
    await sleep(80);
    document.execCommand("insertText", false, text);

    // "Does it contain our text" is NOT enough, and that weakness is what let
    // the concatenation ship: the appended message contained the new text
    // perfectly well. So the leftover has to be gone too. Comparing against
    // what was actually read a moment ago — rather than against `text` — keeps
    // this honest for content `textContent` renders differently (WhatsApp
    // draws some emoji as images, whose characters never appear in it).
    const needle = norm(text).slice(0, 20);
    for (let i = 0; i < 20; i += 1) {
      const got = norm(box.textContent);
      if (got.includes(needle) && (!had || !got.includes(had))) return true;
      await sleep(100);
    }
    return false;
  }

  /**
   * The send control.
   *
   * Found by `data-icon`, never by label: the `aria-label` is "Send" on this
   * account and would be "Wyślij" on a Polish one, and matching an English word
   * is not a selector — the mistake that made the Instagram adapter unable to
   * send on its own operator's UI.
   */
  const SEND_ICON = '[data-icon="wds-ic-send-filled"]';

  function sendButton(within) {
    const scope = within ?? conversation()?.querySelector("footer");
    const icon = scope?.querySelector(SEND_ICON);
    return icon?.closest('button, [role="button"]') ?? null;
  }

  /**
   * The PHOTO EDITOR's send, as distinct from the chat's own.
   *
   * They wear the same icon, so "is there a send button anywhere" cannot tell
   * them apart — and that mattered: the editor-is-already-open guard below used
   * the document-wide form, so a composer that merely had text in it looked
   * like a stale editor and got an Escape. Escape closes the CONVERSATION here
   * (measured — `active` went null), which would leave the photo with nowhere
   * to go. The editor covers the conversation, so its button is the one that is
   * NOT inside the footer.
   */
  function editorSendButton() {
    const footer = conversation()?.querySelector("footer");
    const icon = [...document.querySelectorAll(SEND_ICON)].find((e) => !footer || !footer.contains(e));
    return icon?.closest('button, [role="button"]') ?? null;
  }

  /**
   * Send one message and confirm it against the conversation.
   *
   * Confirmed by the message appearing as an OUTGOING message IN THE STORE,
   * never by the click returning — a click WhatsApp ignored looks exactly like
   * one it accepted. The store is also the only place direction can be checked
   * at all on this platform.
   */
  async function sendBubble(text, expectThreadId = null) {
    const where = await askStore("active");
    if (!where.ok || !where.result?.jid) return { ok: false, reason: "not on a chat" };
    // The chat must still be the one this reply was written for — see the
    // Telegram adapter for the incident. A reply is composed for a thread and
    // sent seconds later, and anything may have moved the tab in between.
    if (expectThreadId && where.result.jid !== expectThreadId) {
      return {
        ok: false,
        reason: `the open conversation changed (wanted ${expectThreadId}, on ${where.result.jid}) — not sending`,
      };
    }
    if (!text) return { ok: false, reason: "refusing to send an empty message" };
    if (!composer()) return { ok: false, reason: "no composer on this screen" };

    const before = new Set((await store("thread", { limit: MAX_HISTORY })).messages?.map((m) => m.id) ?? []);
    if (!(await typeIntoComposer(text))) return { ok: false, reason: "the composer did not take the text" };

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
      const got = await askStore("thread", { limit: MAX_HISTORY });
      const landed = got.ok && got.result.ok
        ? got.result.messages.find((m) => m.side === "out" && !before.has(m.id) && m.text.includes(needle))
        : null;
      if (landed) return { ok: true, id: landed.id, text: landed.text };
    }
    return { ok: false, reason: "the message is not visible as an outgoing message after sending" };
  }

  /**
   * Send a photo, by pasting the bytes into the composer.
   *
   * PASTED, not handed to a file input — and the difference matters more here
   * than on Telegram, because WhatsApp has a file input that LOOKS right and is
   * not. The one input present on a fresh conversation is `accept="image/*"`
   * and it is the **sticker** input: measured, feeding a PNG to it produced a
   * `type: "sticker"` message, delivered, with no error anywhere. The photo
   * input (`accept="image/*,video/mp4,…"`) does not exist until the attach menu
   * has been opened and its — localised, icon-less — "Photos & videos" item
   * pressed. A paste needs none of that.
   *
   * WhatsApp then shows a CONFIRM step, an editor with its own send button,
   * rather than sending immediately.
   */
  async function sendPhoto({ dataB64, filename, mime, caption }) {
    const where = await askStore("active");
    if (!where.ok || !where.result?.jid) return { ok: false, reason: "not on a chat" };
    const box = composer();
    if (!box) return { ok: false, reason: "no composer on this screen" };

    // THE EDITOR ACCUMULATES. A previous attempt that was abandoned leaves its
    // image queued, and the next paste sends BOTH — measured, the button read
    // "Send 2 selected". Clear it before attaching rather than discovering it
    // by sending a stranger somebody else's picture.
    if (editorSendButton()) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      await sleep(600);
    }

    const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
    const file = new File([bytes], filename || "photo.jpg", { type: mime || "image/jpeg" });
    const before = new Set((await store("thread", { limit: MAX_HISTORY })).messages?.map((m) => m.id) ?? []);

    const dt = new DataTransfer();
    dt.items.add(file);
    box.focus();
    box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));

    let confirm = null;
    for (let i = 0; i < 40 && !confirm; i += 1) {
      await sleep(250);
      // Specifically the editor's, not the footer's — they share an icon.
      confirm = editorSendButton();
    }
    if (!confirm) return { ok: false, reason: "the photo editor never appeared" };

    // The caption goes in the EDITOR's own field, not the chat's. Writing to
    // the wrong one leaves the caption sitting in the composer to be sent
    // afterwards as a stray message.
    if (caption) {
      const capBox = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e !== box && !e.closest("footer"));
      if (capBox) {
        capBox.focus();
        document.execCommand("insertText", false, caption);
      }
    }

    confirm.click();

    for (let i = 0; i < 60; i += 1) {
      await sleep(300);
      const got = await askStore("thread", { limit: MAX_HISTORY });
      const landed = got.ok && got.result.ok
        ? got.result.messages.find((m) => m.side === "out" && !before.has(m.id) && m.kind !== "text")
        : null;
      // The KIND is reported back because WhatsApp decides it, not us: the same
      // bytes arrive as `photo` through the composer and as `sticker` through
      // the sticker input, and a caller told only "ok" cannot tell which.
      if (landed) return { ok: true, id: landed.id, kind: landed.kind };
    }
    return { ok: false, reason: "the photo is not visible as an outgoing message after sending" };
  }

  // ── media bytes ────────────────────────────────────────────────────────────

  /**
   * The bytes behind a `blob:` url, as base64.
   *
   * A blob url is registered in THIS page and resolvable nowhere else, so the
   * worker cannot download it the way it downloads an Instagram CDN link — and
   * on WhatsApp there is no url it could use instead, because media is
   * end-to-end encrypted on the CDN and only the page holds the key. The
   * store's own decrypted copy is the one place it exists.
   */
  async function rawBytes(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const type = blob.type || res.headers.get("content-type") || "";
      // IMAGE OR VIDEO, nothing else. Without this an error page would be
      // uploaded and handed to the model AS THE LEAD'S MEDIA, and the reply
      // comes back reading perfectly normally.
      if (!/^(image|video)\//.test(type)) {
        return { ok: false, reason: `not image or video (${type || "no type"}, ${blob.size} bytes)` };
      }
      // `mime` rides along on the REFUSAL too: the caller decides whether
      // there is a fallback worth trying, and only a video has one.
      if (blob.size > MAX_MEDIA_BYTES) {
        return { ok: false, reason: `too large (${blob.size} bytes)`, bytes: blob.size, mime: type };
      }
      return toB64(blob, type);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * A decoded `<video>` for a blob, built rather than found.
   *
   * `shrinkVideo` and `captureVideoFrame` both need a decoded element, and on
   * the other two platforms one is already on the page. Here the bubble has no
   * media element at all until it is played, so there is nothing to look up.
   * Detached from the document deliberately — it must not appear on screen or
   * make a sound — and muted, because a detached element still plays audio.
   */
  function decodeOffscreen(url) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      v.onloadeddata = () => done(v);
      v.onerror = () => done(null);
      setTimeout(() => done(null), 15000);
      v.src = url;
    });
  }

  async function mediaBytes(url) {
    if (!url) return { ok: false, reason: "no url" };

    // THE WHOLE FILE FIRST. Sending it entire is the best outcome and the
    // ordinary one here — WhatsApp compresses on the sender's phone, and the
    // video that exposed this whole path was 287 KB.
    const raw = await rawBytes(url);
    if (raw.ok) return raw;

    // Only a VIDEO has anywhere to fall back to. A photo over the ceiling is
    // simply too big, and trying to decode one as video would spend fifteen
    // seconds failing before saying so.
    if (!/^video\//.test(raw.mime ?? "")) return raw;

    // TWO STEPS DOWN, and only the last loses the motion — the same ladder the
    // Telegram adapter uses, for the same measured reason: the 10 MB ceiling is
    // about twelve seconds of phone video, so "too large" is an ordinary case.
    const why = raw.reason;
    const video = await decodeOffscreen(url);
    if (!video) return { ...raw, reason: `${why}; and it would not decode for re-encoding` };

    const small = await shrinkVideo(video, MAX_MEDIA_BYTES);
    if (small.ok) return { ...small, shrunkBecause: why, shrunk: { ...small.shrunk, from: raw.bytes ?? null } };

    const frame = await captureVideoFrame(video, "video");
    return frame.ok
      ? { ...frame, fellBackBecause: `${why}; ${small.reason}` }
      : { ...frame, reason: `${frame.reason} (after: ${why}; ${small.reason})` };
  }

  // ── diagnostics ────────────────────────────────────────────────────────────

  async function probe() {
    const who = await askStore("me");
    // STOP HERE WHILE IT IS STILL SYNCING. `chats` and `thread` wait for the
    // stream to be ready, so asking them now would block the diagnostic for a
    // minute and a half and report a hang instead of the one fact that matters.
    if (who.ok && who.result?.synced === false) {
      return { url: location.href, storeReachable: true, synced: false, own: who.result,
        note: "WhatsApp is still downloading messages — nothing can be read until it finishes" };
    }
    // And stop here when the page script is not answering at all. Every op
    // below would then wait out its own timeout in turn, so the diagnostic
    // that exists to report this fault would take four times as long as any
    // other call and read as a hang — burying the one line that explains it.
    if (!who.ok) {
      return { url: location.href, storeReachable: false, storeError: who.reason,
        note: "the page-world script did not answer — WhatsApp's data model is unreachable, so nothing below could be read" };
    }
    const active = await askStore("active");
    const thread = await askStore("thread", { limit: MAX_HISTORY });
    const chats = await askStore("chats");
    const msgs = thread.ok && thread.result.ok ? thread.result.messages : [];
    return {
      url: location.href,
      synced: who.ok ? who.result?.synced : null,
      // The single most useful line when nothing works: if this is false the
      // page script never reached WhatsApp's model and EVERY answer below is
      // meaningless, which is a completely different fault from an empty inbox.
      storeReachable: who.ok,
      storeError: who.ok ? null : who.reason,
      own: who.ok ? who.result : null,
      chat: active.ok ? active.result : null,
      threadOk: thread.ok ? thread.result.ok : false,
      threadReason: thread.ok ? (thread.result.reason ?? null) : thread.reason,
      chats: chats.ok ? chats.result.length : null,
      refusedChats: chats.ok ? chats.result.filter((c) => c.refusal).map((c) => `${c.title ?? c.jid}: ${c.refusal}`) : null,
      messagesParsed: msgs.length,
      incoming: msgs.filter((m) => m.side === "in").length,
      outgoing: msgs.filter((m) => m.side === "out").length,
      composerFound: Boolean(composer()),
      composerText: composer() ? norm(composer().textContent) : null,
      sendArmed: Boolean(sendButton()),
      // What KINDS are on screen and whether each yielded a picture. When a
      // photo reaches the character as an empty message, this says whether the
      // reader saw a photo at all or saw one and could not get at it — two
      // different faults that look identical in the log.
      kinds: msgs.reduce((acc, m) => {
        const key = `${m.kind}${m.hasMedia ? "+media" : m.unreadable ? "+unreadable" : ""}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      // Whether the newest inbound media can actually be fetched — the one
      // thing a media message's presence in the list does NOT tell you, since
      // the bubble renders nothing until it is played.
      newestMediaReadable: await (async () => {
        const m = [...msgs].reverse().find((x) => x.side === "in" && x.hasMedia);
        if (!m) return null;
        const r = await mediaFor(m.id, m.kind);
        return r.ok
          ? `${m.kind} via ${r.via ?? "store"}${r.mime ? ` ${r.mime}` : ""}${r.bytes ? ` ${r.bytes}B` : ""}${r.durationS ? ` ${r.durationS}s` : ""}`
          : `NO: ${r.reason}`;
      })(),
      tail: msgs.slice(-4),
    };
  }

  // ── new-message watch ──────────────────────────────────────────────────────

  let watchTimer = null;
  let lastSeen = "";

  function startWatch() {
    const observer = new MutationObserver(() => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(async () => {
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

  /**
   * The other half of the watch: a conversation that is NOT on screen.
   *
   * `startWatch` above only ever reports the OPEN chat, so a brand-new thread
   * was invisible to it and only the worker's periodic inbox sweep ever found
   * one — up to two minutes, and never at all when no run is going.
   *
   * Unlike Telegram this cannot be read from the DOM (virtualised sidebar, no
   * JID anywhere), so the page script diffs WhatsApp's own store and pushes
   * here. Unsolicited, so it carries no `id` and is not an `askStore` reply.
   *
   * The jids go over as-is: a WhatsApp chat's `label` in `ft:list-threads` IS
   * its jid, which is what the worker matches a woken cycle against. Whether
   * each one is worth answering — bot, group, archived, ourselves — is decided
   * there by the same refusals a scheduled cycle uses, never here.
   */
  function startListWatch() {
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (d?.source !== "fluidextension-page" || d.kind !== "wa-list-changed") return;
      if (!d.jids?.length) return;
      chrome.runtime.sendMessage({ type: "ft:list-changed", peers: d.jids }).catch(() => {});
    });
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ft:read":
            return respond({ ok: true, result: await readThread() });
          // Can this platform be worked RIGHT NOW? WhatsApp answers no while
          // it is pulling history from the phone, which it only finishes when
          // the tab is actually on screen — so the worker needs to be able to
          // ask, rather than discovering it as an empty inbox.
          case "ft:ready": {
            // SIGNED OUT IS NOT "STILL LOADING", and telling them apart is the
            // difference between a wait that ends and one that never can.
            // Measured: after the browser was killed and relaunched, WhatsApp
            // came back on its QR screen and this answered "still downloading
            // messages — it only finishes while the tab is on screen". The run
            // then waited politely for a sync that could never start, and the
            // panel said loading rather than the one thing a human had to do.
            if (signedOut()) {
              // `needsHuman` stops the worker trying to repair this. Nothing it
              // can do helps — and replacing the tab, which is its last resort
              // for a page that will not come good, would throw away the QR
              // code the moment before somebody scans it.
              return respond({
                ok: true,
                result: { ready: false, needsHuman: true, why: "signed out — scan the QR code on the WhatsApp tab" },
              });
            }
            // ANSWERED FAST, EVEN WHILE BOOTING — and that is the whole point
            // of this deadline. `askStore` waits 40s because a cold bundle is
            // slow to evaluate, but the worker gives a readiness probe only
            // 10s and treats silence as an UNREACHABLE TAB. So during every
            // WhatsApp boot this used to answer nothing, the platform was
            // filed as dead rather than loading, and now that repair is
            // automatic that verdict NAVIGATES THE TAB — interrupting the very
            // sync it was waiting on. A slow answer here is a repair loop.
            //
            // "Not ready yet" is a real answer and the honest one: it keeps
            // the platform in the loading state, where the worker waits.
            const me = await Promise.race([
              askStore("me"),
              new Promise((r) => setTimeout(() => r({ ok: false, booting: true }), READY_ANSWER_MS)),
            ]);
            if (me.booting) {
              return respond({ ok: true, result: { ready: false, why: "WhatsApp is still starting up on this tab" } });
            }
            if (!me.ok) return respond({ ok: true, result: { ready: false, why: "the page has not loaded WhatsApp's data model yet" } });
            return respond({
              ok: true,
              result: me.result?.synced
                ? { ready: true }
                : { ready: false, why: "still downloading messages — it only finishes while the tab is on screen" },
            });
          }
          case "ft:probe":
            return respond({ ok: true, result: await probe() });
          case "ft:list-threads":
            return respond({ ok: true, result: await listThreads() });
          case "ft:open-thread":
            return respond({ ok: true, result: await openThread(msg.label) });
          case "ft:whoami": {
            const who = await store("me");
            return respond({ ok: true, result: who.handle ? who : null });
          }
          case "ft:where": {
            const active = await askStore("active");
            return respond({ ok: true, result: { threadId: active.ok ? active.result.jid : null, url: location.href } });
          }
          case "ft:type":
            return respond({ ok: true, result: { typed: await typeIntoComposer(msg.text) } });
          case "ft:send-bubble":
            return respond({ ok: true, result: await sendBubble(msg.text, msg.expectThreadId ?? null) });
          case "ft:send-photo":
            return respond({ ok: true, result: await sendPhoto(msg) });
          case "ft:media-bytes":
            return respond({ ok: true, result: await mediaBytes(msg.url) });
          // Everything else belongs to a capability WhatsApp does not declare —
          // a feed, followers, a requests folder, public comments. Naming the
          // missing one beats a generic refusal: reaching here at all means a
          // capability gate upstream is wrong.
          default:
            return respond({ ok: false, error: `WhatsApp has no ${msg?.type}` });
        }
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
    })();
    return true;
  });

  startWatch();
  startListWatch();
  console.debug("[FluidExtension] WhatsApp adapter ready");
})();
