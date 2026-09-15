# FluidExtension

[![CI](https://github.com/Trebuu/fluidextension/actions/workflows/ci.yml/badge.svg)](https://github.com/Trebuu/fluidextension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Chrome (MV3) extension that answers direct messages on **Instagram, Telegram
Web and WhatsApp Web** with a [FluidTalk](https://talk.fluidvip.com) character,
driven from a side panel.

## What it does, and what is on by default

It is an automation tool, not a drafting aid: with stock settings it acts on its
own. Read this table before you point it at an account you care about.

| Capability | Default | What it does |
|---|---|---|
| `autoSend` | **on** | generates *and sends* a reply to every new inbound message |
| `acceptRequests` | **on** | accepts pending message requests |
| `followupsEnabled` | **on** | nudges leads who went quiet, on a stage ladder |
| `commentRepliesEnabled` | **on** | replies to replies to our own comments (4/h, 12/day) |
| `commentsEnabled` | **on** | **comments publicly on strangers' posts** (3/h, 5/day) |
| `outreachEnabled` | **on** | **cold-opens DMs with people who never wrote to us** (3/h, 15/day) |
| `scheduleEnabled` | off | when on, confines all of the above to set hours |
| `newThreadsPerHour` | 5 | caps *first* replies into never-answered threads (see below) |

Not every platform has every capability — the set is declared per platform in
`src/lib/platforms.js`. **Instagram has all of them; Telegram Web and WhatsApp
Web have DMs and follow-ups only**, so outreach, requests and both comment
features are Instagram-only in practice.

**Two of these contact people who never contacted us**: `outreachEnabled` (a
cold DM) and `commentsEnabled` (a public comment on a stranger's post). Turn
both off for reply-only behaviour. `commentsEnabled` is also gated a second time
server-side — FluidTalk keeps Comments off per workflow and fails closed — so
the local switch alone is not enough to make it write.

### Running this against a real account

Automating direct messages is against the terms of service of Instagram,
WhatsApp and Telegram. Accounts doing it get rate-limited, restricted or banned,
and the platforms change their DOM without warning — which is a defect class this
code handles but cannot eliminate. **You are responsible for what the account you
attach it to does to other people.** Use it on accounts you own and can afford to
lose, and treat the rate caps as the floor of good behaviour, not a target.

## How it fits together

```
instagram.com tab                    service worker                 FluidTalk
┌────────────────────┐   messages   ┌──────────────────┐   HTTPS   ┌──────────┐
│ content/instagram  │ ───────────► │ background.js    │ ────────► │ /api/v1/ │
│  reads the thread  │ ◄─────────── │  holds the token │ ◄──────── │ characters
│  types + sends     │              │  owns the rules  │           │  /chat   │
└────────────────────┘              └──────────────────┘           └──────────┘
                                            ▲
                                            │ chrome.runtime
                                    ┌───────┴────────┐
                                    │ sidepanel/     │  settings, transcript,
                                    │  (no logic)    │  generated reply, log
                                    └────────────────┘
```

**The connector token never reaches the page.** A content script shares the DOM
with Instagram, so the worker keeps the token and does the fetch; `host_permissions`
is what lets it call the API cross-origin.

## FluidTalk contract

`POST {apiBase}/api/v1/characters/chat`, header `X-Connector-Token: ftc_…`, body
`{platform, handle, message, own_username?, session_id?}`. Two things matter:

- **The token *is* the character.** There is no `character_id` field in this API;
  swapping the token swaps who replies.
- **`X-Connector-Token` and nothing else.** `bot_auth.py` reads one `APIKeyHeader`
  with no `Authorization` fallback, so a Bearer token is a 401 with no hint why.

A reply of `bubbles: []` is a normal outcome, not a failure — the character stays
silent when a turn is deduped, the lead is claimed by another of the owner's
accounts, or the plan is capped. The panel reports the reason rather than showing
"nothing happened".

### One token, several Instagram accounts

This is supported by design, and it is worth knowing exactly how, because the
behaviour changes with two flags on the Character.

A connector token resolves a **`StrategyBinding` = (owner, character, engine,
platform)**. Nothing in that binding names a platform *account* — so a token is
never "for" one Instagram account. Which account received the DM travels
per-request in the body as `own_username`, which is why this extension asks for
your Instagram username in Settings.

Two `Character` flags decide what happens when one character runs several
accounts. **Both default OFF:**

| Flag | OFF (default) | ON |
|---|---|---|
| `ignore_duplicate_leads` *(Pro+)* | every account answers the lead | first account to engage claims them; others get `ignored: lead_claimed_by_other_account` and write nothing |
| `separate_sessions_per_account` | **one session per (character, platform, handle)**, shared by all accounts — including funnel state | session is also keyed by the receiving account, so a lead can be COLD on one and CONVERTED on another |

The code's own framing: sharing is *"right for one persona spread over several
phones"*, and wrong for *"accounts run as independent personas off a shared
template"*.

`StrategyLead` — the Person, keyed `(character, platform, handle)` — stays shared
**either way**, so cross-platform identity, facts and memory are unaffected.

**The consequence to plan for** with the defaults: if one lead messages two of
your accounts, both reply *and* the second continues the first's conversation
mid-funnel, because the account is not part of the session's identity.

## Answering the inbox

**Chat → Start** walks the inbox and replies to every thread whose newest
message is theirs. The same run also drives follow-ups, comment replies and —
unless `outreachEnabled` is off — outreach, each behind its own cap.

Each thread is refused, cheaply and locally, before any billed FluidTalk call:

| Refusal | Why |
|---|---|
| the last message is ours | nothing is owed a reply |
| their last message is a placeholder | Instagram will not render it, so we cannot read what they said |
| never answered, and the hourly cap is spent | see below |

### The hourly cap on new conversations

`newThreadsPerHour` (default 5) limits **only threads we have never replied
in**. Answering somebody already talking to us is never throttled — that is a
reply they are waiting for, and delaying it just makes the account look
unresponsive. Starting conversations is the thing that looks automated when it
arrives in bursts, so that is what is counted.

It is recorded in `sendBubbles` — the one place a message actually goes out — so
sweep, auto mode and the manual Send button all count against the same budget. A
manual send is *recorded but never blocked*: a human choosing to answer someone
is not the burst the cap exists to prevent.

The window is a rolling hour kept in `storage.local`, **not** `storage.session`:
an MV3 worker is torn down whenever it goes idle, and a cap that forgets itself
every few minutes is not a cap.

### Unreadable messages

Instagram substitutes its own copy for message types the web client cannot
render ("Unsupported message — use the Instagram mobile app"). That text is
*Instagram's*, not the lead's. Feeding it to the character makes it answer a
sentence nobody sent, and the reply comes back plausible and generic — which is
exactly what hides the mistake. Seen live: a lead sent two such messages and the
character replied *"hey you sent that twice lol"*.

The bubble carries no structural marker, so detection is a **text heuristic and
therefore locale-bound** (`PLACEHOLDER_PATTERNS`); a locale it does not cover
falls through and is treated as a real message. Because of that, a thread whose
newest inbound is a placeholder is **refused outright** rather than answered from
an older message: when we cannot read what they last said, we do not reply.

## What it decides for you

Three things are fixed rather than configurable, because every alternative was
a way to get it wrong:

- **Production only.** One FluidTalk deployment. A stored staging base from an
  older build would send live DMs as a character that does not exist there, so
  `apiBase` is pinned on both read and write.
- **Auto.** It generates and sends on every new inbound message. The manual
  Generate / Insert / Send buttons still exist for one-off use.
- **The account is detected, not typed.** A typed handle has to match exactly or
  the lead reader treats our own profile link as the lead's — which surfaces as
  strange replies rather than as an error. See below for how it is read.

### Reading which account is signed in

The nav is no use: the DM view collapses it and it carries no profile link. Two
signals do work, both measured on the inbox and inside a thread:

1. the first `"username":"…"` in the page's embedded JSON is the viewer;
2. on the inbox, with no thread open, the only profile link on the page is ours.

(1) is used only when (2) confirms it, so a build whose JSON ordering changes
cannot quietly hand back a lead's handle instead.

## Reading Instagram's DOM

Instagram ships obfuscated per-build class names, so nothing here matches on a
class. The adapter uses ARIA roles (`grid` / `row` / `textbox`), `contenteditable`,
and **layout**.

Two constraints follow from that, and both are real:

- **Direction is decided by geometry.** An incoming and an outgoing message carry
  identical roles and classes; the only difference Instagram has never stopped
  making is that ours are right-aligned. So the account must run a **left-to-right
  language** — under an RTL locale every message is classified backwards.
- **Only the rendered tail is visible.** Instagram virtualises long threads, so
  the adapter sees recent messages, never full history. That is fine: FluidTalk
  keeps the real transcript server-side and resumes the session by handle.

Writing has one trap worth knowing: the composer is a **Lexical** editor that
repaints from its own model. Assigning `textContent` changes what you see and
leaves the model empty — the Send button stays disabled and Enter sends nothing,
silently. `document.execCommand("insertText")` is deprecated but is the one path
that still emits the `beforeinput`/`input` pair Lexical commits on.

**Sending is confirmed against the thread, not the click.** A click Instagram
ignored looks exactly like one it accepted, so `sendBubble` polls until the text
appears as an outgoing row before reporting success.

When any of this breaks, **Settings → Diagnose page** reports what each selector
actually matched, so a redesign is diagnosable from the panel instead of a stack
trace.

## Replies to our comments

Somebody answering a public comment is a conversation too, and it runs on
FluidTalk's `/comments/reply`, which returns a `decision` — `comment_reply`,
`drive_to_dm_nudge`, `skip`, `bow_out`. Every stop rule answers `ok: true` with
`reply: null`, so a refusal looks exactly like a success unless the reply text
itself is read; nothing is posted unless words came back.

**Where the replies are found: `/notifications/`, not our own history.** Opening
every post we ever commented on is a page load each and can only find replies
under comments this install made — the notification list names the posts where
something actually happened, including ones we have no record of. It is an
index, not the truth: it decides which page to open, and the post page decides
what gets answered. Neither matching rule reads Instagram's prose (a row is a
notification because it links to a post, and a reply because it links to *our*
handle — Reply prefills `@us`), because the account's interface language is not
ours to choose.

Three things about posting one are worth knowing before changing this code:

- **Pressing Reply is the permission to press Publish.** It arms Instagram's own
  reply state and prefills `@them`; with an empty composer the same Publish click
  posts a brand-new top-level comment addressed to nobody. The prefill must also
  name the person we meant — a comment's Reply control and its replies' sit 44px
  apart in one column.
- **Type the body, do not assign it.** Same reason as the DM composer above.
- **Instagram's own client cannot name the comment being replied to.** It puts
  the id through a JavaScript number and a comment id does not fit
  (`Number("18101000000015838") === 18101000000015840`), so the server files the
  reply as a top-level comment. `src/content/instagram-mainworld.js` runs in the
  MAIN world and repairs that one field. And because Instagram draws a
  just-posted comment inside whichever thread the composer was aimed at, the
  page right after Post agrees with what we intended either way — confirmation
  comes from **reloading the post**, and a reply that did not thread is logged.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this folder.
2. Open `instagram.com` and log in as the account you want to answer for.
3. Click the FluidExtension toolbar icon to open the side panel.
4. **Settings** → your Instagram username, the connector token, and a mode.
   **Test connection** confirms FluidTalk accepts the token.
5. Open a DM thread. **Chat** shows the conversation; **Generate reply** asks the
   character.

Requires Chrome/Chromium 114+ for `chrome.sidePanel`.

### Fleet configuration

`presets.json` in the extension folder, if present, is authoritative and
re-applied on every launch — one file configures every profile in a fleet that
shares the folder. It is **not** committed and is gitignored, because it carries
a connector token and its mere presence overrides local settings. Copy
`presets.example.json` and edit, or produce one with **Presets → Save → Export**.

## Development

There is no build step and no dependencies — it loads as-is.

```sh
node scripts/test-settings.mjs        # and test-presets / -schedule / -scheduler / -active-platform
node scripts/dev-browser.mjs          # launch a browser with the extension loaded
```

Two things about this codebase that cost real debugging time:

- **`node --check` lies about `src/background.js`.** The worker is
  `type: "module"`, and the plain form exits 0 on a hard SyntaxError. Use
  `node --input-type=module --check < src/background.js`. A parse failure there
  kills the whole extension backend, and a dead worker *hangs* rather than
  erroring — `chrome.runtime.sendMessage` never settles.
- **An unpacked extension can serve a stale worker even in a freshly launched
  browser.** `chrome.runtime.reload()` from any extension page re-reads from
  disk. Check the artifact by fetching the extension's own source for a string
  you just wrote, not by trusting that a restart re-read the folder.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — there is no build step, so a clone is a
dev environment. It also lists the two traps that reliably cost an afternoon
(`node --check` lying about the worker, and a stale worker in a fresh browser)
and the behaviours that are deliberate rather than accidental.

Security issues: please report privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — fork it, build it, ship it, commercial use included. Keep the
copyright notice and you are done.

### Third-party

- `src/vendor/geist-latin.woff2`, `geist-mono-latin.woff2` — [Geist](https://github.com/vercel/geist-font),
  © 2024 The Geist Project Authors, SIL Open Font License 1.1. See
  [`src/vendor/LICENSE-Geist.txt`](src/vendor/LICENSE-Geist.txt).
- `src/vendor/lg.css`, `lg-core.js` — the Liquid Glass material, part of this
  project and covered by the repository license.
