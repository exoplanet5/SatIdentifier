/* SAT.occultation.starCandidates — spherical-corridor star candidate search.
 *
 * Scientific responsibility: query the existing J2000 star catalogue around a
 * normalized SatellitePass path and return deduplicated star candidates. This
 * module does not propagate satellites, solve stellar closest approach, assign
 * occultation probability, rank events, or write application state/UI data.
 *
 * The browser loads this file as a classic script. A small CommonJS convenience
 * loads the same geometry dependency for the focused Node harness.
 */
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports &&
    typeof SAT !== 'undefined') {
  SAT.occultation = SAT.occultation || {};
  if (!SAT.occultation.geometry) require('./geometry.js');
}
(function () {
  'use strict';

  const ARCSEC_PER_DEG = 3600;
  const DEFAULTS = {
    // Engineering search padding only; it is not a TLE uncertainty or probability.
    corridorArcsec: 1,
    rawPathPaddingArcsec: 0,
    magLimit: null,
    maxCandidates: 20000,
    maxTotalCandidates: null,
    maxQueries: 4096,
    catalogueResultCap: 20000,
    // Raw worker paths are already explicitly unverified. A small query-only
    // representation prevents a full-night fallback from issuing one cone
    // query for every transferred worker segment. The original pass path is
    // retained as provenance and remains available to event refinement.
    rawPathMaxSamples: 4,
    // Large interactive runs can omit duplicated audit payloads after the
    // scientific query has been accounted for. The normal API retains both.
    retainQueries: true,
    retainSourcePass: true,
  };

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  function nonNegative(value, label) {
    const number = finiteNumber(value, label);
    if (number < 0) throw new Error(label + ' must be non-negative');
    return number;
  }

  function positiveInteger(value, label) {
    const number = Math.floor(finiteNumber(value, label));
    if (number < 1) throw new Error(label + ' must be at least 1');
    return number;
  }

  function boundedInteger(value, label) {
    const number = Math.floor(finiteNumber(value, label));
    if (number < 0) throw new Error(label + ' must be non-negative');
    return number;
  }

  function normRa(raDeg) {
    return ((raDeg % 360) + 360) % 360;
  }

  const GEOMETRY = SAT.occultation.geometry;

  function unitFromRaDec(raDeg, decDeg) {
    return GEOMETRY.unitFromRaDec(raDeg, decDeg);
  }

  function raDecFromUnit(v) {
    return GEOMETRY.raDecFromUnit(v);
  }

  /** Return the minor great-circle arc in degrees between two unit directions.
   *
   * Equation: `d = atan2(|a × b|, a · b)`. The atan2 form remains well
   * conditioned for both sub-arcsecond separations and nearly antipodal points.
   * `a` and `b` are dimensionless unit vectors in the J2000 mean-equator,
   * mean-equinox frame; the returned `d` is in degrees.
   */
  function arcDeg(a, b) {
    return GEOMETRY.arcDeg(a, b);
  }

  function uniqueFlag(flags, value) {
    if (flags.indexOf(value) < 0) flags.push(value);
  }

  function passId(pass) {
    if (pass && pass.passId != null) return String(pass.passId);
    if (pass && pass.satId != null) return 'sat:' + String(pass.satId);
    if (pass && pass.norad != null) return 'norad:' + String(pass.norad);
    return null;
  }

  function normalizedPath(pass, flags, config) {
    const input = pass && Array.isArray(pass.path) ? pass.path : [];
    const points = [];
    let invalid = 0;
    for (let i = 0; i < input.length; i++) {
      const row = input[i];
      const t = row && Number(row.t);
      const ra = row && Number(row.raDeg);
      const dec = row && Number(row.decDeg);
      if (!isFinite(t) || !isFinite(ra) || !isFinite(dec) || dec < -90 || dec > 90) {
        invalid++;
        continue;
      }
      points.push({
        t: Math.round(t),
        raDeg: normRa(ra),
        decDeg: dec,
        vector: unitFromRaDec(ra, dec),
        sourceIndex: i,
      });
    }
    if (invalid) uniqueFlag(flags, 'invalid-path-points');
    points.sort((a, b) => a.t - b.t || a.sourceIndex - b.sourceIndex);
    const unique = [];
    for (let i = 0; i < points.length; i++) {
      if (unique.length && unique[unique.length - 1].t === points[i].t) {
        unique[unique.length - 1] = points[i];
      } else {
        unique.push(points[i]);
      }
    }
    if (unique.length !== points.length) uniqueFlag(flags, 'duplicate-path-times');
    if (unique.some((point, i) => i && point.t <= unique[i - 1].t)) {
      uniqueFlag(flags, 'non-increasing-path');
    }
    if (pass && pass.pathMode === 'raw-worker' && unique.length > config.rawPathMaxSamples) {
      const kept = [];
      for (let i = 0; i < config.rawPathMaxSamples; i++) {
        const index = Math.round(i * (unique.length - 1) /
          (config.rawPathMaxSamples - 1));
        if (!kept.length || kept[kept.length - 1].t !== unique[index].t) {
          kept.push(unique[index]);
        }
      }
      uniqueFlag(flags, 'raw-path-downsampled');
      return kept;
    }
    return unique;
  }

  function resolveInput(input) {
    const source = input && typeof input === 'object' ? input : {};
    const corridor = source.corridorArcsec == null
      ? (source.searchRadiusArcsec == null
        ? (source.starCorridorArcsec == null ? DEFAULTS.corridorArcsec : source.starCorridorArcsec)
        : source.searchRadiusArcsec)
      : source.corridorArcsec;
    const rawPadding = source.rawPathPaddingArcsec == null
      ? (source.fallbackPathPaddingArcsec == null
        ? DEFAULTS.rawPathPaddingArcsec : source.fallbackPathPaddingArcsec)
      : source.rawPathPaddingArcsec;
    const maxCandidates = source.maxCandidates == null
      ? (source.maxStarsPerPass == null ? DEFAULTS.maxCandidates : source.maxStarsPerPass)
      : source.maxCandidates;
    const maxTotalCandidates = source.maxTotalCandidates == null
      ? DEFAULTS.maxTotalCandidates : source.maxTotalCandidates;
    const maxQueries = source.maxQueries == null ? DEFAULTS.maxQueries : source.maxQueries;
    const catalogueResultCap = source.catalogueResultCap == null
      ? DEFAULTS.catalogueResultCap : source.catalogueResultCap;
    const rawPathMaxSamples = source.rawPathMaxSamples == null
      ? DEFAULTS.rawPathMaxSamples : source.rawPathMaxSamples;
    const magLimit = source.magLimit == null ? DEFAULTS.magLimit : source.magLimit;
    if (magLimit != null && !isFinite(Number(magLimit))) throw new Error('magLimit must be finite or null');
    const rawPathSampleLimit = boundedInteger(rawPathMaxSamples, 'rawPathMaxSamples');
    if (rawPathSampleLimit < 2) throw new Error('rawPathMaxSamples must be at least 2');
    const totalCandidateLimit = maxTotalCandidates == null ? null
      : boundedInteger(maxTotalCandidates, 'maxTotalCandidates');
    return {
      corridorArcsec: nonNegative(corridor, 'corridorArcsec'),
      rawPathPaddingArcsec: nonNegative(rawPadding, 'rawPathPaddingArcsec'),
      magLimit: magLimit == null ? null : Number(magLimit),
      maxCandidates: boundedInteger(maxCandidates, 'maxCandidates'),
      maxTotalCandidates: totalCandidateLimit,
      maxQueries: positiveInteger(maxQueries, 'maxQueries'),
      catalogueResultCap: positiveInteger(catalogueResultCap, 'catalogueResultCap'),
      rawPathMaxSamples: rawPathSampleLimit,
      retainQueries: source.retainQueries == null ? DEFAULTS.retainQueries : !!source.retainQueries,
      retainSourcePass: source.retainSourcePass == null
        ? DEFAULTS.retainSourcePass : !!source.retainSourcePass,
    };
  }

  function services(overrides) {
    const root = typeof SAT === 'undefined' ? {} : SAT;
    const source = overrides || {};
    return { stars: source.stars || root.stars };
  }

  function starRecord(row) {
    if (!row || typeof row !== 'object') return null;
    const raDeg = Number(row.raDeg), decDeg = Number(row.decDeg), mag = Number(row.mag);
    if (!isFinite(raDeg) || !isFinite(decDeg) || decDeg < -90 || decDeg > 90 || !isFinite(mag)) {
      return null;
    }
    const catalogueId = row.starId != null ? row.starId
      : (row.id != null ? row.id : null);
    return {
      raDeg: normRa(raDeg),
      decDeg: decDeg,
      mag: mag,
      catalogueId: catalogueId == null ? null : String(catalogueId),
    };
  }

  function starKey(star) {
    if (star.catalogueId != null) return 'id:' + star.catalogueId;
    // The binary catalogue stores RA/Dec as float32 and magnitude as centimags;
    // these digits are finer than the catalogue's quantization and keep close
    // but distinct stars from collapsing during multi-segment deduplication.
    return 'rdm:' + star.raDeg.toFixed(7) + ':' + star.decDeg.toFixed(7) + ':' +
      star.mag.toFixed(3);
  }

  function candidateComparator(a, b) {
    return a.mag - b.mag || a.starKey.localeCompare(b.starKey);
  }

  /** Search one SatellitePass for stars in a spherical path corridor.
   *
   * Parameters
   * ----------
   * pass : object
   *     A P0-04 SatellitePass. `path` contains UTC Unix-millisecond samples and
   *     J2000 RA/Dec in degrees. The object is retained as `sourcePass` and is
   *     never mutated.
   * options : object, optional
   *     `corridorArcsec` is additional angular search padding; it is an
   *     engineering input, not a TLE uncertainty or an occultation probability.
   *     `magLimit` is the catalogue magnitude limit. `rawPathPaddingArcsec`
   *     supplies an explicit padding when the pass has no verified adaptive
   *     tolerance. The remaining fields bound work and expose truncation.
   * overrides : object, optional
   *     Test/service injection. `overrides.stars.cone(raDeg, decDeg, radiusDeg,
   *     magLimit)` must return an array of J2000 star records.
   *
   * Returns
   * -------
   * object
   *     `{passId, sourcePass, candidates, queries, complete, truncated, flags}`.
   *     Each candidate has `{passId, starKey, raDeg, decDeg, mag,
   *     catalogueId, sourceSegments}`. Candidates are deduplicated and sorted
   *     by magnitude; `sourceSegments` identifies the path segments whose
   *     sound over-query returned the star. No closest-approach time is claimed.
   *
   * Equation
   * --------
   * For segment arc length `L`, midpoint `m`, corridor padding `C`, and verified
   * path tolerance `T`, the cone query radius is
   * `q = min(180°, L/2 + (C + T)/3600)`. Every point on the minor great-circle
   * segment is within `L/2` of `m`; the adaptive-path contract bounds the true
   * trajectory's interpolation residual by `T`. The query is therefore a
   * conservative corridor over-query, with possible false positives by design.
   *
   * Notes
   * -----
   * A raw-worker pass has no representation-error claim. It remains searchable,
   * but receives `path-precision-unverified` and is complete only if the caller
   * supplies an explicit fallback padding. Long raw paths may also be reduced
   * to `rawPathMaxSamples` for query-budget control; that reduction is flagged
   * and is never presented as a complete recall claim. A missing or failed cone
   * query marks the result incomplete rather than pretending that no stars were
   * present.
   */
  function searchPass(pass, options, overrides) {
    const config = resolveInput(options);
    const svc = services(overrides);
    if (!svc.stars || typeof svc.stars.cone !== 'function') {
      throw new Error('SAT.stars.cone() is required for OCCSTAR1 star search');
    }

    const flags = [];
    const result = {
      passId: passId(pass),
      satId: pass && pass.satId,
      norad: pass && pass.norad,
      sourcePass: config.retainSourcePass ? pass : null,
      candidates: [],
      queries: [],
      pathSampleCount: 0,
      sourcePathSampleCount: pass && Array.isArray(pass.path) ? pass.path.length : 0,
      queryCount: 0,
      duplicateCount: 0,
      truncated: false,
      complete: true,
      flags: flags,
      corridorArcsec: config.corridorArcsec,
      pathToleranceArcsec: null,
      pathPaddingArcsec: null,
      rawPathMaxSamples: config.rawPathMaxSamples,
    };

    const path = normalizedPath(pass, flags, config);
    result.pathSampleCount = path.length;
    if (!path.length) {
      uniqueFlag(flags, 'missing-path');
      result.complete = false;
      return result;
    }

    const adaptiveTolerance = pass && Number(pass.pathToleranceArcsec);
    const verifiedTolerance = pass && pass.pathMode === 'adaptive' &&
      isFinite(adaptiveTolerance) && adaptiveTolerance >= 0 ? adaptiveTolerance : null;
    const pathPaddingArcsec = verifiedTolerance == null
      ? config.rawPathPaddingArcsec : verifiedTolerance;
    result.pathToleranceArcsec = verifiedTolerance;
    result.pathPaddingArcsec = pathPaddingArcsec;
    if (verifiedTolerance == null) {
      uniqueFlag(flags, 'path-precision-unverified');
      if (config.rawPathPaddingArcsec <= 0) result.complete = false;
    }
    // Downsampling is a query-budget safeguard for raw-worker paths only. It
    // adds another representation approximation, so even explicit raw-path
    // padding cannot turn this result into a complete recall claim.
    if (flags.indexOf('raw-path-downsampled') >= 0) result.complete = false;

    const byKey = new Map();
    const segmentCount = Math.max(1, path.length - 1);
    for (let i = 0; i < segmentCount; i++) {
      if (result.queryCount >= config.maxQueries) {
        result.truncated = true;
        result.complete = false;
        uniqueFlag(flags, 'star-query-truncated');
        break;
      }
      const a = path[i];
      const b = path.length === 1 ? path[i] : path[i + 1];
      const envelope = GEOMETRY.segmentEnvelope(a.vector, b.vector,
        config.corridorArcsec + pathPaddingArcsec);
      const lengthDeg = envelope.arcDeg;
      if (envelope.wholeSphere) uniqueFlag(flags, 'long-path-segment');
      const radiusDeg = envelope.radiusDeg;
      const center = raDecFromUnit(envelope.center) || { raDeg: a.raDeg, decDeg: a.decDeg };
      const query = {
        segmentIndex: path.length === 1 ? 0 : i,
        center: { raDeg: center.raDeg, decDeg: center.decDeg },
        radiusDeg: radiusDeg,
        radiusArcsec: radiusDeg * ARCSEC_PER_DEG,
        segmentArcsec: lengthDeg * ARCSEC_PER_DEG,
        magLimit: config.magLimit,
        count: 0,
        failed: false,
      };
      result.queryCount++;
      let rows = [];
      try {
        rows = svc.stars.cone(center.raDeg, center.decDeg, radiusDeg, config.magLimit);
        if (!Array.isArray(rows)) throw new Error('star cone did not return an array');
      } catch (error) {
        query.failed = true;
        result.complete = false;
        uniqueFlag(flags, 'star-query-failed');
        rows = [];
      }
      query.count = rows.length;
      if (rows.length >= config.catalogueResultCap) {
        result.truncated = true;
        result.complete = false;
        uniqueFlag(flags, 'star-catalogue-truncated');
      }
      if (config.retainQueries) result.queries.push(query);
      for (let j = 0; j < rows.length; j++) {
        const star = starRecord(rows[j]);
        if (!star) {
          uniqueFlag(flags, 'invalid-star-record');
          continue;
        }
        const key = starKey(star);
        let candidate = byKey.get(key);
        if (!candidate) {
          candidate = {
            passId: result.passId,
            starKey: key,
            raDeg: star.raDeg,
            decDeg: star.decDeg,
            mag: star.mag,
            catalogueId: star.catalogueId,
            sourceSegments: [],
          };
          byKey.set(key, candidate);
        } else {
          result.duplicateCount++;
        }
        if (candidate.sourceSegments.indexOf(query.segmentIndex) < 0) {
          candidate.sourceSegments.push(query.segmentIndex);
        }
      }
    }

    const candidates = Array.from(byKey.values());
    candidates.forEach((candidate) => candidate.sourceSegments.sort((a, b) => a - b));
    candidates.sort(candidateComparator);
    if (candidates.length > config.maxCandidates) {
      candidates.length = config.maxCandidates;
      result.truncated = true;
      result.complete = false;
      uniqueFlag(flags, 'candidate-limit');
    }
    result.candidates = candidates;
    return result;
  }

  /** Add one pass result to a bounded aggregate without retaining excess stars.
   *
   * `maxCandidates` is a per-pass catalogue guard. `maxTotalCandidates`, when
   * supplied by an interactive caller, is a second deterministic guard over the
   * flattened pass list. The latter is deliberately explicit in the result flags
   * because dropping candidates changes recall even though every cone query still
   * ran and its query count remains accounted for.
   */
  function appendAggregate(aggregate, result, options) {
    const discovered = result.candidates.length;
    aggregate.candidateMatches += discovered;
    if (options.maxTotalCandidates != null) {
      const remaining = Math.max(0, options.maxTotalCandidates - aggregate.candidates.length);
      if (discovered > remaining) {
        result.candidates.length = remaining;
        result.truncated = true;
        result.complete = false;
        uniqueFlag(result.flags, 'candidate-total-limit');
        aggregate.candidateLimitReached = true;
      }
    }
    aggregate.candidates.push.apply(aggregate.candidates, result.candidates);
    aggregate.queries += result.queryCount;
    aggregate.duplicates += result.duplicateCount;
    aggregate.truncated = aggregate.truncated || result.truncated;
    aggregate.complete = aggregate.complete && result.complete;
  }

  function aggregateResult(aggregate, results, result, options) {
    results.push(result);
    appendAggregate(aggregate, result, options);
  }

  function resultStats(aggregate, options) {
    return {
      passes: aggregate.results,
      candidates: aggregate.candidates.length,
      candidateMatches: aggregate.candidateMatches,
      candidateLimit: options.maxTotalCandidates,
      candidateLimitReached: aggregate.candidateLimitReached,
      queries: aggregate.queries,
      duplicates: aggregate.duplicates,
      truncated: aggregate.truncated,
      complete: aggregate.complete,
      auditCompacted: !options.retainQueries || !options.retainSourcePass,
      queriesRetained: options.retainQueries,
      sourcePassesRetained: options.retainSourcePass,
    };
  }

  /** Search one pass or a list of passes, preserving one audit result per pass. */
  function search(input, overrides) {
    const source = Array.isArray(input) ? { passes: input } : (input || {});
    const passes = Array.isArray(source.passes) ? source.passes
      : (source.pass ? [source.pass] : (Array.isArray(source.path) ? [source] : []));
    const options = resolveInput(source);
    const results = [];
    const aggregate = {
      candidates: [], candidateMatches: 0, queries: 0, duplicates: 0,
      truncated: false, complete: true, candidateLimitReached: false,
      results: 0,
    };
    for (let i = 0; i < passes.length; i++) {
      aggregateResult(aggregate, results, searchPass(passes[i], options, overrides), options);
    }
    aggregate.results = results.length;
    return {
      status: aggregate.complete ? 'ok' : (results.length ? 'partial' : 'empty'),
      results: results,
      candidates: aggregate.candidates,
      stats: resultStats(aggregate, options),
    };
  }

  function cancelledError() {
    const error = new Error('Occultation star search cancelled');
    error.pipelineCode = 'cancelled';
    return error;
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Cooperative variant of `search()` for the interactive pipeline.
   *
   * Parameters
   * ----------
   * input : object
   *     The same JSON-like pass list and star-search options accepted by
   *     `search()`. Times in pass paths are UTC Unix milliseconds; angles are
   *     J2000 degrees and catalogue magnitudes are V magnitudes.
   * overrides : object, optional
   *     Service overrides, including `{stars: {cone()}}` for tests.
   * controls : object, optional
   *     `shouldCancel()` returns a boolean; `onProgress(payload)` receives
   *     `{phase:'star-search', done, total}`. The function yields to the browser
   *     event loop in short work slices so Cancel and repaint events can be handled.
   *
   * Returns
   * -------
   * Promise<object>
   *     The same aggregate search result as `search()`.
   *
   * Notes
   * -----
   * The scientific query for each pass is unchanged. Only scheduling differs:
   * several quick passes may share one task turn, while long work yields after
   * a short time slice. Progress notifications are throttled for the same
   * reason. Cancellation is explicit and never converts an unfinished search
   * into an empty result.
   */
  async function searchAsync(input, overrides, controls) {
    const source = Array.isArray(input) ? { passes: input } : (input || {});
    const passes = Array.isArray(source.passes) ? source.passes
      : (source.pass ? [source.pass] : (Array.isArray(source.path) ? [source] : []));
    const options = resolveInput(source);
    const control = controls || {};
    const results = [];
    const aggregate = {
      candidates: [], candidateMatches: 0, queries: 0, duplicates: 0,
      truncated: false, complete: true, candidateLimitReached: false,
      results: 0,
    };
    let sliceStart = Date.now(), lastProgressAt = 0, batchCount = 0;
    for (let i = 0; i < passes.length; i++) {
      if (typeof control.shouldCancel === 'function' && control.shouldCancel()) {
        throw cancelledError();
      }
      const result = searchPass(passes[i], options, overrides);
      aggregateResult(aggregate, results, result, options);
      const now = Date.now();
      if (typeof control.onProgress === 'function' &&
          (i === 0 || i + 1 === passes.length || now - lastProgressAt >= 100)) {
        control.onProgress({ phase: 'star-search', done: i + 1, total: passes.length });
        lastProgressAt = now;
      }
      batchCount++;
      if (i + 1 < passes.length && (now - sliceStart >= 12 || batchCount >= 64)) {
        await yieldToBrowser();
        sliceStart = Date.now();
        batchCount = 0;
      }
    }
    if (typeof control.shouldCancel === 'function' && control.shouldCancel()) {
      throw cancelledError();
    }
    aggregate.results = results.length;
    return {
      status: aggregate.complete ? 'ok' : (results.length ? 'partial' : 'empty'),
      results: results,
      candidates: aggregate.candidates,
      stats: resultStats(aggregate, options),
    };
  }

  const API = {
    resolveInput: resolveInput,
    searchPass: searchPass,
    candidatesForPass: searchPass,
    search: search,
    searchAsync: searchAsync,
    find: search,
    arcDeg: arcDeg,
  };

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.starCandidates = API;
})();
