/* SAT.stars — the star field the chart draws satellites against.
 *
 * At a 1 degree field the bright-star catalogue SatObserver ships (V <= 4.6, ~1000
 * stars over the whole sky) shows literally nothing, which is why tools/make_starcat.py
 * exists and why this module prefers assets/stars_m9.bin (130 183 stars to V = 9.0).
 * The bright catalogue is still the fallback, so the app runs before anyone has built
 * the asset — isDeep() tells the UI which one is live so it can say so.
 *
 * The binary is a structure of arrays precisely so that loading it costs one fetch and
 * three typed-array constructions: no per-star parsing, no object allocation, no
 * DataView. Declination is sorted ascending so a cone query is a binary search over a
 * dec band followed by an exact test on the survivors. See tools/make_starcat.py for
 * the format and the three data-quality decisions baked into the asset.
 */
(function () {
  'use strict';

  // Tried in order. stars_deep.bin is the Gaia DR3 build (V <= 10.5, proper
  // motions applied to the current epoch — the Tycho file's J2000 mean places
  // put high-PM stars up to ~4' off by 2026); stars_m9.bin is the committed
  // Tycho-2 fallback so the app still works before the deep build has been run.
  const ASSETS = ['assets/stars_deep.bin', 'assets/stars_m9.bin'];
  const HEADER_BYTES = 12;          // magic + count + magLimit
  const BYTES_PER_STAR = 10;        // float32 ra + float32 dec + int16 mag
  const MAX_RESULTS = 20000;        // contract cap on a single cone query
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // The live catalogue, structure of arrays. When deep these are views straight over
  // the fetched ArrayBuffer (no copy); when falling back they are built once from
  // SAT.stardata into the same shape, so cone() has exactly one implementation.
  let raArr = null, decArr = null, mag100Arr = null;
  let starCount = 0;
  let deep = false;
  let localMag = 0;                 // the live catalogue's V limit (binary header)
  let loadPromise = null;

  const norm360 = (d) => ((d % 360) + 360) % 360;
  const brightData = () => (typeof SAT !== 'undefined' && SAT.stardata) || {};

  // ---- loading -------------------------------------------------------------

  /** Parse an STR1 buffer into typed-array views, or throw if it is not our file.
   *
   * Validating the magic and the length is not paranoia: a dev server that answers a
   * missing asset with an HTML 404 page returns a perfectly good ArrayBuffer, and
   * without these two checks it would become 130 000 NaN stars instead of a fallback.
   * Shared by the bundled catalogue and the round-15 deep tiles — one parser, one
   * set of validations.
   */
  function parseStr1(buf) {
    if (buf.byteLength < HEADER_BYTES) throw new Error('truncated header');
    const magic = String.fromCharCode.apply(null, new Uint8Array(buf, 0, 4));
    if (magic !== 'STR1') throw new Error('bad magic "' + magic + '"');
    const head = new DataView(buf, 0, HEADER_BYTES);
    const n = head.getUint32(4, true);
    const want = HEADER_BYTES + BYTES_PER_STAR * n;
    if (!n || buf.byteLength < want) {
      throw new Error('count ' + n + ' needs ' + want + ' bytes, got ' + buf.byteLength);
    }
    // Offsets 12, 12+4n and 12+8n are all multiples of 4, so every view is naturally
    // aligned — the whole reason the format is a structure of arrays rather than an
    // interleaved 10-byte record, which would be misaligned and force a slow DataView.
    return {
      ra: new Float32Array(buf, HEADER_BYTES, n),
      dec: new Float32Array(buf, HEADER_BYTES + 4 * n, n),
      mag100: new Int16Array(buf, HEADER_BYTES + 8 * n, n),
      n: n,
      magLimit: head.getFloat32(8, true) || 9.0,
    };
  }

  function adoptBuffer(buf) {
    const t = parseStr1(buf);
    raArr = t.ra;
    decArr = t.dec;
    mag100Arr = t.mag100;
    starCount = t.n;
    deep = true;
    // The header's V limit (10.5 Gaia / 9.0 Tycho) tells the chart when a wanted
    // depth is beyond this file and the deep tile set is needed (round 15).
    localMag = t.magLimit;
  }

  /** Build the same three arrays from SAT.stardata, sorted by declination.
   *
   * Paying the sort here rather than special-casing the fallback in cone() keeps one
   * query path, so the fallback cannot rot: every test that exercises cone() exercises
   * both catalogues. starcat.js stores RA in [-180, 180]; the binary uses [0, 360).
   */
  function adoptBright() {
    const rows = (brightData().stars || []).slice().sort((a, b) => a[1] - b[1]);
    const n = rows.length;
    raArr = new Float32Array(n);
    decArr = new Float32Array(n);
    mag100Arr = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      raArr[i] = norm360(rows[i][0]);
      decArr[i] = rows[i][1];
      mag100Arr[i] = Math.round(rows[i][2] * 100);
    }
    starCount = n;
    deep = false;
    localMag = 4.6;                 // the bright catalogue's nominal V limit
  }

  /** Load the deep catalogue once. Never rejects: a missing or malformed asset
   *  degrades to the bright catalogue rather than taking the chart down with it. */
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      let loaded = false;
      for (const asset of ASSETS) {
        try {
          const resp = await fetch(asset);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          adoptBuffer(await resp.arrayBuffer());
          loaded = true;
          break;
        } catch (e) {
          console.warn('SAT.stars: ' + asset + ' unusable (' + e.message + ')');
        }
      }
      if (!loaded) {
        console.warn('SAT.stars: no deep catalogue — falling back to the bright catalogue');
        adoptBright();
      }
      return { count: starCount, deep: deep };
    })();
    return loadPromise;
  }

  // ---- cone query ----------------------------------------------------------

  /** First index in `arr[0..n)` whose declination is >= v (or > v when `strict`).
   *  This binary search is the entire reason the builder sorts by declination. */
  function bound(arr, n, v, strict) {
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (strict ? arr[m] <= v : arr[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** The cone kernel over one STR1 array set, pushing matches into `out`.
   *  Shared by cone() (the bundled catalogue) and deepField() (each tile),
   *  so both sources go through exactly one tested implementation. */
  function coneInto(t, ra0, dec0, radiusDeg, lim100, out) {
    const r0 = norm360(ra0);
    const lo = bound(t.dec, t.n, dec0 - radiusDeg, false);
    const hi = bound(t.dec, t.n, dec0 + radiusDeg, true);

    // Bounding half-width in RA at the band's extreme declination. Rejecting on this
    // costs one subtraction where the exact test costs three trig calls, and the
    // all-sky view asks for tens of degrees over 130k stars — that is where it pays.
    // Undefined once the band reaches a pole (every RA is in the cone), hence 180.
    const dMax = Math.min(Math.max(Math.abs(dec0 - radiusDeg), Math.abs(dec0 + radiusDeg)), 90);
    const cdMax = Math.cos(dMax * D2R);
    const sinR = Math.sin(radiusDeg * D2R);
    const raHalf = (radiusDeg >= 90 || sinR >= cdMax) ? 180 : Math.asin(sinR / cdMax) * R2D;

    const cosR = Math.cos(radiusDeg * D2R);
    const d0 = dec0 * D2R, sd0 = Math.sin(d0), cd0 = Math.cos(d0);

    for (let i = lo; i < hi; i++) {
      if (t.mag100[i] > lim100) continue;
      const ra = t.ra[i];
      let dRa = ra - r0;
      if (raHalf < 180) {
        const wrapped = Math.abs(((dRa + 540) % 360) - 180);
        if (wrapped > raHalf) continue;
      }
      // Exact cone membership, as a dot product against cos(radius): mathematically
      // identical to sep() <= radius but without the acos, which is not free at this
      // call count. Verified against frames.sep in tools/test_stars.js.
      const dec = t.dec[i] * D2R;
      const dot = sd0 * Math.sin(dec) + cd0 * Math.cos(dec) * Math.cos(dRa * D2R);
      if (dot >= cosR) out.push({ raDeg: ra, decDeg: t.dec[i], mag: t.mag100[i] / 100 });
    }
  }

  /** Keep the brightest MAX_RESULTS, not the first found. The arrays are
   *  dec-sorted, so truncating in scan order would shear the northern half off
   *  the field and look exactly like a chart bug; dropping the faintest
   *  degrades gracefully. Returns true when a cut happened. */
  function capBrightest(out) {
    if (out.length <= MAX_RESULTS) return false;
    out.sort((a, b) => a.mag - b.mag);
    out.length = MAX_RESULTS;
    return true;
  }

  /** Stars within radiusDeg of (ra0, dec0), brighter than magLimit.
   *  Returns [{raDeg, decDeg, mag}, ...], at most MAX_RESULTS entries. */
  function cone(ra0, dec0, radiusDeg, magLimit) {
    const out = [];
    if (!starCount || !(radiusDeg > 0)) return out;
    const lim100 = (magLimit == null || !isFinite(magLimit)) ? 32767 : Math.round(magLimit * 100);
    coneInto({ ra: raArr, dec: decArr, mag100: mag100Arr, n: starCount },
      ra0, dec0, radiusDeg, lim100, out);
    capBrightest(out);
    return out;
  }

  // ---- names and constellation lines ---------------------------------------
  // Always from SAT.stardata: the binary carries no identities, and these are drawn
  // only on wide fields (> 5 deg), where the bright catalogue is exactly right.

  /** Proper names of bright stars in the field: [{raDeg, decDeg, name}, ...]. */
  function named(ra0, dec0, radiusDeg) {
    const src = brightData().names || [];
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const ra = norm360(src[i][0]), dec = src[i][1];
      if (SAT.frames.sep(ra0, dec0, ra, dec) <= radiusDeg) {
        out.push({ raDeg: ra, decDeg: dec, name: src[i][2] });
      }
    }
    return out;
  }

  /** Great-circle midpoint, used only to decide whether a segment crosses the field. */
  function midpoint(ra1, dec1, ra2, dec2) {
    const a = SAT.frames.raDecToVec(ra1, dec1), b = SAT.frames.raDecToVec(ra2, dec2);
    return SAT.frames.vecToRaDec({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  }

  /** Constellation figures clipped to the field: [[{raDeg, decDeg}, ...], ...].
   *
   * A segment is kept when either endpoint OR its midpoint is inside — the midpoint
   * test is what keeps a long segment that crosses the field with both stars outside
   * it, which is common at the 5-10 deg fields where these are drawn at all. Runs of
   * kept segments are emitted as one polyline so the chart can stroke each in a
   * single path.
   */
  function constellationLines(ra0, dec0, radiusDeg) {
    const src = brightData().lines || [];
    const sep = SAT.frames.sep;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const poly = src[i];
      let run = null;
      for (let k = 0; k + 1 < poly.length; k++) {
        const a = { raDeg: norm360(poly[k][0]), decDeg: poly[k][1] };
        const b = { raDeg: norm360(poly[k + 1][0]), decDeg: poly[k + 1][1] };
        let near = sep(ra0, dec0, a.raDeg, a.decDeg) <= radiusDeg ||
          sep(ra0, dec0, b.raDeg, b.decDeg) <= radiusDeg;
        if (!near) {
          const m = midpoint(a.raDeg, a.decDeg, b.raDeg, b.decDeg);
          near = sep(ra0, dec0, m.raDeg, m.decDeg) <= radiusDeg;
        }
        if (!near) { run = null; continue; }
        if (!run) { run = [a]; out.push(run); }
        run.push(b);
      }
    }
    return out;
  }

  // ---- deep tile set (rounds 15-16) ----------------------------------------
  // The chart's < 3° views go deeper than the bundled catalogue — V = 13 since
  // round 16 (the m17 build measured ~1.4 GB, m13 is ~60 MB; user's call) — in
  // a LOCAL tile set (data/deepstars/, built once by make_starcat.py
  // --deep-tiles) loaded on demand from the local server. The round-14 online
  // VizieR fetch is gone: no runtime network access, and the states below are
  // about local files only. Scheme (CONTRACT "Deep tile set"): 4° dec bands
  // 0..44, single polar tiles at |dec| >= 86, twelve 30° RA columns elsewhere.
  const TILE_BAND = 4, TILE_COLS = 12, TILE_COL_DEG = 30;
  const TILE_LRU = 16;              // tiles kept in memory (~1 MB each)
  let deepIdx = null;               // null = not probed; {present:false} | index
  let deepProbing = false;
  let deepBroken = false;           // tile 404/parse failure: treat as not built
  const tileCache = new Map();      // name -> parsed STR1 arrays (insertion = LRU)
  const tileFetching = new Set();

  /** Tile names covering a cone. Pure; handles the RA wrap and the polar caps.
   *  Over-covers slightly (the RA half-width is taken at the band's extreme
   *  declination) — an extra ~1 MB tile load beats a star missing at a corner. */
  function tilesForCone(ra0, dec0, radiusDeg) {
    const out = [];
    const r0 = norm360(ra0);
    const dLo = Math.max(-90, dec0 - radiusDeg);
    const dHi = Math.min(90, dec0 + radiusDeg);
    const b0 = Math.min(44, Math.max(0, Math.floor((dLo + 90) / TILE_BAND)));
    const b1 = Math.min(44, Math.max(0, Math.floor((dHi + 90) / TILE_BAND)));
    for (let b = b0; b <= b1; b++) {
      if (b === 0 || b === 44) { out.push('t' + b + '_0.bin'); continue; }
      const e0 = -90 + b * TILE_BAND;
      const dMax = Math.min(89.9, Math.max(Math.abs(e0), Math.abs(e0 + TILE_BAND)));
      const cd = Math.cos(dMax * D2R);
      const sinR = Math.sin(Math.min(89.9, radiusDeg) * D2R);
      if (sinR >= cd) {                       // cone wraps every RA at this band
        for (let c = 0; c < TILE_COLS; c++) out.push('t' + b + '_' + c + '.bin');
        continue;
      }
      const raHalf = Math.asin(sinR / cd) * R2D;
      const k0 = Math.floor((r0 - raHalf) / TILE_COL_DEG);
      const k1 = Math.floor((r0 + raHalf) / TILE_COL_DEG);
      for (let k = k0; k <= k1; k++) {
        const nm = 't' + b + '_' + (((k % TILE_COLS) + TILE_COLS) % TILE_COLS) + '.bin';
        if (out.indexOf(nm) < 0) out.push(nm);
      }
    }
    return out;
  }

  /** Evict least-recently-used tiles beyond the cap, never one needed now. */
  function evictTiles(keep) {
    for (const k of Array.from(tileCache.keys())) {
      if (tileCache.size <= TILE_LRU) break;
      if (keep.indexOf(k) < 0) tileCache.delete(k);
    }
  }

  /** Deep star source for the chart's narrow fields, from the local tile set.
   *  Never throws, never rejects. Returns {state:'ready'|'loading'|'error',
   *  stars, truncated} plus, when ready, `magLimit` — the tile set's actual
   *  V cut, which the chart's dot law keys on (a build shallower than the
   *  wanted depth must render as what it is). While not 'ready' the caller
   *  draws the bundled catalogue instead. 'error' means the tile set is not
   *  built (or the local server went away) — parked until the next page load,
   *  no retry storm. onReady fires when the probe or a tile batch completes. */
  function deepField(ra0, dec0, radiusDeg, magLimit, onReady) {
    const fail = { state: 'error', stars: null, truncated: false };
    if (deepBroken || (deepIdx && !deepIdx.present)) return fail;

    if (!deepIdx) {                           // presence probe, once per load
      if (!deepProbing) {
        deepProbing = true;
        fetch('/api/stars/deep')
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((d) => { deepIdx = (d && d.present) ? d : { present: false }; })
          .catch(() => { deepIdx = { present: false }; })
          .then(() => { if (onReady) { try { onReady(); } catch (e) { /* ignore */ } } });
      }
      return { state: 'loading', stars: null, truncated: false };
    }

    const names = tilesForCone(ra0, dec0, radiusDeg);
    let pending = false;
    for (const nm of names) {
      if (tileCache.has(nm) || tileFetching.has(nm)) {
        pending = pending || tileFetching.has(nm);
        continue;
      }
      pending = true;
      tileFetching.add(nm);
      fetch('/api/stars/tile/' + nm)
        .then((resp) => {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.arrayBuffer();
        })
        .then((buf) => {
          tileFetching.delete(nm);
          tileCache.set(nm, parseStr1(buf));
          evictTiles(names);
          if (!tileFetching.size && onReady) { try { onReady(); } catch (e) { /* ignore */ } }
        })
        .catch((e) => {
          tileFetching.delete(nm);
          deepBroken = true;
          console.warn('SAT.stars deep tile ' + nm + ': ' + (e && e.message));
          if (onReady) { try { onReady(); } catch (e2) { /* ignore */ } }
        });
    }
    if (pending) return { state: 'loading', stars: null, truncated: false };

    // Every tile cached: merge per-tile cones through the shared kernel.
    const lim100 = (magLimit == null || !isFinite(magLimit)) ? 32767 : Math.round(magLimit * 100);
    const out = [];
    for (const nm of names) {
      const t = tileCache.get(nm);
      tileCache.delete(nm); tileCache.set(nm, t);   // LRU touch
      coneInto(t, ra0, dec0, radiusDeg, lim100, out);
    }
    return {
      state: 'ready', stars: out, truncated: capBrightest(out),
      magLimit: deepIdx.magLimit,
    };
  }

  // ---- status --------------------------------------------------------------

  /** True when the deep catalogue is live; false on the bright-star fallback.
   *  The chart uses this to warn that a narrow field will look empty. */
  const isDeep = () => deep;

  /** Number of stars in whichever catalogue is live. */
  const count = () => starCount;

  /** The live catalogue's magnitude limit — what cone() can actually deliver. */
  const localLimit = () => localMag;

  SAT.stars = {
    load, cone, named, constellationLines,
    deepField, tilesForCone, isDeep, count, localLimit,
  };
})();
