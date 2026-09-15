/**
 * The one thing that cannot be done from a content script: repair the comment
 * id in Instagram's own reply request.
 *
 * WHY THIS FILE EXISTS. Pressing Reply and pressing Publish produces a correct
 * reply mutation — `PolarisPostCommentInputRevampedMutation`, carrying the
 * parent thread and a `replied_to_comment_id`. But Instagram's web client puts
 * that id through a JavaScript **number**, and a comment id does not fit in
 * one. Measured on live requests, 2026-09-09:
 *
 *     Number("18101000000015838") === 18101000000015840
 *     Number("18148000000007919") === 18148000000007920
 *
 * and those are exactly the values that went out on the wire. The id named is
 * therefore a comment that does not exist, and the server files the comment at
 * TOP LEVEL instead of in the thread — a public comment that reads as an
 * unprompted remark rather than an answer. Nothing in the page can prevent it:
 * the same rounding happens for anyone, including a human clicking Reply.
 *
 * A content script cannot fix it either, because it runs in an isolated world
 * and the page's own `fetch` is not the one it can see. Hence `world: "MAIN"`.
 *
 * The rewrite is deliberately the narrowest one that works, so this can never
 * quietly alter anything else Instagram sends:
 *   - only requests whose body carries the comment mutation,
 *   - only the `replied_to_comment_id` field,
 *   - only while a reply we are about to post has announced its exact id,
 *   - and only when the number on the wire is EXACTLY that id's rounded form,
 *     which is what proves we are undoing this rounding rather than editing
 *     somebody else's request.
 * The intent is consumed on use, so a later comment cannot inherit it.
 */
(() => {
  "use strict";

  const MUTATION = /PolarisPostComment\w*Mutation/;
  const FIELD = /(replied_to_comment_id(?:%22%3A|"\s*:\s*))(\d+)/;

  /** The exact id of the comment we are answering, announced by the adapter. */
  let intent = null;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d?.source !== "fluidextension" || d.kind !== "reply-target") return;
    intent = typeof d.id === "string" ? d.id : null;
  });

  function repair(body) {
    if (!intent || typeof body !== "string" || !MUTATION.test(body)) return body;
    const m = body.match(FIELD);
    if (!m) return body;

    const onWire = m[2];
    const wanted = intent;
    // The proof that this is OUR request and OUR rounding: the number the page
    // is about to send is what `Number(id)` produces. Anything else is left
    // alone — a mismatch means the page is replying to something we did not ask
    // about, and silently rewriting that would be a bug with a public blast
    // radius.
    if (String(Number(wanted)) !== onWire) return body;

    intent = null;
    window.postMessage(
      { source: "fluidextension-page", kind: "reply-target-repaired", from: onWire, to: wanted },
      "*",
    );
    return body.replace(FIELD, `$1${wanted}`);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (init && typeof init.body === "string") {
        init = { ...init, body: repair(init.body) };
      }
    } catch {
      // Never break the page's own networking over this.
    }
    return nativeFetch.call(this, input, init);
  };

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === "string") body = repair(body);
    } catch {
      /* as above */
    }
    return nativeSend.call(this, body);
  };
})();
