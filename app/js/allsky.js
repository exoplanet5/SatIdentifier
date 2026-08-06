/* ===== allsky.js — SAT.allsky : polar alt/az context view ===================
 *
 * Ported from SatObserver's skychart.js and reduced to one question: where on the
 * sky am I actually pointed, and what else is up there? It keeps the polar alt/az
 * plot, the horizon, the star field, the Sun and the Moon, and replaces SatObserver's
 * pass trajectories with the two things this app needs — the FOV footprint (the
 * outline of the current field projected onto the dome) and the sky tracks of the
 * objects in SAT.state.visibleCrossings().
 *
 * The RA/Dec -> alt/az conversion goes through SAT.frames, not through skychart.js's
 * inline hour-angle helper: this view is drawn beside a gnomonic chart that has
 * precession and nutation applied, and two sky views that disagree by 0.36 deg would
 * be worse than one.
 *
 * Secondary window, closed by default.
 * ========================================================================== */
(function () {
  'use strict';

  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // The FOV outline's stroke colour is the accent, and tools/test_ports.js keys on
  // this exact string to pull the footprint back out of a recording canvas — keep
  // the two in step (the test reads the literal out of this file).
  var FOV_STROKE = 'rgba(79,195,247,0.95)';
  var FOV_FILL = 'rgba(79,195,247,0.10)';
  var FOV_HALO = 'rgba(79,195,247,0.45)';

  // coloured by object type via the shared, user-editable palette in SAT.state
  function typeColorOf(cr) {
    try { return SAT.state.typeColorOf(cr && cr.type); }
    catch (e) { return '#90a4ae'; }
  }

  // A full-catalogue scan can return thousands of crossings; drawing every track at
  // 64 samples would be a quarter of a million frame conversions. Cap, and say so.
  var TRACK_CAP = 150, MARK_CAP = 600;

  var body = null, winRef = null, canvas = null, ctx = null;
  var cssW = 0, cssH = 0, dpr = 1;
  var dirty = false, rafQueued = false;
  var warned = false;
  var elHud = null;
  var markerHits = [];                        // [{id, x, y}]
  var toolBtns = {};
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function cfg() {
    var s = SAT.state.settings;
    if (!s.allsky) s.allsky = {};
    var c = s.allsky;
    if (c.eastLeft == null) c.eastLeft = true;
    if (c.elStep == null) c.elStep = 30;
    if (c.stars == null) c.stars = true;
    if (c.sunMoon == null) c.sunMoon = true;
    if (c.mw == null) c.mw = false;           // Milky Way layer, off by default
    if (c.tracks == null) c.tracks = true;
    if (c.starNames == null) c.starNames = false;
    if (c.constLines == null) c.constLines = false;
    if (c.constNames == null) c.constNames = false;
    return c;
  }

  function hexA(hex, a) {
    var h = (hex || '#4fc3f7').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0x4fc3f7;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---- geometry ------------------------------------------------------------

  function metrics() {
    var R = Math.max(30, Math.min(cssW, cssH) / 2 - 30);
    return { cx: cssW / 2, cy: cssH / 2, R: R };
  }

  /** Alt/az -> canvas. Elevation is allowed a few degrees below zero so a field or a
   *  track that grazes the horizon is drawn falling off the edge rather than being
   *  clipped to a straight line along it. */
  function project(azDeg, elDeg, m) {
    var r = (90 - Math.max(elDeg, -5)) / 90 * m.R;
    var a = azDeg * Math.PI / 180;
    var sx = cfg().eastLeft ? -1 : 1;          // sky view: E on the left, as when looking up
    return { x: m.cx + sx * r * Math.sin(a), y: m.cy - r * Math.cos(a) };
  }

  function altAz(raDeg, decDeg, loc, date) {
    var o = SAT.state.obs;
    return SAT.frames.raDecToAltAz(raDeg, decDeg, loc, date,
      { refract: true, dut1S: o.dut1S });
  }

  /** The field centre in J2000 RA/Dec, whichever way the user expressed it. */
  function pointingRaDec(loc, date) {
    var o = SAT.state.obs;
    if (o.mode === 'altaz') {
      return SAT.frames.altAzToRaDec(o.azDeg, o.elDeg, loc, date,
        { refract: true, dut1S: o.dut1S });
    }
    return { raDeg: o.raDeg, decDeg: o.decDeg };
  }

  /** Field boundary as standard coordinates (degrees) about the field centre.
   *
   * rotDeg IS applied: it is the position angle of the field on the sky, so it
   * changes which patch of sky the rectangle covers. flipEW is NOT applied: that
   * only mirrors the main chart's display and must never move the footprint.
   */
  function fovOutlineXiEta() {
    var o = SAT.state.obs;
    var pts = [], i, k;
    if (o.fovShape === 'circ') {
      for (i = 0; i <= 72; i++) {
        var a = 2 * Math.PI * i / 72;         // a circle needs no rotation applied
        pts.push({ xi: o.fovRDeg * Math.cos(a), eta: o.fovRDeg * Math.sin(a) });
      }
      return pts;
    }
    // Edges are sampled, not just cornered: a gnomonic rectangle re-projected onto
    // the horizon dome is not a quadrilateral, and four points would cut the corners
    // off a wide field near the horizon.
    var p = o.rotDeg * Math.PI / 180, cp = Math.cos(p), sp = Math.sin(p);
    var hw = o.fovWDeg / 2, hh = o.fovHDeg / 2, K = 10;
    var corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (i = 0; i < 4; i++) {
      var a0 = corners[i], a1 = corners[(i + 1) % 4];
      for (k = 0; k < K; k++) {
        var f = k / K;
        var x = a0[0] + (a1[0] - a0[0]) * f;
        var y = a0[1] + (a1[1] - a0[1]) * f;
        pts.push({ xi: x * cp + y * sp, eta: -x * sp + y * cp });
      }
    }
    pts.push(pts[0]);
    return pts;
  }

  /** The field boundary and centre in alt/az at this instant. */
  function fovFootprint(loc, date) {
    var c = pointingRaDec(loc, date);
    if (!isFinite(c.raDeg) || !isFinite(c.decDeg)) return null;
    var xe = fovOutlineXiEta(), out = [], i, rd;
    for (i = 0; i < xe.length; i++) {
      rd = SAT.frames.tanDeproject(xe[i].xi, xe[i].eta, c.raDeg, c.decDeg);
      out.push(altAz(rd.raDeg, rd.decDeg, loc, date));
    }
    return {
      pts: out,
      centre: altAz(c.raDeg, c.decDeg, loc, date),
      raDeg: c.raDeg, decDeg: c.decDeg,
    };
  }

  // ---- drawing primitives --------------------------------------------------

  function haloText(text, x, y, fill, align) {
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(5,8,12,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function drawGrid(m) {
    var i, p, el;
    var step = cfg().elStep || 30;
    ctx.lineWidth = 1;
    for (el = 0; el < 90; el += step) {
      var r = (90 - el) / 90 * m.R;
      ctx.beginPath();
      ctx.arc(m.cx, m.cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = el === 0 ? 'rgba(232,234,237,0.5)' :
        (el % 30 === 0 ? 'rgba(232,234,237,0.16)' : 'rgba(232,234,237,0.08)');
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(232,234,237,0.5)';
    ctx.fill();

    var names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    ctx.font = '11px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < 8; i++) {
      var az = i * 45;
      var pe = project(az, 0, m);
      ctx.beginPath();
      ctx.moveTo(m.cx, m.cy);
      ctx.lineTo(pe.x, pe.y);
      ctx.strokeStyle = 'rgba(232,234,237,0.10)';
      ctx.stroke();
      var pl = project(az, -14, m);            // label just outside the horizon
      ctx.fillStyle = az === 0 ? '#e8eaed' : 'rgba(154,164,174,0.9)';
      ctx.fillText(names[i], pl.x, pl.y);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(154,164,174,0.75)';
    ctx.font = '10px ' + MONO;
    [0, 30, 60].forEach(function (e) {
      p = project(22.5, e, m);
      ctx.fillText(e + '°', p.x + 2, p.y);
    });
  }

  // ---- star field ----------------------------------------------------------
  // Round 12: SatObserver fallback, binding (CONTRACT, All-Sky section). The star
  // field is the bright catalogue SAT.stardata ONLY (V <= 4.6, ~1000 stars) drawn
  // whole-hemisphere with SatObserver's radius/alpha law — SAT.stars.cone and the
  // old allsky.magLimit are gone. ~500 frames conversions per render is sub-ms,
  // which is exactly the sum SatObserver pays, so no cache is needed either.

  function drawStars(m, loc, date) {
    var sd = SAT.stardata;
    if (!sd || !sd.stars) return;
    for (var i = 0; i < sd.stars.length; i++) {
      var st = sd.stars[i];                    // [raDeg(-180..180), decDeg, mag]
      var a = altAz(((st[0] % 360) + 360) % 360, st[1], loc, date);
      if (a.elDeg <= 0.3) continue;
      var p = project(a.azDeg, a.elDeg, m);
      var rad = Math.max(0.6, 2.7 - 0.45 * st[2]);
      var alpha = Math.max(0.25, 0.95 - 0.13 * st[2]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(225,235,255,' + alpha.toFixed(2) + ')';
      ctx.fill();
    }
  }

  // ---- star names & constellations (SN / CL / CN, as SatObserver's sky chart) --
  // Drawn straight from SAT.stardata (bright catalogue): names exist only to
  // mag 2.7 and constellation figures are whole-sky by nature, so the deep
  // catalogue has nothing to add here. Coordinates there are [RA -180..180, Dec].

  function drawConstLines(m, loc, date) {
    var sd = SAT.stardata;
    if (!sd || !sd.lines) return;
    ctx.strokeStyle = 'rgba(110,150,215,0.30)';
    ctx.lineWidth = 1;
    for (var i = 0; i < sd.lines.length; i++) {
      var seg = sd.lines[i];
      var prev = null;
      ctx.beginPath();
      for (var j = 0; j < seg.length; j++) {
        var a = altAz(((seg[j][0] % 360) + 360) % 360, seg[j][1], loc, date);
        if (a.elDeg <= 0) { prev = null; continue; }
        var q = project(a.azDeg, a.elDeg, m);
        if (prev) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        prev = q;
      }
      ctx.stroke();
    }
  }

  function drawStarNames(m, loc, date) {
    var sd = SAT.stardata;
    if (!sd || !sd.names) return;
    ctx.font = '9px ' + MONO;
    for (var i = 0; i < sd.names.length; i++) {
      var nm = sd.names[i];
      var a = altAz(((nm[0] % 360) + 360) % 360, nm[1], loc, date);
      if (a.elDeg <= 1) continue;
      var q = project(a.azDeg, a.elDeg, m);
      haloText(nm[2], q.x + 5, q.y - 4, 'rgba(185,205,240,0.9)');
    }
  }

  function drawConstNames(m, loc, date) {
    var sd = SAT.stardata;
    if (!sd || !sd.cons) return;
    ctx.font = 'italic 10px ' + MONO;
    ctx.textBaseline = 'middle';
    for (var i = 0; i < sd.cons.length; i++) {
      var cn = sd.cons[i];
      var a = altAz(((cn[0] % 360) + 360) % 360, cn[1], loc, date);
      if (a.elDeg <= 4) continue;
      var q = project(a.azDeg, a.elDeg, m);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(140,165,205,0.55)';
      ctx.fillText(cn[2], q.x, q.y);
    }
    ctx.textAlign = 'left';
  }

  // ---- Milky Way -----------------------------------------------------------
  // Faint isophotes (d3-celestial contours via vendor/mwdata.js), SatObserver's
  // polar-chart layer with one change: the per-vertex J2000 -> horizontal
  // conversion goes through a rotation matrix built ONCE per render from three
  // SAT.frames.raDecToAltAz probes, so the glow shares the star layer's
  // precession/nutation chain instead of re-deriving hour angles inline.
  // SatObserver's fill-parity fix carries over unchanged: the polar projection
  // maps the nadir to twice the horizon radius, so canvas fills the side of each
  // ring NOT containing the nadir; whenever the nadir drifts inside a contour the
  // fill inverts — a rim-circle subpath flips even-odd parity back, keyed on the
  // north galactic pole, a point known to be outside every isophote.
  // Documented deviation (CONTRACT): no twilight fade — full contour alpha
  // whenever the layer is on.
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

  /** Rows of the J2000 -> horizontal (N, E, up) rotation at this site and time. */
  function horizMatrix(loc, date) {
    var o = { refract: false, dut1S: SAT.state.obs.dut1S };
    function hvec(raDeg, decDeg) {
      var a = SAT.frames.raDecToAltAz(raDeg, decDeg, loc, date, o);
      var el = a.elDeg * D2R, az = a.azDeg * D2R, ce = Math.cos(el);
      return [ce * Math.cos(az), ce * Math.sin(az), Math.sin(el)];
    }
    var X = hvec(0, 0), Y = hvec(90, 0), Z = hvec(0, 90);   // images of x̂, ŷ, ẑ
    return [
      [X[0], Y[0], Z[0]],
      [X[1], Y[1], Z[1]],
      [X[2], Y[2], Z[2]],
    ];
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

  function drawMW(m, loc, date) {
    var mw = SAT.mwdata;
    if (!mw || !cfg().mw) return;
    if (!mw._vecs) mw._vecs = mwVecs(mw);
    var R = horizMatrix(loc, date);
    var sx = cfg().eastLeft ? -1 : 1;
    // equatorial unit vector -> chart point (same mapping as project(), without
    // the elevation clamp: below-horizon parts must land outside the clipped
    // horizon circle, nadir at 2R)
    function pt(x, y, z) {
      var hn = R[0][0] * x + R[0][1] * y + R[0][2] * z;
      var he = R[1][0] * x + R[1][1] * y + R[1][2] * z;
      var hu = R[2][0] * x + R[2][1] * y + R[2][2] * z;
      var alt = Math.asin(Math.max(-1, Math.min(1, hu)));
      var az = Math.atan2(he, hn);
      var r = (90 - alt * R2D) / 90 * m.R;
      return { x: m.cx + sx * r * Math.sin(az), y: m.cy - r * Math.cos(az) };
    }
    // edges get grossly distorted near the nadir singularity; subdivide long
    // projected chords along the great circle so none can slash across the disc
    var maxChord2 = (0.25 * m.R) * (0.25 * m.R);
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
    var RIM = m.R * 2.2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.R, 0, Math.PI * 2);
    ctx.clip();
    // soften the isophote steps into a diffuse glow where the browser allows
    var blur = typeof ctx.filter === 'string';
    if (blur) ctx.filter = 'blur(' + (m.R * 0.01).toFixed(1) + 'px)';
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
          ctx.moveTo(m.cx + RIM, m.cy);
          ctx.arc(m.cx, m.cy, RIM, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = 'rgba(172,192,222,' + lev.a + ')';
      ctx.fill('evenodd');
    }
    if (blur) ctx.filter = 'none';
    ctx.restore();
  }

  // ---- Sun and Moon --------------------------------------------------------
  // SatObserver's icons (round 12): rayed sun disc, moon with its phase
  // terminator, drawn only above the horizon. Positions still come from
  // SAT.frames (not subpoints) so they agree with the rest of this view.

  function drawSunMoon(m, loc, date) {
    if (!cfg().sunMoon) return;
    var s, mo;
    try { s = SAT.frames.sunJ2000(date); mo = SAT.frames.moonJ2000(date); }
    catch (e) { return; }
    var sun = altAz(s.raDeg, s.decDeg, loc, date);
    var moon = altAz(mo.raDeg, mo.decDeg, loc, date);
    moon.elDeg -= 0.95 * Math.cos(moon.elDeg * D2R); // lunar parallax (mean 57')

    if (sun.elDeg > 0) {
      var p = project(sun.azDeg, sun.elDeg, m);
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

    if (moon.elDeg > 0) {
      var q = project(moon.azDeg, moon.elDeg, m);
      // geocentric sun–moon elongation -> phase; bright limb faces the sun's
      // chart position (valid below the horizon too: project() clamps el,
      // keeping the azimuth direction)
      var mv = SAT.frames.raDecToVec(mo.raDeg, mo.decDeg);
      var sv = SAT.frames.raDecToVec(s.raDeg, s.decDeg);
      var cosPsi = mv.x * sv.x + mv.y * sv.y + mv.z * sv.z;
      var ps = project(sun.azDeg, sun.elDeg, m);
      var phi = Math.atan2(ps.y - q.y, ps.x - q.x);
      var R = 5.5;
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

  // ---- FOV footprint -------------------------------------------------------

  function drawFov(m, loc, date) {
    var f = fovFootprint(loc, date);
    if (!f) return null;
    // A field below the horizon has no footprint on the dome. Drawing the clamped
    // outline anyway would put a convincing shape outside the horizon ring; say it
    // in the HUD instead.
    if (f.centre.elDeg <= -1) return f;

    var i, p, xs = [], ys = [];
    for (i = 0; i < f.pts.length; i++) {
      p = project(f.pts[i].azDeg, f.pts[i].elDeg, m);
      xs.push(p.x); ys.push(p.y);
    }
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.closePath();
    ctx.fillStyle = FOV_FILL;
    ctx.fill();
    ctx.strokeStyle = FOV_STROKE;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    var w = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    var h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    var c = project(f.centre.azDeg, f.centre.elDeg, m);
    if (Math.max(w, h) < 14) {
      // A 1 deg field is two pixels across on an all-sky plot. Ring it, or the one
      // thing this window exists to show is invisible.
      ctx.beginPath();
      ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = FOV_HALO;
      ctx.lineWidth = 1;
      if (ctx.setLineDash) ctx.setLineDash([3, 3]);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }
    ctx.font = '10px ' + MONO;
    haloText('FOV', c.x + 14, c.y - 12, FOV_STROKE);
    return f;
  }

  // ---- crossings -----------------------------------------------------------

  function drawTrack(m, cr, loc, date, selected) {
    var path = cr.path || [];
    if (path.length < 2) return;
    var col = typeColorOf(cr);
    var nowMs = date.getTime();
    var prev = null, i, a, p, q;
    ctx.lineWidth = selected ? 2.0 : 1.2;
    ctx.lineJoin = 'round';
    for (i = 0; i < path.length; i++) {
      q = path[i];
      a = altAz(q.raDeg, q.decDeg, loc, date);
      if (a.elDeg <= 0) { prev = null; continue; }
      p = project(a.azDeg, a.elDeg, m);
      if (prev) {
        // The part already past dims, so the direction of travel reads at a glance
        ctx.strokeStyle = hexA(col, q.t <= nowMs ? 0.30 : (selected ? 0.95 : 0.7));
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      prev = p;
    }
  }

  function drawCrossings(m, loc, date) {
    var list = [];
    // chartCrossings: ticked rows in the Crossings table narrow this view too
    try { list = SAT.state.chartCrossings() || []; } catch (e) { list = []; }
    if (!list.length) return { up: 0, total: 0, drawn: 0 };

    var selId = SAT.state.selection ? SAT.state.selection.satId : null;
    var i, cr, obj, la, p, drawn = 0, up = 0;

    if (cfg().tracks) {
      for (i = 0; i < list.length && drawn < TRACK_CAP; i++) {
        try { drawTrack(m, list[i], loc, date, list[i].satId === selId); } catch (e) { /* skip */ }
        drawn++;
      }
      // the selection must always be visible, even past the cap
      if (selId && drawn >= TRACK_CAP) {
        for (i = TRACK_CAP; i < list.length; i++) {
          if (list[i].satId !== selId) continue;
          try { drawTrack(m, list[i], loc, date, true); } catch (e) { /* skip */ }
          break;
        }
      }
    }

    for (i = 0; i < list.length && up < MARK_CAP; i++) {
      cr = list[i];
      obj = SAT.state.getObj(cr.satId);
      if (!obj) continue;
      try {
        la = SAT.prop.look(loc, obj, date,
          { dut1S: SAT.state.obs.dut1S });
      } catch (e) { la = null; }
      if (!la || la.elDeg <= 0) continue;
      up++;
      p = project(la.azDeg, la.elDeg, m);
      ctx.fillStyle = typeColorOf(cr);
      ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
      ctx.strokeRect(p.x - 2.5, p.y - 2.5, 5, 5);
      if (cr.satId === selId) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.font = '11px ' + MONO;
        haloText(cr.name || String(cr.norad), p.x + 8, p.y, '#ffffff');
      }
      markerHits.push({ id: cr.satId, x: p.x, y: p.y });
    }
    return { up: up, total: list.length, drawn: drawn };
  }

  // ---- render --------------------------------------------------------------

  function render() {
    if (!ctx || cssW < 2 || cssH < 2) return;
    var date = SAT.clock.getDate();
    var m = metrics();
    markerHits = [];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, cssW, cssH);

    var loc = SAT.state.activeLocation();
    if (!loc) {
      ctx.fillStyle = '#9aa4ae';
      ctx.font = '12px ' + MONO;
      ctx.textAlign = 'center';
      ctx.fillText('Set an active site in the Sites window', m.cx, m.cy);
      elHud.style.display = 'none';
      return;
    }
    // The All-Sky view IS a ground-horizon projection (az rings, N/E/S/W, zenith
    // at centre) — for an orbital station it would render nonsense, so it says so
    // instead (CONTRACT v0.2 "UI consequences"). The sky chart is the view there.
    if ((loc.kind || 'ground') === 'orbit') {
      ctx.fillStyle = '#9aa4ae';
      ctx.font = '12px ' + MONO;
      ctx.textAlign = 'center';
      ctx.fillText('All-Sky is a ground-horizon view — the active site is an orbital station.',
        m.cx, m.cy - 8);
      ctx.fillText('Use the Sky Chart, which works for both site kinds.', m.cx, m.cy + 10);
      elHud.style.display = 'none';
      return;
    }

    try { drawMW(m, loc, date); } catch (e) { /* optional layer */ }
    drawGrid(m);
    try {
      var cl = cfg();
      if (cl.constLines) drawConstLines(m, loc, date);   // beneath the stars
      if (cl.stars) drawStars(m, loc, date);
      if (cl.starNames) drawStarNames(m, loc, date);
      if (cl.constNames) drawConstNames(m, loc, date);
    } catch (e) { /* star layers are optional */ }
    try { drawSunMoon(m, loc, date); } catch (e) { /* ditto */ }
    var fov = drawFov(m, loc, date);
    drawCrossings(m, loc, date);

    // ---- HUD ----
    var o = SAT.state.obs;
    var size = o.fovShape === 'circ'
      ? 'r ' + SAT.util.fmtAngle(o.fovRDeg, 1)
      : SAT.util.fmtAngle(o.fovWDeg, 1) + ' × ' + SAT.util.fmtAngle(o.fovHDeg, 1);
    var txt;
    if (fov) {
      txt = 'FOV  AZ ' + fov.centre.azDeg.toFixed(1) + '°  EL ' + fov.centre.elDeg.toFixed(1) +
        '°  ·  ' + size + '  ·  RA ' + SAT.util.fmtRA(fov.raDeg, 0) +
        '  Dec ' + SAT.util.fmtDec(fov.decDeg);
      if (fov.centre.elDeg <= -1) {
        txt += '   ⚠ field is ' + (-fov.centre.elDeg).toFixed(1) + '° below the horizon';
      }
    } else {
      txt = 'No pointing';
    }
    try {
      var sun = SAT.frames.sunJ2000(date);
      var sa = altAz(sun.raDeg, sun.decDeg, loc, date);
      txt += '  ·  sun ' + sa.elDeg.toFixed(1) + '°';
    } catch (e) { /* leave the sun off */ }
    elHud.textContent = txt;
    elHud.style.display = 'block';
    // Round 19: the footer line (site, sky/map view, crossing counts, track-cap
    // notes) was removed at user request — the crossing bookkeeping lives in
    // the Crossings window. drawCrossings still runs for its side effects.
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
        // One warning, then silence: a per-frame console flood is how a small render
        // bug becomes an unusable app.
        if (!warned) { warned = true; console.warn('SAT.allsky render failed', e); }
      }
    });
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
    requestRender();
  }

  function injectStyle() {
    if (document.getElementById('ask-style')) return;
    var s = document.createElement('style');
    s.id = 'ask-style';
    s.textContent =
      '.ask-canvas{position:absolute;left:0;top:0;display:block;cursor:crosshair;}' +
      '.ask-hud{position:absolute;font:11px ' + MONO + ';font-variant-numeric:tabular-nums;' +
        'color:#e8eaed;background:rgba(10,14,18,0.62);padding:2px 7px;border-radius:3px;' +
        'pointer-events:none;white-space:nowrap;z-index:5;}' +
      '.ask-topstack{position:absolute;top:34px;left:6px;right:6px;display:flex;' +
        'flex-direction:column;gap:4px;align-items:flex-start;pointer-events:none;z-index:5;}' +
      '.ask-topstack .ask-hud{position:static;white-space:normal;line-height:1.5;}' +
      '.ask-toolbar{position:absolute;top:6px;left:6px;display:flex;gap:3px;z-index:6;opacity:.85;}' +
      '.ask-toolbar:hover{opacity:1;}' +
      '.ask-tbtn{min-width:26px;padding:2px 6px;}' +
      '.ask-tbtn.ask-on{outline:1px solid #4fc3f7;color:#4fc3f7;}';
    document.head.appendChild(s);
  }

  function init(bodyEl, win) {
    body = bodyEl;
    winRef = win;
    win.noScroll = true;
    injectStyle();

    canvas = document.createElement('canvas');
    canvas.className = 'ask-canvas';
    body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    elHud = SAT.util.el('div', { class: 'ask-hud' }, '');
    body.appendChild(SAT.util.el('div', { class: 'ask-topstack' }, [elHud]));

    function tbtn(key, label, title, onclick) {
      var b = SAT.util.el('button', { class: 'btn small ask-tbtn', title: title, onclick: onclick }, label);
      if (key) toolBtns[key] = b;
      return b;
    }
    function updateToolbar() {
      var c = cfg();
      toolBtns.grid.textContent = c.elStep + '°';
      toolBtns.sunMoon.classList.toggle('ask-on', !!c.sunMoon);
      toolBtns.stars.classList.toggle('ask-on', !!c.stars);
      toolBtns.mw.classList.toggle('ask-on', !!c.mw);
      toolBtns.starNames.classList.toggle('ask-on', !!c.starNames);
      toolBtns.constLines.classList.toggle('ask-on', !!c.constLines);
      toolBtns.constNames.classList.toggle('ask-on', !!c.constNames);
      toolBtns.tracks.classList.toggle('ask-on', !!c.tracks);
    }
    function toggleLayer(key) {
      return function () {
        var c = cfg();
        c[key] = !c[key];
        SAT.state.save();
        updateToolbar();
        requestRender();
      };
    }
    body.appendChild(SAT.util.el('div', { class: 'ask-toolbar' }, [
      tbtn('grid', '30°', 'elevation grid spacing: 30° / 10° per ring', function () {
        var c = cfg();
        c.elStep = c.elStep === 30 ? 10 : 30;
        SAT.state.save();
        updateToolbar();
        requestRender();
      }),
      tbtn('sunMoon', '☉', 'sun & moon (moon shows phase)', toggleLayer('sunMoon')),
      tbtn('stars', '✶', 'stars (to mag 4.6)', toggleLayer('stars')),
      tbtn('mw', 'MW', 'Milky Way glow', toggleLayer('mw')),
      tbtn('starNames', 'SN', 'bright star names', toggleLayer('starNames')),
      tbtn('constLines', 'CL', 'constellation lines', toggleLayer('constLines')),
      tbtn('constNames', 'CN', 'constellation names', toggleLayer('constNames')),
      tbtn('tracks', '↗', 'sky tracks of the objects crossing the field', toggleLayer('tracks')),
      tbtn(null, 'E⇄', 'flip east/west (sky view vs map view)', function () {
        cfg().eastLeft = !cfg().eastLeft;
        SAT.state.save();
        requestRender();
      }),
    ]));
    updateToolbar();

    canvas.addEventListener('click', function (e) {
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      var best = null, bestD = 9, i, d;
      for (i = 0; i < markerHits.length; i++) {
        d = Math.hypot(markerHits[i].x - x, markerHits[i].y - y);
        if (d <= bestD) { bestD = d; best = markerHits[i]; }
      }
      try { SAT.state.clickSelect(best ? best.id : null); } catch (err) { /* ignore */ }
    });

    // Double-click re-aims the pointing, mirroring the sky chart's dblclick.
    // The all-sky projection is trivially invertible (radius = zenith distance),
    // so the click maps to az/el directly; both representations are written, the
    // same as pointing.applyAltAz, so the re-aim works in either input mode.
    canvas.addEventListener('dblclick', function (e) {
      var loc = SAT.state.activeLocation();
      if (!loc || (loc.kind || 'ground') === 'orbit') return;  // panel is gated there
      var r = canvas.getBoundingClientRect();
      var m = metrics();
      var sx = cfg().eastLeft ? -1 : 1;
      var dx = (e.clientX - r.left - m.cx) * sx;
      var dy = m.cy - (e.clientY - r.top);
      var rr = Math.hypot(dx, dy);
      if (rr > m.R * (95 / 90)) return;        // outside the horizon circle
      var azDeg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      var elDeg = Math.max(-5, 90 - 90 * rr / m.R);
      try {
        var rd = SAT.prop.siteAltAzToRaDec(loc, azDeg, elDeg,
          SAT.clock ? SAT.clock.getDate() : new Date(),
          { refract: true, dut1S: SAT.state.obs.dut1S });
        if (!rd) return;
        SAT.state.setObs({ raDeg: rd.raDeg, decDeg: rd.decDeg,
          azDeg: azDeg, elDeg: elDeg });     // marks the scan stale, as a re-aim must
      } catch (err) { /* a bad epoch degrades to no-op, not nonsense pointing */ }
    });

    body.addEventListener('win-resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(body);
    resize();

    SAT.bus.on('time', requestRender);
    SAT.bus.on('obs-changed', requestRender);
    SAT.bus.on('scan-done', requestRender);
    SAT.bus.on('filters-changed', requestRender);
    SAT.bus.on('selection-changed', requestRender);
    SAT.bus.on('settings-changed', requestRender);
    SAT.bus.on('locations-changed', requestRender);
    SAT.bus.on('state-loaded', function () {
      updateToolbar();
      requestRender();
    });
    requestRender();
  }

  SAT.allsky = { init: init, requestRender: requestRender };
})();
