/**
 * Capability-declaration tests — run with `node scripts/test-capabilities.mjs`.
 *
 * WHAT IS UNDER TEST is the per-platform capability table in
 * `src/lib/platforms.js`, which is the only thing that decides whether a pass
 * runs at all. `supports()` is consulted before every outreach, comment,
 * comment-reply, request and follow-up pass, so a capability quietly dropped
 * from a list does not error anywhere — the pass simply stops happening, and
 * the panel shows the toggle as available while nothing acts on it. That is a
 * silent regression, and silent is exactly what a test is for.
 *
 * Nothing here touches the browser: the module has no `chrome` reference at
 * module scope, so it imports in node as-is.
 */

import assert from "node:assert/strict";
import { PLATFORMS, platformById, supports } from "../src/lib/platforms.js";
import { PLATFORM_DEFAULTS, PLATFORM_OVERRIDES } from "../src/lib/settings.js";

const ALL = ["dm", "followups", "requests", "comments", "commentReplies", "outreach"];
const ok = (name) => console.log(`  ok — ${name}`);

// ── Threads is at parity with Instagram ──────────────────────────────────────
//
// This is a claim the release was cut on, so it is worth a test rather than a
// sentence in a commit message. Every one of the six was exercised against the
// live account before it was declared; what this guards is the NEXT edit.
{
  const ig = platformById("instagram");
  const th = platformById("threads");
  assert.ok(ig && th, "both platforms are declared");

  assert.deepEqual([...th.capabilities].sort(), [...ig.capabilities].sort(),
    "Threads declares exactly Instagram's capability set");
  assert.deepEqual([...th.capabilities].sort(), [...ALL].sort(),
    "...and that set is all six");
  assert.deepEqual(th.blockedCapabilities ?? {}, {},
    "nothing is blocked on Threads — a blocked capability is a feature the panel offers and nothing performs");
  ok("Threads has all six capabilities, none blocked");
}

// ── the two platforms that are deliberately narrower ─────────────────────────
//
// Telegram never grew the surfaces (no requests folder we drive, no comments).
//
// WhatsApp DOES follow-ups and they are dangerous: one unsolicited nudge signed
// the linked session out on 2026-09-15. It used to be declared absent, which hid
// the switch and the reason with it; it is now a real capability, off by default
// for WhatsApp alone, carrying the sentence the panel shows. What is asserted
// here is that the three halves of that arrangement stay together — take away
// any one and it is either an unexplained risk or a silent block.
{
  const tg = platformById("telegram");
  assert.deepEqual([...tg.capabilities].sort(), ["dm", "followups"].sort());
  ok("Telegram is DMs and follow-ups");

  const wa = platformById("whatsapp");
  assert.deepEqual([...wa.capabilities].sort(), ["dm", "followups"].sort());
  assert.equal(supports(wa, "followups"), true, "the pass can actually run");
  assert.deepEqual(wa.blockedCapabilities ?? {}, {}, "nothing is blocked any more");

  const warning = wa.riskyCapabilities?.followups ?? "";
  assert.ok(warning.length > 40, "follow-ups are flagged RISKY with a real sentence");
  assert.match(warning, /sign|log/i, "...and the sentence says what it costs: the account");

  assert.equal(PLATFORM_OVERRIDES.whatsapp?.followupsEnabled, false,
    "...and WhatsApp starts with it OFF");
  ok("WhatsApp does follow-ups: enabled=false by default, flagged risky, not blocked");
}

// ── off-by-default must not become a block ───────────────────────────────────
//
// The override is a STARTING value. If it were applied over the stored settings
// instead of under them, switching it on would silently undo itself on the next
// read — a block wearing a default's clothes, and the exact failure this change
// exists to avoid.
{
  for (const [id, over] of Object.entries(PLATFORM_OVERRIDES)) {
    const p = platformById(id);
    assert.ok(p, `${id}: overrides name a real platform`);
    for (const key of Object.keys(over)) {
      assert.ok(Object.hasOwn(PLATFORM_DEFAULTS, key),
        `${id}: "${key}" is a per-platform setting, not a global one`);
    }
  }
  // Only a platform that HAS the capability may default it off; defaulting a
  // capability nobody has is a line that does nothing and reads as if it does.
  assert.ok(supports(platformById("whatsapp"), "followups"));
  ok("every override targets a real platform and a real per-platform setting");
}

// ── the table itself stays well-formed ───────────────────────────────────────
{
  for (const p of PLATFORMS) {
    assert.ok(p.id && p.label && p.origin, `${p.id}: has id, label and origin`);
    assert.ok(p.origin.startsWith("https://"), `${p.id}: origin is an https origin`);
    assert.ok(!p.origin.endsWith("/"), `${p.id}: origin carries no trailing slash — platformForUrl appends one`);
    assert.ok(Array.isArray(p.capabilities) && p.capabilities.length,
      `${p.id}: declares at least one capability`);

    for (const c of p.capabilities) {
      assert.ok(ALL.includes(c), `${p.id}: "${c}" is a capability the worker knows`);
      assert.equal(supports(p, c), true, `${p.id}: supports("${c}")`);
    }

    // A capability cannot be both available and blocked — one of the two is a
    // mistake, and which one is not guessable from here.
    for (const c of Object.keys(p.blockedCapabilities ?? {})) {
      assert.ok(ALL.includes(c), `${p.id}: blocked "${c}" is a real capability`);
      assert.ok(!p.capabilities.includes(c),
        `${p.id}: "${c}" is both declared and blocked`);
      assert.ok((p.blockedCapabilities[c] ?? "").length > 20,
        `${p.id}: the block on "${c}" carries a reason`);
    }

    // The mirror image: a RISKY capability must be one the platform actually
    // has. Flagging a capability nobody declared puts a warning on a control
    // that is not on screen, which is a warning nobody will ever read.
    for (const c of Object.keys(p.riskyCapabilities ?? {})) {
      assert.ok(ALL.includes(c), `${p.id}: risky "${c}" is a real capability`);
      assert.ok(p.capabilities.includes(c),
        `${p.id}: "${c}" is flagged risky but not declared — nothing would show it`);
      assert.ok(!Object.hasOwn(p.blockedCapabilities ?? {}, c),
        `${p.id}: "${c}" cannot be both blocked and merely risky`);
      assert.ok((p.riskyCapabilities[c] ?? "").length > 40,
        `${p.id}: the risk on "${c}" explains itself`);
    }

    // Every capability needs somewhere to go. `dm` is the exception: the inbox
    // route is the platform's home page for the ones without a separate one.
    assert.ok(typeof p.routes?.home === "function", `${p.id}: has a home route`);
  }
  ok(`${PLATFORMS.length} platform declarations are well-formed`);
}

console.log("\ncapabilities: all assertions passed");
