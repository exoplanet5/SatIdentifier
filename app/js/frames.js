/* SAT.frames — coordinate frames, precession/nutation, refraction, projection.
 *
 * SatObserver never needed this: it only ever wanted alt/az and sub-points, so
 * satellite.js's TEME->ECEF path sufficed. This tool reports RA/Dec against a star
 * field, where TEME-is-not-J2000 is a 0.36 deg error in 2026 — twenty times a
 * telescope field. Everything here exists to make that error go away.
 *
 * Pure functions, no module state except the memo caches (all keyed on time).
 * Read the "Precession" section of CONTRACT.md before editing.
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const AS2R = (Math.PI / 180) / 3600;      // arcseconds -> radians
  const J2000 = 2451545.0;

  const RE_EQ = 6378.137;                   // WGS-84 semi-major axis, km
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);

  // ---- time scales ---------------------------------------------------------

  // TAI-UTC. Only the TLE era matters here; before the first entry we clamp to 32 s
  // and after the last we hold at 37 s. A missed future leap second costs 1 s of
  // GMST = 15", which is dwarfed by the DUT1 we already ignore (see CONTRACT.md).
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

  /** Julian Date in TT = TAI + 32.184 s. Argument for precession and nutation. */
  function jdTT(date) { return jdUTC(date) + (taiMinusUtc(date) + 32.184) / 86400; }

  /** Julian centuries TT from J2000. */
  function tCen(date) { return (jdTT(date) - J2000) / 36525; }

  /** GMST in radians.
   *
   * Delegates to satellite.js so that this module and SAT.prop cannot disagree
   * about the TEME<->ECEF rotation: SGP4's TEME frame is defined against exactly
   * this GMST, and the whole cross-check test below rests on the two paths sharing
   * it. Do not substitute an "improved" GMST here.
   *
   * Takes UT1 in principle; we pass UTC plus the optional dut1S offset. With
   * dut1S = 0 the error is <= 0.9 s = 13.5" of Earth rotation (CONTRACT.md budget).
   */
  function gmstRad(date, dut1S) {
    const d = dut1S ? new Date(date.getTime() + dut1S * 1000) : date;
    return satellite.gstime(d);
  }

  // ---- nutation (IAU 1980, 20 largest terms, residual < 0.05") --------------
  // Columns: l, l', F, D, Om, dPsi (0.1 mas), dPsi*T, dEps (0.1 mas), dEps*T
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

  /** IAU-1980 nutation. Returns {dPsiRad, dEpsRad, epsARad (mean obliquity),
   *  epsRad (true obliquity), eqEqRad (equation of the equinoxes)}. */
  function nutation(date) {
    const T = tCen(date);
    if (T === nutCache.t) return nutCache.v;
    const T2 = T * T, T3 = T2 * T;

    // Delaunay arguments, degrees (IAU 1980); 1r = 360 deg
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
    dPsi *= 1e-4 * AS2R;        // table is in 0.1 mas = 1e-4 arcsec
    dEps *= 1e-4 * AS2R;

    // mean obliquity, IAU 1980
    const epsA = (84381.448 - 46.8150 * T - 0.00059 * T2 + 0.001813 * T3) * AS2R;
    const v = {
      dPsiRad: dPsi, dEpsRad: dEps, epsARad: epsA, epsRad: epsA + dEps,
      eqEqRad: dPsi * Math.cos(epsA),
    };
    nutCache = { t: T, v: v };
    return v;
  }

  // ---- matrices ------------------------------------------------------------
  // Row-major 9-element arrays. apply(M, v) computes M . v.

  function apply(M, v) {
    return {
      x: M[0] * v.x + M[1] * v.y + M[2] * v.z,
      y: M[3] * v.x + M[4] * v.y + M[5] * v.z,
      z: M[6] * v.x + M[7] * v.y + M[8] * v.z,
    };
  }

  /** Transpose = inverse, for the orthonormal matrices used here. */
  function applyT(M, v) {
    return {
      x: M[0] * v.x + M[3] * v.y + M[6] * v.z,
      y: M[1] * v.x + M[4] * v.y + M[7] * v.z,
      z: M[2] * v.x + M[5] * v.y + M[8] * v.z,
    };
  }

  let precCache = { t: NaN, m: null };

  /** IAU-1976 equatorial precession, J2000 -> mean equator/equinox of date.
   *
   * This is the ONLY precession primitive; every other direction is its transpose
   * (applyT). Do not add a general "t1 to t2" variant: those cubic polynomials are
   * not self-inverse, so precessing forward then back would not return the original
   * vector — the exact reason Bill Gray restructured lunar/precess.cpp around a
   * J2000-anchored matrix. Matrix elements transcribed from his
   * setup_equatorial_precession_from_j2000().
   *
   * Equatorial rather than ecliptic form is deliberate. The ecliptic form is more
   * stable over millennia (the equatorial cubic terms are ~600x larger and diverge),
   * but for near-term epochs the equatorial form is preferred, and the two differ by
   * about a nanoradian per 3 years from J2000 — some 2 milliarcsec in 2026. This is
   * not a bug; do not "upgrade" it.
   */
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

  /** Nutation matrix, mean of date (MOD) -> true of date (TOD).
   *  N = R1(-eps) . R3(-dPsi) . R1(epsA) */
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

  /** TEME of date -> J2000 mean equinox.
   *
   * Chain: TEME --R3(-eqEq)--> TOD --N^T--> MOD --P^T--> J2000.
   *
   * The sign of the equation-of-equinoxes step is fixed by the requirement that
   * TEME->PEF uses GMST (the SGP4 convention satellite.js implements) while
   * TOD->PEF uses GAST = GMST + eqEq. Setting R3(GMST).v_TEME = R3(GAST).v_TOD
   * gives v_TOD = R3(-eqEq).v_TEME. The alt/az cross-check test verifies it.
   */
  function temeToJ2000(v, date) {
    const tod = rot3(v, -nutation(date).eqEqRad);
    const mod = applyT(nutationMatrix(date), tod);
    return applyT(precessionMatrix(date), mod);
  }

  /** J2000 mean equinox -> TEME of date. Exact inverse of temeToJ2000. */
  function j2000ToTeme(v, date) {
    const mod = apply(precessionMatrix(date), v);
    const tod = apply(nutationMatrix(date), mod);
    return rot3(tod, nutation(date).eqEqRad);
  }

  /** J2000 -> true equator and equinox of date (TOD). */
  function j2000ToTod(v, date) {
    return apply(nutationMatrix(date), apply(precessionMatrix(date), v));
  }

  /** TOD -> J2000. */
  function todToJ2000(v, date) {
    return applyT(precessionMatrix(date), applyT(nutationMatrix(date), v));
  }

  // ---- site geometry -------------------------------------------------------

  /** WGS-84 geodetic -> Earth-fixed (ECEF) km. loc = {latDeg, lonDeg, altM}. */
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

  /** Site position in TEME km. v_TEME = R3(-gmst) . v_ECEF. */
  function siteTemeKm(loc, date, dut1S) {
    const e = siteEcefKm(loc);
    const g = gmstRad(date, dut1S);
    const c = Math.cos(g), s = Math.sin(g);
    return { x: e.x * c - e.y * s, y: e.x * s + e.y * c, z: e.z };
  }

  /** Topocentric vector (satellite minus site) in TEME km. */
  function topoTeme(loc, satTemeKm, date, dut1S) {
    const s = siteTemeKm(loc, date, dut1S);
    return { x: satTemeKm.x - s.x, y: satTemeKm.y - s.y, z: satTemeKm.z - s.z };
  }

  // ---- spherical helpers ---------------------------------------------------

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

  /** Great-circle separation in degrees. Vincenty form: stable both at very small
   *  separations (where the cosine formula loses precision) and near 180 deg. */
  function sep(ra1, dec1, ra2, dec2) {
    const d1 = dec1 * D2R, d2 = dec2 * D2R, dA = (ra2 - ra1) * D2R;
    const s1 = Math.sin(d1), c1 = Math.cos(d1);
    const s2 = Math.sin(d2), c2 = Math.cos(d2);
    const sdA = Math.sin(dA), cdA = Math.cos(dA);
    const a = c2 * sdA, b = c1 * s2 - s1 * c2 * cdA;
    return Math.atan2(Math.sqrt(a * a + b * b), s1 * s2 + c1 * c2 * cdA) * R2D;
  }

  /** Position angle of point 2 as seen from point 1, degrees north through east. */
  function posAngle(ra1, dec1, ra2, dec2) {
    const d1 = dec1 * D2R, d2 = dec2 * D2R, dA = (ra2 - ra1) * D2R;
    const p = Math.atan2(Math.sin(dA) * Math.cos(d2),
      Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dA)) * R2D;
    return (p + 360) % 360;
  }

  // ---- refraction ----------------------------------------------------------

  /** Refraction in degrees to ADD to a geometric (true) elevation to get the
   *  apparent one. Saemundsson's formula, scaled for pressure and temperature.
   *  Returns 0 below -1 deg, where the formula is meaningless anyway.
   *
   *  Clamped at zero: the formula goes very slightly negative near the zenith
   *  (-0.12" at El 90), and refraction never is. */
  function refractionDeg(elDeg, opts) {
    if (elDeg < -1) return 0;
    const o = opts || {};
    const P = o.pressureMb == null ? 1010 : o.pressureMb;
    const T = o.tempC == null ? 10 : o.tempC;
    const r = 1.02 / Math.tan((elDeg + 10.3 / (elDeg + 5.11)) * D2R);   // arcmin
    return Math.max(0, (r / 60) * (P / 1010) * (283 / (273 + T)));
  }

  /** Inverse: refraction in degrees to SUBTRACT from an apparent elevation to get
   *  the geometric one.
   *
   *  Solved by fixed-point iteration on refractionDeg rather than by Bennett's
   *  formula, which is the traditional apparent->true companion but is NOT the
   *  exact inverse of Saemundsson — the two disagree by a fraction of an arcsec.
   *  Exactness matters here: the Pointing window converts RA/Dec <-> Alt/Az on
   *  every mode switch, and a non-invertible pair would walk the pointing a little
   *  further each time the user toggled.
   *
   *  The iteration contracts at |d(refraction)/d(elevation)|, which is ~0 at the
   *  zenith but reaches ~0.12 per step near the horizon (refraction runs 29' at
   *  El 0 against 22' at El 1). A fixed three or four passes therefore converges
   *  instantly high up and leaves ~0.1" on the horizon — small, but it is the kind
   *  of thing that gets quoted as "exact" and then is not. So iterate to an actual
   *  convergence test instead. This is never in the scan's hot loop (the cull is
   *  pure geometry); it runs per UI conversion and per confirmed crossing, where a
   *  handful of extra tan() calls cost nothing.
   */
  function refractionInvDeg(elAppDeg, opts) {
    if (elAppDeg < -1) return 0;
    let el = elAppDeg - refractionDeg(elAppDeg, opts);
    for (let i = 0; i < 24; i++) {
      const next = elAppDeg - refractionDeg(el, opts);
      if (Math.abs(next - el) < 1e-13) { el = next; break; }
      el = next;
    }
    return elAppDeg - el;
  }

  // ---- RA/Dec <-> Alt/Az ---------------------------------------------------

  /** Local apparent sidereal time in radians (GAST + east longitude). */
  function lastRad(loc, date, dut1S) {
    return gmstRad(date, dut1S) + nutation(date).eqEqRad + loc.lonDeg * D2R;
  }

  /** J2000 RA/Dec -> alt/az. opts: {refract, dut1S, tempC, pressureMb}.
   *  With refract:true the returned elevation is apparent (what a telescope points
   *  at); with refract:false it is geometric. */
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

  /** Alt/az -> J2000 RA/Dec. With refract:true the given elevation is treated as
   *  apparent and de-refracted first. */
  function altAzToRaDec(azDeg, elDeg, loc, date, opts) {
    const o = opts || {};
    let el = elDeg;
    if (o.refract) el -= refractionInvDeg(el, o);
    const a = azDeg * D2R, e = el * D2R, phi = loc.latDeg * D2R;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const se = Math.sin(e), ce = Math.cos(e);
    // sin(dec) = sin(phi)sin(h) + cos(phi)cos(h)cos(A)
    // cos(dec)sin(H) = -cos(h)sin(A);  cos(dec)cos(H) = cos(phi)sin(h) - sin(phi)cos(h)cos(A)
    const dec = Math.asin(Math.max(-1, Math.min(1, sp * se + cp * ce * Math.cos(a))));
    const H = Math.atan2(-ce * Math.sin(a), se * cp - ce * sp * Math.cos(a));
    const ra = (lastRad(loc, date, o.dut1S) - H) * R2D;
    const j = todToJ2000(raDecToVec(((ra % 360) + 360) % 360, dec * R2D), date);
    const rd = vecToRaDec(j);
    return { raDeg: rd.raDeg, decDeg: rd.decDeg };
  }

  // ---- Sun and Moon --------------------------------------------------------

  /** Low-precision solar position (~0.01 deg), true equator and equinox of date. */
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

  function sunJ2000(date) {
    const s = sunTodRaDec(date);
    const rd = vecToRaDec(todToJ2000(raDecToVec(s.raDeg, s.decDeg), date));
    return { raDeg: rd.raDeg, decDeg: rd.decDeg, rAu: s.rAu };
  }

  /** Sun position in TEME km — for phase angle and the Earth-shadow test. */
  function sunTemeKm(date) {
    const s = sunTodRaDec(date);
    const v = raDecToVec(s.raDeg, s.decDeg);
    const r = s.rAu * 149597870.7;
    // TOD -> TEME is R3(+eqEq); at 0.01 deg solar accuracy this is cosmetic, but
    // keeping the frame honest costs one rotation per epoch.
    const t = rot3(v, nutation(date).eqEqRad);
    return { x: t.x * r, y: t.y * r, z: t.z * r };
  }

  /** Low-precision lunar position (~0.3 deg), J2000. Meeus ch. 47, leading terms. */
  function moonJ2000(date) {
    const T = tCen(date);
    const Lp = (218.316 + 481267.8813 * T) * D2R;
    const M = (357.529 + 35999.0503 * T) * D2R;
    const Mp = (134.963 + 477198.8676 * T) * D2R;
    const D = (297.850 + 445267.1115 * T) * D2R;
    const F = (93.272 + 483202.0175 * T) * D2R;
    const lam = Lp + (6.289 * Math.sin(Mp) + 1.274 * Math.sin(2 * D - Mp)
      + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * Mp)
      - 0.186 * Math.sin(M) - 0.114 * Math.sin(2 * F)) * D2R;
    const bet = (5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F)
      + 0.278 * Math.sin(Mp - F) + 0.173 * Math.sin(2 * D - F)) * D2R;
    const rKm = 385000.56 - 20905.355 * Math.cos(Mp) - 3699.111 * Math.cos(2 * D - Mp)
      - 2955.968 * Math.cos(2 * D) - 569.925 * Math.cos(2 * Mp);
    const eps = nutation(date).epsARad;
    const cb = Math.cos(bet), sb = Math.sin(bet);
    const cl = Math.cos(lam), sl = Math.sin(lam);
    const v = {
      x: cb * cl,
      y: cb * sl * Math.cos(eps) - sb * Math.sin(eps),
      z: cb * sl * Math.sin(eps) + sb * Math.cos(eps),
    };
    const rd = vecToRaDec(todToJ2000(v, date));
    return { raDeg: rd.raDeg, decDeg: rd.decDeg, rKm: rKm };
  }

  // ---- gnomonic (TAN) projection -------------------------------------------

  /** Standard coordinates in DEGREES about the tangent point (ra0, dec0);
   *  xi east, eta north. Null when the point is 90 deg or more away. */
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

  /** Inverse gnomonic. xi/eta in degrees. */
  function tanDeproject(xi, eta, ra0, dec0) {
    const x = xi * D2R, y = eta * D2R;
    const d0 = dec0 * D2R;
    const rho = Math.sqrt(x * x + y * y);
    if (rho < 1e-15) return { raDeg: ((ra0 % 360) + 360) % 360, decDeg: dec0 };
    const c = Math.atan(rho);
    const sc = Math.sin(c), cc = Math.cos(c);
    const dec = Math.asin(cc * Math.sin(d0) + y * sc * Math.cos(d0) / rho);
    const ra = ra0 * D2R + Math.atan2(x * sc,
      rho * Math.cos(d0) * cc - y * Math.sin(d0) * sc);
    return { raDeg: ((ra * R2D % 360) + 360) % 360, decDeg: dec * R2D };
  }

  SAT.frames = {
    D2R, R2D, RE_EQ,
    jdUTC, jdTT, tCen, taiMinusUtc, gmstRad, nutation,
    precessionMatrix, nutationMatrix, apply, applyT, rot3,
    temeToJ2000, j2000ToTeme, j2000ToTod, todToJ2000,
    siteEcefKm, siteTemeKm, topoTeme,
    vecToRaDec, raDecToVec, sep, posAngle,
    refractionDeg, refractionInvDeg, lastRad, raDecToAltAz, altAzToRaDec,
    sunJ2000, sunTemeKm, moonJ2000,
    tanProject, tanDeproject,
  };
})();
