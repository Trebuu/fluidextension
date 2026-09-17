# Security

## Reporting a vulnerability

Please report privately through GitHub, not in a public issue:

**[Open a private security advisory](https://github.com/Trebuu/fluidextension/security/advisories/new)**

That form is private to the maintainers. Expect an acknowledgement within a few
days; please give us a reasonable window to ship a fix before disclosing.

Useful things to include: what an attacker can do, which platform adapter is
involved, and whether it needs a valid connector token.

## What this extension holds

**A connector token, in `chrome.storage.local`.** It is the credential for a
FluidTalk character and is deliberately kept in the service worker rather than
the page: a content script shares the DOM with Instagram, Threads, Telegram or
WhatsApp, so anything the token touched there would be reachable by the site.

## What it sends, and where

**To `talk.fluidvip.com`** — the conversation the character is answering, with
the connector token. That is the product.

**To `extension.fluidvip.com/releases/latest.json`** — a plain GET, at most once
every six hours, to learn whether a newer release exists. Chrome will not tell
an unpacked install that, so the check is ours. It is worth being precise about
what this is, because a phone-home in an automation tool deserves the scrutiny:
it **sends nothing** — no token, no handle, no version, no identifier, no
cookie. It is an unauthenticated request for a 262-byte static file, and the
comparison happens locally afterwards. The server learns an IP fetched a public
file, the same as loading the website would tell it.

Turning it off is deleting `FEED_URL` in `src/lib/update.js`; the failure path
already treats an unreachable feed as "no update".

Findings that would matter most:

- anything that exposes the token to a content script or to page JavaScript
- anything that lets a visited page drive the worker's message handlers
- a `world: "MAIN"` script (`src/content/*-mainworld.js`) leaking privileged
  state into the page

## Not vulnerabilities

- **`presets.json` contains a plaintext token.** That is what the file is. It is
  gitignored and CI fails if one is committed; protect it as you would any
  credential file.
- **The extension can send messages on your behalf.** That is the product. See
  the README for what is enabled by default before attaching it to an account.
- **A platform's DOM changed and an adapter broke.** That is a bug — please open
  a normal issue.

## Scope

This repository only. FluidTalk's hosted API is a separate service; report issues
with it to that service rather than here.
