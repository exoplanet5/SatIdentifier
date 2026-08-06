/* Verification for app/js/stars.js and app/js/photometry.js.
 * Run: node tools/test_stars.js
 *
 * The load-bearing tests are (a) that every star cone() returns is genuinely inside
 * the cone when rechecked with frames.sep — cone() uses a dot product against
 * cos(radius) and a bounding-box prefilter, and both are exactly the kind of
 * shortcut that silently loses stars near a pole or across the RA=0 seam — and
 * (b) that a 1 m sphere at 1000 km lands near 8th magnitude, which pins the whole
 * photometric chain (albedo, phase normalisation, metres-vs-km) to a known value.
 */
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');
const ASSET = path.join(__dirname, '..', 'app', 'assets', 'stars_m9.bin');

global.window = global;
global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
global.SAT = { ui: {} };
require(path.join(APP, 'frames.js'));
require(path.join(APP, 'vendor', 'starcat.js'));

// stars.js fetches its asset; in node we answer from disk. Returning a *copy* of the
// bytes in a fresh ArrayBuffer is what the browser does too, and it is what lets the
// module take typed-array views over the buffer without copying per star.
function shimFetch(file) {
  global.fetch = async (url) => {
    if (!file) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = fs.readFileSync(file);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  };
}

/** Load a fresh copy of a module, defeating require's cache, so the fallback path
 *  can be exercised in the same process as the deep-catalogue path. */
function reloadModule(name) {
  const p = path.join(APP, name);
  delete require.cache[require.resolve(p)];
  require(p);
}

const F = SAT.frames;
let failures = 0;

/** Independent reference implementation: parse the .bin here and scan it linearly
 *  with frames.sep. Shares no code with stars.js, which is the point. */
const RAW = (() => {
  const b = fs.readFileSync(ASSET);
  const n = b.readUInt32LE(4);
  const ra = [], dec = [], mag = [];
  for (let i = 0; i < n; i++) {
    ra.push(b.readFloatLE(12 + 4 * i));
    dec.push(b.readFloatLE(12 + 4 * n + 4 * i));
    mag.push(b.readInt16LE(12 + 8 * n + 2 * i) / 100);
  }
  return { n, ra, dec, mag };
})();

function bruteCone(ra0, dec0, radiusDeg, magLimit) {
  const out = [];
  for (let i = 0; i < RAW.n; i++) {
    if (RAW.mag[i] > magLimit) continue;
    if (F.sep(ra0, dec0, RAW.ra[i], RAW.dec[i]) <= radiusDeg) {
      out.push({ raDeg: RAW.ra[i], decDeg: RAW.dec[i], mag: RAW.mag[i] });
    }
  }
  return out;
}

function check(name, got, want, tol, unit) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${fmt(got)} vs ${fmt(want)} ${unit || ''} (tol ${tol})`);
}
function ok(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${detail == null ? '' : detail}`);
}
function fmt(v) {
  if (v == null || !isFinite(v)) return String(v);
  return Math.abs(v) >= 1e5 ? v.toExponential(4) : v.toFixed(4);
}

(async () => {

  // ================================================================ stars.js
  shimFetch(ASSET);
  reloadModule('stars.js');
  const S = SAT.stars;

  console.log('\n[1] deep catalogue loads');
  {
    const info = await S.load();
    ok('reports deep catalogue', info.deep === true, 'deep=' + info.deep);
    check('star count', info.count, 130183, 0, 'stars');
    check('count() agrees', S.count(), 130183, 0, 'stars');
    ok('isDeep()', S.isDeep() === true);
    check('localLimit() reads the header V cut', S.localLimit(), 9.0, 1e-6, 'mag');
    const bytes = fs.statSync(ASSET).size;
    check('asset size matches 12 + 10*count', bytes, 12 + 10 * info.count, 0, 'bytes');
  }

  // Orion's belt: the field the chart was designed around, and dense enough that a
  // broken dec-band search shows up as a wrong count rather than as zero.
  const RA0 = 84.0, DEC0 = -1.2;

  console.log('\n[2] cone query, Orion\'s belt (ra 84.0, dec -1.2, r 5 deg)');
  let big;
  {
    big = S.cone(RA0, DEC0, 5, 99);
    ok('plausible star count', big.length > 200 && big.length < 2000, big.length + ' stars');

    // Recheck every hit with the independent Vincenty separation in frames.js.
    let worst = 0;
    for (const s of big) worst = Math.max(worst, F.sep(RA0, DEC0, s.raDeg, s.decDeg));
    check('worst separation of a returned star', worst, 0, 5.0, 'deg');
    ok('no returned star outside the cone', worst <= 5.0, worst.toFixed(4) + ' deg');

    // ...and that nothing inside was missed. Reference count comes from an
    // independent linear scan of the raw file with frames.sep — deliberately not
    // from cone() itself, so the dec-band search and the RA prefilter are both
    // being checked against something that shares none of their logic.
    const brute = bruteCone(RA0, DEC0, 5.0, 99).length;
    check('vs brute-force scan of all 130183 stars', big.length, brute, 0, 'stars');
  }

  console.log('\n[2b] the 20000-result cap');
  {
    const all = S.cone(RA0, DEC0, 180, 99);
    check('all-sky query is capped', all.length, 20000, 0, 'stars');
    let faintest = -99;
    for (const s of all) faintest = Math.max(faintest, s.mag);
    // Capping must keep the BRIGHTEST, not the first found: the arrays are
    // dec-sorted, so a scan-order cut would return a dec-limited slab.
    const brightest20k = bruteCone(RA0, DEC0, 180, 99).map((s) => s.mag)
      .sort((a, b) => a - b)[19999];
    check('cap kept the brightest 20000', faintest, brightest20k, 0, 'mag');
    let north = 0, south = 0;
    for (const s of all) (s.decDeg > 0 ? north++ : south++);
    ok('cap did not slice the sky in declination', north > 3000 && south > 3000,
      north + ' north, ' + south + ' south');
  }

  console.log('\n[3] narrow cone — the case the deep catalogue exists for');
  {
    const small = S.cone(RA0, DEC0, 0.5, 99);
    ok('0.5 deg cone is small but non-empty', small.length > 0 && small.length < 100,
      small.length + ' stars');
    let worst = 0;
    for (const s of small) worst = Math.max(worst, F.sep(RA0, DEC0, s.raDeg, s.decDeg));
    ok('all within 0.5 deg', worst <= 0.5, 'worst ' + worst.toFixed(5) + ' deg');
  }

  console.log('\n[4] magnitude limit is respected');
  {
    const m7 = S.cone(RA0, DEC0, 5, 7.0);
    const m4 = S.cone(RA0, DEC0, 5, 4.0);
    let worst = -99;
    for (const s of m7) worst = Math.max(worst, s.mag);
    ok('no star fainter than the limit', worst <= 7.0, 'faintest ' + worst.toFixed(2));
    ok('limit actually cuts', m7.length < big.length && m4.length < m7.length,
      `${big.length} (all) > ${m7.length} (V<=7) > ${m4.length} (V<=4)`);
    // Counts cross-checked against a standalone read of the .bin in python.
    check('V<=7 count', m7.length, 91, 0, 'stars');
  }

  console.log('\n[5] bright stars are present with the right photometry');
  {
    const probes = [
      ['Sirius', 101.287, -16.716, -1.46],
      ['Vega', 279.234, 38.784, 0.03],
      ['Polaris', 37.955, 89.264, 1.98],   // also exercises the cone at the pole
    ];
    for (const [name, ra, dec, v] of probes) {
      const hits = S.cone(ra, dec, 0.05, 99);
      let best = null;
      for (const s of hits) if (!best || s.mag < best.mag) best = s;
      if (!best) { ok(name + ' found', false, 'MISSING'); continue; }
      const off = F.sep(ra, dec, best.raDeg, best.decDeg) * 3600;
      check(name + ' V', best.mag, v, 0.15, `mag (${off.toFixed(1)}" off)`);
    }
  }

  console.log('\n[6] wrap-around and pole edge cases');
  {
    // A cone straddling RA = 0 must not be cut in half by the bounding-box prefilter.
    const a = S.cone(0.0, 0.0, 3, 99).length;
    const b = S.cone(180.0, 0.0, 3, 99).length;
    ok('cone across the RA seam returns stars', a > 20, a + ' at RA 0, ' + b + ' at RA 180');
    let worst = 0;
    for (const s of S.cone(0.0, 0.0, 3, 99)) worst = Math.max(worst, F.sep(0, 0, s.raDeg, s.decDeg));
    ok('all within 3 deg across the seam', worst <= 3.0, 'worst ' + worst.toFixed(4));

    // A cone containing the pole: every RA is inside, so the prefilter must disable.
    const pole = S.cone(0, 89.0, 3, 99);
    let pw = 0, spread = 0;
    for (const s of pole) { pw = Math.max(pw, F.sep(0, 89, s.raDeg, s.decDeg)); spread = Math.max(spread, s.raDeg); }
    ok('polar cone stars all inside', pw <= 3.0, pole.length + ' stars, worst ' + pw.toFixed(4));
    ok('polar cone spans all RA', spread > 300, 'max RA ' + spread.toFixed(1));
  }

  console.log('\n[7] names and constellation lines (always from SAT.stardata)');
  {
    const n = S.named(RA0, DEC0, 10);
    ok('Orion names found', n.length >= 3, n.map((x) => x.name).join(', '));
    const lines = S.constellationLines(RA0, DEC0, 15);
    const pts = lines.reduce((a, p) => a + p.length, 0);
    ok('Orion figure returned', lines.length > 0, lines.length + ' polylines, ' + pts + ' points');
    ok('every polyline has >= 2 points', lines.every((p) => p.length >= 2));
    ok('empty far from any figure', S.named(84, -1.2, 0.01).length === 0);
  }

  console.log('\n[8] fallback to SAT.stardata when the asset is missing');
  {
    shimFetch(null);
    reloadModule('stars.js');
    const B = SAT.stars;
    const warn = console.warn; console.warn = () => {};   // the fallback warns; expected
    const info = await B.load();
    console.warn = warn;
    ok('reports shallow catalogue', info.deep === false && B.isDeep() === false);
    check('bright-star count', info.count, SAT.stardata.stars.length, 0, 'stars');
    const c = B.cone(RA0, DEC0, 10, 99);
    ok('cone still works on the fallback', c.length > 0 && c.length < 60, c.length + ' stars');
    let worstMag = -99, worstSep = 0;
    for (const s of c) { worstMag = Math.max(worstMag, s.mag); worstSep = Math.max(worstSep, F.sep(RA0, DEC0, s.raDeg, s.decDeg)); }
    ok('fallback respects the cone', worstSep <= 10.0, 'worst ' + worstSep.toFixed(4) + ' deg');
    ok('fallback is the V<=4.6 catalogue', worstMag <= 4.6, 'faintest ' + worstMag.toFixed(2));
    check('fallback localLimit', B.localLimit(), 4.6, 1e-6, 'mag');
  }

  console.log('\n[8b] deep tile set — tilesForCone + deepField (round 15)');
  {
    // STR1 tile bytes built here, independent of the app's writer — the format
    // is pinned by the CONTRACT, so the test constructs it from the spec.
    function tileBytes(stars) {
      const rows = stars.slice().sort((a, b) => a[1] - b[1]);
      const n = rows.length;
      const b = Buffer.alloc(12 + 10 * n);
      b.write('STR1', 0, 'ascii');
      b.writeUInt32LE(n, 4);
      b.writeFloatLE(13.0, 8);
      rows.forEach((s, i) => {
        b.writeFloatLE(s[0], 12 + 4 * i);
        b.writeFloatLE(s[1], 12 + 4 * n + 4 * i);
        b.writeInt16LE(s[2], 12 + 8 * n + 2 * i);
      });
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }

    const reqs = [];
    let present = true;
    const TILES = {
      't27_3.bin': tileBytes([
        [100.0, 20.0, 850], [100.1, 20.0, 1150], [99.9, 20.05, 1290],
        [105.0, 21.9, 300],                       // in the tile, outside the cone
      ]),
    };
    global.fetch = async (url) => {
      const u = String(url);
      if (u === '/api/stars/deep') {
        reqs.push(u);
        return { ok: true, status: 200,
                 json: async () => ({ ok: true, present: present, magLimit: 13, count: 4 }) };
      }
      if (u.startsWith('/api/stars/tile/')) {
        reqs.push(u);
        const name = u.slice('/api/stars/tile/'.length);
        if (!TILES[name]) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, arrayBuffer: async () => TILES[name] };
      }
      const b = fs.readFileSync(ASSET);
      return { ok: true, status: 200,
               arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    };
    reloadModule('stars.js');
    const D = SAT.stars;
    await D.load();
    check('deep localLimit from the binary header', D.localLimit(), 9.0, 1e-6, 'mag');

    // ---- tilesForCone, pure ----
    let t = D.tilesForCone(100.013, 20.019, 1.08);
    ok('mid-latitude cone maps to one tile', t.length === 1 && t[0] === 't27_3.bin', t.join(','));
    t = D.tilesForCone(1, 0, 3);
    ok('cone across RA 0 pulls both wrap columns',
      t.length === 6 && t.indexOf('t22_0.bin') >= 0 && t.indexOf('t22_11.bin') >= 0, t.join(','));
    t = D.tilesForCone(123, 88, 2);
    ok('polar cone is the single cap tile', t.length === 1 && t[0] === 't44_0.bin', t.join(','));
    t = D.tilesForCone(15, 84.5, 1);
    ok('near-polar band widens its RA reach', t.indexOf('t43_0.bin') >= 0 && t.length >= 1, t.join(','));

    // ---- deepField over the tile set ----
    let readyCount = 0;
    const onReady = () => readyCount++;
    const settle = () => new Promise((res) => setImmediate(res));

    let r = D.deepField(100.013, 20.019, 1.08, 13, onReady);
    ok('first call probes the index, loading', r.state === 'loading' && reqs[0] === '/api/stars/deep');
    await settle();
    ok('probe completion fired onReady', readyCount === 1, 'fired ' + readyCount);
    r = D.deepField(100.013, 20.019, 1.08, 13, onReady);
    ok('second call fetches the covering tile, loading',
      r.state === 'loading' && reqs[1] === '/api/stars/tile/t27_3.bin', reqs[1]);
    await settle();
    ok('tile arrival fired onReady', readyCount === 2, 'fired ' + readyCount);
    r = D.deepField(100.013, 20.019, 1.08, 13, onReady);
    ok('now ready with the cone subset of the tile',
      r.state === 'ready' && r.stars.length === 3, r.stars && r.stars.length + ' stars');
    ok('v100 decoded to magnitudes',
      r.stars.every((s) => [8.5, 11.5, 12.9].some((v) => Math.abs(s.mag - v) < 1e-3)));
    ok('magLimit filters within the tile',
      D.deepField(100.013, 20.019, 1.08, 12, onReady).stars.length === 2);
    r = D.deepField(100.2, 20.1, 0.9, 13, onReady);
    ok('pan inside the tile stays ready, no new request',
      r.state === 'ready' && reqs.length === 2, reqs.length + ' reqs');

    // ---- not built: 404 tile parks the whole feature ----
    const warn = console.warn; console.warn = () => {};   // the 404 warns; expected
    r = D.deepField(200, -40, 1, 13, onReady);            // t12_6-ish: not in TILES
    ok('missing tile starts as loading', r.state === 'loading');
    await settle();
    r = D.deepField(200, -40, 1, 13, onReady);
    ok('404 parks deepField in error', r.state === 'error');
    r = D.deepField(100.013, 20.019, 1.08, 13, onReady);
    ok('…for every field, with no retry storm',
      r.state === 'error' && reqs.length === 3, reqs.length + ' reqs total');
    console.warn = warn;

    // ---- index says not built ----
    present = false;
    reloadModule('stars.js');
    const D2 = SAT.stars;
    await D2.load();
    D2.deepField(100, 20, 1, 13, onReady);
    await settle();
    r = D2.deepField(100, 20, 1, 13, onReady);
    ok('absent tile set reports error after the probe', r.state === 'error');
  }

  // ============================================================ photometry.js
  require(path.join(APP, 'photometry.js'));
  const P = SAT.photo;

  console.log('\n[9] photometry: absolute scale');
  {
    // 1 m sphere, 1000 km, phase 90 deg. The textbook figure for a 1 m diffuse
    // sphere at 1000 km is roughly 8th magnitude; anything wildly off means a
    // metres/km slip, a wrong albedo, or a missing phase normalisation.
    const r = P.magnitude({}, { rangeKm: 1000, phaseDeg: 90, shadow: 'none' });
    check('1 m sphere @ 1000 km, phase 90', r.mag, 8.0, 1.0, 'mag');
    ok('method flagged as a guess', r.method === 'default', r.method);

    // Inverse-square: 10x the range is 5 magnitudes fainter.
    const far = P.magnitude({}, { rangeKm: 10000, phaseDeg: 90, shadow: 'none' });
    check('10x range costs 5 mag', far.mag - r.mag, 5.0, 1e-9, 'mag');

    // RCS tier: pi m^2 of RCS is an effective radius of exactly 1 m, so it must
    // reproduce the default tier bit for bit — that is the whole sqrt(rcs/pi) claim.
    const rcs = P.magnitude({ rcs: Math.PI }, { rangeKm: 1000, phaseDeg: 90, shadow: 'none' });
    check('rcs=pi m^2 matches the 1 m default', rcs.mag, r.mag, 1e-12, 'mag');
    ok('method is rcs', rcs.method === 'rcs', rcs.method);

    // qsmag tier: by definition stdMag is the magnitude at 1000 km and phase 90.
    const q = P.magnitude({ stdMag: 3.5, rcs: 10 }, { rangeKm: 1000, phaseDeg: 90, shadow: 'none' });
    check('qsmag at its defining geometry', q.mag, 3.5, 1e-12, 'mag');
    ok('qsmag outranks rcs', q.method === 'qsmag', q.method);
    const q2 = P.magnitude({ stdMag: 3.5 }, { rangeKm: 2000, phaseDeg: 90, shadow: 'none' });
    check('qsmag at 2x range', q2.mag - 3.5, 5 * Math.log10(2), 1e-12, 'mag');
  }

  console.log('\n[9b] photometry: model and type tiers');
  {
    // Everything at the same geometry, so only the tier differs.
    const G = { rangeKm: 1000, phaseDeg: 90, shadow: 'none' };
    const m = (o) => P.magnitude(o, G);

    const rb = m({ name: 'FALCON 9 R/B', type: 'R/B' });
    const pay = m({ name: 'COSMOS 2558', type: 'PAY' });
    const deb = m({ name: 'FENGYUN 1C DEB', type: 'DEB' });
    const unk = m({ name: 'OBJECT AX', type: 'UNK' });
    const sl = m({ name: 'STARLINK-31026', type: 'PAY' });
    const ow = m({ name: 'ONEWEB-0512', type: 'PAY' });
    console.log(`        R/B ${rb.mag.toFixed(2)}  PAY ${pay.mag.toFixed(2)}  ` +
      `DEB ${deb.mag.toFixed(2)}  STARLINK ${sl.mag.toFixed(2)}  ONEWEB ${ow.mag.toFixed(2)}` +
      `  (1000 km, phase 90)`);

    ok('R/B uses the type tier', rb.method === 'type', rb.method);
    ok('DEB uses the type tier', deb.method === 'type', deb.method);
    ok('UNK falls through to default', unk.method === 'default', unk.method);
    check('UNK equals the 1 m sphere', unk.mag, 7.9334, 0.001, 'mag');

    // A rocket body must be conspicuously brighter than debris — that ordering is
    // the entire point of the tier, and getting the radius ratio inverted would
    // still produce plausible-looking numbers.
    ok('R/B several mag brighter than DEB', deb.mag - rb.mag > 3,
      (deb.mag - rb.mag).toFixed(2) + ' mag');
    ok('brightness ordering R/B < PAY < DEB', rb.mag < pay.mag && pay.mag < deb.mag);
    // r=2 m vs r=1 m is exactly 4x the area.
    check('R/B vs PAY is the area ratio', pay.mag - rb.mag, 2.5 * Math.log10(4), 1e-12, 'mag');

    ok('Starlink uses the model tier', sl.method === 'model', sl.method);
    check('Starlink at its defining geometry', sl.mag, 7.0, 1e-12, 'mag');
    check('OneWeb at its defining geometry', ow.mag, 7.5, 1e-12, 'mag');
    ok('model beats the type prior', sl.method === 'model' && sl.mag !== pay.mag,
      `STARLINK ${sl.mag.toFixed(2)} via ${sl.method}, plain PAY ${pay.mag.toFixed(2)}`);
    ok('model matches case/whitespace insensitively',
      m({ name: '  starlink-1130  ' }).method === 'model');
    ok('a non-constellation name does not match', m({ name: 'STARSHINE 3' }).method === 'default');

    // Long-form OBJECT_TYPE spellings must work too, or a server.py change that
    // forwards the OMM wording would quietly drop the catalogue to 'default'.
    ok('long-form OBJECT_TYPE accepted',
      m({ type: 'ROCKET BODY' }).method === 'type' && m({ type: 'PAYLOAD' }).method === 'type' &&
      m({ type: 'Debris' }).method === 'type');
    check('ROCKET BODY == R/B', m({ type: 'ROCKET BODY' }).mag, rb.mag, 1e-12, 'mag');
  }

  console.log('\n[9c] tier precedence, best first');
  {
    const G = { rangeKm: 1000, phaseDeg: 90, shadow: 'none' };
    // One object carrying every input at once: each tier must be selected only
    // when everything better is absent.
    const full = { stdMag: 3.5, rcs: 10, name: 'STARLINK-31026', type: 'R/B' };
    ok('stdMag wins over everything', P.magnitude(full, G).method === 'qsmag');
    const noStd = { rcs: 10, name: 'STARLINK-31026', type: 'R/B' };
    ok('rcs wins over model and type', P.magnitude(noStd, G).method === 'rcs');
    const noRcs = { name: 'STARLINK-31026', type: 'R/B' };
    ok('model wins over type', P.magnitude(noRcs, G).method === 'model');
    const noName = { type: 'R/B' };
    ok('type wins over default', P.magnitude(noName, G).method === 'type');
    ok('nothing at all -> default', P.magnitude({}, G).method === 'default');

    // A real RCS must be preferred to the type prior even when the two disagree
    // sharply: a 0.05 m^2 rocket-body fragment is measured, the 2 m class is assumed.
    const measured = P.magnitude({ rcs: 0.05, type: 'R/B' }, G);
    const assumed = P.magnitude({ type: 'R/B' }, G);
    ok('measured rcs beats the R/B prior', measured.method === 'rcs',
      `rcs ${measured.mag.toFixed(2)} vs type prior ${assumed.mag.toFixed(2)}`);
    ok('and they genuinely differ', Math.abs(measured.mag - assumed.mag) > 3,
      Math.abs(measured.mag - assumed.mag).toFixed(2) + ' mag apart');

    // rcs = 0 is "not measured", not "a point target" — it must not shadow the prior.
    ok('rcs of 0 falls through to the type tier',
      P.magnitude({ rcs: 0, type: 'R/B' }, G).method === 'type');

    // The new tiers must obey range and phase exactly like the old ones.
    const near = P.magnitude({ type: 'R/B' }, G);
    const far = P.magnitude({ type: 'R/B' }, { rangeKm: 10000, phaseDeg: 90, shadow: 'none' });
    check('type tier obeys inverse square', far.mag - near.mag, 5.0, 1e-9, 'mag');
    const slFar = P.magnitude({ name: 'STARLINK-1' }, { rangeKm: 2000, phaseDeg: 90, shadow: 'none' });
    check('model tier obeys inverse square', slFar.mag - 7.0, 5 * Math.log10(2), 1e-12, 'mag');
    ok('eclipse still overrides every tier',
      P.magnitude({ type: 'R/B' }, { rangeKm: 1000, phaseDeg: 90, shadow: 'umbra' }).mag === null);
  }

  console.log('\n[10] photometry: phase function');
  {
    // F(phi) peaks at phase 0, so the magnitude must be minimal there and must
    // increase monotonically to 180. Checked through magnitude() rather than the
    // raw phase function, because that is the only surface the app exposes.
    let prev = -Infinity, mono = true;
    const at = {};
    for (let p = 0; p <= 180; p += 5) {
      const m = P.magnitude({}, { rangeKm: 1000, phaseDeg: p, shadow: 'none' }).mag;
      at[p] = m;
      if (m < prev - 1e-12) mono = false;
      prev = m;
    }
    ok('brightest at phase 0', at[0] < at[5] && at[0] < at[90] && at[0] < at[180],
      `phase 0: ${at[0].toFixed(2)}, 90: ${at[90].toFixed(2)}, 180: ${at[180].toFixed(2)}`);
    ok('monotonically fainter to phase 180', mono);
    // F(0)/F(90) = (2/(3pi))/(2/(3pi^2)) = pi, so full phase is 2.5*log10(pi) brighter.
    check('phase 0 vs 90 amplitude', at[90] - at[0], 2.5 * Math.log10(Math.PI), 1e-9, 'mag');
  }

  console.log('\n[11] photometry: eclipse and penumbra');
  {
    const u = P.magnitude({ stdMag: 3.5 }, { rangeKm: 1000, phaseDeg: 60, shadow: 'umbra' });
    ok('umbra returns mag null', u.mag === null, 'mag=' + u.mag + ' method=' + u.method);
    const p0 = P.magnitude({ stdMag: 3.5 }, { rangeKm: 1000, phaseDeg: 60, shadow: 'penumbra' });
    ok('bare penumbra string returns null', p0.mag === null, 'method=' + p0.method);
    const lit = P.magnitude({ stdMag: 3.5 }, { rangeKm: 1000, phaseDeg: 60, shadow: 'none' });
    const half = P.magnitude({ stdMag: 3.5 },
      { rangeKm: 1000, phaseDeg: 60, shadow: { state: 'penumbra', frac: 0.5 } });
    check('half-obscured Sun dims by 2.5*log10(2)', half.mag - lit.mag,
      2.5 * Math.log10(2), 1e-12, 'mag');
  }

  console.log('\n[12] shadowState geometry');
  {
    const date = new Date('2026-07-21T00:00:00Z');
    const sun = F.sunTemeKm(date);
    const sHat = { x: sun.x, y: sun.y, z: sun.z };
    const sn = Math.hypot(sHat.x, sHat.y, sHat.z);
    sHat.x /= sn; sHat.y /= sn; sHat.z /= sn;

    // Sunward of the Earth at LEO altitude: always lit.
    const lit = P.shadowState({ x: sHat.x * 7000, y: sHat.y * 7000, z: sHat.z * 7000 }, date);
    ok('sunward object is unshadowed', lit.state === 'none' && lit.frac === 1, lit.state);

    // Directly anti-sunward at LEO: deep in the umbra.
    const dark = P.shadowState({ x: -sHat.x * 7000, y: -sHat.y * 7000, z: -sHat.z * 7000 }, date);
    ok('anti-sunward object is in the umbra', dark.state === 'umbra' && dark.frac === 0, dark.state);

    // Walk the terminator: from the shadow axis outward there must be exactly one
    // umbra -> penumbra -> none transition, with frac rising monotonically.
    const perp = { x: -sHat.y, y: sHat.x, z: 0 };
    const pn = Math.hypot(perp.x, perp.y, perp.z);
    perp.x /= pn; perp.y /= pn; perp.z /= pn;
    const R = 7000;
    const seen = [];
    let lastFrac = -1, monoFrac = true, nPen = 0;
    for (let a = 0; a <= 90; a += 0.05) {
      const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180);
      const v = {
        x: -sHat.x * R * ca + perp.x * R * sa,
        y: -sHat.y * R * ca + perp.y * R * sa,
        z: -sHat.z * R * ca + perp.z * R * sa,
      };
      const st = P.shadowState(v, date);
      if (st.state === 'penumbra') nPen++;
      if (!seen.length || seen[seen.length - 1] !== st.state) seen.push(st.state);
      if (st.frac < lastFrac - 1e-12) monoFrac = false;
      lastFrac = st.frac;
    }
    ok('umbra -> penumbra -> none, once', seen.join(' -> ') === 'umbra -> penumbra -> none',
      seen.join(' -> '));
    ok('unobscured fraction rises monotonically', monoFrac);
    ok('penumbra is a real band, not a knife edge', nPen > 3, nPen + ' samples of 0.05 deg');
  }

  console.log('\n[13] phaseAngleDeg');
  {
    // Observer at the origin-ish, satellite at +x, Sun far along +x: the Sun is
    // behind the satellite as seen from the observer -> phase 180.
    const sat = { x: 7000, y: 0, z: 0 };
    const site = { x: 6378, y: 0, z: 0 };
    const sunFar = { x: 1.5e8, y: 0, z: 0 };
    check('back-lit', P.phaseAngleDeg(sunFar, site, sat), 180, 1e-6, 'deg');
    check('side-lit', P.phaseAngleDeg({ x: 7000, y: 1.5e8, z: 0 }, site, sat), 90, 0.01, 'deg');
    check('front-lit', P.phaseAngleDeg({ x: -1.5e8, y: 0, z: 0 }, site, sat), 0, 1e-6, 'deg');
  }

  // [14] streak — removed 2026-07-21 with the exposure-simulator feature: the
  // trail across the FOV (path + entry/exit + rate) is the identification tool;
  // a separate per-exposure streak length duplicated it and needed a plate scale
  // the user did not want to supply.

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
