/* Verification for app/js/chart.js — parse + the projection/orientation maths.
 * Run: node tools/test_chart.js
 *
 * A canvas view cannot be exercised headlessly, so the file is written with the one
 * thing that can go silently wrong — the orientation transform — factored into pure
 * functions (SAT.chart._skyToScreen / _screenToSky / _makeTransform). Everything
 * below tests those directly, plus loads the module under a stub DOM to prove it
 * parses and attaches the contracted API.
 *
 * ORIENTATION CONVENTION UNDER TEST — chart.js defines SKY VIEW:
 *   rotDeg = 0, flipEW = false  =>  north UP  (negative screen y)
 *                                   east  LEFT (negative screen x)
 * That is the orientation of a direct astronomical image and of every FITS viewer's
 * default, because we look outwards at the sphere rather than down onto a map; the
 * satobserver all-sky chart makes the same choice (its `eastLeft` defaults to true).
 * `flipEW` then means an optical train with an odd number of reflections, exactly as
 * state.js describes it, and mirrors screen x only.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

// ---- stub environment ------------------------------------------------------
// chart.js touches the DOM only inside init(); the stubs exist so that requiring the
// file cannot throw, and so a future top-level DOM access fails loudly here.
const styleEls = {};
const calls = {};                       // canvas op -> count, for the smoke test
function rec(name) { return function () { calls[name] = (calls[name] || 0) + 1; }; }
const ctx2d = {
  fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
  font: '', textAlign: '', textBaseline: '',
  setTransform: rec('setTransform'), save: rec('save'), restore: rec('restore'),
  translate: rec('translate'), rotate: rec('rotate'),
  beginPath: rec('beginPath'), closePath: rec('closePath'),
  moveTo: rec('moveTo'), lineTo: rec('lineTo'), rect: rec('rect'), arc: rec('arc'),
  ellipse: rec('ellipse'),                 // moon phase terminator
  fill: rec('fill'), stroke: rec('stroke'),
  fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
  fillText: rec('fillText'), strokeText: rec('strokeText'),
  measureText: () => ({ width: 20 }),
};
function stubEl() {
  return {
    style: {}, className: '', textContent: '',
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {},
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 700 }),
  };
}
global.window = global;
global.devicePixelRatio = 2;            // exercise the HiDPI path
global.requestAnimationFrame = (fn) => fn();   // render synchronously, so it can throw
global.ResizeObserver = function () { this.observe = () => {}; };
global.document = {
  head: { appendChild: () => {} },
  getElementById: (id) => styleEls[id] || null,
  createElement: stubEl,
  createTextNode: () => ({}),
};
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
// real catalogue data: since round 11 the chart's star background IS the bright
// catalogue (SAT.stardata), and the Milky Way layer reads SAT.mwdata
require(path.join(APP, 'vendor', 'starcat.js'));
require(path.join(APP, 'vendor', 'mwdata.js'));
require(path.join(APP, 'util.js'));
require(path.join(APP, 'frames.js'));
// real propagate.js: chart.js routes every alt/az conversion through SAT.prop's
// kind-dispatching converters since the orbital-station amendment (ground sites
// delegate to frames verbatim, so every existing expectation is unchanged)
require(path.join(APP, 'propagate.js'));
require(path.join(APP, 'chart.js'));

const C = SAT.chart, F = SAT.frames;

let failures = 0;
function ok(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail || ''}`);
}
function close(name, got, want, tol, unit) {
  const good = Math.abs(got - want) <= tol;
  if (!good) failures++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ` +
    `${got.toFixed(6)} vs ${want.toFixed(6)} ${unit || 'px'} (tol ${tol})`);
}

// ---------------------------------------------------------------- test 0
console.log('\n[0] module loads under a stub DOM and exposes the contracted API');
{
  ok('SAT.chart exists', !!C);
  ok('init / requestRender / fitView are functions',
    typeof C.init === 'function' && typeof C.requestRender === 'function' &&
    typeof C.fitView === 'function');
}

// ---------------------------------------------------------------- fixtures
// 100 px per degree, origin at screen (0,0) so signs are unambiguous.
const SCALE = 100;
const RA0 = 83.822, DEC0 = -5.391;          // the default pointing (Orion)

// A star exactly 0.5 deg north and one exactly 0.5 deg east of the tangent point,
// derived through frames.tanDeproject so these are real sky positions, not assumed
// standard coordinates. Projecting them back must reproduce (0, 0.5) and (0.5, 0).
const NORTH = F.tanDeproject(0, 0.5, RA0, DEC0);
const EAST = F.tanDeproject(0.5, 0, RA0, DEC0);

console.log('\n[1] the two test stars really are 0.5° north and 0.5° east');
{
  // A gnomonic standard coordinate is a TANGENT, not an arc: a point plotted 0.5° from
  // centre on the tangent plane is atan(0.5°) = 0.4999867° away on the sky. The 13 mas
  // difference is the projection doing its job, and asserting the exact relation here
  // is what proves tanDeproject fed us the point we think it did.
  const TRUE_SEP = Math.atan(0.5 * Math.PI / 180) * 180 / Math.PI;
  close('north star separation', F.sep(RA0, DEC0, NORTH.raDeg, NORTH.decDeg), TRUE_SEP, 1e-9, 'deg');
  close('north star position angle', F.posAngle(RA0, DEC0, NORTH.raDeg, NORTH.decDeg), 0, 1e-6, 'deg');
  close('east star separation', F.sep(RA0, DEC0, EAST.raDeg, EAST.decDeg), TRUE_SEP, 1e-9, 'deg');
  close('east star position angle', F.posAngle(RA0, DEC0, EAST.raDeg, EAST.decDeg), 90, 1e-6, 'deg');

  // and the standard coordinates themselves round-trip exactly, which is the property
  // the screen transform is actually built on
  const bn = F.tanProject(NORTH.raDeg, NORTH.decDeg, RA0, DEC0);
  const be = F.tanProject(EAST.raDeg, EAST.decDeg, RA0, DEC0);
  close('north star eta', bn.eta, 0.5, 1e-12, 'deg');
  close('north star xi', bn.xi, 0, 1e-12, 'deg');
  close('east star xi', be.xi, 0.5, 1e-12, 'deg');
  close('east star eta', be.eta, 0, 1e-12, 'deg');
}

function project(star, rotDeg, flipEW) {
  const s = F.tanProject(star.raDeg, star.decDeg, RA0, DEC0);
  const t = C._makeTransform(rotDeg, flipEW, SCALE, 0, 0);
  return C._skyToScreen(s.xi, s.eta, t);
}

// ---------------------------------------------------------------- test 2
console.log('\n[2] rotDeg = 0, flipEW = false — sky view: north up, east LEFT');
{
  const n = project(NORTH, 0, false);
  const e = project(EAST, 0, false);
  close('north star screen x', n.x, 0, 1e-9);
  close('north star screen y  (NEGATIVE = up)', n.y, -50, 1e-9);
  ok('north lands at negative y', n.y < 0, `y = ${n.y.toFixed(3)}`);
  close('east star screen y', e.y, 0, 1e-9);
  close('east star screen x  (NEGATIVE = left)', e.x, -50, 1e-9);
  ok('east lands at negative x', e.x < 0, `x = ${e.x.toFixed(3)}`);
}

// ---------------------------------------------------------------- test 3
console.log('\n[3] rotDeg = 90 — chart +Y points at position angle 90 (east up)');
{
  // East is now up; north, which was up, is carried clockwise on screen to the right.
  const n = project(NORTH, 90, false);
  const e = project(EAST, 90, false);
  close('east star screen x', e.x, 0, 1e-9);
  close('east star screen y  (east now up)', e.y, -50, 1e-9);
  close('north star screen y', n.y, 0, 1e-9);
  close('north star screen x  (POSITIVE = right)', n.x, 50, 1e-9);

  // A general point must rotate rigidly: |r| preserved, screen angle turned by 90 deg.
  const t0 = C._makeTransform(0, false, SCALE, 0, 0);
  const t90 = C._makeTransform(90, false, SCALE, 0, 0);
  const p0 = C._skyToScreen(0.3, 0.2, t0);
  const p90 = C._skyToScreen(0.3, 0.2, t90);
  close('radius preserved under rotation', Math.hypot(p90.x, p90.y), Math.hypot(p0.x, p0.y), 1e-9);
  // clockwise on screen by 90 deg: (x,y) -> (-y, x)
  close('rotated x == -y0', p90.x, -p0.y, 1e-9);
  close('rotated y ==  x0', p90.y, p0.x, 1e-9);

  // 45 deg is the sanity check that the sense, not just the quarter turn, is right:
  // north should sit half-way between up and right.
  const n45 = project(NORTH, 45, false);
  close('rot 45 north x', n45.x, 50 / Math.SQRT2, 1e-9);
  close('rot 45 north y', n45.y, -50 / Math.SQRT2, 1e-9);
}

// ---------------------------------------------------------------- test 4
console.log('\n[4] flipEW mirrors screen x only');
{
  for (const rot of [0, 37, 90, 213]) {
    const a = C._skyToScreen(0.3, -0.17, C._makeTransform(rot, false, SCALE, 0, 0));
    const b = C._skyToScreen(0.3, -0.17, C._makeTransform(rot, true, SCALE, 0, 0));
    close(`rot ${rot}: flipped x == -unflipped x`, b.x, -a.x, 1e-9);
    close(`rot ${rot}: y unchanged by flip`, b.y, a.y, 1e-9);
  }
  const e = project(EAST, 0, true);
  ok('flipped chart puts east on the RIGHT', e.x > 0, `x = ${e.x.toFixed(3)}`);
  close('flipped east star x', e.x, 50, 1e-9);
}

// ---------------------------------------------------------------- test 5
console.log('\n[5] pan / zoom translation and the screen->sky inverse');
{
  const t = C._makeTransform(31.5, true, 250, 400, 300);
  const p = C._skyToScreen(0.11, -0.07, t);
  const back = C._screenToSky(p.x, p.y, t);
  close('round-trip xi', back.xi, 0.11, 1e-12, 'deg');
  close('round-trip eta', back.eta, -0.07, 1e-12, 'deg');
  const origin = C._skyToScreen(0, 0, t);
  close('tangent point sits at (cx, cy) x', origin.x, 400, 1e-9);
  close('tangent point sits at (cx, cy) y', origin.y, 300, 1e-9);
  // scale really is px per degree
  const oneDeg = C._skyToScreen(1, 0, C._makeTransform(0, false, 250, 0, 0));
  close('1 deg east is 250 px from centre', Math.hypot(oneDeg.x, oneDeg.y), 250, 1e-9);
}

// ---------------------------------------------------------------- test 6
console.log('\n[6] compass rosette directions follow the transform');
{
  let d = C._axisDirs(C._makeTransform(0, false, 1, 0, 0));
  close('rot 0 north arrow dy (up)', d.n.y, -1, 1e-9, '');
  close('rot 0 east arrow dx (left)', d.e.x, -1, 1e-9, '');
  d = C._axisDirs(C._makeTransform(0, true, 1, 0, 0));
  close('flipped east arrow dx (right)', d.e.x, 1, 1e-9, '');
  close('flipped north arrow dy (still up)', d.n.y, -1, 1e-9, '');
  d = C._axisDirs(C._makeTransform(90, false, 1, 0, 0));
  close('rot 90 east arrow dy (up)', d.e.y, -1, 1e-9, '');
  close('rot 90 north arrow dx (right)', d.n.x, 1, 1e-9, '');
}

// ---------------------------------------------------------------- test 7
console.log('\n[7] grid spacing scales with the field');
{
  // largest nice step that still yields >= 4 divisions across the field
  const cases = [
    [40, 10], [12, 2], [4, 1], [1.2, 10 / 60], [0.4, 5 / 60],
    [0.08, 1 / 60], [0.01, 5 / 3600],
  ];
  for (const [span, want] of cases) {
    const got = C._gridStepDeg(span, 4);
    ok(`span ${span}° -> step ${(want * 60).toFixed(2)}′`, Math.abs(got - want) < 1e-12,
      `got ${(got * 60).toFixed(3)}′, ${(span / got).toFixed(1)} divisions`);
  }
}

// ---------------------------------------------------------------- test 8
console.log('\n[8] path sampling: RA wrap is handled at the current-position marker');
{
  // a synthetic crossing that runs through RA 0h, so the short-way interpolation is
  // exercised — the failure mode is a track that jumps 360 deg for one segment
  const p = [
    { t: 1000, raDeg: 359.0, decDeg: 10.0 },
    { t: 2000, raDeg: 359.8, decDeg: 10.2 },
    { t: 3000, raDeg: 0.6, decDeg: 10.4 },
  ];
  const mid = C._pathPosAt(p, 2500);
  close('interpolated RA across 0h', ((mid.raDeg + 360) % 360), 0.2, 1e-9, 'deg');
  close('interpolated Dec', mid.decDeg, 10.3, 1e-9, 'deg');
  ok('outside the crossing returns null',
    C._pathPosAt(p, 500) === null && C._pathPosAt(p, 5000) === null);
}

// ---------------------------------------------------------------- test 9
console.log('\n[9] parked-mount frame interpolation (obs.track = "mount")');
{
  // The frame table is interpolated between knots; the failure mode is a field that
  // jumps the long way round when the drift carries it across 0h RA, or an
  // orientation that unwinds through 360° instead of stepping 1°.
  close('lerp forward', C._lerpAngle(10, 20, 0.5), 15, 1e-12, 'deg');
  close('lerp across 0h the SHORT way', C._lerpAngle(359, 1, 0.5), 360, 1e-12, 'deg');
  close('lerp backwards across 0h', C._lerpAngle(1, 359, 0.5), 0, 1e-12, 'deg');
  close('lerp rotation 350 -> 10', C._lerpAngle(350, 10, 0.25), 355, 1e-12, 'deg');

  const a = { raDeg: 359.5, decDeg: 10, rotDeg: 359 };
  const b = { raDeg: 0.5, decDeg: 12, rotDeg: 1 };
  const m = C._lerpFrame(a, b, 0.5);
  close('frame RA wraps to 0', m.raDeg, 0, 1e-9, 'deg');
  close('frame Dec interpolates', m.decDeg, 11, 1e-12, 'deg');
  close('frame rotation wraps to 0', ((m.rotDeg % 360) + 360) % 360, 0, 1e-9, 'deg');

  // A parked alt/az field really does drift and rotate: check the sky under a fixed
  // az/el at Greenwich moves ~15"/s in RA, which is the whole reason star trails
  // appear in this mode and satellites in the other.
  const loc = { latDeg: 51.4779, lonDeg: -0.0015, altM: 47 };
  const opts = { refract: false, dut1S: 0 };
  const tA = new Date('2026-07-21T22:00:00Z');
  const tB = new Date('2026-07-21T22:00:30Z');
  const pA = F.altAzToRaDec(180, 60, loc, tA, opts);
  const pB = F.altAzToRaDec(180, 60, loc, tB, opts);
  const drift = F.sep(pA.raDeg, pA.decDeg, pB.raDeg, pB.decDeg) * 3600 / 30;
  ok('parked field drifts through the stars at ~15″/s',
    drift > 5 && drift < 16, `${drift.toFixed(2)}″/s measured over 30 s`);
}

// ---------------------------------------------------------------- test 10
console.log('\n[10] render smoke test — every layer, both tracking modes');
{
  // Most of chart.js is paint, which `node --check` cannot reach. Driving init() and
  // render() against a recording 2D context is what catches a typo in a layer that
  // would otherwise only surface as a blank canvas in the app.
  const LOC = {
    id: 'l1', name: 'Greenwich', latDeg: 51.4779, lonDeg: -0.0015, altM: 47,
    active: true, color: '#ff5252',
  };
  const T0 = Date.parse('2026-07-21T22:00:00Z');

  // one crossing per orbit class, each a short arc through the field
  function crossing(id, cls, i) {
    const pathPts = [];
    for (let k = 0; k <= 32; k++) {
      const f = k / 32;
      pathPts.push({
        t: T0 - 20000 + f * 60000,
        raDeg: RA0 - 0.6 + 1.2 * f + 0.05 * i,
        decDeg: DEC0 - 0.3 + 0.6 * f * f + 0.05 * i,   // f^2 so the track is curved
      });
    }
    return {
      satId: id, norad: 25544 + i, name: 'OBJ-' + i, intl: '1998-067A',
      tEnterMs: pathPts[0].t, tExitMs: pathPts[pathPts.length - 1].t, tCaMs: T0,
      sepCaDeg: 0.1, raDeg: RA0, decDeg: DEC0, azDeg: 180, elDeg: 60,
      rangeKm: 800, rangeRateKmS: -2, rateAsPerS: 900, paDeg: 60,
      rateMountAsPerS: 890, paMountDeg: 58, magEst: 4.2, phaseDeg: 70,
      shadow: 'none', cls: cls, sunElDeg: -20,
      path: pathPts,
    };
  }
  const CROSSINGS = ['leo', 'meo', 'geo', 'heo'].map((c, i) => crossing('o_' + i, c, i));

  global.SAT.bus = { on: () => {}, off: () => {}, emit: () => {} };
  global.SAT.clock = { getDate: () => new Date(T0) };
  global.SAT.stars = {
    isDeep: () => true,
    cone: (ra, dec, r) => {
      const out = [];
      for (let k = 0; k < 400; k++) {
        out.push({ raDeg: ra + (k % 20 - 10) * r / 12, decDeg: dec + (Math.floor(k / 20) - 10) * r / 12, mag: 3 + (k % 7) });
      }
      return out;
    },
    named: (ra, dec) => [{ raDeg: ra + 0.2, decDeg: dec + 0.1, name: 'Alnitak' }],
    constellationLines: (ra, dec) => [[
      { raDeg: ra - 1, decDeg: dec - 1 }, { raDeg: ra, decDeg: dec },
      { raDeg: ra + 1, decDeg: dec + 1 },
    ]],
  };
  global.SAT.state = {
    obs: {
      mode: 'radec', raDeg: RA0, decDeg: DEC0, azDeg: 180, elDeg: 60, track: 'sky',
      fovShape: 'rect', fovWDeg: 1.5, fovHDeg: 1.0, fovRDeg: 0.75,
      rotDeg: 0, flipEW: false, spanMin: 60, refraction: true, dut1S: 0,
    },
    settings: { chart: {} },
    selection: { satId: 'o_0' },
    scan: { crossings: CROSSINGS, stale: false },
    locations: [LOC],
    activeLocation: () => LOC,
    visibleCrossings: () => CROSSINGS,
    // round 2: the chart draws chartCrossings (the ticked-rows narrowing);
    // with nothing ticked it equals visibleCrossings
    chartCrossings: () => CROSSINGS,
    save: () => {},
    setObs: () => {},
    clickSelect: () => {},
  };

  const body = stubEl();
  let threw = null;
  try {
    C.init(body, { isOpen: () => true });
  } catch (e) { threw = e; }
  ok('init() completes', !threw, threw ? String(threw && threw.stack).split('\n')[0] : '');
  ok('render drew stars, tracks and text',
    calls.arc > 100 && calls.stroke > 50 && calls.fillText > 10,
    `arc ${calls.arc}, stroke ${calls.stroke}, fillText ${calls.fillText}, fill ${calls.fill}`);
  ok('HiDPI transform applied', calls.setTransform >= 1);

  // Now the cases most likely to be broken, one at a time. Any throw inside render()
  // is swallowed by the rAF guard in production, so assert on the console instead.
  const warn = console.warn;
  let warnings = 0;
  console.warn = (...a) => { warnings++; warn('      render warned:', a[0], a[1] && a[1].message); };

  const variants = [
    ['parked mount (stars trail)', { track: 'mount' }],
    ['alt/az pointing, parked', { mode: 'altaz', track: 'mount' }],
    ['circular FOV', { fovShape: 'circ' }],
    ['rotated 37° and mirrored', { rotDeg: 37, flipEW: true }],
    ['wide field (constellations)', { fovWDeg: 30, fovHDeg: 20 }],
    ['tiny field (arcsecond grid)', { fovWDeg: 0.01, fovHDeg: 0.008 }],
    ['near the pole', { decDeg: 89.4 }],
    ['across 0h RA', { raDeg: 0.05 }],
  ];
  // chart.js warns only ONCE per session by design (a broken layer must not spam the
  // console every frame), so a throw in a later variant would otherwise pass silently.
  // Count draw activity as well: a render that died early does far less work.
  function drawn() {
    return (calls.arc || 0) + (calls.stroke || 0) + (calls.fill || 0) +
      (calls.fillText || 0) + (calls.lineTo || 0);
  }
  const base = Object.assign({}, SAT.state.obs);
  for (const [name, patch] of variants) {
    Object.assign(SAT.state.obs, base, patch);
    const w0 = warnings, d0 = drawn();
    C.requestRender();
    const work = drawn() - d0;
    ok(name, warnings === w0 && work > 60, `${work} draw ops`);
  }

  // Every optional layer switched on at once — starNames, constNames and the
  // Milky Way default to false, so without this those branches are never
  // executed by any variant. The wide Orion field has real MW isophotes nearby.
  Object.assign(SAT.state.obs, base, { fovWDeg: 30, fovHDeg: 20 });
  Object.assign(SAT.state.settings.chart, {
    stars: true, starNames: true, constLines: true, constNames: true,
    sunMoon: true, mw: true, grid: true, labels: true, magLimit: 9,
  });
  let w1 = warnings, d1 = drawn(), a1 = calls.arc || 0;
  C.requestRender();
  ok('all layers enabled (incl. MW + CN)', warnings === w1 && drawn() - d1 > 60,
    `${drawn() - d1} draw ops`);
  ok('wide field draws a dense star layer', (calls.arc || 0) - a1 > 30,
    `${(calls.arc || 0) - a1} arcs`);

  // Point at the Sun so the Sun and Moon marker branches actually draw. Their
  // positions come from frames.js at the fixture epoch, so this is a real pointing.
  const sun = F.sunJ2000(new Date(T0));
  Object.assign(SAT.state.obs, base,
    { raDeg: sun.raDeg, decDeg: sun.decDeg, fovWDeg: 20, fovHDeg: 20 });
  w1 = warnings; d1 = drawn();
  C.requestRender();
  ok('Sun / Moon markers in field', warnings === w1 && drawn() - d1 > 60,
    `${drawn() - d1} draw ops, sun at RA ${sun.raDeg.toFixed(1)}°`);

  const moon = F.moonJ2000(new Date(T0));
  Object.assign(SAT.state.obs, base,
    { raDeg: moon.raDeg, decDeg: moon.decDeg, fovWDeg: 20, fovHDeg: 20 });
  w1 = warnings; d1 = drawn();
  C.requestRender();
  ok('Moon marker + separation note', warnings === w1 && drawn() - d1 > 60,
    `${drawn() - d1} draw ops, moon at RA ${moon.raDeg.toFixed(1)}°`);

  // no site at all, and no star catalogue: both must degrade, not throw
  Object.assign(SAT.state.obs, base, { mode: 'altaz', track: 'mount' });
  SAT.state.activeLocation = () => null;
  let w0 = warnings, d0 = drawn();
  C.requestRender();
  ok('no active location -> friendly message, no throw',
    warnings === w0 && drawn() - d0 >= 1, `${drawn() - d0} draw ops (message only)`);

  SAT.state.activeLocation = () => LOC;
  Object.assign(SAT.state.obs, base);
  const savedStars = SAT.stars;
  delete global.SAT.stars;
  w0 = warnings; d0 = drawn();
  C.requestRender();
  ok('missing SAT.stars -> no stars, no throw',
    warnings === w0 && drawn() - d0 > 60, `${drawn() - d0} draw ops`);
  global.SAT.stars = savedStars;

  console.warn = warn;
}

// ---------------------------------------------------------------- test 11
// Extended pass track (round 3): sampled over the whole scan window, cached on
// the crossing, below-horizon samples become gaps, and interpolation never
// bridges a gap.
console.log('\n[11] extended pass track');
{
  const T0 = Date.UTC(2026, 6, 21, 12, 0, 0);
  SAT.state.scan = {
    ranAt: new Date(T0 + 999),
    params: { t0Ms: T0, spanMin: 10 },
    crossings: [], checked: new Set(),
  };
  // extTrackOf resolves the ObjEntry through state.getObj — a crossing whose
  // object has left the catalogue must yield null, so the stub has to supply one
  const savedGetObj = SAT.state.getObj;
  SAT.state.getObj = id => (id === 'o_1' ? { id: 'o_1', norad: 1 } : null);
  // Deterministic fake look(): RA drifts 0.01 deg/s; below horizon for a window
  // in the middle of the span, so the track must carry a gap there.
  const savedLook = SAT.prop && SAT.prop.look;
  global.SAT.prop = global.SAT.prop || {};
  SAT.prop.look = (loc, obj, date) => {
    const dt = (date.getTime() - T0) / 1000;
    return {
      raDeg: 100 + dt * 0.01, decDeg: 20,
      elDeg: (dt > 200 && dt < 280) ? -5 : 45,   // 80 s below-horizon gap
    };
  };
  const cr = { satId: 'o_1', cls: 'leo', rateAsPerS: 36 };   // 0.01 deg/s
  const ext = C._extTrackOf(cr, { latDeg: 40, lonDeg: 116, altM: 0 });

  ok('track built and cached', !!ext && cr._ext === ext && cr._extK === SAT.state.scan.ranAt.getTime());
  const above = ext.filter(Boolean).length;
  const gaps = ext.length - above;
  ok('spans the whole window with a horizon gap',
    ext.length > 10 && gaps >= 1 && above >= ext.length - gaps, `${above} above, ${gaps} gap`);
  ok('second call returns the cache, not a rebuild', C._extTrackOf(cr, null) === ext);

  const mid = C._extPosAt(ext, T0 + 100 * 1000);       // inside the first run
  ok('interpolates inside an above-horizon run',
    !!mid && Math.abs(mid.raDeg - 101.0) < 0.5, mid && mid.raDeg.toFixed(3));
  const inGap = C._extPosAt(ext, T0 + 240 * 1000);      // inside the gap
  ok('never interpolates across a horizon gap', inGap === null, String(inGap));
  ok('outside the window is null', C._extPosAt(ext, T0 - 60 * 1000) === null);

  // a new scan invalidates: fresh ranAt forces a rebuild
  SAT.state.scan.ranAt = new Date(T0 + 5555);
  const ext2 = C._extTrackOf(cr, { latDeg: 40, lonDeg: 116, altM: 0 });
  ok('new scan key rebuilds the cache', ext2 !== ext && cr._extK === T0 + 5555);

  if (savedLook) SAT.prop.look = savedLook;
  SAT.state.getObj = savedGetObj;
}

// ---------------------------------------------------------------- test 12
// Adaptive star depth (round 14): the pure law, then the deep-field wiring —
// a narrow auto-mode view must consult SAT.stars.deepField at m17, draw the
// local cone while the fetch is out, and swap the online stars in when it lands.
console.log('\n[12] adaptive star depth (rounds 14/15)');
{
  const A = C.autoMagLimit;
  ok('law: 2° field -> 13 (deep tiles)', A(2) === 13, 'got ' + A(2));
  ok('law: 2.99° -> 13, strict boundary', A(2.99) === 13, 'got ' + A(2.99));
  ok('law: 3° -> 10.5 (local catalogue limit)', A(3) === 10.5, 'got ' + A(3));
  ok('law: 6° -> 9.0', A(6) === 9, 'got ' + A(6));
  ok('law: 12° -> 7.5', A(12) === 7.5, 'got ' + A(12));
  ok('law: 24° -> 6.0', A(24) === 6, 'got ' + A(24));
  ok('law: 60° -> floor 4.5', A(60) === 4.5, 'got ' + A(60));
  let mono = true, prev = Infinity;
  for (let d = 3; d <= 90; d += 0.25) {
    const m = A(d);
    if (m > prev + 1e-9) mono = false;
    prev = m;
  }
  ok('law: monotone non-increasing beyond 3°', mono);

  // ---- wiring: instrumented SAT.stars with a deep field that we control
  const T0 = Date.parse('2026-07-21T22:00:00Z');
  const LOC = {
    id: 'l1', name: 'Greenwich', latDeg: 51.4779, lonDeg: -0.0015, altM: 47,
    active: true, color: '#ff5252',
  };
  const deepCalls = [];
  const coneMags = [];
  let deepAnswer = { state: 'loading', stars: null };
  let onReadyCb = null;
  global.SAT.clock = { getDate: () => new Date(T0) };
  global.SAT.stars = {
    isDeep: () => true,
    localLimit: () => 10.5,
    cone: (ra, dec, r, mag) => {
      coneMags.push(mag);
      const out = [];
      for (let k = 0; k < 50; k++) {
        out.push({ raDeg: ra + (k % 10 - 5) * r / 8, decDeg: dec + (Math.floor(k / 10) - 2) * r / 8, mag: 4 + (k % 6) });
      }
      return out;
    },
    deepField: (ra, dec, r, mag, onReady) => {
      deepCalls.push({ r: r, mag: mag });
      onReadyCb = onReady;
      return deepAnswer;
    },
    named: () => [],
    constellationLines: () => [],
  };
  SAT.state.activeLocation = () => LOC;
  SAT.state.scan = { crossings: [], stale: false };
  SAT.state.visibleCrossings = () => [];
  SAT.state.chartCrossings = () => [];
  // 1.5° x 1.0° FOV in a 900x700 window: the enclosing view span is ~2.3° < 3°,
  // so auto mode wants the m17 online depth. Move the pointing 2° from wherever
  // the last render left the star cache, so ensureStars must re-query.
  Object.assign(SAT.state.obs, {
    mode: 'radec', raDeg: RA0 + 2, decDeg: DEC0, track: 'sky',
    fovShape: 'rect', fovWDeg: 1.5, fovHDeg: 1.0, rotDeg: 0, flipEW: false,
  });
  Object.assign(SAT.state.settings.chart, {
    stars: true, starNames: false, constLines: false, constNames: false,
    sunMoon: false, mw: false, grid: true, labels: true, magAuto: true,
  });
  C.fitView();

  ok('narrow auto view consulted deepField at m13',
    deepCalls.length >= 1 && deepCalls[deepCalls.length - 1].mag === 13,
    deepCalls.length + ' calls, mag ' + (deepCalls.length ? deepCalls[deepCalls.length - 1].mag : '—'));
  ok('local cone drew the interim field at the same limit',
    coneMags.length >= 1 && coneMags[coneMags.length - 1] === 13,
    'cone mags: ' + coneMags.join(','));

  // the fetch lands: onReady must invalidate and re-render, and the re-query
  // must take the online stars instead of the local cone
  const deepStars = [];
  for (let k = 0; k < 120; k++) {
    deepStars.push({ raDeg: RA0 + 2 + (k % 12 - 6) * 0.1, decDeg: DEC0 + (Math.floor(k / 12) - 5) * 0.1, mag: 10 + (k % 3) });
  }
  deepAnswer = { state: 'ready', stars: deepStars, truncated: false };
  const cones0 = coneMags.length, arcs0 = calls.arc || 0;
  ok('deepField handed a completion callback', typeof onReadyCb === 'function');
  onReadyCb();
  ok('deep stars swapped in without a local re-cone',
    coneMags.length === cones0 && (calls.arc || 0) - arcs0 > 100,
    (coneMags.length - cones0) + ' new cones, ' + ((calls.arc || 0) - arcs0) + ' arcs');

  // manual mode pins the limit and never touches the deep field
  const deeps1 = deepCalls.length;
  Object.assign(SAT.state.settings.chart, { magAuto: false, magLimit: 9 });
  Object.assign(SAT.state.obs, { raDeg: RA0 + 6 });   // move: force a re-query
  C.requestRender();
  ok('manual m9 stays local', deepCalls.length === deeps1 &&
    coneMags[coneMags.length - 1] === 9, 'cone mags tail: ' + coneMags.slice(-2).join(','));

  // wide auto field: the law sheds depth and stays local
  Object.assign(SAT.state.settings.chart, { magAuto: true });
  Object.assign(SAT.state.obs, { fovWDeg: 30, fovHDeg: 20, raDeg: RA0 });
  C.fitView();
  const wideMag = coneMags[coneMags.length - 1];
  ok('wide auto field stays local and shallow',
    deepCalls.length === deeps1 && wideMag < 10.5 + 1e-9 && wideMag >= 4.5,
    'cone mag ' + wideMag);

  // round 17: a pinned deep limit obeys the narrow-field gate — wide views
  // must never touch the tiles, however deep the pin.
  const deeps2 = deepCalls.length;
  Object.assign(SAT.state.settings.chart, { magAuto: false, magLimit: 13 });
  Object.assign(SAT.state.obs, { fovWDeg: 30, fovHDeg: 20, raDeg: RA0 + 4 });
  C.fitView();
  ok('pinned m13 on a wide field never touches the tiles',
    deepCalls.length === deeps2 && coneMags[coneMags.length - 1] === 13,
    (deepCalls.length - deeps2) + ' deep calls, cone mag ' + coneMags[coneMags.length - 1]);
  Object.assign(SAT.state.obs, { fovWDeg: 1.5, fovHDeg: 1.0, raDeg: RA0 + 8 });
  C.fitView();
  ok('pinned m13 on a narrow field uses the tiles',
    deepCalls.length === deeps2 + 1 && deepCalls[deepCalls.length - 1].mag === 13,
    (deepCalls.length - deeps2) + ' deep calls');
}

// ---------------------------------------------------------------- test 13
// Star dot law (round 15) — Stellarium's computeRCMag design on a canvas:
// flux-law radius above a 1 px floor, cubic luminance fade below it, hard
// cutoff, sqrt-compressed bright end, exposure shift for deep limits.
console.log('\n[13] starDot — Stellarium-derived dot law');
{
  const S = C.starDot;
  let d = S(0, 11);
  close('m0 at m11 limit: flux-law radius', d.rad, 5.2, 1e-9, 'px');
  ok('m0 full luminance', d.lum === 1, 'lum ' + d.lum);
  d = S(5, 9);
  close('m5 radius matches round 9', d.rad, 5.2 * Math.pow(10, -0.425), 1e-9, 'px');
  close('m5 luminance matches round 9', d.lum, 1.04 - 0.29, 1e-9, '');
  d = S(9, 9);
  ok('faint floor: radius pinned at 1 px', d.rad === 1, 'rad ' + d.rad);
  ok('faint floor: luminance faded cubically',
    Math.abs(d.lum - (1.04 - 0.058 * 9) * Math.pow(5.2 * Math.pow(10, -0.765), 3)) < 1e-9,
    'lum ' + d.lum.toFixed(4));

  // the exposure shift: a star AT the limit renders the same at every deep limit
  const at17 = S(17, 17), at11 = S(11, 11);
  ok('m17 at m17 == m11 at m11 (exposure shift)',
    at17.rad === at11.rad && Math.abs(at17.lum - at11.lum) < 1e-12,
    'lum ' + at17.lum.toFixed(4));
  ok('a star at the limit is nearly invisible', at17.lum < 0.1, 'lum ' + at17.lum.toFixed(4));
  ok('below the cutoff is culled, not drawn', S(20, 17) === null);

  d = S(0, 17);
  ok('bright end sqrt-compressed, not a blob', d.rad > 6.5 && d.rad < 9.5 && d.lum === 1,
    'rad ' + d.rad.toFixed(2));

  // monotone: fainter never gets bigger or brighter (until it disappears)
  let mono = true, pr = Infinity, pl = Infinity;
  for (let m = -1; m <= 18; m += 0.25) {
    const s = S(m, 17);
    if (!s) break;
    if (s.rad > pr + 1e-9 || s.lum > pl + 1e-9) mono = false;
    pr = s.rad; pl = s.lum;
  }
  ok('radius and luminance monotone in magnitude', mono);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
