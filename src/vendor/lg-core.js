/* ═══════════════════════════════════════════════════════════════════════════
   lg-core.js — LIQUID GLASS, FROM FIRST PRINCIPLES
   ───────────────────────────────────────────────────────────────────────────
   Apple describe the material in "Meet Liquid Glass" (WWDC25, session 219) as
   four simultaneous optical behaviours. This file reproduces each one as a
   separate, inspectable layer rather than faking the whole thing with one
   blurred box:

     1. LENSING     the bevelled edge refracts the backdrop (Snell's law).
                    Real refraction, computed per pixel from a surface normal,
                    baked into an RGB displacement map and fed to
                    <feDisplacementMap>. NOT feTurbulence noise.
     2. DISPERSION  glass has a different index of refraction per wavelength,
                    so the rim splits into colour. Three displacement passes at
                    n_R < n_G < n_B, recombined channel-wise.
     3. FROST       the interior scatters: a small blur + saturation lift. The
                    RIM stays sharp — that contrast between a soft middle and a
                    crisp, squeezed edge is most of what makes it read as glass
                    rather than as a frosted panel.
     4. SPECULAR    a rim highlight from a light in the environment, Blinn-Phong
                    against the same normal field, plus a Fresnel term. It moves
                    when the "device" moves (here: the pointer).

   HOW IT IS ASSEMBLED
   ───────────────────────────────────────────────────────────────────────────
   Every [data-lg] host gets shadow layers injected into it:

     the host       backdrop-filter: url(#…) — layers 1-3, the backdrop pass.
                    It has to sit on the host itself; a child cannot carry it.
                    See the BACKDROP ROOT note in lg.css.
     .lg__tint      the adaptive tint + the top-to-bottom brightness ramp
     .lg__spec      layer 4, a generated PNG, blended with plus-lighter
     .lg__edge      the 1px inner hairline (bright at the top, dim at the base)
     …your content, untouched, on top

   Each is toggleable at runtime (LG.setLayer) so the lab page can dissect it.

   BROWSER REALITY
   ───────────────────────────────────────────────────────────────────────────
   `backdrop-filter: url(#svg-filter)` is Chromium-only today. Safari and
   Firefox get the CSS-only path (frost + rim + sheen), which is layers 3 and 4
   without the refraction. Feature-detected, never assumed.
   ═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  /* Chromium is the only engine that will run an SVG filter as a backdrop pass.
     Test it for real — CSS.supports() alone answers true in engines that then
     silently drop the filter, so we also require the engine to admit to
     backdrop-filter at all. */
  var SUPPORTS_SVG_BACKDROP = (function () {
    try {
      return CSS.supports('backdrop-filter', 'url(#x)') &&
             CSS.supports('backdrop-filter', 'blur(1px)');
    } catch (e) { return false; }
  })();

  /* ─────────────────────────────────────────────────────────────────────────
     1. GEOMETRY — the silhouette
     ─────────────────────────────────────────────────────────────────────────
     Signed distance to a rounded box, negative inside. `n` is the corner
     exponent: 2 is a circular corner (what CSS border-radius draws), 4 is an
     Apple-style continuous corner / squircle, which is flatter at 45° and
     blends into the straight edge instead of meeting it at a tangent break.
     When n != 2 the host must be clipped with the matching path, or the
     lensing will run past the visible edge — see LG.squirclePath(). */
  function sdRoundBox(px, py, hw, hh, r, n) {
    var qx = Math.abs(px) - (hw - r);
    var qy = Math.abs(py) - (hh - r);
    var ax = qx > 0 ? qx : 0;
    var ay = qy > 0 ? qy : 0;
    var outer;
    if (n === 2) {
      outer = Math.sqrt(ax * ax + ay * ay);
    } else {
      outer = Math.pow(Math.pow(ax, n) + Math.pow(ay, n), 1 / n);
    }
    var inner = Math.min(Math.max(qx, qy), 0);
    return outer + inner - r;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     1b. UNION — two pieces of glass becoming one
     ─────────────────────────────────────────────────────────────────────────
     Apple's GlassEffectContainer blends elements that come within a spacing
     threshold of each other: the material behaves like a liquid, so two nearby
     controls do not overlap, they FUSE, with a meniscus where they meet.

     A signed distance field gives you that for free. The union of two shapes is
     min(d₁, d₂) — but a hard min leaves a crease at the join. The polynomial
     smooth minimum blends the two fields over a radius k, which is exactly the
     meniscus. k IS the spacing threshold: shapes further apart than k stay
     separate, shapes closer than it pull into one silhouette.

     Everything downstream — the bevel, the normals, the refraction, the
     highlight — reads from the combined field and therefore wraps the merged
     shape without knowing anything about it. That is the whole reason this
     engine works on distance fields instead of on element boxes. */
  function smin(a, b, k) {
    if (k <= 0) return a < b ? a : b;
    var h = 0.5 + 0.5 * (b - a) / k;
    h = h < 0 ? 0 : (h > 1 ? 1 : h);
    return b * (1 - h) + a * h - k * h * (1 - h);
  }

  /* The field for a whole host: one rounded box, or the smooth union of
     however many sub-shapes it was given. */
  function fieldAt(px, py, shapes, k, n) {
    var d = sdRoundBox(px - shapes[0].cx, py - shapes[0].cy,
                       shapes[0].hw, shapes[0].hh, shapes[0].r, n);
    for (var i = 1; i < shapes.length; i++) {
      var s = shapes[i];
      d = smin(d, sdRoundBox(px - s.cx, py - s.cy, s.hw, s.hh, s.r, n), k);
    }
    return d;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     2. THE BEVEL PROFILE — the cross-section of the edge
     ─────────────────────────────────────────────────────────────────────────
     x runs 0 at the outer silhouette to 1 at the inner plateau; the function
     returns surface height, 0 at the edge, 1 on the flat top. Its DERIVATIVE
     is what actually matters: that is the surface tilt that bends light. */
  var PROFILES = {
    /* A quarter circle. Ray deviation grows without bound at the very edge —
       the aggressive, obviously-lensed look. */
    circle: function (x) { return Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x))); },

    /* A quarter squircle. Same total bend, spread over more of the band, so the
       rim reads as thick glass rather than as a hard bevel. This is the one
       that matches Apple's controls. */
    squircle: function (x) {
      var u = 1 - x;
      return Math.pow(Math.max(0, 1 - u * u * u * u), 0.25);
    },

    /* Convex, then rolling back concave before the plateau: the "lip" you see
       on Apple's larger surfaces, where the background pinches and then
       releases. Costs contrast, buys depth. */
    lip: function (x) {
      var convex = PROFILES.squircle(x);
      var concave = 1 - PROFILES.squircle(1 - x);
      var t = x * x * (3 - 2 * x);              // smoothstep
      return convex * (1 - t) + concave * t;
    },

    /* A straight chamfer. Constant tilt across the band = a constant offset
       ring. Useful as a control when reading the lab's displacement preview. */
    flat: function (x) { return x; }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     3. REFRACTION — Snell's law, one ray per pixel
     ─────────────────────────────────────────────────────────────────────────
     The incident ray is orthogonal to the screen. It meets a surface whose
     normal is tilted by θ₁ from vertical, so θ₁ IS the angle of incidence.

        n₁·sin(θ₁) = n₂·sin(θ₂),  n₁ = 1 (air)

     The ray is deviated by (θ₁ − θ₂) and then travels `thickness` through the
     material, so it lands thickness·tan(θ₁ − θ₂) away from where it entered.
     That offset, pointed along the outward edge normal, is the displacement. */
  function refractOffset(tilt, ior, thickness) {
    var s = Math.sin(tilt) / ior;
    if (s >= 1) return thickness;                 // total internal reflection
    var t2 = Math.asin(s);
    return thickness * Math.tan(tilt - t2);
  }

  /* Both the circle and the squircle profile have an INFINITE derivative at the
     outer silhouette, so the ray deviation there is unbounded. Left alone, one
     singular pixel sets the normalisation maximum and every other displacement
     in the field gets crushed to nothing — the lens vanishes and all you see is
     a bright rim. Real glass has no infinitely sharp edge either; it is
     polished. Clamping the tilt is that polish. */
  function clampTilt(tilt, maxTilt) {
    return tilt > maxTilt ? maxTilt : tilt;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     4. MAP GENERATION
     ─────────────────────────────────────────────────────────────────────────
     One pass over the pixels that fall inside the bevel band (the interior is
     neutral by definition and is skipped, which is why this stays cheap even
     on a full-width panel). Produces two images:

       displacement map  R = x offset, G = y offset, both around a neutral 128
                         B = rim coverage — reused as the mask that keeps the
                             rim sharp while the interior frosts
       specular map      white, alpha = highlight intensity

     Both are returned as data URLs and memoised on geometry, so twelve
     identical pricing cards build the map once. */
  var mapCache = new Map();

  function buildMaps(cfg) {
    var key = [cfg.w, cfg.h, cfg.r, cfg.bezel, cfg.ior, cfg.thickness,
               cfg.profile, cfg.cornerN, cfg.lightAngle, cfg.lightElev, cfg.maxTilt,
               cfg.shine, cfg.sign, cfg.k,
               cfg.shapes ? cfg.shapes.map(function (s) {
                 return [s.cx | 0, s.cy | 0, s.hw | 0, s.hh | 0, s.r | 0].join(',');
               }).join(';') : ''].join('|');
    var hit = mapCache.get(key);
    if (hit) return hit;

    var w = Math.max(2, Math.round(cfg.w));
    var h = Math.max(2, Math.round(cfg.h));
    var hw = w / 2, hh = h / 2;
    var r = Math.max(0.01, Math.min(cfg.r, Math.min(hw, hh)));

    /* One box unless the host handed us a set to fuse. Coordinates are
       element-local, origin at the top-left, which is the same space feImage
       and the CSS mask are pinned to. */
    var shapes = cfg.shapes && cfg.shapes.length ? cfg.shapes
               : [{ cx: hw, cy: hh, hw: hw, hh: hh, r: r }];
    var k = cfg.k || 0;
    var merged = shapes.length > 1;

    /* With several shapes the usable band is set by the SMALLEST of them —
       a bevel wider than half the thinnest lobe would swallow it. */
    var minHalf = Math.min.apply(null, shapes.map(function (s) {
      return Math.min(s.hw, s.hh);
    }));
    var band = Math.max(1, Math.min(cfg.bezel, minHalf - 0.5));
    var f = PROFILES[cfg.profile] || PROFILES.squircle;
    var n = cfg.cornerN;

    /* Light direction. lightAngle is degrees clockwise from 12 o'clock, which
       is how the lab labels it; elevation 0 = grazing, 1 = straight on. */
    var la = (cfg.lightAngle - 90) * Math.PI / 180;
    var lx = Math.cos(la), ly = Math.sin(la), lz = cfg.lightElev;
    var ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
    /* Blinn-Phong halfway vector against a view straight down the z axis. */
    var hx = lx, hy = ly, hz = lz + 1;
    var hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
    /* A weaker counter-light on the opposite rim. Apple's controls are lit from
       two sides; with one light the far edge dies and the pill looks printed. */
    var kx = -hx, ky = -hy, kz = hz;

    var dCan = document.createElement('canvas'); dCan.width = w; dCan.height = h;
    var sCan = document.createElement('canvas'); sCan.width = w; sCan.height = h;
    var mCan = document.createElement('canvas'); mCan.width = w; mCan.height = h;
    var dCtx = dCan.getContext('2d', { willReadFrequently: true });
    var sCtx = sCan.getContext('2d', { willReadFrequently: true });
    var mCtx = mCan.getContext('2d', { willReadFrequently: true });
    var dImg = dCtx.createImageData(w, h);
    var sImg = sCtx.createImageData(w, h);
    var mImg = mCtx.createImageData(w, h);
    var dData = dImg.data, sData = sImg.data, mData = mImg.data;

    /* Pass A — accumulate raw offsets so we can normalise against the true
       maximum. feDisplacementMap only has 8 bits per channel; spending them on
       a range we never reach is how a lens ends up looking quantised. */
    var ox = new Float32Array(w * h);
    var oy = new Float32Array(w * h);
    var maxMag = 1e-6;
    var eps = 0.5;                                  // SDF gradient step, px
    var dx2 = 1 / (2 * eps);

    for (var y = 0; y < h; y++) {
      var py = y + 0.5;
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var px = x + 0.5;
        var d = fieldAt(px, py, shapes, k, n);

        /* The silhouette mask, for every pixel — this is what clips the host
           when its shape is a union rather than a border-radius. One pixel of
           antialiasing straight off the distance. */
        var cov = 0.5 - d;
        mData[i * 4] = 255; mData[i * 4 + 1] = 255; mData[i * 4 + 2] = 255;
        mData[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, cov)) * 255);

        /* Outside the silhouette, or deep enough inside that the bevel is
           over: neutral. */
        if (d > 0.5 || d < -band) { continue; }

        var inward = -d;                            // 0 at the edge, +band in
        var t = Math.min(1, Math.max(0, inward / band));

        /* Surface tilt = slope of the profile, in real pixels: the profile
           climbs `thickness` over `band`, so scale the normalised derivative
           by that aspect ratio. */
        var e = 1 / band;
        var slope = (f(Math.min(1, t + e)) - f(Math.max(0, t - e))) /
                    ((Math.min(1, t + e) - Math.max(0, t - e)) || 1e-6);
        slope *= cfg.thickness / band;
        var tilt = clampTilt(Math.atan(Math.abs(slope)), cfg.maxTilt);
        slope = Math.tan(tilt) * (slope < 0 ? -1 : 1);   // keep the normal in step

        /* Outward unit normal of the silhouette, by central difference on the
           COMBINED field — which is why the bevel wraps a fused shape
           correctly, meniscus included, with no special case for it. */
        var gx = fieldAt(px + eps, py, shapes, k, n) -
                 fieldAt(px - eps, py, shapes, k, n);
        var gy = fieldAt(px, py + eps, shapes, k, n) -
                 fieldAt(px, py - eps, shapes, k, n);
        gx *= dx2; gy *= dx2;
        var gl = Math.hypot(gx, gy) || 1e-6; gx /= gl; gy /= gl;

        var mag = refractOffset(tilt, cfg.ior, cfg.thickness) * cfg.sign;

        /* Feather the last half pixel so the outermost row is not a hard step
           against whatever sits outside the silhouette. */
        if (d > -0.5) mag *= (0.5 - d);

        ox[i] = gx * mag;
        oy[i] = gy * mag;
        var m = Math.abs(mag);
        if (m > maxMag) maxMag = m;

        /* ── specular, same normal field ───────────────────────────────────
           N = normalize(slope · outwardNormal, 1): a convex bevel's normal
           leans outward, so the highlight tracks the silhouette. */
        var nx = gx * slope, ny = gy * slope, nz = 1;
        var nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;

        var spec = nx * hx + ny * hy + nz * hz;
        spec = spec > 0 ? Math.pow(spec, cfg.shine) : 0;
        var back = nx * kx + ny * ky + nz * kz;
        back = back > 0 ? Math.pow(back, cfg.shine * 1.35) * 0.55 : 0;
        /* Fresnel: grazing angles reflect more. Keeps the whole rim faintly
           alive instead of only the two lit corners. */
        var fres = Math.pow(1 - nz, 3) * 0.42;

        var a = Math.min(1, spec + back + fres);
        /* Concentrate the highlight on the outer third of the bevel. A rim
           light that reaches the plateau reads as a plastic dome, not as an
           edge catching the light. */
        a *= Math.pow(1 - t, 2.1);
        if (d > -0.5) a *= (0.5 - d);

        var o = i * 4;
        sData[o] = 255; sData[o + 1] = 255; sData[o + 2] = 255;
        sData[o + 3] = Math.round(a * 255);
      }
    }

    /* Pass B — encode. */
    var inv = 1 / maxMag;
    for (var j = 0; j < w * h; j++) {
      var q = j * 4;
      var yy = (j / w) | 0, xx = j - yy * w;
      var dd = fieldAt(xx + 0.5, yy + 0.5, shapes, k, n);

      var ux = ox[j] * inv, uy = oy[j] * inv;
      dData[q]     = Math.max(0, Math.min(255, Math.round(128 + ux * 127)));
      dData[q + 1] = Math.max(0, Math.min(255, Math.round(128 + uy * 127)));

      /* Blue channel carries rim coverage: 1 at the silhouette, feathering to
         0 by 55% of the way in. Extracted later as an alpha mask so the sharp
         lensed rim can sit on top of the frosted interior. */
      var rimCov = 0;
      if (dd <= 0.5) {
        var tt = Math.min(1, Math.max(0, (-dd) / (band * 0.42)));
        rimCov = 1 - (tt * tt * (3 - 2 * tt));
        if (dd > -0.5) rimCov *= (0.5 - dd);
      }
      dData[q + 2] = Math.round(rimCov * 255);
      dData[q + 3] = 255;                           // never premultiply the map
    }

    dCtx.putImageData(dImg, 0, 0);
    sCtx.putImageData(sImg, 0, 0);
    mCtx.putImageData(mImg, 0, 0);

    var out = {
      displacement: dCan.toDataURL(),
      specular: sCan.toDataURL(),
      /* Only generated when it is needed: a union has no border-radius that
         could clip it, so the host gets masked with this instead. */
      silhouette: merged ? mCan.toDataURL() : null,
      merged: merged,
      shapes: shapes,
      /* feDisplacementMap moves a pixel by scale·(channel/255 − 0.5). Our
         encoding puts ±1 at 128±127, i.e. ±0.498 after that subtraction, so
         the scale that reproduces `maxMag` real pixels is maxMag/0.498. */
      scale: maxMag / (127 / 255),
      maxMag: maxMag,
      w: w, h: h
    };
    /* Evict oldest-first, not clear-all. A Map keeps insertion order, so
       deleting the first key drops the least recently ADDED entry. Clearing
       the whole cache meant one host crossing the cap threw away every other
       host's maps too, and the next pointer move rebuilt all of them at once —
       a stutter that looked like the highlight "catching". */
    while (mapCache.size > 400) mapCache.delete(mapCache.keys().next().value);
    mapCache.set(key, out);
    return out;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     5. THE FILTER
     ─────────────────────────────────────────────────────────────────────────
     Region is deliberately larger than the element. A displacement at the rim
     reaches for backdrop that lies OUTSIDE the element box; if the filter
     region stops at the box, those reads return transparent black and the rim
     picks up a dark fringe. Grow the region by the maximum displacement and
     the reads land on real content. The result is still clipped to the border
     box by the element itself. */
  function ensureDefs() {
    var svg = document.getElementById('lg-defs');
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.id = 'lg-defs';
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.cssText =
        'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.appendChild(svg);
    }
    return svg;
  }

  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }

  function buildFilter(id, maps, cfg) {
    var M = cfg.margin != null ? cfg.margin : Math.ceil(maps.maxMag) + 6;
    var W = maps.w, H = maps.h;

    var filter = el('filter', {
      id: id,
      filterUnits: 'userSpaceOnUse',
      primitiveUnits: 'userSpaceOnUse',
      x: -M, y: -M, width: W + 2 * M, height: H + 2 * M,
      'color-interpolation-filters': 'sRGB'
    });

    /* The map is pinned to the element box, not to the (larger) filter region,
       so the bevel stays where the border-radius is. */
    filter.appendChild(el('feImage', {
      href: maps.displacement, x: 0, y: 0, width: W, height: H,
      preserveAspectRatio: 'none', result: 'map'
    }));

    /* ── the frosted interior ─────────────────────────────────────────────
       Blur first, then a gentle brightness/saturation lift. This is the layer
       everyone else's "glassmorphism" stops at. */
    filter.appendChild(el('feGaussianBlur', {
      in: 'SourceGraphic', stdDeviation: cfg.blur, result: 'frost'
    }));

    /* ── the lensed rim ───────────────────────────────────────────────────
       Three passes at three indices of refraction. Longer wavelengths bend
       less, so red is displaced least and blue most; recombining the isolated
       channels leaves the colour split you see on a real bevel. */
    var disp = cfg.dispersion;
    var scales = {
      R: maps.scale * (1 - disp),
      G: maps.scale,
      B: maps.scale * (1 + disp)
    };
    var rowFor = {
      R: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      G: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      B: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
    };
    ['R', 'G', 'B'].forEach(function (ch) {
      filter.appendChild(el('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'map', scale: scales[ch],
        xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + ch
      }));
      filter.appendChild(el('feColorMatrix', {
        in: 'd' + ch, type: 'matrix', values: rowFor[ch], result: 'c' + ch
      }));
    });
    filter.appendChild(el('feBlend', { in: 'cR', in2: 'cG', mode: 'screen', result: 'rg' }));
    filter.appendChild(el('feBlend', { in: 'rg', in2: 'cB', mode: 'screen', result: 'lens' }));

    /* A whisker of blur on the rim only — enough to stop the displacement
       stepping between source pixels, not enough to soften it. */
    filter.appendChild(el('feGaussianBlur', {
      in: 'lens', stdDeviation: cfg.rimBlur, result: 'lensSoft'
    }));

    /* Rim coverage lives in the map's blue channel; hoist it into alpha. */
    filter.appendChild(el('feColorMatrix', {
      in: 'map', type: 'matrix',
      values: '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 0', result: 'rimMask'
    }));
    filter.appendChild(el('feComposite', {
      in: 'lensSoft', in2: 'rimMask', operator: 'in', result: 'rimOnly'
    }));

    /* Sharp rim over frosted middle. */
    filter.appendChild(el('feComposite', {
      in: 'rimOnly', in2: 'frost', operator: 'over', result: 'joined'
    }));
    filter.appendChild(el('feColorMatrix', {
      in: 'joined', type: 'saturate', values: cfg.saturate, result: 'sat'
    }));
    /* Apple's material lifts the dynamic range of what it sits over rather
       than dimming it — the panel is brighter than the wall behind it. */
    filter.appendChild(el('feComponentTransfer', { in: 'sat', result: 'out' }));
    var ct = filter.lastChild;
    ['feFuncR', 'feFuncG', 'feFuncB'].forEach(function (fn) {
      ct.appendChild(el(fn, { type: 'linear', slope: cfg.brightness, intercept: cfg.lift }));
    });

    /* Debug tap. Naming any intermediate result ends the chain there, so the
       lab (and anyone reading this in devtools) can see exactly what each
       primitive contributes instead of guessing from the composite.
         map · frost · lens · lensSoft · rimMask · rimOnly · joined · sat */
    if (cfg.debug) {
      filter.appendChild(el('feOffset', { in: cfg.debug, dx: 0, dy: 0 }));
    }

    return filter;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     6. THE HOST
     ───────────────────────────────────────────────────────────────────────── */
  var LAYERS = ['lens', 'tint', 'spec', 'edge'];

  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }

  function readConfig(host) {
    var d = host.dataset;
    var cs = getComputedStyle(host);
    var rect = host.getBoundingClientRect();
    var w = rect.width, h = rect.height;

    var radius = num(d.lgRadius, parseFloat(cs.borderTopLeftRadius) || 0);
    if (radius > Math.min(w, h) / 2) radius = Math.min(w, h) / 2;

    /* Default bevel.
       A slab of glass has ONE thickness whatever you cut out of it, so the
       bevel is close to constant in absolute pixels rather than proportional
       to the element. It grows only slightly with size, because Apple's larger
       surfaces "simulate a thicker, more substantial material" (WWDC25 219) —
       and it can never exceed the corner radius or half the short side, or the
       bevel would run past the silhouette it is supposed to be rolling over. */
    var minSide = Math.min(w, h);
    var bezel = num(d.lgBezel, Math.max(8, Math.min(
      radius || 20, minSide / 2, 13 + minSide * 0.035, 34)));
    var light = d.lgTone === 'light';

    /* MERGE MODE.
       data-lg-merge="<k>" turns the host into a container: its own box stops
       being the silhouette, and the shapes come from its [data-lg-shape]
       descendants instead, smooth-unioned with radius k. k is Apple's spacing
       threshold — sub-shapes closer together than k fuse, further apart stay
       separate. Measured from live rects, so it survives layout and animation. */
    var shapes = null, kMerge = 0;
    if (d.lgMerge != null) {
      kMerge = num(d.lgMerge, 20);
      var parts = host.querySelectorAll('[data-lg-shape]');
      if (parts.length) {
        shapes = [];
        parts.forEach(function (p) {
          var pr = p.getBoundingClientRect();
          if (pr.width < 2 || pr.height < 2) return;
          var pcs = getComputedStyle(p);
          var prr = parseFloat(pcs.borderTopLeftRadius) || 0;
          shapes.push({
            cx: pr.left - rect.left + pr.width / 2,
            cy: pr.top - rect.top + pr.height / 2,
            hw: pr.width / 2,
            hh: pr.height / 2,
            r: Math.min(prr, pr.width / 2, pr.height / 2)
          });
        });
        if (!shapes.length) shapes = null;
      }
    }

    return {
      w: w, h: h, r: radius, bezel: bezel,
      shapes: shapes, k: kMerge,
      ior: num(d.lgIor, 1.48),
      /* How far a refracted ray travels inside the material before it exits.
         This, not the index, is the knob that decides how MUCH the edge bends
         what is behind it. */
      thickness: num(d.lgThickness, bezel * 0.82),
      /* Radians. Above this the profile is treated as polished flat — see
         clampTilt(). 72° gives a strong ring without a singular pixel. */
      maxTilt: num(d.lgMaxTilt, 72) * Math.PI / 180,
      dispersion: num(d.lgDispersion, 0.045),
      profile: d.lgProfile || 'squircle',
      cornerN: num(d.lgCornerN, 2),
      blur: num(d.lgBlur, 9),
      rimBlur: num(d.lgRimBlur, 0.4),
      /* The backdrop pass is tone-aware too, not just the tint.
         Lifting brightness and saturation is what gives the material its glow
         over dark art — run the same numbers over a white page and the result
         clips to paper, taking the control's own label with it. Over a light
         backdrop the pass has to sit slightly BELOW the page instead. */
      saturate: num(d.lgSaturate, light ? 1.25 : 1.8),
      brightness: num(d.lgBrightness, light ? 0.965 : 1.05),
      lift: num(d.lgLift, light ? 0 : 0.012),
      lightAngle: num(d.lgLight, 138),
      lightElev: num(d.lgElev, 0.5),
      shine: num(d.lgShine, 34),
      sign: num(d.lgSign, 1),
      margin: d.lgMargin != null ? num(d.lgMargin, 0) : null,
      debug: d.lgDebug || null
    };
  }

  function layerEl(host, name) {
    var e = host.querySelector(':scope > .lg__' + name);
    if (!e) {
      e = document.createElement('span');
      e.className = 'lg__' + name;
      e.setAttribute('aria-hidden', 'true');
      host.insertBefore(e, host.firstChild);
    }
    return e;
  }

  function apply(host) {
    if (!host.__lgId) host.__lgId = 'lg-f-' + (++uid);
    var cfg = readConfig(host);
    if (cfg.w < 4 || cfg.h < 4) return;

    host.classList.add('lg');
    host.style.setProperty('--lg-radius', cfg.r + 'px');

    /* Inject in reverse so the DOM order ends up touch → tint → spec → edge,
       with the host's own children left last and on top. */
    var edge = layerEl(host, 'edge');
    var spec = layerEl(host, 'spec');
    var tint = layerEl(host, 'tint');
    if (host.hasAttribute('data-lg-interactive')) layerEl(host, 'touch');

    var maps = buildMaps(cfg);
    host.__lgMaps = maps;
    host.__lgCfg = cfg;

    spec.style.backgroundImage = 'url("' + maps.specular + '")';
    spec.style.backgroundSize = '100% 100%';

    /* A fused silhouette is not a border-radius, so the host is masked with
       the generated alpha instead. The mask clips the backdrop pass, the tint,
       the highlight and the hairline in one go — they are all children of, or
       painted by, this element. */
    if (maps.silhouette) {
      host.style.maskImage = 'url("' + maps.silhouette + '")';
      host.style.webkitMaskImage = 'url("' + maps.silhouette + '")';
      host.style.maskSize = host.style.webkitMaskSize = '100% 100%';
      host.style.borderRadius = '0';
      /* A box-shadow would still be drawn on the unmasked rectangle. */
      host.style.boxShadow = 'none';
      /* And the hairline is built from border-radius + mask-composite, so on a
         fused shape it would trace a rectangle. Drop it: the specular map is
         generated from the real silhouette and already carries the rim. */
      edge.style.display = 'none';
    } else if (host.style.maskImage) {
      host.style.maskImage = host.style.webkitMaskImage = '';
      host.style.boxShadow = '';
      edge.style.display = '';
    }

    /* The backdrop pass goes on the HOST. See the long comment in lg.css: a
       child cannot carry it, because anything that makes the host a backdrop
       root leaves the child with an empty backdrop to filter. */
    if (SUPPORTS_SVG_BACKDROP && host.dataset.lgMode !== 'css') {
      var defs = ensureDefs();
      var old = document.getElementById(host.__lgId);
      if (old) old.remove();
      defs.appendChild(buildFilter(host.__lgId, maps, cfg));
      host.style.backdropFilter = 'url(#' + host.__lgId + ')';
      host.style.webkitBackdropFilter = 'url(#' + host.__lgId + ')';
      host.dataset.lgEngine = 'refraction';
    } else {
      /* No SVG backdrop pass available. Frost + saturate only; the bevel is
         carried entirely by the specular layer and the edge hairline, which is
         why those two are separate layers in the first place. */
      var css = 'blur(' + (cfg.blur + 6) + 'px) saturate(' + cfg.saturate +
                ') brightness(' + cfg.brightness + ')';
      host.style.backdropFilter = css;
      host.style.webkitBackdropFilter = css;
      host.dataset.lgEngine = 'css';
    }
    return host;
  }

  /* Re-measure on resize — on a TRAILING debounce, not per frame.
     A rebuild is a canvas pass plus a toDataURL, which is cheap but not free.
     Anything that animates its own size (the nav contracting on scroll, a
     window drag) would otherwise pay for it on every tick, and the map it
     builds mid-transition is thrown away by the next one. Waiting for the size
     to settle costs one frame of a slightly stale bevel and saves every
     intermediate build. */
  var pending = new Set();
  var timer = 0;

  /* ─────────────────────────────────────────────────────────────────────────
     RESIZING: the maps are BAKED, so a host mid-animation is showing the wrong
     ones.

     Both maps are bitmaps sized to the box they were built for. While a host
     animates its width — a sidebar collapsing, a window drag — the
     displacement map stays pinned to the OLD box (so the far edge loses its
     bevel entirely) and the specular PNG is painted at 100% × 100% of the NEW
     box, so its rim is squashed along one axis. That is the stretch: the
     graphic holds still and distorts, then snaps correct when the rebuild
     lands at the end.

     Rebuilding per frame is not the answer — that is two canvases and two
     toDataURL calls per frame, which is exactly the cost the highlight
     throttle exists to avoid.

     So while the size is moving, fall back to the representation that is
     correct at ANY size: the CSS frost, plus the 1px gradient hairline, which
     is drawn by the browser and therefore cannot stretch. The refraction ring
     is absent for the length of the animation and fades back in when the box
     settles — which reads as the glass catching the light again, not as a
     graphic snapping into place.
     ───────────────────────────────────────────────────────────────────────── */
  function beginResize(host) {
    if (host.hasAttribute('data-lg-resizing')) return;
    host.setAttribute('data-lg-resizing', '');
    var cfg = host.__lgCfg;
    /* Same filter chain the no-SVG engine uses, brightness included — the SVG
       pass lifts value as well as blurring, so dropping that term here would
       make the panel visibly dim the instant an animation started. */
    var css = 'blur(' + ((cfg ? cfg.blur : 9) + 6) + 'px) saturate(' +
              (cfg ? cfg.saturate : 1.6) + ') brightness(' +
              (cfg ? cfg.brightness : 1.05) + ')';
    host.style.backdropFilter = css;
    host.style.webkitBackdropFilter = css;
  }

  function schedule(host) {
    beginResize(host);
    pending.add(host);
    clearTimeout(timer);
    timer = setTimeout(function () {
      var list = Array.from(pending); pending.clear();
      list.forEach(function (h) {
        h.removeAttribute('data-lg-resizing');
        apply(h);                     /* rebuilds at the settled size */
      });
    }, 70);
  }

  var ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
          /* The observer fires once on observe(), and again for any layout
             that did not actually change the box. Rebuilding for a size we
             already built is wasted work — and with the fallback above it
             would also flash the refraction off and on for no reason.

             Measured off getBoundingClientRect, NOT off en.contentRect: the
             maps are built from the border box (readConfig uses the same
             call), while contentRect is the CONTENT box. On any host with
             padding — the rail has 14px/12px — the two numbers can never be
             equal, so comparing against contentRect would make this guard
             dead code and flash the refraction on the mount pass. */
          var host = en.target;
          var r = host.getBoundingClientRect();
          var maps = host.__lgMaps;
          if (maps && maps.w === Math.max(2, Math.round(r.width)) &&
                      maps.h === Math.max(2, Math.round(r.height))) return;
          schedule(host);
        });
      })
    : null;

  function mount(root) {
    root = root || document;
    var hosts = root.querySelectorAll('[data-lg]');
    hosts.forEach(function (h) {
      apply(h);
      if (ro) ro.observe(h);
    });
    return hosts.length;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     7. THE LIGHT MOVES
     ─────────────────────────────────────────────────────────────────────────
     On a phone the highlight tracks the device in space. On a page the honest
     analogue is the pointer. Hosts marked data-lg-live regenerate their
     specular map as the pointer crosses them — cheap for a pill or a button,
     which is why it is opt-in rather than global. */
  /* The light angle is QUANTISED to this many degrees. Two reasons, and the
     second is the important one:
       · the eye cannot see a 1° change in where a rim highlight sits;
       · the map cache is keyed on the angle, so a continuous angle misses the
         cache on every single frame and rebuilds two canvases plus two
         toDataURL calls per live host. At 5° the cache fills after one sweep
         and every later pass is free.
     This is the difference between the highlight costing ~8 canvas encodes a
     frame and costing none. */
  var LIGHT_STEP = 5;

  var pointer = null;      /* latest pointer position                         */
  var liveRaf = 0;         /* the ONE scheduled frame — see the note below    */

  function trackPointer() {
    window.addEventListener('pointermove', function (ev) {
      pointer = { x: ev.clientX, y: ev.clientY };
      /* A real guard. The previous version wrote `liveQueue = {...}` and then
         tested `liveQueue.raf`, a property nothing ever set — so it scheduled
         a fresh frame on EVERY pointermove instead of one per frame. */
      if (liveRaf) return;
      liveRaf = requestAnimationFrame(runLive);
    }, { passive: true });
  }

  function runLive() {
    liveRaf = 0;
    var p = pointer; if (!p) return;
    var hosts = document.querySelectorAll('[data-lg][data-lg-live]');

    hosts.forEach(function (host) {
      var r = host.getBoundingClientRect();
      if (!r.width || r.bottom < -80 || r.top > innerHeight + 80) return;  /* offscreen */

      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var ang = Math.atan2(p.x - cx, -(p.y - cy)) * 180 / Math.PI;
      ang = (ang + 360) % 360;
      var stepped = Math.round(ang / LIGHT_STEP) * LIGHT_STEP % 360;

      /* CHEAP, every frame: the fingertip glow and the highlight's strength are
         plain custom properties, so they move at pointer rate for free. The
         glow position was never written before, which is why the "light
         spreading from your fingertip" sat permanently in the middle. */
      host.style.setProperty('--lg-tx', ((p.x - r.left) / r.width * 100).toFixed(1) + '%');
      host.style.setProperty('--lg-ty', ((p.y - r.top) / r.height * 100).toFixed(1) + '%');
      var d = Math.hypot(p.x - cx, p.y - cy);
      var reach = Math.max(r.width, r.height) * 1.6;
      host.style.setProperty('--lg-spec-boost',
        (1 + 0.85 * Math.max(0, 1 - d / reach)).toFixed(3));

      /* EXPENSIVE, only when the rim actually needs redrawing. */
      if (host.dataset.lgLight !== String(stepped)) {
        host.dataset.lgLight = String(stepped);
        apply(host);
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     8. ADAPTIVITY
     ─────────────────────────────────────────────────────────────────────────
     "Small elements flip from light to dark based on what is behind them"
     (WWDC25 219). We cannot read the backdrop's pixels from CSS, so sections
     declare their own weight with data-tone="light|dark" and any element
     marked data-lg-adaptive flips as those sections pass under it. That is the
     same contract Apple's own material has with the content layer — it just
     resolves it in the compositor instead of in an observer. */
  function adapt(probeY) {
    var targets = document.querySelectorAll('[data-lg-adaptive]');
    if (!targets.length) return;
    targets.forEach(function (t) {
      var r = t.getBoundingClientRect();
      var y = probeY != null ? probeY : r.top + r.height / 2;
      var x = r.left + r.width / 2;
      var stack = document.elementsFromPoint(x, Math.max(1, y));
      var tone = 'dark';
      for (var i = 0; i < stack.length; i++) {
        if (stack[i] === t || t.contains(stack[i])) continue;
        var s = stack[i].closest('[data-tone]');
        if (s) { tone = s.dataset.tone; break; }
      }
      if (t.dataset.lgTone !== tone) {
        t.dataset.lgTone = tone;
        /* The tone does not only change CSS. It changes the backdrop pass —
           brightness, saturation and lift all flip — so the filter has to be
           rebuilt, not just re-styled. */
        apply(t);
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     9. PUBLIC SURFACE
     ───────────────────────────────────────────────────────────────────────── */
  var LG = {
    supportsRefraction: SUPPORTS_SVG_BACKDROP,
    mount: mount,
    apply: apply,
    refresh: schedule,
    adapt: adapt,
    trackPointer: trackPointer,
    profiles: PROFILES,
    buildMaps: buildMaps,
    sd: sdRoundBox,

    /* Toggle one optical layer across the document — the lab's dissection
       control, and a fast way to prove which layer is doing the work. */
    setLayer: function (name, on) {
      var attr = 'data-lg-hide-' + name;
      if (on) document.documentElement.removeAttribute(attr);
      else document.documentElement.setAttribute(attr, '');
    },
    layers: LAYERS,

    /* A continuous-corner outline for hosts that want a true squircle instead
       of CSS's circular corner. n = 4 is Apple-ish; 2 degenerates to the
       border-radius shape. Returned as a `path()` string for clip-path. */
    squirclePath: function (w, h, r, n) {
      n = n || 4;
      var pts = [], steps = 160;
      var hw = w / 2, hh = h / 2;
      for (var i = 0; i <= steps; i++) {
        var a = (i / steps) * Math.PI * 2;
        var ca = Math.cos(a), sa = Math.sin(a);
        var sx = Math.sign(ca) || 1, sy = Math.sign(sa) || 1;
        var ux = Math.pow(Math.abs(ca), 2 / n) * sx;
        var uy = Math.pow(Math.abs(sa), 2 / n) * sy;
        /* Straight run along the flats, superelliptic only in the corners. */
        var x = sx * Math.max(0, hw - r) + ux * r;
        var y = sy * Math.max(0, hh - r) + uy * r;
        pts.push((hw + x).toFixed(2) + ' ' + (hh + y).toFixed(2));
      }
      return 'path("M' + pts.join('L') + 'Z")';
    }
  };

  global.LG = LG;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); });
  } else {
    mount();
  }
})(window);
