/* SAT.scan — the heart of the tool: who is in my field of view?
 *
 * Owns a pool of classic Web Workers, each holding a shard of the catalogue and its
 * satrecs. This file does almost no arithmetic: its job is to shard, to keep the
 * workers loaded, to merge and sort, and to be honest with the UI about what was
 * culled and what was truncated.
 *
 * The one structural rule that matters here (CONTRACT.md "Performance decisions"):
 * satrecs are built ONCE, in the worker, when the catalogue loads. Re-sharding or
 * changing the worker count therefore costs a reload, which is why the pool is
 * rebuilt only on 'catalog-changed' or a worker-count change — never per scan.
 */
(function () {
  'use strict';

  const WORKER_URL = 'js/worker/scan-worker.js';

  // Above this the tab would freeze for minutes, so run() refuses and names the two
  // knobs that fix it. 60 M propagations is ~40 s single-threaded at the measured
  // 0.61 us each, i.e. already far past "interactive" even across six workers.
  const MAX_PROPAGATIONS = 60e6;

  let pool = [];          // [{w, index, loaded, count}]
  let poolWorkers = 0;    // worker count the current pool was built for
  let loadPromise = null;
  let running = null;     // the in-flight job, or null

  /* ---- pool management ----------------------------------------------------- */

  function scanSettings() {
    const s = (SAT.state && SAT.state.settings) || {};
    return Object.assign({
      coarseStepS: 30, fineStepS: 1.0, marginDeg: 0, workers: 0, maxCrossings: 5000,
    }, s.scan || {});
  }

  /** 0 = auto: hardwareConcurrency - 1, capped at 8. One core is left for the UI
   *  thread, which still has to draw the chart while the scan runs. */
  function workerCount() {
    const want = scanSettings().workers | 0;
    if (want > 0) return Math.min(32, want);
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(8, hc - 1));
  }

  function destroyPool() {
    pool.forEach((p) => { try { p.w.terminate(); } catch (e) { /* already gone */ } });
    pool = [];
    poolWorkers = 0;
    loadPromise = null;
  }

  function buildPool(n) {
    destroyPool();
    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_URL);
      const p = { w: w, index: i, loaded: false, count: 0, onMsg: null };
      w.onmessage = (ev) => { if (p.onMsg) p.onMsg(ev.data); };
      pool.push(p);
    }
    poolWorkers = n;
  }

  /** Push the catalogue into the pool, sharded by index. Round-robin rather than
   *  contiguous blocks: the catalogue arrives roughly grouped by orbit family, and
   *  contiguous shards would hand one worker every GEO object (all of which survive
   *  stage 1 together, or none do) while another idles. */
  function ensureLoaded() {
    if (loadPromise) return loadPromise;
    const objs = (SAT.state.catalog && SAT.state.catalog.objs) || [];
    const n = workerCount();
    if (poolWorkers !== n || !pool.length) buildPool(n);

    const shards = [];
    for (let i = 0; i < n; i++) shards.push([]);
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      shards[i % n].push({
        id: o.id, norad: o.norad, name: o.name, intl: o.intl,
        l1: o.l1, l2: o.l2, rcs: o.rcs, stdMag: o.stdMag,
        type: o.type, cls: o.cls || null,
      });
    }

    loadPromise = Promise.all(pool.map((p, i) => new Promise((res, rej) => {
      p.onMsg = (m) => {
        if (m.type !== 'loaded') return;
        p.loaded = true; p.count = m.count;
        res(m);
      };
      p.w.onerror = (e) => rej(new Error('scan worker failed to start: ' + (e.message || e)));
      p.w.postMessage({ cmd: 'load', objs: shards[i] });
    })));
    return loadPromise;
  }

  /* ---- parameters ---------------------------------------------------------- */

  function fovOf(obs) {
    return {
      shape: obs.fovShape === 'circ' ? 'circ' : 'rect',
      wDeg: obs.fovWDeg, hDeg: obs.fovHDeg, rDeg: obs.fovRDeg,
      rotDeg: obs.rotDeg || 0,
    };
  }

  function fovRadiusDeg(obs) {
    if (obs.fovShape === 'circ') return obs.fovRDeg || 0;
    return Math.hypot((obs.fovWDeg || 0) / 2, (obs.fovHDeg || 0) / 2);
  }

  /** Resolve the user's pointing into whichever pair the worker needs.
   *
   *  track 'sky' wants a fixed J2000 RA/Dec, so an alt/az pointing is converted once
   *  at t0. track 'mount' wants a fixed apparent alt/az (ground) or LVLH pair
   *  (orbit), so an RA/Dec pointing is converted once at t0 and then held. Doing
   *  this here keeps the worker's per-epoch pointing step to a single rotation.
   *
   *  Conversions go through SAT.prop's kind-dispatching converters: for a ground
   *  site they ARE frames.altAzToRaDec/raDecToAltAz with refraction (round-2
   *  review); for an orbit site they are the LVLH basis with refraction off, a
   *  ground-site rule that never applies in vacuum (CONTRACT v0.2). A null
   *  conversion means the observer could not be propagated at t0 — that fails the
   *  scan here, loudly, rather than posting NaNs to six workers. */
  function pointingOf(obs, rs, t0) {
    const track = obs.track === 'mount' ? 'mount' : 'sky';
    const refract = rs.kind !== 'orbit';
    const opt = { refract: refract };
    const cvAA = (ra, dec) => SAT.prop.siteRaDecToAltAz(rs, ra, dec, t0, opt);
    const cvRD = (az, el) => SAT.prop.siteAltAzToRaDec(rs, az, el, t0, opt);
    const bad = () => new Error('observer NORAD ' + rs.norad +
      ' cannot be propagated at the scan start — its TLE may be unusable at this epoch');
    const out = { track: track, mode: obs.mode, refract: refract };
    if (track === 'mount') {
      if (obs.mode === 'altaz') { out.azDeg = obs.azDeg; out.elDeg = obs.elDeg; }
      else {
        const aa = cvAA(obs.raDeg, obs.decDeg);
        if (!aa) throw bad();
        out.azDeg = aa.azDeg; out.elDeg = aa.elDeg;
      }
      // the J2000 pair is still filled in so the UI has something to display
      const rd = cvRD(out.azDeg, out.elDeg);
      if (!rd) throw bad();
      out.raDeg = rd.raDeg; out.decDeg = rd.decDeg;
    } else {
      if (obs.mode === 'altaz') {
        const rd = cvRD(obs.azDeg, obs.elDeg);
        if (!rd) throw bad();
        out.raDeg = rd.raDeg; out.decDeg = rd.decDeg;
      } else { out.raDeg = obs.raDeg; out.decDeg = obs.decDeg; }
      out.azDeg = obs.azDeg; out.elDeg = obs.elDeg;
    }
    return out;
  }

  /* ---- estimate ------------------------------------------------------------ */

  /** Projected propagation count, so the UI can warn BEFORE a huge scan rather than
   *  after the tab has stopped responding.
   *
   *  This is the pre-cull upper bound: stage 1 typically removes 60-90% of the
   *  catalogue, but how much depends on the pointing and we do not know it until we
   *  have run it. Warning on the bound is the honest direction to be wrong in. */
  function estimate(overrides) {
    const obs = Object.assign({}, SAT.state.obs, overrides || {});
    const st = Object.assign(scanSettings(), overrides || {});
    const objects = ((SAT.state.catalog && SAT.state.catalog.objs) || []).length;
    // Mirror of the worker's orbit-site clamp (CONTRACT "Stage 2/3 under a moving
    // observer") — the refusal maths must count what will actually run.
    const loc = SAT.state.activeLocation && SAT.state.activeLocation();
    const orbitSite = !!(loc && (loc.kind || 'ground') === 'orbit');
    const coarseStepS = orbitSite
      ? Math.max(0.5, Math.min(10, st.coarseStepS))
      : Math.max(0.5, st.coarseStepS);
    const spanMin = Math.max(0, obs.spanMin || 0);
    const coarseSteps = Math.round(spanMin * 60 / coarseStepS) + 1;
    const propagations = objects * coarseSteps;
    return {
      objects: objects,
      coarseSteps: coarseSteps,
      coarseStepS: coarseStepS,
      spanMin: spanMin,
      workers: workerCount(),
      propagations: propagations,
      limit: MAX_PROPAGATIONS,
      tooLarge: propagations > MAX_PROPAGATIONS,
      // 0.61 us per propagation, measured — see CONTRACT.md "Performance decisions"
      estMs: Math.round(propagations * 0.61 / 1000 / workerCount()),
    };
  }

  function tooLargeMessage(est) {
    return 'Scan too large: about ' + (est.propagations / 1e6).toFixed(1) +
      ' million propagations (' + est.objects.toLocaleString() + ' objects x ' +
      est.coarseSteps.toLocaleString() + ' steps), over the ' +
      (est.limit / 1e6).toFixed(0) + ' M limit. Raise coarseStepS (now ' +
      est.coarseStepS + ' s) or shorten spanMin (now ' + est.spanMin + ' min).';
  }

  /* ---- run ----------------------------------------------------------------- */

  function isRunning() { return !!running; }

  function cancel() {
    if (!running) return;
    running.cancelled = true;
    pool.forEach((p) => p.w.postMessage({ cmd: 'cancel' }));
  }

  /** Emit an event for a caller-owned scan workflow. Raw scans must never use the
   * ordinary `scan-*` channel unless that is explicitly requested and rejected by
   * rawEventPrefix(); occultation callers normally pass `eventPrefix: 'occultation'`.
   * A null/false/empty prefix deliberately disables raw progress events. */
  function emitScoped(prefix, phase, payload) {
    if (prefix == null || prefix === false || prefix === '') return;
    const p = String(prefix).trim().replace(/-+$/, '');
    if (p) SAT.bus.emit(p + '-' + phase, payload);
  }

  function rawEventPrefix(options) {
    const o = options || {};
    const prefix = Object.prototype.hasOwnProperty.call(o, 'eventPrefix')
      ? o.eventPrefix : 'scan-raw';
    if (String(prefix).trim() === 'scan') {
      throw new Error('SAT.scan.runRaw() cannot use the ordinary scan event prefix');
    }
    return prefix;
  }

  function rawMaxResults(options) {
    const o = options || {};
    const value = o.maxResults == null ? 100000 : Number(o.maxResults);
    if (!isFinite(value) || value < 0) {
      throw new Error('SAT.scan.runRaw() maxResults must be a non-negative number');
    }
    return Math.floor(value);
  }

  function emitRawProgress(job, prefix) {
    let done = 0, total = 0, phase = 'coarse';
    for (let i = 0; i < job.progress.length; i++) {
      const p = job.progress[i];
      if (!p) continue;
      done += p.done; total += p.total;
      if (p.phase === 'fine') phase = 'fine';
    }
    emitScoped(prefix, 'progress', { done: done, total: total, phase: phase });
  }

  /** Run the existing worker protocol without touching ordinary scan state.
   *
   * The returned object intentionally stays at the worker geometry boundary:
   * ordinary scan photometry, object-type enrichment, checked-row clearing and
   * `SAT.state.scan` publication belong only to run(). `maxResults` is applied
   * after shard merging so the caller receives a deterministic time-sorted set. */
  async function runRaw(params, options) {
    if (running) throw new Error('a scan is already running');
    if (!params || typeof params !== 'object') {
      throw new Error('SAT.scan.runRaw() requires scan parameters');
    }

    const objs = (SAT.state.catalog && SAT.state.catalog.objs) || [];
    if (!objs.length) throw new Error('No catalogue loaded — fetch one in the Sources window.');

    const o = options || {};
    const maxResults = rawMaxResults(o);
    const eventPrefix = rawEventPrefix(o);
    const workerParams = Object.assign({}, params, { maxCrossings: maxResults });
    const job = { cancelled: false, t0: Date.now(), progress: [] };
    running = job;
    emitScoped(eventPrefix, 'started', {
      objects: objs.length, workers: workerCount(), spanMin: workerParams.spanMin,
      maxResults: maxResults,
    });

    try {
      await ensureLoaded();
      if (job.cancelled) throw new Error('cancelled');

      const results = await Promise.all(pool.map((p, i) => new Promise((res, rej) => {
        job.progress[i] = { done: 0, total: 0, phase: 'coarse' };
        p.onMsg = (m) => {
          if (m.type === 'progress') {
            job.progress[i] = { done: m.done, total: m.total, phase: m.phase };
            emitRawProgress(job, eventPrefix);
          } else if (m.type === 'result') {
            res(m);
          } else if (m.type === 'error') {
            rej(new Error(m.error));
          }
        };
        p.w.onerror = (e) => rej(new Error('scan worker error: ' + (e.message || e)));
        p.w.postMessage({ cmd: 'scan', params: workerParams });
      })));

      if (job.cancelled || results.some((r) => r.cancelled)) throw new Error('cancelled');

      const merged = mergeRawResults(results, maxResults);
      const ms = Date.now() - job.t0;
      running = null;
      const payload = {
        count: merged.crossings.length, ms: ms, truncated: merged.truncated,
        culled: merged.culled, propagations: merged.propagations,
      };
      emitScoped(eventPrefix, 'done', payload);
      return Object.assign(merged, { ms: ms });
    } catch (err) {
      running = null;
      const e = (err && err.message === 'cancelled')
        ? new Error('Raw scan cancelled') : err;
      emitScoped(eventPrefix, 'failed', { error: e.message || String(e) });
      throw e;
    }
  }

  async function run() {
    if (running) throw new Error('a scan is already running');

    const loc = SAT.state.activeLocation();
    if (!loc) throw new Error('No active site — choose one in the Locations window.');
    const objs = (SAT.state.catalog && SAT.state.catalog.objs) || [];
    if (!objs.length) throw new Error('No catalogue loaded — fetch one in the Sources window.');

    // Resolve the site kind ONCE: an orbit site's TLE comes out of the loaded
    // catalogue, and the worker owns satrecs for its shard only, so the observer's
    // lines ride in the params to every worker (CONTRACT worker protocol).
    const rs = SAT.state.resolvedSite(loc);
    if (rs.kind === 'orbit' && rs.missing) {
      throw new Error('Orbital site "' + loc.name + '": NORAD ' + loc.norad +
        ' is not in the loaded catalogue. Load a catalogue that contains it ' +
        '(Catalogue window), or choose a different observer.');
    }

    const est = estimate();
    if (est.tooLarge) {
      const err = new Error(tooLargeMessage(est));
      err.estimate = est;
      throw err;
    }

    const obs = SAT.state.obs;
    const st = scanSettings();
    const t0 = SAT.clock ? SAT.clock.getDate() : new Date();
    const t0Ms = t0.getTime();

    const params = {
      t0Ms: t0Ms,
      spanMin: obs.spanMin,
      site: rs.kind === 'orbit'
        ? { kind: 'orbit', norad: rs.norad, l1: rs.l1, l2: rs.l2,
            name: rs.objName || loc.name }
        : { kind: 'ground', latDeg: loc.latDeg, lonDeg: loc.lonDeg, altM: loc.altM },
      pointing: pointingOf(obs, rs, t0),
      fov: fovOf(obs),
      filters: { minElDeg: (SAT.state.filters && SAT.state.filters.minElDeg) || 0 },
      steps: { coarseStepS: st.coarseStepS, fineStepS: st.fineStepS, marginDeg: st.marginDeg },
      dut1S: st.dut1S || 0,
      maxCrossings: st.maxCrossings,
    };

    const job = { cancelled: false, t0: Date.now(), progress: [] };
    running = job;
    SAT.bus.emit('scan-started', {
      objects: objs.length, workers: workerCount(),
      spanMin: obs.spanMin, fovRadiusDeg: fovRadiusDeg(obs),
    });

    try {
      await ensureLoaded();
      if (job.cancelled) throw new Error('cancelled');

      const results = await Promise.all(pool.map((p, i) => new Promise((res, rej) => {
        job.progress[i] = { done: 0, total: 0, phase: 'coarse' };
        p.onMsg = (m) => {
          if (m.type === 'progress') {
            job.progress[i] = { done: m.done, total: m.total, phase: m.phase };
            emitProgress(job);
          } else if (m.type === 'result') {
            res(m);
          } else if (m.type === 'error') {
            rej(new Error(m.error));
          }
        };
        p.w.onerror = (e) => rej(new Error('scan worker error: ' + (e.message || e)));
        p.w.postMessage({ cmd: 'scan', params: params });
      })));

      if (job.cancelled || results.some((r) => r.cancelled)) throw new Error('cancelled');

      const merged = mergeResults(results, st.maxCrossings);
      const ms = Date.now() - job.t0;

      const sc = SAT.state.scan || (SAT.state.scan = {});
      sc.crossings = merged.crossings;
      if (sc.checked && sc.checked.size) sc.checked.clear();   // stale ticks would
      // silently blank the chart after a rescan
      sc.ranAt = new Date();
      sc.stale = false;
      sc.params = params;
      sc.culled = merged.culled;
      sc.truncated = merged.truncated;

      running = null;
      SAT.bus.emit('scan-done', {
        count: merged.crossings.length, ms: ms, truncated: merged.truncated,
        culled: merged.culled, propagations: merged.propagations,
      });
      return merged.crossings;
    } catch (err) {
      running = null;
      const e = (err && err.message === 'cancelled') ? new Error('Scan cancelled') : err;
      SAT.bus.emit('scan-failed', { error: e.message || String(e) });
      throw e;
    }
  }

  function emitProgress(job) {
    let done = 0, total = 0, phase = 'coarse';
    for (let i = 0; i < job.progress.length; i++) {
      const p = job.progress[i];
      if (!p) continue;
      done += p.done; total += p.total;
      if (p.phase === 'fine') phase = 'fine';
    }
    SAT.bus.emit('scan-progress', { done: done, total: total, phase: phase });
  }

  /** Merge the shards, fill in the photometry the worker deliberately left out, sort
   *  by closest approach, and truncate explicitly.
   *
   *  Photometry runs here rather than in the worker because SAT.photo lives on the
   *  main thread and duplicating it would make a third copy of the same magnitude
   *  model. It is a handful of objects, so the cost is nil. */
  function mergeResults(results, maxCrossings) {
    const culled = {
      total: 0, bad: 0, stage1: 0, stage2: 0, stage3: 0, survivors: 0, candidates: 0,
    };
    let propagations = 0;
    let all = [];
    results.forEach((r) => {
      if (r.culled) Object.keys(culled).forEach((k) => { culled[k] += (r.culled[k] || 0); });
      propagations += r.propagations || 0;
      all = all.concat(r.crossings || []);
    });

    all.forEach((c) => {
      const obj = SAT.state.getObj ? SAT.state.getObj(c.satId) : null;
      const geom = { rangeKm: c.rangeKm, phaseDeg: c.phaseDeg, shadow: c.shadow };
      if (SAT.photo && SAT.photo.magnitude) {
        const m = SAT.photo.magnitude(obj || { rcs: c.rcs, stdMag: c.stdMag }, geom);
        c.magEst = m.mag; c.magMethod = m.method;
      } else { c.magEst = null; c.magMethod = null; }
      // Object type (for the type filter chips) and geodetic height at closest
      // approach (for the altitude filter). A crossing lasts seconds to minutes,
      // so the CA height IS the height during the crossing; ≤ maxCrossings
      // propagations here cost single-digit milliseconds.
      c.type = (obj && obj.type) || c.type || null;
      c.cls = c.cls || (obj && obj.cls) || null;
      c.altKm = null;
      if (obj && SAT.prop && SAT.prop.temeKm) {
        try {
          const d = new Date(c.tCaMs);
          const pv = SAT.prop.temeKm(obj, d);
          if (pv) {
            const g = satellite.eciToGeodetic(pv.r, satellite.gstime(d));
            if (g && isFinite(g.height)) c.altKm = g.height;
          }
        } catch (e) { /* leave null — the filter treats null as "unknown, keep" */ }
      }
    });

    all.sort((a, b) => a.tCaMs - b.tCaMs);
    const truncated = all.length > maxCrossings;
    if (truncated) all = all.slice(0, maxCrossings);
    return {
      crossings: all, culled: culled, truncated: truncated, propagations: propagations,
    };
  }

  /** Merge raw worker geometry without ordinary-scan enrichment or state writes. */
  function mergeRawResults(results, maxResults) {
    const culled = {
      total: 0, bad: 0, stage1: 0, stage2: 0, stage3: 0, survivors: 0, candidates: 0,
    };
    let propagations = 0;
    let all = [];
    results.forEach((r) => {
      if (r.culled) Object.keys(culled).forEach((k) => { culled[k] += (r.culled[k] || 0); });
      propagations += r.propagations || 0;
      all = all.concat(r.crossings || []);
    });

    all.sort((a, b) => a.tCaMs - b.tCaMs);
    const truncated = all.length > maxResults;
    if (truncated) all = all.slice(0, maxResults);
    return {
      crossings: all, culled: culled, truncated: truncated, propagations: propagations,
    };
  }

  /* ---- invalidation -------------------------------------------------------- */

  if (typeof SAT !== 'undefined' && SAT.bus) {
    // The catalogue IS the pool's state, so a new one means new satrecs. Everything
    // else (pointing, FOV, timespan) is a scan parameter and costs nothing to change.
    SAT.bus.on('catalog-changed', () => { destroyPool(); });
    SAT.bus.on('settings-changed', (p) => {
      if (p && p.section === 'scan' && poolWorkers !== workerCount()) destroyPool();
    });
  }

  SAT.scan = { run, runRaw, cancel, isRunning, estimate };
})();
