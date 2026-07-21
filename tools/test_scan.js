/* Verification for app/js/worker/scan-worker.js — the scan engine's core.
 * Run: node tools/test_scan.js [path/to/catalogue.tle]
 *
 * Three things are checked, in increasing order of how badly a failure would hurt:
 *
 *  (a) CORRECTNESS — every crossing returned really is inside the field at its
 *      tCaMs, recomputed independently through frames.js rather than by trusting
 *      the worker's own numbers.
 *  (b) SOUNDNESS OF THE STAGE 1 CULL — the same scan with the geometric cull
 *      switched off must find the IDENTICAL crossing set. The cull is the only
 *      part of the algorithm that can lose a real object without leaving a trace,
 *      so it gets an exact set comparison, not a tolerance.
 *  (c) COST — wall clock and the per-stage culled counts, which the UI has to
 *      show: a scan that removes 90% of the catalogue must say so, or a bug in
 *      the cull is indistinguishable from "no satellites tonight".
 */
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

global.window = global;
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
require(path.join(APP, 'frames.js'));
const F = SAT.frames;

const worker = require(path.join(APP, 'worker', 'scan-worker.js'));

let failures = 0;
function ok(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

/* ---- catalogue ----------------------------------------------------------- */

const CANDIDATES = [
  process.argv[2],
  '/tmp/active.tle',
  path.join('/private/tmp/claude-502/-Users-mickey-sda-satidentifier',
    '8f585dfb-8b71-4dc2-9b62-f86b2af3ea20', 'scratchpad', 'active.tle'),
].filter(Boolean);

const src = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!src) {
  console.error('No catalogue found. Fetch one with:\n  curl -s -A "SatIdentifier/0.1" ' +
    '"https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle" -o /tmp/active.tle');
  process.exit(2);
}

const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
const objs = [];
for (let i = 0; i + 2 < lines.length; i += 3) {
  const l1 = lines[i + 1], l2 = lines[i + 2];
  if (!l1 || l1[0] !== '1' || !l2 || l2[0] !== '2') continue;
  const norad = parseInt(l2.slice(2, 7), 10);
  objs.push({
    id: 'o_' + norad, norad: norad, name: (lines[i] || '').trim(),
    intl: l1.slice(9, 17).trim(), l1: l1, l2: l2, rcs: null, stdMag: null,
  });
}
console.log(`catalogue: ${src}\n           ${objs.length} objects`);

let t = Date.now();
const loaded = worker.loadObjs(objs);
console.log(`           ${loaded.count} satrecs built in ${Date.now() - t} ms ` +
  `(${loaded.bad} rejected as invalid)`);

// The catalogue's newest element epoch fixes a sensible scan time: scanning a week
// away from the elements would exercise TLE decay, not the scan engine.
let newest = 0;
for (const o of objs) {
  const r = satellite.twoline2satrec(o.l1, o.l2);
  if (r && isFinite(r.jdsatepoch) && r.jdsatepoch > newest) newest = r.jdsatepoch;
}
const T0 = new Date(Math.round((newest - 2440587.5) * 86400000 / 1000) * 1000);
console.log(`           newest element epoch ${T0.toISOString()} — scanning from there`);

/* ---- scan parameters ----------------------------------------------------- */

const SITE = { latDeg: 43.9, lonDeg: -103.5, altM: 1200 };   // mid-latitude, Black Hills

function params(over) {
  return Object.assign({
    t0Ms: T0.getTime(),
    spanMin: 60,
    site: SITE,
    pointing: { track: 'sky', mode: 'radec', raDeg: 260.0, decDeg: 35.0, refract: true },
    fov: { shape: 'circ', rDeg: 30, wDeg: 0, hDeg: 0, rotDeg: 0 },
    filters: { minElDeg: 0 },
    steps: { coarseStepS: 30, fineStepS: 1.0, marginDeg: 0 },
    dut1S: 0,
  }, over || {});
}

/** Recompute a crossing's separation from the field centre from first principles:
 *  raw SGP4 -> topocentric TEME -> J2000 via frames.js -> Vincenty separation.
 *  Shares nothing with the worker except satellite.js itself. */
function independentSep(cr, p) {
  const o = objs.find((x) => x.id === cr.satId);
  const rec = satellite.twoline2satrec(o.l1, o.l2);
  const d = new Date(cr.tCaMs);
  const pv = satellite.propagate(rec, d);
  if (!pv || !pv.position) return null;
  const topo = F.topoTeme(p.site, pv.position, d);
  const rd = F.vecToRaDec(F.temeToJ2000(topo, d));
  const aa = F.raDecToAltAz(rd.raDeg, rd.decDeg, p.site, d, { refract: false });
  return {
    sepDeg: F.sep(rd.raDeg, rd.decDeg, p.pointing.raDeg, p.pointing.decDeg),
    raDeg: rd.raDeg, decDeg: rd.decDeg, elDeg: aa.elDeg,
  };
}

const key = (c) => c.satId + '@' + Math.round(c.tCaMs / 1000);

async function scan(p, label) {
  const t = Date.now();
  const res = await worker.runScan(p);
  const ms = Date.now() - t;
  if (label) {
    const c = res.culled;
    console.log(`  ${label.padEnd(26)} ${String(res.crossings.length).padStart(5)} crossings  ` +
      `${String(ms).padStart(6)} ms  ${(res.propagations / 1e6).toFixed(2)} M props`);
    console.log(`  ${''.padEnd(26)} stage1 culled ${c.stage1} of ${c.total - c.bad} ` +
      `(${(100 * c.stage1 / Math.max(1, c.total - c.bad)).toFixed(1)}%) -> ${c.survivors} survivors; ` +
      `stage2 culled ${c.stage2} -> ${c.candidates} candidates; stage3 dropped ${c.stage3}`);
  }
  res.wallMs = ms;
  return res;
}

/* ========================================================================== */

(async () => {
  // ------------------------------------------------------------------ test a
  console.log('\n[a] wide-field scan: 30 deg radius, mid-latitude site, 1 hour');
  const pA = params();
  const A = await scan(pA, 'stage 1 ON');

  ok('found a plausible number of crossings',
    A.crossings.length > 20 && A.crossings.length < 20000,
    `(${A.crossings.length})`);

  let worstSep = -1, worstName = '', badRa = 0, checked = 0, worstRa = 0;
  for (const c of A.crossings) {
    const ind = independentSep(c, pA);
    if (!ind) continue;
    checked++;
    if (ind.sepDeg > worstSep) { worstSep = ind.sepDeg; worstName = c.name; }
    const dRa = F.sep(ind.raDeg, ind.decDeg, c.raDeg, c.decDeg) * 3600;
    if (dRa > worstRa) worstRa = dRa;
    if (dRa > 1.0) badRa++;
  }
  ok('every crossing is inside the FOV at tCaMs (independent recompute)',
    worstSep <= pA.fov.rDeg,
    `worst ${worstSep.toFixed(4)} deg vs ${pA.fov.rDeg} deg limit  [${worstName}]  (${checked} checked)`);
  ok('reported RA/Dec matches an independent recompute to < 1 arcsec',
    badRa === 0, `worst ${worstRa.toFixed(4)} arcsec`);

  let monotone = true, pathOk = true, ordered = true;
  let prev = -Infinity;
  for (const c of A.crossings) {
    if (!(c.tEnterMs <= c.tCaMs && c.tCaMs <= c.tExitMs)) monotone = false;
    if (!(c.path && c.path.length >= 2 && c.path.length <= 64)) pathOk = false;
    if (c.tCaMs < prev) ordered = false;
    prev = c.tCaMs;
  }
  ok('tEnter <= tCa <= tExit for every crossing', monotone);
  ok('path has 2..64 samples for every crossing', pathOk);
  ok('crossings are sorted by tCaMs', ordered);

  // Narrow field: this is where the cull actually bites, and where an error in
  // the FOV boundary would show up as a sepCa just outside the radius.
  console.log('\n[a2] narrow-field scan: 4 x 3 deg rectangle, rotated 25 deg, 6 hours');
  const pN = params({
    spanMin: 360,
    fov: { shape: 'rect', wDeg: 4, hDeg: 3, rDeg: 0, rotDeg: 25 },
    steps: { coarseStepS: 30, fineStepS: 0.5, marginDeg: 0 },
  });
  const N = await scan(pN, 'stage 1 ON');
  ok('narrow field finds crossings (otherwise the test below is vacuous)',
    N.crossings.length > 5, `(${N.crossings.length})`);
  let rectOk = true, worstRect = 0;
  for (const c of N.crossings) {
    const ind = independentSep(c, pN);
    if (!ind) continue;
    const p = F.tanProject(ind.raDeg, ind.decDeg, pN.pointing.raDeg, pN.pointing.decDeg);
    if (!p) { rectOk = false; continue; }
    // rotDeg is the position angle of chart +Y, N through E
    const r = pN.fov.rotDeg * F.D2R, cr = Math.cos(r), sr = Math.sin(r);
    const X = p.xi * cr - p.eta * sr, Y = p.xi * sr + p.eta * cr;
    const over = Math.max(Math.abs(X) - pN.fov.wDeg / 2, Math.abs(Y) - pN.fov.hDeg / 2);
    if (over > worstRect) worstRect = over;
    if (over > 1e-6) rectOk = false;
  }
  ok('every crossing is inside the rectangle at tCaMs',
    rectOk, `worst overshoot ${(worstRect * 3600).toFixed(3)} arcsec`);

  // ------------------------------------------------------------------ test b
  console.log('\n[b] stage 1 soundness: cull ON must equal cull OFF');
  for (const [label, p] of [['30 deg circle', pA], ['4 x 3 deg rect', pN]]) {
    const on = (label === '30 deg circle') ? A : N;
    const off = await scan(Object.assign({}, p, { useStage1: false }), 'stage 1 OFF (' + label + ')');
    const sOn = new Set(on.crossings.map(key));
    const sOff = new Set(off.crossings.map(key));
    const lost = [...sOff].filter((k) => !sOn.has(k));
    const gained = [...sOn].filter((k) => !sOff.has(k));
    ok(`identical crossing set, ${label}`,
      lost.length === 0 && gained.length === 0,
      `culled-off found ${sOff.size}, culled-on found ${sOn.size}` +
      (lost.length ? `; LOST BY THE CULL: ${lost.slice(0, 12).join(', ')}` : '') +
      (gained.length ? `; only with cull: ${gained.slice(0, 12).join(', ')}` : ''));
    if (lost.length) {
      console.log('        ^ the stage 1 cull is UNSOUND — it dropped real crossings.');
      for (const k of lost.slice(0, 5)) {
        const c = off.crossings.find((x) => key(x) === k);
        console.log(`          ${c.name} (${c.norad}) ${c.cls} sep ${c.sepCaDeg.toFixed(3)} deg ` +
          `el ${c.elDeg.toFixed(1)} range ${c.rangeKm.toFixed(0)} km`);
      }
    }
  }

  // A pointing at the celestial pole should annihilate the GEO belt — the cull's
  // headline claim in CONTRACT.md. If it does not, the plane test is not working.
  console.log('\n[b2] pole pointing must kill the GEO belt');
  const pPole = params({
    pointing: { track: 'sky', mode: 'radec', raDeg: 0, decDeg: 89.9, refract: true },
    fov: { shape: 'circ', rDeg: 2, wDeg: 0, hDeg: 0, rotDeg: 0 },
  });
  const Pl = await scan(pPole, 'pole, 2 deg circle');
  const off = await scan(Object.assign({}, pPole, { useStage1: false }), 'pole, stage 1 OFF');
  const sOn = new Set(Pl.crossings.map(key)), sOff = new Set(off.crossings.map(key));
  const lost = [...sOff].filter((k) => !sOn.has(k));
  ok('identical crossing set at the pole', lost.length === 0,
    `${sOff.size} vs ${sOn.size}` + (lost.length ? `; LOST: ${lost.slice(0, 8).join(', ')}` : ''));
  ok('cull removes most of the catalogue at the pole',
    Pl.culled.stage1 / Math.max(1, Pl.culled.total - Pl.culled.bad) > 0.5,
    `${(100 * Pl.culled.stage1 / Math.max(1, Pl.culled.total - Pl.culled.bad)).toFixed(1)}% culled`);

  // Alt/az "mount" tracking exercises the per-epoch pointing path.
  console.log('\n[b3] mount tracking (field fixed in alt/az)');
  const pM = params({
    pointing: { track: 'mount', mode: 'altaz', azDeg: 180, elDeg: 55, refract: true },
    fov: { shape: 'circ', rDeg: 5, wDeg: 0, hDeg: 0, rotDeg: 0 },
  });
  const M = await scan(pM, 'mount, 5 deg circle');
  const Moff = await scan(Object.assign({}, pM, { useStage1: false }), 'mount, stage 1 OFF');
  const mOn = new Set(M.crossings.map(key)), mOff = new Set(Moff.crossings.map(key));
  const mLost = [...mOff].filter((k) => !mOn.has(k));
  ok('identical crossing set under mount tracking', mLost.length === 0,
    `${mOff.size} vs ${mOn.size}` + (mLost.length ? `; LOST: ${mLost.slice(0, 8).join(', ')}` : ''));

  // ------------------------------------------------------------------ test b4
  // Stage 1 soundness is an exact set comparison; stage 2 recall cannot be, because
  // there is no ground truth. The closest available proxy: re-run with the coarse
  // step equal to the fine step, so the coarse sweep can barely miss anything, and
  // check the 30 s sweep found the same objects.
  console.log('\n[b4] stage 2 recall: 30 s coarse sweep vs a 1 s sweep, 15 deg, 15 min');
  const pFast = params({ spanMin: 15, fov: { shape: 'circ', rDeg: 15, wDeg: 0, hDeg: 0, rotDeg: 0 } });
  const R30 = await scan(pFast, 'coarse 30 s');
  const R1 = await scan(Object.assign({}, pFast,
    { steps: { coarseStepS: 1, fineStepS: 1.0, marginDeg: 0 } }), 'coarse 1 s (reference)');
  const sat30 = new Set(R30.crossings.map((c) => c.satId));
  const sat1 = new Set(R1.crossings.map((c) => c.satId));
  const missed = [...sat1].filter((s) => !sat30.has(s));
  ok('the 1 s reference sweep finds objects (otherwise this test is vacuous)',
    sat1.size > 10, `(${sat1.size})`);
  ok('30 s coarse sweep misses no object the 1 s sweep found',
    missed.length === 0,
    `1 s found ${sat1.size} objects, 30 s found ${sat30.size}` +
    (missed.length ? `; MISSED: ${missed.slice(0, 10).join(', ')}` : ''));

  // ------------------------------------------------------------------ test b5
  // Both rate pairs must be present and in the right frame. The discriminating case
  // is GEO: it co-rotates with the Earth, so it drifts through the STAR field at
  // very nearly the sidereal rate while sitting still against the HORIZON. Getting
  // the omega x rho term backwards (or omitting it) doubles the mount rate to ~30"/s
  // instead of collapsing it to ~0, which this catches immediately.
  console.log('\n[b5] sky vs mount angular rates');
  // Aim at the GEO belt on the meridian: RA = local apparent sidereal time, and the
  // declination the belt sits at when viewed from this latitude (parallax pulls it
  // below the equator). Hard-coding an RA would put the field under the horizon,
  // which is how this test first came out empty.
  const lstDeg = ((F.lastRad(SITE, T0) * F.R2D) % 360 + 360) % 360;
  const pGeo = params({
    spanMin: 120,
    pointing: { track: 'sky', mode: 'radec', raDeg: lstDeg, decDeg: -5.7, refract: true },
    fov: { shape: 'circ', rDeg: 12, wDeg: 0, hDeg: 0, rotDeg: 0 },
  });
  console.log(`  field centre RA ${lstDeg.toFixed(2)} deg (= LST), Dec -5.7 deg`);
  const G = await scan(pGeo, 'GEO belt, 12 deg circle');

  const haveBoth = G.crossings.every((c) =>
    isFinite(c.rateAsPerS) && isFinite(c.paDeg) &&
    isFinite(c.rateMountAsPerS) && isFinite(c.paMountDeg));
  ok('every crossing carries both rate/PA pairs', haveBoth);

  const geos = G.crossings.filter((c) => c.cls === 'geo');
  ok('the scan found GEO objects (otherwise this test is vacuous)', geos.length > 3,
    `(${geos.length})`);
  if (geos.length) {
    const worstSkyErr = Math.max(...geos.map((c) => Math.abs(c.rateAsPerS - 15.0)));
    const worstMount = Math.max(...geos.map((c) => c.rateMountAsPerS));
    ok('GEO sky rate is ~15 arcsec/s (sidereal drift through the star field)',
      worstSkyErr < 3.0, `worst departure from 15"/s is ${worstSkyErr.toFixed(2)}"/s`);
    ok('GEO mount rate is ~0 arcsec/s (stationary against the horizon)',
      worstMount < 3.0, `worst ${worstMount.toFixed(3)}"/s`);
  }

  const leos = G.crossings.filter((c) => c.cls === 'leo');
  ok('LEO found for the rate-difference check', leos.length > 3, `(${leos.length})`);
  if (leos.length) {
    // The two frames differ by exactly the observer's rotation, which projects onto
    // the sky at no more than the ~15.04"/s sidereal rate whatever the geometry.
    const worstDiff = Math.max(...leos.map((c) => Math.abs(c.rateAsPerS - c.rateMountAsPerS)));
    ok('LEO sky and mount rates differ by no more than Earth rotation (~15"/s)',
      worstDiff <= 15.1, `worst difference ${worstDiff.toFixed(3)}"/s`);
  }

  // ------------------------------------------------------------------ test c
  console.log('\n[c] timing and cull budget');
  const pDay = params({ spanMin: 360, steps: { coarseStepS: 30, fineStepS: 1.0, marginDeg: 0 } });
  const D = await scan(pDay, '6 h @ 30 s, 30 deg');
  console.log(`\n  single-thread wall clock, ${objs.length} objects:`);
  console.log(`    1 h  @ 30 s, 30 deg circle : ${A.wallMs} ms  (${A.crossings.length} crossings)`);
  console.log(`    6 h  @ 30 s, 4x3 deg rect  : ${N.wallMs} ms  (${N.crossings.length} crossings)`);
  console.log(`    6 h  @ 30 s, 30 deg circle : ${D.wallMs} ms  (${D.crossings.length} crossings)`);
  console.log(`    -> across 6 workers, roughly ${(D.wallMs / 6 / 1000).toFixed(2)} s for the 6 h scan`);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
