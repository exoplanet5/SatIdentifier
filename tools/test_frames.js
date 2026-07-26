/* Verification for app/js/frames.js — the three tests CONTRACT.md mandates.
 * Run: node tools/test_frames.js
 *
 * The cross-check (test 2) is the load-bearing one: it compares alt/az computed
 * through frames.js against satellite.js's long-tested TEME->ECEF->lookAngles path.
 * A sign error in the equation of the equinoxes, nutation or precession, a units
 * slip, or a GMST/GAST mix-up all show up here, with no external data needed.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');
global.window = global;
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
require(path.join(APP, 'frames.js'));
const F = SAT.frames;

let failures = 0;
function check(name, got, want, tol, unit) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${got.toExponential(3)} vs ${want.toExponential(3)} ${unit || ''} (tol ${tol.toExponential(1)})`);
}

const DATES = [
  new Date('2026-07-21T03:14:15Z'),
  new Date('2026-01-01T00:00:00Z'),
  new Date('2020-06-15T18:30:00Z'),
  new Date('2000-01-01T12:00:00Z'),
];

// ---------------------------------------------------------------- test 1
console.log('\n[1] round trip: j2000ToTeme(temeToJ2000(v)) === v');
{
  let worst = 0;
  for (const d of DATES) {
    for (const v of [{ x: 1234.5, y: -6789.0, z: 3456.7 },
                     { x: -42164, y: 0, z: 0 },
                     { x: 0, y: 0, z: 7000 }]) {
      const back = F.j2000ToTeme(F.temeToJ2000(v, d), d);
      const n = Math.hypot(v.x, v.y, v.z);
      worst = Math.max(worst, Math.hypot(back.x - v.x, back.y - v.y, back.z - v.z) / n);
    }
  }
  check('worst relative round-trip error', worst, 0, 1e-12, '');
}

// ---------------------------------------------------------------- test 2
console.log('\n[2] cross-check alt/az: frames.js vs satellite.js ECEF path');
{
  // Real TLEs spanning LEO, a Molniya-type HEO and GEO, so the deep-space SDP4
  // path is exercised as well as SGP4.
  const TLES = [
    ['ISS (LEO)',
     '1 25544U 98067A   26201.51782528  .00016717  00000+0  10270-3 0  9994',
     '2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345'],
    ['MOLNIYA (HEO)',
     '1 25485U 98054A   26201.32871319 -.00000201  00000+0  00000+0 0  9995',
     '2 25485  63.1913 191.6259 7215842 264.9061  17.5324  2.00612736 12345'],
    ['GOES (GEO)',
     '1 29155U 06018A   26201.45833333 -.00000118  00000+0  00000+0 0  9992',
     '2 29155   0.4907  92.1740 0004215 173.4372 186.5901  1.00271135 12345'],
  ];
  const sites = [
    { name: 'mid-lat north', latDeg: 40.0, lonDeg: 116.4, altM: 50 },
    { name: 'equator',       latDeg: 0.0,  lonDeg: -78.5, altM: 2800 },
    { name: 'high south',    latDeg: -67.6, lonDeg: 62.9, altM: 20 },
    { name: 'below sea',     latDeg: 31.5, lonDeg: 35.5, altM: -400 },
  ];
  let worstEl = 0, worstAz = 0, n = 0;
  for (const [, l1, l2] of TLES) {
  const rec = satellite.twoline2satrec(l1, l2);
  for (const site of sites) {
    for (let k = 0; k < 288; k++) {          // every 5 min over a day
      const d = new Date(Date.UTC(2026, 6, 21, 0, 5 * k, 0));
      const pv = satellite.propagate(rec, d);
      if (!pv || !pv.position) continue;

      // path A — the well-tested one SatObserver has always used
      const gmst = satellite.gstime(d);
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const la = satellite.ecfToLookAngles(
        { latitude: site.latDeg * F.D2R, longitude: site.lonDeg * F.D2R, height: site.altM / 1000 },
        ecf);
      if (la.elevation * F.R2D < 5) continue;   // grazing geometry amplifies everything

      // path B — through frames.js: TEME -> J2000 -> back to alt/az
      const topo = F.topoTeme(site, pv.position, d);
      const rd = F.vecToRaDec(F.temeToJ2000(topo, d));
      const aa = F.raDecToAltAz(rd.raDeg, rd.decDeg, site, d, { refract: false });

      let dAz = ((aa.azDeg - la.azimuth * F.R2D + 540) % 360) - 180;
      dAz *= Math.cos(aa.elDeg * F.D2R);        // great-circle, not raw azimuth
      worstAz = Math.max(worstAz, Math.abs(dAz) * 3600);
      worstEl = Math.max(worstEl, Math.abs(aa.elDeg - la.elevation * F.R2D) * 3600);
      n++;
    }
  }
  }
  console.log(`  (${n} above-horizon samples, ${TLES.length} orbits x ${sites.length} sites)`);
  check('worst elevation difference', worstEl, 0, 0.1, 'arcsec');
  check('worst azimuth difference (great-circle)', worstAz, 0, 0.1, 'arcsec');
}

// ---------------------------------------------------------------- test 3
console.log('\n[3] absolute sanity');
{
  // Precession of the J2000 vernal equinox to 2026.55 should be ~0.363 deg.
  const d = new Date('2026-07-21T00:00:00Z');
  const eq = { x: 1, y: 0, z: 0 };
  const mod = F.apply(F.precessionMatrix(d), eq);
  const moved = Math.acos(Math.max(-1, Math.min(1, mod.x))) * F.R2D;
  const T = F.tCen(d);
  // The J2000 equinox and the mean equinox of date are separated by the general
  // precession p = 5029.0966"/cy. At 2026.55 that is 26.55 yr x 50.29"/yr = 0.3709 deg
  // -- NOT 0.363, which is the 26.0 yr figure and was this test's original error.
  check('vernal equinox precession', moved, 0.37095, 0.002, 'deg');
  check('implied general precession', moved * 3600 / T, 5029.0966, 3.0, 'arcsec/cy');

  // Nutation in longitude stays inside its ~+-19" envelope. The equation of the
  // equinoxes is dPsi*cos(eps): amplitude ~1.1 SECONDS OF TIME, which is ~16
  // ARCSEC -- the units trap this test was originally written into.
  let maxPsi = 0, maxEq = 0;
  for (let i = 0; i < 400; i++) {
    const dd = new Date(Date.UTC(2010, 0, 1) + i * 18 * 86400000);
    const nu = F.nutation(dd);
    maxPsi = Math.max(maxPsi, Math.abs(nu.dPsiRad) * F.R2D * 3600);
    maxEq = Math.max(maxEq, Math.abs(nu.eqEqRad) * F.R2D * 3600);
  }
  check('max |nutation in longitude| over 20 yr', maxPsi, 17.5, 3.0, 'arcsec');
  check('max |equation of equinoxes| over 20 yr', maxEq, 16.0, 3.0, 'arcsec');
  check('  ... same, expressed in seconds of time', maxEq / 15, 1.07, 0.2, 's');

  // Mean obliquity at J2000 = 23 deg 26' 21.448".
  const e0 = F.nutation(new Date('2000-01-01T12:00:00Z')).epsARad * F.R2D;
  check('mean obliquity at J2000', e0, 23.4392911, 1e-5, 'deg');

  // Refraction: the textbook values.
  check('refraction at El 90', F.refractionDeg(90), 0.0, 0.002, 'deg');
  check('refraction at El 30 (arcmin)', F.refractionDeg(30) * 60, 1.7, 0.15, 'arcmin');
  check('refraction at El 10 (arcmin)', F.refractionDeg(10) * 60, 5.3, 0.4, 'arcmin');
  const elA = 20 + F.refractionDeg(20);
  check('refraction round trip at El 20', elA - F.refractionInvDeg(elA), 20, 0.01, 'deg');

  // Gnomonic projection round trip, including a point far off axis.
  let worst = 0;
  for (const [ra, dec] of [[83.8, -5.4], [84.9, -4.1], [10.0, 89.0], [359.9, -0.1]]) {
    const p = F.tanProject(ra, dec, 83.822, -5.391);
    if (!p) continue;
    const b = F.tanDeproject(p.xi, p.eta, 83.822, -5.391);
    worst = Math.max(worst, F.sep(ra, dec, b.raDeg, b.decDeg) * 3600);
  }
  check('gnomonic round trip', worst, 0, 1e-6, 'arcsec');

  // Separation and position angle on known geometry.
  check('sep of 1 deg in dec', F.sep(100, 10, 100, 11), 1.0, 1e-9, 'deg');
  check('PA due north', F.posAngle(100, 10, 100, 11), 0.0, 1e-6, 'deg');
  check('PA due east', F.posAngle(100, 0, 101, 0), 90.0, 1e-6, 'deg');

  // Site geometry: geocentric radius at the pole and the equator.
  const eqR = F.siteEcefKm({ latDeg: 0, lonDeg: 0, altM: 0 });
  const poR = F.siteEcefKm({ latDeg: 90, lonDeg: 0, altM: 0 });
  check('WGS-84 equatorial radius', eqR.x, 6378.137, 1e-6, 'km');
  check('WGS-84 polar radius', poR.z, 6356.752, 1e-3, 'km');

  // Alt/az round trip through RA/Dec.
  const site = { latDeg: 40, lonDeg: 116.4, altM: 50 };
  const dd = new Date('2026-07-21T15:00:00Z');
  const rd = F.altAzToRaDec(123.4, 47.6, site, dd, { refract: true });
  const aa = F.raDecToAltAz(rd.raDeg, rd.decDeg, site, dd, { refract: true });
  check('alt/az round trip: az', aa.azDeg, 123.4, 1e-6, 'deg');
  check('alt/az round trip: el', aa.elDeg, 47.6, 1e-6, 'deg');
}

// ---------------------------------------------------------------- test 4
console.log('\n[4] LVLH frame (orbital observing stations)');
{
  // Equatorial prograde circular orbit: every axis is known by inspection.
  // r = +x, v = +y  =>  R (zenith) = x, W (orbit normal, r x v) = z,
  // S (along-track) = W x R = y.
  const b = F.lvlhBasis({ x: 7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 });
  check('R is radial (x)', b.R.x, 1, 1e-12, '');
  check('W is the orbit normal (z)', b.W.z, 1, 1e-12, '');
  check('S is along-track (y)', b.S.y, 1, 1e-12, '');

  // The named pointings land on the named axes.
  const along = F.lvlhToVec(0, 0, b);
  const normal = F.lvlhToVec(90, 0, b);
  const zenith = F.lvlhToVec(0, 90, b);
  const nadir = F.lvlhToVec(123, -90, b);        // az must not matter at the pole
  check('az 0 el 0 -> along-track', along.y, 1, 1e-12, '');
  check('az 90 el 0 -> orbit normal', normal.z, 1, 1e-12, '');
  check('el +90 -> zenith', zenith.x, 1, 1e-12, '');
  check('el -90 -> nadir (any az)', nadir.x, -1, 1e-12, '');

  // Orthonormality and az/el round trip on messy, inclined, eccentric PVs.
  let worstOrtho = 0, worstRt = 0;
  const pvs = [
    [{ x: 4102, y: -4577, z: 2957 }, { x: 5.1, y: 2.2, z: -3.7 }],
    [{ x: -26550, y: 33200, z: 40 }, { x: -2.4, y: -1.9, z: 0.1 }],
    [{ x: 1200, y: 6900, z: -3300 }, { x: -7.2, y: 1.1, z: -0.4 }],
  ];
  for (const [r, v] of pvs) {
    const bb = F.lvlhBasis(r, v);
    const dots = [
      bb.R.x * bb.S.x + bb.R.y * bb.S.y + bb.R.z * bb.S.z,
      bb.R.x * bb.W.x + bb.R.y * bb.W.y + bb.R.z * bb.W.z,
      bb.S.x * bb.W.x + bb.S.y * bb.W.y + bb.S.z * bb.W.z,
      Math.hypot(bb.R.x, bb.R.y, bb.R.z) - 1,
      Math.hypot(bb.S.x, bb.S.y, bb.S.z) - 1,
      Math.hypot(bb.W.x, bb.W.y, bb.W.z) - 1,
    ];
    worstOrtho = Math.max(worstOrtho, ...dots.map(Math.abs));
    for (const [az, el] of [[0, 0], [37.2, 12.8], [180, -45], [271.5, 88], [359.9, -88]]) {
      const back = F.vecToLvlh(F.lvlhToVec(az, el, bb), bb);
      let dAz = ((back.azDeg - az + 540) % 360) - 180;
      dAz *= Math.cos(el * Math.PI / 180);
      worstRt = Math.max(worstRt, Math.abs(dAz), Math.abs(back.elDeg - el));
    }
  }
  check('basis orthonormality (worst dot / norm error)', worstOrtho, 0, 1e-12, '');
  check('az/el round trip through the basis', worstRt, 0, 1e-9, 'deg');

  // Degenerate PV refuses rather than poisons.
  const bad = F.lvlhBasis({ x: 7000, y: 0, z: 0 }, { x: 7.5, y: 0, z: 0 });
  check('r parallel to v yields null, not NaNs', bad === null ? 0 : 1, 0, 0, '');
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
