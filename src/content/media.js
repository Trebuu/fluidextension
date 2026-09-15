/**
 * Reading a VIDEO out of a page, for adapters that cannot simply download one.
 *
 * Shared by the Telegram and Instagram adapters because the same problem turns
 * up on both, for different reasons:
 *
 *   - Telegram: the file IS fetchable, but /inbound-media refuses anything over
 *     10 MB, and that ceiling is about TWELVE SECONDS of phone video — so most
 *     real videos must be made smaller before they can be sent for vision.
 *   - Instagram: there is no file to fetch AT ALL. A DM video mounts as a
 *     MediaSource-backed `blob:` and `fetch` on it answers "Failed to fetch"
 *     (measured 2026-09-10), so re-encoding the DECODED ELEMENT is the ONLY
 *     path there — the primary one, not a fallback.
 *
 * Everything here therefore works off the decoded `<video>`, never the network.
 * Content scripts of one extension share an isolated world, so this file is
 * listed BEFORE each adapter in the manifest and hands them one global.
 */
(() => {
  "use strict";
  if (window.__ftMedia) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * `fallbackMime` is the type the RESPONSE claimed, for the case where the
   * blob carries none. Guessing `image/jpeg` there put video bytes on the wire
   * labelled as a photo, and the stored file is named from that mime — so the
   * model provider was handed a `.jpg` that is really an mp4 and asked to guess.
   */
  function toB64(blob, fallbackMime) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () =>
        resolve({
          ok: true,
          b64: String(fr.result).split(",")[1] ?? "",
          mime: blob.type || fallbackMime || "image/jpeg",
          bytes: blob.size,
        });
      fr.onerror = () => resolve({ ok: false, reason: "could not read the bytes" });
      fr.readAsDataURL(blob);
    });
  }

  /**
   * ONE frame from the middle of an animation — the FALLBACK, not the plan.
   *
   * The video itself is sent whole now (see `mediaBytes`), because the model
   * reads it: the same sticker that returned `vision_failed` came back as
   * "a bald man with a beard, smiling in a shower, gives a thumbs up and
   * winks" — a description of MOTION, which no single frame can produce. This
   * exists for when that is not possible: bytes too large for /inbound-media,
   * or a video whose data we cannot get at.
   *
   * One thing measured here is worth keeping: a 2×2 CONTACT SHEET of four
   * frames read WORSE than one frame, because nothing tells the model the tiles
   * are one animation and we do not control the vision prompt. It described the
   * grid — "four identical black robot-like faces" — and the character then
   * talked about "robot cats", plural. Do not reach for that again.
   *
   * Mid-animation rather than the first frame: a sticker often opens on a blank
   * or partly-drawn state.
   */
  /** The longest edge of a fallback frame. See the note below on why not 256². */
  const FRAME_MAX_EDGE = 768;

  /**
   * Seek, and actually wait for it.
   *
   * The old budget here was 900 ms, which is optimistic for the one case this
   * runs in: the file is big, so the midpoint is a byte range Telegram's worker
   * has to fetch and decode before it can paint.
   */
  function seekTo(video, at, ms = 3000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      video.addEventListener("seeked", finish, { once: true });
      try {
        video.currentTime = at;
      } catch {
        finish();
      }
      setTimeout(finish, ms);
    });
  }

  /**
   * Is this canvas one flat colour?
   *
   * `drawImage` on a video below HAVE_CURRENT_DATA draws NOTHING and throws
   * nothing, so the canvas keeps whatever was under it. A uniform image uploads
   * perfectly happily and `vision.seen` comes back TRUE, describing a blank
   * rectangle — the failure has to be caught here or it is never caught.
   */
  function looksBlank(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      const v = d[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min < 8;
  }

  /**
   * Only one thing may drive the `<video>` at a time.
   *
   * Both readers below pause, seek and play an element that is ON THE USER'S
   * SCREEN and then put it back. Two of them interleaved restore each other's
   * saved position, leaving the chat parked mid-video — and the thread reader
   * is triggered by a MutationObserver that our own scrolling can re-fire.
   */
  let videoBusy = Promise.resolve();

  function withVideo(video, fn) {
    const run = videoBusy.then(async () => {
      const was = { at: video.currentTime, paused: video.paused, rate: video.playbackRate, muted: video.muted };
      try {
        return await fn();
      } finally {
        // It is on the user's screen: leaving it parked or racing would show.
        video.playbackRate = was.rate;
        video.muted = was.muted;
        try {
          video.currentTime = was.at;
        } catch {
          /* a torn-down element is not worth an exception here */
        }
        if (was.paused) video.pause();
        else video.play().catch(() => {});
      }
    });
    videoBusy = run.catch(() => {});
    return run;
  }

  async function captureVideoFrame(video, kind = "video") {
    for (let i = 0; i < 20 && (video.readyState < 2 || !video.videoWidth); i += 1) await sleep(150);
    if (!video.videoWidth) return { ok: false, reason: `the ${kind} never produced a frame` };

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

    // NATIVE ASPECT, and big enough to read. The old canvas was a fixed 256×256
    // square tuned for stickers, which are square; a 1072×1920 phone video was
    // squashed 1.79× AND downsampled 7.5×, and the model called the result
    // "a blurry photo". The same frame at native aspect came back with the
    // objects on the desk named. It is also SMALLER — 37 KB as jpeg against
    // 108 KB as png, and a png of a photographic frame was never size-checked.
    const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");

    return withVideo(video, async () => {
      if (duration) {
        video.pause();
        await seekTo(video, duration / 2);
      }
      // A seek drops readyState back while the decoder refills, and the old
      // code drew immediately after it. Re-wait, or draw nothing at all.
      for (let i = 0; i < 25 && video.readyState < 2; i += 1) await sleep(100);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (looksBlank(ctx, canvas.width, canvas.height)) {
        return { ok: false, reason: `the ${kind} produced a blank frame` };
      }
      const b64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
      return { ok: true, b64, mime: "image/jpeg", bytes: Math.round((b64.length * 3) / 4), fromVideoFrame: true };
    });
  }

  /**
   * Re-encode a video small enough to upload, instead of giving up on motion.
   *
   * WHY THIS IS THE COMMON PATH, not an edge case. `/inbound-media` refuses
   * anything over 10 MB, and a phone video measured here runs at 0.81 MB/s —
   * so the cap is reached at about **twelve seconds**. Practically every real
   * video a lead sends is too big to forward whole, and the fallback frame
   * would be the normal outcome rather than the rare one.
   *
   * The bytes come from the DECODED ELEMENT, not from the network, so this also
   * works when the file itself cannot be had at all.
   *
   * Measured on the live 1072×1920 / 2.1 s / 1788100-byte video: 268×480 VP9,
   * 39812 bytes, 1.1 s of wall time — 45× smaller.
   */
  const SHRINK_MAX_EDGE = 480;
  const SHRINK_FPS = 12;
  /** Aim to finish in about this long; a reply that arrives much later is its own bug. */
  const SHRINK_WALL_TARGET_S = 8;
  const SHRINK_MAX_SPEED = 8;
  /** Past this there is nothing worth watching in a timelapse, so take a frame. */
  const SHRINK_MAX_DURATION_S = 240;
  /**
   * ⚠ NEVER SPEED UP INTO A CLIP SHORTER THAN THIS. The model does not fail on
   * a degenerate clip — it INVENTS one, confidently, with `seen: true` and no
   * reason given. Measured twice on the same 2.1 s video of a DESK, re-encoded
   * at 5.3× into 0.42 s:
   *
   *   "A young woman with dark hair … stands in a kitchen, swaying her hips"
   *   "A woman in a black top and jeans dances seductively in a dimly lit room"
   *
   * Two different fabrications, neither anywhere near the truth, and for this
   * product they are the worst possible invention — the character would answer
   * a sexual scene that does not exist. The same video at 1× was described
   * correctly twice ("a hand moves a computer mouse across a black desk").
   *
   * So the speed-up is bounded by OUTPUT length, not just by wall time. This
   * only ever bites short videos, which gain nothing from being sped up anyway.
   */
  const SHRINK_MIN_OUT_S = 2;
  /** Below this the recording is degenerate whatever its duration claims. */
  const SHRINK_MIN_FRAMES = 8;

  async function shrinkVideo(video, budgetBytes) {
    if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      return { ok: false, reason: "this browser cannot re-encode video" };
    }
    for (let i = 0; i < 20 && (video.readyState < 2 || !video.videoWidth); i += 1) await sleep(150);
    if (!video.videoWidth) return { ok: false, reason: "the video never produced a frame to re-encode" };

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!duration) return { ok: false, reason: "the video has no duration to re-encode" };
    if (duration > SHRINK_MAX_DURATION_S) return { ok: false, reason: `too long to re-encode (${Math.round(duration)}s)` };

    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!mime) return { ok: false, reason: "no webm encoder in this browser" };

    // Bounded three ways: never slower than real time, never faster than the
    // cap, and never fast enough to leave less than SHRINK_MIN_OUT_S of clip.
    const speed = Math.min(
      SHRINK_MAX_SPEED,
      Math.max(1, duration / SHRINK_WALL_TARGET_S),
      Math.max(1, duration / SHRINK_MIN_OUT_S),
    );
    const wallSeconds = duration / speed;
    // Bitrate chosen to land inside the budget with room to spare, since the
    // encoder only approximates it. Floored so a long video is not encoded into
    // mush, capped so a short one does not waste the allowance.
    const bits = Math.max(250000, Math.min(2500000, (budgetBytes * 8 * 0.7) / Math.max(1, wallSeconds)));

    const scale = Math.min(1, SHRINK_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    // Even dimensions: some encoders refuse odd ones.
    canvas.width = Math.max(2, Math.round((video.videoWidth * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((video.videoHeight * scale) / 2) * 2);
    const ctx = canvas.getContext("2d");

    return withVideo(video, async () => {
      const stream = canvas.captureStream(SHRINK_FPS);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(bits) });
      const chunks = [];
      rec.ondataavailable = (e) => {
        if (e.data?.size) chunks.push(e.data);
      };
      const stopped = new Promise((resolve) => {
        rec.onstop = resolve;
      });

      rec.start();
      video.muted = true;
      video.playbackRate = speed;
      await seekTo(video, 0);
      await video.play().catch(() => {});

      let painted = 0;
      await new Promise((resolve) => {
        const tick = () => {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          painted += 1;
          if (video.ended || video.currentTime >= duration - 0.05) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // A video that stalls mid-play must not hold the reply open for ever.
        setTimeout(resolve, (wallSeconds + 6) * 1000);
      });

      rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(chunks, { type: mime });
      // A degenerate clip is WORSE than no clip: the model invents rather than
      // failing, so refusing here is what sends us to an honest still frame.
      if (!blob.size) return { ok: false, reason: "re-encoding produced nothing" };
      if (painted < SHRINK_MIN_FRAMES) {
        return { ok: false, reason: `re-encoding caught only ${painted} frame(s)` };
      }
      if (blob.size > budgetBytes) return { ok: false, reason: `still too large after re-encoding (${blob.size} bytes)` };
      // The BASE type on the wire. `video/webm;codecs=vp9` is right for
      // MediaRecorder and wrong for everything downstream, which keys the
      // stored filename off the mime.
      const out = await toB64(blob, mime);
      return out.ok
        ? {
            ...out,
            mime: mime.split(";")[0],
            fromVideo: true,
            shrunk: { speed: Number(speed.toFixed(1)), size: `${canvas.width}x${canvas.height}` },
          }
        : out;
    });
  }

  window.__ftMedia = { toB64, seekTo, looksBlank, withVideo, captureVideoFrame, shrinkVideo };
})();
