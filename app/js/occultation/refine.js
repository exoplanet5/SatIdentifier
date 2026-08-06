/* SAT.occultation.refine — time-dependent stellar closest approach.
 *
 * Scientific responsibility: minimize the angular separation between a fixed
 * J2000 catalogue direction and an exactly evaluated satellite direction over
 * one UTC time interval. The path is used to select and bracket candidate
 * intervals; the final separation and time always come from `evaluate(tMs)`.
 * This module does not propagate TLEs, query a catalogue, write state, or draw
 * a chart.
 *
 * The browser loads this file as a classic script. The CommonJS convenience
 * below lets the focused Node harness load the same geometry dependency.
 */
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports &&
    typeof SAT !== 'undefined') {
  SAT.occultation = SAT.occultation || {};
  if (!SAT.occultation.geometry) require('./geometry.js');
}
(function () {
  'use strict';

  const GEOMETRY = SAT.occultation.geometry;
  const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
  const ARCSEC_EPS = 1e-9;
  const DEFAULTS = {
    timeToleranceMs: 0.05,
    coarseMarginArcsec: 0.01,
    // Raw worker paths have no adaptive error certificate. Keep the historical
    // Infinity default for ordinary callers; headless full-search mode may set
    // an explicit conservative screening margin after using a full fine-step
    // worker path, avoiding an expensive golden search on every distant segment.
    unverifiedSelectionMarginArcsec: Infinity,
    maxEvaluations: 100000,
    maxSegments: 4096,
    maxIterations: 80,
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

  function directionOf(value, label) {
    const source = value && value.vector ? value.vector
      : (value && value.direction ? value.direction : value);
    if (source && isFinite(Number(source.raDeg)) && isFinite(Number(source.decDeg))) {
      return GEOMETRY.unitFromRaDec(Number(source.raDeg), Number(source.decDeg));
    }
    const unit = GEOMETRY.normalize(source);
    if (!unit) throw new Error((label || 'direction') +
      ' must be a finite non-zero vector or RA/Dec point');
    return unit;
  }

  function uniqueFlag(flags, value) {
    if (flags.indexOf(value) < 0) flags.push(value);
  }

  function solverError(code, message) {
    const error = new Error(message);
    error.solverCode = code;
    return error;
  }

  function resolveInput(input) {
    if (!input || typeof input !== 'object') throw new Error('closest-approach input is required');
    const pass = input.pass && typeof input.pass === 'object' ? input.pass : input;
    const path = Array.isArray(input.path) ? input.path : pass.path;
    if (!Array.isArray(path) || !path.length) throw new Error('closest-approach path is required');
    if (typeof input.evaluate !== 'function' && typeof input.at !== 'function') {
      throw new Error('closest-approach evaluate(tMs) is required');
    }
    const star = input.star || input.candidate || input.starDirection;
    if (!star) throw new Error('closest-approach star direction is required');
    const startMs = input.startMs == null
      ? (pass.startMs == null ? null : pass.startMs) : input.startMs;
    const endMs = input.endMs == null
      ? (pass.endMs == null ? null : pass.endMs) : input.endMs;
    return {
      pass: pass,
      path: path,
      star: star,
      evaluate: input.evaluate || input.at,
      startMs: startMs,
      endMs: endMs,
    };
  }

  function resolveOptions(options) {
    const source = options || {};
    const timeToleranceMs = nonNegative(
      source.timeToleranceMs == null ? DEFAULTS.timeToleranceMs : source.timeToleranceMs,
      'timeToleranceMs');
    const coarseMarginArcsec = nonNegative(
      source.coarseMarginArcsec == null ? DEFAULTS.coarseMarginArcsec : source.coarseMarginArcsec,
      'coarseMarginArcsec');
    const unverifiedSelectionMarginArcsec = source.unverifiedSelectionMarginArcsec == null
      ? DEFAULTS.unverifiedSelectionMarginArcsec
      : nonNegative(source.unverifiedSelectionMarginArcsec, 'unverifiedSelectionMarginArcsec');
    const maxEvaluations = positiveInteger(
      source.maxEvaluations == null ? DEFAULTS.maxEvaluations : source.maxEvaluations,
      'maxEvaluations');
    const maxSegments = positiveInteger(
      source.maxSegments == null ? DEFAULTS.maxSegments : source.maxSegments,
      'maxSegments');
    const maxIterations = positiveInteger(
      source.maxIterations == null ? DEFAULTS.maxIterations : source.maxIterations,
      'maxIterations');
    if (!(timeToleranceMs > 0)) throw new Error('timeToleranceMs must be greater than zero');
    return {
      timeToleranceMs: timeToleranceMs,
      coarseMarginArcsec: coarseMarginArcsec,
      unverifiedSelectionMarginArcsec: unverifiedSelectionMarginArcsec,
      maxEvaluations: maxEvaluations,
      maxSegments: maxSegments,
      maxIterations: maxIterations,
    };
  }

  /** Copy and time-order a path without modifying the SatellitePass. */
  function normalizedPath(path) {
    const rows = path.map((row, index) => {
      if (!row || typeof row !== 'object') throw new Error('path[' + index + '] must be an object');
      const t = finiteNumber(row.t, 'path[' + index + '].t');
      return { t: t, vector: directionOf(row, 'path[' + index + ']'), sourceIndex: index };
    });
    rows.sort((a, b) => a.t - b.t || a.sourceIndex - b.sourceIndex);
    const unique = [];
    for (let i = 0; i < rows.length; i++) {
      if (unique.length && unique[unique.length - 1].t === rows[i].t) {
        unique[unique.length - 1] = rows[i];
      } else {
        unique.push(rows[i]);
      }
    }
    return unique;
  }

  function passTolerance(pass) {
    if (!pass || pass.pathMode !== 'adaptive' || pass.pathTruncated) return null;
    const value = Number(pass.pathToleranceArcsec);
    return isFinite(value) && value >= 0 ? value : null;
  }

  function baseResult(state, status, complete, flags, error) {
    const best = state.best;
    const coarse = state.coarseBest;
    const bracket = best && best.bracket ? best.bracket : null;
    const separation = best ? best.distanceArcsec : null;
    return {
      status: status,
      complete: complete,
      tCaMs: best ? best.t : null,
      nominalSeparationArcsec: separation,
      distanceArcsec: separation,
      closestVector: best ? best.vector : null,
      closestGeometry: best ? best.raw : null,
      coarseTMs: coarse ? coarse.t : null,
      coarseDistanceArcsec: coarse ? coarse.distanceArcsec : null,
      bracket: bracket,
      bracketWidthMs: bracket ? bracket.endMs - bracket.startMs : null,
      searchStartMs: state.startMs,
      searchEndMs: state.endMs,
      pathToleranceArcsec: state.pathToleranceArcsec,
      evaluations: state.evaluations,
      iterations: state.iterations,
      segmentsConsidered: state.segmentsConsidered,
      segmentsSelected: state.segmentsSelected,
      segmentsRefined: state.segmentsRefined,
      flags: flags.slice(),
      error: error ? String(error.message || error) : null,
    };
  }

  /**
   * Refine the closest approach between one catalogue star and one pass.
   *
   * Parameters
   * ----------
   * input : object
   *     `{pass, candidate, evaluate}`. `pass.path` is a time-ordered J2000
   *     polyline with UTC Unix-millisecond `t` values. `candidate` is the
   *     P0-05 star record or any `{raDeg, decDeg}`/unit-vector direction.
   *     `evaluate(tMs)` is a synchronous exact satellite-direction evaluator;
   *     it may return `{raDeg, decDeg}` or a unit vector and may include extra
   *     geometry fields that are returned as `closestGeometry`.
   * options : object, optional
   *     `timeToleranceMs` is the final bracket-width target. `coarseMarginArcsec`
   *     is an over-selection margin for geometric segment screening.
   *     `maxEvaluations`, `maxSegments`, and `maxIterations` bound work.
   *
   * Returns
   * -------
   * object
   *     On success, `{status: 'ok', complete: true, tCaMs,
   *     nominalSeparationArcsec, closestGeometry, bracket, flags}` plus
   *     diagnostic counts. `tCaMs` may be fractional milliseconds so a pure
   *     evaluator can demonstrate sub-millisecond numerical convergence.
   *     Evaluation failure or a work budget produces a partial result with
   *     `status: 'failed'` and `complete: false`; the best evaluated sample is
   *     retained when available.
   *
   * Equation
   * --------
   * The minimized objective is
   * `d(t) = atan2(|s(t) × q|, s(t) · q) * 206264.806247`, where `s(t)` is the
   * exact satellite unit direction and fixed catalogue direction `q` is in the
   * J2000 frame. Each selected time interval is minimized by a golden-section
   * search, which preserves a bracket for a unimodal local minimum.
   *
   * Notes
   * -----
   * `geometry.pathDistance(...).closestTMs` is only a piecewise-linear timing
   * diagnostic and is never used as the final answer. For an untruncated
   * adaptive path, a segment whose geometric distance is more than
   * `2 * pathToleranceArcsec + coarseMarginArcsec` above the best segment is
   * safely excluded by the spherical triangle inequality. Unverified or
   * truncated paths refine every available segment unless `maxSegments` is hit.
   * The solver assumes the exact separation has at most one relevant minimum
   * within each path segment; adaptive sampling is responsible for making that
   * local bracket sufficiently small for the physical trajectory.
   *
   * Raises
   * ------
   * Error
   *     If the input schema, direction, time interval, or numerical options are
   *     invalid. Runtime evaluator failures are returned as a failed result so
   *     one bad candidate need not abort a later pipeline.
   */
  function refine(input, options) {
    const resolved = resolveInput(input);
    const config = resolveOptions(options);
    const pass = resolved.pass;
    const path = normalizedPath(resolved.path);
    if (!path.length) throw new Error('closest-approach path has no valid samples');
    const starVector = directionOf(resolved.star, 'star direction');
    const startMs = resolved.startMs == null ? path[0].t : finiteNumber(resolved.startMs, 'startMs');
    const endMs = resolved.endMs == null ? path[path.length - 1].t : finiteNumber(resolved.endMs, 'endMs');
    if (endMs < startMs) throw new Error('endMs must be >= startMs');

    const flags = [];
    const state = {
      startMs: startMs,
      endMs: endMs,
      pathToleranceArcsec: passTolerance(pass),
      evaluations: 0,
      iterations: 0,
      segmentsConsidered: 0,
      segmentsSelected: 0,
      segmentsRefined: 0,
      best: null,
      coarseBest: null,
    };
    const cache = new Map();
    if (state.pathToleranceArcsec == null) uniqueFlag(flags, 'path-precision-unverified');
    if (pass.pathTruncated) uniqueFlag(flags, 'path-truncated');

    function consider(sample) {
      if (!state.best || sample.distanceArcsec < state.best.distanceArcsec ||
          (sample.distanceArcsec === state.best.distanceArcsec && sample.t < state.best.t)) {
        state.best = sample;
      }
    }

    function sampleAt(tMs) {
      const t = finiteNumber(tMs, 'evaluation time');
      if (cache.has(t)) return cache.get(t);
      if (state.evaluations >= config.maxEvaluations) {
        throw solverError('evaluation-budget', 'closest-approach evaluation budget exhausted');
      }
      let raw = null;
      try {
        raw = resolved.evaluate(t);
      } catch (error) {
        throw solverError('evaluation-failed', 'satellite direction evaluation failed: ' +
          String(error.message || error));
      }
      let vector = null;
      try { vector = directionOf(raw, 'evaluated satellite direction'); } catch (error) {
        throw solverError('evaluation-failed', 'satellite direction evaluation returned no valid direction');
      }
      const sample = {
        t: t,
        vector: vector,
        distanceArcsec: GEOMETRY.angularSeparationArcsec(vector, starVector),
        raw: raw,
        bracket: null,
      };
      state.evaluations++;
      cache.set(t, sample);
      consider(sample);
      return sample;
    }

    function workingPath() {
      const rows = path.filter((row) => row.t >= startMs && row.t <= endMs)
        .map((row) => ({ t: row.t, vector: row.vector, sourceIndex: row.sourceIndex }));
      function addBoundary(t, label) {
        if (rows.some((row) => row.t === t)) return;
        const sample = sampleAt(t);
        rows.push({ t: t, vector: sample.vector, sourceIndex: -1 });
        uniqueFlag(flags, label);
      }
      addBoundary(startMs, 'path-boundary-evaluated');
      addBoundary(endMs, 'path-boundary-evaluated');
      rows.sort((a, b) => a.t - b.t || a.sourceIndex - b.sourceIndex);
      return rows;
    }

    function segmentDescriptors(rows) {
      const segments = [];
      for (let i = 1; i < rows.length; i++) {
        if (!(rows[i].t > rows[i - 1].t)) continue;
        const geometric = GEOMETRY.segmentDistance(starVector, rows[i - 1].vector, rows[i].vector);
        const fraction = geometric.fraction == null ? 0.5 : geometric.fraction;
        const guessT = rows[i - 1].t + (rows[i].t - rows[i - 1].t) * fraction;
        segments.push({
          index: i - 1,
          startMs: rows[i - 1].t,
          endMs: rows[i].t,
          guessMs: guessT,
          geometric: geometric,
          distanceArcsec: geometric.distanceArcsec,
        });
      }
      return segments;
    }

    function minimizeSegment(segment) {
      let lo = segment.startMs;
      let hi = segment.endMs;
      let left = sampleAt(lo);
      let right = sampleAt(hi);
      let best = left.distanceArcsec <= right.distanceArcsec ? left : right;
      const guess = sampleAt(segment.guessMs);
      if (guess.distanceArcsec < best.distanceArcsec ||
          (guess.distanceArcsec === best.distanceArcsec && guess.t < best.t)) best = guess;
      if (hi === lo) {
        best.bracket = { startMs: lo, endMs: hi };
        return { best: best, iterations: 0, truncated: false };
      }

      let x1 = hi - GOLDEN_RATIO * (hi - lo);
      let x2 = lo + GOLDEN_RATIO * (hi - lo);
      let f1 = sampleAt(x1);
      let f2 = sampleAt(x2);
      if (f1.distanceArcsec < best.distanceArcsec ||
          (f1.distanceArcsec === best.distanceArcsec && f1.t < best.t)) best = f1;
      if (f2.distanceArcsec < best.distanceArcsec ||
          (f2.distanceArcsec === best.distanceArcsec && f2.t < best.t)) best = f2;

      let iterations = 0;
      while (hi - lo > config.timeToleranceMs && iterations < config.maxIterations) {
        iterations++;
        if (f1.distanceArcsec > f2.distanceArcsec) {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + GOLDEN_RATIO * (hi - lo);
          f2 = sampleAt(x2);
          if (f2.distanceArcsec < best.distanceArcsec ||
              (f2.distanceArcsec === best.distanceArcsec && f2.t < best.t)) best = f2;
        } else {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - GOLDEN_RATIO * (hi - lo);
          f1 = sampleAt(x1);
          if (f1.distanceArcsec < best.distanceArcsec ||
              (f1.distanceArcsec === best.distanceArcsec && f1.t < best.t)) best = f1;
        }
      }
      const midpoint = sampleAt((lo + hi) / 2);
      if (midpoint.distanceArcsec < best.distanceArcsec ||
          (midpoint.distanceArcsec === best.distanceArcsec && midpoint.t < best.t)) best = midpoint;
      best.bracket = { startMs: lo, endMs: hi };
      return {
        best: best,
        iterations: iterations,
        truncated: hi - lo > config.timeToleranceMs,
      };
    }

    try {
      const rows = workingPath();
      if (rows.length === 1) {
        const sample = sampleAt(rows[0].t);
        sample.bracket = { startMs: startMs, endMs: endMs };
        state.coarseBest = {
          t: sample.t, distanceArcsec: sample.distanceArcsec,
        };
        return baseResult(state, 'ok', true, flags, null);
      }
      const segments = segmentDescriptors(rows);
      state.segmentsConsidered = segments.length;
      if (!segments.length) throw solverError('no-segments', 'closest-approach path has no positive-time segment');

      let coarseSegment = null;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (!coarseSegment || segment.distanceArcsec < coarseSegment.distanceArcsec ||
            (segment.distanceArcsec === coarseSegment.distanceArcsec && segment.index < coarseSegment.index)) {
          coarseSegment = segment;
        }
      }
      state.coarseBest = {
        t: coarseSegment.guessMs,
        distanceArcsec: coarseSegment.distanceArcsec,
      };

      const tolerance = state.pathToleranceArcsec;
      const selectionMargin = tolerance == null
        ? config.unverifiedSelectionMarginArcsec : 2 * tolerance + config.coarseMarginArcsec;
      let selected = segments.filter((segment) =>
        segment.distanceArcsec <= coarseSegment.distanceArcsec + selectionMargin + ARCSEC_EPS);
      if (!selected.length) selected = [coarseSegment];
      if (selected.length > config.maxSegments) {
        selected.sort((a, b) => a.distanceArcsec - b.distanceArcsec || a.index - b.index);
        selected = selected.slice(0, config.maxSegments);
        uniqueFlag(flags, 'segment-budget');
      }
      state.segmentsSelected = selected.length;
      selected.sort((a, b) => a.startMs - b.startMs || a.index - b.index);
      for (let i = 0; i < selected.length; i++) {
        state.segmentsRefined++;
        const result = minimizeSegment(selected[i]);
        state.iterations += result.iterations;
        if (result.best.bracket && (!state.best || result.best.t === state.best.t)) {
          state.best = result.best;
        }
        if (result.truncated) uniqueFlag(flags, 'time-iteration-limit');
      }
      const complete = flags.indexOf('segment-budget') < 0 &&
        flags.indexOf('time-iteration-limit') < 0;
      return baseResult(state, complete ? 'ok' : 'failed', complete, flags, null);
    } catch (error) {
      if (error && error.solverCode === 'evaluation-failed') uniqueFlag(flags, 'evaluation-failed');
      else if (error && error.solverCode === 'evaluation-budget') uniqueFlag(flags, 'evaluation-budget');
      else if (error && error.solverCode === 'no-segments') uniqueFlag(flags, 'no-segments');
      else throw error;
      return baseResult(state, 'failed', false, flags, error);
    }
  }

  const API = {
    refine: refine,
    solve: refine,
  };

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.refine = API;
})();
