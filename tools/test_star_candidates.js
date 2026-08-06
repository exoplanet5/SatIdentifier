/* Verification for app/js/occultation/star-candidates.js — P0-05 OCCSTAR1.
 * Run: node tools/test_star_candidates.js
 *
 * The star catalogue is replaced by a deterministic cone double. The assertions
 * exercise the spherical corridor envelope, RA-wrap handling, multi-segment
 * deduplication, path-precision flags, truncation, failure reporting, and the
 * no-state/no-mutation boundary without loading a browser asset.
 */
const assert = require('assert');
const path = require('path');

const APP = path.join(__dirname, '..', 'app', 'js');
global.SAT = { occultation: {} };
require(path.join(APP, 'occultation', 'star-candidates.js'));
const S = SAT.occultation.starCandidates;

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function near(name, got, want, tolerance, detail) {
  const condition = isFinite(got) && Math.abs(got - want) <= tolerance;
  ok(name, condition, `${got} vs ${want}${detail ? ' ' + detail : ''}`);
}
function throws(name, fn) {
  let thrown = false;
  try { fn(); } catch (error) { thrown = true; }
  ok(name, thrown);
}

const pass = {
  passId: 'pass:25544:1', satId: '25544', norad: 25544,
  pathMode: 'adaptive', pathToleranceArcsec: 2,
  path: [
    { t: 1000, raDeg: 359.8, decDeg: 20 },
    { t: 2000, raDeg: 0.2, decDeg: 20 },
    { t: 3000, raDeg: 0.6, decDeg: 20 },
  ],
};
const originalPath = JSON.stringify(pass.path);
const calls = [];
const stars = {
  cone(raDeg, decDeg, radiusDeg, magLimit) {
    calls.push({ raDeg, decDeg, radiusDeg, magLimit });
    // The same star is returned by adjacent segment queries. The second star is
    // deliberately fainter so candidate-limit ordering is observable.
    return [
      { raDeg: 0.0, decDeg: 20.0, mag: 8.1 },
      { raDeg: 0.00001, decDeg: 20.00001, mag: 8.2 },
    ];
  },
};

console.log('\n[1] API, spherical envelope, RA wrap, and provenance');
const one = S.searchPass(pass, { corridorArcsec: 10, magLimit: 9 }, { stars });
ok('star-candidates API is attached', typeof S.searchPass === 'function' && typeof S.search === 'function');
ok('one cone query per adaptive segment', one.queryCount === 2 && calls.length === 2);
ok('RA wrap uses a midpoint near zero', calls[0].raDeg < 1 || calls[0].raDeg > 359,
  String(calls[0].raDeg));
near('first query includes half-segment plus padding', calls[0].radiusDeg * 3600,
  S.arcDeg({ x: Math.cos(20 * Math.PI / 180) * Math.cos(359.8 * Math.PI / 180),
    y: Math.cos(20 * Math.PI / 180) * Math.sin(359.8 * Math.PI / 180),
    z: Math.sin(20 * Math.PI / 180) },
  { x: Math.cos(20 * Math.PI / 180) * Math.cos(0.2 * Math.PI / 180),
    y: Math.cos(20 * Math.PI / 180) * Math.sin(0.2 * Math.PI / 180),
    z: Math.sin(20 * Math.PI / 180) }) * 1800 + 12, 0.05, 'arcsec');
ok('candidate records preserve pass id', one.candidates.every((row) => row.passId === pass.passId));
ok('duplicate star records are merged across segments', one.candidates.length === 2 && one.duplicateCount === 2);
ok('merged candidate retains source segment provenance', one.candidates[0].sourceSegments.length === 2 &&
  one.candidates[0].sourceSegments[0] === 0 && one.candidates[0].sourceSegments[1] === 1);
ok('verified adaptive path is complete', one.complete === true && one.flags.length === 0);
ok('input path is not mutated', JSON.stringify(pass.path) === originalPath);
ok('module does not create occultation state', SAT.state === undefined);

console.log('\n[2] Single-point and fallback-path semantics');
const single = S.searchPass({ passId: 'single', pathMode: 'adaptive', pathToleranceArcsec: 1,
  path: [{ t: 1, raDeg: 10, decDeg: -5 }] }, { corridorArcsec: 3 }, { stars });
ok('single-point path remains searchable', single.queryCount === 1 && single.queries[0].segmentArcsec === 0);
const raw = S.searchPass({ passId: 'raw', pathMode: 'raw-worker', path: pass.path },
  { corridorArcsec: 3 }, { stars });
ok('raw-worker path is marked precision-unverified', raw.complete === false &&
  raw.flags.includes('path-precision-unverified'));
const longRawPath = {
  passId: 'raw-long', pathMode: 'raw-worker',
  path: [0, 1, 2, 3, 4, 5].map((t) => ({ t: t * 1000, raDeg: 10 + t * 0.1, decDeg: 20 })),
};
const downsampledRaw = S.searchPass(longRawPath, { corridorArcsec: 3 }, { stars });
ok('long raw-worker paths use a bounded query representation',
  downsampledRaw.pathSampleCount === 4 && downsampledRaw.sourcePathSampleCount === 6 &&
  downsampledRaw.queryCount === 3 && downsampledRaw.flags.includes('raw-path-downsampled'));
ok('raw-path downsampling remains explicitly incomplete', downsampledRaw.complete === false);
const paddedRaw = S.searchPass({ passId: 'raw-padded', pathMode: 'raw-worker', path: pass.path },
  { corridorArcsec: 3, rawPathPaddingArcsec: 30 }, { stars });
ok('explicit raw-path padding restores completeness claim', paddedRaw.complete === true &&
  paddedRaw.pathToleranceArcsec === null && paddedRaw.pathPaddingArcsec === 30);

console.log('\n[3] Truncation, malformed data, and service failures');
const capped = S.searchPass(pass, { maxCandidates: 1 }, { stars });
ok('candidate cap is explicit', capped.candidates.length === 1 && capped.truncated &&
  capped.flags.includes('candidate-limit'));
const malformed = S.searchPass({ passId: 'bad', path: [{ t: 1, raDeg: 1, decDeg: 100 }] }, {}, { stars });
ok('malformed path returns an incomplete audit result', malformed.complete === false &&
  malformed.flags.includes('missing-path') && malformed.flags.includes('invalid-path-points'));
throws('missing star service is rejected', () => S.searchPass(pass, {}, { stars: null }));
const failingStars = { cone() { throw new Error('catalogue unavailable'); } };
const failed = S.searchPass(pass, {}, { stars: failingStars });
ok('cone failure is surfaced without a false empty claim', failed.complete === false &&
  failed.flags.includes('star-query-failed') && failed.queryCount === 2);

console.log('\n[4] Batch API and validation');
const batch = S.search({ passes: [pass], corridorArcsec: 4 }, { stars });
ok('batch API returns one audit result per pass', batch.results.length === 1 && batch.stats.passes === 1);
ok('batch API flattens candidates for later stages', batch.candidates.length === batch.results[0].candidates.length);
throws('negative corridor is rejected', () => S.searchPass(pass, { corridorArcsec: -1 }, { stars }));
throws('zero query budget is rejected', () => S.searchPass(pass, { maxQueries: 0 }, { stars }));

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
