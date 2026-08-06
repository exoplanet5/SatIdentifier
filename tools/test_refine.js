/* Verification for app/js/occultation/refine.js — P0-07 closest approach.
 * Run: node tools/test_refine.js
 *
 * The evaluator doubles below are deterministic analytic J2000 trajectories.
 * They deliberately make the piecewise path's linear closest-time diagnostic
 * differ from the exact quadratic trajectory so the final result must come
 * from the bracketed evaluator, not geometry.pathDistance().closestTMs.
 */
const path = require('path');

const APP = path.join(__dirname, '..', 'app', 'js');
global.SAT = { occultation: {} };
require(path.join(APP, 'occultation', 'refine.js'));
const R = SAT.occultation.refine;
const G = SAT.occultation.geometry;

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function near(name, got, want, tolerance, detail) {
  ok(name, isFinite(got) && Math.abs(got - want) <= tolerance,
    `${got} vs ${want}${detail ? ' ' + detail : ''}`);
}
function throws(name, fn) {
  let thrown = false;
  try { fn(); } catch (error) { thrown = true; }
  ok(name, thrown);
}
function wrapRa(value) {
  return ((value % 360) + 360) % 360;
}
function analyticTrack(tMs) {
  const trueTime = 1234.37;
  const dt = tMs - trueTime;
  // Arcsec: a smooth, non-linear along-track motion plus a fixed cross-track miss.
  const alongArcsec = 0.04 * dt + 0.00001 * dt * dt;
  return {
    raDeg: wrapRa(10 + alongArcsec / 3600),
    decDeg: 0.5 / 3600,
    rangeKm: 42000,
    rateAsPerS: 40,
  };
}
function pathFromEvaluator(evaluate, times) {
  return times.map((t) => Object.assign({ t: t }, evaluate(t)));
}

console.log('\n[1] Exact time refinement beats geometric closestTMs');
ok('refine API is attached', typeof R.refine === 'function' && typeof R.solve === 'function');
const pass = {
  passId: 'pass:analytic', pathMode: 'raw-worker', pathToleranceArcsec: null,
  startMs: 0, endMs: 2000, path: pathFromEvaluator(analyticTrack, [0, 2000]),
};
const originalPath = JSON.stringify(pass.path);
const star = { starKey: 'synthetic', raDeg: 10, decDeg: 0, mag: 5 };
const geometric = G.pathDistance(star, pass.path);
const result = R.refine({ pass: pass, candidate: star, evaluate: analyticTrack }, {
  timeToleranceMs: 0.02,
});
near('exact minimum time is recovered below the P0-07 threshold', result.tCaMs, 1234.37, 0.2);
near('fixed cross-track miss is evaluated on the exact direction',
  result.nominalSeparationArcsec, 0.5, 1e-7);
ok('result is complete despite a raw path because all intervals were refined',
  result.status === 'ok' && result.complete === true);
ok('raw path precision is disclosed', result.flags.includes('path-precision-unverified'));
ok('returned geometry preserves evaluator fields', result.closestGeometry && result.closestGeometry.rangeKm === 42000);
ok('linear path time is not reused as final time', Math.abs(geometric.closestTMs - result.tCaMs) > 100);
ok('pass path is not mutated', JSON.stringify(pass.path) === originalPath);

console.log('\n[2] Adaptive-path screening, boundaries, RA wrap, and polar directions');
const adaptivePass = {
  passId: 'pass:adaptive', pathMode: 'adaptive', pathToleranceArcsec: 0.5,
  pathTruncated: false, startMs: 0, endMs: 2000,
  path: pathFromEvaluator(analyticTrack, [0, 1000, 2000]),
};
const adaptive = R.refine({ pass: adaptivePass, star: star, evaluate: analyticTrack }, {
  timeToleranceMs: 0.05,
});
near('adaptive path still uses exact evaluator time', adaptive.tCaMs, 1234.37, 0.2);
ok('verified adaptive path does not receive an unverified flag',
  !adaptive.flags.includes('path-precision-unverified'));
const endpointEvaluate = (t) => ({ raDeg: 20 + 0.001 * t, decDeg: 0 });
const endpoint = R.refine({
  path: pathFromEvaluator(endpointEvaluate, [10, 20]),
  star: { raDeg: 20.01, decDeg: 0 },
  evaluate: endpointEvaluate,
  startMs: 10, endMs: 20,
}, { timeToleranceMs: 0.05 });
ok('endpoint minimum stays inside the requested interval', endpoint.tCaMs >= 10 && endpoint.tCaMs <= 10.1,
  String(endpoint.tCaMs));
const polarEvaluate = (t) => ({
  raDeg: wrapRa(359.9 + 0.2 * t / 1000), decDeg: 89.9,
});
const polar = R.refine({
  path: pathFromEvaluator(polarEvaluate, [0, 1000]),
  star: { raDeg: 0, decDeg: 89.9 }, evaluate: polarEvaluate,
}, { timeToleranceMs: 0.05 });
near('polar RA-wrap minimum is found', polar.tCaMs, 500, 0.2);
near('polar minimum separation is zero', polar.nominalSeparationArcsec, 0, 1e-7);

console.log('\n[3] Failure isolation, budgets, and validation');
const failed = R.refine({
  path: [{ t: 0, raDeg: 0, decDeg: 0 }, { t: 1000, raDeg: 1, decDeg: 0 }],
  star: { raDeg: 0, decDeg: 0 },
  evaluate: (t) => t > 400 ? null : { raDeg: t / 3600000, decDeg: 0 },
});
ok('evaluator failure is returned as an incomplete candidate result',
  failed.status === 'failed' && !failed.complete && failed.flags.includes('evaluation-failed'));
const budget = R.refine({
  path: [{ t: 0, raDeg: 0, decDeg: 0 }, { t: 1000, raDeg: 1, decDeg: 0 }],
  star: { raDeg: 0.5, decDeg: 0 }, evaluate: (t) => ({ raDeg: t / 2000, decDeg: 0 }),
}, { maxEvaluations: 4 });
ok('evaluation budget is explicit', budget.status === 'failed' && budget.flags.includes('evaluation-budget'));
throws('missing evaluator is rejected', () => R.refine({ path: pass.path, star: star }));
throws('reversed interval is rejected', () => R.refine({
  path: pass.path, star: star, evaluate: analyticTrack, startMs: 10, endMs: 0,
}));
throws('zero time tolerance is rejected', () => R.refine({
  path: pass.path, star: star, evaluate: analyticTrack,
}, { timeToleranceMs: 0 }));
ok('geometry and refine modules do not create application state', SAT.state === undefined);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
