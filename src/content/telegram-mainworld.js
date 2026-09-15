/**
 * The one thing that cannot be done from a content script: read a video
 * message's bytes.
 *
 * WHY THIS FILE EXISTS. A Telegram video is not a `blob:` like a photo or a
 * sticker — its `<video>` carries a `/k/stream/{…}` URL that is served by
 * TELEGRAM'S OWN service worker, which decrypts and reassembles the file from
 * its DC. **A content script's `fetch` is not intercepted by the page's service
 * worker** (Chrome 85+ gives content-script requests the extension's network
 * context), so that URL goes to the real server, which has no such route and
 * answers with the SPA shell: `text/html`, 1587 bytes. Measured side by side on
 * the same URL, 2026-09-10:
 *
 *     from the page          → 206, video/mp4, content-range bytes 0-524287/1788100
 *     from the content script→ 200, text/html, 1587 bytes
 *
 * The isolated world cannot see it and never will, which is why the read has to
 * happen here and the result be handed back as a `blob:` URL — those the
 * content script CAN read, because a blob url is keyed by origin, not by world.
 *
 * The chunk loop lives here rather than in the adapter because every chunk
 * needs the same interception: Telegram's worker answers 206 with 512 KB
 * however much is asked for, so a single fetch hands back a TRUNCATED file that
 * has a video mime and a plausible size and would upload perfectly happily.
 * Only the model would notice, by failing to decode it.
 */
(() => {
  "use strict";

  /** `/inbound-media` refuses anything larger, so there is no point buffering it. */
  const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
  /** A stream that never advances would otherwise loop for ever. */
  const MAX_CHUNKS = 64;
  /** Long enough for the adapter to have read the blob, short enough not to leak. */
  const REVOKE_AFTER_MS = 120000;

  async function readStream(url) {
    const first = await fetch(url, { headers: { Range: "bytes=0-" } });
    const type = first.headers.get("content-type") ?? "";
    const head = new Uint8Array(await first.arrayBuffer());

    // IMAGE OR VIDEO, nothing else. If interception ever breaks again this is
    // what catches it, rather than handing the model an HTML document as the
    // lead's media — a failure whose reply reads perfectly normally.
    if (!/^(image|video)\//.test(type)) {
      return { ok: false, reason: `not image or video (${type || "no type"}, ${head.length} bytes)` };
    }

    const range = first.headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) : null;

    // A 206 WITHOUT a usable total is the one shape that defeats both guards
    // below: `bytes 0-524287/*` parses to NaN, so the chunk loop is skipped AND
    // the truncation check is skipped, and a 512 KB fragment goes out wearing a
    // correct `video/mp4` type and a plausible size. Refuse instead of
    // guessing — a partial file is the failure this whole file exists to stop.
    if (first.status === 206 && !Number.isFinite(total)) {
      return { ok: false, reason: "the stream gave no total size, so a chunk cannot be told from the whole file" };
    }
    if (total && total > MAX_MEDIA_BYTES) return { ok: false, reason: `too large (${total} bytes)`, bytes: total };

    const parts = [head];
    let at = head.length;
    for (let i = 0; i < MAX_CHUNKS && total && at < total; i += 1) {
      const res = await fetch(url, { headers: { Range: `bytes=${at}-` } });
      const chunk = new Uint8Array(await res.arrayBuffer());
      if (!chunk.length) break;
      parts.push(chunk);
      at += chunk.length;
    }
    if (total && at < total) return { ok: false, reason: `only got ${at} of ${total} bytes` };

    const blob = new Blob(parts, { type });
    const blobUrl = URL.createObjectURL(blob);
    // Revoked from HERE, on a timer, rather than by the adapter: revocation is
    // the mirror of creation and belongs in the world that created it.
    setTimeout(() => URL.revokeObjectURL(blobUrl), REVOKE_AFTER_MS);
    return { ok: true, blobUrl, mime: type, bytes: blob.size };
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d?.source !== "fluidextension" || d.kind !== "stream-bytes") return;

    let result;
    try {
      result = await readStream(d.url);
    } catch (err) {
      result = { ok: false, reason: err.message };
    }
    window.postMessage({ source: "fluidextension-page", kind: "stream-bytes-result", id: d.id, ...result }, "*");
  });
})();
