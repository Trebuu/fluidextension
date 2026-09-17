# Contributing

Thanks for looking. This is a small codebase with no build step — clone it, load
it unpacked, and you are developing.

## Getting set up

```sh
git clone https://github.com/Trebuu/fluidextension.git
cd fluidextension
node scripts/test-settings.mjs        # no install needed: no dependencies
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the
folder. Requires Chrome/Chromium 114+ for `chrome.sidePanel`.

`scripts/dev-browser.mjs` launches a browser with the extension already loaded
and a durable profile, so a platform login survives restarts. Re-logging in every
run is what trips a checkpoint, so prefer it over a fresh profile each time.

## Before you open a PR

```sh
for f in scripts/test-*.mjs; do node "$f"; done
```

CI runs those on Node 20, 22 and 24, plus parse checks and a manifest check.

## Two traps that will cost you an afternoon

These are not style preferences. Both produce silent failures that look like
something else entirely.

**`node --check` lies about `src/background.js`.** The service worker is
`type: "module"`, and the plain form exits **0** on a hard SyntaxError. Use:

```sh
node --input-type=module --check < src/background.js
```

A parse failure there kills the whole extension backend, and a dead MV3 worker
*hangs* rather than erroring — `chrome.runtime.sendMessage` never settles, which
reads like a slow network call.

**An unpacked extension can serve a stale worker even in a browser you just
launched.** `chrome.runtime.reload()` from any extension page re-reads from disk.
Verify which artifact is actually running by fetching the extension's own source
for a string you just wrote — not by trusting that a restart re-read the folder.

## Platform adapters

Each platform lives in `src/content/<platform>.js` and declares its capabilities
in `src/lib/platforms.js`. Instagram and Threads have all six (`dm`, `followups`,
`requests`, `comments`, `commentReplies`, `outreach`); Telegram and WhatsApp have
`dm` and `followups`.

A capability that works but can cost the account goes in `riskyCapabilities`
with a sentence saying what it costs, and a default of off for that platform in
`PLATFORM_OVERRIDES` (`src/lib/settings.js`). WhatsApp follow-ups are the one
example: they used to be omitted from `capabilities` instead, which hid the whole
settings block and the reason with it. Prefer a present control, defaulted off,
that explains itself — an absent one asserts the platform cannot do the thing,
which was false. `scripts/test-capabilities.mjs` asserts the capability, the
override and the warning stay together, so removing any one of them fails the
build rather than quietly restoring the hazard.

If you are touching a DOM adapter, the rules the existing ones follow:

- **Never match on a class name.** Instagram ships obfuscated per-build classes.
  Use ARIA roles, `contenteditable`, and layout.
- **Never match on interface prose.** The account's language is not ours to
  choose — these adapters have run against Polish UIs. Matching an English word
  is not a selector.
- **Confirm an action against the page, not against the click.** A click the site
  ignored looks exactly like one it accepted. Sends poll until the message
  appears as an outgoing row.
- **Type into editors, do not assign.** Instagram's composer is Lexical and
  repaints from its own model; assigning `textContent` updates what you see and
  leaves the model empty, so Send stays disabled and Enter sends nothing.

## Things that are deliberate

Please raise an issue before changing these — each is the way it is because the
alternative broke something real:

- **`apiBase` is pinned** on read and write. A stored staging base from an older
  build would send live DMs as a character that does not exist there.
- **The signed-in account is detected, not typed.** A typed handle that does not
  match exactly makes the lead reader treat our own profile link as the lead's,
  which surfaces as strange replies rather than as an error.
- **The hourly cap counts only never-answered threads.** Replying to someone
  already talking to us is deliberately unthrottled.
- **Follow-up stages are independent windows, not running totals.** `12,24,48`
  means 12h of silence, then 24h after that nudge, then 48h after that one.
  Repeats and unsorted input are valid schedules; sorting them rewrites the
  user's plan.

## Reporting a security issue

Please do not open a public issue — see [SECURITY.md](SECURITY.md).
