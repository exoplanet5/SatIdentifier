/* Verification for app/js/crossings.js — run: node tools/test_crossings.js
 *
 * crossings.js is pure DOM, so this harness stands up just enough of a document for
 * SAT.util.el() to build a real tree, then drives the module the way a user does:
 * clicking column headers, editing SAT.state.filters, pressing the export buttons.
 * Assertions are made against the rendered table, not against module internals — the
 * module exposes only {init, refresh}, and the rendered rows are the thing that can
 * actually be wrong.
 *
 * SAT.state and SAT.bus are the REAL modules (state.js), because the interesting
 * question is whether the table and state.visibleCrossings() agree, and a
 * re-implemented fake filter would agree with itself by construction.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

/* ==================== minimal DOM ==================== */

function mkStyle() {
  return { cssText: '', display: '', width: '' };
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = mkStyle();
    this.attrs = {};
    this._h = {};
    this._text = '';
    this.className = '';
    this.classList = {
      add: c => { if (!this.className.split(/\s+/).includes(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: c => { this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      contains: c => this.className.split(/\s+/).includes(c),
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, fn) { (this._h[t] || (this._h[t] = [])).push(fn); }
  removeEventListener(t, fn) {
    if (this._h[t]) this._h[t] = this._h[t].filter(f => f !== fn);
  }
  _fire(t, ev) { (this._h[t] || []).forEach(fn => fn(ev || {})); }
  click() { this._fire('click'); }
  set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('');
  }
}

class TextNode {
  constructor(v) { this._v = String(v); this.parentNode = null; this.children = []; }
  get textContent() { return this._v; }
  set textContent(v) { this._v = String(v); }
}

global.window = global;
global.addEventListener = () => {};
global.document = {
  head: new El('head'),
  body: new El('body'),
  createElement: t => new El(t),
  createTextNode: v => new TextNode(v),
  getElementById: () => null,
};
global.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });

let clipboard = null;
// node ships a read-only `navigator` global, so a plain assignment is silently
// dropped and the clipboard path would look like it simply did nothing
Object.defineProperty(global, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: t => { clipboard = t; return Promise.resolve(); } } },
});

const blobs = [];
let objectUrls = 0;
global.Blob = class { constructor(parts, opts) { this.text = parts.join(''); this.opts = opts; blobs.push(this); } };
global.URL = { createObjectURL: () => { objectUrls++; return 'blob:test'; }, revokeObjectURL: () => {} };

/* dom search helpers */
function walk(node, out) {
  out = out || [];
  (node.children || []).forEach(c => { out.push(c); walk(c, out); });
  return out;
}
const byTag = (root, tag) => walk(root).filter(e => e.tagName === tag.toUpperCase());
const byClass = (root, cls) =>
  walk(root).filter(e => e.className && e.className.split(/\s+/).includes(cls));

/* ==================== load the app modules ==================== */

global.SAT = { ui: {} };
// satellite + frames are needed by the below-horizon empty state, which converts
// the pointing to alt/az over the scanned span through the real SAT.frames
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
require(path.join(APP, 'util.js'));
require(path.join(APP, 'frames.js'));
require(path.join(APP, 'state.js'));

let scanRuns = 0;
SAT.scan = {
  run: () => { scanRuns++; return Promise.resolve([]); },
  cancel: () => {},
  isRunning: () => false,
  estimate: () => 1.3e6,
};
let clockJumps = [];
SAT.clock = { setDate: d => clockJumps.push(d.getTime()), getDate: () => new Date(T0) };

require(path.join(APP, 'crossings.js'));

/* ==================== synthetic data ==================== */

const T0 = Date.UTC(2026, 6, 21, 22, 0, 0);
const CLASSES = ['leo', 'meo', 'geo', 'heo'];
const METHODS = ['qsmag', 'rcs', 'default'];
const SHADOWS = ['none', 'none', 'none', 'penumbra', 'umbra'];

// deterministic pseudo-random so a failure is reproducible
let seed = 20260721;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const N = 50;
const CROSSINGS = [];
for (let i = 0; i < N; i++) {
  const shadow = SHADOWS[i % SHADOWS.length];
  const enter = T0 + Math.floor(rnd() * 3600e3);
  const dur = 4000 + Math.floor(rnd() * 240e3);
  const method = METHODS[i % METHODS.length];
  // eclipsed objects have no magnitude — this is the null the sort must handle
  const magEst = shadow === 'umbra' ? null : Math.round((rnd() * 16 - 2) * 10) / 10;
  CROSSINGS.push({
    satId: 'o_' + (40000 + i * 7),
    norad: 40000 + i * 7,
    name: i === 3 ? 'SL-16 R/B "DEB", PIECE 1'          // comma + quote: the CSV case
      : (i === 9 ? "O'BRIEN\tTEST" : 'OBJECT ' + (40000 + i * 7)),
    intl: '2026-' + String(100 + i) + 'A',
    tEnterMs: enter,
    tCaMs: enter + Math.floor(dur / 2),
    tExitMs: enter + dur,
    sepCaDeg: Math.round(rnd() * 1000) / 1000,
    raDeg: Math.round(rnd() * 3600) / 10,
    decDeg: Math.round((rnd() * 180 - 90) * 10) / 10,
    azDeg: Math.round(rnd() * 3600) / 10,
    elDeg: Math.round(rnd() * 900) / 10,
    rangeKm: Math.round(400 + rnd() * 40000),
    rangeRateKmS: Math.round((rnd() * 10 - 5) * 100) / 100,
    // the two frames: sidereal (vs the stars) and mount (vs the horizon). GEO rows
    // get the pathological pair — ~15″/s sidereal, ~0″/s on a parked mount
    rateAsPerS: CLASSES[i % 4] === 'geo' ? 15.0 : Math.round(rnd() * 30000) / 10,
    paDeg: Math.round(rnd() * 3600) / 10,
    rateMountAsPerS: CLASSES[i % 4] === 'geo' ? 0.2 : Math.round(rnd() * 30000) / 10,
    paMountDeg: Math.round(rnd() * 3600) / 10,
    magEst: magEst,
    magMethod: magEst == null ? null : method,
    phaseDeg: Math.round(rnd() * 1800) / 10,
    shadow: shadow,
    // every 5th object gets stale elements (> 7 d), which the table must flag
    tleAgeDays: i % 5 === 0
      ? Math.round((8 + rnd() * 20) * 10) / 10
      : Math.round(rnd() * 50) / 10,
    tleSlopDeg: Math.round(rnd() * 100) / 100,
    cls: CLASSES[i % 4],
    sunElDeg: -20 + rnd() * 10,
    path: [{ t: enter, raDeg: 10, decDeg: 5 }, { t: enter + dur, raDeg: 10.1, decDeg: 5.1 }],
  });
}

/* ==================== state setup ==================== */

SAT.state.locations = [{ id: 'loc_t', name: 'Test', latDeg: 51.5, lonDeg: -0.1, altM: 40, active: true, color: '#f00' }];
SAT.state.catalog = { source: 'test', fetched: '2026-07-21T00:00:00Z', count: 27843, objs: CROSSINGS.map(c => ({ id: c.satId, norad: c.norad })) };
SAT.state.scan.crossings = CROSSINGS;
SAT.state.scan.ranAt = new Date(T0);
SAT.state.scan.stale = false;
// the shape scan.js actually publishes (mergeResults): rejected counts per stage
// PLUS the direct stage-1 survivor count
SAT.state.scan.culled = {
  // stage1 and survivors deliberately do NOT sum to total (12 objects had bad TLEs),
  // so this pins that the summary uses `survivors` rather than total - stage1
  total: 27843, bad: 12, stage1: 18231, stage2: 400, stage3: 20,
  survivors: 9600, candidates: 140,
};
SAT.state.save = () => {};   // no backend in this harness

// turn every column on so each one can be sorted
SAT.state.settings.columns = ['name', 'norad', 'intl', 'type', 'cls', 'enter', 'ca', 'exit',
  'dur', 'sep', 'radec', 'az', 'el', 'range', 'rate', 'pa', 'rateAlt', 'paAlt', 'mag',
  'method', 'sunlit', 'age'];
const NCOLS = SAT.state.settings.columns.length;   // 22 (round 4 added 'type')
SAT.state.obs.track = 'sky';

/* ==================== harness ==================== */

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || detail == null ? '' : '  <- ' + detail));
}
function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

const bodyEl = new El('div');

/* ---- table readers ---- */
function headerCells() { return byTag(byTag(bodyEl, 'thead')[0], 'th'); }
function headerLabels() { return headerCells().map(th => th.textContent.replace(/[ ▲▼]+$/, '')); }
function bodyRows() { return byTag(bodyEl, 'tbody')[0].children; }
function rowCells(tr) { return tr.children; }
function colIndex(label) { return headerLabels().indexOf(label); }
/** The crossing records currently rendered, in rendered order, resolved by NORAD. */
function renderedRecords() {
  const ix = colIndex('NORAD');
  return bodyRows().map(tr => {
    const n = parseInt(rowCells(tr)[ix].textContent, 10);
    return CROSSINGS.find(c => c.norad === n);
  });
}
function clickHeader(label) {
  const i = colIndex(label);
  if (i < 0) throw new Error('no column ' + label);
  headerCells()[i]._fire('click');
}
function findButton(text) {
  return byTag(bodyEl, 'button').find(b => b.textContent.indexOf(text) === 0);
}

/* ==================== [1] load + init ==================== */
console.log('\n[1] module parses, exposes {init, refresh}, initialises');
ok('SAT.ui.crossings exists', !!SAT.ui.crossings);
eq('typeof init', typeof SAT.ui.crossings.init, 'function');
eq('typeof refresh', typeof SAT.ui.crossings.refresh, 'function');
SAT.ui.crossings.init(bodyEl, { noScroll: false });
ok('root built', byClass(bodyEl, 'xin-root').length === 1);
// +1: the pick (checkbox) column renders a header cell but is a view control,
// not a data column — it is deliberately absent from sorting, toggling and export
eq('header columns rendered (data + pick)', headerCells().length, NCOLS + 1);
eq('rows rendered', bodyRows().length, N);
ok('style injected with xin- prefix',
  document.head.children.length === 1 && /\.xin-root/.test(document.head.children[0].textContent));
{
  const s = byClass(bodyEl, 'xin-summary')[0].textContent;
  ok('summary reports per-stage cull counts',
    /27.843 objects/.test(s) && /9.600 after geometry/.test(s) && /50 crossings/.test(s), s);
  ok('summary uses culled.survivors, not total - stage1 (which is 9 612 here)',
    s.indexOf('9612') < 0 && s.indexOf('9 612') < 0 && s.indexOf('9 612') < 0, s);
}
{
  // stale tag hidden now, shown once the parameters move
  const tag = byClass(bodyEl, 'xin-stale')[0];
  eq('stale tag hidden when fresh', tag.style.display, 'none');
  SAT.state.scan.stale = true;
  SAT.bus.emit('obs-changed', { field: 'raDeg' });
  eq('stale tag shown when scan.stale', tag.style.display, '');
  eq('stale tag text', tag.textContent, 'parameters changed — rescan');
  SAT.state.scan.stale = false;
  SAT.bus.emit('obs-changed', { field: 'raDeg' });
}

/* ==================== [1b] the Scan / Cancel button ==================== */
console.log('\n[1b] Scan button is the only path to SAT.scan.run()');
{
  const btn = findButton('Scan') || findButton('Cancel');
  ok('Scan button exists and is primary', !!btn && /primary/.test(btn.className), btn && btn.className);
  const before = scanRuns;
  btn._fire('click');
  eq('pressing Scan calls SAT.scan.run() exactly once', scanRuns - before, 1);

  // while a scan runs the same button cancels
  SAT.bus.emit('scan-started', {});
  eq('button becomes Cancel', btn.textContent, 'Cancel');
  ok('progress bar shown while running', byClass(bodyEl, 'xin-prog')[0].style.display === '');
  let cancels = 0;
  const realRunning = SAT.scan.isRunning, realCancel = SAT.scan.cancel;
  SAT.scan.isRunning = () => true;
  SAT.scan.cancel = () => cancels++;
  const runsMid = scanRuns;
  btn._fire('click');
  eq('pressing Cancel calls SAT.scan.cancel()', cancels, 1);
  eq('… and does NOT start another scan', scanRuns - runsMid, 0);
  SAT.scan.isRunning = realRunning;
  SAT.scan.cancel = realCancel;
  SAT.bus.emit('scan-done', { count: N, ms: 2340, truncated: false });
  eq('button returns to Scan', btn.textContent, 'Scan');
  ok('progress bar hidden when idle', byClass(bodyEl, 'xin-prog')[0].style.display === 'none');
}
{
  // a failed scan surfaces the error instead of leaving the button stuck
  SAT.bus.emit('scan-started', {});
  SAT.bus.emit('scan-failed', { error: new Error('worker died') });
  eq('scan-failed releases the button', (findButton('Scan') || {}).textContent, 'Scan');
  ok('scan-failed is reported, not swallowed',
    /worker died/.test(byClass(bodyEl, 'xin-warn').map(e => e.textContent).join(' ')));
  SAT.bus.emit('scan-done', { count: N, ms: 2340, truncated: false });
}

/* ==================== [2] sorting ==================== */
console.log('\n[2] sorting — every numeric column orders correctly, nulls last');

// label -> the underlying value, written independently of crossings.js's own COLS
const NUMERIC = {
  'NORAD': c => c.norad,
  'Enter (UTC)': c => c.tEnterMs,
  'CA (UTC)': c => c.tCaMs,
  'Exit': c => c.tExitMs,
  'Dur': c => c.tExitMs - c.tEnterMs,
  'Sep@CA': c => c.sepCaDeg,
  'RA/Dec (J2000)': c => c.raDeg,
  'Az': c => c.azDeg,
  'El': c => c.elDeg,
  'Range km': c => c.rangeKm,
  'Rate ″/s (sky)': c => c.rateAsPerS,
  'PA (sky)': c => c.paDeg,
  'Rate ″/s (mount)': c => c.rateMountAsPerS,
  'PA (mount)': c => c.paMountDeg,
  'Mag': c => c.magEst,
  'TLE age': c => c.tleAgeDays,
};

function checkOrder(label, get, asc) {
  const recs = renderedRecords();
  const vals = recs.map(get);
  const nulls = vals.filter(v => v == null).length;
  let bad = null;
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1], b = vals[i];
    if (a == null && b != null) { bad = 'null at ' + (i - 1) + ' before value at ' + i; break; }
    if (a == null || b == null) continue;
    if (asc ? b < a : b > a) { bad = 'row ' + (i - 1) + '=' + a + ' then row ' + i + '=' + b; break; }
  }
  ok(label + (asc ? ' ▲' : ' ▼') + (nulls ? ' (' + nulls + ' null)' : ''), bad === null, bad);
}

Object.keys(NUMERIC).forEach(label => {
  const get = NUMERIC[label];
  clickHeader(label);
  const recs1 = renderedRecords().map(get);
  const asc1 = isAsc(recs1);
  checkOrder(label, get, asc1);
  clickHeader(label);                      // second click flips direction
  const recs2 = renderedRecords().map(get);
  ok(label + ' second click reverses', isAsc(recs2) !== asc1 || allEqual(recs2),
    JSON.stringify(recs2.slice(0, 4)));
  checkOrder(label, get, isAsc(recs2));
});
function isAsc(vals) {
  const v = vals.filter(x => x != null);
  for (let i = 1; i < v.length; i++) if (v[i] < v[i - 1]) return false;
  return true;
}
function allEqual(vals) { const v = vals.filter(x => x != null); return v.every(x => x === v[0]); }

// the classic bug, stated explicitly: null magnitude must sink, never read as 0
console.log('\n[2b] null magnitude sorts last in BOTH directions (not as 0)');
{
  const nullCount = CROSSINGS.filter(c => c.magEst == null).length;
  ok('fixture has eclipsed objects with magEst === null', nullCount > 0, 'count ' + nullCount);
  // reset to a known direction: click until ascending
  clickHeader('Mag');
  let recs = renderedRecords();
  if (!isAsc(recs.map(c => c.magEst))) { clickHeader('Mag'); recs = renderedRecords(); }
  const tailA = recs.slice(N - nullCount);
  ok('ascending: the last ' + nullCount + ' rows are the null-mag rows',
    tailA.every(c => c.magEst == null));
  const minMag = Math.min.apply(null, CROSSINGS.filter(c => c.magEst != null).map(c => c.magEst));
  ok('ascending: first row is the brightest real magnitude, not a null',
    recs[0].magEst === minMag, 'got ' + recs[0].magEst + ' want ' + minMag);
  clickHeader('Mag');
  const recsD = renderedRecords();
  const tailD = recsD.slice(N - nullCount);
  ok('descending: the last ' + nullCount + ' rows are STILL the null-mag rows',
    tailD.every(c => c.magEst == null),
    JSON.stringify(tailD.map(c => c.magEst)));
  const maxMag = Math.max.apply(null, CROSSINGS.filter(c => c.magEst != null).map(c => c.magEst));
  ok('descending: first row is the faintest real magnitude',
    recsD[0].magEst === maxMag, 'got ' + recsD[0].magEst + ' want ' + maxMag);
  // and the guess marker
  const magIx = colIndex('Mag');
  const guessRow = renderedRecords().findIndex(c => c.magMethod === 'default');
  const cell = rowCells(bodyRows()[guessRow])[magIx];
  ok("method 'default' magnitudes are marked as a guess (~ and .xin-guess)",
    cell.textContent.indexOf('~') === 0 && /xin-guess/.test(cell.className),
    cell.textContent + ' / ' + cell.className);
  const realRow = renderedRecords().findIndex(c => c.magMethod === 'qsmag');
  ok("method 'qsmag' magnitudes are NOT marked",
    rowCells(bodyRows()[realRow])[magIx].textContent.indexOf('~') < 0);
}

// text columns sort too
console.log('\n[2c] text columns');
clickHeader('Name');
{
  const names = renderedRecords().map(c => c.name);
  const sorted = names.slice().sort((a, b) => a.localeCompare(b));
  ok('Name ▲ is locale-sorted', JSON.stringify(names) === JSON.stringify(sorted));
}

/* ==================== [2d] TLE age column ==================== */
console.log('\n[2d] TLE age — the per-row confidence number');
{
  ok('TLE age is a default-visible column', colIndex('TLE age') >= 0);
  clickHeader('TLE age');
  let recs = renderedRecords();
  if (!isAsc(recs.map(c => c.tleAgeDays))) { clickHeader('TLE age'); recs = renderedRecords(); }
  const ageIx = colIndex('TLE age');
  const oldRow = recs.findIndex(c => c.tleAgeDays > 7);
  const freshRow = recs.findIndex(c => c.tleAgeDays <= 7);
  ok('fixture has both fresh and stale elements', oldRow >= 0 && freshRow >= 0);
  const oldCell = rowCells(bodyRows()[oldRow])[ageIx];
  ok('elements over a week old are flagged (.xin-old)', /xin-old/.test(oldCell.className),
    oldCell.className);
  ok('… and fresh ones are not',
    !/xin-old/.test(rowCells(bodyRows()[freshRow])[ageIx].className));
  ok('cell prints the age in days', /^\d+(\.\d)? d$/.test(oldCell.textContent), oldCell.textContent);
  ok('tooltip carries the scan search slop when present',
    /Search slop applied/.test(oldCell.attrs.title || ''), oldCell.attrs.title);
}

/* ==================== [3] filters ==================== */
console.log('\n[3] filters — SAT.state.visibleCrossings drives the table, and never rescans');

clickHeader('CA (UTC)');   // back to a stable order
const runsBefore = scanRuns;

function applyFilter(patch, name) {
  Object.assign(SAT.state.filters, patch);
  SAT.bus.emit('filters-changed', {});
  const want = SAT.state.visibleCrossings().length;
  eq(name + ' -> row count', bodyRows().length, want);
  return want;
}

function reset() {
  SAT.state.filters.maxMag = 99;
  SAT.state.filters.sunlitOnly = false;
  SAT.state.filters.minRateAsPerS = 0;
  SAT.state.filters.maxRateAsPerS = 0;
  SAT.state.filters.classes = { leo: true, meo: true, geo: true, heo: true };
  SAT.state.filters.search = '';
  SAT.bus.emit('filters-changed', {});
}

reset();
eq('unfiltered rows', bodyRows().length, N);

{
  const n = applyFilter({ maxMag: 6 }, 'maxMag 6');
  ok('maxMag excludes null magnitudes (eclipsed are not "bright")',
    renderedRecords().every(c => c.magEst != null && c.magEst <= 6));
  ok('maxMag actually removed rows', n < N, 'kept ' + n);
  reset();
}
{
  applyFilter({ sunlitOnly: true }, 'sunlitOnly');
  ok('only shadow === none survives', renderedRecords().every(c => c.shadow === 'none'));
  reset();
}
{
  applyFilter({ classes: { leo: true, meo: false, geo: false, heo: false } }, 'class chips leo-only');
  ok('only leo rows', renderedRecords().every(c => c.cls === 'leo'));
  reset();
}
{
  applyFilter({ minRateAsPerS: 500, maxRateAsPerS: 2000 }, 'rate 500..2000');
  ok('rate band respected',
    renderedRecords().every(c => c.rateAsPerS >= 500 && c.rateAsPerS <= 2000));
  reset();
}
{
  applyFilter({ search: '40021' }, 'search "40021"');
  ok('search matches NORAD', renderedRecords().every(c => String(c.norad).indexOf('40021') >= 0));
  applyFilter({ search: 'SL-16' }, 'search "SL-16"');
  ok('search matches name', renderedRecords().every(c => /SL-16/i.test(c.name)));
  reset();
}
{
  // combined, and the empty state that names the fix
  applyFilter({ maxMag: -5, search: 'nothing-matches-this' }, 'impossible filter');
  const empty = byClass(bodyEl, 'msg-empty')[0];
  ok('filtered-to-nothing empty state names the filter controls',
    /hidden by the filters/.test(empty.textContent) && /Clear the magnitude limit/.test(empty.textContent),
    empty.textContent);
  reset();
}
eq('filtering triggered ZERO scans', scanRuns - runsBefore, 0);

/* ---- the filter widgets themselves write state and emit, without scanning ---- */
{
  let emitted = 0;
  const h = () => emitted++;
  SAT.bus.on('filters-changed', h);
  const sunBox = byTag(bodyEl, 'INPUT').find(i => i.attrs.type === 'checkbox' && i.parentNode &&
    String(i.parentNode.textContent).indexOf('sunlit only') >= 0);
  sunBox.checked = true;
  sunBox._fire('change');
  eq('sunlit checkbox wrote SAT.state.filters', SAT.state.filters.sunlitOnly, true);
  ok("sunlit checkbox emitted 'filters-changed'", emitted === 1, 'emits ' + emitted);
  eq('… and still no rescan', scanRuns - runsBefore, 0);
  SAT.bus.off('filters-changed', h);
  reset();
}

/* ---- class chips ---- */
{
  const chip = byClass(bodyEl, 'xin-chip').find(c => c.textContent === 'geo' && c._h.click);
  chip._fire('click');
  eq('geo chip toggled state.filters.classes.geo', SAT.state.filters.classes.geo, false);
  eq('geo rows gone', bodyRows().length, SAT.state.visibleCrossings().length);
  ok('no geo rows rendered', renderedRecords().every(c => c.cls !== 'geo'));
  chip._fire('click');
  reset();
}

/* ==================== [4] row interaction ==================== */
console.log('\n[4] row interaction');
{
  const tr = bodyRows()[2];
  const rec = renderedRecords()[2];
  let selected = null;
  SAT.bus.on('selection-changed', p => { selected = p.satId; });
  tr._fire('click');
  eq('row click selects the object', selected, rec.satId);

  clockJumps = [];
  bodyRows()[2]._fire('dblclick');
  eq('row double-click jumps the clock to tCaMs', clockJumps[0], rec.tCaMs);

  let hovered = 'unset';
  SAT.bus.on('crossing-hover', p => { hovered = p.satId; });
  bodyRows()[2]._fire('mouseenter');
  eq('row hover emits crossing-hover', hovered, rec.satId);
  eq('… and parks it on SAT.state.hoverSatId for the chart', SAT.state.hoverSatId, rec.satId);
  bodyRows()[2]._fire('mouseleave');
  eq('row unhover clears it', SAT.state.hoverSatId, null);
  SAT.state.setSelection(null);
}

/* ==================== [4b] the two angular rates ==================== */
console.log('\n[4b] Rate / PA follow SAT.state.obs.track and name their frame');
{
  const geo = CROSSINGS.find(c => c.cls === 'geo');
  ok('fixture GEO row has the pathological pair (15″/s sky vs 0.2″/s mount)',
    geo.rateAsPerS === 15 && geo.rateMountAsPerS === 0.2);

  // resolved off the rendered NORAD cell, so it works for records that are not in
  // the CROSSINGS fixture (the orphan row below)
  function cellFor(rec, label) {
    const ix = colIndex(label), nix = colIndex('NORAD');
    if (ix < 0) return null;
    const tr = bodyRows().find(r => rowCells(r)[nix].textContent === String(rec.norad));
    return tr ? rowCells(tr)[ix].textContent : null;
  }

  // ---- track 'sky' ----
  SAT.state.obs.track = 'sky';
  SAT.bus.emit('obs-changed', { field: 'track' });
  ok('sky: header names the sidereal frame', colIndex('Rate ″/s (sky)') >= 0 && colIndex('PA (sky)') >= 0);
  ok('sky: the other frame is offered as its own column',
    colIndex('Rate ″/s (mount)') >= 0 && colIndex('PA (mount)') >= 0);
  eq('sky: Rate cell shows rateAsPerS', cellFor(geo, 'Rate ″/s (sky)'), '15.0');
  eq('sky: the alt column shows rateMountAsPerS', cellFor(geo, 'Rate ″/s (mount)'), '0.2');
  eq('sky: PA cell shows paDeg', cellFor(geo, 'PA (sky)'), geo.paDeg.toFixed(1) + '°');

  // ---- track 'mount' ----
  SAT.state.obs.track = 'mount';
  SAT.bus.emit('obs-changed', { field: 'track' });
  ok('mount: headers relabel to the mount frame',
    colIndex('Rate ″/s (mount)') >= 0 && colIndex('PA (mount)') >= 0);
  eq('mount: Rate cell now shows rateMountAsPerS', cellFor(geo, 'Rate ″/s (mount)'), '0.2');
  eq('mount: the alt column shows rateAsPerS', cellFor(geo, 'Rate ″/s (sky)'), '15.0');
  eq('mount: PA cell shows paMountDeg', cellFor(geo, 'PA (mount)'), geo.paMountDeg.toFixed(1) + '°');

  // a Crossing with no mount rate must blank, never fall back to the sidereal value
  const orphan = Object.assign({}, geo, { norad: 999001, satId: 'orphan', rateMountAsPerS: undefined, paMountDeg: undefined });
  SAT.state.scan.crossings = CROSSINGS.concat([orphan]);
  SAT.ui.crossings.refresh();
  eq('missing rateMountAsPerS renders as — (never the sky value)', cellFor(orphan, 'Rate ″/s (mount)'), '—');
  eq('missing paMountDeg renders as —', cellFor(orphan, 'PA (mount)'), '—');
  SAT.state.scan.crossings = CROSSINGS;

  // the filter tests rateAsPerS (sky) whatever the track: the column it filters
  // must therefore be on screen
  SAT.state.settings.columns = SAT.state.settings.columns.filter(k => k !== 'rateAlt');
  SAT.ui.crossings.refresh();
  eq('mount + no rate filter: sky column hidden as asked', colIndex('Rate ″/s (sky)'), -1);
  SAT.state.filters.minRateAsPerS = 100;
  SAT.bus.emit('filters-changed', {});
  ok('mount + rate filter: the filtered (sky) column is forced visible',
    colIndex('Rate ″/s (sky)') >= 0, headerLabels().join(' | '));
  ok('the rows kept are the ones matching the SKY rate',
    renderedRecords().every(c => c.rateAsPerS >= 100));
  ok('… and the GEO rows (15″/s sky) are gone despite a 0.2″/s mount rate',
    renderedRecords().every(c => c.cls !== 'geo'));
  SAT.state.filters.minRateAsPerS = 0;
  SAT.bus.emit('filters-changed', {});
  eq('clearing the filter drops the forced column again', colIndex('Rate ″/s (sky)'), -1);

  SAT.state.settings.columns.push('rateAlt');
  SAT.state.obs.track = 'sky';
  SAT.bus.emit('obs-changed', { field: 'track' });
  eq('back to sky, full column set (+pick)', headerCells().length, NCOLS + 1);
}

/* ==================== [5] export ==================== */
console.log('\n[5] export — CSV quoting, TSV, JSON');
{
  const nasty = CROSSINGS[3];
  ok('fixture name contains a comma and a quote',
    nasty.name.indexOf(',') >= 0 && nasty.name.indexOf('"') >= 0, nasty.name);

  blobs.length = 0;
  objectUrls = 0;
  findButton('CSV')._fire('click');
  eq('CSV blob produced', blobs.length, 1);
  eq('CSV download completed client-side (object URL handed to an <a download>)', objectUrls, 1);
  eq('the temporary anchor was removed from the document', document.body.children.length, 0);
  const csv = blobs[0].text;
  const lines = csv.split('\r\n');
  const line = lines.find(l => l.indexOf('SL-16') >= 0);
  ok('CSV row for the nasty name exists', !!line, 'lines ' + lines.length);
  eq('CSV row count = header + visible rows', lines.length, bodyRows().length + 1);
  const wantField = '"SL-16 R/B ""DEB"", PIECE 1"';
  ok('CSV quotes the field and doubles the inner quotes',
    line.indexOf(wantField) === 0, line.slice(0, 60));

  // and it round-trips: a correct parse yields the original name back
  function parseCsvLine(s) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  const fields = parseCsvLine(line);
  eq('CSV round-trips the name unchanged', fields[0], nasty.name);
  const noradIx = lines[0].split(',').indexOf('NORAD');
  eq('… and the NORAD column did not shift', fields[noradIx], String(nasty.norad));

  // a name containing a bare quote but no comma still gets quoted
  const line9 = lines.find(l => l.indexOf('BRIEN') >= 0);
  ok('tab inside a name does not break CSV', !!line9);

  blobs.length = 0;
  findButton('JSON')._fire('click');
  eq('JSON blob produced', blobs.length, 1);
  const j = JSON.parse(blobs[0].text);
  eq('JSON carries every visible crossing', j.crossings.length, bodyRows().length);
  eq('JSON preserves the raw name', j.crossings.find(c => c.norad === nasty.norad).name, nasty.name);
  ok('JSON keeps the path samples', Array.isArray(j.crossings[0].path));

  clipboard = null;
  findButton('Copy TSV')._fire('click');
  ok('TSV copied to the clipboard', typeof clipboard === 'string' && clipboard.length > 0);
  const tsvHead = clipboard.split('\n')[0].split('\t');
  eq('TSV header matches the visible DATA columns (pick excluded)',
  tsvHead.length, headerCells().length - 1);
  ok('embedded tab in a name is neutralised', clipboard.split('\n').every(l => l.split('\t').length === tsvHead.length),
    'a row has a different field count');
}

/* ==================== [6] columns + empty states ==================== */
console.log('\n[6] column visibility and the remaining empty states');
{
  const boxes = byTag(byClass(bodyEl, 'xin-cols')[0], 'INPUT');
  eq('one checkbox per column', boxes.length, NCOLS);
  const before = headerCells().length;
  boxes[11].checked = false;               // 'az' (index moved when 'type' arrived)
  boxes[11]._fire('change');
  eq('unticking a column removes its header', headerCells().length, before - 1);
  ok('settings.columns persisted as an array (state.js cannot merge a null object)',
    Array.isArray(SAT.state.settings.columns) && SAT.state.settings.columns.indexOf('az') < 0);
  boxes[11].checked = true;
  boxes[11]._fire('change');
  eq('re-ticking restores it', headerCells().length, before);
}
{
  const savedCrossings = SAT.state.scan.crossings;
  const savedRanAt = SAT.state.scan.ranAt;

  SAT.state.scan.crossings = [];
  SAT.state.scan.ranAt = null;
  SAT.ui.crossings.refresh();
  ok('empty state: not scanned yet names Scan',
    /Not scanned yet/.test(byClass(bodyEl, 'msg-empty')[0].textContent));

  SAT.state.scan.ranAt = new Date(T0);
  SAT.ui.crossings.refresh();
  ok('empty state: scanned but genuinely empty names FOV/timespan',
    /nothing crossed this field/.test(byClass(bodyEl, 'msg-empty')[0].textContent));

  const savedObjs = SAT.state.catalog.objs;
  SAT.state.catalog.objs = [];
  SAT.ui.crossings.refresh();
  ok('empty state: no catalogue names the Sources window',
    /Sources window/.test(byClass(bodyEl, 'msg-empty')[0].textContent));

  const savedLocs = SAT.state.locations;
  SAT.state.locations = [];
  SAT.ui.crossings.refresh();
  ok('empty state: no site names the Locations window',
    /Locations window/.test(byClass(bodyEl, 'msg-empty')[0].textContent));

  SAT.state.locations = savedLocs;
  SAT.state.catalog.objs = savedObjs;
  SAT.state.scan.crossings = savedCrossings;
  SAT.state.scan.ranAt = savedRanAt;
  SAT.ui.crossings.refresh();
  eq('restored', bodyRows().length, SAT.state.visibleCrossings().length);
}
{
  // the below-horizon zero must explain itself instead of advising a wider FOV.
  // Dec -80 from Greenwich (lat +51.5) culminates at el = 90 - |51.5 - (-80)| =
  // -41.5 — never up, whatever the hour angle, so the whole span is below.
  const o = SAT.state.obs;
  const saved = { mode: o.mode, raDeg: o.raDeg, decDeg: o.decDeg, spanMin: o.spanMin };
  const savedCross = SAT.state.scan.crossings, savedParams = SAT.state.scan.params;
  o.mode = 'radec'; o.raDeg = 100; o.decDeg = -80; o.spanMin = 60;
  SAT.state.scan.crossings = [];
  SAT.state.scan.params = { t0Ms: T0 };   // horizonHint keys off the scanned t0
  SAT.ui.crossings.refresh();
  const msg = byClass(bodyEl, 'msg-empty')[0].textContent;
  ok('empty state: below-horizon pointing (El < 0 all span) names the horizon',
    /below the horizon/.test(msg), msg);
  ok('… does NOT give the useless "widen the FOV" advice', !/Widen the FOV/.test(msg), msg);
  ok('… and reports the peak elevation through real SAT.frames',
    /peaks at -\d+\.\d°/.test(msg), msg);
  Object.assign(o, saved);
  SAT.state.scan.crossings = savedCross;
  SAT.state.scan.params = savedParams;
  SAT.ui.crossings.refresh();
  eq('restored after horizon test', bodyRows().length, SAT.state.visibleCrossings().length);
}
{
  // truncation notice
  SAT.bus.emit('scan-started', {});
  SAT.bus.emit('scan-progress', { done: 4000, total: 9612, phase: 'coarse' });
  const ptxt = byClass(bodyEl, 'xin-prog-txt').map(e => e.textContent).join(' ');
  ok('progress bar shows done/total and the phase', /coarse/.test(ptxt) && /4.000\/9.612/.test(ptxt), ptxt);
  SAT.bus.emit('scan-done', { count: N, ms: 2340, truncated: true });
  const warn = byClass(bodyEl, 'xin-warn').map(e => e.textContent).join(' ');
  ok('truncation is announced, never silent', /Truncated at/.test(warn), warn);
  const s = byClass(bodyEl, 'xin-summary')[0].textContent;
  ok('summary shows elapsed seconds', / in 2\.3 s/.test(s), s);
}
{
  // render cap
  const many = [];
  for (let i = 0; i < 1200; i++) many.push(Object.assign({}, CROSSINGS[i % N], { norad: 900000 + i, satId: 'x' + i }));
  SAT.state.scan.crossings = many;
  SAT.ui.crossings.refresh();
  eq('render cap applied', bodyRows().length, 400);
  const cap = byClass(bodyEl, 'xin-warn').map(e => e.textContent).join(' ');
  ok('cap is announced as "showing first N of M"',
    /showing first 400 of 1.200/.test(cap), cap);
  SAT.state.scan.crossings = CROSSINGS;
  SAT.ui.crossings.refresh();
}

/* ==================== summary ==================== */
console.log('\n' + (failures ? '✗ ' + failures + ' FAILED' : '✓ all passed') +
  ' — ' + checks + ' checks\n');
process.exit(failures ? 1 : 0);
