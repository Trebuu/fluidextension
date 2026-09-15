/**
 * Side panel — settings, the thread on screen, and what the character wants to
 * say about it.
 *
 * The panel holds no logic of its own: every action is a message to the service
 * worker, which owns the token and the API. That keeps one copy of the rules
 * (what may be generated, what may be sent) instead of one here and one there.
 */

const $ = (id) => document.getElementById(id);

/** Call the service worker, unwrapping its {ok, result|error} envelope. */
async function bg(type, extra = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...extra });
  if (!reply?.ok) {
    const err = new Error(reply?.error ?? "the extension did not answer");
    err.requestId = reply?.requestId;
    throw err;
  }
  return reply.result;
}

let state = { settings: null, thread: null, bubbles: [], quotas: null, insertIndex: 0 };

// ── painting ─────────────────────────────────────────────────────────────────

function setStatus(text, tone = "") {
  const el = $("status");
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/**
 * Paint the per-platform form from ONE platform's settings.
 *
 * `settings` here is the OPEN row's platform, which is not necessarily the
 * active one — setting up a platform you are not currently working is the
 * normal case. `state.settings` stays the ACTIVE platform's, because that is
 * what the budgets and the Start description are about; conflating the two is
 * how a form for WhatsApp would describe an Instagram run.
 */
function paintSettings(settings) {
  if (!settings) return;
  state.formSettings = settings;
  const label = formPlatform()?.label ?? null;
  // Named from the platform the form is FOR. Hard-coding Instagram told a
  // WhatsApp user to go and open a different app.
  $("ownUsername").textContent =
    settings.ownUsername || (label ? `not detected — open ${label}` : "not detected");
  $("connectorToken").value = settings.connectorToken;
  // Stored in ms because that is what the delays are used as; shown in seconds
  // because nobody reasons about a pause in milliseconds.
  $("minReplyDelayMs").value = Math.round(settings.minReplyDelayMs / 1000);
  $("maxReplyDelayMs").value = Math.round(settings.maxReplyDelayMs / 1000);
  $("newThreadsPerHour").value = settings.newThreadsPerHour;
  $("newThreadsPerDay").value = settings.newThreadsPerDay;
  $("maxThreadAgeDays").value = settings.maxThreadAgeDays;
  $("pauseBetweenThreads").checked = settings.pauseBetweenThreads;
  $("betweenThreadsMs").value = Math.round(settings.betweenThreadsMs / 1000);
  $("betweenThreadsMs").disabled = !settings.pauseBetweenThreads;
  $("acceptRequests").checked = settings.acceptRequests;
  $("requestsPerHour").value = settings.requestsPerHour;
  $("requestsPerDay").value = settings.requestsPerDay;
  $("requests-sub").textContent = `${settings.requestsPerHour} / hour · ${settings.requestsPerDay} / day`;
  $("autoSend").checked = settings.autoSend;
  // Says what WILL happen, not what the switch is called — the difference
  // between drafting and messaging a real person should not need inferring.
  // AND WHETHER THE HOURS ALLOW IT, which is the difference between a switch
  // that is on and one that is acting. Asleep, this said "answers new messages
  // by itself" while the worker was holding every one of them — the switch was
  // telling the truth about itself and lying about what happens.
  //
  // Only when the form is the BOUND platform's: `state.schedule` is the bound
  // one's week, and stamping it on a form opened for another account would
  // describe the wrong one.
  const boundHere = Boolean(state.platform?.id) && settings.platform === state.platform.id;
  const held = boundHere && state.schedule?.enabled && !state.schedule.open;
  $("autoSend-sub").textContent = settings.autoSend
    ? held
      ? "On, but held — the schedule has this account asleep, so nothing is answered."
      : "On — answers new messages in this thread by itself."
    : "Off — Generate drafts a reply and waits. Nothing is sent until you press Send.";
  $("describeUnreadable").checked = settings.describeUnreadable;
  $("followupsEnabled").checked = settings.followupsEnabled;
  $("followupStagesHours").value = settings.followupStagesHours;
  // Read the ladder back as a sentence, so a typo shows up as the wrong
  // schedule rather than as silence three days from now. Each entry is its own
  // wait, so every rung after the first is worded "later" — the whole point is
  // that these numbers are not totals, and the read-back has to say so.
  const stages = parseStages(settings.followupStagesHours);
  $("followup-sub").textContent = stages.length
    ? `${stages.length} nudge${stages.length > 1 ? "s" : ""}: ${stages
        .map((h, i) => (i === 0 ? `#1 after ${describeHours(h)} quiet` : `#${i + 1} ${describeHours(h)} later`))
        .join(", ")}. Then nothing.`
    : "No valid stages — nobody will be followed up.";

  paintSchedule(settings);

  $("commentsEnabled").checked = settings.commentsEnabled;
  $("skipSponsored").checked = settings.skipSponsored;
  $("feedScanLimit").value = settings.feedScanLimit;
  $("commentSources").value = settings.commentSources;
  $("commentsPerHour").value = settings.commentsPerHour;
  $("commentsPerDay").value = settings.commentsPerDay;
  $("commentRepliesEnabled").checked = settings.commentRepliesEnabled;
  $("commentRepliesPerHour").value = settings.commentRepliesPerHour;
  $("commentRepliesPerDay").value = settings.commentRepliesPerDay;

  $("outreachEnabled").checked = settings.outreachEnabled;
  $("outreachPerHour").value = settings.outreachPerHour;
  $("outreachPerDay").value = settings.outreachPerDay;
}

// ── the schedule ─────────────────────────────────────────────────────────────

/**
 * Days as the STORE keys them — Sunday first, the way `Date.getDay()` counts —
 * and as the panel SHOWS them, Monday first, the way a working week runs.
 *
 * Two orders, named once each. Getting them confused puts an account's evening
 * on the wrong day, and nothing about the symptom points here.
 */
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Turning the switch on with nothing set offers a week, rather than silence. */
const WORKING_WEEK = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
};

/** The week being edited, as a plain object we can hand straight to a save. */
function currentSchedule() {
  const raw = state.formSettings?.schedule;
  const out = {};
  for (const key of DAY_KEYS) {
    const windows = Array.isArray(raw?.[key]) ? raw[key] : [];
    out[key] = windows.filter((w) => Array.isArray(w) && w.length === 2).map((w) => [String(w[0]), String(w[1])]);
  }
  return out;
}

/** Write the week back. One save per edit — the worker is the only store. */
async function saveSchedule(schedule) {
  state.formSettings = { ...state.formSettings, schedule };
  paintSchedule(state.formSettings);
  await saveSetting({ schedule });
}

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

function paintSchedule(settings) {
  const on = Boolean(settings.scheduleEnabled);
  $("scheduleEnabled").checked = on;
  $("scheduleEnabled-sub").textContent = on
    ? "Outside these hours the account is silent — no sweep, no automatic replies, no follow-ups."
    : "Off — it runs when you press Start and stops when you press Stop.";
  $("schedule-card").hidden = !on;
  $("scheduleJitterMin").value = settings.scheduleJitterMin ?? 10;

  const schedule = currentSchedule();

  $("schedule-week").replaceChildren(
    ...WEEK_ORDER.map((index) => {
      const key = DAY_KEYS[index];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "day";
      // The initial, not the name: seven three-letter labels at 380px is a
      // line of text, and the row has to be readable as a WEEK.
      b.textContent = DAY_SHORT[index][0];
      b.setAttribute("aria-pressed", String(schedule[key].length > 0));
      b.setAttribute("aria-label", DAY_LONG[index]);
      b.title = DAY_LONG[index];
      b.addEventListener("click", () => {
        // A day switched off KEEPS NOTHING. Hiding its hours and bringing them
        // back on the next click would mean the panel holds a schedule the
        // worker has never been told about.
        saveSchedule({ ...schedule, [key]: schedule[key].length ? [] : [["09:00", "17:00"]] });
      });
      return b;
    }),
  );

  const rows = [];
  for (const index of WEEK_ORDER) {
    const key = DAY_KEYS[index];
    schedule[key].forEach((window, i) => rows.push(windowRow(schedule, index, i, window)));
  }
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "none";
    p.textContent = "No days picked. With the schedule on and no window, nothing runs by itself.";
    rows.push(p);
  }
  $("schedule-windows").replaceChildren(...rows);

  if (on) refreshScheduleNext();
}

function windowRow(schedule, index, i, [from, to]) {
  const key = DAY_KEYS[index];
  const row = document.createElement("div");
  row.className = "wrow";

  const day = document.createElement("span");
  day.className = i ? "d cont" : "d";
  day.textContent = i ? "and" : DAY_SHORT[index];
  row.append(day);

  const edit = (which) => async (e) => {
    const value = e.target.value;
    // An empty time input is a half-finished edit, not a window from midnight.
    if (!/^\d{2}:\d{2}$/.test(value)) return paintSchedule(state.formSettings);
    const windows = schedule[key].map((w, n) => (n === i ? (which === 0 ? [value, w[1]] : [w[0], value]) : w));
    await saveSchedule({ ...schedule, [key]: windows });
  };

  const start = document.createElement("input");
  start.type = "time";
  start.value = from;
  start.setAttribute("aria-label", `${DAY_LONG[index]} from`);
  start.addEventListener("change", edit(0));

  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "–";

  const end = document.createElement("input");
  end.type = "time";
  end.value = to;
  end.setAttribute("aria-label", `${DAY_LONG[index]} to`);
  end.addEventListener("change", edit(1));
  row.append(start, sep, end);

  // ONE GROUP AT THE END, so it wraps as a unit. A 12-hour locale renders
  // "10:00 PM – 02:00 AM" wide enough that an overnight row overflows, and
  // with the tag and the button as loose siblings the button alone dropped to
  // a second line — which reads as a layout that broke rather than one that
  // wrapped. `margin-left:auto` keeps the group right whichever line it is on.
  const tail = document.createElement("span");
  tail.className = "end";

  // Friday night, said out loud. Without this an end before its start reads as
  // a typo — and it is the only way to express "until 2am" at all.
  if (minutesOf(to) <= minutesOf(from)) {
    const tag = document.createElement("span");
    tag.className = "nextday";
    tag.textContent = `→ ${DAY_SHORT[(index + 1) % 7]}`;
    tag.title = `Runs past midnight into ${DAY_LONG[(index + 1) % 7]}`;
    tail.append(tag);
  }
  row.append(tail);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = i ? "icon rm" : "icon";
  btn.textContent = i ? "×" : "+";
  btn.title = i ? "Remove this window" : `Add a second window on ${DAY_LONG[index]}`;
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", async () => {
    const windows = i ? schedule[key].filter((_, n) => n !== i) : [...schedule[key], ["19:00", "22:00"]];
    await saveSchedule({ ...schedule, [key]: windows });
  });
  tail.append(btn);
  return row;
}

/**
 * The read-back, and it comes from the WORKER.
 *
 * The panel deliberately does no calendar arithmetic. "Opens Monday at 09:04"
 * has to be the same sentence the minute tick is acting on, and two
 * implementations of a week are two answers to when an account wakes up — the
 * kind that only disagree on the days nobody is watching.
 */
async function refreshScheduleNext() {
  // The same expression `saveSetting` uses, and deliberately so: the form can
  // be painted while no row is open, the worker falls back to the bound
  // platform for a save, and a readout resolved differently would describe a
  // different account from the one the edit just went to.
  const platform = state.openPlatform ?? null;
  const hd = $("schedule-next-hd");
  const sub = $("schedule-next-sub");
  const box = $("schedule-next");
  let st;
  try {
    st = await bg("ft:schedule-preview", { platform });
  } catch {
    return;
  }
  // The form may have moved on while that was in flight.
  if (!st || (state.openPlatform ?? null) !== platform) return;

  if (st.broken) {
    box.dataset.live = "broken";
    hd.innerHTML = "<b>This week cannot be read</b>";
    sub.textContent = `${st.errors.join("; ")}. Nothing runs until it is fixed.`;
    return;
  }
  if (st.open) {
    box.dataset.live = "true";
    hd.innerHTML = `Awake now — closes <b>${st.window.to}</b>`;
    const then = st.next ? `, then sleeps until ${DAY_LONG[st.next.day]} ${st.next.from}` : "";
    sub.textContent = `In ${untilLabel(st.window.endAt)}. It finishes the conversation it is on${then}.`;
    return;
  }
  box.dataset.live = "false";
  if (!st.next) {
    hd.textContent = "Never opens";
    sub.textContent = "No day is switched on, so nothing runs by itself.";
    return;
  }
  const jitter = Math.round((st.next.opensAt - st.next.startAt) / 60000);
  hd.innerHTML = `Opens ${DAY_LONG[st.next.day]} <b>${st.next.from}</b>`;
  sub.textContent =
    `In ${untilLabel(st.next.opensAt)}, on this browser's clock. Silent until then` +
    (jitter ? ` — this account opens about ${jitter} min in.` : ".");
}

/**
 * Which platform the active tab is, as a tag.
 *
 * Named rather than implied: everything the panel does is filed under a
 * platform, and once there is more than one, "which one am I about to act on"
 * has to be answerable without reading the address bar.
 */
/**
 * Grey out what the platform in front of us cannot do.
 *
 * The worker already refuses these passes by capability, so without this the
 * panel and the product disagree: Telegram has no posts to comment on, yet the
 * comment settings sat there fully editable, took a value, saved it, and did
 * nothing. A control that accepts input it will never act on is worse than a
 * missing one — it reads as a feature that is broken rather than absent.
 *
 * Driven by the SAME capability list the worker gates on, read off the active
 * tab. Nothing here enumerates platforms: a block declares which capability it
 * belongs to and the platform answers.
 *
 * With no supported tab open, nothing is greyed. We genuinely do not know which
 * platform the user means, and disabling everything on a guess would hide the
 * settings whenever the panel is opened next to the wrong tab.
 */
function paintCapabilities(platform) {
  const caps = platform?.capabilities ?? null;
  // Readouts, not controls: a budget for a pass this platform cannot run is
  // removed rather than disabled — there is nothing to explain and nothing to
  // switch on, and a greyed number still reads as a number.
  for (const block of document.querySelectorAll("[data-capability-hide]")) {
    block.hidden = Boolean(caps) && !caps.includes(block.dataset.capabilityHide);
  }
  for (const block of document.querySelectorAll("[data-capability]")) {
    const cap = block.dataset.capability;
    const off = Boolean(caps) && !caps.includes(cap);
    block.classList.toggle("unavailable", off);
    for (const el of block.querySelectorAll("input, select, button, textarea")) el.disabled = off;
    // Say WHY once per block rather than on every control.
    let note = block.querySelector(".cap-note");
    if (off && !note) {
      note = Object.assign(document.createElement("p"), {
        className: "cap-note",
        textContent: `${platform.label} has no ${CAP_LABELS[cap] ?? cap}.`,
      });
      block.prepend(note);
    } else if (off && note) {
      note.textContent = `${platform.label} has no ${CAP_LABELS[cap] ?? cap}.`;
    } else if (note) {
      note.remove();
    }
  }
}

const CAP_LABELS = {
  requests: "message requests",
  followups: "follow-ups here yet",
  comments: "public posts to comment on",
  commentReplies: "public comments to reply to",
  outreach: "followers list to cold-DM",
};

/**
 * One row per platform: is it set up, is its tab usable, and which is ACTIVE.
 *
 * A chooser, not a status list, because only one platform runs at a time. The
 * ordinary way to switch is to click that platform's tab — but the panel has to
 * offer it too, since a platform being set up for the first time may not be
 * open yet, and with two configured and neither focused there is no tab to
 * click.
 *
 * BOUND and ACTIVE are different questions and stay visibly separate: one is
 * "may the extension work this account at all", the other is "which one is it
 * working right now". Binding a platform does not start it.
 */
function paintPlatforms(info) {
  const box = $("platform-settings");
  if (!info?.rows) return;
  state.platforms = info.rows;

  // WHICH MODULE IS OPEN is the panel's own state, not the worker's, and it
  // deliberately survives a repaint: the rows are rebuilt on every tab switch,
  // every focus change and every save, and a module that collapsed under the
  // user mid-edit would be unusable.
  //
  // ⚠ `undefined` AND `null` ARE DIFFERENT HERE, and conflating them is what
  // made a module impossible to close. `undefined` means nobody has chosen yet,
  // so open the one being worked; `null` means the user CLOSED it, and must be
  // left alone. Testing it with `!state.openPlatform` treated a deliberate
  // close as "nothing chosen" and re-opened the default on the very next paint
  // — so clicking an open module's header did nothing at all, and closing any
  // other one made the active platform spring open instead.
  const chosen = state.openPlatform !== undefined;
  const stillThere = info.rows.some((p) => p.id === state.openPlatform);
  if (!chosen || (state.openPlatform !== null && !stillThere)) {
    state.openPlatform = info.active ?? info.rows.find((p) => p.configured)?.id ?? info.rows[0]?.id ?? null;
  }

  // REBUILT ONLY WHEN A ROW WOULD ACTUALLY LOOK DIFFERENT.
  //
  // The form is a real node that gets re-parented into the open row, and
  // re-parenting a node BLURS whatever inside it has focus. Every saved setting
  // repaints these rows, so an unconditional rebuild meant typing a number and
  // pressing Tab threw away the focus you had just moved. Nothing below this
  // line changes on a value edit, so the common case now rebuilds nothing.
  const key = JSON.stringify([
    state.openPlatform,
    info.rows.map((p) => [p.id, p.configured, p.active, p.handle, p.open, p.reachable, p.ready]),
  ]);
  if (key === state.rowsKey && box.childElementCount) return;
  state.rowsKey = key;

  // PARK THE FORM BEFORE REBUILDING. `replaceChildren` discards everything
  // inside the modules, and the form is inside one of them — so rebuilding
  // while it sits there DESTROYS it, and the next module to open finds nothing
  // to move. Measured: collapsing every module left `#platform-form` gone from
  // the document entirely. It is moved back out first and only re-parented
  // into a module that is actually open.
  const form = $("platform-form");
  form.hidden = true;
  $("form-home").append(form);

  box.replaceChildren(
    ...info.rows.map((p) => {
      const item = document.createElement("div");
      item.className = "pitem";
      const open = p.id === state.openPlatform;
      item.dataset.open = String(open);

      const row = document.createElement("div");
      row.className = "plat";
      // BOUND IS THE SAME QUESTION AS ACTIVE NOW, since only one platform can
      // be bound — so an "idle" state (bound but not being worked) no longer
      // exists, and the bound one goes straight to reporting its tab.
      //
      // ORDER MATTERS: unreachable outranks not-ready, because a tab whose
      // content script was orphaned by an extension restart is not slow, it is
      // dead — and it looks completely normal from the outside. That silence
      // is the whole failure, so it gets its own state rather than hiding
      // under a green "live".
      const status = !p.configured
        ? "off"
        : !p.open
          ? "closed"
          : p.reachable === false
            ? "dead"
            : p.ready === false
              ? "loading"
              : "live";
      row.dataset.state = status;
      row.dataset.active = String(Boolean(p.active));
      row.title = {
        off: `${p.label} is not bound — open it and press Bind`,
        closed: `No ${p.label} tab is open`,
        dead: `${p.label}'s tab still has the OLD extension — it was restarted. The extension is reloading that tab itself; no action needed.`,
        loading: `${p.label} is still loading: ${p.notReadyWhy ?? "not ready"}`,
        live: `${p.label} is the active platform`,
      }[status];

      // Name and account on one line, state and chevron on the other — this is
      // a module heading now, not a list item, so it gets room to say what it
      // is rather than being read sideways.
      const lead = document.createElement("div");
      lead.className = "lead";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.label;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = p.handle ? `@${p.handle}` : "not signed in";
      lead.append(name, who);

      const st = document.createElement("span");
      st.className = "state";
      const dot = document.createElement("i");
      dot.className = "dot";
      st.append(
        dot,
        document.createTextNode(
          { off: "not bound", closed: "no tab", dead: "reloading", loading: "loading", live: "bound" }[status],
        ),
      );

      const chev = document.createElement("i");
      chev.className = "chev";

      row.append(lead, st, chev);
      // The whole header opens and closes. The buttons inside stop the click,
      // because opening a platform's settings, binding it, and switching to it
      // are three different intentions and must not share one gesture.
      // Through `refreshAll`, not a local repaint: opening a row changes WHICH
      // platform's values the form must show, and those have to be fetched.
      // Painting from whatever the form happened to be holding is how a row for
      // one account shows another's numbers.
      row.addEventListener("click", () => {
        state.openPlatform = open ? null : p.id;
        refreshAll();
      });

      const body = document.createElement("div");
      body.className = "pbody";
      item.append(row, body);
      if (open) {
        // THE ACTIONS, at the top of the module: binding it, and working it.
        // Both were previously a tick in the header — a checkbox that silently
        // enrolled a real account, next to a row that switched platforms if you
        // clicked slightly to the right of it. Buttons that name what they do.
        const acts = document.createElement("div");
        acts.className = "pacts";

        // The platform currently bound, if it is not this one — binding this
        // one will replace it, and the button has to say so BEFORE it is
        // pressed. A control that silently stops another account working is not
        // one anybody can use confidently.
        const heldBy = (state.platforms ?? []).find((x) => x.configured && x.id !== p.id);

        const bind = document.createElement("button");
        bind.className = p.configured ? "btn" : "btn primary";
        bind.textContent = p.configured
          ? "Unbind"
          : heldBy
            ? `Bind ${p.label} instead`
            : `Bind ${p.label}`;
        bind.title = p.configured
          ? `Stop working ${p.label}. Its settings are kept.`
          : heldBy
            ? `Work ${p.label} instead of ${heldBy.label}. Only one platform runs at a time.`
            : `Work ${p.label} with this character.`;
        bind.addEventListener("click", (e) => {
          e.stopPropagation();
          setConfigured(p.id, !p.configured);
        });
        acts.append(bind);
        body.append(acts);

        // Say what binding will MEAN, where the button is, rather than leaving
        // it to be inferred from whether anything starts happening.
        const note = document.createElement("p");
        note.className = "phint";
        if (p.configured) {
          note.textContent = `${p.label} is the one platform being worked. Unbinding stops it; its settings are kept.`;
        } else if (heldBy) {
          note.textContent = `Only one platform runs at a time — binding ${p.label} unbinds ${heldBy.label}. Settings below are saved either way.`;
        } else {
          note.textContent = `Nothing is bound, so nothing is running. Settings below are saved either way.`;
        }
        body.append(note);

        // THE ONE FORM, re-parented. Moving it is what guarantees the open
        // module and the values on screen cannot disagree.
        form.hidden = false;
        body.append(form);
      }
      return item;
    }),
  );
}

/** The platform the SETTINGS FORM is editing — the open row, not the active one. */
function formPlatform() {
  return (state.platforms ?? []).find((p) => p.id === state.openPlatform) ?? null;
}

/**
 * Bind or unbind, and say what actually happened.
 *
 * There is no separate "switch platform" any more: binding IS the switch, since
 * only one platform can be bound. The refusal worth reading is a run being in
 * progress — rebinding then would move it to another account mid-conversation.
 */
async function setConfigured(id, on) {
  const displaced = on ? (state.platforms ?? []).find((p) => p.configured && p.id !== id) : null;
  const label = (state.platforms ?? []).find((p) => p.id === id)?.label ?? id;
  try {
    await bg("ft:set-configured", { platform: id, on });
    setStatus(
      on
        ? displaced
          ? `Now working ${label} — ${displaced.label} was unbound.`
          : `Now working ${label}.`
        : `${label} unbound — nothing is running.`,
      on ? "ok" : "warn",
    );
  } catch (err) {
    setStatus(err.message, "error");
  }
  await refreshAll();
}

/**
 * The ACTIVE platform, in the header and as the scope of the settings form.
 *
 * Not the tab in front. The panel is a tab too, so painting "which tab am I
 * looking at" meant the header said "no platform" whenever somebody clicked
 * into the panel to read it.
 */
function paintPlatform(platform) {
  state.platform = platform ?? null;
  const el = $("platform-pill");
  el.textContent = platform?.label ?? "no platform";
  el.dataset.state = platform ? "on" : "none";
  el.title = platform
    ? `Working ${platform.label} (${platform.id}) — click another platform's tab to switch`
    : "No platform is active — open one and click its tab";

  // Greyed by the platform whose settings are OPEN, not by the active one. The
  // two are routinely different now, and the capability list is a fact about
  // the form on screen: Telegram has no feed to comment on whether or not it is
  // the platform currently being worked.
  paintCapabilities(formPlatform());
}

/** The detected handle comes from the worker, not from settings alone. */
function paintOwnHandle(handle) {
  if (handle) $("ownUsername").textContent = handle;
}

function paintThread(thread) {
  state.thread = thread;
  const card = $("thread-card");

  if (!thread?.ok) {
    card.hidden = true;
    // Named from the tab we are actually on. Hard-coding "Instagram" told a
    // WhatsApp user to go and open a conversation on a different app.
    const where = state.platform?.label ?? "the platform";
    const why = {
      not_on_thread: `Open a DM conversation in ${where} to reply to it.`,
      no_messages: "This thread has no messages rendered yet.",
    };
    setStatus(why[thread?.reason] ?? "No conversation on screen.", "warn");
    return;
  }

  card.hidden = false;
  $("thread-handle").textContent = thread.handle ? `@${thread.handle}` : "(handle not found)";

  const list = $("transcript");
  list.replaceChildren();
  for (const m of thread.messages.slice(-state.settings.historyLimit)) {
    const li = document.createElement("li");
    li.className = `msg ${m.side}`;
    li.textContent = m.text;
    list.append(li);
  }
  list.scrollTop = list.scrollHeight;

  if (!thread.lastInbound) {
    setStatus("The last message is yours — nothing to reply to yet.", "");
  } else {
    setStatus(`Waiting on a reply to: “${truncate(thread.lastInbound.text, 90)}”`, "ok");
  }
}

/**
 * Show the generated reply, one row per bubble.
 *
 * A reply is often SEVERAL messages — the character paces them, and the API
 * returns a `delay_ms` for each. Insert used to take `bubbles[0]` and nothing
 * else, so anyone driving it by hand got the first line and silently lost the
 * rest. Each bubble is now separately insertable, and the button walks them in
 * order so "insert, send, insert, send" works without hunting.
 */
function paintBubbles(bubbles) {
  state.bubbles = bubbles;
  state.insertIndex = 0;
  const card = $("reply-card");
  card.hidden = bubbles.length === 0;

  const list = $("bubbles");
  list.replaceChildren();
  bubbles.forEach((b, i) => {
    const li = document.createElement("li");
    li.dataset.index = String(i);
    li.tabIndex = 0;
    li.title = "Put this one in the composer";

    const text = document.createElement("span");
    text.textContent = b.text;
    li.append(text);

    // Only worth showing when there is more than one — a lone bubble has no
    // order to explain.
    if (bubbles.length > 1) {
      const meta = document.createElement("span");
      meta.className = "bmeta";
      meta.textContent = `${i + 1} of ${bubbles.length}${b.delay_ms ? ` · ${(b.delay_ms / 1000).toFixed(1)}s` : ""}`;
      li.append(meta);
    }

    const insertThis = () => insertBubble(i);
    li.addEventListener("click", insertThis);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        insertThis();
      }
    });
    list.append(li);
  });

  $("insert").disabled = bubbles.length === 0;
  $("send").disabled = bubbles.length === 0;
  paintInsertState();
  $("action-hint").textContent =
    bubbles.length > 1
      ? `${bubbles.length} messages. Insert steps through them, or click one. Send delivers all ${bubbles.length}, waiting for each to appear.`
      : bubbles.length
        ? "Insert puts it in the composer. Send delivers it and waits for it to appear."
        : "";
}

/** Which bubble Insert will place next, reflected on the button and the list. */
function paintInsertState() {
  const total = state.bubbles.length;
  const btn = $("insert");
  btn.textContent = total > 1 ? `Insert ${Math.min(state.insertIndex + 1, total)}/${total}` : "Insert";
  for (const li of $("bubbles").children) {
    const i = Number(li.dataset.index);
    li.classList.toggle("is-used", i < state.insertIndex);
    li.classList.toggle("is-next", total > 1 && i === state.insertIndex);
  }
}

async function insertBubble(index) {
  const bubble = state.bubbles[index];
  if (!bubble) return;
  await bg("ft:type", { text: bubble.text });
  // Advance past the one just placed so the button offers the NEXT, but never
  // rewind — clicking bubble 1 again after 2 should not undo the progress.
  state.insertIndex = Math.max(state.insertIndex, index + 1);
  paintInsertState();
  setStatus(
    state.bubbles.length > 1
      ? `Message ${index + 1} of ${state.bubbles.length} is in the composer. Press Enter in Instagram, then insert the next.`
      : "Put in the Instagram composer. Press Enter there to send.",
    "ok",
  );
}

/**
 * The three budgets, as counters with a spent-bar.
 *
 * Shows what is LEFT rather than what is used: the question being asked is
 * "will it act on the next thread", and remaining answers that directly. The
 * bar fills as the budget is consumed, so an exhausted one reads as full-red
 * even though the number reads zero.
 */
/**
 * The ladder, parsed the same way the worker parses it.
 *
 * Duplicated deliberately rather than imported: the panel must show what WILL
 * happen, and showing the raw text the user typed would hide that a stray
 * character was dropped.
 */
function parseStages(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

const describeHours = (h) => (h >= 24 && h % 24 === 0 ? `${h / 24}d` : `${h}h`);

/** "42m" / "3h 5m" / "<1m" — a gap, not a clock time. */
function untilLabel(at) {
  const ms = at - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function paintQuota(quotas) {
  if (!quotas) return;
  state.quotas = quotas;
  const cells = [
    ["q-new", quotas.newThread],
    ["q-out", quotas.outreach],
    ["q-req", quotas.request],
  ];

  for (const [id, q] of cells) {
    if (!q) continue;
    const n = $(`${id}-n`);
    const bar = $(`${id}-bar`);
    n.textContent = String(q.remaining);

    // Level is about how close to STOPPING we are, so it is derived from what
    // is left against the tighter of the two windows, not from either alone.
    const cap = Math.min(q.hourLimit, q.dayLimit) || 1;
    const level = q.remaining <= 0 ? "spent" : q.remaining / cap <= 0.34 ? "low" : "ok";
    if (level === "ok") {
      delete n.dataset.level;
      delete bar.dataset.level;
    } else {
      n.dataset.level = level;
      bar.dataset.level = level;
    }

    const usedFrac = cap > 0 ? Math.min(1, (cap - q.remaining) / cap) : 0;
    bar.style.width = `${Math.round(usedFrac * 100)}%`;

    // Two facts under the number, because "4 left" cannot say by itself
    // whether the hour or the day is the thing about to stop us.
    const sub = $(`${id}-sub`);
    sub.replaceChildren();
    if (q.resetsAt) {
      const span = document.createElement("span");
      span.className = "in";
      span.textContent = `+1 in ${untilLabel(q.resetsAt)}`;
      span.dataset.soon = String(q.resetsAt - Date.now() < 5 * 60_000);
      sub.append(span, document.createTextNode(` · ${q.dayLeft} today`));
    } else {
      sub.append(document.createTextNode(`${q.dayLeft} today`));
    }

    n.parentElement.title =
      q.remaining > 0
        ? `${q.hourLeft} left this hour, ${q.dayLeft} left today.` +
          (q.fullyResetsAt ? ` Hour fully clear in ${untilLabel(q.fullyResetsAt)}.` : "")
        : `Cap reached — the ${q.blockedBy} limit. One slot frees in ${
            q.blockedBy === "hour" ? untilLabel(q.resetsAt) : untilLabel(q.dayResetsAt)
          }.`;
  }
}

/**
 * One button that is Start or Stop depending on the run.
 *
 * Two buttons meant one of them was always dead, and the disabled one still
 * looked like the control you wanted. Its state is driven by the worker's own
 * `running`/`stopping`, never by what was last clicked, so a run that ended on
 * its own leaves the button saying Start.
 */
/**
 * What Start will actually do, given the current settings.
 *
 * Built rather than fixed, because the honest sentence changes: it used to say
 * "never starts a conversation", which stopped being true the moment outreach
 * was added. And Start sends whatever the Reply-automatically switch says —
 * that switch governs the unattended watcher, not this button — so the hint
 * has to say so or the two controls look like they contradict each other.
 *
 * EVERY CLAUSE IS GATED ON THE CAPABILITY TOO, not just on the setting. The
 * settings are shared across platforms, so on WhatsApp this promised to accept
 * message requests, answer comment replies, comment on a feed and cold-DM
 * followers — four passes the worker skips by declaration and that platform
 * does not have. A description of a run that cannot happen is worse than none:
 * it is the one place the user checks before pressing Start.
 */
function idleHint() {
  const can = (c) => !state.platform || state.platform.capabilities?.includes(c);
  const parts = ["Sends replies where their message is the last one."];
  if (state.settings?.acceptRequests && can("requests")) parts.push("Accepts message requests.");
  // Answering replies is listed BEFORE commenting, because that is the order it
  // runs in — and because the two are separately switchable, so a run that only
  // answers replies has to describe itself correctly.
  if (state.settings?.commentRepliesEnabled && can("commentReplies")) parts.push("Answers replies to my comments.");
  if (state.settings?.commentsEnabled && can("comments")) {
    const where = { feed: "in my feed", followers: "by my followers", both: "in my feed and by my followers" };
    parts.push(`Comments on posts ${where[state.settings.commentSources] ?? ""}.`);
  }
  if (state.settings?.followupsEnabled && can("followups")) {
    const n = parseStages(state.settings.followupStagesHours).length;
    if (n) parts.push(`Nudges quiet leads (up to ${n}).`);
  }
  parts.push(
    state.settings?.outreachEnabled && can("outreach")
      ? "Then cold-DMs followers who have never written to you."
      : "Never starts a conversation.",
  );
  return parts.join(" ");
}

function paintSweep(sweep) {
  state.sweep = sweep;
  const running = Boolean(sweep?.running);
  const stopping = Boolean(sweep?.stopping);
  const btn = $("sweep-toggle");
  // ASLEEP IS A FOURTH STATE, and it is not idle: idle is an extension nobody
  // has told what to do, asleep is a plan waiting for its hour. The button
  // still works — pressing it is an override, and it says so.
  const sched = state.schedule;
  const asleep = Boolean(sched?.enabled) && !sched.open && !running && !stopping;

  btn.textContent = stopping ? "Stopping…" : running ? "Stop" : asleep ? "Run now" : "Start";
  btn.classList.toggle("primary", !running);
  btn.classList.toggle("danger", running);
  btn.disabled = stopping;

  // The header pill is the panel's state at a glance, from the WORKER's own
  // flags — never from what the button was last clicked to say.
  const pill = $("run-pill");
  pill.dataset.state = stopping ? "stopping" : running ? "running" : asleep ? "scheduled" : "idle";
  pill.replaceChildren(
    Object.assign(document.createElement("i"), { className: "dot" }),
    document.createTextNode(stopping ? "Stopping" : running ? "Running" : asleep ? "Asleep" : "Idle"),
  );

  if (!running && asleep) {
    $("sweep-status").textContent = sched.broken
      ? "The schedule cannot be read, so nothing runs by itself. Fix it in Settings, or press Run now."
      : sched.next
        ? `Asleep until ${DAY_LONG[sched.next.day]} ${sched.next.from}. Nothing is sent and nothing is answered for ${untilLabel(sched.next.opensAt)}.`
        : "Asleep — no day is switched on, so nothing runs by itself.";
    return;
  }
  if (!sweep || (!running && sweep.done === 0)) {
    $("sweep-status").textContent = idleHint();
    return;
  }
  const where = sweep.current ? ` · on ${sweep.current}` : "";
  const cycles = sweep.cycles ? ` · pass ${sweep.cycles}` : "";
  // Which kind of run this is, said in the bar rather than left to be worked
  // out from whether the hour looks right: the plan closes the run it opened
  // at 17:00 and will not touch the one somebody started at 20:00.
  if (running && sched?.enabled) {
    const lead =
      sweep.reason === "schedule"
        ? `On schedule until ${sched.window?.to ?? "it closes"}. `
        : sched.open
          ? ""
          : "Running off-schedule — the plan will not stop this one. ";
    if (lead) {
      $("sweep-status").textContent =
        lead + (sweep.waiting ? `Watching for new messages · ${sweep.sent} replied${cycles}` : `${sweep.sent} replied, ${sweep.skipped} skipped${where}${cycles}`);
      return;
    }
  }
  // "Waiting" is a RUNNING state and has to read like one. A run no longer ends
  // when the inbox is clear — it goes quiet and watches — so a panel that said
  // "Finished" there would be describing the normal resting state as the end.
  if (running) {
    $("sweep-status").textContent = sweep.waiting
      ? `Watching for new messages · ${sweep.sent} replied${cycles}`
      : `${sweep.sent} replied, ${sweep.skipped} skipped${where}${cycles}`;
    return;
  }
  $("sweep-status").textContent = `Stopped — ${sweep.sent} replied, ${sweep.skipped} skipped${cycles}`;
}

function paintLog(entries) {
  const list = $("log");
  list.replaceChildren();
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing yet. Actions taken on Instagram show up here.";
    list.append(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.dataset.level = e.level;
    const t = document.createElement("time");
    t.textContent = new Date(e.at).toLocaleTimeString();
    const span = document.createElement("span");
    span.textContent = e.message;
    li.append(t, span);
    list.append(li);
  }
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── loading ──────────────────────────────────────────────────────────────────

async function refreshAll() {
  const st = await bg("ft:get-state");
  // The ACTIVE platform's settings — what the budgets and the Start
  // description are about. NOT what the form shows; see below.
  state.settings = st.settings;
  // The BOUND platform's week, for the run bar. Painted from the worker's own
  // answer, so the bar cannot say Asleep while the worker is sending.
  state.schedule = st.schedule;
  // ORDER MATTERS: `paintPlatforms` decides which row is open, and both
  // `paintPlatform` (capability greying) and the form below are about THAT
  // platform rather than the active one.
  paintPlatforms(await bg("ft:platforms").catch(() => null));
  paintPlatform(st.platform);
  if (state.openPlatform) {
    paintSettings(await bg("ft:platform-settings", { platform: state.openPlatform }).catch(() => null));
  }
  // ONLY WHEN THE OPEN ROW IS THE ACTIVE PLATFORM. `ownHandle` is read live from
  // the page we are working, so it is the active platform's — and painting it
  // over a form opened on a DIFFERENT platform relabels that account with this
  // one's handle. Seen exactly that: Instagram's row, opened while Telegram was
  // active, displayed Telegram's handle under "Signed in as".
  if (state.openPlatform === st.platform?.id) paintOwnHandle(st.ownHandle);
  paintLog(st.log);
  paintQuota(st.quotas);
  paintSweep(st.sweep);

  if (!st.platform) {
    $("thread-card").hidden = true;
    setStatus("No platform is active. Open one and click its tab, or pick one above.", "warn");
    return;
  }
  const row = (state.platforms ?? []).find((p) => p.id === st.platform.id);
  if (row && !row.configured) {
    $("thread-card").hidden = true;
    setStatus(`${st.platform.label} is not bound — open it in Settings and press Bind.`, "warn");
    return;
  }
  if (row && !row.open) {
    $("thread-card").hidden = true;
    setStatus(`No ${st.platform.label} tab is open.`, "warn");
    return;
  }
  await refreshThread();
}

async function refreshThread() {
  try {
    paintThread(await bg("ft:read-thread"));
  } catch (err) {
    $("thread-card").hidden = true;
    setStatus(err.message, "error");
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

/** Run an async action with the button disabled, and report the failure. */
async function withButton(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (err) {
    setStatus(err.requestId ? `${err.message} (request ${err.requestId})` : err.message, "error");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

$("generate").addEventListener("click", (e) =>
  withButton(e.target, "Generating…", async () => {
    const result = await bg("ft:generate", { force: true });
    paintThread(result.thread);
    paintBubbles(result.bubbles ?? []);
    // Prefer FluidTalk's own words: it explains "duplicate_message" as a
    // re-delivered DM and says a different message resets it, which the bare
    // reason code does not.
    if (result.silent) {
      setStatus(result.explain || `The character chose not to reply (${result.silent}).`, "warn");
    } else if (result.cached) {
      // Say it, so "why didn't it change" has an answer that is not "broken".
      setStatus("Showing the reply already written for this message.", "ok");
    }
    if (result.skipped) setStatus(result.skipped, "warn");
  }),
);

$("insert").addEventListener("click", async (e) => {
  // Wrap around once every bubble has been placed, so the button stays usable
  // if a paste went wrong and needs redoing.
  const i = state.insertIndex >= state.bubbles.length ? 0 : state.insertIndex;
  if (i === 0) state.insertIndex = 0;
  await withButton(e.target, "Inserting…", () => insertBubble(i));
  // AFTER withButton: it restores the label it captured on entry, which would
  // otherwise put "Insert 1/2" back over the "Insert 2/2" just painted.
  paintInsertState();
});

$("send").addEventListener("click", (e) =>
  withButton(e.target, "Sending…", async () => {
    const sent = await bg("ft:send", { thread: state.thread, bubbles: state.bubbles });
    const ok = sent.filter((s) => s.ok).length;
    setStatus(
      ok === sent.length
        ? `Sent ${ok} message(s).`
        : `Only ${ok} of ${state.bubbles.length} appeared in the thread.`,
      ok === sent.length ? "ok" : "error",
    );
    paintBubbles([]);
    await refreshThread();
  }),
);

$("refresh").addEventListener("click", refreshThread);

$("check-token").addEventListener("click", (e) =>
  withButton(e.target, "Checking…", async () => {
    await bg("ft:check-token");
    setStatus("FluidTalk accepted the connector token.", "ok");
  }),
);

$("diagnose").addEventListener("click", (e) =>
  withButton(e.target, "Reading…", async () => {
    const probe = await bg("ft:probe");
    const el = $("probe");
    el.hidden = false;
    el.textContent = JSON.stringify(probe, null, 2);
  }),
);

$("clear-log").addEventListener("click", async () => {
  await bg("ft:clear-log");
  paintLog([]);
});

/**
 * Start or stop, decided from the CURRENT worker state rather than the label.
 *
 * Repaints before awaiting the worker: the round-trip is short but a button
 * that does not change until it returns reads as one that ignored the click.
 */
$("sweep-toggle").addEventListener("click", async () => {
  const { sweep } = await bg("ft:get-state");
  try {
    if (sweep?.running) {
      paintSweep({ ...sweep, stopping: true });
      await bg("ft:sweep-stop");
      setStatus("Stopping.", "warn");
    } else {
      paintSweep({ running: true, sent: 0, skipped: 0, done: 0 });
      await bg("ft:sweep-start");
      setStatus("Sweeping the inbox. Watch the Log tab, or press Stop.", "ok");
    }
  } catch (err) {
    setStatus(err.message, "error");
    paintSweep(await bg("ft:get-state").then((s) => s.sweep));
  }
});

// ── settings binding ─────────────────────────────────────────────────────────

/**
 * Save a patch against the platform this form was PAINTED for.
 *
 * The platform is sent explicitly rather than resolved by the worker at save
 * time. Almost every setting now belongs to one platform, and the active one
 * can change between the form being painted and a control being changed — the
 * user clicks a platform tab to check something, comes back, and the value they
 * type would land on the account they just looked at. Naming it closes that
 * window; global settings (the token) route themselves regardless.
 *
 * A save refreshes the ROWS too, because the first per-platform save is what
 * sets a platform up, and that has to appear immediately.
 */
async function saveSetting(patch) {
  // THE OPEN ROW, not the active platform. They are routinely different now —
  // setting up a platform you are not working is the normal case — and saving
  // against the active one would write the numbers you just typed for WhatsApp
  // onto whichever account happens to be in front.
  const platform = state.openPlatform ?? null;
  paintSettings(await bg("ft:save-settings", { platform, patch }));
  // The rows too: the first per-platform save is what SETS A PLATFORM UP, and
  // that has to show on its row immediately.
  paintPlatforms(await bg("ft:platforms").catch(() => null));
  paintPlatform(state.platform);
}

/** Persist on change; text inputs on blur so a token is not saved half-typed. */
function bindSetting(id, { event = "change", parse = (v) => v } = {}) {
  $(id).addEventListener(event, async (e) => {
    await saveSetting({ [id]: parse(e.target.value) });
  });
}

/** Checkbox settings save on change, from `checked` rather than `value`. */
function bindCheck(id) {
  $(id).addEventListener("change", async (e) => {
    await saveSetting({ [id]: e.target.checked });
    // These switches change what Start will DO, and its description is built
    // from them — repaint it now rather than leaving a stale promise on screen.
    paintSweep(state.sweep);
  });
}

bindSetting("connectorToken", { event: "blur", parse: (v) => v.trim() });
bindSetting("minReplyDelayMs", { parse: (v) => Math.max(0, Number(v) || 0) * 1000 });
bindSetting("maxReplyDelayMs", { parse: (v) => Math.max(0, Number(v) || 0) * 1000 });
bindSetting("newThreadsPerHour", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("newThreadsPerDay", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("maxThreadAgeDays", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("betweenThreadsMs", { parse: (v) => Math.max(0, Number(v) || 0) * 1000 });
bindSetting("requestsPerHour", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("requestsPerDay", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("outreachPerHour", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("outreachPerDay", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("followupStagesHours", { event: "blur", parse: (v) => v.trim() });
bindSetting("commentSources");
bindSetting("commentsPerHour", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("commentsPerDay", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("feedScanLimit", { parse: (v) => Math.max(1, Number(v) || 1) });
bindCheck("commentsEnabled");
bindCheck("skipSponsored");
bindCheck("describeUnreadable");
bindSetting("scheduleJitterMin", { parse: (v) => Math.max(0, Math.min(60, Number(v) || 0)) });

/**
 * The schedule switch, which cannot be an ordinary `bindCheck` for one reason:
 * ON WITH NO DAYS IS PERMANENT SILENCE.
 *
 * It is an honest state and the worker handles it, but it is nobody's intent
 * when they flick the switch — so turning it on with an empty week offers a
 * working week instead. Offered, not imposed: it is saved, painted, and every
 * day of it is one click from off, which is the difference between a default
 * you can see and a rule you have to discover.
 */
$("scheduleEnabled").addEventListener("change", async (e) => {
  const on = e.target.checked;
  const empty = !Object.values(currentSchedule()).some((w) => w.length);
  await saveSetting(on && empty ? { scheduleEnabled: true, schedule: WORKING_WEEK } : { scheduleEnabled: on });
  // Start's description and the header pill both change meaning here.
  refreshAll();
});

$("feed-preview").addEventListener("click", (e) =>
  withButton(e.target, "Reading…", async () => {
    const rows = await bg("ft:read-feed", { limit: 30 });
    const el = $("comment-out");
    el.hidden = false;
    // Shows what was KEPT. A filter you cannot see is a filter you cannot
    // trust — this is how you check an ad is being skipped rather than assume.
    el.textContent = rows.length
      ? [`${rows.length} post(s) would be considered:`, ...rows.map((r) => `  @${r.author ?? "?"}  ${r.code}`)].join(
          "\n",
        )
      : "No eligible posts on the feed right now (ads and suggested posts are filtered out).";
  }),
);

$("comment-check").addEventListener("click", (e) =>
  withButton(e.target, "Checking…", async () => {
    const r = await bg("ft:comment-status");
    const el = $("comment-out");
    el.hidden = false;
    el.textContent = r.enabled
      ? "Comments are ON for this character in FluidTalk."
      : `Comments are OFF in FluidTalk — nothing will be written until they are turned on.\n\n${r.explain ?? r.ignore_reason}`;
  }),
);

$("comment-preview").addEventListener("click", (e) =>
  withButton(e.target, "Writing…", async () => {
    const r = await bg("ft:comment-generate");
    const el = $("comment-out");
    el.hidden = false;
    el.textContent = r.comment
      ? `on @${r.author} — “${r.caption}”\n${r.images} image(s), seen: ${r.vision?.seen ?? "n/a"}\n\n“${r.comment}”\n\nNot posted.`
      : `Nothing written (${r.ignore_reason ?? "no reason"}).\n\n${r.explain ?? ""}`;
  }),
);
$("replies-read").addEventListener("click", (e) =>
  withButton(e.target, "Reading…", async () => {
    const r = await bg("ft:read-comment-replies");
    const el = $("comment-out");
    el.hidden = false;
    if (!r.ok) {
      el.textContent = `Cannot read replies here (${r.reason}). Open a post you have commented on.`;
      return;
    }
    el.textContent = r.replies.length
      ? [
          `${r.replies.length} reply/replies under your ${r.ourComments.length} comment(s) on ${r.code}:`,
          ...r.replies.map(
            (x) => `  @${x.author}${x.mine ? " (you)" : x.answeredOnPage ? " (already answered)" : ""}  “${x.text.slice(0, 60)}”`,
          ),
        ].join("\n")
      : `Nobody has replied to your comment on ${r.code} yet (${r.comments} comment(s) read, ${r.expanded} thread(s) expanded).`;
  }),
);

$("replies-dry").addEventListener("click", (e) =>
  withButton(e.target, "Checking…", async () => {
    const r = await bg("ft:run-comment-replies", { limit: 1, dryRun: true });
    const el = $("comment-out");
    el.hidden = false;
    el.textContent = `${r.posts} post(s) from ${r.via}, ${r.replies} unanswered reply/replies, ${r.posted} would be answered.\nNothing was posted — see the log for what it would say.`;
  }),
);

bindSetting("commentRepliesPerHour", { parse: (v) => Math.max(0, Number(v) || 0) });
bindSetting("commentRepliesPerDay", { parse: (v) => Math.max(0, Number(v) || 0) });
bindCheck("commentRepliesEnabled");

bindCheck("followupsEnabled");
bindCheck("autoSend");
bindCheck("pauseBetweenThreads");
bindCheck("acceptRequests");
bindCheck("outreachEnabled");

$("outreach-preview").addEventListener("click", (e) =>
  withButton(e.target, "Reading…", async () => {
    const res = await bg("ft:outreach-preview");
    const el = $("outreach-list");
    el.hidden = false;
    el.textContent = res.ok
      ? `${res.targets.length} follower(s) not yet opened:\n` + res.targets.join("\n")
      : `could not read followers: ${res.reason}`;
  }),
);

// ── presets ──────────────────────────────────────────────────────────────────

/**
 * The saved presets, and what the fleet file is doing.
 *
 * SAVE IS LOCAL. An extension cannot write to its own package, so a preset
 * saved here reaches this browser profile and no other — making one fleet-wide
 * is Export, then dropping the file into the shared extension folder. The copy
 * next to Export says so, because a "Save" that silently means "only here" is
 * exactly the kind of thing somebody discovers after setting up fifty profiles.
 */
async function paintPresets() {
  let info;
  try {
    info = await bg("ft:presets-list");
  } catch {
    return;
  }
  state.presets = info.presets ?? [];

  // The fleet box only exists when a fleet file does — on a single-browser
  // install it is noise about a feature that is not in use.
  const box = $("fleet-box");
  box.hidden = !info.fleetPresent && !info.fleet;
  if (!box.hidden) {
    const f = info.fleet;
    const bad = Boolean(f?.error);
    $("fleet-state").textContent = bad ? "not applied" : f?.name ? `“${f.name}”` : "found";
    $("fleet-state").dataset.bad = String(bad);
    box.dataset.bad = String(bad);
    $("fleet-sub").textContent = bad
      ? `presets.json could not be used, so this profile kept its own settings: ${f.error}`
      : f?.name
        ? `Applied from presets.json in the extension folder${f.handle ? ` for @${f.handle}` : ""}. It is re-applied on every launch, so changes made here are temporary.`
        : "presets.json is present in the extension folder.";
  }

  const list = $("preset-list");
  if (!state.presets.length) {
    list.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "hint",
        textContent: "No presets saved in this browser profile yet.",
      }),
    );
    return;
  }

  list.replaceChildren(
    ...state.presets.map((p) => {
      const row = document.createElement("div");
      row.className = "preset";

      const lead = document.createElement("div");
      lead.className = "lead";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name;
      const sub = document.createElement("span");
      sub.className = "who";
      // What it will DO, not what it contains — Load rebinds and can change the
      // character, and both belong in front of the button.
      const bindLabel = p.bind ? `binds ${p.bind}` : "binds nothing";
      sub.textContent = `${bindLabel}${p.token ? " · has token" : " · no token"}`;
      lead.append(name, sub);

      const acts = document.createElement("div");
      acts.className = "preset-acts";
      for (const [label, cls, fn] of [
        ["Load", "btn primary", (e) => arm(e.target, loadPrompt(p), () => loadPreset(p))],
        ["Export", "btn", () => exportPreset(p)],
        ["Delete", "btn", (e) => arm(e.target, "Sure?", () => removePreset(p))],
      ]) {
        const b = document.createElement("button");
        b.className = cls;
        b.textContent = label;
        b.addEventListener("click", fn);
        acts.append(b);
      }

      row.append(lead, acts);
      return row;
    }),
  );
}

/**
 * Confirm in the button itself: press once to arm, again to do it.
 *
 * NOT `confirm()`. A side panel is not a tab, and Chrome does not reliably give
 * extension surfaces a modal dialog — a blocked `confirm()` returns falsy, so
 * the button would simply do nothing, for ever, with no error anywhere. This
 * cannot be blocked, and it says what is about to happen while it waits.
 */
function arm(btn, prompt, run) {
  if (btn.dataset.armed === "1") {
    clearTimeout(Number(btn.dataset.timer));
    btn.dataset.armed = "0";
    btn.textContent = btn.dataset.label ?? btn.textContent;
    run();
    return;
  }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = prompt;
  btn.dataset.timer = String(
    setTimeout(() => {
      btn.dataset.armed = "0";
      btn.textContent = btn.dataset.label ?? btn.textContent;
    }, 5000),
  );
}

async function loadPreset(p) {
  try {
    // The PRESET, not its name: one pasted into the box has never been saved,
    // so there is no name to look it up by.
    await bg("ft:preset-apply", { preset: p });
    setStatus(`Loaded “${p.name}”.`, "ok");
  } catch (err) {
    setStatus(err.message, "error");
  }
  await refreshAll();
  await paintPresets();
}

/** What loading this preset will actually do, said before it is done. */
function loadPrompt(p) {
  return p.bind ? `Load & bind ${p.bind}?` : "Load & unbind all?";
}

/** Put the preset on screen, selected, so it can be copied out. */
function exportPreset(p) {
  const box = $("preset-paste");
  box.value = JSON.stringify(p, null, 2);
  box.focus();
  box.select();
  setStatus(
    p.token
      ? "Copy this — it contains the character token. Paste it into another profile, or save it as presets.json in the extension folder to apply it to every profile."
      : "Copy this. It has no token, so the profile you paste it into keeps its own.",
    p.token ? "warn" : "ok",
  );
}

async function removePreset(p) {
  await bg("ft:preset-delete", { name: p.name });
  setStatus(`Deleted “${p.name}”.`, "");
  await paintPresets();
}

$("preset-save").addEventListener("click", (e) =>
  withButton(e.target, "Saving…", async () => {
    const name = $("preset-name").value.trim();
    if (!name) {
      setStatus("Give the preset a name first.", "warn");
      return;
    }
    await bg("ft:preset-save", { name, includeToken: $("preset-with-token").checked });
    $("preset-name").value = "";
    setStatus(`Saved “${name}” in this browser profile. Export it to use it elsewhere.`, "ok");
    await paintPresets();
  }),
);

/** What the pasted blob actually is — checked before anything is applied. */
let checkedPreset = null;

$("preset-check").addEventListener("click", (e) =>
  withButton(e.target, "Checking…", async () => {
    const out = $("preset-out");
    out.hidden = false;
    checkedPreset = null;
    $("preset-import").disabled = true;
    $("preset-apply-pasted").disabled = true;

    const r = await bg("ft:preset-check", { json: $("preset-paste").value });
    if (!r.ok) {
      out.textContent = `Not usable:\n  ${r.errors.join("\n  ")}`;
      return;
    }
    checkedPreset = r.preset;
    $("preset-import").disabled = false;
    $("preset-apply-pasted").disabled = false;
    out.textContent = [
      `Name:      ${r.summary.name}`,
      `Binds:     ${r.summary.bind ?? "nothing"}`,
      `Token:     ${r.summary.hasToken ? "included — this sets the character" : "not included — the profile keeps its own"}`,
      `Settings:  ${r.summary.platforms.join(", ") || "none"}`,
      ``,
      `Nothing has been changed yet.`,
    ].join("\n");
  }),
);

$("preset-import").addEventListener("click", (e) =>
  withButton(e.target, "Importing…", async () => {
    const p = await bg("ft:preset-import", { json: $("preset-paste").value });
    setStatus(`Imported “${p.name}”. It is saved here but not applied.`, "ok");
    await paintPresets();
  }),
);

$("preset-apply-pasted").addEventListener("click", (e) =>
  withButton(e.target, "Applying…", async () => {
    if (!checkedPreset) return;
    await loadPreset(checkedPreset);
  }),
);

// ── tabs ─────────────────────────────────────────────────────────────────────

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) {
      const on = t === tab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    }
    for (const p of document.querySelectorAll(".panel")) {
      p.classList.toggle("is-active", p.dataset.panel === tab.dataset.tab);
    }
    // Repainted on open rather than polled: a preset list changes only when
    // somebody changes it, and the fleet state only at launch.
    if (tab.dataset.tab === "presets") paintPresets();
  });
}

// ── live updates ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  // The worker decides which platform is active, so it says when that changes
  // rather than leaving the panel to race it for the same tab event.
  if (msg?.type === "ft:active-changed") refreshAll();
  if (msg?.type === "ft:thread-updated") paintThread(msg.thread);
  if (msg?.type === "ft:sweep-changed") {
    paintSweep(msg.sweep);
    // A sweep is the main way the cap gets spent, so keep it honest live.
    bg("ft:quota").then(paintQuota).catch(() => {});
  }
  if (msg?.type === "ft:log-changed") bg("ft:get-state").then((st) => paintLog(st.log));
});

/**
 * Keep the countdown honest.
 *
 * The numbers only change when the worker acts, but the TIME does not — a
 * "+1 in 42m" painted once is a lie within a minute. Re-asking the worker (a
 * storage read, no network) also picks up slots that aged out while the panel
 * sat open, which recomputing from the stale timestamps alone would miss.
 */
setInterval(() => {
  bg("ft:quota").then(paintQuota).catch(() => {});
  // Same reason, and a longer countdown: "asleep for 14h 38m" is wrong within
  // a minute, and the moment it matters most is the one nobody is watching —
  // the window opening while the panel sits there saying it has not.
  bg("ft:get-state")
    .then((st) => {
      state.schedule = st.schedule;
      paintSweep(state.sweep);
    })
    .catch(() => {});
  if (state.formSettings?.scheduleEnabled) refreshScheduleNext();
}, 30_000);

// Switching tabs changes which conversation is on screen.
chrome.tabs.onActivated.addListener(refreshAll);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) refreshAll();
});
// AND SWITCHING WINDOWS, which `tabs.onActivated` does not cover. It fires
// when the active tab WITHIN a window changes — but the arrangement this
// feature wants is one window per platform, where each tab is already the
// active one in its own window, so moving between them fires nothing at all
// and the panel sat showing the previous platform's handle and budgets.
chrome.windows.onFocusChanged.addListener(refreshAll);
// A tab closing or opening changes which platforms are reachable, and the
// platform rows are the one place that is visible.
chrome.tabs.onRemoved.addListener(refreshAll);
chrome.tabs.onCreated.addListener(refreshAll);

refreshAll();
