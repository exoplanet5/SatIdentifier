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
  let loadPromise = null;

  const norm360 = (d) => ((d % 360) + 360) % 360;
  const brightData = () => (typeof SAT !== 'undefined' && SAT.stardata) || {};

  // ---- loading -------------------------------------------------------------

  /** Attach typed-array views to a fetched buffer, or throw if it is not our file.
   *
   * Validating the magic and the length is not paranoia: a dev server that answers a
   * missing asset with an HTML 404 page returns a perfectly good ArrayBuffer, and
   * without these two checks it would become 130 000 NaN stars instead of a fallback.
   */
  function adoptBuffer(buf) {
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
    raArr = new Float32Array(buf, HEADER_BYTES, n);
    decArr = new Float32Array(buf, HEADER_BYTES + 4 * n, n);
    mag100Arr = new Int16Array(buf, HEADER_BYTES + 8 * n, n);
    starCount = n;
    deep = true;
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

  /** First index whose declination is >= v (or > v when `strict`).
   *  This binary search is the entire reason the builder sorts by declination. */
  function bound(v, strict) {
    let lo = 0, hi = starCount;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (strict ? decArr[m] <= v : decArr[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** Stars within radiusDeg of (ra0, dec0), brighter than magLimit.
   *  Returns [{raDeg, decDeg, mag}, ...], at most MAX_RESULTS entries. */
  function cone(ra0, dec0, radiusDeg, magLimit) {
    const out = [];
    if (!starCount || !(radiusDeg > 0)) return out;

    const r0 = norm360(ra0);
    const lim100 = (magLimit == null || !isFinite(magLimit)) ? 32767 : Math.round(magLimit * 100);
    const lo = bound(dec0 - radiusDeg, false);
    const hi = bound(dec0 + radiusDeg, true);

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
      if (mag100Arr[i] > lim100) continue;
      const ra = raArr[i];
      let dRa = ra - r0;
      if (raHalf < 180) {
        const wrapped = Math.abs(((dRa + 540) % 360) - 180);
        if (wrapped > raHalf) continue;
      }
      // Exact cone membership, as a dot product against cos(radius): mathematically
      // identical to sep() <= radius but without the acos, which is not free at this
      // call count. Verified against frames.sep in tools/test_stars.js.
      const dec = decArr[i] * D2R;
      const dot = sd0 * Math.sin(dec) + cd0 * Math.cos(dec) * Math.cos(dRa * D2R);
      if (dot >= cosR) out.push({ raDeg: ra, decDeg: decArr[i], mag: mag100Arr[i] / 100 });
    }

    if (out.length > MAX_RESULTS) {
      // Keep the brightest, not the first found. The arrays are dec-sorted, so
      // truncating in scan order would shear the northern half off the field and
      // look exactly like a chart bug; dropping the faintest degrades gracefully.
      out.sort((a, b) => a.mag - b.mag);
      out.length = MAX_RESULTS;
    }
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

  // ---- status --------------------------------------------------------------

  /** True when the deep catalogue is live; false on the bright-star fallback.
   *  The chart uses this to warn that a narrow field will look empty. */
  const isDeep = () => deep;

  /** Number of stars in whichever catalogue is live. */
  const count = () => starCount;

  SAT.stars = { load, cone, named, constellationLines, isDeep, count };
})();
