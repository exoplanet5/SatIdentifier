/* Browser-independent, pass-streaming P0-11 orchestration.
 *
 * The interactive pipeline intentionally returns one immutable graph for the
 * browser. A full-night desktop run has a different memory boundary: it scans
 * one worker crossing, searches its path, refines its candidates, keeps only the
 * requested event rows, and then releases that pass before continuing.
 */
'use strict';

function copyValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function addFlag(flags, value) {
  if (flags.indexOf(value) < 0) flags.push(value);
}

function addNumber(target, source, key) {
  target[key] = (Number(target[key]) || 0) + (Number(source && source[key]) || 0);
}

function addEventStats(target, source) {
  [
    'candidates', 'events', 'refined', 'incomplete', 'failed', 'duplicateCandidates',
    'contacted', 'contactMisses', 'contactIncomplete', 'evaluatedCandidates',
    'evaluatedEvents', 'filteredEvents', 'filteredMisses', 'filteredIncomplete',
    'filteredCandidates', 'retainedPasses',
  ].forEach((key) => addNumber(target, source, key));
}

function emit(bus, name, payload) {
  if (bus && typeof bus.emit === 'function') bus.emit(name, payload || {});
}

/** Return the local J2000 polyline used for a conservative candidate screen.
 *
 * Parameters
 * ----------
 * pass : object
 *     Satellite pass whose `path` samples contain UTC Unix-millisecond `t` and
 *     J2000 `raDeg`/`decDeg` coordinates in degrees. The array is borrowed and
 *     never mutated.
 * candidate : object
 *     OCCSTAR1 candidate with zero-based `sourceSegments` indices referring to
 *     the pass path representation.
 *
 * Returns
 * -------
 * Array<object>
 *     The candidate-producing segments plus one neighbouring segment on each
 *     side, preserving chronological path order. If provenance is unavailable,
 *     the complete pass path is returned.
 *
 * Notes
 * -----
 * The neighbour points keep an occultation near a segment boundary from being
 * rejected by the screen. This is only a fast contacts-only gate; every retained
 * candidate still goes through the exact time-dependent P0-07/P0-09 solvers.
 */
function screeningPath(pass, candidate) {
  const path = pass && Array.isArray(pass.path) ? pass.path : [];
  const segments = candidate && Array.isArray(candidate.sourceSegments)
    ? candidate.sourceSegments.map(Number).filter(isFinite) : [];
  if (path.length < 2 || !segments.length) return path;
  const pointIndices = new Set();
  segments.forEach((segment) => {
    const index = Math.floor(segment);
    for (let i = Math.max(0, index - 1); i <= Math.min(path.length - 2, index + 1); i++) {
      pointIndices.add(i); pointIndices.add(i + 1);
    }
  });
  const selected = Array.from(pointIndices).sort((a, b) => a - b).map((index) => path[index]);
  return selected.length >= 2 ? selected : path;
}

function emptyEventStats() {
  return {
    passes: 0, candidates: 0, events: 0, refined: 0, incomplete: 0, failed: 0,
    duplicateCandidates: 0, contacted: 0, contactMisses: 0, contactIncomplete: 0,
    evaluatedCandidates: 0, evaluatedEvents: 0, filteredEvents: 0, filteredMisses: 0,
    filteredIncomplete: 0, filteredCandidates: 0, retainedPasses: 0,
  };
}

function eventOverrides(services) {
  return {
    state: services.state, prop: services.prop, refine: services.refine,
    bus: null,
  };
}

/** Run full-search stages with a bounded live graph.
 *
 * `services` contains the production `passes`, `starCandidates`, `eventState`,
 * `night`, `scan`, `prop`, `refine`, `state`, `stars`, and `bus` modules. Raw
 * worker paths may be detailed, but they are cleared as soon as their one-pass
 * event result has been assembled. Contacts-only output therefore scales with
 * successful events rather than with every miss in the full catalogue.
 */
async function run(input, services) {
  const source = input || {};
  // The production pipeline flattens `passOptions`/`passes` before handing
  // them to the pass module. Keep the same contract here; otherwise the
  // desktop runner would silently fall back to the browser's tiny raw-path
  // default instead of using its configured streaming path budget.
  const passInput = Object.assign({}, source, source.passOptions || {}, source.passes || {});
  const config = services.passes.resolveInput(passInput);
  const startedAtMs = Date.now();
  const flags = [];
  const timings = { discoveryMs: 0, searchMs: 0, eventsMs: 0, totalMs: null };
  const discoveryStats = {
    windows: 0, rawCrossings: 0, passes: 0, exactRefined: 0, deferred: 0,
    exactPassLimit: config.exactPassLimit, rawAuditCompacted: false, rejected: 0,
    truncated: false, culled: { total: 0, bad: 0, stage1: 0, stage2: 0,
      stage3: 0, survivors: 0, candidates: 0 }, propagations: 0, ms: 0,
  };
  const searchStats = {
    passes: 0, candidates: 0, candidateMatches: 0, candidateLimit: null,
    candidateLimitReached: false, queries: 0, duplicates: 0, truncated: false,
    complete: true, auditCompacted: true, queriesRetained: false,
    sourcePassesRetained: false, screenedCandidates: 0,
  };
  const eventStats = emptyEventStats();
  const eventInput = source.eventOptions || {};
  const screeningMarginArcsec = !!eventInput.contactsOnly &&
    Number.isFinite(Number(eventInput.candidateScreeningMarginArcsec)) &&
    Number(eventInput.candidateScreeningMarginArcsec) > 0
    ? Number(eventInput.candidateScreeningMarginArcsec) : null;
  const geometry = services.geometry;
  const screeningEnabled = screeningMarginArcsec != null && geometry &&
    typeof geometry.pathDistance === 'function';
  let screenedCandidates = 0;
  const state = services.eventState.emptyState();
  state.site = copyValue(config.site);
  state.options = copyValue({
    refraction: config.refraction, dut1S: config.dut1S,
    refine: (source.eventOptions || {}).refine || {},
    contact: (source.eventOptions || {}).contact || {},
    retainOnlyCandidatePasses: true,
    contactsOnly: !!((source.eventOptions || {}).contactsOnly),
    satelliteClasses: config.satelliteClasses,
    satelliteTypes: config.satelliteTypes,
  });
  state.passes = [];
  state.candidates = [];
  state.events = [];
  state.failures = [];
  state.stats = eventStats;

  const windows = services.night.windowsForDate({
    site: config.site, localDate: config.localDate, timeZone: config.timeZone,
    sunAltitudeLimitDeg: config.sunAltitudeLimitDeg, dut1S: config.dut1S,
  });
  discoveryStats.windows = windows.length;
  if (!windows.length) {
    state.status = 'empty';
    state.complete = true;
    state.updatedAtMs = Date.now();
    timings.totalMs = Date.now() - startedAtMs;
    return {
      version: 'p0-11', status: 'no-night', complete: true,
      startedAtMs: startedAtMs, finishedAtMs: Date.now(),
      config: copyValue({ mode: 'headless-complete', pass: config, stars: source.starOptions || {},
        events: source.eventOptions || {} }),
      flags: ['no-night'], timings: timings,
      discovery: { status: 'no-night', windows: [], stats: discoveryStats },
      search: { status: 'empty', candidates: [], stats: searchStats }, state: state,
      published: false, stats: { discovery: discoveryStats, search: searchStats, events: eventStats },
    };
  }

  if (config.deferExactPasses) addFlag(flags, 'pass-refinement-deferred');
  addFlag(flags, 'raw-audit-compacted');
  addFlag(flags, 'star-audit-compacted');
  addFlag(flags, 'candidate-pass-state-pruned');
  addFlag(flags, 'path-precision-unverified');
  if (screeningEnabled) addFlag(flags, 'candidate-geometric-screening');

  let lastScanProgressMs = 0;
  let lastScanPhase = null;
  const scanProgress = (payload) => {
    const phase = payload && payload.phase != null ? String(payload.phase) : null;
    const now = Date.now();
    if (phase === lastScanPhase && payload && payload.done !== payload.total &&
        now - lastScanProgressMs < 100) return;
    lastScanPhase = phase;
    lastScanProgressMs = now;
    emit(services.bus, 'occultation-progress',
      Object.assign({ stage: 'pass-scan' }, payload || {}));
  };
  const lastPassProgressMs = new Map();
  function emitPassProgress(stage, done, total) {
    const now = Date.now();
    const previous = lastPassProgressMs.get(stage) || 0;
    if (done !== total && now - previous < 100) return;
    lastPassProgressMs.set(stage, now);
    emit(services.bus, 'occultation-progress', {
      stage: stage, phase: stage, done: done, total: total,
    });
  }
  if (services.bus && typeof services.bus.on === 'function') {
    services.bus.on('occultation-scan-progress', scanProgress);
  }

  const discoveryStart = Date.now();
  try {
    for (let w = 0; w < windows.length; w++) {
      const window = windows[w];
      const params = services.passes.buildScanParameters(passInput, window);
      let streamedCrossings = false;
      const handleCrossing = async (crossing, progressTotal) => {
        streamedCrossings = true;
        const passNumber = discoveryStats.rawCrossings + 1;
        discoveryStats.rawCrossings++;
        const normalized = services.passes.normalizeCrossings(
          [crossing], { config: config, window: window },
          { prop: services.prop, path: services.path, state: services.state },
          { deferExact: !!config.deferExactPasses });
        const pass = normalized[0];
        if (!pass) {
          discoveryStats.rejected++;
          if (crossing && Array.isArray(crossing.path)) crossing.path.length = 0;
          return;
        }
        discoveryStats.passes++;
        if (config.deferExactPasses) {
          discoveryStats.deferred++;
          discoveryStats.rawAuditCompacted = true;
        } else {
          discoveryStats.exactRefined++;
        }
        searchStats.passes++;

        const searchStart = Date.now();
        const search = services.starCandidates.searchPass(pass, Object.assign({}, source.starOptions || {}, {
          maxCandidates: Number.MAX_SAFE_INTEGER, maxTotalCandidates: null,
          maxQueries: Number.MAX_SAFE_INTEGER, catalogueResultCap: Number.MAX_SAFE_INTEGER,
          retainQueries: false, retainSourcePass: false,
        }), { stars: services.stars });
        timings.searchMs += Date.now() - searchStart;
        let candidates = search.candidates;
        if (screeningEnabled && candidates.length) {
          const before = candidates.length;
          candidates = candidates.filter((candidate) => {
            const distance = geometry.pathDistance(
              { raDeg: candidate.raDeg, decDeg: candidate.decDeg },
              screeningPath(pass, candidate)).distanceArcsec;
            return distance <= screeningMarginArcsec;
          });
          screenedCandidates += before - candidates.length;
        }
        searchStats.candidates += candidates.length;
        searchStats.candidateMatches += search.candidates.length;
        searchStats.queries += Number(search.queryCount) || 0;
        searchStats.duplicates += Number(search.duplicateCount) || 0;
        searchStats.truncated = searchStats.truncated || !!search.truncated;
        searchStats.complete = searchStats.complete && search.complete;
        (search.flags || []).forEach((flag) => addFlag(flags, flag));
        emitPassProgress('star-search', passNumber, progressTotal);

        if (candidates.length) {
          const eventsStart = Date.now();
          const eventOptions = Object.assign({}, source.eventOptions || {}, {
            retainOnlyCandidatePasses: true,
          });
          // `searchPass()` returns one pass result with its candidates on the
          // result object.  Pass that array explicitly: event-assembly also
          // accepts an aggregate `{search:{results:[...]}}` shape, but a
          // singleton streaming result has no aggregate `results` array.
          const built = await services.eventState.buildAsync({
            site: config.site, refraction: config.refraction, dut1S: config.dut1S,
            passes: [pass], candidates: candidates,
            satelliteFilters: { classes: config.satelliteClasses, types: config.satelliteTypes },
          }, eventOptions, eventOverrides(services), {});
          timings.eventsMs += Date.now() - eventsStart;
          addEventStats(eventStats, built.stats);
          if (built.events.length) {
            state.passes.push.apply(state.passes, built.passes);
            state.candidates.push.apply(state.candidates, built.candidates);
            state.events.push.apply(state.events, built.events);
            state.failures.push.apply(state.failures, built.failures);
          }
          if (!built.complete) addFlag(flags, 'event-state-partial');
        }
        emitPassProgress('event-refinement', passNumber, progressTotal);

        // `pass.path` and the worker crossing path are the largest objects in a
        // full run. The event builder has already copied the successful rows.
        if (Array.isArray(pass.path)) pass.path.length = 0;
        if (pass.sourceCrossing && Array.isArray(pass.sourceCrossing.path)) {
          pass.sourceCrossing.path.length = 0;
        }
        if (crossing && Array.isArray(crossing.path)) crossing.path.length = 0;
      };
      const raw = await services.scan.runRaw(params, {
        maxResults: config.maxResults, eventPrefix: 'occultation-scan',
        onCrossing: (crossing) => handleCrossing(crossing, 0),
      });
      const list = Array.isArray(raw && raw.crossings) ? raw.crossings : [];
      discoveryStats.propagations += Number(raw && raw.propagations) || 0;
      discoveryStats.ms += Number(raw && raw.ms) || 0;
      discoveryStats.truncated = discoveryStats.truncated || !!(raw && raw.truncated);
      const culled = raw && raw.culled;
      if (culled) Object.keys(discoveryStats.culled).forEach((key) => {
        discoveryStats.culled[key] += Number(culled[key]) || 0;
      });
      // The production Node adapter streams each crossing through the callback.
      // Keep this fallback for a test adapter that implements only the original
      // batch-shaped `runRaw()` contract.
      if (!streamedCrossings) {
        for (let i = 0; i < list.length; i++) {
          await handleCrossing(list[i], list.length);
        }
      }
      emitPassProgress('star-search', discoveryStats.passes, discoveryStats.passes);
      emitPassProgress('event-refinement', discoveryStats.passes, discoveryStats.passes);
      if (raw && Array.isArray(raw.crossings)) raw.crossings.length = 0;
    }
  } finally {
    if (services.bus && typeof services.bus.off === 'function') {
      services.bus.off('occultation-scan-progress', scanProgress);
    }
  }
  timings.discoveryMs = Date.now() - discoveryStart;
  discoveryStats.rawAuditCompacted = true;
  eventStats.passes = discoveryStats.passes;
  eventStats.candidates = state.candidates.length;
  eventStats.events = state.events.length;
  eventStats.retainedPasses = state.passes.length;
  searchStats.screenedCandidates = screenedCandidates;
  state.stats = eventStats;
  state.events.sort((a, b) => {
    const at = a.tCaMs == null ? Infinity : a.tCaMs;
    const bt = b.tCaMs == null ? Infinity : b.tCaMs;
    return at - bt || String(a.eventId).localeCompare(String(b.eventId));
  });
  state.complete = !searchStats.truncated && searchStats.complete &&
    !discoveryStats.truncated && !flags.includes('event-state-partial');
  state.status = state.complete ? (state.events.length ? 'ok' : 'empty') : 'partial';
  state.updatedAtMs = Date.now();
  const finishedAtMs = Date.now();
  timings.totalMs = finishedAtMs - startedAtMs;
  const status = discoveryStats.truncated || searchStats.truncated || !state.complete
    ? 'partial' : (state.events.length ? 'ok' : 'empty');
  const complete = status === 'ok' || status === 'empty';
  return {
    version: 'p0-11', status: status, complete: complete,
    startedAtMs: startedAtMs, finishedAtMs: finishedAtMs,
    config: copyValue({ mode: 'headless-complete', pass: config,
      stars: source.starOptions || {}, events: source.eventOptions || {} }),
    flags: flags, timings: timings,
    discovery: { status: 'ok', windows: copyValue(windows), stats: discoveryStats },
    search: { status: searchStats.complete ? 'ok' : 'partial', candidates: [], stats: searchStats },
    state: state, published: false,
    stats: { discovery: discoveryStats, search: searchStats, events: eventStats },
  };
}

module.exports = { run: run };
