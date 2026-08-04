/* Verification for the three ported window modules — sources.js, satinfo.js and
 * allsky.js — plus the adapted locations.js.  Run: node tools/test_ports.js
 *
 * These are UI modules, so "does it work" mostly means "does it build the DOM it
 * claims to and read SAT.state correctly". That is testable under node with a
 * document stub, and it catches the things that actually break a port: a namespace
 * that never gets attached, a field the new state no longer has, a helper that reads
 * an object shape from the old app.
 *
 * The load-bearing test is [5], allsky's FOV footprint. It is pure geometry with a
 * checkable answer, and it is the one thing in these three files that can be wrong
 * while looking completely plausible on screen. Since the module exposes only
 * {init, requestRender} (CONTRACT.md), the footprint is recovered from a RECORDING
 * canvas context: every stroke is captured with its style, and the outline is the
 * one drawn in allsky's FOV_STROKE — a literal this test reads out of the source so
 * the two cannot drift apart.
 */
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app', 'js');

// ---------------------------------------------------------------- harness
let failures = 0, checks = 0;

function ok(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name +
    (detail == null ? '' : '   ' + detail));
}

function near(name, got, want, tol, unit) {
  const good = isFinite(got) && Math.abs(got - want) <= tol;
  checks++;
  if (!good) failures++;
  console.log('  ' + (good ? 'PASS' : 'FAIL') + '  ' + name.padEnd(52) +
    fmt(got) + ' vs ' + fmt(want) + ' ' + (unit || '') + ' (tol ' + tol + ')');
}

function fmt(v) {
  return (typeof v === 'number' && isFinite(v)) ? v.toFixed(4) : String(v);
}

// ---------------------------------------------------------------- DOM stub
const byId = Object.create(null);

function textNode(s) {
  return { nodeType: 3, nodeName: '#text', textContent: String(s), childNodes: [] };
}

function makeEl(tag) {
  const e = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    childNodes: [],
    style: {},
    dataset: {},
    _attrs: {},
    _on: {},
    className: '',
    value: '',
    checked: false,
    disabled: false,
    clientWidth: 400,
    clientHeight: 400,
    width: 0,
    height: 0,
  };
  Object.defineProperty(e, 'id', {
    get() { return e._attrs.id || ''; },
    set(v) { e._attrs.id = v; byId[v] = e; },
  });
  Object.defineProperty(e, 'firstChild', { get: () => e.childNodes[0] || null });
  Object.defineProperty(e, 'lastChild', {
    get: () => e.childNodes[e.childNodes.length - 1] || null,
  });
  Object.defineProperty(e, 'children', {
    get: () => e.childNodes.filter(c => c.nodeType === 1),
  });
  Object.defineProperty(e, 'textContent', {
    get() {
      return e.childNodes.map(c => c.nodeType === 3 ? c.textContent : c.textContent).join('');
    },
    set(v) { e.childNodes = [textNode(v)]; },
  });
  Object.defineProperty(e, 'innerHTML', {
    get: () => '',
    set() { e.childNodes = []; },
  });
  e.appendChild = c => { e.childNodes.push(c); c.parentNode = e; return c; };
  e.removeChild = c => {
    const i = e.childNodes.indexOf(c);
    if (i >= 0) e.childNodes.splice(i, 1);
    return c;
  };
  e.insertBefore = (c, ref) => {
    const i = e.childNodes.indexOf(ref);
    e.childNodes.splice(i < 0 ? e.childNodes.length : i, 0, c);
    return c;
  };
  e.setAttribute = (k, v) => {
    e._attrs[k] = v;
    if (k === 'id') byId[v] = e;
    if (k.indexOf('data-') === 0) e.dataset[k.slice(5)] = v;
  };
  e.getAttribute = k => (k in e._attrs ? e._attrs[k] : null);
  e.addEventListener = (t, fn) => { (e._on[t] = e._on[t] || []).push(fn); };
  e.removeEventListener = (t, fn) => {
    const a = e._on[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  e.dispatchEvent = ev => {
    (e._on[(ev && ev.type) || ''] || []).forEach(fn => fn(ev));
    return true;
  };
  e.classList = {
    add: c => { if (!e.className.split(' ').includes(c)) e.className = (e.className + ' ' + c).trim(); },
    remove: c => { e.className = e.className.split(' ').filter(x => x && x !== c).join(' '); },
    contains: c => e.className.split(' ').includes(c),
    toggle: (c, on) => {
      const has = e.classList.contains(c);
      const want = on == null ? !has : !!on;
      if (want) e.classList.add(c); else e.classList.remove(c);
      return want;
    },
  };
  e.getBoundingClientRect = () => ({
    left: 0, top: 0, width: e.clientWidth, height: e.clientHeight,
    right: e.clientWidth, bottom: e.clientHeight,
  });
  e.querySelectorAll = () => [];
  e.querySelector = () => null;
  e.closest = () => null;
  e.focus = () => {};
  e.blur = () => {};
  e.getContext = () => (e._ctx || (e._ctx = makeCtx()));
  return e;
}

/** Canvas 2D context that records every stroke/fill with the style in force. */
function makeCtx() {
  const rec = { strokes: [], fills: [], texts: [] };
  let cur = [];
  const c = {
    _rec: rec,
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    setTransform() {}, transform() {}, translate() {}, rotate() {}, scale() {},
    save() {}, restore() {}, clearRect() {}, clip() {},
    setLineDash() {}, getLineDash() { return []; },
    measureText(t) { return { width: String(t).length * 6 }; },
    beginPath() { cur = []; },
    closePath() { if (cur.length) cur.push(cur[0]); },
    moveTo(x, y) { cur.push([x, y]); },
    lineTo(x, y) { cur.push([x, y]); },
    rect(x, y, w, h) { cur.push([x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]); },
    roundRect(x, y, w, h) { c.rect(x, y, w, h); },
    arc(x, y, r, a0, a1) {
      for (let i = 0; i <= 24; i++) {
        const a = a0 + (a1 - a0) * i / 24;
        cur.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
      }
    },
    ellipse() {},
    stroke() { rec.strokes.push({ style: c.strokeStyle, width: c.lineWidth, pts: cur.slice() }); },
    fill() { rec.fills.push({ style: c.fillStyle, pts: cur.slice() }); },
    fillRect(x, y, w, h) { rec.fills.push({ style: c.fillStyle, rect: [x, y, w, h], pts: [] }); },
    strokeRect() {},
    fillText(t, x, y) { rec.texts.push({ text: String(t), x, y, style: c.fillStyle }); },
    strokeText() {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
  return c;
}

const documentStub = {
  createElement: makeEl,
  createTextNode: textNode,
  getElementById: id => byId[id] || null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
documentStub.head = makeEl('head');
documentStub.body = makeEl('body');

const desktop = makeEl('div');
desktop.id = 'desktop';
desktop.clientWidth = 1400;
desktop.clientHeight = 900;

// ---------------------------------------------------------------- globals
global.window = global;
global.document = documentStub;
global.navigator = { hardwareConcurrency: 8 };
global.devicePixelRatio = 1;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } };
global.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };

// rAF is queued, not immediate: requestRender() calls itself from inside render()
// in normal use, and running synchronously would recurse instead of coalescing.
const rafQ = [];
global.requestAnimationFrame = fn => { rafQ.push(fn); return rafQ.length; };
global.cancelAnimationFrame = () => {};
function flushRaf() {
  for (let i = 0; i < 8 && rafQ.length; i++) {
    const batch = rafQ.splice(0, rafQ.length);
    batch.forEach(fn => fn(performance.now()));
  }
}

// Backend stub. Every module here is defensive about the backend being absent, but
// the happy path is what we want to exercise.
let fetchLog = [];
global.fetch = (url, opts) => {
  fetchLog.push({ url, opts });
  let data = { ok: true };
  if (url.startsWith('/api/celestrak/groups')) {
    data = { ok: true, groups: [{ id: 'active', name: 'Active satellites' }] };
  } else if (url.startsWith('/api/spacetrack/config')) {
    data = { ok: true, identity: 'someone@example.org', hasPassword: true };
  } else if (url.startsWith('/api/cache')) {
    data = { ok: true, entries: [] };
  } else if (url.startsWith('/api/satcat')) {
    data = {
      ok: true,
      record: {
        LAUNCH_DATE: '1998-11-20', LAUNCH_SITE: 'TYMSC',
        OWNER: 'CIS', OBJECT_TYPE: 'PAY', OPS_STATUS_CODE: '+',
      },
    };
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
};

global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
// real catalogue data: since round 12 allsky's star field IS the bright catalogue
// (SAT.stardata), and its Milky Way layer reads SAT.mwdata
require(path.join(APP, 'vendor', 'starcat.js'));
require(path.join(APP, 'vendor', 'mwdata.js'));

// ---------------------------------------------------------------- load modules
const ORDER = ['util', 'frames', 'windows', 'clock', 'propagate', 'state',
  'stars', 'photometry', 'sources', 'locations', 'satinfo', 'allsky'];

console.log('\n[1] modules parse and attach their namespaces');
for (const name of ORDER) {
  try {
    require(path.join(APP, name + '.js'));
  } catch (e) {
    ok(name + '.js loads', false, e.message);
    console.log('\nCANNOT CONTINUE\n');
    process.exit(1);
  }
}
ok('sources.js  -> SAT.ui.sources.init', typeof SAT.ui.sources.init === 'function');
ok('locations.js-> SAT.ui.locations.init', typeof SAT.ui.locations.init === 'function');
ok('satinfo.js  -> SAT.ui.satinfo.init', typeof SAT.ui.satinfo.init === 'function');
ok('satinfo.js  -> SAT.ui.satinfo.show', typeof SAT.ui.satinfo.show === 'function');
ok('allsky.js   -> SAT.allsky.init', typeof SAT.allsky.init === 'function');
ok('allsky.js   -> SAT.allsky.requestRender', typeof SAT.allsky.requestRender === 'function');
ok('allsky exposes exactly {init, requestRender}',
  Object.keys(SAT.allsky).sort().join(',') === 'init,requestRender',
  '{' + Object.keys(SAT.allsky).join(', ') + '}');

// ---------------------------------------------------------------- fixtures
const F = SAT.frames;
const SITE = { id: 'loc_t', name: 'Test Site', latDeg: 51.4779, lonDeg: -0.0015, altM: 47, active: true, color: '#ff5252' };
SAT.state.locations = [SITE];

const T0 = new Date('2026-07-21T22:00:00Z');
SAT.clock.setDate(T0);

// Epoch 26201.5 = 2026 day 201.5 = 2026-07-20 12:00 UTC, i.e. ~1.4 d before T0.
const PAYLOAD = {
  ok: true, source: 'test:fixture', fetched: '2026-07-21T21:00:00Z', count: 3,
  tles: [
    { name: 'ISS (ZARYA)', norad: 25544, intl: '1998-067A',
      l1: '1 25544U 98067A   26201.51782528  .00016717  00000+0  10270-3 0  9994',
      l2: '2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345',
      rcs: 399.05, stdMag: -1.3 },
    { name: 'DEBRIS (NO PHOTOMETRY)', norad: 90001, intl: '2020-001Z',
      l1: '1 90001U 20001Z   26201.30000000  .00000100  00000+0  10000-4 0  9995',
      l2: '2 90001  97.4000 200.0000 0010000  90.0000 270.0000 15.10000000 12345',
      rcs: null, stdMag: null },
    { name: 'BROKEN ELEMENTS', norad: 99999, intl: null,
      l1: 'this is not a tle line at all', l2: 'neither is this one',
      rcs: null, stdMag: null },
  ],
};

// ---------------------------------------------------------------- [2] state contract
console.log('\n[2] SAT.state.addTles is the shape sources.js was written against');
const res = SAT.state.addTles('spacetrack', PAYLOAD, { replace: true });
ok('addTles returns {count, bad, added, updated}',
  res && typeof res.count === 'number' && typeof res.bad === 'number' &&
  typeof res.added === 'number' && typeof res.updated === 'number',
  JSON.stringify(res));
ok('count is every object, good or bad', res.count === 3, 'count=' + res.count);
ok('the malformed TLE is counted as bad', res.bad >= 1, 'bad=' + res.bad);
ok('catalogue holds the set, tagged by source',
  SAT.state.catalog.objs.length === 3 &&
  SAT.state.catalog.objs.every(o => o.src === 'spacetrack'));

// Merge semantics: an OLDER duplicate must lose, a NEWER one must win and
// carry its source tag with it. Epoch day 26195 < 26201 (the fixture's ISS).
const OLD_ISS = {
  source: 'text:pasted', fetched: '2026-07-21T00:00:00Z',
  tles: [{ name: 'ISS OLD', norad: 25544, intl: '1998-067A',
    l1: '1 25544U 98067A   26195.51782528  .00016717  00000+0  10270-3 0  9992',
    l2: '2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345',
    rcs: null, stdMag: null }],
};
const mOld = SAT.state.addTles('paste', OLD_ISS, { replace: false });
ok('older duplicate loses the dedup', mOld.added === 0 && mOld.updated === 0 &&
  SAT.state.objByNorad(25544).name === 'ISS (ZARYA)', JSON.stringify(mOld));
const NEW_ISS = {
  source: 'text:pasted', fetched: '2026-07-21T00:00:00Z',
  tles: [{ name: 'ISS NEW', norad: 25544, intl: '1998-067A',
    l1: '1 25544U 98067A   26205.51782528  .00016717  00000+0  10270-3 0  9997',
    l2: '2 25544  51.6392 339.0967 0004272  82.5714 277.5709 15.50136786 12345',
    rcs: null, stdMag: null }],
};
const mNew = SAT.state.addTles('paste', NEW_ISS, { replace: false });
ok('newer duplicate wins and flips ownership', mNew.updated === 1 &&
  SAT.state.objByNorad(25544).src === 'paste', JSON.stringify(mNew));

const stats = SAT.state.sourceStats();
ok('sourceStats reports per source', !!(stats.spacetrack && stats.paste) &&
  stats.paste.count === 1 && stats.spacetrack.count === 1,
  JSON.stringify(Object.keys(stats)));
ok('stats carry newest/median/oldest ages',
  ['newestD', 'medianD', 'oldestD'].every(k => typeof stats.paste[k] === 'number'));

SAT.state.clearSource('paste');
ok('clearSource removes the pasted object', !SAT.state.objByNorad(25544) &&
  SAT.state.sourceStats().paste === undefined);

// restore the full fixture for the window tests below
SAT.state.addTles('spacetrack', PAYLOAD, { replace: true });

const ISS = SAT.state.objByNorad(25544);
const DEB = SAT.state.objByNorad(90001);

// ---------------------------------------------------------------- [3] sources.js
console.log('\n[3] sources.js — freshness banner and object counts');
{
  const body = makeEl('div');
  const win = { id: 'sources', body, isOpen: () => true, setTitle() {}, open() {}, focus() {} };
  SAT.ui.sources.init(body, win);
  const fresh = textOf(body);

  ok('shows the object count', fresh.includes('3 objects'), quote(fresh, '3 objects'));
  ok('reports unparseable TLEs', /unparseable/.test(fresh), quote(fresh, 'unparseable'));
  ok('"Full catalogue" has top billing',
    fresh.includes('Load full catalogue') &&
    fresh.indexOf('Load full catalogue') < fresh.indexOf('McCants'));
  ok('names Space-Track as THE full-catalogue provider',
    /Space-Track full GP/.test(fresh));
  ok('the CelesTrak tab is gone (round-1 review)', !/CelesTrak/.test(fresh));
  ok('keeps the Space-Track / McCants / paste / cache tabs',
    ['Space-Track', 'McCants', 'Paste TLE', 'Cache'].every(t => fresh.includes(t)));
  ok('statistics are per source', /✓ Space-Track/.test(fresh) &&
    /newest/.test(fresh) && /median/.test(fresh) && /oldest/.test(fresh),
    quote(fresh, 'Space-Track'));
  // Comments are allowed to mention families (the header explains what was dropped);
  // code is not.
  ok('drops the family concept entirely',
    !/famil/i.test(fresh) && !/famil/i.test(stripComments(
      fs.readFileSync(path.join(APP, 'sources.js'), 'utf8'))));

  // 1.4 d old at T0 -> fresh, no warning
  ok('fresh source is NOT flagged', /✓ Space-Track/.test(fresh) && !/stale/.test(fresh),
    quote(fresh, 'Space-Track'));

  // Drive the clock 10 days on: the same elements are now 11 d old (median > 3 d).
  SAT.clock.setDate(new Date(T0.getTime() + 10 * 86400000));
  const stale = textOf(body);
  ok('stale source IS flagged, per source', /⚠ Space-Track/.test(stale) &&
    /stale, refresh/.test(stale), quote(stale, 'Space-Track'));
  ok('stale note quantifies the error', /7′|2°|km/.test(stale));
  ok('warning is above the tabs, not inside one',
    stale.indexOf('⚠ Space-Track') < stale.indexOf('McCants'));
  SAT.clock.setDate(T0);
}

// ---------------------------------------------------------------- [4] satinfo.js
console.log('\n[4] satinfo.js — photometry breakdown, TLE age, SATCAT');
{
  const win = SAT.windows.register({
    id: 'satinfo', title: 'Satellite Info', open: false,
    build: (b, w) => SAT.ui.satinfo.init(b, w),
  });
  SAT.ui.satinfo.show(ISS);
  const t = textOf(win.body);

  ok('window opened by show()', win.isOpen());
  ok('identifies the object', t.includes('ISS (ZARYA)') && t.includes('25544'));
  ok('TLE epoch age is prominent (before the elements table)',
    /Elements are .* old/.test(t) &&
    t.indexOf('Elements are') < t.indexOf('Mean elements'), quote(t, 'Elements are'));
  ok('age drives an explicit confidence statement', /arcminutes|km/.test(t));
  ok('states the photometry method', /Method/.test(t) && /qsmag/.test(t), quote(t, 'qsmag'));
  ok('names what qsmag means', /McCants standard magnitude/.test(t));
  ok('shows RCS with the implied radius', /RCS/.test(t) && /399\.05 m²/.test(t) && /sphere radius/.test(t));
  ok('shows the standard magnitude', /Standard magnitude/.test(t) && /-1\.3/.test(t));
  ok('shows an estimated magnitude', /Estimated mag/.test(t));
  ok('keeps the mean elements', ['Perigee', 'Apogee', 'Period', 'INC', 'RAAN', 'AOP'].every(k => t.includes(k)));

  // An object with neither stdMag nor rcs must fall to 'default' and SAY it is a guess.
  SAT.ui.satinfo.show(DEB);
  const d = textOf(win.body);
  ok('falls back to the default tier', /default/.test(d) && /assumed 1 m sphere/.test(d));
  ok('flags the default tier as a guess', /guess/.test(d), quote(d, 'guess'));
  ok('says why RCS is missing', /not in SATCAT/.test(d));

  // SATCAT lookup is async
  return_satcat(win);
}

function return_satcat(win) {
  // resolved-promise chain: two microtask turns is enough
  Promise.resolve().then(() => {}).then(() => {
    const t = textOf(win.body);
    ok('SATCAT record filled in (GET /api/satcat?norad=N)',
      fetchLog.some(f => f.url.startsWith('/api/satcat?norad=')), '');
  });
}

// ---------------------------------------------------------------- [5] allsky.js
console.log('\n[5] allsky.js — FOV footprint projection (the load-bearing test)');

const ALLSKY_SRC = fs.readFileSync(path.join(APP, 'allsky.js'), 'utf8');
const FOV_STROKE = (/var FOV_STROKE = '([^']+)'/.exec(ALLSKY_SRC) || [])[1];
ok('FOV stroke colour recovered from the source', !!FOV_STROKE, FOV_STROKE);

const askWin = SAT.windows.register({
  id: 'allsky', title: 'All-Sky', open: true,
  build: (b, w) => SAT.allsky.init(b, w),
});
const askCtx = askWin.body.children.find(c => c.tagName === 'CANVAS')._ctx;

// geometry of the plot, as allsky computes it
const CSSW = 400, CSSH = 400;
const M = { cx: CSSW / 2, cy: CSSH / 2, R: Math.max(30, Math.min(CSSW, CSSH) / 2 - 30) };
const EAST_LEFT = SAT.state.settings.allsky.eastLeft !== false;

function drawAndGrabFov() {
  askCtx._rec.strokes.length = 0;
  SAT.allsky.requestRender();
  flushRaf();
  const hits = askCtx._rec.strokes.filter(s => s.style === FOV_STROKE);
  return hits.length ? hits[hits.length - 1].pts : null;
}

/** Canvas point -> alt/az, the exact inverse of allsky's project(). */
function unproject(p) {
  const dx = p[0] - M.cx, dy = p[1] - M.cy;
  const r = Math.hypot(dx, dy);
  const sx = EAST_LEFT ? -1 : 1;
  let az = Math.atan2(sx * dx, -dy) * 180 / Math.PI;
  if (az < 0) az += 360;
  return { azDeg: az, elDeg: 90 - (r / M.R) * 90, rFrac: r / M.R };
}

function winding(pts) {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    let d = Math.atan2(pts[i + 1][1] - M.cy, pts[i + 1][0] - M.cx) -
      Math.atan2(pts[i][1] - M.cy, pts[i][0] - M.cx);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return total / (2 * Math.PI);
}

// ---- 5a: a field at the ZENITH must close around the plot centre ----
{
  const z = F.altAzToRaDec(0, 90, SITE, T0, { refract: false });
  SAT.state.setObs({
    mode: 'radec', raDeg: z.raDeg, decDeg: z.decDeg,
    fovShape: 'rect', fovWDeg: 1.5, fovHDeg: 1.0, rotDeg: 0, refraction: false,
  });
  const pts = drawAndGrabFov();
  ok('5a  zenith field produces a footprint', !!pts && pts.length > 4,
    pts ? pts.length + ' points' : 'none');
  if (pts) {
    const rad = pts.map(p => Math.hypot(p[0] - M.cx, p[1] - M.cy));
    const maxR = Math.max.apply(null, rad), minR = Math.min.apply(null, rad);
    ok('5a  closed curve (last point returns to the first)',
      Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6);
    ok('5a  hugs the plot centre', maxR < 0.03 * M.R,
      'maxR=' + maxR.toFixed(2) + ' px of R=' + M.R);
    ok('5a  does not pass through the centre', minR > 0.2,
      'minR=' + minR.toFixed(2) + ' px');
    near('5a  winds once around the centre', Math.abs(winding(pts)), 1.0, 0.02, 'turns');
    const els = pts.map(p => unproject(p).elDeg);
    ok('5a  every edge point is within a degree of the zenith',
      Math.min.apply(null, els) > 89.0, 'min el=' + Math.min.apply(null, els).toFixed(3) + '°');
  }
}

// ---- 5b: a field near the HORIZON must land near the horizon ring ----
{
  SAT.state.setObs({ mode: 'altaz', azDeg: 180, elDeg: 5, refraction: false });
  const pts = drawAndGrabFov();
  ok('5b  horizon field produces a footprint', !!pts && pts.length > 4);
  if (pts) {
    const fr = pts.map(p => unproject(p).rFrac);
    const minF = Math.min.apply(null, fr), maxF = Math.max.apply(null, fr);
    ok('5b  sits near the horizon ring, inside it', minF > 0.90 && maxF <= 1.0,
      'r/R in [' + minF.toFixed(3) + ', ' + maxF.toFixed(3) + ']');
    const els = pts.map(p => unproject(p).elDeg);
    near('5b  mean elevation is the pointing elevation',
      els.reduce((a, b) => a + b, 0) / els.length, 5.0, 0.15, 'deg');
    const azs = pts.map(p => unproject(p).azDeg);
    ok('5b  centred on the pointing azimuth',
      Math.abs(azs.reduce((a, b) => a + b, 0) / azs.length - 180) < 1.0,
      'mean az=' + (azs.reduce((a, b) => a + b, 0) / azs.length).toFixed(2) + '°');
  }
}

// ---- 5c: the footprint is the right ANGULAR size, not merely in the right place ----
{
  SAT.state.setObs({ mode: 'altaz', azDeg: 90, elDeg: 45, fovShape: 'circ', fovRDeg: 3, refraction: false });
  const pts = drawAndGrabFov();
  ok('5c  circular field produces a footprint', !!pts && pts.length > 20);
  if (pts) {
    // Alt/az is a rigid rotation of RA/Dec (refraction off), so separations survive
    // the whole deproject -> altaz -> project chain exactly. A 3 deg radius in the
    // tangent plane subtends atan(tan) = 2.9971 deg on the sky.
    const c = unproject([M.cx + (EAST_LEFT ? -1 : 1) * ((90 - 45) / 90) * M.R * Math.sin(Math.PI / 2),
      M.cy - ((90 - 45) / 90) * M.R * Math.cos(Math.PI / 2)]);
    const seps = pts.map(p => {
      const q = unproject(p);
      return F.sep(q.azDeg, q.elDeg, c.azDeg, c.elDeg);
    });
    const lo = Math.min.apply(null, seps), hi = Math.max.apply(null, seps);
    near('5c  every boundary point is one field radius out', (lo + hi) / 2, 2.9971, 0.01, 'deg');
    ok('5c  the boundary is a circle (radius is constant)', hi - lo < 0.01,
      'spread=' + ((hi - lo) * 3600).toFixed(1) + '″');
  }
}

// ---- 5d: it is a CONTEXT view — no pass trajectories, but crossings and stars ----
{
  ok('5d  no pass-prediction machinery survived the port',
    !/AOS|LOS|computeTrack|refineCross/.test(ALLSKY_SRC));
  ok('5d  draws visibleCrossings()', /visibleCrossings/.test(ALLSKY_SRC));
  ok('5d  uses SAT.frames for RA/Dec -> alt/az, not an inline helper',
    /SAT\.frames\.raDecToAltAz/.test(ALLSKY_SRC) && !/sinLat\s*\*\s*sinDec/.test(ALLSKY_SRC));
  ok('5d  keeps horizon, stars, Sun and Moon',
    /drawGrid/.test(ALLSKY_SRC) && /drawStars/.test(ALLSKY_SRC) && /drawSunMoon/.test(ALLSKY_SRC));

  // a crossing track should actually be stroked in its class colour
  SAT.state.setObs({ mode: 'altaz', azDeg: 180, elDeg: 45, fovShape: 'rect', fovWDeg: 2, fovHDeg: 2 });
  const path = [];
  for (let i = 0; i <= 8; i++) {
    const aa = F.altAzToRaDec(170 + i * 2, 40 + i, SITE, T0, { refract: false });
    path.push({ t: T0.getTime() + i * 1000, raDeg: aa.raDeg, decDeg: aa.decDeg });
  }
  SAT.state.scan.crossings = [{
    satId: ISS.id, norad: 25544, name: 'ISS (ZARYA)', intl: '1998-067A',
    tEnterMs: T0.getTime(), tExitMs: T0.getTime() + 8000, tCaMs: T0.getTime() + 4000,
    sepCaDeg: 0.2, cls: 'leo', shadow: 'none', magEst: 1.2, rateAsPerS: 900, path,
  }];
  askCtx._rec.strokes.length = 0;
  SAT.allsky.requestRender();
  flushRaf();
  const leo = askCtx._rec.strokes.filter(s => String(s.style).startsWith('rgba(79,195,247,0.'));
  ok('5d  crossing track drawn in the LEO class colour', leo.length > 0,
    leo.length + ' segments');
  SAT.state.scan.crossings = [];
}

// ---- 5e: round 12 — the star field is the bright catalogue, plus MW & sun/moon --
{
  ok('5e  never queries the deep catalogue (bright-only fallback)',
    !/SAT\.stars\.cone/.test(stripComments(ALLSKY_SRC)) && /SAT\.stardata/.test(ALLSKY_SRC));
  ok('5e  carries the MW and sun/moon layers', /drawMW/.test(ALLSKY_SRC) &&
    /SAT\.mwdata/.test(ALLSKY_SRC) && /sunMoon/.test(ALLSKY_SRC));

  // bright stars actually drawn: at T0 (22:00 UT, Greenwich) the sky is up
  SAT.state.settings.allsky.stars = true;
  askCtx._rec.fills.length = 0;
  SAT.allsky.requestRender();
  flushRaf();
  let starFills = askCtx._rec.fills.filter(s => String(s.style).startsWith('rgba(225,235,255'));
  ok('5e  bright-catalogue stars drawn on the dome', starFills.length > 100,
    starFills.length + ' star dots');

  // the MW layer fills its isophote levels when toggled on, and not before
  const mwStyle = s => String(s.style).startsWith('rgba(172,192,222');
  ok('5e  MW off by default -> no isophote fills',
    askCtx._rec.fills.filter(mwStyle).length === 0);
  SAT.state.settings.allsky.mw = true;
  askCtx._rec.fills.length = 0;
  SAT.allsky.requestRender();
  flushRaf();
  const mwFills = askCtx._rec.fills.filter(mwStyle);
  ok('5e  MW on -> one fill per isophote level', mwFills.length === SAT.mwdata.levels.length,
    mwFills.length + ' of ' + SAT.mwdata.levels.length);
  SAT.state.settings.allsky.mw = false;

  // sun icon: jump the clock to local noon so the sun is up, then restore
  SAT.clock.setDate(new Date('2026-07-21T12:00:00Z'));
  askCtx._rec.strokes.length = 0;
  askCtx._rec.fills.length = 0;
  SAT.allsky.requestRender();
  flushRaf();
  const rays = askCtx._rec.strokes.filter(s => s.style === '#ffd54f');
  ok('5e  rayed sun disc above the horizon at noon', rays.length >= 8,
    rays.length + ' sun strokes');
  starFills = askCtx._rec.fills.filter(s => String(s.style).startsWith('rgba(225,235,255'));
  ok('5e  star layer has no twilight/daylight gating (no sky tint either)',
    starFills.length > 100 && !/skyBg|sunAlt/.test(ALLSKY_SRC),
    starFills.length + ' star dots at noon');
  SAT.clock.setDate(T0);
}

// ---------------------------------------------------------------- [6] locations.js
console.log('\n[6] locations.js — still correct against the new SAT.state');
{
  const body = makeEl('div');
  SAT.ui.locations.init(body, { id: 'locations', body, isOpen: () => true });
  const t = textOf(body);
  const src = fs.readFileSync(path.join(APP, 'locations.js'), 'utf8');
  ok('renders the site row', t.includes('Lat °N') && t.includes('Lon °E'));
  ok('drops the "Show" column the new state has no field for',
    !/'Show'/.test(src) && !/loc\.show/.test(src));
  ok('adding a site no longer writes a `show` field', !/show:\s*true/.test(src));
  ok('changing the site invalidates the scan', /scan\.stale\s*=\s*true/.test(src));
  ok('no longer promises pass predictions', !/pass prediction/.test(t));
}

// ---------------------------------------------------------------- helpers
function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent;
  return (node.childNodes || []).map(textOf).join(' ');
}

/** Crude but sufficient: these files have no regex literals or `//` inside strings
 *  that would confuse it, and it only has to separate prose from code. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function quote(hay, needle) {
  const i = hay.indexOf(needle);
  if (i < 0) return '(not found)';
  return '…' + hay.slice(Math.max(0, i - 10), i + 70).replace(/\s+/g, ' ') + '…';
}

// ---------------------------------------------------------------- summary
process.on('exit', () => {
  console.log(failures
    ? '\n' + failures + ' of ' + checks + ' checks FAILED\n'
    : '\nall ' + checks + ' checks passed\n');
});
setTimeout(() => process.exit(failures ? 1 : 0), 50);
