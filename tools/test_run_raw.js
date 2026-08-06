/* Verification for app/js/scan.js — the isolated raw worker-pool API.
 * Run: node tools/test_run_raw.js
 *
 * This harness uses a deterministic Worker double so it can test orchestration
 * without starting a browser. The production worker protocol is already covered
 * by test_scan.js; this file checks the boundary that test_scan.js cannot see:
 * raw result merging, the shared run lock/cancel path, event namespacing, and the
 * guarantee that SAT.state.scan is untouched.
 */
const assert = require('assert');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

global.window = global;

const events = [];
const listeners = new Map();
const bus = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  },
  off(name, fn) {
    if (listeners.has(name)) listeners.get(name).delete(fn);
  },
  emit(name, payload) {
    events.push({ name: name, payload: payload });
    if (listeners.has(name)) listeners.get(name).forEach(fn => fn(payload));
  },
};

const objects = [
  { id: 'o_1', norad: 1, name: 'ONE', intl: null, l1: 'l1', l2: 'l2' },
  { id: 'o_2', norad: 2, name: 'TWO', intl: null, l1: 'l1', l2: 'l2' },
  { id: 'o_3', norad: 3, name: 'THREE', intl: null, l1: 'l1', l2: 'l2' },
];

const originalCrossings = [{ satId: 'old', tCaMs: 1 }];
const originalChecked = new Set(['old']);
const originalRanAt = new Date('2026-08-05T00:00:00Z');
const originalParams = { untouched: true };
const originalCulled = { untouched: true };

global.SAT = {
  ui: {},
  bus: bus,
  state: {
    settings: {
      scan: { coarseStepS: 30, fineStepS: 1, marginDeg: 0, workers: 2, maxCrossings: 5 },
    },
    catalog: { objs: objects },
    obs: {
      mode: 'radec', raDeg: 10, decDeg: 20, azDeg: 180, elDeg: 60,
      track: 'sky', fovShape: 'circ', fovWDeg: 2, fovHDeg: 2, fovRDeg: 1,
      rotDeg: 0, spanMin: 1,
    },
    filters: { minElDeg: 0 },
    scan: {
      crossings: originalCrossings,
      ranAt: originalRanAt,
      stale: true,
      params: originalParams,
      culled: originalCulled,
      checked: originalChecked,
    },
    activeLocation: () => ({ name: 'Test site', latDeg: 0, lonDeg: 0, altM: 0 }),
    resolvedSite: loc => Object.assign({ kind: 'ground' }, loc),
  },
  clock: { getDate: () => new Date('2026-08-05T00:00:00Z') },
};

const workerCalls = [];
let workerNumber = 0;
const crossingSets = [
  [
    { satId: 'o_1', tCaMs: 300 },
    { satId: 'o_1', tCaMs: 100 },
  ],
  [
    { satId: 'o_2', tCaMs: 200 },
    { satId: 'o_3', tCaMs: 400 },
  ],
];

class FakeWorker {
  constructor(url) {
    this.url = url;
    this.index = workerNumber++;
    this.onmessage = null;
    this.onerror = null;
    this.cancelled = false;
    this.scanToken = 0;
    workerCalls.push({ worker: this.index, cmd: 'construct', url: url });
  }

  send(data) {
    if (this.onmessage) this.onmessage({ data: data });
  }

  postMessage(message) {
    workerCalls.push({ worker: this.index, cmd: message.cmd, params: message.params });
    if (message.cmd === 'load') {
      setTimeout(() => this.send({ type: 'loaded', count: message.objs.length, bad: 0 }), 0);
      return;
    }
    if (message.cmd === 'cancel') {
      this.cancelled = true;
      return;
    }
    if (message.cmd !== 'scan') return;

    this.cancelled = false;
    const token = ++this.scanToken;
    setTimeout(() => {
      if (token !== this.scanToken) return;
      if (this.cancelled) {
        this.send({ type: 'result', cancelled: true, crossings: [], culled: null });
        return;
      }
      this.send({ type: 'progress', done: 1, total: 2, phase: 'coarse' });
    }, 1);
    setTimeout(() => {
      if (token !== this.scanToken) return;
      if (this.cancelled) {
        this.send({ type: 'result', cancelled: true, crossings: [], culled: null });
        return;
      }
      this.send({ type: 'progress', done: 2, total: 2, phase: 'fine' });
      this.send({
        type: 'result',
        crossings: crossingSets[this.index],
        culled: {
          total: 2, bad: 0, stage1: this.index + 1, stage2: 0, stage3: 0,
          survivors: 1, candidates: 1,
        },
        propagations: 10 + this.index,
      });
    }, 10);
  }

  terminate() { this.scanToken++; }
}

global.Worker = FakeWorker;
require(path.join(APP, 'scan.js'));

const PARAMS = {
  t0Ms: Date.parse('2026-08-05T00:00:00Z'), spanMin: 1,
  site: { kind: 'ground', latDeg: 0, lonDeg: 0, altM: 0 },
  pointing: { track: 'sky', raDeg: 10, decDeg: 20 },
  fov: { shape: 'circ', rDeg: 70 },
  filters: { minElDeg: 20 },
  steps: { coarseStepS: 30, fineStepS: 1, marginDeg: 0 },
};

function names() { return events.map(e => e.name); }

(async () => {
  console.log('\n[1] raw result and state isolation');
  const stateScanRef = SAT.state.scan;
  const checkedRef = SAT.state.scan.checked;
  const raw = await SAT.scan.runRaw(PARAMS, { maxResults: 3, eventPrefix: 'occultation' });

  assert.deepStrictEqual(raw.crossings.map(c => c.tCaMs), [100, 200, 300]);
  assert.strictEqual(raw.truncated, true);
  assert.strictEqual(raw.propagations, 21);
  assert.strictEqual(raw.culled.stage1, 3);
  assert.strictEqual(typeof raw.ms, 'number');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(raw.crossings[0], 'magEst'), false);
  assert.strictEqual(SAT.state.scan, stateScanRef);
  assert.strictEqual(SAT.state.scan.crossings, originalCrossings);
  assert.strictEqual(SAT.state.scan.ranAt, originalRanAt);
  assert.strictEqual(SAT.state.scan.params, originalParams);
  assert.strictEqual(SAT.state.scan.culled, originalCulled);
  assert.strictEqual(SAT.state.scan.checked, checkedRef);
  assert.deepStrictEqual([...SAT.state.scan.checked], ['old']);
  assert.deepStrictEqual(names().filter(n => n.startsWith('scan-')), []);
  assert.deepStrictEqual(
    names().filter(n => n.startsWith('occultation-')).filter((n, i, a) => a.indexOf(n) === i),
    ['occultation-started', 'occultation-progress', 'occultation-done'],
  );
  console.log('  PASS  raw merge, event namespace, and SAT.state.scan isolation');

  console.log('\n[2] shared run lock and cancellation');
  const locked = SAT.scan.runRaw(PARAMS, { eventPrefix: null });
  await assert.rejects(
    SAT.scan.runRaw(PARAMS, { eventPrefix: null }),
    /already running/,
  );
  await locked;
  assert.strictEqual(SAT.scan.isRunning(), false);

  const cancelled = SAT.scan.runRaw(PARAMS, { eventPrefix: 'occultation' });
  setTimeout(() => SAT.scan.cancel(), 2);
  await assert.rejects(cancelled, /Raw scan cancelled/);
  assert.strictEqual(SAT.scan.isRunning(), false);
  assert.ok(names().includes('occultation-failed'));
  console.log('  PASS  raw scan shares the lock and cancel path');

  console.log('\n[3] ordinary run remains stateful and uses ordinary events');
  const ordinary = await SAT.scan.run();
  assert.strictEqual(ordinary.length, 4);
  assert.strictEqual(SAT.state.scan.stale, false);
  assert.strictEqual(SAT.state.scan.crossings.length, 4);
  assert.strictEqual(SAT.state.scan.checked.size, 0);
  assert.ok(SAT.state.scan.params);
  assert.ok(names().includes('scan-started'));
  assert.ok(names().includes('scan-progress'));
  assert.ok(names().includes('scan-done'));
  console.log('  PASS  ordinary run state and event behavior');

  const loads = workerCalls.filter(c => c.cmd === 'load');
  const scans = workerCalls.filter(c => c.cmd === 'scan');
  assert.strictEqual(loads.length, 2, 'pool should load once per worker');
  assert.ok(scans.length >= 8, 'raw and ordinary runs should reuse the pool');
  assert.strictEqual(scans[0].params.maxCrossings, 3);
  console.log('  PASS  existing worker pool reused across raw and ordinary runs');

  console.log('\nall raw scan checks passed\n');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
