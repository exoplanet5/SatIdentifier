/* ===== chart.js — SAT.chart : gnomonic (TAN) sky chart, the main view ===== */
/*
 * Tangent plane at the pointing, drawn in the DETECTOR frame: the FOV rectangle is
 * axis-aligned on screen and `obs.rotDeg` / `obs.flipEW` turn the sky underneath it.
 * That is the orientation an observer can actually check against a real frame,
 * and it is why the scan defines its rectangular boundary in the same rotated frame.
 *
 * Projection and orientation are deliberately separate stages:
 *   frames.tanProject -> {xi, eta} degrees (xi east, eta north)   [sky geometry]
 *   skyToScreen       -> pixels, applying rot, flip, zoom and pan  [display only]
 * Nothing downstream of skyToScreen ever feeds back into the geometry, so a crossing
 * lands on the same star whichever way the user has the chart turned.
 *
 * The tangent point is a FUNCTION OF TIME, not a constant, and that is the whole of
 * `obs.track`. Sidereally guided ('sky'), the frame is pinned to the celestial sphere:
 * stars are dots and satellites streak, a geostationary object included — it drifts
 * through the star field at ~15"/s. Parked ('mount'), the frame is pinned to the
 * horizon: the sky turns under it, so the STARS trail and a geostationary object is
 * the fixed dot. Same pass, opposite pictures. Everything drawn across a time span
 * therefore asks frameAt() for the frame at that sample's own time; the two cases
 * are one code path, and 'sky' is just the case where frameAt is constant.
 */
(function () {
  'use strict';

  // ---- module state --------------------------------------------------------
  var body = null, winRef = null, canvas = null, ctx = null;
  var cssW = 0, cssH = 0, dpr = 1;
  var dirty = false, rafQueued = false, warned = false;
  var view = { zoom: 1, panX: 0, panY: 0 };   // zoom is relative to the fit scale
  var markerHits = [];                        // [{id, x, y}]
  var elHud = null, elCursor = null, elFoot = null;
  var toolBtns = {};
  var drag = null;

  // Star cone results. Re-queried only when the tangent point or the view radius
  // moves by more than 10% of the field — a cone query walks 130k stars, and doing
  // that on every animation frame is the difference between 60 fps and 6.
  var starCache = {
    ok: false, ra0: 0, dec0: 0, radiusDeg: 0, queryDeg: 0, magLimit: -99,
    stars: [], named: [], lines: [], cons: [],
  };

  // Detector frame, rebuilt once per render. `ref` is the frame at the clock time;
  // `knots` is the drift table used when the mount is parked (null when tracking).
  var frameRef = null;                  // {raDeg, decDeg, rotDeg}
  var frameKnots = null;                // {t0, dt, n, f: [frame, ...]}
  var curScale = 1, curCx = 0, curCy = 0;
  var xfCache = { rot: NaN, flip: null, scale: NaN, cx: NaN, cy: NaN, t: null };

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var ACCENT = '#4fc3f7';
  // Targets are coloured by OBJECT TYPE (round-5 review), not orbit class: "is it
  // debris or a payload" is the first identification question. The palette lives in
  // SAT.state.typeColorOf — user-editable (round 6) and shared with the all-sky
  // view and the table's chips, so one override applies everywhere at once.
  function typeColorOf(cr) {
    try { return SAT.state.typeColorOf(cr && cr.type); }
    catch (e) { return '#90a4ae'; }        // stub states in tests may lack the helper
  }

  // Grid / scale-bar steps, degrees. Runs 90° down to 1″ so the same table serves a
  // whole-sky view and a 30″ field.
  var NICE_DEG = [
    90, 60, 30, 20, 10, 5, 2, 1,
    30 / 60, 20 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
    30 / 3600, 20 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
  ];

  function cfg() {
    var s = SAT.state.settings;
    if (!s.chart) s.chart = {};
    var c = s.chart;
    if (c.stars == null) c.stars = true;
    if (c.starNames == null) c.starNames = false;
    if (c.constLines == null) c.constLines = true;
    if (c.constNames == null) c.constNames = false;
    if (c.sunMoon == null) c.sunMoon = true;
    if (c.mw == null) c.mw = false;             // Milky Way layer, off by default
    if (c.magLimit == null) c.magLimit = 9.0;
    if (c.grid == null) c.grid = true;
    if (c.labels == null) c.labels = true;
    if (c.padFrac == null) c.padFrac = 0.7;
    return c;
  }

  function hexA(hex, a) {
    var h = (hex || ACCENT).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0x4fc3f7;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---- orientation and view transform (pure; unit-tested in tools/test_chart.js) --

  /** Bundle the display-only parameters into one immutable transform.
   *
   *  Kept pure and argument-fed so the orientation maths can be tested under node
   *  with no DOM — see tools/test_chart.js. Nothing here reads SAT.state. */
  function makeTransform(rotDeg, flipEW, scale, cx, cy) {
    var r = (rotDeg || 0) * D2R;
    return {
      cosRot: Math.cos(r), sinRot: Math.sin(r), flip: !!flipEW,
      scale: scale, cx: cx, cy: cy,
    };
  }

  /** Standard coordinates (xi east, eta north, DEGREES) -> screen pixels.
   *
   *  Convention: SKY VIEW — north up, EAST LEFT when flipEW is false. That is the
   *  orientation of a direct astronomical image (and of every FITS viewer's default),
   *  because we are looking outwards at the sphere rather than down onto a map;
   *  `flipEW` then represents an optical train with an odd number of reflections,
   *  which is exactly how the field is described in state.js. Consequences, with
   *  rotDeg = 0 and flipEW = false: a star 0.5° north of centre is at NEGATIVE screen
   *  y, and one 0.5° east is at NEGATIVE screen x.
   *
   *  rotDeg is the position angle (north through east) of chart +Y, so a point at
   *  position angle PA sits at angle (PA - rotDeg) from screen-up, measured in the
   *  same north-through-east sense — which on an east-left chart is counter-clockwise.
   *  The E/W flip is applied last and mirrors x only. */
  function skyToScreen(xi, eta, t) {
    var u = xi * t.cosRot - eta * t.sinRot;      // "chart east" component
    var v = eta * t.cosRot + xi * t.sinRot;      // "chart north" component
    return {
      x: t.cx + (t.flip ? u : -u) * t.scale,
      y: t.cy - v * t.scale,
    };
  }

  /** Exact inverse of skyToScreen. */
  function screenToSky(x, y, t) {
    var u = ((x - t.cx) / t.scale) * (t.flip ? 1 : -1);
    var v = -(y - t.cy) / t.scale;
    return {
      xi: u * t.cosRot + v * t.sinRot,
      eta: -u * t.sinRot + v * t.cosRot,
    };
  }

  /** Screen direction (unit vector) of increasing eta (north) and xi (east).
   *  This is what the compass rosette draws — the whole point of the rosette is that
   *  it is derived from the same transform the sky is, not from a stored guess. */
  function axisDirs(t) {
    // skyToScreen of the unit sky basis with the translation and scale stripped out,
    // so these stay exactly the directions the chart is actually drawn in
    var zero = { cosRot: t.cosRot, sinRot: t.sinRot, flip: t.flip, scale: 1, cx: 0, cy: 0 };
    return {
      n: skyToScreen(0, 1, zero),
      e: skyToScreen(1, 0, zero),
    };
  }

  /** Largest nice step that still gives at least `divs` divisions across `spanDeg`. */
  function gridStepDeg(spanDeg, divs) {
    var want = divs || 4;
    for (var i = 0; i < NICE_DEG.length; i++) {
      if (spanDeg / NICE_DEG[i] >= want) return NICE_DEG[i];
    }
    return NICE_DEG[NICE_DEG.length - 1];
  }

  /** Largest nice step not exceeding v — for the scale bar. */
  function niceAtMost(v) {
    for (var i = 0; i < NICE_DEG.length; i++) if (NICE_DEG[i] <= v) return NICE_DEG[i];
    return NICE_DEG[NICE_DEG.length - 1];
  }

  // ---- pointing ------------------------------------------------------------

  /** The tangent point at `date`, J2000.
   *
   *  In alt/az mode this is recomputed from az/el every frame, so a parked mount's
   *  field visibly drifts across the star background as the clock runs — which is
   *  the entire reason someone would choose alt/az here (drift scans, meteor cameras,
   *  a fixed all-sky lens). Returns null when alt/az is asked for without a site,
   *  because there is then no answer to give. */
  function tangentPoint(date) {
    var o = SAT.state.obs;
    if (o.mode === 'altaz') {
      var loc = SAT.state.activeLocation();
      if (!loc) return null;
      try {
        // kind-dispatching: LVLH on an orbit site, refracted alt/az on the ground
        return SAT.prop.siteAltAzToRaDec(loc, o.azDeg, o.elDeg, date,
          { refract: true, dut1S: o.dut1S });
      } catch (e) { return null; }
    }
    return { raDeg: o.raDeg, decDeg: o.decDeg };
  }

  /** Fit scale in px/deg: the FOV occupies padFrac of the binding viewport axis. */
  function fitScale() {
    var o = SAT.state.obs, c = cfg();
    var pad = SAT.util.clamp(c.padFrac || 0.7, 0.2, 0.98);
    if (o.fovShape === 'circ') {
      return pad * Math.min(cssW, cssH) / Math.max(1e-6, 2 * o.fovRDeg);
    }
    return pad * Math.min(cssW / Math.max(1e-6, o.fovWDeg),
      cssH / Math.max(1e-6, o.fovHDeg));
  }

  function transform() {
    var o = SAT.state.obs;
    return makeTransform(o.rotDeg, o.flipEW, fitScale() * view.zoom,
      cssW / 2 + view.panX, cssH / 2 + view.panY);
  }

  /** Transform for a frame, memoised on its rotation: a parked mount asks for this
   *  once per drawn sample and the answer changes only when the frame does. */
  function xf(fr) {
    var o = SAT.state.obs;
    var c = xfCache;
    if (c.t && c.rot === fr.rotDeg && c.flip === o.flipEW && c.scale === curScale
        && c.cx === curCx && c.cy === curCy) {
      return c.t;
    }
    c.rot = fr.rotDeg; c.flip = o.flipEW; c.scale = curScale; c.cx = curCx; c.cy = curCy;
    c.t = makeTransform(fr.rotDeg, o.flipEW, curScale, curCx, curCy);
    return c.t;
  }

  /** Radius in degrees of the circle enclosing the viewport — the star cone radius. */
  function viewRadiusDeg(t) {
    return 0.5 * Math.hypot(cssW, cssH) / Math.max(1e-9, t.scale);
  }

  // ---- the detector frame as a function of time ----------------------------

  /** Shortest-way angular interpolation, degrees. A frame table that crosses 0h RA
   *  would otherwise sweep the long way round for exactly one knot interval. */
  function lerpAngle(a, b, f) {
    var d = ((b - a + 540) % 360) - 180;
    return a + d * f;
  }

  function lerpFrame(a, b, f) {
    return {
      raDeg: ((lerpAngle(a.raDeg, b.raDeg, f) % 360) + 360) % 360,
      decDeg: a.decDeg + (b.decDeg - a.decDeg) * f,
      rotDeg: lerpAngle(a.rotDeg, b.rotDeg, f),
    };
  }

  /** Position angle of the mount's +altitude direction at a parked az/el.
   *
   *  This is what makes a parked field ROTATE as well as drift: chart +Y is fixed to
   *  the mount, so its position angle on the sky walks with the parallactic angle.
   *  Measured numerically off a 0.01 deg probe rather than from the closed-form
   *  parallactic angle, so it inherits whatever refraction setting the pointing uses
   *  instead of quietly disagreeing with it. */
  function verticalPA(azDeg, elDeg, loc, date, opts, tp) {
    var up = SAT.prop.siteAltAzToRaDec(loc, azDeg, Math.min(89.99, elDeg + 0.01), date, opts);
    if (!up) throw new Error('unresolvable site');   // caught by buildFrames -> fixed frame
    return SAT.frames.posAngle(tp.raDeg, tp.decDeg, up.raDeg, up.decDeg);
  }

  /** Build the frame table covering [t0, t1] around the clock time.
   *
   *  Tracking sidereally there is nothing to build — one constant frame. Parked, we
   *  sample the drift every ~15 s and interpolate, because altAzToRaDec runs the full
   *  nutation series and calling it per path sample per crossing per animation frame
   *  is thousands of evaluations a second for a drift that is smooth to well under a
   *  pixel between knots. */
  function buildFrames(nowMs, t0Ms, t1Ms) {
    var o = SAT.state.obs;
    var now = new Date(nowMs);
    var base = tangentPoint(now);
    frameKnots = null;
    if (!base) { frameRef = null; return null; }
    frameRef = { raDeg: base.raDeg, decDeg: base.decDeg, rotDeg: o.rotDeg };

    var loc = SAT.state.activeLocation();
    if (o.track !== 'mount' || !loc || !(t1Ms > t0Ms)) return frameRef;

    var opts = { refract: true, dut1S: o.dut1S };
    var azEl;
    try {
      azEl = o.mode === 'altaz'
        ? { azDeg: o.azDeg, elDeg: o.elDeg }
        : SAT.prop.siteRaDecToAltAz(loc, base.raDeg, base.decDeg, now, opts);
      if (!azEl) throw new Error('unresolvable site');   // -> fixed frame below
      // reference orientation: whatever the parked mount's +Y reads as right now
      var pa0 = verticalPA(azEl.azDeg, azEl.elDeg, loc, now, opts, base);
      var n = SAT.util.clamp(Math.ceil((t1Ms - t0Ms) / 15000) + 1, 2, 128);
      var dt = (t1Ms - t0Ms) / (n - 1);
      var f = [];
      for (var i = 0; i < n; i++) {
        var d = new Date(t0Ms + dt * i);
        var tp = SAT.prop.siteAltAzToRaDec(loc, azEl.azDeg, azEl.elDeg, d, opts);
        if (!tp) throw new Error('unresolvable site');
        var pa = verticalPA(azEl.azDeg, azEl.elDeg, loc, d, opts, tp);
        f.push({ raDeg: tp.raDeg, decDeg: tp.decDeg, rotDeg: o.rotDeg + (pa - pa0) });
      }
      frameKnots = { t0: t0Ms, dt: dt, n: n, f: f };
    } catch (e) {
      frameKnots = null;          // a bad site or epoch degrades to a fixed frame
    }
    return frameRef;
  }

  /** The detector frame at tMs. Constant when tracking the sky. */
  function frameAt(tMs) {
    var k = frameKnots;
    if (!k) return frameRef;
    var u = (tMs - k.t0) / k.dt;
    if (!(u > 0)) return k.f[0];
    if (u >= k.n - 1) return k.f[k.n - 1];
    var i = Math.floor(u);
    return lerpFrame(k.f[i], k.f[i + 1], u - i);
  }

  /** Project a sky position into the detector frame that applies at tMs. */
  function projAt(raDeg, decDeg, tMs) {
    var fr = frameAt(tMs);
    if (!fr) return null;
    return proj(raDeg, decDeg, fr.raDeg, fr.decDeg, xf(fr));
  }

  // ---- view manipulation ---------------------------------------------------

  function clampZoom(z) { return SAT.util.clamp(z, 0.2, 20); }

  /** Zoom keeping the sky point under (mx,my) pinned to the cursor. The transform is
   *  linear about (cx,cy), so the fixed point falls out algebraically. */
  function zoomAt(mx, my, factor) {
    var z0 = view.zoom, z1 = clampZoom(z0 * factor);
    if (z1 === z0) return;
    var cx0 = cssW / 2 + view.panX, cy0 = cssH / 2 + view.panY;
    var k = z1 / z0;
    view.zoom = z1;
    view.panX = (mx - k * (mx - cx0)) - cssW / 2;
    view.panY = (my - k * (my - cy0)) - cssH / 2;
    requestRender();
  }

  function fitView() {
    view.zoom = 1; view.panX = 0; view.panY = 0;
    requestRender();
  }

  // ---- star layer ----------------------------------------------------------
  // Round 12: the deep catalogue is REAFFIRMED as this chart's star background —
  // round 11 briefly made it bright-only on a misread instruction; the SatObserver
  // bright-only fallback belongs to the All-Sky panel. See CONTRACT
  // "Chart star background".

  /** Cone query with caching. Queries 1.2x wider than needed so the 10%-of-field
   *  reuse window below is always fully covered by the cached disc. */
  function ensureStars(ra0, dec0, radiusDeg, magLimit) {
    var c = starCache;
    if (!SAT.stars || typeof SAT.stars.cone !== 'function') {
      // stars.js absent or not loaded yet: an empty field, never a thrown render
      c.ok = false; c.stars = []; c.named = []; c.lines = []; c.cons = [];
      return c;
    }
    var slack = 0.10 * radiusDeg;
    if (c.ok && c.magLimit === magLimit
        && Math.abs(radiusDeg - c.radiusDeg) <= slack
        && SAT.frames.sep(c.ra0, c.dec0, ra0, dec0) <= slack) {
      return c;
    }
    var q = radiusDeg * 1.2;
    var stars = [], named = [], lines = [], cons = [];
    try { stars = SAT.stars.cone(ra0, dec0, q, magLimit) || []; } catch (e) { stars = []; }
    try {
      if (typeof SAT.stars.named === 'function') named = SAT.stars.named(ra0, dec0, q) || [];
    } catch (e) { named = []; }
    try {
      if (typeof SAT.stars.constellationLines === 'function') {
        lines = SAT.stars.constellationLines(ra0, dec0, q) || [];
      }
    } catch (e) { lines = []; }
    // constellation names straight from the bright catalogue (CN toggle, round 11)
    var sep = SAT.frames.sep;
    var cn = ((typeof SAT !== 'undefined' && SAT.stardata) || {}).cons || [];
    for (var i = 0; i < cn.length; i++) {
      var ra = ((cn[i][0] % 360) + 360) % 360;
      if (sep(ra0, dec0, ra, cn[i][1]) <= q) {
        cons.push({ raDeg: ra, decDeg: cn[i][1], name: cn[i][2] });
      }
    }
    c.ok = true; c.ra0 = ra0; c.dec0 = dec0;
    c.radiusDeg = radiusDeg; c.queryDeg = q; c.magLimit = magLimit;
    c.stars = stars; c.named = named; c.lines = lines; c.cons = cons;
    return c;
  }

  function invalidateStars() { starCache.ok = false; }

  // ---- small drawing helpers ----------------------------------------------

  function haloText(text, x, y, fill, align, baseline) {
    ctx.textAlign = align || 'left';
    ctx.textBaseline = baseline || 'middle';
    ctx.strokeStyle = 'rgba(5,8,12,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function onScreen(p, pad) {
    var m = pad == null ? 0 : pad;
    return p && p.x >= -m && p.x <= cssW + m && p.y >= -m && p.y <= cssH + m;
  }

  /** Project a sky position straight to pixels. Null when the point is over the
   *  tangent-plane horizon (>= 90° away), which tanProject reports as null. */
  function proj(raDeg, decDeg, ra0, dec0, t) {
    var s = SAT.frames.tanProject(raDeg, decDeg, ra0, dec0);
    if (!s) return null;
    return skyToScreen(s.xi, s.eta, t);
  }

  function fmtDecShort(d, stepDeg) {
    var sign = d < 0 ? '−' : '+', a = Math.abs(d);
    var dd = Math.floor(a + 1e-9);
    var mFull = (a - dd) * 60, mm = Math.floor(mFull + 1e-7);
    var ss = Math.round((mFull - mm) * 60);
    if (ss >= 60) { ss = 0; mm += 1; }
    if (stepDeg >= 1 - 1e-9) return sign + dd + '°';
    if (stepDeg >= 1 / 60 - 1e-12) return sign + dd + '°' + SAT.util.pad2(mm) + '′';
    return sign + dd + '°' + SAT.util.pad2(mm) + '′' + SAT.util.pad2(ss) + '″';
  }

  function fmtRaShort(raDeg, stepDeg) {
    var h = (((raDeg % 360) + 360) % 360) / 15;
    var hh = Math.floor(h + 1e-9);
    var mFull = (h - hh) * 60, mm = Math.floor(mFull + 1e-7);
    var ss = Math.round((mFull - mm) * 60);
    if (ss >= 60) { ss = 0; mm += 1; }
    if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
    if (stepDeg >= 15) return hh + 'h';
    if (stepDeg >= 15 / 60) return hh + 'h' + SAT.util.pad2(mm) + 'm';
    return hh + 'h' + SAT.util.pad2(mm) + 'm' + SAT.util.pad2(ss) + 's';
  }

  // ---- layers --------------------------------------------------------------

  function drawGrid(ra0, dec0, t) {
    var fr = viewRadiusDeg(t);
    var stepDec = gridStepDeg(2 * fr, 4);
    // RA lines are spaced so their on-sky separation matches the dec spacing; near
    // the pole that means far fewer meridians, which is what keeps a polar field
    // from turning into a solid fan of lines.
    var cosd = Math.max(0.02, Math.cos(dec0 * D2R));
    var stepRa = gridStepDeg(2 * fr / cosd, 4);
    var decMin = Math.max(-90, dec0 - fr), decMax = Math.min(90, dec0 + fr);
    var raHalf = Math.min(180, fr / cosd + stepRa);
    var i, j, p, prev;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(232,234,237,0.11)';
    ctx.font = '10px ' + MONO;

    // parallels of declination
    var d0 = Math.ceil(decMin / stepDec) * stepDec;
    for (var d = d0; d <= decMax + 1e-9; d += stepDec) {
      prev = null;
      ctx.beginPath();
      for (i = 0; i <= 96; i++) {
        var ra = ra0 - raHalf + (2 * raHalf) * i / 96;
        p = proj(ra, d, ra0, dec0, t);
        if (!p || !isFinite(p.x) || Math.abs(p.x) > 1e5 || Math.abs(p.y) > 1e5) {
          prev = null; continue;
        }
        if (prev) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        prev = p;
      }
      ctx.stroke();
      p = proj(ra0, d, ra0, dec0, t);
      if (onScreen(p, 0)) {
        haloText(fmtDecShort(d, stepDec), 4, p.y, 'rgba(154,164,174,0.85)');
      }
    }

    // meridians of right ascension
    var r0 = Math.ceil((ra0 - raHalf) / stepRa) * stepRa;
    for (var r = r0; r <= ra0 + raHalf + 1e-9; r += stepRa) {
      prev = null;
      ctx.beginPath();
      for (j = 0; j <= 64; j++) {
        var dd2 = decMin + (decMax - decMin) * j / 64;
        p = proj(r, dd2, ra0, dec0, t);
        if (!p || !isFinite(p.x) || Math.abs(p.x) > 1e5 || Math.abs(p.y) > 1e5) {
          prev = null; continue;
        }
        if (prev) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        prev = p;
      }
      ctx.stroke();
      p = proj(r, dec0, ra0, dec0, t);
      if (onScreen(p, 0)) {
        haloText(fmtRaShort(r, stepRa), p.x, cssH - 6, 'rgba(154,164,174,0.85)', 'center');
      }
    }
  }

  function drawStars(ra0, dec0, t) {
    var c = cfg();
    if (!c.stars && !c.constLines && !c.starNames && !c.constNames) return;
    var fr = viewRadiusDeg(t);
    var cache = ensureStars(ra0, dec0, fr, c.magLimit);
    var spanDeg = cssW / Math.max(1e-9, t.scale);
    var i, j, p, prev, st;

    // Constellation lines and names only make sense once the field is wide enough to
    // contain a recognisable figure; below ~5° they are a couple of stray strokes.
    if (c.constLines && spanDeg > 5 && cache.lines.length) {
      ctx.strokeStyle = 'rgba(110,150,215,0.28)';
      ctx.lineWidth = 1;
      for (i = 0; i < cache.lines.length; i++) {
        var seg = cache.lines[i];
        prev = null;
        ctx.beginPath();
        for (j = 0; j < seg.length; j++) {
          p = proj(seg[j].raDeg, seg[j].decDeg, ra0, dec0, t);
          if (!p) { prev = null; continue; }
          if (prev) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          prev = p;
        }
        ctx.stroke();
      }
    }

    if (c.stars && cache.stars.length) {
      for (i = 0; i < cache.stars.length; i++) {
        st = cache.stars[i];
        p = proj(st.raDeg, st.decDeg, ra0, dec0, t);
        if (!onScreen(p, 4)) continue;
        // Radius/alpha vs magnitude, retuned in round 9 (was linear 3.8 - 0.30m):
        // a linear ramp spends most of its range on the handful of m<3 stars and
        // compresses m4-9 — where nearly every background star lives — into
        // ~1.5 px, so the field read as same-size dots. Radius follows the flux
        // law, shrinking ~18% per magnitude (area halves every ~1.8 mag): every
        // step of the sequence is a visible step on screen. m0 = 5.2 px, m3 = 2.9,
        // m5 = 2.0, m7 = 1.3, m9 = 0.9; capped at 6.5 px so Sirius is a star and
        // not a blob, floored at 0.7 px / alpha 0.42 so the deep catalogue's
        // m9-10.5 end stays visible rather than clipped away.
        var rad = Math.min(6.5, Math.max(0.7, 5.2 * Math.pow(10, -0.085 * st.mag)));
        var alpha = Math.max(0.42, Math.min(1, 1.04 - 0.058 * st.mag));
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(225,235,255,' + alpha.toFixed(2) + ')';
        ctx.fill();
      }
    }

    if (c.starNames && spanDeg > 5 && cache.named.length) {
      ctx.font = '9px ' + MONO;
      for (i = 0; i < cache.named.length; i++) {
        var nm = cache.named[i];
        p = proj(nm.raDeg, nm.decDeg, ra0, dec0, t);
        if (!onScreen(p, 0)) continue;
        haloText(nm.name, p.x + 5, p.y - 4, 'rgba(185,205,240,0.9)');
      }
    }

    if (c.constNames && spanDeg > 5 && cache.cons.length) {
      ctx.font = 'italic 10px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (i = 0; i < cache.cons.length; i++) {
        var cn = cache.cons[i];
        p = proj(cn.raDeg, cn.decDeg, ra0, dec0, t);
        if (!onScreen(p, 0)) continue;
        ctx.fillStyle = 'rgba(140,165,205,0.55)';
        ctx.fillText(cn.name, p.x, p.y);
      }
      ctx.textAlign = 'left';
    }
  }

  // ---- Milky Way -----------------------------------------------------------
  // Faint isophotes (d3-celestial contours via vendor/mwdata.js), ported from the
  // SatObserver polar chart to the gnomonic frame. Two things need care:
  //  1. The gnomonic radius diverges at 90° from the tangent point and the far
  //     hemisphere has no image at all, so every vertex is clamped radially to an
  //     off-screen rim (direction from centre preserved) — fills stay finite and
  //     are exact inside the viewport.
  //  2. Same fill-parity trap as the polar chart: when a ring's projected outline
  //     wraps the chart, canvas fills the wrong side. The north galactic pole is a
  //     point known to be OUTSIDE every isophote; any ring whose outline contains
  //     its projection gets an extra rim-circle subpath to flip even-odd parity
  //     back. (SatObserver's construction, different projection, same reasoning.)
  // Documented deviation (CONTRACT): no twilight fade — the chart background never
  // changes with the sun, so the layer draws at full contour alpha whenever on.
  var MW_GP_RA = 192.859, MW_GP_DEC = 27.128; // north galactic pole (J2000)

  function mwVecs(mw) {
    return mw.levels.map(function (lev) {
      return lev.rings.map(function (ring) {
        var v = new Float64Array(ring.length * 3);
        for (var i = 0; i < ring.length; i++) {
          var ra = ring[i][0] * D2R, de = ring[i][1] * D2R, cd = Math.cos(de);
          v[i * 3] = cd * Math.cos(ra);
          v[i * 3 + 1] = cd * Math.sin(ra);
          v[i * 3 + 2] = Math.sin(de);
        }
        return v;
      });
    });
  }

  function pointInPoly(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var yi = pts[i].y, yj = pts[j].y;
      if ((yi > py) !== (yj > py) &&
          px < (pts[j].x - pts[i].x) * (py - yi) / (yj - yi) + pts[i].x) inside = !inside;
    }
    return inside;
  }

  function drawMW(ra0, dec0, t) {
    var mw = SAT.mwdata;
    if (!mw || !cfg().mw) return;
    if (!mw._vecs) mw._vecs = mwVecs(mw);
    var ra = ra0 * D2R, de = dec0 * D2R;
    // tangent-frame basis: boresight b, east e (b × pole plane), north n
    var bx = Math.cos(ra) * Math.cos(de), by = Math.sin(ra) * Math.cos(de), bz = Math.sin(de);
    var ex = -Math.sin(ra), ey = Math.cos(ra);                        // ez = 0
    var nx = -Math.cos(ra) * Math.sin(de), ny = -Math.sin(ra) * Math.sin(de), nz = Math.cos(de);
    var RIM = 2.5 * (cssW + cssH);           // px — beyond every visible pixel
    var fMin = 0.02;                          // ~cos 88.9°: off-rim anyway
    // equatorial unit vector -> chart point (clamped gnomonic; see header)
    function pt(x, y, z) {
      var f = x * bx + y * by + z * bz;
      var u = x * ex + y * ey;               // ·east, sin-scaled
      var v = x * nx + y * ny + z * nz;      // ·north
      var p = (f > fMin)
        ? skyToScreen(u / f * R2D, v / f * R2D, t)
        : skyToScreen(u * 1e4, v * 1e4, t);  // horizon/far side: direction only
      var dx = p.x - t.cx, dy = p.y - t.cy;
      var d = Math.hypot(dx, dy);
      if (d > RIM) { p.x = t.cx + dx / d * RIM; p.y = t.cy + dy / d * RIM; }
      return p;
    }
    // long projected chords are subdivided along the great circle, so no edge can
    // slash across the field on its way to the rim
    var mc = 0.30 * Math.min(cssW, cssH);
    var maxChord2 = mc * mc;
    function subdiv(out, x0, y0, z0, p0, x1, y1, z1, p1, depth) {
      var dx = p1.x - p0.x, dy = p1.y - p0.y;
      if (depth > 0 && dx * dx + dy * dy > maxChord2) {
        var xm = x0 + x1, ym = y0 + y1, zm = z0 + z1;
        var n = Math.sqrt(xm * xm + ym * ym + zm * zm);
        if (n > 1e-9) {
          xm /= n; ym /= n; zm /= n;
          var pm = pt(xm, ym, zm);
          subdiv(out, x0, y0, z0, p0, xm, ym, zm, pm, depth - 1);
          subdiv(out, xm, ym, zm, pm, x1, y1, z1, p1, depth - 1);
          return;
        }
      }
      out.push(p1);
    }
    var gd = MW_GP_DEC * D2R, gr = MW_GP_RA * D2R, gc = Math.cos(gd);
    var gpP = pt(gc * Math.cos(gr), gc * Math.sin(gr), Math.sin(gd));
    var RIMC = RIM * 1.2;
    ctx.save();
    // soften the isophote steps into a diffuse glow where the browser allows
    var blur = typeof ctx.filter === 'string';
    if (blur) ctx.filter = 'blur(' + (Math.min(cssW, cssH) * 0.01).toFixed(1) + 'px)';
    for (var L = 0; L < mw.levels.length; L++) {
      var lev = mw.levels[L];
      ctx.beginPath();
      for (var ri = 0; ri < lev.rings.length; ri++) {
        var v = mw._vecs[L][ri];
        var n = v.length / 3;
        var p0 = pt(v[0], v[1], v[2]);
        var pts = [p0];
        for (var i = 1; i <= n; i++) {
          var j = (i % n) * 3, k = ((i - 1) * 3);
          var p1 = pt(v[j], v[j + 1], v[j + 2]);
          subdiv(pts, v[k], v[k + 1], v[k + 2], p0, v[j], v[j + 1], v[j + 2], p1, 4);
          p0 = p1;
        }
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var q = 1; q < pts.length; q++) ctx.lineTo(pts[q].x, pts[q].y);
        ctx.closePath();
        if (pointInPoly(gpP.x, gpP.y, pts)) {
          ctx.moveTo(t.cx + RIMC, t.cy);
          ctx.arc(t.cx, t.cy, RIMC, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = 'rgba(172,192,222,' + lev.a + ')';
      ctx.fill('evenodd');
    }
    if (blur) ctx.filter = 'none';
    ctx.restore();
  }

  function drawFov(t) {
    var o = SAT.state.obs;
    var cx = t.cx, cy = t.cy;
    var circ = o.fovShape === 'circ';
    var hw = (circ ? o.fovRDeg : o.fovWDeg / 2) * t.scale;
    var hh = (circ ? o.fovRDeg : o.fovHDeg / 2) * t.scale;

    // Dim everything outside the field by ~25%. even-odd fill so the hole matches the
    // outline exactly; drawn before the satellites so those stay at full brightness.
    ctx.beginPath();
    ctx.rect(0, 0, cssW, cssH);
    if (circ) { ctx.moveTo(cx + hw, cy); ctx.arc(cx, cy, hw, 0, Math.PI * 2); }
    else { ctx.rect(cx - hw, cy - hh, 2 * hw, 2 * hh); }
    ctx.fillStyle = 'rgba(4,7,10,0.25)';
    ctx.fill('evenodd');

    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (circ) ctx.arc(cx, cy, hw, 0, Math.PI * 2);
    else ctx.rect(cx - hw, cy - hh, 2 * hw, 2 * hh);
    ctx.stroke();

    // angular size on the edges — the number people actually check
    ctx.font = '10px ' + MONO;
    if (circ) {
      haloText('r ' + SAT.util.fmtAngle(o.fovRDeg, 2), cx, cy - hw - 8, ACCENT, 'center');
    } else {
      haloText(SAT.util.fmtAngle(o.fovWDeg, 2), cx, cy - hh - 8, ACCENT, 'center');
      ctx.save();
      ctx.translate(cx - hw - 8, cy);
      ctx.rotate(-Math.PI / 2);
      haloText(SAT.util.fmtAngle(o.fovHDeg, 2), 0, 0, ACCENT, 'center');
      ctx.restore();
    }
  }

  function drawCompass(t) {
    // Always visible, and always derived from the live transform: this rosette is how
    // the user confirms the chart matches the frame on their screen. Getting the
    // orientation wrong and not noticing is the classic way to misidentify a trail.
    var ox = cssW - 40, oy = cssH - 40, L = 20;
    var dirs = axisDirs(t);
    ctx.font = '10px ' + MONO;

    ctx.beginPath();
    ctx.arc(ox, oy, L + 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,14,18,0.62)';
    ctx.fill();

    function arrow(dx, dy, label, col) {
      var tx = ox + dx * L, ty = oy + dy * L;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // arrowhead
      var a = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 5 * Math.cos(a - 0.4), ty - 5 * Math.sin(a - 0.4));
      ctx.lineTo(tx - 5 * Math.cos(a + 0.4), ty - 5 * Math.sin(a + 0.4));
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      haloText(label, ox + dx * (L + 7), oy + dy * (L + 7), col, 'center');
    }
    arrow(dirs.n.x, dirs.n.y, 'N', '#e8eaed');
    arrow(dirs.e.x, dirs.e.y, 'E', ACCENT);
  }

  function drawScaleBar(t) {
    var targetPx = Math.max(40, cssW * 0.18);
    var deg = niceAtMost(targetPx / Math.max(1e-9, t.scale));
    var px = deg * t.scale;
    var x0 = 12, y0 = cssH - 22;
    ctx.strokeStyle = 'rgba(232,234,237,0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + px, y0);
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + px, y0 - 4); ctx.lineTo(x0 + px, y0 + 4);
    ctx.stroke();
    ctx.font = '10px ' + MONO;
    haloText(SAT.util.fmtAngle(deg, deg >= 1 ? 0 : 1), x0 + px / 2, y0 - 10,
      'rgba(232,234,237,0.9)', 'center');
  }

  // ---- crossings -----------------------------------------------------------

  /** Interpolate a path sample at tMs, or null when tMs is outside the crossing. */
  function pathPosAt(path, tMs) {
    if (!path || path.length < 2) return null;
    if (tMs < path[0].t || tMs > path[path.length - 1].t) return null;
    for (var i = 1; i < path.length; i++) {
      if (tMs <= path[i].t) {
        var a = path[i - 1], b = path[i];
        var span = b.t - a.t;
        var f = span > 0 ? (tMs - a.t) / span : 0;
        // RA must be interpolated the short way round, or a path crossing 0h sweeps
        // backwards across the whole sky for exactly one segment
        var dra = ((b.raDeg - a.raDeg + 540) % 360) - 180;
        return {
          t: tMs,
          raDeg: a.raDeg + dra * f,
          decDeg: a.decDeg + (b.decDeg - a.decDeg) * f,
        };
      }
    }
    return null;
  }

  /* ---- extended pass track (round-3 review) --------------------------------
   * The scan's `path` covers only tEnter..tExit — for a telescope-sized field a
   * few seconds of arc. The extended track samples the SAME object over the WHOLE
   * scan timespan (while above the horizon), so the user sees where the trail
   * came from and where it went, and the label stays on screen after a crossing
   * that lasted two seconds. Positions are sky RA/Dec, pure functions of time, so
   * each track is computed once per scan and cached on the crossing object; the
   * per-frame cost is only the projection.
   */
  var EXT_BUILD_PER_FRAME = 30;   // spread the one-time build over frames: 81
                                  // tracks x <=400 SGP4+frame solutions is ~0.5 s,
                                  // which as a single hiccup would read as a hang

  function extTrackOf(cr, loc) {
    var sc = SAT.state.scan;
    var key = sc.ranAt ? sc.ranAt.getTime() : 0;
    if (cr._extK === key) return cr._ext;         // may be null (build failed)
    var params = sc.params || {};
    var t0 = params.t0Ms, spanMs = (params.spanMin || 0) * 60000;
    var obj = SAT.state.getObj ? SAT.state.getObj(cr.satId) : null;
    cr._extK = key;
    cr._ext = null;
    if (t0 == null || !(spanMs > 0) || !obj || !loc || !SAT.prop) return null;
    // Step: ~0.4 deg per segment at the CA rate, floored so a whole track never
    // exceeds ~400 points, clamped to [2 s, 60 s]. The bright in-FOV segment still
    // comes from the scan's fine samples, so coarseness here only touches the dim
    // context trail.
    var rate = Math.max(1, cr.rateAsPerS || 1);
    var stepMs = 1440e3 / rate;                   // 0.4 deg = 1440 arcsec
    stepMs = Math.max(stepMs, spanMs / 400);
    stepMs = Math.min(60000, Math.max(2000, stepMs));
    var pts = [];
    for (var t = t0; t <= t0 + spanMs; t += stepMs) {
      var lk = null;
      try { lk = SAT.prop.look(loc, obj, new Date(t), { dut1S: SAT.state.obs.dut1S }); }
      catch (e) { lk = null; }
      // null marks a below-horizon (or failed) gap; consumers break the line there
      pts.push((lk && lk.elDeg > 0) ? { t: t, raDeg: lk.raDeg, decDeg: lk.decDeg } : null);
    }
    cr._ext = pts.some(function (q) { return q; }) ? pts : null;
    return cr._ext;
  }

  /** pathPosAt over an extended track: interpolate only inside a contiguous
   *  above-horizon run, never across a gap. */
  function extPosAt(pts, tMs) {
    if (!pts) return null;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      if (!a || !b) continue;
      if (tMs >= a.t && tMs <= b.t) return pathPosAt([a, b], tMs);
    }
    return null;
  }

  /** Arrowhead with its tip at b, pointing a->b — the pass motion direction
   *  (round-5 review). Nothing else on the trail says which way the object moved,
   *  and a streak on a real frame has no arrow either: this is the disambiguator. */
  function drawMotionArrow(a, b, col) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    dx /= L; dy /= L;
    var s = 7;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(b.x - s * (dx * 0.866 - dy * 0.5), b.y - s * (dy * 0.866 + dx * 0.5));
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x - s * (dx * 0.866 + dy * 0.5), b.y - s * (dy * 0.866 - dx * 0.5));
    ctx.stroke();
  }

  /** Place a motion arrow ~60% along the path, searching forward for a segment
   *  that is on screen and long enough (>= 6 px) to define a direction. */
  function arrowOnPath(path, col) {
    var start = Math.max(1, Math.floor(path.length * 0.6));
    for (var j = start; j < path.length; j++) {
      var a = projAt(path[j - 1].raDeg, path[j - 1].decDeg, path[j - 1].t);
      var b = projAt(path[j].raDeg, path[j].decDeg, path[j].t);
      if (!a || !b || !onScreen(b, 20)) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 6) continue;
      drawMotionArrow(a, b, col);
      return;
    }
  }

  function drawCrossings(list, nowMs) {
    var c = cfg();
    var selId = SAT.state.selection ? SAT.state.selection.satId : null;
    var loc = SAT.state.activeLocation();
    var i, j, p;
    var extBudget = EXT_BUILD_PER_FRAME;
    var extPending = false;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Layer 1: the dim whole-timespan tracks, under everything else. Drawn first
    // so the bright in-FOV segments and the FOV outline always win visually.
    ctx.lineWidth = 1;
    for (i = 0; i < list.length; i++) {
      var crx = list[i];
      var key = SAT.state.scan.ranAt ? SAT.state.scan.ranAt.getTime() : 0;
      if (crx._extK !== key) {
        if (extBudget <= 0) { extPending = true; continue; }
        extBudget--;
      }
      var ext = extTrackOf(crx, loc);
      if (!ext) continue;
      var ecol = hexA(typeColorOf(crx), 0.16);
      var prev = null;
      for (j = 0; j < ext.length; j++) {
        var q = ext[j];
        if (!q) { prev = null; continue; }
        var sp = projAt(q.raDeg, q.decDeg, q.t);
        if (!sp || !onScreen(sp, 400)) { prev = null; continue; }
        if (prev) {
          ctx.strokeStyle = ecol;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(sp.x, sp.y);
          ctx.stroke();
        }
        prev = sp;
      }
    }
    // finish building the remaining tracks on subsequent frames
    if (extPending) requestRender();

    for (i = 0; i < list.length; i++) {
      var cr = list[i];
      var col = typeColorOf(cr);
      var path = cr.path;
      if (!path || path.length < 2) continue;

      // The crossing path IS the identification tool: the trail the object cuts
      // across the field between tEnter and tExit, drawn from the scan's own samples
      // so curvature is preserved. The already-swept portion is dimmed, so what
      // remains bright is what is still to come at the current clock time.
      ctx.lineWidth = 1.3;
      for (j = 1; j < path.length; j++) {
        var a = projAt(path[j - 1].raDeg, path[j - 1].decDeg, path[j - 1].t);
        var b = projAt(path[j].raDeg, path[j].decDeg, path[j].t);
        if (!a || !b) continue;
        if (!onScreen(a, 400) && !onScreen(b, 400)) continue;
        var swept = (path[j - 1].t + path[j].t) / 2 <= nowMs;
        ctx.strokeStyle = hexA(col, swept ? 0.3 : 0.85);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // which way is it moving — one arrowhead per trail
      arrowOnPath(path, hexA(col, 0.9));

      // Current position. Inside the crossing window the scan's fine path is the
      // authority; outside it (the object has left the field, or not yet arrived)
      // fall back to the extended track, drawn dimmer — a two-second crossing must
      // not mean a two-second label (round-3 review).
      var pos = pathPosAt(path, nowMs);
      var inField = !!pos;
      if (!pos) pos = extPosAt(cr._ext, nowMs);
      if (!pos) continue;
      p = projAt(pos.raDeg, pos.decDeg, nowMs);
      if (!onScreen(p, 30)) continue;

      if (!inField) ctx.globalAlpha = 0.55;
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
      ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
      if (cr.satId === selId) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      if (c.labels) {
        ctx.font = '11px ' + MONO;
        var lbl = cr.name || String(cr.norad || '');
        haloText(lbl, p.x + 9, p.y, '#ffffff');
      }
      if (!inField) ctx.globalAlpha = 1;
      markerHits.push({ id: cr.satId, x: p.x, y: p.y });
    }
    return list.length;
  }

  function drawSunMoon(ra0, dec0, t, date) {
    if (!cfg().sunMoon) return null;
    var sun = null, moon = null, p;
    try { sun = SAT.frames.sunJ2000(date); } catch (e) { sun = null; }
    try { moon = SAT.frames.moonJ2000(date); } catch (e) { moon = null; }

    if (sun) {
      p = proj(sun.raDeg, sun.decDeg, ra0, dec0, t);
      if (onScreen(p, 20)) {
        // rayed disc, straight from the SatObserver chart
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 1.5;
        for (var k = 0; k < 8; k++) {
          var a = k * Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * 7, p.y + Math.sin(a) * 7);
          ctx.lineTo(p.x + Math.cos(a) * 11, p.y + Math.sin(a) * 11);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd54f';
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,40,0,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (moon) {
      var q = proj(moon.raDeg, moon.decDeg, ra0, dec0, t);
      if (onScreen(q, 20)) {
        // geocentric sun–moon elongation -> phase; bright limb faces the sun.
        // The sun can be over the tangent-plane horizon (unprojectable), so the
        // limb direction comes from a waypoint 1° along the moon->sun great
        // circle, which is always projectable next to an on-screen moon.
        var R = 5.5, phi = 0, cosPsi = 0;
        var mv = sun ? SAT.frames.raDecToVec(moon.raDeg, moon.decDeg) : null;
        if (mv) {
          var sv = SAT.frames.raDecToVec(sun.raDeg, sun.decDeg);
          cosPsi = mv.x * sv.x + mv.y * sv.y + mv.z * sv.z;
          var tx = sv.x - cosPsi * mv.x, ty = sv.y - cosPsi * mv.y, tz = sv.z - cosPsi * mv.z;
          var tn = Math.hypot(tx, ty, tz);
          if (tn > 1e-9) {
            var wc = Math.cos(D2R), ws = Math.sin(D2R);
            var wrd = SAT.frames.vecToRaDec({
              x: mv.x * wc + tx / tn * ws,
              y: mv.y * wc + ty / tn * ws,
              z: mv.z * wc + tz / tn * ws,
            });
            var wp = proj(wrd.raDeg, wrd.decDeg, ra0, dec0, t);
            if (wp) phi = Math.atan2(wp.y - q.y, wp.x - q.x);
          }
        }
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(phi);                    // +x now points toward the sun
        ctx.beginPath();                    // dark side
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fillStyle = '#3c4148';
        ctx.fill();
        ctx.beginPath();                    // lit side: sun-side semicircle …
        ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
        // … closed by the terminator ellipse (toward the sun when crescent)
        ctx.ellipse(0, 0, R * Math.abs(cosPsi), R, 0, Math.PI / 2, -Math.PI / 2, cosPsi > 0);
        ctx.fillStyle = '#e6e2d6';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(8,10,14,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
    return moon;
  }

  // ---- render --------------------------------------------------------------

  function centreMessage(text) {
    ctx.fillStyle = '#9aa4ae';
    ctx.font = '12px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cssW / 2, cssH / 2);
    ctx.textAlign = 'left';
  }

  function render() {
    if (!ctx || cssW < 2 || cssH < 2) return;
    var date = SAT.clock ? SAT.clock.getDate() : new Date();
    var nowMs = date.getTime();
    markerHits = [];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, cssW, cssH);

    var o = SAT.state.obs;
    var loc = SAT.state.activeLocation();
    var list = [];
    // chartCrossings, not visibleCrossings: ticked rows narrow the drawn set
    try { list = SAT.state.chartCrossings() || []; } catch (e) { list = []; }

    // The frame table has to cover everything that will be drawn across time: every
    // crossing path, plus the clock time itself.
    var t0 = nowMs, t1 = nowMs;
    for (var i = 0; i < list.length; i++) {
      var pth = list[i].path;
      if (!pth || !pth.length) continue;
      if (pth[0].t < t0) t0 = pth[0].t;
      if (pth[pth.length - 1].t > t1) t1 = pth[pth.length - 1].t;
    }
    var tp = buildFrames(nowMs, t0, t1);
    if (!tp) {
      centreMessage('Alt/Az pointing needs a site — set an active ground station in Locations');
      elHud.textContent = '—';
      elCursor.textContent = '';
      elFoot.textContent = 'no active location';
      return;
    }
    var ra0 = tp.raDeg, dec0 = tp.decDeg;
    var t = transform();
    curScale = t.scale; curCx = t.cx; curCy = t.cy;

    drawMW(ra0, dec0, t);
    if (cfg().grid) drawGrid(ra0, dec0, t);
    drawStars(ra0, dec0, t);
    var moon = drawSunMoon(ra0, dec0, t, date);
    drawFov(t);
    var nCross = drawCrossings(list, nowMs);
    drawScaleBar(t);
    drawCompass(t);

    // HUD: pointing, then field geometry, then what the scan found
    var fovTxt = o.fovShape === 'circ'
      ? 'r ' + SAT.util.fmtAngle(o.fovRDeg, 2)
      : SAT.util.fmtAngle(o.fovWDeg, 2) + ' × ' + SAT.util.fmtAngle(o.fovHDeg, 2);
    var mount = o.track === 'mount';
    var hud = 'RA ' + SAT.util.fmtRA(ra0) + '  Dec ' + SAT.util.fmtDec(dec0) +
      ' · ' + fovTxt + ' · rot ' + o.rotDeg.toFixed(0) + '°' +
      (o.flipEW ? ' · mirrored' : '') +
      ' · ' + (view.zoom).toFixed(2) + '×';
    if (o.mode === 'altaz') {
      hud += '  [Az ' + o.azDeg.toFixed(2) + '° El ' + o.elDeg.toFixed(2) + '°]';
    }
    // Name the tracking mode outright. Which of the two rates streaks a real frame
    // follows from it, and a reader comparing this chart against one has to know
    // which picture they are being shown.
    hud += mount
      ? ' · parked: stars trail'
      : ' · sidereal: satellites streak';
    elHud.textContent = hud;

    var foot = [];
    foot.push(loc ? loc.name : 'no active location');
    foot.push(nCross + ' crossing' + (nCross === 1 ? '' : 's'));

    // The selected object's rate, taken from the pair that matches obs.track — the
    // sidereal pair against the stars, the mount pair against the horizon. Quoting
    // the wrong one is a 15"/s error on a GEO object, not a rounding difference.
    var selId = SAT.state.selection ? SAT.state.selection.satId : null;
    if (selId) {
      for (var k = 0; k < list.length; k++) {
        if (list[k].satId !== selId) continue;
        var cr = list[k];
        var rate = mount ? cr.rateMountAsPerS : cr.rateAsPerS;
        var pa = mount ? cr.paMountDeg : cr.paDeg;
        if (rate != null && isFinite(rate)) {
          foot.push(cr.name + ' ' + rate.toFixed(1) + '″/s' +
            (pa != null && isFinite(pa) ? ' PA ' + pa.toFixed(0) + '°' : ''));
        }
        break;
      }
    }
    if (SAT.state.scan && SAT.state.scan.stale) foot.push('⚠ parameters changed — rescan');
    if (moon) {
      foot.push('moon ' + SAT.frames.sep(ra0, dec0, moon.raDeg, moon.decDeg).toFixed(0) + '° away');
    }
    if (SAT.stars && typeof SAT.stars.isDeep === 'function' && !SAT.stars.isDeep()) {
      foot.push('bright stars only');
    } else if (!SAT.stars) {
      foot.push('no star catalogue');
    }
    elFoot.textContent = foot.join(' · ');
  }

  function requestRender() {
    dirty = true;
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(function () {
      rafQueued = false;
      if (!dirty) return;
      if (winRef && !winRef.isOpen()) return;
      dirty = false;
      try {
        render();
      } catch (e) {
        // one warning, then stay quiet: a broken layer must not kill the rAF loop
        if (!warned) { warned = true; console.warn('chart render failed', e); }
      }
    });
  }

  // ---- interaction ---------------------------------------------------------

  function evtPos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function cursorSky(x, y) {
    var date = SAT.clock ? SAT.clock.getDate() : new Date();
    var tp = tangentPoint(date);
    if (!tp) return null;
    var s = screenToSky(x, y, transform());
    return SAT.frames.tanDeproject(s.xi, s.eta, tp.raDeg, tp.decDeg);
  }

  function hitTest(x, y) {
    var best = null, bestD = 8;      // 8 px, per the contract
    for (var i = 0; i < markerHits.length; i++) {
      var d = Math.hypot(markerHits[i].x - x, markerHits[i].y - y);
      if (d <= bestD) { bestD = d; best = markerHits[i]; }
    }
    return best;
  }

  /** Re-aim the pointing at the sky position under (x, y). Returns true when a
   *  pointing was written. centre:true also zeroes the pan, so the new pointing
   *  lands in the middle of the window — the double-click flow is "drag somewhere
   *  interesting, double-click it", and leaving the old pan offset in place would
   *  put the freshly aimed field back off in a corner. */
  function reAimAt(x, y, centre) {
    var rd = cursorSky(x, y);
    if (!rd) return false;
    var patch = { raDeg: rd.raDeg, decDeg: rd.decDeg };
    // In alt/az mode the RA/Dec fields alone would be ignored by everything that
    // reads the pointing, so carry the re-aim across to az/el as well — otherwise
    // the re-aim would silently do nothing on a parked mount.
    if (SAT.state.obs.mode === 'altaz') {
      var loc = SAT.state.activeLocation();
      if (loc) {
        try {
          var aa = SAT.prop.siteRaDecToAltAz(loc, rd.raDeg, rd.decDeg,
            SAT.clock ? SAT.clock.getDate() : new Date(),
            { refract: true, dut1S: SAT.state.obs.dut1S });
          if (aa) { patch.azDeg = aa.azDeg; patch.elDeg = aa.elDeg; }
        } catch (e) { /* leave az/el alone rather than write nonsense */ }
      }
    }
    SAT.state.setObs(patch);         // marks the scan stale, which a re-aim must
    if (centre) { view.panX = 0; view.panY = 0; }
    invalidateStars();
    requestRender();
    return true;
  }

  function handleClick(x, y, shift) {
    if (shift) {
      reAimAt(x, y, false);          // shift-click re-aims but keeps the view still
      return;
    }
    var hit = hitTest(x, y);
    try { SAT.state.clickSelect(hit ? hit.id : null); } catch (e) { /* ignore */ }
  }

  function onDragMove(e) {
    if (!drag) return;
    var pt = evtPos(e);
    var dx = pt.x - drag.lx, dy = pt.y - drag.ly;
    drag.lx = pt.x; drag.ly = pt.y;
    if (Math.abs(pt.x - drag.sx) + Math.abs(pt.y - drag.sy) > 3) drag.moved = true;
    view.panX += dx;
    view.panY += dy;
    requestRender();
    e.preventDefault();
  }

  function onDragUp(e) {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    var wasClick = drag && !drag.moved;
    var px = drag ? drag.lx : 0, py = drag ? drag.ly : 0;
    var shift = drag ? drag.shift : false;
    drag = null;
    if (canvas) canvas.style.cursor = 'crosshair';
    if (wasClick) handleClick(px, py, shift);
  }

  function wireInput() {
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var pt = evtPos(e);
      drag = { sx: pt.x, sy: pt.y, lx: pt.x, ly: pt.y, moved: false, shift: e.shiftKey };
      canvas.style.cursor = 'grabbing';
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragUp);
      e.preventDefault();
    });

    // Double-click = re-aim (round-3 review): drag somewhere, double-click a spot,
    // and that spot becomes the new pointing, centred. Fit-to-window moved fully
    // onto the ⤢ toolbar button, which already existed.
    canvas.addEventListener('dblclick', function (e) {
      var pt = evtPos(e);
      reAimAt(pt.x, pt.y, true);
      e.preventDefault();
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;
      else if (e.deltaMode === 2) dy *= cssH;
      var pt = evtPos(e);
      zoomAt(pt.x, pt.y, Math.exp(-dy * 0.0015));
    }, { passive: false });

    canvas.addEventListener('mousemove', function (e) {
      if (drag) return;
      var pt = evtPos(e);
      var rd = cursorSky(pt.x, pt.y);
      if (!rd) { elCursor.textContent = '—'; return; }
      var txt = 'RA ' + SAT.util.fmtRA(rd.raDeg) + '  Dec ' + SAT.util.fmtDec(rd.decDeg);
      var loc = SAT.state.activeLocation();
      if (loc) {
        try {
          var aa = SAT.prop.siteRaDecToAltAz(loc, rd.raDeg, rd.decDeg,
            SAT.clock ? SAT.clock.getDate() : new Date(),
            { refract: true, dut1S: SAT.state.obs.dut1S });
          var orb = SAT.prop.isOrbitSite(loc);
          if (aa) {
            txt += '  ·  ' + (orb ? 'AzL ' : 'Az ') + aa.azDeg.toFixed(2) +
              '°  ' + (orb ? 'ElL ' : 'El ') + aa.elDeg.toFixed(2) + '°';
          }
        } catch (err) { /* readout degrades to RA/Dec only */ }
      }
      elCursor.textContent = txt;
      canvas.style.cursor = hitTest(pt.x, pt.y) ? 'pointer' : 'crosshair';
    });

    canvas.addEventListener('mouseleave', function () { elCursor.textContent = '—'; });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ---- plumbing ------------------------------------------------------------

  function resize() {
    if (!body || !canvas) return;
    var r = body.getBoundingClientRect();
    var w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    var d = window.devicePixelRatio || 1;
    if (w === cssW && h === cssH && d === dpr) return;
    cssW = w; cssH = h; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    invalidateStars();          // the view radius changed with the viewport
    requestRender();
  }

  function injectStyle() {
    if (document.getElementById('chart-style')) return;
    var s = document.createElement('style');
    s.id = 'chart-style';
    s.textContent =
      '.chart-canvas{position:absolute;left:0;top:0;display:block;cursor:crosshair;}' +
      '.chart-hud{position:absolute;font:11px ' + MONO + ';font-variant-numeric:tabular-nums;' +
        'color:#e8eaed;background:rgba(10,14,18,0.62);padding:2px 7px;border-radius:3px;' +
        'pointer-events:none;white-space:nowrap;z-index:5;}' +
      '.chart-topstack{position:absolute;top:34px;left:6px;right:6px;display:flex;' +
        'flex-direction:column;gap:4px;align-items:flex-start;pointer-events:none;z-index:5;}' +
      '.chart-topstack .chart-hud{position:static;white-space:normal;line-height:1.5;}' +
      '.chart-foot{color:#9aa4ad;}' +
      '.chart-toolbar{position:absolute;top:6px;left:6px;display:flex;gap:3px;z-index:6;opacity:.85;}' +
      '.chart-toolbar:hover{opacity:1;}' +
      '.chart-tbtn{min-width:26px;padding:2px 6px;}' +
      '.chart-tbtn.chart-on{outline:1px solid ' + ACCENT + ';color:' + ACCENT + ';}';
    document.head.appendChild(s);
  }

  function buildToolbar() {
    function tbtn(key, label, title, onclick) {
      var b = SAT.util.el('button',
        { class: 'btn small chart-tbtn', title: title, onclick: onclick }, label);
      if (key) toolBtns[key] = b;
      return b;
    }
    function toggleLayer(key) {
      return function () {
        var c = cfg();
        c[key] = !c[key];
        try { SAT.state.save(); } catch (e) { /* ignore */ }
        updateToolbar();
        requestRender();
      };
    }
    var bar = SAT.util.el('div', { class: 'chart-toolbar' }, [
      tbtn('sunMoon', '☉', 'sun & moon (moon shows phase)', toggleLayer('sunMoon')),
      tbtn('stars', '✶', 'stars', toggleLayer('stars')),
      tbtn('mw', 'MW', 'Milky Way glow', toggleLayer('mw')),
      tbtn('starNames', 'SN', 'star names (fields wider than 5°)', toggleLayer('starNames')),
      tbtn('constLines', 'CL', 'constellation lines (fields wider than 5°)', toggleLayer('constLines')),
      tbtn('constNames', 'CN', 'constellation names (fields wider than 5°)', toggleLayer('constNames')),
      tbtn('grid', '#', 'RA/Dec grid', toggleLayer('grid')),
      tbtn('labels', 'Ab', 'satellite labels', toggleLayer('labels')),
      tbtn('mag', 'm9', 'star magnitude limit', function () {
        var c = cfg();
        var steps = [4.5, 6, 7.5, 9, 11];
        var i = steps.indexOf(c.magLimit);
        c.magLimit = steps[(i + 1) % steps.length];
        invalidateStars();
        try { SAT.state.save(); } catch (e) { /* ignore */ }
        updateToolbar();
        requestRender();
      }),
      tbtn(null, 'E⇄', 'mirror the chart east/west (odd number of reflections)', function () {
        // flipEW lives in obs, so this routes through setObs and marks the scan
        // stale. Conservative — a mirror changes no sky geometry — but setObs is the
        // single mutator and splitting display flags out of obs is not this file's
        // decision to make.
        SAT.state.setObs({ flipEW: !SAT.state.obs.flipEW });
      }),
      tbtn(null, '⤢', 'fit the field to the window', fitView),
    ]);
    body.appendChild(bar);
    updateToolbar();
  }

  function updateToolbar() {
    var c = cfg();
    if (!toolBtns.stars) return;
    toolBtns.sunMoon.classList.toggle('chart-on', !!c.sunMoon);
    toolBtns.stars.classList.toggle('chart-on', !!c.stars);
    toolBtns.mw.classList.toggle('chart-on', !!c.mw);
    toolBtns.starNames.classList.toggle('chart-on', !!c.starNames);
    toolBtns.constLines.classList.toggle('chart-on', !!c.constLines);
    toolBtns.constNames.classList.toggle('chart-on', !!c.constNames);
    toolBtns.grid.classList.toggle('chart-on', !!c.grid);
    toolBtns.labels.classList.toggle('chart-on', !!c.labels);
    toolBtns.mag.textContent = 'm' + c.magLimit;
  }

  function init(bodyEl, win) {
    body = bodyEl;
    winRef = win;
    if (win) win.noScroll = true;
    injectStyle();

    canvas = document.createElement('canvas');
    canvas.className = 'chart-canvas';
    body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    elHud = SAT.util.el('div', { class: 'chart-hud' }, '');
    elCursor = SAT.util.el('div', { class: 'chart-hud' }, '—');
    elFoot = SAT.util.el('div', { class: 'chart-hud chart-foot' }, '');
    body.appendChild(SAT.util.el('div', { class: 'chart-topstack' },
      [elHud, elCursor, elFoot]));

    buildToolbar();
    wireInput();

    body.addEventListener('win-resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(body);
    resize();

    // In alt/az mode the tangent point is a function of time, so every tick moves the
    // star field even when nothing else changed — the cache check below absorbs the
    // small steps and re-queries only when the field has really moved.
    SAT.bus.on('time', requestRender);
    SAT.bus.on('obs-changed', function () { invalidateStars(); requestRender(); });
    SAT.bus.on('scan-done', requestRender);
    SAT.bus.on('filters-changed', requestRender);
    SAT.bus.on('selection-changed', requestRender);
    SAT.bus.on('settings-changed', function () {
      invalidateStars(); updateToolbar(); requestRender();
    });
    SAT.bus.on('catalog-changed', requestRender);
    SAT.bus.on('locations-changed', function () { invalidateStars(); requestRender(); });
    SAT.bus.on('state-loaded', function () {
      invalidateStars(); updateToolbar(); fitView();
    });
    requestRender();
  }

  SAT.chart = {
    init: init, requestRender: requestRender, fitView: fitView,
    // Pure geometry, exported for tools/test_chart.js. The orientation transform is
    // the one piece of this file that can be — and must be — verified without a
    // browser; everything else is paint.
    _makeTransform: makeTransform,
    _skyToScreen: skyToScreen,
    _screenToSky: screenToSky,
    _axisDirs: axisDirs,
    _gridStepDeg: gridStepDeg,
    _pathPosAt: pathPosAt,
    _extTrackOf: extTrackOf,
    _extPosAt: extPosAt,
    _lerpAngle: lerpAngle,
    _lerpFrame: lerpFrame,
  };
})();
