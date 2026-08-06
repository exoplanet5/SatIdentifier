/* Verification for the large-result cooperative P0-11 path.
 * Run: node tools/test_cooperative_occultation.js
 *
 * The test uses deterministic star and propagation services. It checks that
 * the asynchronous star search and event assembly preserve the synchronous
 * scientific results while exposing progress and explicit cancellation.
 */
const path = require('path');

const APP = path.join(__dirname, '..', 'app', 'js');
const object = { id: 'sat-cooperative', norad: 1, name: 'COOPERATIVE SAT' };
const lookCalls = [];

global.SAT = {
  occultation: {},
  state: {
    getObj: (id) => id === object.id ? object : null,
  },
  prop: {
    look(site, obj, date) {
      lookCalls.push({ site: site, object: obj, date: date });
      if (obj !== object) return null;
      const seconds = (date.getTime() - 1000) / 1000;
      return { raDeg: 10 + 0.1 * seconds, decDeg: 0, rangeKm: 1000, shadow: 'none' };
    },
  },
  bus: { emit() {} },
};

require(path.join(APP, 'occultation', 'event-state.js'));
require(path.join(APP, 'occultation', 'star-candidates.js'));
const E = SAT.occultation.eventState;
const S = SAT.occultation.starCandidates;
const site = { kind: 'ground', latDeg: -37.8, lonDeg: 145, altM: 30 };

function passFor(index) {
  return {
    passId: 'pass:cooperative:' + index, satId: object.id, norad: object.norad,
    name: object.name, startMs: 0, culminationMs: 1000, endMs: 2000,
    pathMode: 'adaptive', pathToleranceArcsec: 1,
    path: [
      { t: 0, raDeg: 9.9, decDeg: 0 },
      { t: 2000, raDeg: 10.1, decDeg: 0 },
    ],
  };
}

const passes = Array.from({ length: 20 }, (_, index) => passFor(index));
const stars = {
  cone() { return [{ raDeg: 10, decDeg: 0, mag: 5, starId: 'star-1' }]; },
};
let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

async function rejectsWithCode(promise, code) {
  try {
    await promise;
    return false;
  } catch (error) {
    return error && error.pipelineCode === code;
  }
}

(async function () {
  console.log('\n[1] Cooperative star search');
  const searchProgress = [];
  const search = await S.searchAsync({ passes: passes, corridorArcsec: 1 }, { stars: stars }, {
    onProgress: (payload) => searchProgress.push(payload),
  });
  ok('async search preserves one audit result per pass',
    search.status === 'ok' && search.results.length === passes.length &&
    search.candidates.length === passes.length);
  ok('async search reports progress',
    searchProgress.length >= 2 && searchProgress[0].done === 1 &&
    searchProgress[searchProgress.length - 1].done === passes.length);
  ok('async search keeps the verified-path completeness claim',
    search.results.every((result) => result.complete === true));

  const compactSearch = await S.searchAsync({ passes: passes.slice(0, 3), corridorArcsec: 1,
    maxTotalCandidates: 1, retainQueries: false, retainSourcePass: false }, { stars: stars });
  ok('large-search candidate retention is globally bounded and explicit',
    compactSearch.status === 'partial' && compactSearch.candidates.length === 1 &&
    compactSearch.stats.candidateLimitReached === true &&
    compactSearch.stats.candidateMatches === 3);
  ok('large-search audit compaction drops duplicated query/pass graphs',
    compactSearch.stats.auditCompacted === true && compactSearch.results[0].queries.length === 0 &&
    compactSearch.results[0].sourcePass === null);
  const compactBuilt = await E.buildAsync({ site: site, passes: passes.slice(0, 3), search: compactSearch }, {
    defaultRadiusM: 1,
  }, { state: SAT.state, prop: SAT.prop, refine: SAT.occultation.refine });
  ok('compacted search results still bind candidates through the pass list',
    compactBuilt.events.length === 1 && compactBuilt.events[0].passId === passes[0].passId);

  console.log('\n[2] Cooperative event refinement');
  const eventProgress = [];
  const built = await E.buildAsync({ site: site, passes: passes, search: search }, {
    defaultRadiusM: 1,
  }, { state: SAT.state, prop: SAT.prop, refine: SAT.occultation.refine }, {
    onProgress: (payload) => eventProgress.push(payload),
  });
  ok('async event assembly preserves all candidates',
    built.events.length === passes.length && built.stats.events === passes.length);
  ok('async event assembly reports progress',
    eventProgress.length >= 2 && eventProgress[0].done === 1 &&
    eventProgress[eventProgress.length - 1].done === passes.length);
  ok('event refinement still uses SAT.prop.look()', lookCalls.length > 0);

  console.log('\n[3] Explicit cancellation');
  ok('star search cancellation is explicit', await rejectsWithCode(
    S.searchAsync({ passes: passes }, { stars: stars }, { shouldCancel: () => true }), 'cancelled'));
  ok('event refinement cancellation is explicit', await rejectsWithCode(
    E.buildAsync({ site: site, passes: passes, search: search }, {},
      { state: SAT.state, prop: SAT.prop, refine: SAT.occultation.refine },
      { shouldCancel: () => true }), 'cancelled'));

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
