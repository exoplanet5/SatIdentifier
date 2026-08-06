/* SAT.occultation.eventAssembly — pass/candidate to event transformation.
 *
 * Scientific responsibility: run the P0-07 closest-approach core and P0-09
 * angular-disc contact solver for each star candidate using the look-adapter's
 * exact J2000 evaluator. This module returns an independent JSON-safe payload;
 * event-state.js owns publication.
 */
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports &&
    typeof SAT !== 'undefined') {
  SAT.occultation = SAT.occultation || {};
  if (!SAT.occultation.refine) require('./refine.js');
  if (!SAT.occultation.contact) require('./contact.js');
  if (!SAT.occultation.lookAdapter) require('./look-adapter.js');
}
(function () {
  'use strict';

  const ROOT = SAT;
  const A = ROOT.occultation.lookAdapter;
  const CONTACT = ROOT.occultation.contact;

  function uniqueFlag(flags, value) {
    if (flags.indexOf(value) < 0) flags.push(value);
  }

  function starKeyOf(candidate, index) {
    if (candidate && candidate.starKey != null && String(candidate.starKey)) return String(candidate.starKey);
    if (candidate && candidate.catalogueId != null) return 'id:' + String(candidate.catalogueId);
    const ra = Number(candidate && candidate.raDeg), dec = Number(candidate && candidate.decDeg);
    const mag = Number(candidate && candidate.mag);
    if (isFinite(ra) && isFinite(dec)) {
      return 'rdm:' + (((ra % 360) + 360) % 360).toFixed(7) + ':' +
        dec.toFixed(7) + ':' + (isFinite(mag) ? mag : 0).toFixed(3);
    }
    return 'invalid:' + index;
  }

  function normaliseCandidate(raw, boundPass, fallbackPass, index) {
    const source = raw && raw.star && typeof raw.star === 'object'
      ? Object.assign({}, raw.star, raw) : (raw || {});
    const pass = boundPass || (source.pass && typeof source.pass === 'object' ? source.pass : fallbackPass);
    const ra = Number(source.raDeg), dec = Number(source.decDeg);
    const valid = isFinite(ra) && isFinite(dec) && dec >= -90 && dec <= 90;
    const segments = Array.isArray(source.sourceSegments)
      ? source.sourceSegments.map(Number).filter(isFinite).sort((a, b) => a - b) : [];
    const sourceSegments = [];
    segments.forEach((segment) => { if (sourceSegments.indexOf(segment) < 0) sourceSegments.push(segment); });
    return {
      valid: valid,
      invalidReason: valid ? null : 'invalid-star-direction',
      passId: source.passId != null ? String(source.passId) : (pass ? A.passIdOf(pass) : null),
      starKey: starKeyOf(source, index),
      raDeg: valid ? (((ra % 360) + 360) % 360) : null,
      decDeg: valid ? dec : null,
      mag: isFinite(Number(source.mag)) ? Number(source.mag) : null,
      catalogueId: source.catalogueId == null ? null : String(source.catalogueId),
      sourceSegments: sourceSegments,
    };
  }

  function collectInput(input) {
    if (!input || typeof input !== 'object') throw new Error('occultation event input is required');
    const source = Array.isArray(input) ? { candidates: input } : input;
    const passes = [], passIds = new Set(), entries = [];
    function addPass(pass) {
      if (!pass || typeof pass !== 'object') return null;
      const id = A.passIdOf(pass);
      if (!passIds.has(id)) {
        passIds.add(id);
        passes.push(pass);
      }
      return passes.find((row) => A.passIdOf(row) === id) || pass;
    }
    (Array.isArray(source.passes) ? source.passes : source.pass ? [source.pass] : []).forEach(addPass);
    function addResult(result) {
      if (!result || typeof result !== 'object') return;
      const boundPass = addPass(result.sourcePass || result.pass);
      (Array.isArray(result.candidates) ? result.candidates : []).forEach((candidate) => {
        entries.push({ candidate: candidate, pass: boundPass });
      });
    }
    const search = source.search || source.starSearch || source.candidateSearch;
    const results = Array.isArray(source.results) ? source.results
      : (search && Array.isArray(search.results) ? search.results : []);
    results.forEach(addResult);
    (Array.isArray(source.candidates) ? source.candidates : []).forEach((candidate) => {
      entries.push({ candidate: candidate,
        pass: candidate && candidate.sourcePass ? addPass(candidate.sourcePass) : null });
    });
    return { source: source, passes: passes, entries: entries };
  }

  function eventIdOf(passId, starKey) {
    return 'event:' + String(passId == null ? 'unbound' : passId) + ':' + String(starKey);
  }

  function statePassCopy(pass, pruneSourcePath) {
    const copy = A.copyValue(pass);
    if (!pruneSourcePath || !copy || !copy.sourceCrossing ||
        !Array.isArray(copy.sourceCrossing.path)) return copy;
    // `pass.path` is the path consumed by the chart. The raw crossing nested
    // under sourceCrossing contains the same samples; retaining both doubles
    // the largest object in a full-night result. Keep the audit record and its
    // scalar worker geometry, but omit only this duplicated representation.
    copy.sourceCrossing.path = [];
    copy.sourceCrossing.pathOmittedFromState = true;
    return copy;
  }

  function passClass(pass) {
    const value = pass && (pass.cls != null ? pass.cls
      : pass.orbitClass != null ? pass.orbitClass
        : pass.sourceCrossing && (pass.sourceCrossing.cls != null
          ? pass.sourceCrossing.cls : pass.sourceCrossing.orbitClass));
    const cls = value == null ? '' : String(value).trim().toLowerCase();
    return ['leo', 'meo', 'geo', 'heo'].indexOf(cls) >= 0 ? cls : null;
  }

  function passType(pass) {
    const value = pass && (pass.type != null ? pass.type
      : pass.sourceCrossing && pass.sourceCrossing.type);
    const type = value == null ? '' : String(value).trim().toUpperCase();
    return type === 'PAY' || type === 'R/B' || type === 'DEB' ? type : 'UNK';
  }

  function finiteOrNull(value) {
    return isFinite(Number(value)) ? Number(value) : null;
  }

  function failureEvent(candidate, pass, flags, error) {
    const passId = candidate.passId || (pass ? A.passIdOf(pass) : null);
    return {
      eventId: eventIdOf(passId, candidate.starKey),
      kind: 'occultation-candidate', status: 'incomplete', refinementStatus: 'failed', complete: false,
      passId: passId, satId: pass && pass.satId != null ? pass.satId : null,
      norad: pass && pass.norad != null ? pass.norad : null,
      name: pass && pass.name != null ? pass.name : null, starKey: candidate.starKey,
      cls: passClass(pass), orbitClass: passClass(pass), type: passType(pass),
      azDeg: null, elDeg: null,
      candidate: A.copyValue(candidate),
      passBounds: pass ? {
        startMs: pass.startMs == null ? null : Number(pass.startMs),
        culminationMs: pass.culminationMs == null ? null : Number(pass.culminationMs),
        endMs: pass.endMs == null ? null : Number(pass.endMs),
      } : null,
      tCaMs: null, closestApproachMs: null, nominalSeparationArcsec: null, distanceArcsec: null,
      closestGeometry: null, bracket: null, bracketWidthMs: null,
      contactStatus: 'unavailable', contact: false, contactResult: null,
      radiusM: null, radiusSource: null, angularRadiusArcsec: null,
      angularDiameterArcsec: null, ingressMs: null, egressMs: null, durationMs: null,
      contactIntervals: [],
      pathMode: pass && pass.pathMode != null ? pass.pathMode : null,
      pathToleranceArcsec: pass && pass.pathToleranceArcsec != null ? pass.pathToleranceArcsec : null,
      flags: flags.slice(), error: error ? String(error.message || error) : null, refinement: null,
    };
  }

  /** Limit exact refinement to the path neighbourhood that produced a candidate.
   *
   * OCCSTAR1 records the path segment indices whose conservative cone queries
   * returned the star. Reusing those indices (plus one neighbour on either side)
   * preserves the boundary interval needed by P0-07 while avoiding a second scan
   * over every unrelated segment for every star candidate. The final closest
   * approach and contact test still use the exact evaluator, not this polyline.
   */
  function candidatePath(pass, candidate) {
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

  function refineCandidate(candidate, pass, site, config, svc) {
    const flags = [];
    if (!pass) uniqueFlag(flags, 'missing-pass');
    if (!candidate.valid) uniqueFlag(flags, candidate.invalidReason || 'invalid-star-direction');
    if (!site) uniqueFlag(flags, 'missing-site');
    if (!svc.refine || typeof svc.refine.refine !== 'function') uniqueFlag(flags, 'refine-unavailable');
    if (!svc.prop || typeof svc.prop.look !== 'function') uniqueFlag(flags, 'look-unavailable');
    if (flags.length) return failureEvent(candidate, pass, flags);

    let adapter;
    try {
      adapter = A.bindLook({ pass: pass, site: site }, config, svc);
    } catch (error) {
      uniqueFlag(flags, error.message.indexOf('catalogue') >= 0 ? 'missing-object' : 'look-bind-failed');
      return failureEvent(candidate, pass, flags, error);
    }
    let refinement;
    try {
      refinement = svc.refine.refine({ pass: pass, candidate: candidate,
        path: candidatePath(pass, candidate), evaluate: adapter.evaluate }, config.refine);
    } catch (error) {
      uniqueFlag(flags, 'refine-input-failed');
      return failureEvent(candidate, pass, flags, error);
    }
    const resultFlags = Array.isArray(refinement.flags) ? refinement.flags.slice() : [];
    resultFlags.forEach((flag) => uniqueFlag(flags, flag));
    const complete = refinement.status === 'ok' && refinement.complete === true;
    if (!complete) uniqueFlag(flags, 'event-incomplete');
    const passId = A.passIdOf(pass);
    let contact = null;
    if (complete) {
      try {
        contact = CONTACT.solve({
          pass: pass,
          candidate: candidate,
          object: adapter.object,
          evaluate: adapter.evaluate,
          tCaMs: refinement.tCaMs,
        }, config.contact);
      } catch (error) {
        contact = {
          status: 'failed', complete: false, contact: false, flags: ['contact-input-failed'],
          error: String(error.message || error), intervals: [], radiusM: null,
          radiusSource: null, angularRadiusArcsecAtCa: null, angularDiameterArcsecAtCa: null,
          ingressMs: null, egressMs: null, durationMs: null,
        };
      }
      const contactFlags = Array.isArray(contact.flags) ? contact.flags : [];
      contactFlags.forEach((flag) => uniqueFlag(flags, flag));
      if (!contact.complete) uniqueFlag(flags, 'contact-incomplete');
    }
    const eventComplete = complete && !!contact && contact.complete === true;
    return {
      eventId: eventIdOf(passId, candidate.starKey), kind: 'occultation-candidate',
      status: eventComplete ? 'candidate' : 'incomplete', refinementStatus: refinement.status,
      complete: eventComplete, passId: passId, satId: pass.satId == null ? null : pass.satId,
      norad: pass.norad == null ? null : pass.norad, name: pass.name == null ? null : pass.name,
      cls: passClass(pass), orbitClass: passClass(pass), type: passType(pass),
      starKey: candidate.starKey, candidate: A.copyValue(candidate),
      passBounds: {
        startMs: pass.startMs == null ? null : Number(pass.startMs),
        culminationMs: pass.culminationMs == null ? null : Number(pass.culminationMs),
        endMs: pass.endMs == null ? null : Number(pass.endMs),
      },
      tCaMs: refinement.tCaMs == null ? null : Number(refinement.tCaMs),
      closestApproachMs: refinement.tCaMs == null ? null : Number(refinement.tCaMs),
      nominalSeparationArcsec: refinement.nominalSeparationArcsec == null
        ? null : Number(refinement.nominalSeparationArcsec),
      distanceArcsec: refinement.distanceArcsec == null ? null : Number(refinement.distanceArcsec),
      closestGeometry: A.copyValue(refinement.closestGeometry),
      azDeg: finiteOrNull(refinement.closestGeometry && refinement.closestGeometry.azDeg),
      elDeg: finiteOrNull(refinement.closestGeometry && refinement.closestGeometry.elDeg),
      closestVector: A.copyValue(refinement.closestVector), bracket: A.copyValue(refinement.bracket),
      bracketWidthMs: refinement.bracketWidthMs == null ? null : Number(refinement.bracketWidthMs),
      contactStatus: contact ? contact.status : 'unavailable',
      contact: contact ? !!contact.contact : false,
      contactResult: A.copyValue(contact),
      radiusM: contact && contact.radiusM == null ? null : (contact ? Number(contact.radiusM) : null),
      radiusSource: contact ? contact.radiusSource : null,
      angularRadiusArcsec: contact && contact.angularRadiusArcsecAtCa == null ? null
        : (contact ? Number(contact.angularRadiusArcsecAtCa) : null),
      angularDiameterArcsec: contact && contact.angularDiameterArcsecAtCa == null ? null
        : (contact ? Number(contact.angularDiameterArcsecAtCa) : null),
      ingressMs: contact && contact.ingressMs == null ? null : (contact ? Number(contact.ingressMs) : null),
      egressMs: contact && contact.egressMs == null ? null : (contact ? Number(contact.egressMs) : null),
      durationMs: contact && contact.durationMs == null ? null : (contact ? Number(contact.durationMs) : null),
      contactIntervals: contact && Array.isArray(contact.intervals)
        ? A.copyValue(contact.intervals) : [],
      pathMode: pass.pathMode == null ? null : pass.pathMode,
      pathToleranceArcsec: pass.pathToleranceArcsec == null ? null : Number(pass.pathToleranceArcsec),
      flags: flags, error: refinement.error == null ? null : String(refinement.error),
      evaluator: { source: adapter.source, dateResolutionMs: adapter.dateResolutionMs },
      refinement: A.copyValue(refinement),
    };
  }

  /**
   * Assemble pass/candidate inputs into an independent occultation event state.
   * The exact evaluator is always `SAT.prop.look()` through `lookAdapter`.
   * `input` accepts `{site, passes, candidates}` or a star-candidate search
   * result with `results[].sourcePass` and `results[].candidates`. Solver options
   * are passed through `options`; `{state, prop, refine}` may be injected for
   * deterministic tests. The result is ordered by `tCaMs` then `eventId` and
   * contains incomplete events instead of discarding failed candidates.
   */
  function prepareBuild(input, options, overrides) {
    const collected = collectInput(input), svc = A.services(overrides);
    const config = A.resolveOptions(collected.source, options);
    const site = A.siteOf(collected.source, svc);
    const passMap = new Map();
    collected.passes.forEach((pass) => passMap.set(A.passIdOf(pass), pass));
    const filterSource = collected.source.satelliteFilters || collected.source.filters || collected.source;
    const state = {
      version: 'p0-09', status: 'empty', complete: true, stale: false, updatedAtMs: config.nowMs,
      site: A.copyValue(site), options: A.copyValue({ refraction: config.refraction,
        dut1S: config.dut1S, refine: config.refine, contact: config.contact,
        retainOnlyCandidatePasses: config.retainOnlyCandidatePasses,
        contactsOnly: config.contactsOnly,
        satelliteClasses: filterSource && Object.prototype.hasOwnProperty.call(filterSource, 'classes')
          ? A.copyValue(filterSource.classes) : null,
        satelliteTypes: filterSource && Object.prototype.hasOwnProperty.call(filterSource, 'types')
          ? A.copyValue(filterSource.types) : null }),
      passes: [], candidates: [], events: [], failures: [],
      stats: { passes: collected.passes.length, candidates: 0, events: 0, refined: 0,
        incomplete: 0, failed: 0, duplicateCandidates: 0, contacted: 0,
        contactMisses: 0, contactIncomplete: 0, evaluatedCandidates: 0,
        evaluatedEvents: 0, filteredEvents: 0, filteredMisses: 0,
        filteredIncomplete: 0, filteredCandidates: 0, retainedPasses: 0 },
    };
    const seen = new Set(), normalized = [];
    collected.entries.forEach((entry, index) => {
      const candidate = normaliseCandidate(entry.candidate, entry.pass,
        collected.passes.length === 1 ? collected.passes[0] : null, index);
      const key = String(candidate.passId == null ? 'unbound' : candidate.passId) + '\u0000' + candidate.starKey;
      if (seen.has(key)) { state.stats.duplicateCandidates++; return; }
      seen.add(key);
      normalized.push({ candidate: candidate, pass: passMap.get(candidate.passId) || null });
    });
    state.candidates = normalized.map((row) => A.copyValue(row.candidate));
    state.stats.candidates = state.candidates.length;
    state.stats.evaluatedCandidates = state.candidates.length;
    const retainedIds = new Set(normalized.map((row) => row.pass ? A.passIdOf(row.pass) : null));
    const retainedPasses = config.retainOnlyCandidatePasses
      ? collected.passes.filter((pass) => retainedIds.has(A.passIdOf(pass)))
      : collected.passes;
    state.passes = retainedPasses.map((pass) => {
      const copy = statePassCopy(pass, config.retainOnlyCandidatePasses);
      if (copy && copy.passId == null) copy.passId = A.passIdOf(pass);
      return copy;
    });
    state.stats.retainedPasses = state.passes.length;
    return { state: state, normalized: normalized, site: site, config: config, svc: svc };
  }

  function isSuccessfulContact(event) {
    return !!(event && event.complete === true && event.contact === true &&
      (event.contactStatus === 'contact' || event.contactStatus === 'grazing'));
  }

  function recordEvent(state, event, config) {
    state.stats.evaluatedEvents++;
    if (event.complete) state.stats.refined++;
    if (event.contactStatus === 'contact' || event.contactStatus === 'grazing') {
      state.stats.contacted++;
    } else if (event.contactStatus === 'miss') {
      state.stats.contactMisses++;
    } else if (event.contactStatus !== 'unavailable') {
      state.stats.contactIncomplete++;
    }
    if (config.contactsOnly && !isSuccessfulContact(event)) {
      state.stats.filteredEvents++;
      if (event.contactStatus === 'miss') state.stats.filteredMisses++;
      else state.stats.filteredIncomplete++;
      return;
    }
    state.events.push(event);
    if (!event.complete) {
      state.stats.incomplete++;
      state.failures.push({ eventId: event.eventId, passId: event.passId, starKey: event.starKey,
        flags: event.flags.slice(), error: event.error });
    }
  }

  function pruneForContactFilter(state) {
    if (!state.options || !state.options.contactsOnly) return;
    const eventKeys = new Set(state.events.map((event) =>
      String(event.passId == null ? 'unbound' : event.passId) + '\u0000' + String(event.starKey)));
    const beforeCandidates = state.candidates.length;
    state.candidates = state.candidates.filter((candidate) => eventKeys.has(
      String(candidate.passId == null ? 'unbound' : candidate.passId) + '\u0000' +
      String(candidate.starKey)));
    state.stats.filteredCandidates = beforeCandidates - state.candidates.length;
    const passIds = new Set(state.candidates.map((candidate) => String(candidate.passId)));
    state.passes = state.passes.filter((pass) => passIds.has(String(A.passIdOf(pass))));
    state.stats.retainedPasses = state.passes.length;
    state.stats.candidates = state.candidates.length;
  }

  function finishBuild(state) {
    pruneForContactFilter(state);
    state.events.sort((a, b) => {
      const at = a.tCaMs == null ? Infinity : a.tCaMs, bt = b.tCaMs == null ? Infinity : b.tCaMs;
      return at - bt || a.eventId.localeCompare(b.eventId);
    });
    state.stats.events = state.events.length;
    state.stats.failed = state.stats.incomplete;
    state.complete = state.events.every((event) => event.complete);
    state.status = state.events.length ? (state.complete ? 'ok' : 'partial') : 'empty';
    return state;
  }

  function build(input, options, overrides) {
    const prepared = prepareBuild(input, options, overrides);
    const state = prepared.state;
    prepared.normalized.forEach((row) => {
      recordEvent(state, refineCandidate(row.candidate, row.pass, prepared.site,
        prepared.config, prepared.svc), prepared.config);
    });
    return finishBuild(state);
  }

  function cancelledError() {
    const error = new Error('Occultation event assembly cancelled');
    error.pipelineCode = 'cancelled';
    return error;
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Cooperative event assembly for the interactive nightly pipeline.
   *
   * Parameters
   * ----------
   * input, options, overrides : object
   *     The same pass/candidate records, solver options, and injected services
   *     accepted by `build()`. Times remain UTC Unix milliseconds; star angles
   *     are J2000 degrees; ranges and effective radii retain their documented km
   *     and m units in the returned event records.
   * controls : object, optional
   *     `shouldCancel()` is checked before each candidate. `onProgress(payload)`
   *     receives `{phase:'event-refinement', done, total}`. The worker-like
   *     scheduling boundary is a browser task, not a scientific approximation.
   *
   * Returns
   * -------
   * Promise<object>
   *     The same independent event state as `build()`, ordered by closest time
   *     and event ID. A cancellation rejects with `pipelineCode: 'cancelled'`;
   *     it never returns a partial state for publication.
   *
   * Notes
   * -----
   * Each candidate still uses the exact P0-07/P0-09 evaluators and the same
   * numerical options. Yielding after a short time slice prevents a large
   * catalogue from monopolizing the browser main thread and lets the pipeline's
   * Cancel button take effect.
   */
  async function buildAsync(input, options, overrides, controls) {
    const prepared = prepareBuild(input, options, overrides);
    const state = prepared.state;
    const control = controls || {};
    let sliceStart = Date.now(), lastProgressAt = 0, batchCount = 0;
    const total = prepared.normalized.length;
    for (let i = 0; i < total; i++) {
      if (typeof control.shouldCancel === 'function' && control.shouldCancel()) {
        throw cancelledError();
      }
      const row = prepared.normalized[i];
      recordEvent(state, refineCandidate(row.candidate, row.pass, prepared.site,
        prepared.config, prepared.svc), prepared.config);
      const now = Date.now();
      if (typeof control.onProgress === 'function' &&
          (i === 0 || i + 1 === total || now - lastProgressAt >= 100)) {
        control.onProgress({ phase: 'event-refinement', done: i + 1, total: total });
        lastProgressAt = now;
      }
      batchCount++;
      if (i + 1 < total && (now - sliceStart >= 12 || batchCount >= 64)) {
        await yieldToBrowser();
        sliceStart = Date.now();
        batchCount = 0;
      }
    }
    if (typeof control.shouldCancel === 'function' && control.shouldCancel()) {
      throw cancelledError();
    }
    return finishBuild(state);
  }

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.eventAssembly = {
    build: build,
    assemble: build,
    buildAsync: buildAsync,
    assembleAsync: buildAsync,
    eventId: eventIdOf,
  };
})();
