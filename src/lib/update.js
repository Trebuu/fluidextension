/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THERE A NEWER RELEASE?
 * ───────────────────────────────────────────────────────────────────────────
 * Chrome will not answer this for us. `chrome.runtime.requestUpdateCheck()`
 * exists but is a no-op here — measured on a real install, it returns
 * `{status: "no_update", details: {version: ""}}`, because the extension has no
 * `update_url` and cannot be given one: self-hosted extension updates are
 * LINUX ONLY, and these installs are Windows, inside Chromium profile managers,
 * loaded unpacked. Chrome classifies them `installType: "development"`.
 *
 * So the feed is ours, and this file is the whole of the decision.
 *
 * ⚠ EVERY FAILURE HERE IS SILENT, which is why it is a module with tests rather
 * than five lines inlined in the worker. A comparison that never returns true
 * shows no banner, and no banner is exactly what being up to date looks like —
 * the bug and the healthy state are the same pixels. Nothing throws, nothing is
 * logged, and nobody files it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Where the version lives.
 *
 * On fluidvip.com ON PURPOSE: `https://*.fluidvip.com/*` is already in
 * `host_permissions`, so polling it needs no new permission and shows the user
 * no new prompt. Pointing this at GitHub would need `github.com` AND
 * `codeload.github.com` — the release archive 302s there — and an extension
 * asking for two more origins at update time is an extension people uninstall.
 */
export const FEED_URL = "https://extension.fluidvip.com/releases/latest.json";

/** How long a check is good for. Six hours: a release is not urgent, and the
 *  panel calls this on every repaint. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const CACHE_KEY = "fluidextension.updateCheck";

/**
 * -1 / 0 / 1, comparing dotted numeric versions.
 *
 * ⚠ NUMERICALLY, PART BY PART. As strings "0.10.0" < "0.9.0", which would strand
 * every install at x.9 for ever and say nothing. Missing parts are zero, so
 * "0.3" and "0.3.0" are the same version rather than an unanswerable question.
 * A leading "v" and stray whitespace are tolerated because the feed is written
 * by a human at some point, and one typo must not disable updates for everyone.
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10));

  const x = parts(a);
  const y = parts(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) {
    const l = Number.isFinite(x[i]) ? x[i] : 0;
    const r = Number.isFinite(y[i]) ? y[i] : 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/** Is `latest` a version, and is it ahead of `current`? */
export function isNewer(latest, current) {
  // A version has to contain at least one number. Without this, "latest" and
  // "not.a.version" parse to all-NaN — read as 0.0.0 — and any current version
  // above 0 would be "newer", which is the wrong direction but still a lie.
  if (typeof latest !== "string" || !/\d/.test(latest)) return false;
  return compareVersions(latest, current) > 0;
}

/**
 * Ask the feed, at most once per `CHECK_EVERY_MS`.
 *
 * Always resolves. A failed check reports `{newer: false, error}` — never a
 * throw, and never an update. The panel calls this on a repaint; an exception
 * there would abandon the rest of the paint, and "we could not reach the feed"
 * must never render as "a new version is available".
 *
 * `now` is injected so the throttle is testable without waiting six hours.
 */
export async function checkForUpdate({ now = Date.now(), force = false } = {}) {
  const current = chrome.runtime.getManifest().version;

  const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? null;
  if (!force && stored && now - stored.at < CHECK_EVERY_MS) {
    // Recompare rather than trusting the stored verdict: the extension may have
    // been updated since the check, in which case the banner must disappear
    // without waiting for the window to expire.
    return { ...stored, current, newer: isNewer(stored.latest, current), cached: true };
  }

  try {
    const res = await fetch(FEED_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    const feed = await res.json();

    const result = {
      at: now,
      current,
      latest: typeof feed.version === "string" ? feed.version.trim() : null,
      download: feed.download ?? null,
      notes: feed.notes ?? null,
      size: feed.size ?? null,
    };
    result.newer = isNewer(result.latest, current);
    await chrome.storage.local.set({ [CACHE_KEY]: result });
    return result;
  } catch (e) {
    // NOT cached: a failure must not suppress the next check for six hours.
    return { at: now, current, latest: null, newer: false, error: String(e.message ?? e) };
  }
}
