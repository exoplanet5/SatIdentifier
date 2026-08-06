/* Verification for scan-time SatIdentifier tag/type filtering.
 * Run: node tools/test_satellite_filters.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
global.satellite = require(path.join(__dirname, '..', 'app', 'js', 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
const worker = require(path.join(__dirname, '..', 'app', 'js', 'worker', 'scan-worker.js'));
const file = path.join(__dirname, 'fixtures', 'mini_catalog.tle');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const objects = [];
for (let i = 0; i + 2 < lines.length; i += 3) {
  const l1 = lines[i + 1], l2 = lines[i + 2];
  if (!l1 || l1[0] !== '1' || !l2 || l2[0] !== '2') continue;
  const norad = Number(l2.slice(2, 7));
  objects.push({ id: 'o_' + norad, norad: norad, name: lines[i].trim(), intl: '',
    l1: l1, l2: l2, rcs: null, stdMag: null, type: 'PAY' });
}

function params(filters) {
  return {
    t0Ms: Date.parse('2026-07-20T12:25:40Z'), spanMin: 60,
    site: { kind: 'ground', latDeg: 43.9, lonDeg: -103.5, altM: 1200 },
    pointing: { track: 'sky', mode: 'radec', raDeg: 260, decDeg: 35, refract: true },
    fov: { shape: 'circ', rDeg: 30, wDeg: 0, hDeg: 0, rotDeg: 0 },
    filters: Object.assign({ minElDeg: 0 }, filters || {}),
    steps: { coarseStepS: 30, fineStepS: 1, marginDeg: 0 },
  };
}

(async () => {
  worker.loadObjs(objects);
  const baseline = await worker.runScan(params());
  assert.ok(baseline.crossings.length, 'fixture should produce a baseline crossing');
  const selectedId = baseline.crossings[0].satId;
  const selectedClass = baseline.crossings[0].cls;
  objects.forEach((object) => {
    object.type = object.id === selectedId ? 'DEB' : 'PAY';
  });
  worker.loadObjs(objects);

  const filtered = await worker.runScan(params({ classes: [selectedClass], types: ['DEB'] }));
  assert.ok(filtered.crossings.length, 'selected object should remain searchable');
  assert.ok(filtered.crossings.every((crossing) => crossing.satId === selectedId &&
    crossing.cls === selectedClass && crossing.type === 'DEB'));

  const filteredWithoutStage1 = await worker.runScan(Object.assign(
    params({ classes: [selectedClass], types: ['DEB'] }), { useStage1: false }));
  assert.deepStrictEqual(
    filteredWithoutStage1.crossings.map((crossing) => crossing.satId + '@' + crossing.tCaMs),
    filtered.crossings.map((crossing) => crossing.satId + '@' + crossing.tCaMs));
  console.log('scan classification-tag/type filters passed');
})().catch((error) => { console.error(error); process.exit(1); });
