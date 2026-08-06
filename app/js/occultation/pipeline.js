/* SAT.occultation.pipeline — deterministic nightly occultation workflow.
 *
 * Pipeline responsibility: connect NightWindow/pass discovery, conservative
 * star-candidate search, and P0-09 event assembly. The scientific cores remain
 * in their own modules; this file owns ordering, cancellation, stage provenance,
 * progress events, and the single optional state publication.
 *
 * No probability, ranking, persistence, or ordinary scan-state mutation is
 * performed here. A runtime stage failure returns an explicit failed result and
 * leaves the previously published occultation state untouched.
 */
(function () {
  'use strict';

  const ROOT = SAT;
  let activeRun = null;
  // This bound applies only when pass-path refinement is deferred for a large
  // raw-worker discovery. It limits the retained event workload, not the number
  // of worker crossings or cone queries, and the resulting partial status is
  // explicit in both the search flags and the published provenance.
  const DEFERRED_TOTAL_CANDIDATES = 5000;

  function copyValue(value) {
    const adapter = ROOT.occultation && ROOT.occultation.lookAdapter;
    if (adapter && typeof adapter.copyValue === 'function') return adapter.copyValue(value);
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return null; }
  }

  function services(overrides) {
    const injected = overrides || {};
    const occultation = ROOT.occultation || {};
    return {
      passes: injected.passes || occultation.passes,
      starCandidates: injected.starCandidates || occultation.starCandidates,
      eventState: injected.eventState || occultation.eventState,
      night: injected.night || occultation.night,
      path: injected.path || occultation.adaptivePath,
      scan: injected.scan || ROOT.scan,
      prop: injected.prop || ROOT.prop,
      refine: injected.refine || occultation.refine,
      state: injected.state || ROOT.state,
      stars: injected.stars || ROOT.stars,
      bus: injected.bus || ROOT.bus || null,
    };
  }

  function emit(svc, name, payload) {
    if (svc.bus && typeof svc.bus.emit === 'function') svc.bus.emit(name, payload || {});
  }

  function stageOptions(source, key, alias) {
    const direct = source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
      ? source[key] : {};
    const alternate = source[alias] && typeof source[alias] === 'object' && !Array.isArray(source[alias])
      ? source[alias] : {};
    return Object.assign({}, alternate, direct);
  }

  /** Resolve the three stage inputs without copying service objects into them.
   *
   * `source` is a JSON-like configuration. `passes` consumes the direct pass
   * fields plus `passOptions`; `stars` consumes `starOptions`; and the event
   * assembler consumes `eventOptions`. The reserved `eventPrefix` is owned by
   * this pipeline so raw worker progress cannot collide with ordinary `scan-*`
   * events.
   */
  function resolveInput(input, options) {
    const source = input && typeof input === 'object' ? input : {};
    const controls = options && typeof options === 'object' ? options : {};
    const fullSearch = source.fullSearch === true || source.executionMode === 'headless-complete';
    const passOptions = stageOptions(source, 'passes', 'passOptions');
    const starOptions = stageOptions(source, 'stars', 'starOptions');
    const eventOptions = stageOptions(source, 'events', 'eventOptions');
    const nowMs = controls.nowMs == null
      ? (source.nowMs == null ? eventOptions.nowMs : source.nowMs) : controls.nowMs;
    if (nowMs != null) eventOptions.nowMs = nowMs;
    const passInput = Object.assign({}, source, passOptions, { eventPrefix: 'occultation-scan' });
    delete passInput.passOptions;
    delete passInput.starOptions;
    delete passInput.eventOptions;
    delete passInput.events;
    delete passInput.stars;
    delete passInput.publish;
    delete passInput.pipeline;
    delete passInput.nowMs;
    return {
      passInput: passInput,
      starOptions: starOptions,
      eventOptions: eventOptions,
      fullSearch: fullSearch,
      publish: controls.publish == null ? source.publish !== false : !!controls.publish,
      nowMs: nowMs,
    };
  }

  function cancelledError() {
    const error = new Error('Occultation pipeline cancelled');
    error.pipelineCode = 'cancelled';
    return error;
  }

  function assertActive(job) {
    if (job.cancelled) throw cancelledError();
  }

  function addFlag(flags, value) {
    if (flags.indexOf(value) < 0) flags.push(value);
  }

  function addSearchFlags(flags, search) {
    (search && Array.isArray(search.results) ? search.results : []).forEach((result) => {
      (Array.isArray(result.flags) ? result.flags : []).forEach((flag) => addFlag(flags, flag));
    });
    if (search && search.status === 'partial') addFlag(flags, 'star-search-partial');
  }

  function addDiscoveryFlags(flags, discovery) {
    const stats = discovery && discovery.stats;
    if (stats && stats.truncated) addFlag(flags, 'pass-discovery-truncated');
    if (stats && stats.deferred) addFlag(flags, 'pass-refinement-deferred');
    if (stats && stats.rawAuditCompacted) addFlag(flags, 'raw-audit-compacted');
  }

  function isFullSearchAuditFlag(flag) {
    return flag === 'pass-refinement-deferred' || flag === 'raw-audit-compacted' ||
      flag === 'star-audit-compacted' || flag === 'candidate-pass-state-pruned' ||
      flag === 'path-precision-unverified';
  }

  function emptySearch() {
    return {
      status: 'empty', results: [], candidates: [],
      stats: { passes: 0, candidates: 0, queries: 0, duplicates: 0,
        truncated: false, complete: true },
    };
  }

  function resultShell(config, startedAtMs) {
    return {
      version: 'p0-11', status: 'failed', complete: false,
      startedAtMs: startedAtMs, finishedAtMs: null,
      config: copyValue({ mode: config.fullSearch ? 'headless-complete' : 'interactive',
        pass: config.passInput, stars: config.starOptions, events: config.eventOptions }),
      discovery: null, search: null, state: null, published: false,
      flags: [], error: null,
      timings: { discoveryMs: null, searchMs: null, eventsMs: null, totalMs: null },
      stats: { discovery: null, search: null, events: null },
    };
  }

  function eventOverrides(svc) {
    return { state: svc.state, prop: svc.prop, refine: svc.refine,
      bus: svc.bus };
  }

  /** Run the complete deterministic P0 occultation workflow.
   *
   * Parameters
   * ----------
   * input : object
   *     Ground-site/night configuration in the P0-03 shape, plus optional
   *     `passOptions`, `starOptions`, and `eventOptions` objects. Times are
   *     local-date configuration at the boundary and UTC Unix milliseconds in
   *     every returned pass/event record.
   * options : object, optional
   *     Pipeline controls: `publish` defaults to true and `nowMs` can provide a
   *     deterministic event-state timestamp. Scientific stage options belong in
   *     `input` so the returned configuration is self-describing.
   * overrides : object, optional
   *     Offline/test services: `passes`, `starCandidates`, `eventState`, `night`,
   *     `scan`, `prop`, `path`, `state`, `stars`, and `bus`.
   *
   * Returns
   * -------
   * Promise<object>
   *     A JSON-safe stage report with `status` equal to `ok`, `empty`,
   *     `no-night`, `partial`, `failed`, or `cancelled`. `complete` is false
   *     for truncation, retained event failures, cancellation, and runtime
   *     errors. The prior state is never cleared by a failed/cancelled run.
   *
   * Notes
   * -----
   * The star search is intentionally skipped for a no-night result. Event
   * assembly is called once, and publication is performed only after all three
   * stages have produced their immutable result objects.
   */
  async function run(input, options, overrides) {
    if (activeRun) throw new Error('an occultation pipeline is already running');
    const config = resolveInput(input, options);
    const svc = services(overrides);
    if (!svc.passes || typeof svc.passes.discover !== 'function') {
      throw new Error('SAT.occultation.passes.discover() is required');
    }
    if (!svc.starCandidates || typeof svc.starCandidates.search !== 'function') {
      throw new Error('SAT.occultation.starCandidates.search() is required');
    }
    if (!svc.eventState || typeof svc.eventState.build !== 'function' ||
        typeof svc.eventState.commit !== 'function') {
      throw new Error('SAT.occultation.eventState build/commit is required');
    }

    const startedAtMs = Date.now();
    const job = { cancelled: false, startedAtMs: startedAtMs, scan: svc.scan };
    activeRun = job;
    const result = resultShell(config, startedAtMs);
    const scanProgress = (payload) => emit(svc, 'occultation-progress',
      Object.assign({ phase: 'pass-scan', stage: 'pass-scan' }, payload || {}));
    if (svc.bus && typeof svc.bus.on === 'function') svc.bus.on('occultation-scan-progress', scanProgress);
    emit(svc, 'occultation-started', { version: 'p0-11', startedAtMs: startedAtMs });

    try {
      const discoveryStart = Date.now();
      const discovery = await svc.passes.discover(config.passInput, {
        night: svc.night, scan: svc.scan, prop: svc.prop, path: svc.path, state: svc.state,
      });
      result.timings.discoveryMs = Date.now() - discoveryStart;
      result.discovery = discovery;
      assertActive(job);
      addDiscoveryFlags(result.flags, discovery);
      emit(svc, 'occultation-passes-ready', {
        windows: discovery && discovery.windows ? discovery.windows.length : 0,
        passes: discovery && discovery.passes ? discovery.passes.length : 0,
        stats: copyValue(discovery && discovery.stats),
      });

      let search;
      if (!discovery || discovery.status === 'no-night') {
        search = emptySearch();
        addFlag(result.flags, 'no-night');
      } else {
        const searchStart = Date.now();
        const searchInput = Object.assign({
          passes: discovery.passes || [],
        }, config.starOptions);
        const deferredLargeRun = !!(discovery && discovery.stats && discovery.stats.deferred);
        if (deferredLargeRun) {
          // The raw pass path remains available to OCCSTAR1/P0-07, but the
          // per-pass query transcript and repeated pass references are not needed
          // to assemble events. Omitting those duplicate graphs is an explicit
          // audit-memory trade-off, while the total candidate cap prevents an
          // all-sky, full-night catalogue from creating an unbounded event state.
          if (searchInput.maxTotalCandidates == null && !config.fullSearch) {
            searchInput.maxTotalCandidates = DEFERRED_TOTAL_CANDIDATES;
          }
          searchInput.retainQueries = false;
          searchInput.retainSourcePass = false;
          result.config.stars = copyValue(Object.assign({}, searchInput, { passes: undefined }));
          delete result.config.stars.passes;
          addFlag(result.flags, 'star-audit-compacted');
        }
        const searchControls = {
          shouldCancel: () => job.cancelled,
          onProgress: (payload) => emit(svc, 'occultation-progress', payload || {}),
        };
        if (typeof svc.starCandidates.searchAsync === 'function') {
          search = await svc.starCandidates.searchAsync(searchInput, { stars: svc.stars }, searchControls);
        } else {
          search = svc.starCandidates.search(searchInput, { stars: svc.stars });
        }
        result.timings.searchMs = Date.now() - searchStart;
        assertActive(job);
        addSearchFlags(result.flags, search);
        if (search && search.stats && search.stats.truncated) addFlag(result.flags, 'star-search-truncated');
        if (search && search.stats && search.stats.candidateLimitReached) {
          addFlag(result.flags, 'candidate-total-limit');
        }
      }
      result.search = search;
      emit(svc, 'occultation-candidates-ready', {
        candidates: search && search.candidates ? search.candidates.length : 0,
        stats: copyValue(search && search.stats), flags: result.flags.slice(),
      });

      const eventsStart = Date.now();
      const eventInput = {
        site: config.passInput.site,
        refraction: config.passInput.refraction,
        dut1S: config.passInput.dut1S,
        passes: discovery && Array.isArray(discovery.passes) ? discovery.passes : [],
        search: search,
        satelliteFilters: {
          classes: config.passInput.classes != null ? copyValue(config.passInput.classes)
            : copyValue(config.passInput.satelliteClasses),
          types: config.passInput.types != null ? copyValue(config.passInput.types)
            : copyValue(config.passInput.satelliteTypes),
        },
      };
      const eventOptions = Object.assign({}, config.eventOptions);
      if (discovery && discovery.stats && discovery.stats.deferred) {
        // Large raw-worker searches retain only passes that actually reached
        // the star-candidate stage in published state. The complete discovery
        // object remains available in this detached run report, while the UI
        // state avoids duplicating tens of thousands of raw paths.
        eventOptions.retainOnlyCandidatePasses = true;
        addFlag(result.flags, 'candidate-pass-state-pruned');
      }
      result.config.events = copyValue(eventOptions);
      let built;
      const eventControls = {
        shouldCancel: () => job.cancelled,
        onProgress: (payload) => emit(svc, 'occultation-progress', payload || {}),
      };
      if (typeof svc.eventState.buildAsync === 'function') {
        built = await svc.eventState.buildAsync(eventInput, eventOptions,
          eventOverrides(svc), eventControls);
      } else {
        built = svc.eventState.build(eventInput, eventOptions, eventOverrides(svc));
      }
      result.timings.eventsMs = Date.now() - eventsStart;
      assertActive(job);
      if (built && !built.complete) addFlag(result.flags, 'event-state-partial');
      const incompleteStage = result.flags.some((flag) => flag !== 'no-night' &&
        !(config.fullSearch && isFullSearchAuditFlag(flag)));
      const status = discovery && discovery.status === 'no-night' ? 'no-night'
        : (incompleteStage ? 'partial'
          : (built.events && built.events.length ? (built.complete ? 'ok' : 'partial') : 'empty'));
      const complete = status === 'ok' || status === 'empty' || status === 'no-night';
      if (built && incompleteStage) {
        built.complete = false;
        if (built.status === 'ok') built.status = 'partial';
      }
      const finishedAtMs = Date.now();
      result.status = status;
      result.complete = complete;
      result.finishedAtMs = finishedAtMs;
      result.timings.totalMs = finishedAtMs - startedAtMs;
      result.state = built;
      result.stats = {
        discovery: copyValue(discovery && discovery.stats),
        search: copyValue(search && search.stats),
        events: copyValue(built && built.stats),
      };
      built.pipeline = {
        version: 'p0-11', status: status, complete: complete,
        config: copyValue(result.config),
        flags: result.flags.slice(), timings: copyValue(result.timings),
        stats: copyValue(result.stats),
      };
      if (config.publish) {
        svc.eventState.commit(built, Object.assign(eventOverrides(svc), { adoptDetached: true }));
        result.published = true;
      }
      emit(svc, 'occultation-events-ready', {
        events: built.events ? built.events.length : 0, status: status,
        complete: complete, flags: result.flags.slice(),
      });
      emit(svc, 'occultation-done', copyValue({ status: status, complete: complete,
        events: built.events ? built.events.length : 0, flags: result.flags,
        stats: result.stats, timings: result.timings, error: result.error }));
      return result;
    } catch (error) {
      const cancelled = job.cancelled || (error && error.pipelineCode === 'cancelled') ||
        (error && /cancelled/i.test(String(error.message || error)));
      result.status = cancelled ? 'cancelled' : 'failed';
      result.complete = false;
      result.finishedAtMs = Date.now();
      result.timings.totalMs = result.finishedAtMs - startedAtMs;
      result.error = String(error && error.message ? error.message : error);
      addFlag(result.flags, cancelled ? 'cancelled' : 'pipeline-failed');
      emit(svc, cancelled ? 'occultation-cancelled' : 'occultation-failed',
        { status: result.status, error: result.error, flags: result.flags.slice() });
      return result;
    } finally {
      if (svc.bus && typeof svc.bus.off === 'function') {
        svc.bus.off('occultation-scan-progress', scanProgress);
      }
      activeRun = null;
    }
  }

  function cancel() {
    if (!activeRun) return false;
    activeRun.cancelled = true;
    const scan = activeRun.scan || ROOT.scan;
    if (scan && typeof scan.cancel === 'function') scan.cancel();
    return true;
  }

  const API = {
    run: run,
    execute: run,
    cancel: cancel,
    isRunning: () => !!activeRun,
    resolveInput: resolveInput,
  };
  ROOT.occultation = ROOT.occultation || {};
  ROOT.occultation.pipeline = API;
})();
