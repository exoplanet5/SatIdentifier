/* Verification for app/js/occultation/adaptive-path.js — P0-04.
 * Run: node tools/test_adaptive_path.js
 *
 * The evaluator below is a deterministic synthetic J2000 trajectory. The dense
 * checks intentionally use independent intermediate times, not the samples that
 * drove the adaptive subdivision, so the contract tests representation error
 * rather than merely checking that the solver reports a small residual.
 */
const assert = require('assert');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

global.SAT = { occultation: {} };
require(path.join(APP, 'occultation', 'adaptive-path.js'));
const A = SAT.occultation.adaptivePath;

const START = 100000;
const END = 200000;

function direction(raDeg, decDeg) {
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const c = Math.cos(dec);
  return { x: c * Math.cos(ra), y: c * Math.sin(ra), z: Math.sin(dec) };
}

function trajectory(t) {
  const f = (t - START) / (END - START);
  // The path crosses RA=0 and contains a smooth transverse excursion. It is
  // deliberately not a great-circle segment, so adaptive refinement is needed.
  return {
    raDeg: 359 + 2 * f + 0.18 * Math.sin(Math.PI * f),
    decDeg: 20 + 0.12 * Math.sin(Math.PI * f),
  };
}

function denseError(pathPoints, evaluate) {
  let worst = 0;
  for (let i = 1; i < pathPoints.length; i++) {
    const a = pathPoints[i - 1], b = pathPoints[i];
    const va = direction(a.raDeg, a.decDeg), vb = direction(b.raDeg, b.decDeg);
    for (let j = 1; j < 100; j++) {
      const f = j / 100;
      const t = Math.round(a.t + (b.t - a.t) * f);
      const truth = direction(evaluate(t).raDeg, evaluate(t).decDeg);
      const reference = A.slerp(va, vb, (t - a.t) / (b.t - a.t));
      worst = Math.max(worst, A.angularSeparationArcsec(truth, reference));
    }
  }
  return worst;
}

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function throws(name, fn) {
  let thrown = false;
  try { fn(); } catch (error) { thrown = true; }
  ok(name, thrown);
}

console.log('\n[1] API and exact spherical contract');
ok('adaptive-path API is attached', !!A && typeof A.refine === 'function');
const straight = A.refine({
  startMs: START, endMs: END,
  path: [{ t: START, raDeg: 10, decDeg: -5 }, { t: END, raDeg: 11, decDeg: -5 }],
  evaluate: (t) => ({ raDeg: 10 + (t - START) / (END - START), decDeg: -5 }),
}, { toleranceArcsec: 1, maxSamples: 32 });
ok('a great-circle-compatible path needs no extra samples',
  straight.pathMode === 'adaptive' && straight.path.length === 2 && !straight.pathTruncated);
ok('straight-path residual remains below one arcsecond',
  straight.pathWorstErrorArcsec < 1, String(straight.pathWorstErrorArcsec));

console.log('\n[2] Curvature, RA wrap, and independent dense validation');
const refined = A.refine({
  startMs: START, endMs: END,
  path: [{ t: START, raDeg: 359, decDeg: 20 }, { t: END, raDeg: 1, decDeg: 20 }],
  evaluate: trajectory,
}, { toleranceArcsec: 1, maxSamples: 128 });
const dense = denseError(refined.path, trajectory);
let ordered = true;
for (let i = 1; i < refined.path.length; i++) if (!(refined.path[i - 1].t < refined.path[i].t)) ordered = false;
ok('curved trajectory switches to adaptive mode', refined.pathMode === 'adaptive');
ok('adaptive path inserts samples for curvature', refined.path.length > 2,
  `samples=${refined.path.length}`);
ok('path timestamps are strictly increasing', ordered);
ok('RA wrap remains the short spherical route', refined.path[0].raDeg > 350 &&
  refined.path[refined.path.length - 1].raDeg < 5);
ok('dense independent error meets tolerance x 1.1', dense <= 1.1,
  `dense=${dense.toFixed(6)} arcsec, reported=${refined.pathWorstErrorArcsec.toFixed(6)} arcsec`);
ok('reported residual is below the requested tolerance', refined.pathWorstErrorArcsec <= 1,
  String(refined.pathWorstErrorArcsec));

console.log('\n[3] Explicit truncation and fallback semantics');
const capped = A.refine({
  startMs: START, endMs: END,
  path: [{ t: START, raDeg: 359, decDeg: 20 }, { t: END, raDeg: 1, decDeg: 20 }],
  evaluate: trajectory,
}, { toleranceArcsec: 1, maxSamples: 2 });
ok('sample budget is enforced', capped.path.length <= 2);
ok('budget exhaustion is explicit', capped.pathTruncated === true);
ok('truncated result keeps a measured residual',
  capped.pathWorstErrorArcsec !== null && capped.pathWorstErrorArcsec > 1);
const fallback = A.refine({
  startMs: START, endMs: END,
  path: [{ t: START, raDeg: 1, decDeg: 2 }, { t: END, raDeg: 3, decDeg: 4 }],
}, { toleranceArcsec: 1, maxSamples: 8 });
ok('missing evaluator does not invent an error claim',
  fallback.pathMode === 'raw-worker' && fallback.pathToleranceArcsec === null &&
  fallback.pathWorstErrorArcsec === null);
const failedInterior = A.refine({
  startMs: START, endMs: END,
  path: [{ t: START, raDeg: 1, decDeg: 2 }, { t: END, raDeg: 3, decDeg: 4 }],
  evaluate: (t) => t === START || t === END ? { raDeg: 1 + 2 * (t - START) / (END - START), decDeg: 2 } : null,
}, { toleranceArcsec: 1, maxSamples: 8 });
ok('interior propagation failure falls back without an error claim',
  failedInterior.pathMode === 'raw-worker' && failedInterior.pathWorstErrorArcsec === null);

console.log('\n[4] Input validation');
throws('zero tolerance is rejected', () => A.refine({ startMs: 0, endMs: 1, evaluate: () => ({ raDeg: 0, decDeg: 0 }) }, { toleranceArcsec: 0 }));
throws('one-sample budget is rejected', () => A.refine({ startMs: 0, endMs: 1, evaluate: () => ({ raDeg: 0, decDeg: 0 }) }, { maxSamples: 1 }));
throws('reversed interval is rejected', () => A.refine({ startMs: 2, endMs: 1, evaluate: () => ({ raDeg: 0, decDeg: 0 }) }));

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
