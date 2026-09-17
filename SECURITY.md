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
