/* Verification for app/js/occultation/geometry.js — P0-06 spherical tube.
 * Run: node tools/test_geometry.js
 *
 * The randomized checks compare conservative segment envelopes and exact
 * point-to-path distances on the unit sphere. The seed is fixed so failures
 * are reproducible without a catalogue, browser, or network.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

global.SAT = { occultation: {} };
require(path.join(APP, 'occultation', 'geometry.js'));
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
function randomUnit(next) {
  const z = 2 * next() - 1;
  const phi = 2 * Math.PI * next();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: r * Math.cos(phi), y: r * Math.sin(phi), z: z };
}
function orthogonal(v) {
  const axis = Math.abs(v.x) < 0.7 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return G.normalize(G.cross(v, axis));
}
function offsetFrom(point, radians) {
  const u = orthogonal(point);
  return G.normalize({
    x: Math.cos(radians) * point.x + Math.sin(radians) * u.x,
    y: Math.cos(radians) * point.y + Math.sin(radians) * u.y,
    z: Math.cos(radians) * point.z + Math.sin(radians) * u.z,
  });
}
function makeRng(seed) {
  let state = seed >>> 0;
  return function () {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

console.log('\n[1] API, analytic arc distance, and path timing');
ok('geometry API is attached', typeof G.segmentEnvelope === 'function' &&
  typeof G.segmentDistance === 'function' && typeof G.pathDistance === 'function');
const a = G.unitFromRaDec(0, 0);
const b = G.unitFromRaDec(90, 0);
const q = G.slerp(a, b, 0.5);
const deltaArcsec = 12.5;
const p = offsetFrom(q, deltaArcsec / G.ARCSEC_PER_RAD);
const distance = G.segmentDistance(p, a, b);
near('point-to-arc distance uses the interior projection', distance.distanceArcsec,
  deltaArcsec, 1e-7);
near('interior fraction is recovered', distance.fraction, 0.5, 1e-12);
const timedPath = [{ t: 1000, raDeg: 0, decDeg: 0 }, { t: 3000, raDeg: 90, decDeg: 0 }];
const timed = G.pathDistance(q, timedPath);
near('path distance returns the closest UTC timestamp', timed.closestTMs, 2000, 1e-9);
ok('empty path has infinite distance', G.pathDistance(q, []).distanceArcsec === Infinity);

console.log('\n[2] RA wrap, polar geometry, degenerate, and antipodal semantics');
const wrapA = G.unitFromRaDec(359.999, 20);
const wrapB = G.unitFromRaDec(0.001, 20);
const wrapEnvelope = G.segmentEnvelope(wrapA, wrapB, 5);
const wrapMid = G.slerp(wrapA, wrapB, 0.5);
ok('RA-wrap midpoint remains close to zero', (() => {
  const rd = G.raDecFromUnit(wrapEnvelope.center);
  return rd.raDeg < 1 || rd.raDeg > 359;
})());
ok('RA-wrap midpoint lies inside its own tube', G.pointInTube(wrapMid, [wrapA, wrapB], 0));
const poleA = G.unitFromRaDec(0, 89.9);
const poleB = G.unitFromRaDec(180, 89.9);
const poleEnvelope = G.segmentEnvelope(poleA, poleB, 1);
ok('polar arc midpoint reaches the north-pole neighborhood',
  G.raDecFromUnit(poleEnvelope.center).decDeg > 89.99);
ok('polar arc contains its pole midpoint', G.pointInTube(poleEnvelope.center, [poleA, poleB], 0));
const degenerate = G.segmentEnvelope(a, a, 7);
near('zero-length segment envelope is padding-sized', degenerate.radiusArcsec, 7, 1e-9);
near('zero-length segment distance is endpoint distance',
  G.segmentDistance(p, a, a).distanceArcsec, G.angularSeparationArcsec(p, a), 1e-9);
const antipodalB = G.unitFromRaDec(180, 0);
const antipodal = G.segmentEnvelope(a, antipodalB, 1);
ok('antipodal envelope is explicitly whole-sphere', antipodal.wholeSphere && antipodal.radiusDeg === 180);
ok('ambiguous antipodal path remains conservative', G.pointInTube(G.unitFromRaDec(40, 70), [a, antipodalB], 0));

console.log('\n[3] Random conservative-envelope recall');
const next = makeRng(0x5006); // fixed deterministic seed
let sampled = 0;
for (let i = 0; i < 500; i++) {
  const u = randomUnit(next);
  const v = randomUnit(next);
  const envelope = G.segmentEnvelope(u, v, 90);
  if (envelope.wholeSphere) continue;
  const padding = 90 / G.ARCSEC_PER_RAD;
  for (let j = 0; j < 5; j++) {
    const fraction = j / 4;
    const onArc = G.slerp(u, v, fraction);
    const perturbation = (next() * 0.999 + 0.0005) * padding;
    const candidate = offsetFrom(onArc, perturbation);
    const separation = G.angularSeparationArcsec(candidate, envelope.center);
    if (separation > envelope.radiusArcsec + 1e-7) failures++;
    sampled++;
  }
}
ok('random points inside a spherical tube are inside its cone envelope', failures === 0,
  `samples=${sampled}`);

console.log('\n[4] Random brute-force path recall and distance stability');
const bruteRng = makeRng(0x0606);
let bruteCases = 0;
let missed = 0;
for (let i = 0; i < 250; i++) {
  const u = randomUnit(bruteRng);
  const v = randomUnit(bruteRng);
  const envelope = G.segmentEnvelope(u, v, 120);
  if (envelope.wholeSphere) continue;
  const radius = 120;
  const point = i % 2 === 0
    ? offsetFrom(G.slerp(u, v, bruteRng()), (0.9 * bruteRng()) / G.ARCSEC_PER_RAD)
    : randomUnit(bruteRng);
  let sampledDistance = Infinity;
  for (let j = 0; j <= 400; j++) {
    const sample = G.slerp(u, v, j / 400);
    sampledDistance = Math.min(sampledDistance, G.angularSeparationArcsec(point, sample));
  }
  if (sampledDistance <= radius) {
    bruteCases++;
    if (!G.pointInTube(point, [u, v], radius)) missed++;
  }
}
ok('optimized tube membership contains dense brute-force hits', missed === 0,
  `bruteHits=${bruteCases}, missed=${missed}`);
ok('geometry module does not create application state', SAT.state === undefined);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
