/* scan-worker.js — worker side of SAT.scan: the three-stage field-of-view scan.
 *
 * One of these runs per pool worker. It owns a *shard* of the catalogue and, per
 * CONTRACT.md's first structural rule, builds that shard's satrecs exactly once —
 * when the 'load' message arrives — never per scan and never per step.
 *
 * The three stages, in order (CONTRACT.md "Algorithm"):
 *   1. static geometric cull, no SGP4 at all;
 *   2. coarse time sweep entirely in TEME, dot products only;
 *   3. fine refinement of the few surviving candidate windows, where converting to
 *      J2000 and doing real trigonometry is finally affordable.
 *
 * The thing that makes this interactive is not the language, it is that the POINTING
 * is rotated into TEME once per epoch and the 27 000 satellite vectors are left
 * alone. Only confirmed crossings are converted to J2000, at the end, for display.
 *
 * Structured so its core is callable from node: tools/test_scan.js drives loadObjs()
 * and runScan() directly, which is how the cull is proved sound (running with
 * useStage1:false must return the identical crossing set).
 */
(function () {
  'use strict';

  // Classic worker; in node tools/test_scan.js puts satellite.js on the global first.
  if (typeof importScripts === 'function') importScripts('../vendor/satellite.min.js');

  /* ===========================================================================
   * DUPLICATED FROM app/js/frames.js — DO NOT EDIT HERE FIRST.
   *
   * A classic worker cannot see the main thread's SAT namespace, so the handful of
   * frame transformations the scan needs are copied verbatim below. frames.js is
   * the REFERENCE IMPLEMENTATION and is the one with the verification suite
   * (tools/test_frames.js, agreement to 1e-5 arcsec); this block must stay
   * behaviourally identical to it. If you change a formula, change frames.js first,
   * re-run its tests, then mirror it here.
   *
   * Deliberately omitted (unused by the scan): moonJ2000, tanDeproject, topoTeme,
   * sunJ2000, and siteTemeKm — the last replaced by obsStateAt() below, which is the
   * same arithmetic with the site's constant ECEF vector hoisted out of a function
   * that stage 3 calls once per fine sample, and which is also where an ORBIT site
   * swaps in SGP4 (CONTRACT.md "Orbital observing stations").
   * =========================================================================== */

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const AS2R = (Math.PI / 180) / 3600;
  const J2000 = 2451545.0;

  const RE_EQ = 6378.137;                   // WGS-84 semi-major axis, km
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);

  const LEAPS = [
    [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
    [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35],
    [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37],
  ];

  function taiMinusUtc(date) {
    const t = date.getTime();
    let s = LEAPS[0][1];
    for (let i = 0; i < LEAPS.length; i++) if (t >= LEAPS[i][0]) s = LEAPS[i][1];
    return s;
  }

  function jdUTC(date) { return date.getTime() / 86400000 + 2440587.5; }
  function jdTT(date) { return jdUTC(date) + (taiMinusUtc(date) + 32.184) / 86400; }
  function tCen(date) { return (jdTT(date) - J2000) / 36525; }

  function gmstRad(date, dut1S) {
    const d = dut1S ? new Date(date.getTime() + dut1S * 1000) : date;
    return satellite.gstime(d);
  }

  const NUT = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
    [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
    [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
    [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
    [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
    [1, 0, 2, 0, 2, -301, 0, 129, -0.1],
    [0, -1, 2, -2, 2, 217, -0.5, -95, 0.3],
    [1, 0, 0, -2, 0, -158, 0, -1, 0],
    [0, 0, 2, -2, 1, 129, 0.1, -70, 0],
    [-1, 0, 2, 0, 2, 123, 0, -53, 0],
    [1, 0, 0, 0, 1, 63, 0.1, -33, 0],
    [0, 0, 0, 2, 0, 63, 0, -2, 0],
    [-1, 0, 2, 2, 2, -59, 0, 26, 0],
    [-1, 0, 0, 0, 1, -58, -0.1, 32, 0],
    [1, 0, 2, 0, 1, -51, 0, 27, 0],
    [2, 0, 0, -2, 0, 48, 0, 1, 0],
    [-2, 0, 2, 0, 1, 46, 0, -24, 0],
  ];

  let nutCache = { t: NaN, v: null };

  function nutation(date) {
    const T = tCen(date);
    if (T === nutCache.t) return nutCache.v;
    const T2 = T * T, T3 = T2 * T;
    const l = 134.96298139 + (1325 * 360 + 198.8673981) * T + 0.0086972 * T2 + 1.78e-5 * T3;
    const lp = 357.52772333 + (99 * 360 + 359.0503400) * T - 0.0001603 * T2 - 3.3e-6 * T3;
    const F = 93.27191028 + (1342 * 360 + 82.0175381) * T - 0.0036825 * T2 + 3.1e-6 * T3;
    const D = 297.85036306 + (1236 * 360 + 307.1114800) * T - 0.0019142 * T2 + 5.3e-6 * T3;
    const Om = 125.04452222 - (5 * 360 + 134.1362608) * T + 0.0020708 * T2 + 2.2e-6 * T3;

    let dPsi = 0, dEps = 0;
    for (let i = 0; i < NUT.length; i++) {
      const c = NUT[i];
      const arg = (c[0] * l + c[1] * lp + c[2] * F + c[3] * D + c[4] * Om) * D2R;
      dPsi += (c[5] + c[6] * T) * Math.sin(arg);
      dEps += (c[7] + c[8] * T) * Math.cos(arg);
    }
    dPsi *= 1e-4 * AS2R;
    dEps *= 1e-4 * AS2R;

    const epsA = (84381.448 - 46.8150 * T - 0.00059 * T2 + 0.001813 * T3) * AS2R;
    const v = {
      dPsiRad: dPsi, dEpsRad: dEps, epsARad: epsA, epsRad: epsA + dEps,
      eqEqRad: dPsi * Math.cos(epsA),
    };
    nutCache = { t: T, v: v };
    return v;
  }

  function apply(M, v) {
    return {
      x: M[0] * v.x + M[1] * v.y + M[2] * v.z,
      y: M[3] * v.x + M[4] * v.y + M[5] * v.z,
      z: M[6] * v.x + M[7] * v.y + M[8] * v.z,
    };
  }

  function applyT(M, v) {
    return {
      x: M[0] * v.x + M[3] * v.y + M[6] * v.z,
      y: M[1] * v.x + M[4] * v.y + M[7] * v.z,
      z: M[2] * v.x + M[5] * v.y + M[8] * v.z,
    };
  }

  let precCache = { t: NaN, m: null };

  /* IAU-1976 equatorial precession, J2000 -> mean of date. The ONLY precession
   * primitive; every other direction is its transpose. See frames.js for why. */
  function precessionMatrix(date) {
    const T = tCen(date);
    if (T === precCache.t) return precCache.m;
    const zeta = T * (2306.2181 + T * (0.30188 + 0.017998 * T)) * AS2R;
    const z = T * (2306.2181 + T * (1.09468 + 0.018203 * T)) * AS2R;
    const theta = T * (2004.3109 + T * (-0.42665 - 0.041833 * T)) * AS2R;
    const cze = Math.cos(zeta), sze = Math.sin(zeta);
    const cz = Math.cos(z), sz = Math.sin(z);
    const cth = Math.cos(theta), sth = Math.sin(theta);
    const m = [
      cze * cth * cz - sze * sz, -sze * cth * cz - cze * sz, -sth * cz,
      cze * cth * sz + sze * cz, -sze * cth * sz + cze * cz, -sth * sz,
      cze * sth, -sze * sth, cth,
    ];
    precCache = { t: T, m: m };
    return m;
  }

  let nutMatCache = { t: NaN, m: null };

  function nutationMatrix(date) {
    const T = tCen(date);
    if (T === nutMatCache.t) return nutMatCache.m;
    const n = nutation(date);
    const ce = Math.cos(n.epsARad), se = Math.sin(n.epsARad);
    const cp = Math.cos(n.dPsiRad), sp = Math.sin(n.dPsiRad);
    const ct = Math.cos(n.epsRad), st = Math.sin(n.epsRad);
    const m = [
      cp, -sp * ce, -sp * se,
      sp * ct, cp * ct * ce + st * se, cp * ct * se - st * ce,
      sp * st, cp * st * ce - ct * se, cp * st * se + ct * ce,
    ];
    nutMatCache = { t: T, m: m };
    return m;
  }

  function rot3(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return { x: c * v.x + s * v.y, y: -s * v.x + c * v.y, z: v.z };
  }

  function temeToJ2000(v, date) {
    const tod = rot3(v, -nutation(date).eqEqRad);
    const mod = applyT(nutationMatrix(date), tod);
    return applyT(precessionMatrix(date), mod);
  }

  function j2000ToTeme(v, date) {
    const mod = apply(precessionMatrix(date), v);
    const tod = apply(nutationMatrix(date), mod);
    return rot3(tod, nutation(date).eqEqRad);
  }

  function j2000ToTod(v, date) {
    return apply(nutationMatrix(date), apply(precessionMatrix(date), v));
  }

  function todToJ2000(v, date) {
    return applyT(precessionMatrix(date), applyT(nutationMatrix(date), v));
  }

  function siteEcefKm(loc) {
    const lat = loc.latDeg * D2R, lon = loc.lonDeg * D2R;
    const h = (loc.altM || 0) / 1000;
    const sp = Math.sin(lat), cp = Math.cos(lat);
    const N = RE_EQ / Math.sqrt(1 - WGS84_E2 * sp * sp);
    return {
      x: (N + h) * cp * Math.cos(lon),
      y: (N + h) * cp * Math.sin(lon),
      z: (N * (1 - WGS84_E2) + h) * sp,
    };
  }

  function vecToRaDec(v) {
    const r = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    let ra = Math.atan2(v.y, v.x) * R2D;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(r ? v.z / r : 0) * R2D, rKm: r };
  }

  function raDecToVec(raDeg, decDeg) {
    const a = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
    return { x: cd * Math.cos(a), y: cd * Math.sin(a), z: Math.sin(d) };
  }

  function sep(ra1, dec1, ra2, dec2) {
    const d1 = dec1 * D2R, d2 = dec2 * D2R, dA = (ra2 - ra1) * D2R;
    const s1 = Math.sin(d1), c1 = Math.cos(d1);
    const s2 = Math.sin(d2), c2 = Math.cos(d2);
    const sdA = Math.sin(dA), cdA = Math.cos(dA);
    const a = c2 * sdA, b = c1 * s2 - s1 * c2 * cdA;
    return Math.atan2(Math.sqrt(a * a + b * b), s1 * s2 + c1 * c2 * cdA) * R2D;
  }

  function posAngle(ra1, dec1, ra2, dec2) {
    const d1 = dec1 * D2R, d2 = dec2 * D2R, dA = (ra2 - ra1) * D2R;
    const p = Math.atan2(Math.sin(dA) * Math.cos(d2),
      Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dA)) * R2D;
    return (p + 360) % 360;
  }

  function refractionDeg(elDeg, opts) {
    if (elDeg < -1) return 0;
    const o = opts || {};
    const P = o.pressureMb == null ? 1010 : o.pressureMb;
    const T = o.tempC == null ? 10 : o.tempC;
    const r = 1.02 / Math.tan((elDeg + 10.3 / (elDeg + 5.11)) * D2R);
    return Math.max(0, (r / 60) * (P / 1010) * (283 / (273 + T)));
  }

  function refractionInvDeg(elAppDeg, opts) {
    if (elAppDeg < -1) return 0;
    let el = elAppDeg - refractionDeg(elAppDeg, opts);
    for (let i = 0; i < 4; i++) el = elAppDeg - refractionDeg(el, opts);
    return elAppDeg - el;
  }

  function lastRad(loc, date, dut1S) {
    return gmstRad(date, dut1S) + nutation(date).eqEqRad + loc.lonDeg * D2R;
  }

  function raDecToAltAz(raDeg, decDeg, loc, date, opts) {
    const o = opts || {};
    const tod = vecToRaDec(j2000ToTod(raDecToVec(raDeg, decDeg), date));
    const H = lastRad(loc, date, o.dut1S) - tod.raDeg * D2R;
    const phi = loc.latDeg * D2R, dec = tod.decDeg * D2R;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const sd = Math.sin(dec), cd = Math.cos(dec);
    const cH = Math.cos(H), sH = Math.sin(H);
    let el = Math.asin(Math.max(-1, Math.min(1, sp * sd + cp * cd * cH))) * R2D;
    let az = Math.atan2(-cd * sH, sd * cp - cd * sp * cH) * R2D;
    if (az < 0) az += 360;
    if (o.refract) el += refractionDeg(el, o);
    return { azDeg: az, elDeg: el };
  }

  function altAzToRaDec(azDeg, elDeg, loc, date, opts) {
    const o = opts || {};
    let el = elDeg;
    if (o.refract) el -= refractionInvDeg(el, o);
    const a = azDeg * D2R, e = el * D2R, phi = loc.latDeg * D2R;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const se = Math.sin(e), ce = Math.cos(e);
    const dec = Math.asin(Math.max(-1, Math.min(1, sp * se + cp * ce * Math.cos(a))));
    const H = Math.atan2(-ce * Math.sin(a), se * cp - ce * sp * Math.cos(a));
    const ra = (lastRad(loc, date, o.dut1S) - H) * R2D;
    const j = todToJ2000(raDecToVec(((ra % 360) + 360) % 360, dec * R2D), date);
    const rd = vecToRaDec(j);
    return { raDeg: rd.raDeg, decDeg: rd.decDeg };
  }

  function sunTodRaDec(date) {
    const n = jdUTC(date) - J2000;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const eps = (23.439 - 0.0000004 * n) * D2R;
    let ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D;
    if (ra < 0) ra += 360;
    const rAu = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return { raDeg: ra, decDeg: Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D, rAu: rAu };
  }

  function sunTemeKm(date) {
    const s = sunTodRaDec(date);
    const v = raDecToVec(s.raDeg, s.decDeg);
    const r = s.rAu * 149597870.7;
    const t = rot3(v, nutation(date).eqEqRad);
    return { x: t.x * r, y: t.y * r, z: t.z * r };
  }

  function tanProject(raDeg, decDeg, ra0, dec0) {
    const d = decDeg * D2R, d0 = dec0 * D2R, dA = (raDeg - ra0) * D2R;
    const sd = Math.sin(d), cd = Math.cos(d);
    const sd0 = Math.sin(d0), cd0 = Math.cos(d0);
    const cdA = Math.cos(dA), sdA = Math.sin(dA);
    const cosc = sd0 * sd + cd0 * cd * cdA;
    if (cosc <= 1e-12) return null;
    return {
      xi: (cd * sdA / cosc) * R2D,
      eta: ((cd0 * sd - sd0 * cd * cdA) / cosc) * R2D,
    };
  }

  /* LVLH frame — mirrors frames.js lvlhBasis/lvlhToVec/vecToLvlh exactly.
   * R = zenith (radially out), W = orbit normal (r x v), S = along-track (W x R);
   * az from S toward W, el from the local-horizontal plane toward R. */
  function lvlhBasis(r, v) {
    const rn = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    if (!(rn > 0)) return null;
    const R = { x: r.x / rn, y: r.y / rn, z: r.z / rn };
    const w = { x: r.y * v.z - r.z * v.y, y: r.z * v.x - r.x * v.z, z: r.x * v.y - r.y * v.x };
    const wn = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (!(wn > 0)) return null;
    const W = { x: w.x / wn, y: w.y / wn, z: w.z / wn };
    const S = { x: W.y * R.z - W.z * R.y, y: W.z * R.x - W.x * R.z, z: W.x * R.y - W.y * R.x };
    return { R: R, S: S, W: W };
  }

  function lvlhToVec(azDeg, elDeg, basis) {
    const a = azDeg * D2R, e = elDeg * D2R;
    const ce = Math.cos(e), se = Math.sin(e);
    const cs = ce * Math.cos(a), cw = ce * Math.sin(a);
    return {
      x: cs * basis.S.x + cw * basis.W.x + se * basis.R.x,
      y: cs * basis.S.y + cw * basis.W.y + se * basis.R.y,
      z: cs * basis.S.z + cw * basis.W.z + se * basis.R.z,
    };
  }

  function vecToLvlh(vec, basis) {
    const s = vec.x * basis.S.x + vec.y * basis.S.y + vec.z * basis.S.z;
    const w = vec.x * basis.W.x + vec.y * basis.W.y + vec.z * basis.W.z;
    const r = vec.x * basis.R.x + vec.y * basis.R.y + vec.z * basis.R.z;
    const n = Math.sqrt(s * s + w * w + r * r) || 1;
    let az = Math.atan2(w, s) * R2D;
    if (az < 0) az += 360;
    return { azDeg: az, elDeg: Math.asin(Math.max(-1, Math.min(1, r / n))) * R2D };
  }

  /* ======================= end of frames.js duplication ===================== */

  // Physical constants used only by the scan.
  // Earth rotation rate, rad/s. Same value as SAT.prop's OMEGA_E to the last digit:
  // it sets the site's velocity here and the sky/mount rate difference in stage 3,
  // and the two modules' rates are compared against each other in the UI.
  const OMEGA_E = 7.292115146706979e-5;
  const R_SUN_KM = 696000;        // solar photospheric radius, for the penumbra test
  const J2 = 1.08262668e-3;       // for the nodal regression that widens the plane test
  const RE_WGS72 = 6378.135;      // satrec.a / alta / altp are in THESE Earth radii
  const MU = 398600.8;            // km^3/s^2, WGS-72 — matches satellite.js's SGP4

  // TLE error model for the per-object slop (CONTRACT.md stage 2, Bill Gray's
  // "# Max error"). A fresh element set is good to ~1 km; error grows roughly
  // linearly at a couple of km/day, badly for decaying LEO. Converted to an ANGLE
  // by dividing by the range, so the same km buys a huge slop on a close pass and
  // almost nothing on GEO. Capped so one ancient element cannot swamp the scan.
  const TLE_ERR_KM0 = 1.0;
  const TLE_ERR_KM_PER_DAY = 2.5;
  const TLE_ERR_KM_MAX = 150;
  const TLE_SLOP_MAX_RAD = 8 * D2R;

  // Stage 1 pads. The horizon test compares a *geocentric* site latitude against an
  // inclination bound on the sub-point's geodetic latitude; those differ by up to
  // 0.19 deg, and J2 wobbles the osculating inclination by a few hundredths. One
  // degree of pad makes the test unarguably conservative for the ~nothing it costs.
  const CULL_PAD_DEG = 1.0;
  const SLICE_MS = 40;            // work budget per chunk, so 'cancel' can be heard

  // A GEO object sits inside a wide field for the whole scan, so a window can be the
  // entire timespan and fineStepS = 1 s would mean 86 400 samples for ONE object on a
  // 24 h scan. Cap the interior sampling and coarsen the step to fit; entry and exit
  // are bisected to 50 ms afterwards regardless, so this costs nothing but the
  // ability to resolve a brief exit-and-re-entry in the middle of a very long dwell.
  const FINE_SAMPLE_CAP = 4000;

  /* ---- module state: the shard, built ONCE at 'load' ----------------------- */

  let objs = [];        // ObjEntry-ish records, minus the TLE lines once parsed
  let recs = [];        // satrecs, index-parallel to objs; null when the TLE is bad
  let epochJd = null;   // Float64Array of satrec epochs, hoisted out of the hot loop
  let badCount = 0;
  let cancelled = false;

  /** Mean motion in rad/min.
   *
   *  satellite.js 5.0 as vendored here writes the un-Kozai'd mean motion into
   *  `no` and leaves `no_kozai` undefined; other builds do the opposite. Reading
   *  the wrong one is silent poison rather than an error — `undefined > 5` is
   *  false and cbrt(MU/undefined^2) is NaN, so every object would sail through the
   *  cull with NaN altitudes instead of failing visibly. Take whichever exists. */
  function meanMotion(rec) {
    return (rec.no_kozai != null && isFinite(rec.no_kozai)) ? rec.no_kozai : rec.no;
  }

  /** twoline2satrec returns error === 0 for total garbage — feed it '1 garbage' and
   *  you get back a satrec with NaN inclo, ecco and jdsatepoch. A NaN object never
   *  matches anything and never throws, so it would just quietly not be scanned.
   *  Validate the numbers, not the error flag. Mirrors SAT.prop.ensureSatrec. */
  function validSatrec(r) {
    if (!r || r.error) return false;
    const n = meanMotion(r);
    return isFinite(n) && n > 0 && isFinite(r.inclo) && isFinite(r.nodeo) &&
      isFinite(r.ecco) && r.ecco >= 0 && r.ecco < 1 && isFinite(r.jdsatepoch);
  }

  /** Build every satrec for this shard. Called once per catalogue load — 6.6 us
   *  each, 106 ms for 16 k objects, and then never again for the session. */
  function loadObjs(list) {
    objs = new Array(list.length);
    recs = new Array(list.length);
    epochJd = new Float64Array(list.length);
    badCount = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      objs[i] = {
        id: o.id, norad: o.norad, name: o.name, intl: o.intl,
        rcs: o.rcs == null ? null : o.rcs, stdMag: o.stdMag == null ? null : o.stdMag,
        type: o.type == null ? null : String(o.type),
        cls: o.cls == null ? null : String(o.cls).trim().toLowerCase(),
      };
      let r = null;
      try {
        r = satellite.twoline2satrec(o.l1, o.l2);
        if (!validSatrec(r)) r = null;
      } catch (e) { r = null; }
      recs[i] = r;
      if (r) objs[i].cls = classOf(r);
      epochJd[i] = r ? r.jdsatepoch : 0;
      if (!r) badCount++;
    }
    return { count: objs.length, bad: badCount };
  }

  /* ---- small geometry helpers --------------------------------------------- */

  /** True when A*rho^2 + B*rho + C <= 0 somewhere in [lo, hi].
   *
   *  CONTRACT.md prescribes sweeping ~24 log-spaced ranges along the sightline for
   *  both stage-1 range tests. Both tests turn out to be quadratics in rho (the
   *  orbit-plane one because f(rho) = s.n + rho*(r.n) is LINEAR, squared against
   *  |p|^2; the declination one likewise), so we minimise them in closed form
   *  instead: same test, but it cannot fall through a gap between samples, and it
   *  is O(1) rather than O(24) per epoch. A sampled sweep that straddles a narrow
   *  admissible band would silently drop a real object, which is the one failure
   *  mode a cull must not have. */
  function quadMinLE0(A, B, C, lo, hi) {
    const ev = (x) => (A * x + B) * x + C;
    let m = Math.min(ev(lo), ev(hi));
    if (A > 0) {
      const xv = -B / (2 * A);
      if (xv > lo && xv < hi) m = Math.min(m, ev(xv));
    }
    return m <= 0;
  }

  function classOf(rec) {
    const revPerDay = meanMotion(rec) * 1440 / (2 * Math.PI);
    if (revPerDay >= 0.9 && revPerDay <= 1.1 && rec.ecco < 0.05) return 'geo';
    if (rec.ecco >= 0.25) return 'heo';
    if (revPerDay > 5) return 'leo';
    return 'meo';
  }

  /** Geocentric radii of perigee and apogee, km.
   *
   *  Prefer satrec.alta / satrec.altp — SGP4's own initialisation computed them, so
   *  the cull geometry is guaranteed to match what the propagator will actually do
   *  rather than a re-derivation that could disagree at the edges. They are heights
   *  in WGS-72 Earth radii, hence the +1 and the 6378.135. Kepler's third law is the
   *  fallback for any element set that leaves them unset. */
  function orbitRadii(rec) {
    if (isFinite(rec.alta) && isFinite(rec.altp) && rec.altp > -1) {
      const rApo = (rec.alta + 1) * RE_WGS72, rPeri = (rec.altp + 1) * RE_WGS72;
      return { rPeri: rPeri, rApo: rApo, aKm: (rApo + rPeri) / 2 };
    }
    let a = rec.a;
    if (!(a > 0) || !isFinite(a)) {
      const nRadS = meanMotion(rec) / 60;
      a = Math.cbrt(MU / (nRadS * nRadS)) / RE_WGS72;
    }
    const aKm = a * RE_WGS72;
    return { rPeri: aKm * (1 - rec.ecco), rApo: aKm * (1 + rec.ecco), aKm: aKm };
  }

  /** Angular velocity of a topocentric direction, resolved into the north/east sky
   *  basis at that direction, so the position angle is directly comparable to a
   *  streak measured on an image. Mirrors SAT.prop.look()'s skyRate() exactly —
   *  the crossings table shows these numbers next to that module's. */
  function skyRate(rhoJ, vel, rangeKm) {
    const ux = rhoJ.x / rangeKm, uy = rhoJ.y / rangeKm, uz = rhoJ.z / rangeKm;
    let ex = -uy, ey = ux, ez = 0;               // east = zhat x uhat
    const en = Math.sqrt(ex * ex + ey * ey);
    if (en < 1e-12) { ex = 1; ey = 0; ez = 0; } else { ex /= en; ey /= en; }
    const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
    const radial = vel.x * ux + vel.y * uy + vel.z * uz;
    const tx = vel.x - radial * ux, ty = vel.y - radial * uy, tz = vel.z - radial * uz;
    const dE = (tx * ex + ty * ey + tz * ez) / rangeKm;      // rad/s
    const dN = (tx * nx + ty * ny + tz * nz) / rangeKm;
    return {
      rate: Math.sqrt(dE * dE + dN * dN) * R2D * 3600,
      pa: (Math.atan2(dE, dN) * R2D + 360) % 360,
    };
  }

  /** Conical Earth shadow with the solar angular radius. Oblateness ignored —
   *  worth <= 0.3 s of timing error at the terminator, far inside TLE noise. */
  function shadowState(satTeme, sunTeme) {
    const rs = Math.sqrt(satTeme.x * satTeme.x + satTeme.y * satTeme.y + satTeme.z * satTeme.z);
    if (rs <= RE_EQ) return { state: 'umbra', frac: 0 };
    const dx = sunTeme.x - satTeme.x, dy = sunTeme.y - satTeme.y, dz = sunTeme.z - satTeme.z;
    const ds = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const thE = Math.asin(Math.min(1, RE_EQ / rs));
    const thS = Math.asin(Math.min(1, R_SUN_KM / ds));
    // angle at the satellite between the Earth's centre and the Sun's centre
    const cosT = (-satTeme.x * dx - satTeme.y * dy - satTeme.z * dz) / (rs * ds);
    const th = Math.acos(Math.max(-1, Math.min(1, cosT)));
    if (th >= thE + thS) return { state: 'none', frac: 1 };
    if (th <= thE - thS) return { state: 'umbra', frac: 0 };
    // partial: unobscured fraction of the solar disc, exact circle-circle overlap
    const r1 = thS, r2 = thE, d = Math.max(th, 1e-12);
    const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1))));
    const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))));
    const overlap = r1 * r1 * (a1 - Math.sin(2 * a1) / 2) + r2 * r2 * (a2 - Math.sin(2 * a2) / 2);
    const frac = Math.max(0, Math.min(1, 1 - overlap / (Math.PI * r1 * r1)));
    return { state: 'penumbra', frac: frac };
  }

  /* ---- scan --------------------------------------------------------------- */

  /** Resolve the scan parameters into the derived quantities every stage needs.
   *  Nothing here depends on a satellite, so it happens exactly once. */
  function prepare(params) {
    const p = params || {};
    const site = p.site;
    const dut1S = p.dut1S || 0;
    const fov = p.fov || {};
    const steps = p.steps || {};
    const filters = p.filters || {};

    const filterSet = (value, normalise) => {
      if (value == null) return null;
      let values = value;
      if (!Array.isArray(values)) {
        if (typeof values === 'object') {
          values = Object.keys(values).filter((key) => values[key]);
        } else {
          values = String(values).split(/[\\s,]+/);
        }
      }
      return new Set(values.map((item) => normalise(item)).filter((item) => item));
    };
    const normaliseClass = (value) => {
      const cls = String(value == null ? '' : value).trim().toLowerCase();
      return cls === 'leo' || cls === 'meo' || cls === 'geo' || cls === 'heo' ? cls : '';
    };
    const normaliseType = (value) => {
      const type = String(value == null ? '' : value).trim().toUpperCase();
      return type === 'PAY' || type === 'R/B' || type === 'DEB' ? type : 'UNK';
    };

    const shape = fov.shape === 'circ' ? 'circ' : 'rect';
    const halfW = (fov.wDeg || 0) / 2, halfH = (fov.hDeg || 0) / 2;
    // Coarse stage works with a single circumscribing radius; the true rectangle
    // is only imposed in stage 3, where the cost of getting it exactly right is paid
    // on a handful of objects instead of the whole catalogue.
    const fovRadiusDeg = shape === 'circ'
      ? (fov.rDeg || 0)
      : Math.sqrt(halfW * halfW + halfH * halfH);

    const obsKind = site && site.kind === 'orbit' ? 'orbit' : 'ground';

    // Orbit sites clamp the coarse step to <= 10 s (CONTRACT "Stage 2/3 under a
    // moving observer"): the chord rescue assumes near-rectilinear RELATIVE motion
    // across one step, and the residual curvature scales with dt^2. scan.js clamps
    // its estimate the same way so the refusal maths stay honest.
    const coarseStepS = obsKind === 'orbit'
      ? Math.max(0.5, Math.min(10, steps.coarseStepS || 30))
      : Math.max(0.5, steps.coarseStepS || 30);
    const fineStepS = Math.max(0.05, steps.fineStepS || 1);
    const spanMin = Math.max(0, p.spanMin || 0);
    const t0Ms = p.t0Ms;
    const t1Ms = t0Ms + spanMin * 60000;
    const nSteps = Math.max(1, Math.round(spanMin * 60 / coarseStepS)) + 1;

    // Ground: hoist the constant ECEF vector (stage 3 calls the provider once per
    // fine sample). Orbit: build the observer satrec ONCE, here. An invalid
    // observer TLE fails the scan loudly at prepare time — it must never fail open
    // into "scanned from (0,0,0)" (CONTRACT "The observer provider").
    let ecef = { x: 0, y: 0, z: 0 }, siteR = 0, siteGcLatDeg = 0, obs = null;
    if (obsKind === 'orbit') {
      let rec = null;
      try { rec = satellite.twoline2satrec(site.l1, site.l2); } catch (e) { rec = null; }
      if (!validSatrec(rec)) {
        throw new Error('observer TLE for NORAD ' + site.norad +
          (site.name ? ' (' + site.name + ')' : '') + ' cannot be propagated');
      }
      const rad = orbitRadii(rec);
      const jd0 = t0Ms / 86400000 + 2440587.5;
      const ageDays = Math.abs(jd0 - rec.jdsatepoch);
      obs = {
        rec: rec, epochJd: rec.jdsatepoch, norad: site.norad,
        rObsMin: rad.rPeri, rObsMax: rad.rApo,
        nRadS: meanMotion(rec) / 60,
        slopKm: Math.min(TLE_ERR_KM_MAX, TLE_ERR_KM0 + TLE_ERR_KM_PER_DAY * ageDays),
      };
    } else {
      ecef = siteEcefKm(site);
      siteR = Math.sqrt(ecef.x * ecef.x + ecef.y * ecef.y + ecef.z * ecef.z);
      // geocentric, not geodetic: the inclination bound is on geocentric latitude
      siteGcLatDeg = Math.asin(ecef.z / siteR) * R2D;
    }

    return {
      site: site, dut1S: dut1S, filters: filters,
      classSet: filterSet(filters.classes != null ? filters.classes
        : (filters.class != null ? filters.class : filters.orbitClasses), normaliseClass),
      typeSet: filterSet(filters.types != null ? filters.types
        : (filters.type != null ? filters.type : filters.objectTypes), normaliseType),
      pointing: p.pointing || { track: 'sky', raDeg: 0, decDeg: 0 },
      shape: shape, halfW: halfW, halfH: halfH,
      rotDeg: fov.rotDeg || 0,
      fovRadiusDeg: fovRadiusDeg, fovRadiusRad: fovRadiusDeg * D2R,
      coarseStepS: coarseStepS, fineStepS: fineStepS,
      marginDeg: steps.marginDeg || 0,
      spanMin: spanMin, t0Ms: t0Ms, t1Ms: t1Ms, nSteps: nSteps,
      // minEl is a ground concept (horizon obstruction / extinction); an orbit
      // site's equivalent is the limb-occlusion gate, so the filter is forced off.
      minElDeg: obsKind === 'orbit' ? 0 : (filters.minElDeg || 0),
      sinMinEl: obsKind === 'orbit' ? 0 : Math.sin((filters.minElDeg || 0) * D2R),
      siteEcef: ecef, siteR: siteR, siteGcLatDeg: siteGcLatDeg,
      obsKind: obsKind, obs: obs,
      obsSlopKm: obs ? obs.slopKm : 0,
      excludeNorad: obs ? obs.norad : null,
      useStage1: p.useStage1 !== false,
      maxCrossings: p.maxCrossings || 5000,
      // Occultation pass discovery may request a smaller diagnostic path to
      // avoid transferring millions of redundant points to the main thread.
      // The crossing geometry itself is unchanged; later exact refinement can
      // evaluate the canonical trajectory when a star candidate survives.
      pathMaxSamples: Math.max(2, Math.floor(Number(p.workerPathMaxSamples || p.pathMaxSamples || 64))),
    };
  }

  function objectAllowed(P, obj) {
    if (!obj) return false;
    if (P.classSet && !P.classSet.has(String(obj.cls == null ? '' : obj.cls).trim().toLowerCase())) {
      return false;
    }
    if (P.typeSet) {
      const rawType = String(obj.type == null ? '' : obj.type).trim().toUpperCase();
      const type = rawType === 'PAY' || rawType === 'R/B' || rawType === 'DEB'
        ? rawType : 'UNK';
      if (!P.typeSet.has(type)) return false;
    }
    return true;
  }

  /** Observer state in TEME km and km/s — THE one place observer kind matters
   *  downstream of prepare() (CONTRACT "Orbital observing stations").
   *
   *  ground — v_TEME = R3(-gmst) . v_ECEF with the ECEF vector hoisted, plus the
   *           inertial site velocity omega_z x r that stage 2's rate margin and
   *           stage 3's range-rate always needed and used to rebuild inline;
   *  orbit  — one sgp4() on the observer satrec. A failure THROWS and fails the
   *           whole scan: a scan quietly run from (0,0,0) is the worst bug here. */
  function obsStateAt(P, date) {
    if (P.obsKind === 'orbit') {
      const tsince = (date.getTime() / 86400000 + 2440587.5 - P.obs.epochJd) * 1440;
      let pv = null;
      try { pv = satellite.sgp4(P.obs.rec, tsince); } catch (e) { pv = null; }
      if (!pv || !pv.position || pv.position === false || !isFinite(pv.position.x)) {
        throw new Error('observer SGP4 failed at ' + date.toISOString() +
          ' (NORAD ' + P.obs.norad + ')');
      }
      return {
        x: pv.position.x, y: pv.position.y, z: pv.position.z,
        vx: pv.velocity.x, vy: pv.velocity.y, vz: pv.velocity.z,
      };
    }
    const e = P.siteEcef;
    const g = gmstRad(date, P.dut1S);
    const c = Math.cos(g), s = Math.sin(g);
    const x = e.x * c - e.y * s, y = e.x * s + e.y * c;
    return { x: x, y: y, z: e.z, vx: -OMEGA_E * y, vy: OMEGA_E * x, vz: 0 };
  }

  /** Pointing at one epoch: the TEME unit vector the hot loop compares against,
   *  plus the J2000 RA/Dec stage 3 needs for the chart-frame boundary test.
   *
   *  track 'sky'   — the field is fixed on the celestial sphere, so the J2000
   *                  RA/Dec is constant and only the J2000->TEME rotation moves.
   *  track 'mount' — ground: fixed in alt/az (parked telescope, drift scan), so
   *                  the RA/Dec is re-derived every epoch. Orbit: fixed in LVLH
   *                  (a body-mounted staring sensor) — azDeg/elDeg are LVLH
   *                  angles, the boresight comes straight off the observer PV in
   *                  TEME, and refraction never applies (CONTRACT v0.2).
   *
   *  Either way this is ONE call per epoch, outside the satellite loop, and the
   *  caller hands in the observer state it already has. Rotating the pointing
   *  rather than the catalogue is worth more than everything else in this file
   *  combined. */
  function pointingAt(P, date, obsSt) {
    const pt = P.pointing;
    if (pt.track === 'mount' && P.obsKind === 'orbit') {
      const basis = lvlhBasis(
        { x: obsSt.x, y: obsSt.y, z: obsSt.z },
        { x: obsSt.vx, y: obsSt.vy, z: obsSt.vz });
      if (!basis) {
        throw new Error('degenerate observer state (r parallel to v) — cannot form LVLH');
      }
      const t = lvlhToVec(pt.azDeg || 0, pt.elDeg || 0, basis);   // already TEME
      const rd = vecToRaDec(temeToJ2000(t, date));
      return { x: t.x, y: t.y, z: t.z, raDeg: rd.raDeg, decDeg: rd.decDeg };
    }
    let raDeg, decDeg;
    if (pt.track === 'mount') {
      const rd = altAzToRaDec(pt.azDeg, pt.elDeg, P.site, date,
        { refract: !!pt.refract, dut1S: P.dut1S });
      raDeg = rd.raDeg; decDeg = rd.decDeg;
    } else {
      raDeg = pt.raDeg; decDeg = pt.decDeg;
    }
    const t = j2000ToTeme(raDecToVec(raDeg, decDeg), date);
    return { x: t.x, y: t.y, z: t.z, raDeg: raDeg, decDeg: decDeg };
  }

  /** Stage 1 — static geometric cull, no SGP4 at all.
   *
   *  Bill Gray's sat_id has no such cull: it brute-forces the catalogue at a single
   *  epoch, which is cheap. We scan a timespan, so every object removed here is
   *  removed from every one of the N coarse steps. Typical survival on a 27 k
   *  catalogue is 10-40%; a pointing near the pole kills the whole GEO belt.
   *
   *  Returns a Uint8Array of keep flags. Everything it uses comes out of the
   *  satrec — inclo, nodeo, no, ecco — so it never touches SGP4.
   */
  function stage1(P) {
    const n = recs.length;
    const keep = new Uint8Array(n);

    // Sample the sightline geometry at a handful of epochs, because the tests below
    // OR over samples — too sparse a cadence would CULL REAL OBJECTS, the one
    // failure a cull must never have (CONTRACT "Stage 1 under a moving observer").
    //   ground — the site vector sweeps at 15 deg/h with Earth rotation (and for
    //            track 'mount' the ray sweeps with it): a 15-minute cadence plus
    //            the pads below covers it, as v0.1 always did;
    //   orbit  — the observer sweeps its own orbit at up to ~4 deg/min, so sample
    //            ~2 deg of observer ARC per epoch, capped at 600 samples (SGP4 on
    //            ONE object is ~0.6 us — a full cap's worth costs under a
    //            millisecond). Whatever arc the cap leaves unresolved is repaid
    //            below as chordKm, charged per object as a tolerance pad.
    const spanS = P.spanMin * 60;
    const nT = P.obsKind === 'orbit'
      ? Math.max(2, Math.min(600, Math.ceil((P.obs.nRadS * spanS) / (2 * D2R)) + 1))
      : Math.max(2, Math.min(25, Math.ceil(P.spanMin / 15) + 1));
    const ep = [];
    for (let j = 0; j < nT; j++) {
      const d = new Date(P.t0Ms + (P.spanMin * 60000) * (nT === 1 ? 0 : j / (nT - 1)));
      const s = obsStateAt(P, d);
      const u = pointingAt(P, d, s);
      const un = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z) || 1;
      const r = { x: u.x / un, y: u.y / un, z: u.z / un };
      ep.push({
        sx: s.x, sy: s.y, sz: s.z, rx: r.x, ry: r.y, rz: r.z,
        S: s.x * s.x + s.y * s.y + s.z * s.z,          // |s|^2
        Pr: s.x * r.x + s.y * r.y + s.z * r.z,          // s . r_hat
      });
    }

    // Between-sample observer motion, as a chord: a true observer position is
    // within chordKm of SOME sample, and the candidate point p = s + rho*r it
    // shifts satisfies |p| >= rPeri_target, so chordKm / rPeri_target radians of
    // extra tolerance makes the sampled tests provably conservative. Zero on the
    // ground, where the 15-min cadence was always resolved by CULL_PAD_DEG.
    let chordKm = 0;
    if (P.obsKind === 'orbit') {
      const dTheta = nT > 1 ? (P.obs.nRadS * spanS) / (nT - 1) : 0;
      chordKm = 2 * P.obs.rObsMax * Math.sin(Math.min(Math.PI, dTheta) / 2);
    }

    const obsRad = P.obsKind === 'orbit' ? P.obs.rObsMax : P.siteR;
    const spanDays = P.spanMin / 1440;
    const jd0 = P.t0Ms / 86400000 + 2440587.5;
    const fovR = P.fovRadiusDeg + P.marginDeg + CULL_PAD_DEG;
    const sinFov = Math.sin(Math.min(Math.PI / 2, fovR * D2R));

    for (let i = 0; i < n; i++) {
      if (!objectAllowed(P, objs[i])) continue;
      const rec = recs[i];
      if (!rec) continue;

      const rad = orbitRadii(rec);
      // A cull must fail OPEN. If any of the derived geometry is not finite we keep
      // the object and let stage 2 decide with real SGP4, rather than silently
      // dropping it — "no satellites tonight" is the worst possible bug here.
      if (!(rad.rApo > 0) || !(rad.rPeri > 0) || !isFinite(rec.inclo) || !isFinite(rec.nodeo)) {
        keep[i] = 1;
        continue;
      }
      const incDeg = rec.inclo * R2D;
      // a retrograde orbit at i = 100 deg still only reaches |lat| = 80 deg
      const iEff = incDeg <= 90 ? incDeg : 180 - incDeg;

      // --- horizon reachability (GROUND ONLY) -------------------------------
      // The sub-satellite point never leaves |lat| <= iEff, so the smallest
      // possible ground arc between site and sub-point is |phi| - iEff. The object
      // can only ever be above the horizon if that is inside the horizon
      // half-angle acos(Re / r_apogee). Compared as a cosine so no acos is needed.
      // An orbit site has no fixed latitude and nothing is permanently hidden —
      // only limb-occluded per sample, which is stage 2's gate — so this cull is
      // skipped there (fail open; the plane test was always the strong one).
      if (P.obsKind !== 'orbit') {
        const minArc = Math.max(0, Math.abs(P.siteGcLatDeg) - iEff - CULL_PAD_DEG);
        if (Math.cos(minArc * D2R) < P.siteR / rad.rApo) continue;
      }

      // Range interval along the sightline: closest possible is perigee straight
      // overhead, furthest is apogee on the far side of the Earth (for an orbit
      // site, of the observer's own apogee-radius sphere).
      const rhoLo = Math.max(1, rad.rPeri - obsRad);
      const rhoHi = rad.rApo + obsRad;

      // observer between-sample motion, charged as an angle at this object's
      // closest possible geocentric radius — see chordKm above
      const padRad = chordKm > 0 ? chordKm / Math.max(rad.rPeri, RE_EQ) : 0;

      // --- declination reachability ---------------------------------------
      // A satellite seen along the ray sits at p = s + rho*r_hat. Its geocentric
      // declination is bounded by |dec| <= iEff, so we need some rho with
      // p_z^2 <= K |p|^2, K = sin^2(iEff + fov + pad). Quadratic in rho.
      const decLim = Math.min(90, iEff + fovR + padRad * R2D);
      const sk = Math.sin(decLim * D2R), K = sk * sk;

      // --- orbit-plane test (the strong one) ------------------------------
      // The satellite is always IN its orbital plane, so p_hat . n_hat == 0 exactly.
      // Tolerance absorbs the field radius plus the nodal regression of Omega:
      // nodedot = -1.5 J2 (Re/p)^2 n cos i. The regression runs from the ELEMENT
      // EPOCH, not from the scan start — nodeo is Omega at epoch, and a 5-day-old
      // LEO element set has already swept ~25 deg of node before the scan even
      // begins. Charging spanDays alone lost real boundary objects the moment the
      // catalogue was older than the CULL_PAD (caught by the cull on/off identity
      // test on a stale snapshot, 2026-07-25). Fresh short scans still get a very
      // tight test; only stale elements pay. Unlike the declination test this
      // uses Omega, so it discriminates WHICH polar orbits can reach this field,
      // not merely whether the inclination is big enough.
      const semiLatus = rad.aKm * (1 - rec.ecco * rec.ecco) / RE_WGS72;
      const nRadDay = meanMotion(rec) * 1440;
      const nodeDot = Math.abs(1.5 * J2 * (1 / (semiLatus * semiLatus)) * nRadDay * Math.cos(rec.inclo));
      const nodeDays = spanDays + Math.abs(jd0 - epochJd[i]);
      const tol = Math.min(1, sinFov + nodeDot * nodeDays + padRad);
      const tol2 = tol * tol;

      const si = Math.sin(rec.inclo), ci = Math.cos(rec.inclo);
      const nx = si * Math.sin(rec.nodeo), ny = -si * Math.cos(rec.nodeo), nz = ci;

      let okDec = false, okPlane = false;
      for (let j = 0; j < nT && !(okDec && okPlane); j++) {
        const e = ep[j];
        if (!okDec) {
          // (sz + rho rz)^2 - K(|s|^2 + 2 rho (s.r) + rho^2) <= 0
          okDec = quadMinLE0(e.rz * e.rz - K,
            2 * (e.sz * e.rz - K * e.Pr),
            e.sz * e.sz - K * e.S, rhoLo, rhoHi);
        }
        if (!okPlane) {
          // (s.n + rho (r.n))^2 - tol^2 |p|^2 <= 0
          const b = e.sx * nx + e.sy * ny + e.sz * nz;
          const c = e.rx * nx + e.ry * ny + e.rz * nz;
          okPlane = quadMinLE0(c * c - tol2,
            2 * (b * c - tol2 * e.Pr),
            b * b - tol2 * e.S, rhoLo, rhoHi);
        }
      }
      if (okDec && okPlane) keep[i] = 1;
    }
    return keep;
  }

  /** The whole scan. Chunked with setTimeout so a 'cancel' message can land and so
   *  progress is reported; resolves with crossings plus the per-stage cull counts.
   *  An optional third argument receives each crossing as soon as stage 3 confirms
   *  it. The normal browser caller omits it and retains the historical batch result;
   *  the desktop complete runner uses it as a bounded-memory stream. */
  function runScan(params, onProgress, onCrossing) {
    const P = prepare(params);
    cancelled = false;
    const t0Wall = Date.now();

    return new Promise((resolve, reject) => {
      const n = recs.length;
      let propagations = 0;

      // ---- stage 1 -------------------------------------------------------
      const keep = P.useStage1 ? stage1(P) : (() => {
        const k = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (recs[i] && objectAllowed(P, objs[i])) k[i] = 1;
        return k;
      })();

      const live = [];
      for (let i = 0; i < n; i++) {
        if (!keep[i]) continue;
        if (!objectAllowed(P, objs[i])) continue;
        // Self-exclusion (CONTRACT v0.2 gate 5): the observer never identifies
        // itself. Applied here so it holds on the useStage1:false path too.
        if (P.excludeNorad != null && objs[i].norad === P.excludeNorad) continue;
        live.push(i);
      }
      const culledStage1 = n - badCount - live.length;

      // Per-survivor constants, hoisted out of the step loop.
      const nLive = live.length;
      const tsince0 = new Float64Array(nLive);   // minutes since element epoch at t0
      const slopKm = new Float64Array(nLive);
      const ageDays = new Float64Array(nLive);
      const jd0 = P.t0Ms / 86400000 + 2440587.5;
      for (let k = 0; k < nLive; k++) {
        const rec = recs[live[k]];
        tsince0[k] = (jd0 - epochJd[live[k]]) * 1440;
        const age = Math.abs(tsince0[k]) / 1440;
        ageDays[k] = age;
        slopKm[k] = Math.min(TLE_ERR_KM_MAX, TLE_ERR_KM0 + TLE_ERR_KM_PER_DAY * age);
      }

      // ---- stage 2 state -------------------------------------------------
      const stepMin = P.coarseStepS / 60;
      const stepMs = P.coarseStepS * 1000;
      const prevU = new Float64Array(nLive * 3);
      const hasPrev = new Uint8Array(nLive);
      const winA = new Float64Array(nLive);      // open candidate window, ms
      const winB = new Float64Array(nLive);
      const winOpen = new Uint8Array(nLive);
      const windows = new Map();                 // live index -> [[a,b], ...]
      const extraMarginRad = P.marginDeg * D2R;

      const openWindow = (k, tMs) => {
        const a = tMs - stepMs, b = tMs + stepMs;
        if (winOpen[k] && a <= winB[k]) { winB[k] = Math.max(winB[k], b); return; }
        if (winOpen[k]) {
          let arr = windows.get(k);
          if (!arr) { arr = []; windows.set(k, arr); }
          arr.push([winA[k], winB[k]]);
        }
        winA[k] = a; winB[k] = b; winOpen[k] = 1;
      };

      let step = 0;

      const coarseChunk = () => {
        if (cancelled) { reject(new Error('cancelled')); return; }
        const deadline = Date.now() + SLICE_MS;
        try {
        while (step < P.nSteps && Date.now() < deadline) {
          const tMs = Math.min(P.t0Ms + step * stepMs, P.t1Ms);
          const date = new Date(tMs);

          // ---- once per epoch, outside the satellite loop (CONTRACT rule 4) ----
          const s = obsStateAt(P, date);
          const sx = s.x, sy = s.y, sz = s.z;
          const svx = s.vx, svy = s.vy, svz = s.vz;        // observer velocity, TEME
          const S2 = sx * sx + sy * sy + sz * sz;          // |s|^2, for the limb test
          const isOrbit = P.obsKind === 'orbit';
          const pt = pointingAt(P, date, s);
          const pn = Math.sqrt(pt.x * pt.x + pt.y * pt.y + pt.z * pt.z) || 1;
          const px = pt.x / pn, py = pt.y / pn, pz = pt.z / pn;
          const tsinceStep = step * stepMin;

          for (let k = 0; k < nLive; k++) {
            const rec = recs[live[k]];
            let pv;
            try { pv = satellite.sgp4(rec, tsince0[k] + tsinceStep); }
            catch (e) { pv = null; }
            propagations++;
            if (!pv || !pv.position || pv.position === false) { hasPrev[k] = 0; continue; }
            const r = pv.position;

            const dx = r.x - sx, dy = r.y - sy, dz = r.z - sz;
            const r2 = dx * dx + dy * dy + dz * dz;

            let rho;
            if (isOrbit) {
              // Earth-limb occlusion (CONTRACT v0.2 gate 1): drop the sample iff
              // the observer->target segment dips inside the hard Earth sphere.
              rho = Math.sqrt(r2);
              const tStar = -(sx * dx + sy * dy + sz * dz) / rho;
              if (tStar > 0 && tStar < rho && S2 - tStar * tStar < RE_EQ * RE_EQ) {
                hasPrev[k] = 0; continue;
              }
            } else {
              // horizon: dot(topo, site) > 0 — the site vector IS the local up
              const up = dx * sx + dy * sy + dz * sz;
              if (up <= 0) { hasPrev[k] = 0; continue; }
              rho = Math.sqrt(r2);
              if (P.sinMinEl > 0 && up < P.sinMinEl * rho * P.siteR) { hasPrev[k] = 0; continue; }
            }

            // adaptive margin, recomputed from THIS step's own range and speed:
            // a GEO object gets arcminutes, an overhead LEO object tens of degrees.
            // The slop charges BOTH element sets — at the sensor the observer's
            // ephemeris error is indistinguishable from the target's.
            const vx = pv.velocity.x - svx, vy = pv.velocity.y - svy, vz = pv.velocity.z - svz;
            const omega = Math.sqrt(vx * vx + vy * vy + vz * vz) / rho;   // rad/s, upper bound
            const slopRad = Math.min(TLE_SLOP_MAX_RAD, (slopKm[k] + P.obsSlopKm) / rho);
            const m = P.fovRadiusRad + extraMarginRad + slopRad + omega * P.coarseStepS;

            const ux = dx / rho, uy = dy / rho, uz = dz / rho;
            const d = ux * px + uy * py + uz * pz;

            // separation as a dot product against cos(margin) — no acos, no atan2.
            // cos(m) >= 1 - m^2/2 always, so using the polynomial as the threshold
            // accepts slightly MORE than the exact test: conservative by construction,
            // and it keeps trig out of a loop that runs 27 000 x N times.
            let hit = false;
            if (m >= Math.PI) hit = true;
            else hit = d >= Math.max(-1, 1 - m * m / 2);

            // Great-circle arc between consecutive coarse positions. Tighter and
            // cheaper to satisfy than a point test with a padded radius, so it is
            // what lets coarseStepS stay large: an object that crosses the field
            // entirely between two samples still shows up, because the chord passes
            // through it even though neither endpoint is close.
            if (!hit && hasPrev[k]) {
              const o = k * 3;
              const ax = prevU[o], ay = prevU[o + 1], az = prevU[o + 2];
              const cx = ay * uz - az * uy, cy = az * ux - ax * uz, cz = ax * uy - ay * ux;
              const nn = cx * cx + cy * cy + cz * cz;
              if (nn > 1e-18) {
                const pd = px * cx + py * cy + pz * cz;
                const sm = Math.min(1, P.fovRadiusRad + extraMarginRad + slopRad);
                if (pd * pd <= sm * sm * nn) {
                  // is the closest point of the great circle between the two samples?
                  const c0 = (ay * pz - az * py) * cx + (az * px - ax * pz) * cy
                    + (ax * py - ay * px) * cz;
                  const c1 = (py * uz - pz * uy) * cx + (pz * ux - px * uz) * cy
                    + (px * uy - py * ux) * cz;
                  if (c0 >= 0 && c1 >= 0) hit = true;
                }
              }
            }

            const o = k * 3;
            prevU[o] = ux; prevU[o + 1] = uy; prevU[o + 2] = uz;
            hasPrev[k] = 1;

            if (hit) openWindow(k, tMs);
          }
          step++;
        }
        // an unpropagatable OBSERVER fails the scan loudly (see obsStateAt)
        } catch (err) { reject(err); return; }

        if (onProgress) onProgress({ done: step, total: P.nSteps, phase: 'coarse' });
        if (step < P.nSteps) { setTimeout(coarseChunk, 0); return; }

        for (let k = 0; k < nLive; k++) {
          if (!winOpen[k]) continue;
          let arr = windows.get(k);
          if (!arr) { arr = []; windows.set(k, arr); }
          arr.push([winA[k], winB[k]]);
        }
        setTimeout(fineStart, 0);
      };

      // ---- stage 3 -------------------------------------------------------
      const cands = [];
      const crossings = [];
      let ci = 0;
      let culledStage3 = 0;

      const fineStart = () => {
        windows.forEach((arr, k) => cands.push({ k: k, wins: arr }));
        fineChunk();
      };

      const fineChunk = async () => {
        if (cancelled) { reject(new Error('cancelled')); return; }
        try {
          const deadline = Date.now() + SLICE_MS;
          while (ci < cands.length && Date.now() < deadline) {
            const c = cands[ci++];
            const before = crossings.length;
            try { refine(P, c.k, live[c.k], tsince0[c.k], ageDays[c.k], slopKm[c.k], c.wins, crossings); }
            catch (e) { /* defensive: never let one bad object kill a scan */ }
            if (crossings.length === before) {
              culledStage3++;
            } else if (typeof onCrossing === 'function') {
              const produced = crossings.splice(before);
              for (let i = 0; i < produced.length; i++) {
                await onCrossing(produced[i]);
              }
            }
          }
          if (onProgress) onProgress({ done: ci, total: cands.length, phase: 'fine' });
          if (ci < cands.length) { setTimeout(fineChunk, 0); return; }

          crossings.sort((a, b) => a.tCaMs - b.tCaMs);
          resolve({
            crossings: crossings,
            culled: {
              total: n, bad: badCount,
              stage1: culledStage1,
              stage2: live.length - cands.length,
              stage3: culledStage3,
              survivors: live.length, candidates: cands.length,
            },
            propagations: propagations,
            ms: Date.now() - t0Wall,
          });
        } catch (error) {
          reject(error);
        }
      };

      setTimeout(coarseChunk, 0);
    });
  }

  /** Full topocentric solution at one instant, in the frames the boundary test
   *  needs. This is stage-3-only work: it converts to J2000 and uses real trig,
   *  which would be ruinous in the coarse loop but costs nothing on a handful of
   *  candidates. */
  function solveAt(P, rec, tsinceMin, tMs) {
    const date = new Date(tMs);
    let pv;
    try { pv = satellite.sgp4(rec, tsinceMin); } catch (e) { return null; }
    if (!pv || !pv.position || pv.position === false) return null;

    const s = obsStateAt(P, date);
    const topo = { x: pv.position.x - s.x, y: pv.position.y - s.y, z: pv.position.z - s.z };
    const rho = Math.sqrt(topo.x * topo.x + topo.y * topo.y + topo.z * topo.z);
    const j = temeToJ2000(topo, date);
    const rd = vecToRaDec(j);
    const pt = pointingAt(P, date, s);

    // upDot/(rho*|s|) is sin(height above the local horizontal) for EITHER kind —
    // the ground zenith and the LVLH R axis are both just s_hat.
    const sR = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
    const upDot = topo.x * s.x + topo.y * s.y + topo.z * s.z;
    const elSin = upDot / (rho * sR);
    let occluded = false;
    if (P.obsKind === 'orbit') {
      const tStar = -upDot / rho;
      occluded = tStar > 0 && tStar < rho && sR * sR - tStar * tStar < RE_EQ * RE_EQ;
    }

    return {
      date: date, tMs: tMs, satTeme: pv.position, velTeme: pv.velocity,
      siteTeme: { x: s.x, y: s.y, z: s.z },
      siteVel: { x: s.vx, y: s.vy, z: s.vz },
      siteR: sR, topo: topo, rho: rho,
      raDeg: rd.raDeg, decDeg: rd.decDeg,
      ra0: pt.raDeg, dec0: pt.decDeg,
      sepDeg: sep(rd.raDeg, rd.decDeg, pt.raDeg, pt.decDeg),
      elSin: elSin, occluded: occluded,
    };
  }

  /** Is this sample inside the field? Circular fields are a plain separation test;
   *  rectangular ones are imposed in the ROTATED CHART FRAME, because that is what
   *  the user's camera actually is. Projection and orientation stay separate
   *  (frames.js tanProject, then rotDeg) so the geometry never depends on flipEW. */
  function insideField(P, sol) {
    // Limb occlusion is part of field membership, so entry/exit bisection resolves
    // a target RISING FROM BEHIND THE EARTH the same way it resolves a field edge.
    if (sol.occluded) return false;
    if (P.minElDeg > 0 && sol.elSin < P.sinMinEl) return false;
    if (P.shape === 'circ') return sol.sepDeg <= P.fovRadiusDeg;
    const p = tanProject(sol.raDeg, sol.decDeg, sol.ra0, sol.dec0);
    if (!p) return false;
    const r = P.rotDeg * D2R, cr = Math.cos(r), sr = Math.sin(r);
    // rotDeg is the position angle of chart +Y, N through E: a point at that PA
    // must land on the +Y axis, which fixes these signs.
    const X = p.xi * cr - p.eta * sr;
    const Y = p.xi * sr + p.eta * cr;
    return Math.abs(X) <= P.halfW && Math.abs(Y) <= P.halfH;
  }

  /** Refine one object's candidate windows into Crossings.
   *
   *  Photometry is deliberately NOT done here: magEst/streak need SAT.photo, which
   *  lives on the main thread and would otherwise become a third copy of the same
   *  maths. The worker returns the geometry photometry needs (rangeKm, phaseDeg,
   *  shadow) and scan.js fills the rest in for the handful of crossings. */
  function refine(P, k, idx, tsince0Min, ageD, slopKmVal, wins, out) {
    const rec = recs[idx];
    const obj = objs[idx];
    const fineMs = P.fineStepS * 1000;
    const tsinceOf = (tMs) => tsince0Min + (tMs - P.t0Ms) / 60000;
    const at = (tMs) => solveAt(P, rec, tsinceOf(tMs), tMs);

    // merge overlapping windows, then clamp to the scan span
    const merged = [];
    wins.slice().sort((a, b) => a[0] - b[0]).forEach((w) => {
      const a = Math.max(P.t0Ms, w[0]), b = Math.min(P.t1Ms, w[1]);
      if (b <= a) return;
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    });

    for (let wi = 0; wi < merged.length; wi++) {
      const wa = merged[wi][0], wb = merged[wi][1];
      const nS = Math.min(FINE_SAMPLE_CAP, Math.max(1, Math.ceil((wb - wa) / fineMs)));
      const dtMs = (wb - wa) / nS;
      const samples = [];
      for (let i = 0; i <= nS; i++) {
        const t = Math.min(wb, wa + i * dtMs);
        const sol = at(t);
        samples.push(sol ? { t: t, sol: sol, in: insideField(P, sol) } : { t: t, sol: null, in: false });
      }

      // contiguous in-field runs
      let i = 0;
      while (i <= nS) {
        if (!samples[i].in) { i++; continue; }
        let a = i;
        while (i + 1 <= nS && samples[i + 1].in) i++;
        const b = i;
        i++;

        // Bisect the boundary to 50 ms against the SAME insideField predicate that
        // produced the samples, so entry/exit and membership can never disagree.
        const bisect = (tOut, tIn) => {
          for (let it = 0; it < 40 && Math.abs(tIn - tOut) > 50; it++) {
            const mid = (tIn + tOut) / 2;
            const sol = at(mid);
            if (sol && insideField(P, sol)) tIn = mid; else tOut = mid;
          }
          return Math.round(tIn);
        };
        let tEnter = samples[a].t, tExit = samples[b].t;
        if (a > 0) tEnter = bisect(samples[a - 1].t, samples[a].t);
        if (b < nS) tExit = bisect(samples[b + 1].t, samples[b].t);

        // Closest approach by parabolic fit on the separation minimum.
        let bi = a;
        for (let q = a; q <= b; q++) if (samples[q].sol.sepDeg < samples[bi].sol.sepDeg) bi = q;
        let tCa = samples[bi].t;
        if (bi > a && bi < b) {
          const y0 = samples[bi - 1].sol.sepDeg, y1 = samples[bi].sol.sepDeg,
            y2 = samples[bi + 1].sol.sepDeg;
          const den = y0 - 2 * y1 + y2;
          if (den > 0) {
            const dt = 0.5 * (y0 - y2) / den;               // in units of the fine step
            if (dt > -1 && dt < 1) tCa = samples[bi].t + dt * dtMs;
          }
        }
        // Round BEFORE the final solve: the crossing reports integer-ms tCaMs, and
        // solving at the unrounded instant leaves the reported RA/Dec up to ~2"
        // ahead of its own timestamp on a fast overhead pass (2000"/s x 0.5 ms).
        tCa = Math.round(Math.max(tEnter, Math.min(tExit, tCa)));

        const ca = at(tCa);
        if (!ca) continue;

        // TWO angular rates, because which one streaks the exposure depends on how
        // the instrument was tracking, and they can differ by everything:
        //
        //   sky   — d(RA,Dec)/dt, motion against the STARS: the streak on a
        //           sidereally-guided exposure. A geostationary satellite is NOT
        //           stationary here — it co-rotates with the Earth and so drifts
        //           through the star field at very nearly the sidereal rate, ~15"/s.
        //   mount — motion against the observer's OWN frame: the horizon for a
        //           parked ground mount (omega_E z), the LVLH frame for a staring
        //           orbital sensor (Omega = r x v / |r|^2) — CONTRACT v0.2 gate 2.
        //
        // Subtracting omega x rho converts the inertial rate into the rotating frame.
        // The cross product is formed in TEME and only then rotated to J2000, because
        // the north/east basis the position angles are measured in lives in J2000.
        // This is a frame change on vectors we already have, not a new propagation.
        const siteVel = ca.siteVel;
        const rhoDot = {
          x: ca.velTeme.x - siteVel.x,
          y: ca.velTeme.y - siteVel.y,
          z: ca.velTeme.z - siteVel.z,
        };
        const rangeRateKmS =
          (ca.topo.x * rhoDot.x + ca.topo.y * rhoDot.y + ca.topo.z * rhoDot.z) / ca.rho;
        const rhoJ = temeToJ2000(ca.topo, ca.date);
        const rhoDotJ = temeToJ2000(rhoDot, ca.date);
        let frameOm;                     // the observer frame's rotation, TEME rad/s
        if (P.obsKind === 'orbit') {
          const st = ca.siteTeme, sv = ca.siteVel;
          const r2o = st.x * st.x + st.y * st.y + st.z * st.z;
          frameOm = {
            x: (st.y * sv.z - st.z * sv.y) / r2o,
            y: (st.z * sv.x - st.x * sv.z) / r2o,
            z: (st.x * sv.y - st.y * sv.x) / r2o,
          };
        } else {
          frameOm = { x: 0, y: 0, z: OMEGA_E };
        }
        const omegaCrossRho = temeToJ2000({
          x: frameOm.y * ca.topo.z - frameOm.z * ca.topo.y,
          y: frameOm.z * ca.topo.x - frameOm.x * ca.topo.z,
          z: frameOm.x * ca.topo.y - frameOm.y * ca.topo.x,
        }, ca.date);
        const sky = skyRate(rhoJ, rhoDotJ, ca.rho);
        const mount = skyRate(rhoJ, {
          x: rhoDotJ.x - omegaCrossRho.x,
          y: rhoDotJ.y - omegaCrossRho.y,
          z: rhoDotJ.z - omegaCrossRho.z,
        }, ca.rho);
        const rateAsPerS = sky.rate, paDeg = sky.pa;

        const sun = sunTemeKm(ca.date);
        const sh = shadowState(ca.satTeme, sun);

        // phase angle: Sun - satellite - observer
        const s2o = {
          x: ca.siteTeme.x - ca.satTeme.x, y: ca.siteTeme.y - ca.satTeme.y,
          z: ca.siteTeme.z - ca.satTeme.z,
        };
        const s2s = { x: sun.x - ca.satTeme.x, y: sun.y - ca.satTeme.y, z: sun.z - ca.satTeme.z };
        const n1 = Math.sqrt(s2o.x * s2o.x + s2o.y * s2o.y + s2o.z * s2o.z);
        const n2 = Math.sqrt(s2s.x * s2s.x + s2s.y * s2s.y + s2s.z * s2s.z);
        const phaseDeg = Math.acos(Math.max(-1, Math.min(1,
          (s2o.x * s2s.x + s2o.y * s2s.y + s2o.z * s2s.z) / (n1 * n2)))) * R2D;

        // Sun's height above the observer's LOCAL HORIZONTAL — twilight on the
        // ground, the observer's own day/night state in orbit (CONTRACT v0.2
        // gate 3). Same formula either way; only the radius is per-epoch now.
        const sunHatDot = (sun.x * ca.siteTeme.x + sun.y * ca.siteTeme.y + sun.z * ca.siteTeme.z)
          / (Math.sqrt(sun.x * sun.x + sun.y * sun.y + sun.z * sun.z) * ca.siteR);
        const sunElDeg = 90 - Math.acos(Math.max(-1, Math.min(1, sunHatDot))) * R2D;

        // azDeg/elDeg are alt/az on the ground, LVLH angles in orbit (gate 4).
        let aa;
        if (P.obsKind === 'orbit') {
          const basis = lvlhBasis(ca.siteTeme, ca.siteVel);
          aa = basis ? vecToLvlh(ca.topo, basis) : { azDeg: 0, elDeg: 90 };
        } else {
          aa = raDecToAltAz(ca.raDeg, ca.decDeg, P.site, ca.date,
            { refract: !!P.pointing.refract, dut1S: P.dut1S });
        }

        // At most P.pathMaxSamples path samples spanning tEnter..tExit, for the
        // chart polyline. Occultation pass discovery may lower this transfer cap.
        const nP = Math.max(2, Math.min(P.pathMaxSamples,
          Math.ceil((tExit - tEnter) / fineMs) + 1));
        const path = [];
        for (let q = 0; q < nP; q++) {
          const t = tEnter + (tExit - tEnter) * (nP === 1 ? 0 : q / (nP - 1));
          const sol = at(t);
          if (sol) path.push({ t: Math.round(t), raDeg: sol.raDeg, decDeg: sol.decDeg });
        }

        out.push({
          satId: obj.id, norad: obj.norad, name: obj.name, intl: obj.intl,
          type: obj.type,
          tEnterMs: tEnter, tExitMs: tExit, tCaMs: Math.round(tCa),
          sepCaDeg: ca.sepDeg,
          raDeg: ca.raDeg, decDeg: ca.decDeg,
          azDeg: aa.azDeg, elDeg: aa.elDeg,
          rangeKm: ca.rho, rangeRateKmS: rangeRateKmS,
          rateAsPerS: rateAsPerS, paDeg: paDeg,
          rateMountAsPerS: mount.rate, paMountDeg: mount.pa,
          phaseDeg: phaseDeg, shadow: sh.state, sunFrac: sh.frac,
          cls: classOf(rec), sunElDeg: sunElDeg,
          // surfaced so the UI never presents a match found only inside the TLE
          // slop as a confident identification (CONTRACT.md, stage 2)
          tleAgeDays: ageD, tleSlopDeg: Math.min(TLE_SLOP_MAX_RAD, slopKmVal / ca.rho) * R2D,
          rcs: obj.rcs, stdMag: obj.stdMag,
          path: path,
        });
      }
    }
  }

  /* ---- worker message plumbing (skipped under node) ------------------------ */

  const core = {
    loadObjs: loadObjs, runScan: runScan, stage1: stage1, prepare: prepare,
    cancel: () => { cancelled = true; },
    count: () => objs.length,
  };

  if (typeof self !== 'undefined' && self.postMessage) {
    self.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.cmd === 'load') {
        const r = loadObjs(msg.objs || []);
        self.postMessage({ type: 'loaded', count: r.count, bad: r.bad });
      } else if (msg.cmd === 'scan') {
        // prepare() throws SYNCHRONOUSLY for an unpropagatable observer TLE
        // (CONTRACT v0.2) — that must become an 'error' message, not an uncaught
        // exception that surfaces as a generic worker crash.
        let job = null;
        try {
          job = runScan(msg.params, (p) => self.postMessage({
            type: 'progress', done: p.done, total: p.total, phase: p.phase,
          }));
        } catch (err) {
          self.postMessage({ type: 'error', error: String(err && err.message || err) });
        }
        if (job) job.then((res) => {
          self.postMessage({
            type: 'result', crossings: res.crossings, culled: res.culled,
            propagations: res.propagations, ms: res.ms,
          });
        }).catch((err) => {
          if (err && err.message === 'cancelled') {
            self.postMessage({ type: 'result', cancelled: true, crossings: [], culled: null });
          } else {
            self.postMessage({ type: 'error', error: String(err && err.message || err) });
          }
        });
      } else if (msg.cmd === 'cancel') {
        cancelled = true;
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})();
