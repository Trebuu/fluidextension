/**
 * Log an Instagram account into the dev browser, over CDP.
 *
 * Dev-only helper. It reads the credentials from its OWN environment and types
 * them straight into the page, so the secret never passes through an agent's
 * transcript or a log line. Run it through FluidCode's credential broker:
 *
 *   run_with_credentials profile=default argv=[
 *     "node", "scripts/ig-login.mjs", "--port", "9333"
 *   ]
 *
 * Env: FLUIDFLOW_IG_USERNAME, FLUIDFLOW_IG_PASSWORD, FLUIDFLOW_IG_TOTP_SECRET?
 *
 * It NEVER prints a credential — only whether each one was present, and what
 * the page did. A brokered value that never materialised still looks like a
 * string, so the placeholder check below is what tells "wrong password" apart
 * from "the secret was never withdrawn".
 */

import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(flag("port", 9333));

const USER = process.env.FLUIDFLOW_IG_USERNAME ?? "";
const PASS = process.env.FLUIDFLOW_IG_PASSWORD ?? "";
const TOTP = process.env.FLUIDFLOW_IG_TOTP_SECRET ?? "";

/**
 * A brokered secret reaches a child as `__fluidcode_<slug>__` unless it was
 * actually materialised. Typing that placeholder into Instagram would be a
 * failed login attempt against a real account for no reason.
 */
const isPlaceholder = (v) => /^__fluidcode_[a-z0-9-]+__$/.test(v);

console.log(
  `credentials: username=${USER ? "present" : "MISSING"} password=${PASS ? "present" : "MISSING"} totp=${TOTP ? "present" : "absent"}`,
);
for (const [name, value] of [["username", USER], ["password", PASS], ["totp", TOTP]]) {
  if (value && isPlaceholder(value)) {
    console.error(
      `ABORT: ${name} is still a broker placeholder — it was never withdrawn. ` +
        `X-Connector-Token-style substitution only happens in HTTP headers at the egress proxy.`,
    );
    process.exit(2);
  }
}
if (!USER || !PASS) process.exit(2);

// ── TOTP ────────────────────────────────────────────────────────────────────

function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/[\s=]/g, "").toUpperCase()) {
    const v = A.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  return ((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).toString().padStart(6, "0");
}

// ── CDP ─────────────────────────────────────────────────────────────────────

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === undefined) return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(JSON.stringify(m.error)));
  else p.resolve(m.result);
});
const send = (method, params = {}, sessionId) => {
  const rid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    ws.send(JSON.stringify({ id: rid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = (await send("Target.getTargets")).targetInfos;
const page = targets.find((t) => t.type === "page" && t.url.includes("instagram.com"));
if (!page) {
  console.error("no instagram.com tab open in the dev browser");
  process.exit(3);
}
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);

const evaluate = async (expression) => {
  const res = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description);
  return res.result.value;
};

/** Focus a field and type into it as real key input, never via .value. */
async function typeInto(selector, text) {
  const found = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    el.select?.();
    return true;
  })()`);
  if (!found) return false;
  await send("Input.insertText", { text }, sessionId);
  return true;
}

/**
 * Resume where the browser already is.
 *
 * A re-run that navigates back to the login form submits the password a SECOND
 * time, and a burst of login attempts on one account is exactly the pattern
 * Instagram checkpoints for. If the browser is already sitting on the 2FA
 * screen, the credential step is already done — pick up from there.
 */
let url = await evaluate(`location.href`);
const resumingAt2fa = url.includes("two_step") || url.includes("two_factor");

if (resumingAt2fa) {
  console.log("resuming: already on the 2FA screen, not re-submitting the password");
} else {
  await send("Page.navigate", { url: "https://www.instagram.com/accounts/login/" }, sessionId);
  await sleep(5000);

  // Cookie consent sits over the form and swallows the first click.
  await evaluate(`(() => {
    for (const b of document.querySelectorAll('button')) {
      if (/allow all cookies/i.test(b.textContent)) { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(1500);

  // Instagram's current login form names its fields `email`/`pass` (the Meta
  // shape), not `username`/`password` — the older names are kept as a fallback
  // because both are served depending on the rollout the browser lands in.
  const USER_SEL = 'input[name="email"], input[name="username"]';
  const PASS_SEL = 'input[name="pass"], input[name="password"]';

  if (!(await typeInto(USER_SEL, USER))) {
    console.error("username field not found — page shape:", await evaluate(`location.href`));
    process.exit(4);
  }
  await sleep(400);
  await typeInto(PASS_SEL, PASS);
  await sleep(400);

  // There is no <button> on this form: the visible "Log in" is a div[role=button]
  // and the real submit input is hidden, so clicking by tag finds nothing.
  console.log(
    "submit via:",
    await evaluate(`(() => {
      for (const el of document.querySelectorAll('div[role="button"]')) {
        if (/^log ?in$/i.test(el.textContent.trim())) { el.click(); return 'role-button'; }
      }
      const form = document.querySelector('form');
      if (form) { form.requestSubmit?.() ?? form.submit(); return 'form.requestSubmit'; }
      const hidden = document.querySelector('input[type="submit"]');
      if (hidden) { hidden.click(); return 'hidden-input'; }
      return 'nothing-found';
    })()`),
  );

  // The login POST plus the redirect chain takes a while; poll rather than guess.
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500);
    if (!(await evaluate(`location.href`)).includes("/accounts/login/")) break;
    if ((await evaluate(`location.href`)).includes("two_step")) break;
  }

  url = await evaluate(`location.href`);
  console.log("after submit:", url.replace(/[?#].*$/, ""));
}

// ── 2FA ─────────────────────────────────────────────────────────────────────

/**
 * Focus the 2FA code box.
 *
 * On the current two_step_verification screen it is an input with NO name, no
 * aria-label and no placeholder — the only thing distinguishing it is that it
 * is the visible text input on the page. The login form's own `email`/`pass`
 * inputs are still in the DOM but hidden, so visibility is what separates them.
 */
async function focusCodeField() {
  return evaluate(`(() => {
    const named = document.querySelector(
      'input[name="verificationCode"], input[autocomplete="one-time-code"]');
    const el = named ?? [...document.querySelectorAll('input[type="text"]')]
      .find((i) => i.offsetParent !== null && !i.name);
    if (!el) return false;
    el.focus();
    el.select?.();
    return true;
  })()`);
}

const needs2fa = await evaluate(
  `/two.factor|two_step|security code|authentication app/i.test(document.body.innerText) || location.href.includes('two_step')`,
);

if (needs2fa) {
  if (!TOTP) {
    console.error("2FA challenged but no FLUIDFLOW_IG_TOTP_SECRET available");
    process.exit(5);
  }
  console.log("2FA challenged — entering TOTP");
  if (!(await focusCodeField())) {
    console.error(
      "2FA screen has no code field I recognise:",
      await evaluate(`document.body.innerText.slice(0,200).replace(/\\s+/g,' ')`),
    );
    process.exit(5);
  }
  // Generate the code AFTER the field is focused: a 30s step spent navigating
  // is a code that expires between being computed and being submitted.
  await send("Input.insertText", { text: totp(TOTP) }, sessionId);
  await sleep(400);

  // "Trust this device" makes this a one-off. Re-challenging on every dev run
  // is itself a risk signal, and the profile is durable precisely so it can be
  // answered once.
  console.log(
    "trust-device:",
    await evaluate(`(() => {
      const cb = document.querySelector('input[type="checkbox"]');
      if (cb && cb.offsetParent !== null && !cb.checked) { cb.click(); return true; }
      return false;
    })()`),
  );

  console.log(
    "2fa submit via:",
    await evaluate(`(() => {
      for (const b of document.querySelectorAll('div[role="button"], button')) {
        if (/^(confirm|continue|next|submit)$/i.test(b.textContent.trim())) { b.click(); return 'role-button'; }
      }
      const s = [...document.querySelectorAll('input[type="submit"]')].find(i => i.offsetParent !== null);
      if (s) { s.click(); return 'submit-input'; }
      const form = document.querySelector('form');
      if (form) { form.requestSubmit?.(); return 'form'; }
      return 'nothing-found';
    })()`),
  );
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500);
    if (!(await evaluate(`location.href`)).includes("two_factor")) break;
  }
  url = await evaluate(`location.href`);
  console.log("after 2fa:", url.replace(/[?#].*$/, ""));
}

// ── did it work ─────────────────────────────────────────────────────────────

// The oracle is the session cookie Instagram only sets for an authenticated
// user — a URL that merely left /accounts/login can also be a checkpoint.
await sleep(2000);
const state = await evaluate(`(() => ({
  url: location.href.replace(/[?#].*$/, ''),
  hasSessionId: document.cookie.includes('sessionid='),
  body: document.body.innerText.slice(0, 220).replace(/\\s+/g, ' '),
}))()`);

console.log("logged in:", state.hasSessionId);
console.log("url:", state.url);
if (!state.hasSessionId) console.log("page says:", state.body);

ws.close();
process.exit(state.hasSessionId ? 0 : 6);
