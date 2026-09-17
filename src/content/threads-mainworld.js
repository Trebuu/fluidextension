/**
 * The doorbell: Threads' realtime socket, watched from the page's own world.
 *
 * WHY THIS FILE EXISTS. Threads never re-renders what is already on screen —
 * neither an open conversation nor a list left sitting on /messages/ — so a
 * MutationObserver has nothing to observe and the adapter's watcher can never
 * notice an incoming message. Measured 2026-09-16: an inbound message, four
 * minutes, bubble count stuck; only a navigation brings it in. That leaves the
 * cycle as the only mechanism, and a cycle is minutes late by construction.
 *
 * The socket is the one thing that DOES move. `window.WebSocket` can only be
 * patched from the MAIN world — an isolated content script has its own — hence
 * a page script, injected at document_start so the wrapper is in place before
 * Threads' bundle constructs anything. Measured: the patch catches both
 * `gateway.threads.com/ws/lightspeed` and `.../ws/streamcontroller`; neither
 * lives in a worker, which would have put them out of reach.
 *
 * ⚠ IT IS A DOORBELL, NOT A TRANSCRIPT. Nothing here reads the message. The
 * payload is undocumented and Meta will change it, and a parser that quietly
 * starts mis-reading produces the worst failure this product has: a plausible
 * reply to something nobody said. All this says is "something happened, go
 * look" — the worker then navigates, which re-renders, and reads the DOM
 * exactly as it does today. A ring that turns out to be nothing costs one
 * navigation; a mis-parse costs a conversation.
 */
(() => {
  "use strict";

  /**
   * Keepalives are 1–21 bytes and payloads are 109 B and up — measured over a
   * session, with nothing in between. Size alone separates traffic from noise
   * without decoding anything.
   */
  const MIN_PAYLOAD_BYTES = 50;

  /**
   * PRESENCE IS NOT A MESSAGE. `streamcontroller` carries presence updates —
   * who is online, who is typing — and they arrive constantly while somebody
   * has the conversation open. Ringing on those would navigate the tab every
   * few seconds for as long as a lead sits there reading, which is exactly the
   * traffic pattern that earned Instagram a sustained 429.
   *
   * Matched as a STRING on the decoded frame rather than by parsing it: if Meta
   * renames the field we start ringing on presence, which costs navigations —
   * the failure that leaves the product working rather than silent.
   */
  const PRESENCE_MARK = "presenceUpdates";

  /**
   * One ring per this window. A single inbound message produces several frames
   * (the message, receipts, presence around it), and each ring wakes a cycle
   * that navigates.
   */
  const COOLDOWN_MS = 5000;

  let lastRang = 0;

  function ring(reason, size) {
    const now = Date.now();
    if (now - lastRang < COOLDOWN_MS) return;
    lastRang = now;
    // `postMessage` to our own window is how the isolated world hears it; the
    // adapter filters on `source` because every script on the page shares it.
    window.postMessage({ source: "fluidextension", kind: "threads-realtime", reason, size }, "*");
  }

  async function inspect(data) {
    const size = data && data.size !== undefined ? data.size : data?.byteLength ?? String(data ?? "").length;
    if (size <= MIN_PAYLOAD_BYTES) return;

    let text = "";
    try {
      text =
        typeof data === "string"
          ? data
          : data instanceof Blob
            ? await data.text()
            : new TextDecoder().decode(data);
    } catch {
      // Undecodable is still a payload-sized frame, and the whole point is that
      // we do not depend on reading it. Ring.
      ring("opaque", size);
      return;
    }
    if (text.includes(PRESENCE_MARK)) return;
    ring("payload", size);
  }

  const Native = window.WebSocket;

  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    // Only the realtime gateway. The page opens other sockets for its own
    // reasons and none of them mean a message arrived.
    if (/gateway\.threads\.com/.test(String(url))) {
      ws.addEventListener("message", (ev) => {
        inspect(ev.data).catch(() => {});
      });
    }
    return ws;
  }

  Wrapped.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[k] = Native[k];
  window.WebSocket = Wrapped;
})();
