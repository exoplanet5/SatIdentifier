/* Verification for app/js/pointing.js — the four checks the Pointing window has to
 * survive. Run: node tools/test_pointing.js
 *
 * The module is a DOM panel, so this file stands up a minimal document stub — just
 * enough of createElement / appendChild / addEventListener / classList for
 * SAT.util.el and the panel's own event wiring — and then drives the real controls
 * by dispatching real events at them. SAT.util and SAT.frames are the shipping
 * files; only SAT.state and SAT.clock are faked, and setObs is a transcription of
 * the real one (same normalisation), because "the edit went through setObs" is the
 * property being tested.
 *
 * Test 1 is the load-bearing one: RA/Dec -> Alt/Az -> RA/Dec through the mode
 * toggle must return the original pointing. It only holds because
 * frames.refractionInvDeg is an exact inverse of refractionDeg; if that regresses
 * to Bennett's formula the pointing walks a fraction of an arcsecond every toggle
 * and this test says so.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

// ---------------------------------------------------------------- DOM stub
const byId = new Map();

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    className: '',
    style: {},
    attrs: {},
    value: '',
    checked: false,
    disabled: false,
    title: '',
    placeholder: '',
    spellcheck: '',
    _text: '',
    _id: null,
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
    setAttribute(k, v) {
      el.attrs[k] = v;
      if (k === 'id') el.id = v;
      else if (k in el && typeof el[k] !== 'function') el[k] = v;
    },
    getAttribute(k) { return el.attrs[k]; },
    addEventListener(ev, fn) { (listeners[ev] || (listeners[ev] = [])).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
    _classes() { return el.className ? el.className.split(/\s+/).filter(Boolean) : []; },
    classList: {
      contains(c) { return el._classes().indexOf(c) >= 0; },
      add(c) { if (!el.classList.contains(c)) el.className = el._classes().concat([c]).join(' '); },
      remove(c) { el.className = el._classes().filter(x => x !== c).join(' '); },
      toggle(c, force) {
        const want = force == null ? !el.classList.contains(c) : !!force;
        if (want) el.classList.add(c); else el.classList.remove(c);
        return want;
      },
    },
  };
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] || null });
  Object.defineProperty(el, 'id', {
    get: () => el._id,
    set(v) { el._id = v; byId.set(v, el); },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text + el.children.map(c => c.textContent || '').join(''); },
    set(v) { el.children = []; el._text = String(v); },
  });
  return el;
}

global.window = global;
global.document = {
  createElement: makeEl,
  createTextNode: s => ({ nodeType: 3, textContent: String(s) }),
  getElementById: id => byId.get(id) || null,
  head: makeEl('head'),
};

// ---------------------------------------------------------------- real modules
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
require(path.join(APP, 'util.js'));
require(path.join(APP, 'frames.js'));
const U = SAT.util;
const F = SAT.frames;

// ---------------------------------------------------------------- fakes
let clockDate = new Date('2026-07-21T21:30:00Z');
SAT.clock = {
  getDate: () => new Date(clockDate.getTime()),
  setDate(d) { clockDate = new Date(d.getTime()); },
  syncNow() { clockDate = new Date(); },
};

const busListeners = new Map();
SAT.bus = {
  on(ev, fn) { (busListeners.get(ev) || busListeners.set(ev, []).get(ev)).push(fn); },
  emit(ev, p) { (busListeners.get(ev) || []).forEach(fn => fn(p)); },
};

const state = {
  obs: {
    mode: 'radec',
    raDeg: 83.822, decDeg: -5.391,
    azDeg: 180, elDeg: 60,
    track: 'sky',
    fovShape: 'rect',
    fovWDeg: 1.5, fovHDeg: 1.0, fovRDeg: 0.75,
    rotDeg: 0, flipEW: false,
    spanMin: 60,
    refraction: true, dut1S: 0,
  },
  settings: { cameras: [] },
  locations: [{
    id: 'loc_test', name: 'Test site', latDeg: 40.0, lonDeg: 116.4, altM: 50,
    active: true, color: '#ff5252',
  }],
  selection: { satId: null },
  scan: { stale: false },
  saves: 0,
  emits: [],
};
state.activeLocation = () => state.locations.find(l => l.active) || state.locations[0] || null;
state.getObj = () => null;
state.save = () => { state.saves++; };
state.fovRadiusDeg = () => (state.obs.fovShape === 'circ'
  ? state.obs.fovRDeg : 0.5 * Math.hypot(state.obs.fovWDeg, state.obs.fovHDeg));
// transcribed from app/js/state.js so the normalisation under test is the real one
state.setObs = function (patch) {
  const o = state.obs;
  Object.assign(o, patch);
  o.raDeg = ((o.raDeg % 360) + 360) % 360;
  o.decDeg = U.clamp(o.decDeg, -90, 90);
  o.azDeg = ((o.azDeg % 360) + 360) % 360;
  o.elDeg = U.clamp(o.elDeg, -90, 90);
  o.fovWDeg = U.clamp(o.fovWDeg, 1 / 3600, 180);
  o.fovHDeg = U.clamp(o.fovHDeg, 1 / 3600, 180);
  o.fovRDeg = U.clamp(o.fovRDeg, 1 / 3600, 90);
  o.spanMin = U.clamp(o.spanMin, 0.1, 7 * 1440);
  o.rotDeg = ((o.rotDeg % 360) + 360) % 360;
  state.scan.stale = true;
  state.emits.push(Object.keys(patch)[0] || null);
  SAT.bus.emit('obs-changed', { field: Object.keys(patch)[0] || null });
  state.save();
};
SAT.state = state;

require(path.join(APP, 'pointing.js'));

// ---------------------------------------------------------------- harness
let failures = 0;
function check(name, got, want, tol, unit) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${Number(got).toExponential(3)} vs ${Number(want).toExponential(3)} ${unit || ''} (tol ${tol.toExponential(1)})`);
}
function ok(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail == null ? '' : detail}`);
}
function eq(name, got, want) {
  ok(name, got === want, JSON.stringify(got) + (got === want ? '' : ' != ' + JSON.stringify(want)));
}

const $ = id => {
  const e = document.getElementById(id);
  if (!e) throw new Error('no control #' + id + ' — the panel did not build it');
  return e;
};
const click = id => $(id).dispatchEvent({ type: 'click' });
const type = (id, v) => { const e = $(id); e.value = String(v); e.dispatchEvent({ type: 'change' }); };
const snap = () => JSON.stringify(state.obs);

// ---------------------------------------------------------------- build
const body = makeEl('div');
SAT.ui.pointing.init(body, { id: 'pointing', isOpen: () => true });
console.log(`\npointing.js built ${byId.size} identified controls`);

// ---------------------------------------------------------------- test 1
console.log('\n[1] mode-switch round trip  RA/Dec -> Alt/Az -> RA/Dec');
{
  const POINTINGS = [
    [83.822, -5.391],    // Orion Nebula, the default field
    [279.234, 38.784],   // Vega
    [0.0, 0.0],          // the equinox itself
    [359.95, -0.02],     // just below it, across the RA wrap
    [201.3, -47.3],      // low in the south from a mid-north site
    [45.0, 85.0],        // near the pole, where RA is ill-conditioned
    [123.4, -70.0],      // well below the horizon from this site
  ];
  const SITES = [
    { id: 'a', name: 'mid-north', latDeg: 40.0, lonDeg: 116.4, altM: 50, active: true },
    { id: 'b', name: 'equator', latDeg: 0.0, lonDeg: -78.5, altM: 2800, active: true },
    { id: 'c', name: 'high south', latDeg: -67.6, lonDeg: 62.9, altM: 20, active: true },
  ];
  const TIMES = ['2026-07-21T21:30:00Z', '2026-01-05T06:11:07Z', '2027-03-14T15:09:26Z'];

  // Split by the elevation the pointing passes through, because the refraction
  // inverse is a fixed-point iteration whose convergence rate is |d(refr)/d(el)|.
  // That is ~0 near the zenith (exact to double precision) and grows toward the
  // horizon, so five passes leave a residual that is only visible below ~5 deg.
  // See the diagnostic table printed below: 0.1" at El 0, which is three orders of
  // magnitude under the arcminute truth a TLE can support. High elevations are the
  // regression test; the grazing bucket is reported, with a tolerance that would
  // still catch a real inversion bug (a wrong inverse costs arcminutes, not 0.05").
  const GRAZE_DEG = 5;
  let worst = 0, worstCase = '', n = 0;
  let worstGraze = 0, worstGrazeCase = '', nGraze = 0;
  let worstRefrOff = 0;
  for (const site of SITES) {
    state.locations = [site];
    for (const t of TIMES) {
      clockDate = new Date(t);
      for (const refr of [true, false]) {
        for (const [ra, dec] of POINTINGS) {
          state.obs.mode = 'radec';
          state.obs.track = 'sky';
          state.obs.refraction = refr;
          state.setObs({ raDeg: ra, decDeg: dec });

          click('pnt-mode-altaz');
          if (state.obs.mode !== 'altaz') { failures++; console.log('  FAIL  mode did not switch'); }
          if (state.obs.track !== 'mount') { failures++; console.log('  FAIL  track default not "mount"'); }
          const az = state.obs.azDeg, el = state.obs.elDeg;

          click('pnt-mode-radec');
          if (state.obs.track !== 'sky') { failures++; console.log('  FAIL  track default not "sky"'); }
          const err = F.sep(ra, dec, state.obs.raDeg, state.obs.decDeg);
          const label = `${site.name} ${t} refr=${refr} (${ra},${dec}) via Az ${az.toFixed(3)} El ${el.toFixed(3)}`;
          if (el < GRAZE_DEG) {
            nGraze++;
            if (err > worstGraze) { worstGraze = err; worstGrazeCase = label; }
          } else {
            n++;
            if (err > worst) { worst = err; worstCase = label; }
          }
          if (!refr) worstRefrOff = Math.max(worstRefrOff, err);
        }
      }
    }
  }
  console.log(`  (${n + nGraze} round trips over ${SITES.length} sites x ${TIMES.length} epochs x 2 refraction settings)`);
  console.log(`  worst above El ${GRAZE_DEG}° (${n} cases): ${worstCase}`);
  console.log(`  worst below El ${GRAZE_DEG}° (${nGraze} cases): ${worstGrazeCase}`);
  check(`worst round-trip error, El > ${GRAZE_DEG}`, worst, 0, 1e-6, 'deg');
  check('  ... expressed in arcsec', worst * 3600, 0, 3.6e-3, 'arcsec');
  check('  ... same, refraction OFF (all elevations)', worstRefrOff, 0, 1e-6, 'deg');
  check(`worst round-trip error, El < ${GRAZE_DEG} (grazing)`, worstGraze, 0, 1e-4, 'deg');

  // The residual above is entirely the refraction inverse, so print its own error
  // curve: this is the number that moves if refractionInvDeg is ever "simplified"
  // back to Bennett's apparent->true formula, which is not the exact companion of
  // the Saemundsson forward formula frames.js uses.
  console.log('  refraction inverse residual vs elevation:');
  for (const e of [90, 30, 10, 5, 1, 0]) {
    const app = e + F.refractionDeg(e);
    const res = Math.abs(app - F.refractionInvDeg(app) - e);
    console.log(`    El ${String(e).padStart(2)}°  refr ${(F.refractionDeg(e) * 60).toFixed(2).padStart(5)}′` +
      `  residual ${(res * 3600).toExponential(2)}″`);
  }

  // restore the single test site
  state.locations = [{
    id: 'loc_test', name: 'Test site', latDeg: 40.0, lonDeg: 116.4, altM: 50,
    active: true, color: '#ff5252',
  }];
  clockDate = new Date('2026-07-21T21:30:00Z');
  state.obs.refraction = true;
  SAT.ui.pointing.refresh();
}

// ---------------------------------------------------------------- test 2
console.log('\n[2] bad input is rejected, flashes, and never reaches state');
{
  state.setObs({ mode: 'radec', raDeg: 83.822, decDeg: -5.391 });
  SAT.ui.pointing.refresh();

  const CASES = [
    ['pnt-ra', 'abc', 'RA: letters'],
    ['pnt-ra', '99 99 99', 'RA: hours/min/sec out of range'],
    ['pnt-ra', '', 'RA: empty'],
    ['pnt-ra', '12 61 00', 'RA: 61 minutes'],
    ['pnt-dec', '91', 'Dec: 91 degrees'],
    ['pnt-dec', '-91 00 00', 'Dec: -91 sexagesimal'],
    ['pnt-dec', '99 99 99', 'Dec: nonsense sexagesimal'],
    ['pnt-dec', 'abc', 'Dec: letters'],
    ['pnt-span', 'abc', 'span: letters'],
    ['pnt-fovw', '-3', 'FOV width: negative'],
    ['pnt-epoch', '2026-02-31 00:00:00', 'epoch: 31 February'],
  ];
  for (const [id, bad, label] of CASES) {
    const before = snap();
    const clockBefore = clockDate.getTime();
    type(id, bad);
    const unchanged = snap() === before && clockDate.getTime() === clockBefore;
    const flashed = $(id).classList.contains('pnt-bad');
    ok(label, unchanged && flashed,
      unchanged ? (flashed ? 'rejected + flashed' : 'NOT flashed') : 'STATE CHANGED: ' + snap());
    $(id).classList.remove('pnt-bad');
  }

  // the field must be repainted from state, not left holding the junk
  eq('rejected field reverted to canonical RA', $('pnt-ra').value, U.fmtRA(state.obs.raDeg));
  eq('rejected field reverted to canonical Dec', $('pnt-dec').value, U.fmtDec(state.obs.decDeg));

  // no NaN anywhere, which is the failure mode the null-returning parsers exist for
  const bad = Object.keys(state.obs).filter(k =>
    typeof state.obs[k] === 'number' && !isFinite(state.obs[k]));
  ok('no non-finite numbers in state.obs', bad.length === 0, bad.join(',') || 'clean');

  // and the good forms all land, including the negative-zero declination trap
  type('pnt-ra', '05 35 17.3');
  check('accepts "05 35 17.3"', state.obs.raDeg, 83.8220833, 1e-6, 'deg');
  type('pnt-ra', '5h35m17.3s');
  check('accepts "5h35m17.3s"', state.obs.raDeg, 83.8220833, 1e-6, 'deg');
  type('pnt-ra', '83.822');
  check('accepts bare degrees "83.822"', state.obs.raDeg, 83.822, 1e-9, 'deg');
  type('pnt-dec', '-00 30 00');
  check('accepts negative-zero dec "-00 30 00"', state.obs.decDeg, -0.5, 1e-12, 'deg');
  type('pnt-dec', '-05:23:28');
  check('accepts "-05:23:28"', state.obs.decDeg, -5.391111, 1e-6, 'deg');
}

// ---------------------------------------------------------------- test 3
console.log('\n[3] arcmin / degree unit toggle round-trips a FOV size exactly');
{
  click('pnt-unit-deg');
  type('pnt-fovw', '1.5');
  type('pnt-fovh', '1');
  const w0 = state.obs.fovWDeg, h0 = state.obs.fovHDeg;
  const shownDegW = $('pnt-fovw').value, shownDegH = $('pnt-fovh').value;

  click('pnt-unit-min');
  eq('width displayed in arcmin', $('pnt-fovw').value, '90');
  eq('height displayed in arcmin', $('pnt-fovh').value, '60');
  ok('toggling units did not touch state', state.obs.fovWDeg === w0 && state.obs.fovHDeg === h0,
    'fovWDeg ' + state.obs.fovWDeg);

  click('pnt-unit-deg');
  eq('width back in degrees', $('pnt-fovw').value, shownDegW);
  eq('height back in degrees', $('pnt-fovh').value, shownDegH);
  ok('deg -> arcmin -> deg is bit-exact in state',
    state.obs.fovWDeg === w0 && state.obs.fovHDeg === h0,
    state.obs.fovWDeg + ' / ' + state.obs.fovHDeg);

  // ...and committing the arcmin reading back is exact too, so a user who tabs
  // through the field in arcmin does not shrink it by a rounding step
  click('pnt-unit-min');
  type('pnt-fovw', $('pnt-fovw').value);
  type('pnt-fovh', $('pnt-fovh').value);
  ok('re-committing the arcmin display is exact',
    state.obs.fovWDeg === w0 && state.obs.fovHDeg === h0,
    state.obs.fovWDeg + ' / ' + state.obs.fovHDeg);

  // a non-round size survives the display round trip too
  type('pnt-fovw', '74.074');
  const wOdd = state.obs.fovWDeg;
  click('pnt-unit-deg');
  click('pnt-unit-min');
  ok('non-round size survives a unit round trip', state.obs.fovWDeg === wOdd, String(wOdd));
  check('  ... and it is 74.074 arcmin', wOdd * 60, 74.074, 1e-12, 'arcmin');

  click('pnt-unit-deg');
  type('pnt-fovw', '1.5');
  type('pnt-fovh', '1');
}

// ---------------------------------------------------------------- test 4
console.log('\n[4] presets');
{
  const loc = state.activeLocation();
  const date = SAT.clock.getDate();

  click('pnt-preset-zenith');
  check('Zenith: stored elevation', state.obs.elDeg, 90, 0, 'deg');
  // the RA/Dec written alongside it must describe the same place
  const back = F.raDecToAltAz(state.obs.raDeg, state.obs.decDeg, loc, date, { refract: true });
  check('Zenith: RA/Dec reads back as El 90', back.elDeg, 90, 1e-6, 'deg');
  // The J2000 declination of the zenith is NOT the site latitude — precession from
  // 2026 back to J2000 moves it by ~0.1 deg, which is 6x a typical FOV and exactly
  // the confusion frames.js exists to prevent. Of DATE, it must be the latitude.
  const tod = F.vecToRaDec(F.j2000ToTod(F.raDecToVec(state.obs.raDeg, state.obs.decDeg), date));
  check('Zenith: apparent (of-date) dec equals site latitude', tod.decDeg, loc.latDeg, 1e-9, 'deg');
  console.log(`    (J2000 dec is ${state.obs.decDeg.toFixed(4)}°, ` +
    `${Math.abs(state.obs.decDeg - loc.latDeg).toFixed(4)}° from the latitude — precession, as it should be)`);

  click('pnt-preset-sun');
  const sun = F.sunJ2000(date);
  check('Sun: RA matches frames.sunJ2000', state.obs.raDeg, sun.raDeg, 1e-9, 'deg');
  check('Sun: Dec matches frames.sunJ2000', state.obs.decDeg, sun.decDeg, 1e-9, 'deg');
  check('Sun: separation from frames.sunJ2000',
    F.sep(state.obs.raDeg, state.obs.decDeg, sun.raDeg, sun.decDeg), 0, 1e-9, 'deg');

  click('pnt-preset-moon');
  const moon = F.moonJ2000(date);
  check('Moon: separation from frames.moonJ2000',
    F.sep(state.obs.raDeg, state.obs.decDeg, moon.raDeg, moon.decDeg), 0, 1e-9, 'deg');

  click('pnt-preset-antisun');
  check('Anti-sun: 180 deg from the Sun',
    F.sep(state.obs.raDeg, state.obs.decDeg, sun.raDeg, sun.decDeg), 180, 1e-9, 'deg');

  // "from selected object" with nothing selected must complain, not throw
  const before = snap();
  click('pnt-preset-sel');
  ok('selected-object preset with no selection is inert',
    snap() === before && /no object selected/.test($('pnt-msg').textContent),
    $('pnt-msg').textContent);
}

// ---------------------------------------------------------------- extras
console.log('\n[5] supporting behaviour');
{
  // 6h/24h chips were removed in round 3 — 1h is now the longest quick chip,
  // and their absence is part of the contract
  click('pnt-span-60');
  eq('quick chip sets spanMin', state.obs.spanMin, 60);
  ok('6h/24h chips are gone', document.getElementById('pnt-span-360') == null &&
    document.getElementById('pnt-span-1440') == null, '');

  type('pnt-fovw', '2.54');
  type('pnt-fovh', '1.7');
  // presets carry FOV only — plate scale left the data model in review round 1
  $('pnt-camname').value = 'My rig';
  click('pnt-camsave');
  ok('camera preset persisted to settings.cameras',
    state.settings.cameras.length === 1 && state.settings.cameras[0].name === 'My rig' &&
    state.settings.cameras[0].wDeg === 2.54 && state.settings.cameras[0].hDeg === 1.7,
    JSON.stringify(state.settings.cameras));
  // a legacy preset with the old plate-scale key must still apply its FOV
  state.settings.cameras.push({ id: 'legacy1', name: 'Legacy', wDeg: 1.5, hDeg: 1.0, ps: 2.0 });
  $('pnt-cam').value = 'ulegacy1';
  $('pnt-cam').dispatchEvent({ type: 'change' });
  check('legacy preset (with stray ps key) applies its FOV', state.obs.fovWDeg, 1.5, 1e-12, 'deg');
  state.settings.cameras.pop();

  type('pnt-fovw', '5');
  $('pnt-cam').value = 'u' + state.settings.cameras[0].id;
  $('pnt-cam').dispatchEvent({ type: 'change' });
  check('selecting the preset restores its width', state.obs.fovWDeg, 2.54, 1e-12, 'deg');

  click('pnt-camdel');
  ok('first delete click only arms', state.settings.cameras.length === 1,
    $('pnt-camdel').textContent);
  click('pnt-camdel');
  ok('second delete click removes it', state.settings.cameras.length === 0, '');

  // Refraction checkbox removed in round 2: refraction is always applied. The
  // observable contract is now that a displayed Alt/Az elevation is APPARENT,
  // and that the panel says so.
  state.setObs({ mode: 'altaz', azDeg: 180, elDeg: 30 });
  SAT.ui.pointing.refresh();
  ok('no refraction checkbox any more', document.getElementById('pnt-refr') == null, '');
  ok('elevation is labelled apparent', /apparent/.test($('pnt-el-note').textContent),
    $('pnt-el-note').textContent);

  // no site at all: the panel must degrade, not throw
  state.locations = [];
  SAT.ui.pointing.refresh();
  const before = snap();
  click('pnt-mode-radec');
  ok('mode switch without a site is refused with a message',
    snap() === before && /needs an active site/.test($('pnt-msg').textContent),
    $('pnt-msg').textContent);
  click('pnt-preset-zenith');
  ok('Zenith without a site is refused with a message', snap() === before,
    $('pnt-msg').textContent);

  // In RA/Dec mode with no site there is nothing to derive alt/az from; the fields
  // must say so rather than show a stale value or NaN.
  state.obs.mode = 'radec';
  SAT.ui.pointing.refresh();
  ok('Alt/Az fields show a placeholder rather than NaN', $('pnt-az').value === '—',
    $('pnt-az').value);
  ok('Alt/Az fields are disabled without a site', $('pnt-az').disabled === true, '');
  ok('site line names the missing site', /no active site/.test($('pnt-siteinfo').textContent),
    $('pnt-siteinfo').textContent);
  ok('no NaN in any displayed field',
    !['pnt-ra', 'pnt-dec', 'pnt-az', 'pnt-el', 'pnt-fovw', 'pnt-span']
      .some(id => /NaN/.test(String($(id).value))), '');
}

// ---------------------------------------------------------------- dual inputs
console.log('\n[6] decimal fields: editable, synced with sexagesimal (round-1 feature)');
{
  state.setObs({ mode: 'radec', raDeg: 83.822, decDeg: -5.391 });
  SAT.ui.pointing.refresh();

  // decimal -> state -> sexagesimal repaint
  type('pnt-ra-d', '150.5');
  check('decimal RA edit lands in state', state.obs.raDeg, 150.5, 1e-9, 'deg');
  ok('sexagesimal RA field repainted from state', /^10 02 00/.test($('pnt-ra').value),
    $('pnt-ra').value);
  type('pnt-dec-d', '-42.25');
  check('decimal Dec edit lands in state', state.obs.decDeg, -42.25, 1e-9, 'deg');
  ok('sexagesimal Dec field repainted', /^-42 15 00/.test($('pnt-dec').value),
    $('pnt-dec').value);

  // sexagesimal -> state -> decimal repaint
  type('pnt-ra', '05 35 17.3');
  check('sexagesimal RA edit lands in state', state.obs.raDeg, 83.82208, 1e-3, 'deg');
  ok('decimal RA field repainted', /^83\.82/.test($('pnt-ra-d').value), $('pnt-ra-d').value);

  // bad decimals reject and leave state untouched
  const before = state.obs.raDeg;
  type('pnt-ra-d', 'abc');
  check('bad decimal RA leaves state unchanged', state.obs.raDeg, before, 0, 'deg');
  type('pnt-dec-d', '91');
  check('Dec 91 decimal rejected', state.obs.decDeg, -42.25, 1e-9, 'deg');
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
