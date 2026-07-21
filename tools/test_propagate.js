/* Verification for app/js/propagate.js — the topocentric solution.
 * Run: node tools/test_propagate.js
 *
 * The apparent-rate calculation is the part worth testing: it needs the observer's
 * own rotation velocity, and omitting that term is invisible for LEO (where the
 * orbital rate dominates) but catastrophic for GEO, whose whole defining property
 * is that it does NOT move. So GEO is the diagnostic case here.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');
global.window = global;
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
require(path.join(APP, 'util.js'));
require(path.join(APP, 'frames.js'));
require(path.join(APP, 'propagate.js'));
const F = SAT.frames, P = SAT.prop;

let failures = 0;
function check(name, got, want, tol, unit) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${Number(got).toPrecision(6)} vs ${want} ${unit || ''} (tol ${tol})`);
}
function ok(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

const mk = (name, l1, l2) => ({ id: 'o_' + name, name, l1, l2 });

const ISS = mk('ISS',
  '1 25544U 98067A   26201.51782528  .00016717  00000+0  10270-3 0  9994',
  '2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345');
const GEO = mk('GOES',
  '1 29155U 06018A   26201.45833333 -.00000118  00000+0  00000+0 0  9992',
  '2 29155   0.4907  92.1740 0004215 173.4372 186.5901  1.00271135 12345');
const MOL = mk('MOLNIYA',
  '1 25485U 98054A   26201.32871319 -.00000201  00000+0  00000+0 0  9995',
  '2 25485  63.1913 191.6259 7215842 264.9061  17.5324  2.00612736 12345');

const site = { latDeg: 40.0, lonDeg: 116.4, altM: 50 };

console.log('\n[1] orbit classification and element extraction');
{
  ok('ISS classified leo', P.classOf(ISS) === 'leo', P.classOf(ISS));
  ok('GOES classified geo', P.classOf(GEO) === 'geo', P.classOf(GEO));
  ok('Molniya classified heo', P.classOf(MOL) === 'heo', P.classOf(MOL));
  check('ISS period', P.periodMinutes(ISS), 92.9, 1.0, 'min');
  check('GEO period', P.periodMinutes(GEO), 1436, 5, 'min');
  const a = P.altitudes(ISS);
  check('ISS apogee height', a.apogeeKm, 420, 60, 'km');
  check('ISS inclination', a.incDeg, 51.6392, 1e-3, 'deg');
  const g = P.altitudes(GEO);
  check('GEO semi-major axis', g.aKm, 42164, 30, 'km');
}

console.log('\n[2] angular rate — sky frame vs mount frame');
{
  // A geostationary satellite is the diagnostic case, and it discriminates the two
  // rates completely. Against the STARS it drifts at very nearly the sidereal rate
  // (15.041"/s) because it co-rotates with the Earth — this is why GEO objects
  // streak on sidereally-guided exposures. Against the HORIZON it is a fixed dot.
  // Swapping the two, or dropping the observer's velocity term, breaks one or other
  // of these by ~15"/s.
  const usSite = { latDeg: 38.9, lonDeg: -77.0, altM: 100 };
  let maxSky = 0, minSky = 1e9, maxMount = 0, n = 0;
  for (let k = 0; k < 48; k++) {
    const d = new Date(Date.UTC(2026, 6, 21, 0, 30 * k, 0));
    const L = P.look(usSite, GEO, d);
    if (!L || L.elDeg < 10) continue;
    maxSky = Math.max(maxSky, L.rateAsPerS);
    minSky = Math.min(minSky, L.rateAsPerS);
    maxMount = Math.max(maxMount, L.rateMountAsPerS);
    n++;
  }
  ok(`GEO sampled above horizon (${n} samples)`, n > 10);
  check('GEO sky rate is the sidereal rate', maxSky, 15.041, 0.6, 'arcsec/s');
  check('GEO sky rate is steady', maxSky - minSky, 0, 0.6, 'arcsec/s');
  check('GEO mount rate is ~zero', maxMount, 0, 0.6, 'arcsec/s');

  // ISS near culmination: v/rho with v ~ 7.66 km/s.
  let bestEl = -90, rateAtBest = 0, rangeAtBest = 0, mountAtBest = 0;
  for (let k = 0; k < 2000; k++) {
    const d = new Date(Date.UTC(2026, 6, 21, 0, 0, 30 * k));
    const L = P.look(site, ISS, d);
    if (L && L.elDeg > bestEl) {
      bestEl = L.elDeg; rateAtBest = L.rateAsPerS;
      rangeAtBest = L.rangeKm; mountAtBest = L.rateMountAsPerS;
    }
  }
  console.log(`  (best ISS pass reached El ${bestEl.toFixed(1)} deg at range ${rangeAtBest.toFixed(0)} km)`);
  const predicted = (7.66 / rangeAtBest) * F.R2D * 3600;   // v/rho, arcsec/s
  check('ISS sky rate at culmination vs v/rho', rateAtBest, predicted, predicted * 0.25, 'arcsec/s');
  // For a fast LEO object the two rates differ only by the ~15"/s of Earth rotation,
  // which is under 1% of the total -- the opposite regime from GEO.
  check('ISS sky vs mount rate differ by <= sidereal', Math.abs(rateAtBest - mountAtBest), 0, 16, 'arcsec/s');
}

console.log('\n[3] rate and position angle agree with finite differences');
{
  // Differentiate the RA/Dec numerically and compare against the analytic rate and
  // PA. This is the check that catches a wrong sky basis or a swapped atan2.
  let worstRate = 0, worstPa = 0, worstMount = 0, n = 0;
  // Each object is sampled from a site that can actually see it; using one site
  // for all three left only 4 usable samples and made this test nearly vacuous.
  const usSite = { latDeg: 38.9, lonDeg: -77.0, altM: 100 };
  for (const [obj, st] of [[ISS, site], [GEO, usSite], [MOL, usSite]]) {
    for (let k = 0; k < 400; k++) {
      const d = new Date(Date.UTC(2026, 6, 21, 0, 0, 137 * k));
      const L = P.look(st, obj, d);
      if (!L || L.elDeg < 15) continue;
      const dt = 0.5;
      const a = P.look(st, obj, new Date(d.getTime() - dt * 500));
      const b = P.look(st, obj, new Date(d.getTime() + dt * 500));
      if (!a || !b) continue;
      const dsep = F.sep(a.raDeg, a.decDeg, b.raDeg, b.decDeg) * 3600 / dt;
      const dpa = F.posAngle(a.raDeg, a.decDeg, b.raDeg, b.decDeg);
      worstRate = Math.max(worstRate, Math.abs(dsep - L.rateAsPerS) / Math.max(L.rateAsPerS, 1));
      // mount rate against finite-differenced ALT/AZ (great-circle on the horizon frame)
      const dEl = b.elDeg - a.elDeg;
      const dAz = (((b.azDeg - a.azDeg + 540) % 360) - 180) * Math.cos(L.elDeg * F.D2R);
      const dmount = Math.hypot(dEl, dAz) * 3600 / dt;
      worstMount = Math.max(worstMount, Math.abs(dmount - L.rateMountAsPerS) / Math.max(L.rateMountAsPerS, 1));
      let dp = Math.abs(((dpa - L.paDeg + 540) % 360) - 180);
      if (L.rateAsPerS > 1) worstPa = Math.max(worstPa, dp);   // PA is meaningless at ~0 rate
      n++;
    }
  }
  console.log(`  (${n} samples across LEO/GEO/HEO)`);
  check('worst relative rate error vs finite difference', worstRate, 0, 0.01, '');
  check('worst position-angle error vs finite difference', worstPa, 0, 0.5, 'deg');
  check('worst relative MOUNT-rate error vs finite difference', worstMount, 0, 0.01, '');
}

console.log('\n[4] consistency with the frames cross-check');
{
  // look() must reproduce satellite.js's own alt/az, same as frames.js does.
  let worst = 0, n = 0;
  for (let k = 0; k < 300; k++) {
    const d = new Date(Date.UTC(2026, 6, 21, 0, 0, 97 * k));
    const L = P.look(site, ISS, d, { refraction: false });
    if (!L || L.elDeg < 5) continue;
    const pv = satellite.propagate(P.ensureSatrec(ISS) && ISS._satrec, d);
    const la = satellite.ecfToLookAngles(
      { latitude: site.latDeg * F.D2R, longitude: site.lonDeg * F.D2R, height: site.altM / 1000 },
      satellite.eciToEcf(pv.position, satellite.gstime(d)));
    worst = Math.max(worst, Math.abs(L.elDeg - la.elevation * F.R2D) * 3600);
    worst = Math.max(worst, Math.abs(L.rangeKm - la.rangeSat));
    n++;
  }
  console.log(`  (${n} above-horizon samples)`);
  check('worst elevation/range disagreement', worst, 0, 0.01, 'arcsec or km');
}

console.log('\n[5] robustness');
{
  const bad = mk('BAD', '1 garbage', '2 garbage');
  ok('invalid TLE returns false from ensureSatrec', P.ensureSatrec(bad) === false);
  ok('invalid TLE returns null from look', P.look(site, bad, new Date()) === null);
  ok('invalid TLE memoises the failure', bad._satrecBad === true);
  const ep = P.tleEpoch(ISS);
  ok('TLE epoch parses to a Date in 2026', ep && ep.getUTCFullYear() === 2026, ep && ep.toISOString());
  const age = P.tleAgeDays(ISS, new Date(Date.UTC(2026, 6, 25)));
  check('TLE age', age, 3.5, 1.0, 'days');
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
