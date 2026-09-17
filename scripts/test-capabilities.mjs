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
// WhatsApp CAN do follow-ups and must not: one unsolicited nudge signed the
// linked session out on 2026-09-15. Asserting the block stops a well-meaning
// "why is this off?" edit from costing another session.
{
  const tg = platformById("telegram");
  assert.deepEqual([...tg.capabilities].sort(), ["dm", "followups"].sort());
  ok("Telegram is DMs and follow-ups");

  const wa = platformById("whatsapp");
  assert.deepEqual(wa.capabilities, ["dm"]);
  assert.ok(wa.blockedCapabilities?.followups,
    "follow-ups are blocked on WhatsApp WITH a reason attached");
  assert.equal(supports(wa, "followups"), false);
  ok("WhatsApp is DMs only, follow-ups blocked with a reason");
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

    // Every capability needs somewhere to go. `dm` is the exception: the inbox
    // route is the platform's home page for the ones without a separate one.
    assert.ok(typeof p.routes?.home === "function", `${p.id}: has a home route`);
  }
  ok(`${PLATFORMS.length} platform declarations are well-formed`);
}

console.log("\ncapabilities: all assertions passed");
