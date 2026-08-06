/* Integration verification for P0-04 adaptive paths in passes.js.
 * Run: node tools/test_passes_adaptive.js
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

const START = 100000;
const END = 200000;
const sourceCrossing = {
  satId: 'adaptive-1', norad: 1, name: 'ADAPTIVE TEST', intl: '2026-001A',
  tEnterMs: START, tExitMs: END, tCaMs: 150000,
  sepCaDeg: 20, elDeg: 70, rangeKm: 700, shadow: 'none',
  path: [
    { t: START, raDeg: 359, decDeg: 20 },
    { t: END, raDeg: 1, decDeg: 20 },
  ],
};
const object = { id: 'adaptive-1', norad: 1, l1: '1 TEST', l2: '2 TEST' };

function trajectory(t) {
  const f = (t - START) / (END - START);
  return {
    raDeg: 359 + 2 * f + 0.18 * Math.sin(Math.PI * f),
    decDeg: 20 + 0.12 * Math.sin(Math.PI * f),
  };
}

global.SAT = {
  occultation: {
    night: { windowsForDate: () => [{ startMs: START, endMs: END, kind: 'normal' }] },
  },
  scan: {
    runRaw: async () => ({
      crossings: [sourceCrossing],
      culled: { total: 1, bad: 0, stage1: 0, stage2: 0, stage3: 0, survivors: 1, candidates: 1 },
      truncated: false, propagations: 1, ms: 1,
    }),
  },
  state: { getObj: (id) => id === object.id ? object : null },
  prop: {
    look: (site, obj, date) => {
      if (site.kind !== 'ground' || obj !== object) return null;
      const x = (date.getTime() - 150000) / 1000;
      const exact = trajectory(date.getTime());
      return Object.assign({
        elDeg: 75 - 0.0002 * x * x,
        rangeKm: 650 + Math.abs(x),
        shadow: 'none',
      }, exact);
    },
  },
};

require(path.join(APP, 'occultation', 'adaptive-path.js'));
require(path.join(APP, 'occultation', 'passes.js'));
const P = SAT.occultation.passes;

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

(async () => {
  console.log('\n[1] adaptive pass integration');
  const result = await P.discover({
    site: { latDeg: -37.8, lonDeg: 145, altM: 30 },
    localDate: '2026-07-23', timeZone: 'Australia/Melbourne',
    minimumElevationDeg: 20, pathToleranceArcsec: 1, pathMaxSamples: 128,
  });
  const pass = result.passes[0];
  ok('discover returns one pass', result.passes.length === 1);
  ok('pass uses the adaptive path mode', pass.pathMode === 'adaptive');
  ok('adaptive path refines the raw seed', pass.path.length > sourceCrossing.path.length);
  ok('path tolerance and measured error are explicit',
    pass.pathToleranceArcsec === 1 && pass.pathWorstErrorArcsec <= 1,
    String(pass.pathWorstErrorArcsec));
  ok('uncapped adaptive path is not truncated',
    pass.pathTruncated === false && !pass.flags.includes('adaptive-path-truncated'));
  ok('raw crossing provenance is preserved without mutation',
    pass.sourceCrossing === sourceCrossing && sourceCrossing.path.length === 2 &&
    sourceCrossing.path[0].raDeg === 359);
  ok('adaptive configuration is returned to the caller',
    result.config.pathToleranceArcsec === 1 && result.config.pathMaxSamples === 128);

  console.log('\n[2] explicit path budget');
  const capped = await P.discover({
    site: { latDeg: 0, lonDeg: 0 }, localDate: '2026-07-23', timeZone: 'UTC',
    minimumElevationDeg: 20, pathToleranceArcsec: 1, pathMaxSamples: 2,
  });
  const cappedPass = capped.passes[0];
  ok('capped path obeys the maximum sample count', cappedPass.path.length <= 2);
  ok('capped path surfaces truncation',
    cappedPass.pathTruncated === true && cappedPass.flags.includes('adaptive-path-truncated'));

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
