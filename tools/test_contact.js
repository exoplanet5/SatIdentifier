/* Verification for app/js/occultation/contact.js — P0-09.
 * Run: node tools/test_contact.js
 *
 * The evaluator is an analytic J2000 track with a fixed 1000 km topocentric
 * range. It checks the angular-radius equation, bisection brackets, size-model
 * provenance, clipped contacts, miss semantics, and evaluator failure handling.
 */
const path = require('path');

const APP = path.join(__dirname, '..', 'app', 'js');
global.SAT = { occultation: {} };
require(path.join(APP, 'occultation', 'contact.js'));
const C = SAT.occultation.contact;
const S = SAT.occultation.satelliteSize;
const ARCSEC_PER_RAD = 180 * 3600 / Math.PI;

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

const pass = { startMs: 0, endMs: 1000 };
const star = { raDeg: 0, decDeg: 0 };
const object = { id: 'synthetic', radiusM: 10 };
const radiusAs = S.angularRadiusArcsec(10, 1000);
function track(tMs) {
  const offsetArcsec = 0.01 * (tMs - 500);
  return { raDeg: offsetArcsec / 3600, decDeg: 0, rangeKm: 1000 };
}

console.log('\n[1] Angular size and exact ingress/egress');
ok('contact API is attached', typeof C.solve === 'function' && typeof C.calculate === 'function');
near('angular radius uses asin(r / range)', radiusAs,
  Math.asin(0.01 / 1000) * ARCSEC_PER_RAD, 1e-12);
near('angular diameter is twice the radius', C.angularDiameterArcsec(10, 1000), 2 * radiusAs, 1e-12);
const originalPass = JSON.stringify(pass);
const result = C.solve({ pass: pass, candidate: star, object: object, evaluate: track, tCaMs: 500 }, {
  sampleStepMs: 200, timeToleranceMs: 0.02,
});
const expectedIngress = 500 - radiusAs / 0.01;
const expectedEgress = 500 + radiusAs / 0.01;
ok('a positive disc crossing is classified as contact',
  result.status === 'contact' && result.contact === true && result.complete === true);
near('ingress solves the alpha - d = 0 root', result.ingressMs, expectedIngress, 0.05);
near('egress solves the alpha - d = 0 root', result.egressMs, expectedEgress, 0.05);
near('duration is egress minus ingress', result.durationMs, 2 * radiusAs / 0.01, 0.1);
ok('root brackets are ordered and narrow',
  result.ingressBracket && result.egressBracket &&
  result.ingressBracket.startMs <= result.ingressMs &&
  result.ingressMs <= result.ingressBracket.endMs &&
  result.egressBracket.endMs - result.egressBracket.startMs <= 0.02);
ok('object and pass inputs are not mutated', JSON.stringify(pass) === originalPass);

console.log('\n[2] Size provenance, miss, and clipped interval');
const rcs = S.resolve({ rcs: 4 * Math.PI }, { defaultRadiusM: null });
ok('RCS resolves to the equivalent diffuse-sphere radius',
  rcs.source === 'rcs' && rcs.radiusM === 2 && rcs.flags.includes('radius-from-rcs'));
const type = S.resolve({ type: 'ROCKET BODY' }, { defaultRadiusM: null });
ok('SATCAT type aliases resolve to an explicit size prior',
  type.source === 'type' && type.radiusM === 2 && type.flags.includes('radius-assumed'));
const miss = C.solve({ pass: pass, candidate: { raDeg: 10 / 3600, decDeg: 0 },
  object: object, evaluate: track, tCaMs: 500 }, { sampleStepMs: 200 });
ok('a closest approach outside the disc is a complete miss',
  miss.status === 'miss' && miss.contact === false && miss.complete === true);
const clipped = C.solve({ pass: { startMs: 400, endMs: 600 }, candidate: star,
  object: object, evaluate: track, tCaMs: 500 }, { sampleStepMs: 100 });
ok('pass-boundary contact is retained and disclosed as clipped',
  clipped.status === 'contact' && clipped.ingressMs === 400 && clipped.egressMs === 600 &&
  clipped.flags.includes('contact-clipped-start') && clipped.flags.includes('contact-clipped-end'));

console.log('\n[3] Failure and validation semantics');
const unknown = C.solve({ pass: pass, candidate: star, object: {}, evaluate: track, tCaMs: 500 }, {
  defaultRadiusM: null,
});
ok('unknown size can be rejected without fabricating a contact',
  unknown.status === 'failed' && !unknown.complete && unknown.flags.includes('radius-unavailable'));
const badRange = C.solve({ pass: pass, candidate: star, object: object,
  evaluate: () => ({ raDeg: 0, decDeg: 0 }), tCaMs: 500 });
ok('missing range is an incomplete result with an explicit flag',
  badRange.status === 'failed' && !badRange.complete && badRange.flags.includes('range-unavailable'));
throws('reversed intervals are rejected', () => C.solve({
  pass: { startMs: 10, endMs: 0 }, candidate: star, object: object, evaluate: track,
}));
throws('zero sample step is rejected', () => C.solve({
  pass: pass, candidate: star, object: object, evaluate: track,
}, { sampleStepMs: 0 }));

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
