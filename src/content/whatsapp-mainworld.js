/**
 * WhatsApp Web's own data model, read from the page.
 *
 * WHY THIS FILE EXISTS, and why it is not an optimisation.
 *
 * The three things this product cannot get wrong are WHO a message is from,
 * WHICH conversation is on screen, and WHAT to key the lead by. Measured
 * against a real logged-in account 2026-09-11, WhatsApp Web's DOM answers none
 * of them:
 *
 *   - **`.message-in` / `.message-out` DO NOT EXIST in this build.** Every
 *     guide to driving WhatsApp says they do; a live message row carries
 *     `class="x1n2onr6 xscbp6u"` and `document.querySelectorAll(".message-in")`
 *     returns 0. Direction read that way is not merely unreliable, it is
 *     uniformly WRONG — every message classifies the same way, silently, and a
 *     thread of our own replies reads as a lead talking to us.
 *   - **No JID appears anywhere in the DOM.** Not on `#main`, not in the
 *     header, not on a chat-list row. A row offers a display NAME, which is
 *     exactly the identifier that made Instagram's follow-ups miss everyone
 *     whose handle is not their name (see [[fluidextension-project]]).
 *   - **A message row's `data-id` is a bare message id** (`3EB0895BC…`), not
 *     the `<fromMe>_<jid>_<id>` triple the IndexedDB keys use. So it carries
 *     neither direction nor conversation.
 *
 * What the page DOES expose is WhatsApp's own store, through the bundle's
 * module loader: `window.require("WAWebCollections")` hands back the live
 * `Chat`, `Msg` and `Contact` collections. From there `msg.id.fromMe` is
 * direction as WhatsApp itself records it, `chat.active` is the open
 * conversation, and `Cmd.openChatAt({chat})` opens one exactly — no row to
 * find, no name to match, no virtualised list to scroll.
 *
 * `window.require` is only reachable from the MAIN world (a content script's
 * `window` is a different object), which is the whole reason for this file.
 * Everything that ACTS on the page — typing, pressing send, reading a picture
 * out of a bubble — stays in the adapter next door, driving the real UI.
 *
 * WHEN THE STORE IS NOT THERE, THIS REFUSES. The module names are WhatsApp's
 * and will eventually be renamed by a build. A silent fall back to the DOM
 * would then key leads by display name and classify every message as incoming
 * — the two failures this file exists to prevent — so a missing module is
 * reported as an error the log can show, not papered over.
 */
(() => {
  "use strict";

  /**
   * The bundle is not loaded at `document_idle`, and the app boots slowly.
   *
   * Unlike Telegram's page script this one cannot resolve its modules once at
   * startup: `window.require` appears when WhatsApp's bundle evaluates, which
   * is after we run. So every call resolves lazily and waits, rather than
   * caching a failure from the first second of the page's life.
   */
  const BOOT_TIMEOUT_MS = 30000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Resolved once and kept. Without this every op pays the boot wait again,
   * and a diagnostic that makes four calls takes four times thirty seconds to
   * tell you the page is still starting — which reads as a hang, not a wait.
   */
  let resolved = null;

  async function modules() {
    if (resolved) return resolved;
    for (let waited = 0; waited < BOOT_TIMEOUT_MS; waited += 250) {
      if (typeof window.require === "function") {
        try {
          const collections = window.require("WAWebCollections");
          if (collections?.Chat && collections?.Contact) {
            resolved = {
              ...collections,
              Cmd: window.require("WAWebCmd").Cmd,
              me: window.require("WAWebUserPrefsMeUser"),
              widFactory: window.require("WAWebWidFactory"),
              findChat: window.require("WAWebFindChatAction"),
            };
            return resolved;
          }
        } catch {
          // Still booting: `require` exists before every module is registered.
        }
      }
      await sleep(250);
    }
    throw new Error("WhatsApp's own data model is not reachable on this page (WAWebCollections did not resolve)");
  }

  /**
   * Wait until WhatsApp has finished pulling history from the phone.
   *
   * **AN EMPTY CHAT LIST DURING A SYNC IS NOT AN EMPTY INBOX**, and the two are
   * indistinguishable from the outside. Measured here: a plain tab reload puts
   * WhatsApp on "Don't close this window. Your messages are downloading." for
   * tens of seconds, during which the store answers honestly with **zero
   * chats**. A run that reads then reports "sees 0 conversation(s)", treats the
   * inbox as finished and does nothing — every cycle, for ever. That is the
   * same failure Telegram's `inbox` route caused, arriving by a different door.
   *
   * `Cmd.isMainStreamReadyMd` is WhatsApp's own word for "the stream is up",
   * so this waits on that rather than on a chat count, which cannot tell a
   * syncing account from a genuinely empty one.
   */
  const SYNC_TIMEOUT_MS = 90000;

  async function ready(mods) {
    for (let waited = 0; waited < SYNC_TIMEOUT_MS; waited += 500) {
      if (mods.Cmd?.isMainStreamReadyMd) return true;
      await sleep(500);
    }
    throw new Error("WhatsApp is still downloading messages — the chat list cannot be read yet");
  }

  /** A Backbone-ish collection's models, whichever accessor this build uses. */
  const modelsOf = (c) => (c?.getModelsArray ? c.getModelsArray() : (c?.models ?? []));

  // ── who is who ─────────────────────────────────────────────────────────────

  /**
   * Conversations that are not a person, keyed by the JID's server part.
   *
   * `@g.us` is a group and `@newsletter` a channel — answering either would
   * broadcast a one-to-one reply to everybody in it. `@broadcast` covers both
   * status updates and broadcast lists, which are not conversations at all.
   */
  const NOT_A_PERSON = /@(g\.us|newsletter|broadcast)$/;

  /** WhatsApp's own service account. Same id on every account on the platform,
   *  the way Telegram's login-code peer is always 777000. */
  const SERVICE_JIDS = new Set(["0@c.us", "status@broadcast"]);

  /**
   * The phone number a JID belongs to, or null when it cannot be known.
   *
   * TWO SHAPES ARE BOTH NORMAL, which is the thing to get right. A classic JID
   * is `<number>@c.us` (`@s.whatsapp.net` in some records) and the number is
   * right there. But WhatsApp is migrating to **LID** — a per-account privacy
   * id, `<digits>@lid` — and it is not an edge case: measured here, even the
   * account's own self-chat opens as `123456789012345@lid`. A LID is stable
   * but meaningless outside this device, so filing a lead under one would make
   * the same human a different person on another account.
   *
   * `Contact.phoneNumber` is WhatsApp's own LID → number mapping and is the
   * only honest way across. When there is no mapping we return null and the
   * caller refuses the chat, exactly as the Telegram adapter refuses a chat
   * with no @username: a conversation we cannot key is one we must not answer.
   */
  function handleForJid(jid, { Contact }) {
    if (!jid || NOT_A_PERSON.test(jid)) return null;
    const direct = /^(\d+)@(c\.us|s\.whatsapp\.net)$/.exec(jid);
    if (direct) return direct[1];
    if (!/@lid$/.test(jid)) return null;

    const contact = modelsOf(Contact).find((c) => c.id?._serialized === jid);
    const pn = contact?.phoneNumber?._serialized ?? contact?.phoneNumber ?? null;
    const mapped = typeof pn === "string" ? /^(\d+)@/.exec(pn) : null;
    return mapped ? mapped[1] : null;
  }

  /**
   * Why this chat may not be answered, or null when it may.
   *
   * Ordered so the most specific reason wins, because the reason is what the
   * run logs — "skipped 3" is the same number whether they were groups or
   * conversations we simply had nothing to say in.
   */
  function refusalFor(chat, mods, ownJids) {
    const jid = chat?.id?._serialized ?? null;
    if (!jid) return "no_chat_id";
    if (SERVICE_JIDS.has(jid)) return "whatsapp_service_account";
    if (chat.isGroup || /@g\.us$/.test(jid)) return "group";
    if (/@newsletter$/.test(jid)) return "channel";
    if (/@broadcast$/.test(jid)) return "broadcast";
    if (ownJids.has(jid)) return "own_chat";
    // `canSend` is WhatsApp's own word for a thread we are not allowed to write
    // in — the PSA chat answers false and its composer is replaced by "Only
    // WhatsApp can send messages". Generating a reply for one would spend a
    // billed turn on something that could never be delivered.
    //
    // ⚠ It does NOT cover Meta's official accounts: "Instagram" is a verified
    // business you genuinely can message, so canSend is true. That is the
    // separate check below, and the one whose absence signed the account out.
    if (chat.canSend === false || chat.isReadOnly) return "read_only_chat";
    if (chat.isPSA === true) return "whatsapp_service_account";
    if (isOfficialAccount(jid, mods)) return "official_account";
    if (isBot(jid, mods)) return "bot_account";
    if (!handleForJid(jid, mods)) return "no_phone_number_for_this_chat";
    return null;
  }

  /**
   * Is this a bot?
   *
   * The same rule as the Telegram adapter's, for the same reason: a character
   * replying to a bot is two programs talking, so there is no setting in which
   * the answer is yes. WhatsApp has no "ends in bot" convention, but it does
   * keep a `BotProfile` collection, and Meta AI is a fixed JID.
   *
   * NOTE this is the one refusal here that has not been exercised against a
   * real bot chat — this account has none. It is written to fail toward
   * skipping rather than toward answering, and wrapped so that a renamed
   * collection cannot take the whole read down with it.
   */
  const META_AI_JIDS = new Set(["13135550002@c.us", "867051314767696@lid"]);

  /**
   * Is this one of WhatsApp's OFFICIAL accounts — Instagram, Meta, a carrier,
   * a bank — rather than a person?
   *
   * WHY THIS EXISTS: messaging one got the account signed out. The official
   * "Instagram" contact is a verified Meta business, and it passed every
   * refusal above — it is not a group, not a bot in `BotProfile`, not Meta AI's
   * fixed JID, it has a real phone number, and `canSend` is TRUE because you
   * genuinely can write to it. The comment on the `canSend` check was right
   * about the PSA chat and wrong about this: a read-only announcement channel
   * and a messageable official business are different things.
   *
   * ⚠ `isBusiness` IS DELIBERATELY NOT A REASON TO REFUSE, and this is the
   * whole judgement in this function. Any WhatsApp Business account sets it —
   * a one-person shop, a freelancer, a lead running their side business off
   * the same number. Refusing on it would silently stop answering a slice of
   * real leads, which is a worse and much quieter failure than the one being
   * fixed here.
   *
   * What separates an OFFICIAL account is verification, which is rare and
   * granted by Meta: `verifiedName` / `verifiedLevel` (the green tick),
   * `isEnterprise` (reached through the Business API rather than the app), and
   * `isPSA` (WhatsApp's own announcements). A small business has none of them.
   *
   * Every read is guarded: a renamed field must make this return false and let
   * the other refusals do their job, not throw and take the whole chat list
   * down with it.
   */
  function isOfficialAccount(jid, { Contact }) {
    try {
      const c = modelsOf(Contact).find((x) => x.id?._serialized === jid);
      if (!c) return false;
      if (c.isPSA === true) return true;
      if (c.isEnterprise === true) return true;
      // A verified NAME is the green tick. Businesses without one are ordinary
      // accounts and stay answerable.
      if (typeof c.verifiedName === "string" && c.verifiedName.length > 0) return true;
      if (typeof c.verifiedLevel === "number" && c.verifiedLevel > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  function isBot(jid, { BotProfile }) {
    if (META_AI_JIDS.has(jid)) return true;
    try {
      return modelsOf(BotProfile).some((b) => b.id?._serialized === jid || b.id === jid);
    } catch {
      return false;
    }
  }

  /** Every JID that is us — a phone one and a LID one, both real. */
  function ownJidsOf({ me }) {
    const out = new Set();
    for (const read of ["getMaybeMePnUser", "getMaybeMeLidUser"]) {
      try {
        const wid = me[read]?.();
        if (wid?._serialized) out.add(wid._serialized);
      } catch {
        // An account half-way through restoring has neither yet.
      }
    }
    return out;
  }

  // ── reading messages ───────────────────────────────────────────────────────

  /**
   * Message types that are not somebody talking.
   *
   * These are WhatsApp's own bookkeeping — key changes, "messages are
   * end-to-end encrypted", group joins, missed calls, a deleted message's
   * tombstone. They carry no body, so left in they would reach the character as
   * empty messages, and `lastInbound` would become one of them: the same defect
   * as Instagram's "unsupported message" placeholder being answered as though
   * the lead had typed it.
   */
  const NOT_SPEECH = new Set([
    "e2e_notification", "notification_template", "gp2", "broadcast_notification",
    "call_log", "protocol", "revoked", "ciphertext", "groups_v4_invite",
    "payment", "oversized", "keep_in_chat", "interactive",
  ]);

  /** What kind of thing a message is, in the vocabulary the worker already uses. */
  function kindOf(msg) {
    switch (msg.type) {
      case "chat": return "text";
      case "image": return "photo";
      case "video": return msg.isGif ? "gif" : "video";
      case "sticker": return "sticker";
      case "ptt": return "voice";
      case "audio": return "audio";
      case "document": return "document";
      case "location":
      case "live_location": return "location";
      case "vcard":
      case "multi_vcard": return "contact";
      case "poll_creation": return "poll";
      default: return msg.type ?? "unknown";
    }
  }

  /** Media kinds whose picture the adapter can actually fetch out of the DOM. */
  const VIEWABLE = new Set(["photo", "video", "gif", "sticker"]);

  function readMessages(chat, limit) {
    const out = [];
    for (const m of modelsOf(chat?.msgs)) {
      if (NOT_SPEECH.has(m.type)) continue;
      const kind = kindOf(m);
      // A CAPTION IS THE LEAD TALKING, so it is their text — the same rule the
      // Telegram adapter learned the hard way, where a captioned video had a
      // real sentence thrown away and was answered as a silent attachment.
      const text = String((m.type === "chat" ? m.body : m.caption) ?? "").trim();
      if (!text && kind === "text") continue;
      out.push({
        id: m.id?.id ?? null,
        // DIRECTION, as WhatsApp itself recorded it when the message arrived.
        // Not geometry (Instagram), not a class (Telegram), and emphatically
        // not `.message-out`, which does not exist in this build.
        side: m.id?.fromMe ? "out" : "in",
        text,
        kind,
        // The picture is NOT read here. A blob url belongs to the page that
        // created it and the bytes have to come out of the rendered bubble, so
        // the adapter joins this id to `[data-id]` in the DOM and reads it
        // there. Saying whether there is one to look for is this side's job.
        hasMedia: VIEWABLE.has(kind),
        unreadable: kind !== "text" && !VIEWABLE.has(kind) && !text,
        at: m.t ? m.t * 1000 : null,
      });
    }
    out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return out.slice(-limit);
  }

  // ── the operations the adapter asks for ────────────────────────────────────

  const OPS = {
    async me(_args, mods) {
      const pn = (() => { try { return mods.me.getMaybeMePnUser()?._serialized ?? null; } catch { return null; } })();
      const lid = (() => { try { return mods.me.getMaybeMeLidUser()?._serialized ?? null; } catch { return null; } })();
      const digits = pn ? /^(\d+)@/.exec(pn)?.[1] ?? null : null;
      // Reported, never waited on — this is the one op a diagnostic can always
      // reach, so it has to answer while the app is still syncing rather than
      // block for ninety seconds and look like a hang.
      return { handle: digits, pn, lid, via: "store", synced: Boolean(mods.Cmd?.isMainStreamReadyMd) };
    },

    async active(_args, mods) {
      const chat = modelsOf(mods.Chat).find((c) => c.active);
      if (!chat) return { jid: null };
      return { jid: chat.id?._serialized ?? null, handle: handleForJid(chat.id?._serialized, mods) };
    },

    /**
     * Every conversation, from WhatsApp's own list rather than the sidebar.
     *
     * The rendered chat list is VIRTUALISED — only the rows on screen exist in
     * the DOM, and they are `list-item-0…n` by screen position, so the same
     * element is a different conversation a moment later. Reading the store
     * sidesteps that entirely and also sees chats that have scrolled away.
     *
     * Archived chats are dropped. That is the user's own signal that they have
     * set the conversation aside, and it is the only place in this product
     * where the human has already said "not this one".
     */
    async chats(_args, mods) {
      await ready(mods);
      const own = ownJidsOf(mods);
      return modelsOf(mods.Chat)
        .filter((c) => !c.archive)
        .map((c) => ({
          // `label` is what the worker opens a row BY, and on WhatsApp it is
          // the JID — exact, unlike a display name.
          label: c.id?._serialized ?? null,
          jid: c.id?._serialized ?? null,
          handle: handleForJid(c.id?._serialized, mods),
          title: c.name ?? c.formattedTitle ?? null,
          unread: c.unreadCount ?? 0,
          at: c.t ? c.t * 1000 : null,
          refusal: refusalFor(c, mods, own),
        }))
        .filter((r) => r.jid)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    },

    /**
     * Open a conversation, exactly.
     *
     * `Cmd.openChatAt` takes an OPTIONS OBJECT — `{chat, chatEntryPoint,
     * msgContext, …}` — which is worth stating because passing the chat
     * positionally (the obvious call, and the one every example uses) throws
     * "Cannot read properties of undefined (reading 'id')" and the run then
     * reports a chat it never opened. Read off the function's own source.
     *
     * Proof is the store's `active` flag afterwards, not the call returning:
     * the lesson from [[fluidflow-goal-opens-the-wrong-thread]] is that an
     * unlanded open leaves the PREVIOUS conversation on screen and everything
     * downstream then answers whoever that was.
     */
    async open({ jid }, mods) {
      if (!jid) return { ok: false, reason: "no jid" };
      // Opening mid-sync finds no chat and reports "no chat for <jid>", which
      // reads as a lead who does not exist rather than as a page not ready.
      await ready(mods);
      const before = modelsOf(mods.Chat).find((c) => c.active)?.id?._serialized ?? null;
      if (before === jid) return { ok: true, jid, before, alreadyOpen: true };

      let chat = modelsOf(mods.Chat).find((c) => c.id?._serialized === jid);
      if (!chat) {
        // Not in the list yet — a follow-up may name somebody whose chat has
        // never been opened on this device. `findExistingChat` returns the
        // model itself; `findOrCreateLatestChat` returns `{chat, created}`.
        try {
          const wid = mods.widFactory.createWid(jid);
          chat = (await mods.findChat.findExistingChat(wid))
            ?? (await mods.findChat.findOrCreateLatestChat(wid))?.chat;
        } catch (err) {
          return { ok: false, reason: `no chat for ${jid}: ${err.message}`, before };
        }
      }
      if (!chat) return { ok: false, reason: `no chat for ${jid}`, before };

      try {
        await mods.Cmd.openChatAt({ chat });
      } catch (err) {
        return { ok: false, reason: `openChatAt refused: ${err.message}`, before };
      }

      for (let waited = 0; waited < 15000; waited += 250) {
        await sleep(250);
        if (modelsOf(mods.Chat).find((c) => c.active)?.id?._serialized === jid) {
          return { ok: true, jid, before };
        }
      }
      return { ok: false, reason: "the chat did not become the open one", before };
    },

    /**
     * The decrypted bytes of one message's media, as a url the adapter can fetch.
     *
     * ⚠ **A WHATSAPP MEDIA BUBBLE CONTAINS NO MEDIA ELEMENT AT ALL** until the
     * user plays it. Measured on a real inbound video: the row was present in
     * the DOM and held **no `<video>`, no `<img>`, no canvas** — only a
     * `media-play` icon and the duration. Instagram at least renders a poster
     * image, so the DOM reader that worked there finds literally nothing here,
     * returns null, and the video is dropped: the character then answered from
     * the CAPTION alone ("Do you like my setup?" → "is that even your setup
     * lol") and it read perfectly naturally. Nothing in the log said a video
     * had arrived, because nothing had failed — we simply never looked.
     *
     * The store had it all along. `mediaData.mediaStage` was already
     * `"RESOLVED"` and `mediaData.renderableUrl` is a `blob:` that fetches back
     * the whole file (measured: `video/mp4`, 293475 bytes, exactly `msg.size`).
     * So media is read from the store like everything else here, and the DOM —
     * scrolling, waiting for a paint, pressing play — drops out of the problem
     * entirely. Pressing play was tried first and did nothing anyway.
     *
     * A blob url crosses into the content script because it is keyed by ORIGIN,
     * not by world.
     */
    async media({ id }, mods) {
      const chat = modelsOf(mods.Chat).find((c) => c.active);
      if (!chat) return { ok: false, reason: "not_on_thread" };
      const msg = modelsOf(chat.msgs).find((m) => m.id?.id === id);
      if (!msg) return { ok: false, reason: `no message ${id} in the open chat` };

      // Not downloaded yet — ask for it. `isUserInitiated` matters: the
      // function returns early for an untrusted message without it.
      if (msg.mediaData?.mediaStage !== "RESOLVED" && typeof msg.downloadMedia === "function") {
        try {
          await msg.downloadMedia({ downloadEvenIfExpensive: true, isUserInitiated: true, rmrReason: 1 });
        } catch (err) {
          return { ok: false, reason: `download refused: ${err.message}`, stage: msg.mediaData?.mediaStage ?? null };
        }
        for (let waited = 0; waited < 20000 && msg.mediaData?.mediaStage !== "RESOLVED"; waited += 400) {
          await sleep(400);
        }
      }

      const stage = msg.mediaData?.mediaStage ?? null;
      let url = null;
      try {
        url = msg.mediaData?.renderableUrl ?? null;
      } catch {
        url = null;
      }
      if (!url) return { ok: false, reason: `no decrypted media (stage ${stage})`, stage };

      return {
        ok: true,
        url,
        stage,
        kind: kindOf(msg),
        mime: msg.mimetype ?? null,
        bytes: msg.size ?? null,
        // Seconds, as WhatsApp records it. Worth carrying because a very short
        // clip is the one input vision answers with confident FICTION rather
        // than failing — see [[fluidextension-telegram]].
        durationS: Number(msg.duration) || null,
        isVideo: ["video", "gif"].includes(kindOf(msg)),
      };
    },

    /** The open conversation and its messages, with every refusal already applied. */
    async thread({ limit = 40 }, mods) {
      const chat = modelsOf(mods.Chat).find((c) => c.active);
      if (!chat) return { ok: false, reason: "not_on_thread" };

      const jid = chat.id?._serialized ?? null;
      // `own_chat` is deliberately NOT refused here, only in the list: the
      // self-chat is the one conversation available for testing on a fresh
      // account, and it is harmless to read — every message in it is ours, so
      // there is never a `lastInbound` and nothing is ever generated or sent.
      const refusal = refusalFor(chat, mods, new Set());
      if (refusal) return { ok: false, reason: refusal, threadId: jid };

      const messages = readMessages(chat, limit);
      if (!messages.length) return { ok: false, reason: "no_messages", threadId: jid };

      return {
        ok: true,
        threadId: jid,
        handle: handleForJid(jid, mods),
        own: (await OPS.me({}, mods)).handle,
        title: chat.name ?? null,
        messages,
        neverAnswered: !messages.some((m) => m.side === "out"),
      };
    },
  };

  // ── the chat-list watch ────────────────────────────────────────────────────

  /**
   * Tell the adapter the moment a conversation we are NOT looking at changes.
   *
   * WHY THIS LIVES HERE AND NOT IN A MutationObserver. On Telegram the chat
   * list is in the DOM, so the watch is a synchronous `querySelectorAll` diff
   * in the content script. WhatsApp's sidebar cannot be used that way: it is
   * VIRTUALISED (only on-screen rows exist, keyed `list-item-0…n` by screen
   * POSITION, so the same element is a different conversation a moment later)
   * and it carries no JID at all. The store is the only place that knows.
   *
   * So the diff has to happen in this world. It is a poll rather than a
   * subscription because `Chat` is Backbone-ISH — `Chat.find()` exists here
   * with `findImpl` unwired, so the event API is not reliably the one the name
   * implies, and an event that silently never fires would mean a lead waiting
   * for ever. A poll that is wrong is a poll that is late; a subscription that
   * is wrong is silence.
   *
   * It is also genuinely cheap, which is the thing to check before calling
   * anything a poll: it reads an in-memory array that WhatsApp keeps updated
   * over its own socket. No DOM, no network, no IndexedDB, and above all it
   * never OPENS a conversation — which is what made the worker's 90-second
   * inbox sweep expensive.
   */
  const LIST_WATCH_MS = 2000;
  let lastList = null;

  function listSnapshot(mods) {
    const out = new Map();
    for (const c of modelsOf(mods.Chat)) {
      // Archived is the user's own "not this one" — the same signal `chats`
      // honours, and it must be honoured identically or the watch would wake
      // the worker for a row the sweep then refuses.
      if (c.archive) continue;
      const jid = c.id?._serialized;
      if (jid) out.set(jid, c.unreadCount ?? 0);
    }
    return out;
  }

  async function watchList() {
    for (;;) {
      let mods;
      try {
        mods = await modules();
      } catch {
        // Signed out, or the page is not WhatsApp yet. `modules()` has already
        // waited its own boot timeout, so this is not a hot loop — and the
        // baseline is dropped because whatever comes back is a new session.
        lastList = null;
        continue;
      }

      await sleep(LIST_WATCH_MS);

      try {
        // MID-SYNC THE STORE HONESTLY REPORTS NOTHING. Taking that as the
        // baseline would make every conversation look new the moment the
        // re-download finishes — the same trap that makes an empty chat list
        // read as an empty inbox.
        if (!mods.Cmd?.isMainStreamReadyMd) continue;
        const now = listSnapshot(mods);
        if (!now.size) continue;

        if (lastList === null) {
          lastList = now;
          continue;
        }

        const changed = [];
        for (const [jid, unread] of now) {
          const before = lastList.get(jid);
          // Absent before, or unread went UP. A count going DOWN is us reading
          // the chat, and treating that as a change would have the sweep wake
          // itself every time it opened one.
          if (before === undefined || unread > before) changed.push(jid);
        }
        lastList = now;

        if (changed.length) {
          window.postMessage({ source: "fluidextension-page", kind: "wa-list-changed", jids: changed }, "*");
        }
      } catch {
        // The store can be swapped out under us on a re-sync. One bad read is
        // not a reason to stop watching for the rest of the session.
      }
    }
  }

  watchList();

  // ── the bridge ─────────────────────────────────────────────────────────────

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d?.source !== "fluidextension" || d.kind !== "wa-store") return;

    let reply;
    try {
      const op = OPS[d.op];
      if (!op) throw new Error(`no such store op: ${d.op}`);
      reply = { ok: true, result: await op(d.args ?? {}, await modules()) };
    } catch (err) {
      reply = { ok: false, reason: err.message };
    }
    window.postMessage({ source: "fluidextension-page", kind: "wa-store-result", id: d.id, ...reply }, "*");
  });
})();
