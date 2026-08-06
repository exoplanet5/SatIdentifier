/* Verification for app/js/occultation/passes.js — P0-03 pass normalization.
 * Run: node tools/test_passes.js
 *
 * The night and raw-scan services are deterministic doubles here. The real
 * worker protocol is covered by test_scan.js and test_run_raw.js; this harness
 * checks the P0-03 boundary between those services and SatellitePass output.
 */
const assert = require('assert');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

const window = { startMs: 100000, endMs: 200000, kind: 'normal', sunAltitudeLimitDeg: -12 };
const calls = [];
let lookCalls = 0;
const sourceCrossing = {
  satId: 'o_1', norad: 1, name: 'TEST SAT', intl: '2026-001A',
  cls: 'leo', type: 'PAY',
  tEnterMs: 95000, tExitMs: 205000, tCaMs: 150000,
  sepCaDeg: 25, azDeg: 123, elDeg: 65, rangeKm: 600, shadow: 'penumbra',
  sunElDeg: -18, tleAgeDays: -4, cls: 'leo',
  path: [
    { t: 100000.4, raDeg: 10, decDeg: -20 },
    { t: 150000.4, raDeg: 11, decDeg: -19 },
    { t: 200000.4, raDeg: 12, decDeg: -18 },
  ],
};

const object = { id: 'o_1', norad: 1, l1: '1 TEST', l2: '2 TEST', type: 'PAY' };
global.SAT = {
  occultation: {
    night: {
      windowsForDate(input) {
        calls.push({ kind: 'night', input: input });
        return [window];
      },
    },
  },
  scan: {
    runRaw: async (params, options) => {
      calls.push({ kind: 'scan', params: params, options: options });
      return {
        crossings: [sourceCrossing, { satId: 'broken', tEnterMs: 1 }],
        culled: { total: 5, bad: 1, stage1: 2, stage2: 1, stage3: 0, survivors: 1, candidates: 1 },
        truncated: false, propagations: 123, ms: 7,
      };
    },
  },
  state: {
    getObj(id) { return id === object.id ? object : null; },
  },
  prop: {
    look(site, obj, date) {
      lookCalls++;
      assert.strictEqual(site.kind, 'ground');
      assert.strictEqual(obj, object);
      const x = (date.getTime() - 151234) / 1000;
      return {
        azDeg: 124,
        elDeg: 75 - 0.0002 * x * x,
        rangeKm: 500 + 0.1 * Math.abs(x),
        shadow: 'none',
      };
    },
    classOf(obj) { return obj === object ? 'leo' : null; },
    tleAgeDays(obj, date) {
      assert.strictEqual(obj, object);
      assert.ok(date instanceof Date);
      return -4;
    },
  },
};
require(path.join(APP, 'occultation', 'passes.js'));
const P = SAT.occultation.passes;

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

(async () => {
  console.log('\n[1] API and zenith scan contract');
  ok('passes API is attached', !!P && typeof P.discover === 'function');
  const input = {
    site: { latDeg: -37.8, lonDeg: 145.0, altM: 30 },
    localDate: '2026-07-23', timeZone: 'Australia/Melbourne',
    sunAltitudeLimitDeg: -12, minimumElevationDeg: 20,
    coarseStepS: 15, fineStepS: 0.5, maxResults: 123,
    passOptions: { classes: ['leo'], types: ['PAY'] },
  };
  const scanParams = P.buildScanParameters(input, window);
  ok('zenith mount pointing is explicit',
    scanParams.pointing.track === 'mount' && scanParams.pointing.elDeg === 90);
  ok('minimum elevation maps to the complementary FOV radius',
    scanParams.fov.shape === 'circ' && scanParams.fov.rDeg === 70 &&
    scanParams.filters.minElDeg === 20 &&
    scanParams.filters.classes[0] === 'leo' && scanParams.filters.types[0] === 'PAY');
  const mixedTagParams = P.buildScanParameters(Object.assign({}, input, {
    passOptions: { tags: ['leo', 'payload'] },
  }), window);
  ok('mixed scan labels map to the worker class/type filters',
    mixedTagParams.filters.classes[0] === 'leo' && mixedTagParams.filters.types[0] === 'PAY');
  ok('night UTC interval becomes the worker span',
    scanParams.t0Ms === window.startMs && scanParams.spanMin === 100 / 60);
  ok('P0-03 does not add star or probability parameters',
    scanParams.stars === undefined && scanParams.probability === undefined);

  console.log('\n[2] raw scan consumption and SatellitePass normalization');
  const result = await P.discover(input);
  const scanCall = calls.find((x) => x.kind === 'scan');
  ok('night service receives the selected date and IANA zone',
    calls[0].kind === 'night' && calls[0].input.localDate === input.localDate &&
    calls[0].input.timeZone === input.timeZone);
  ok('runRaw receives a ground zenith scan',
    !!scanCall && scanCall.params.site.kind === 'ground' &&
    scanCall.params.pointing.elDeg === 90 && scanCall.params.fov.rDeg === 70);
  ok('runRaw receives the caller result cap and scoped events',
    scanCall.options.maxResults === 123 && scanCall.options.eventPrefix === 'occultation');
  ok('one malformed raw crossing is rejected', result.stats.rejected === 1 && result.passes.length === 1);
  const pass = result.passes[0];
  ok('pass boundaries are clipped to the night window',
    pass.startMs === window.startMs && pass.endMs === window.endMs);
  ok('culmination is ordered inside the pass',
    pass.startMs <= pass.culminationMs && pass.culminationMs <= pass.endMs,
    String(pass.culminationMs));
  ok('culmination uses SAT.prop.look() maximum elevation',
    Math.abs(pass.culminationMs - 151234) <= 2 && Math.abs(pass.maxElevationDeg - 75) < 1e-6);
  ok('pass metadata is normalized',
    pass.satId === sourceCrossing.satId && pass.norad === 1 && pass.orbitClass === 'leo' &&
    pass.cls === 'leo' && pass.type === 'PAY' && pass.azDeg === 124 && pass.elDeg === 75 &&
    pass.tleAgeDays === 4 && pass.minRangeKm < 501 && pass.shadowAtCulmination === 'none');
  ok('path remains raw-worker data and is not treated as adaptive',
    pass.pathMode === 'raw-worker' && pass.path.length === 3 &&
    pass.path[0].t === 100000 && pass.pathToleranceArcsec === null &&
    pass.pathTruncated === false);
  ok('source crossing is retained for provenance', pass.sourceCrossing === sourceCrossing);
  ok('discover does not create occultation state', SAT.state.occultation === undefined);
  ok('discovery statistics preserve raw scan accounting',
    result.stats.propagations === 123 && result.stats.ms === 7 &&
    result.stats.culled.stage1 === 2 && result.status === 'ok');

  console.log('\n[2b] large-result cooperative fallback');
  const beforeDeferredLookCalls = lookCalls;
  const deferred = await P.discover(Object.assign({}, input, { exactPassLimit: 0 }));
  ok('large-result fallback retains the raw worker path',
    deferred.stats.deferred === 1 && deferred.stats.exactRefined === 0 &&
    deferred.passes[0].pathMode === 'raw-worker' &&
    deferred.passes[0].flags.indexOf('adaptive-path-deferred') >= 0);
  ok('deferred normalization does not call the main-thread look evaluator',
    lookCalls === beforeDeferredLookCalls);
  ok('deferred discovery compacts duplicated raw audit paths',
    deferred.stats.rawAuditCompacted === true &&
    deferred.rawResults[0].raw.rawCrossingsOmitted === true &&
    deferred.rawResults[0].raw.crossings.length === 0 &&
    deferred.passes[0].sourceCrossing.path.length === 0 &&
    deferred.passes[0].sourceCrossing.pathOmittedFromAudit === true);

  console.log('\n[3] isolation and validation');
  const noNightCalls = calls.length;
  SAT.occultation.night.windowsForDate = () => [];
  const noNight = await P.discover(input);
  ok('no-night dates skip raw scanning', noNight.status === 'no-night' &&
    noNight.passes.length === 0 && calls.length === noNightCalls);
  throws('orbit site is rejected explicitly', () => P.buildScanParameters(
    Object.assign({}, input, { site: { kind: 'orbit', norad: 1 } }), window));
  throws('minimum elevation outside the physical range is rejected', () => P.buildScanParameters(
    Object.assign({}, input, { minimumElevationDeg: 91 }), window));
  throws('non-positive worker step is rejected', () => P.buildScanParameters(
    Object.assign({}, input, { coarseStepS: 0 }), window));

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
