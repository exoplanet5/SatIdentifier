/* SAT.occultation.contact — angular-disc contact timing.
 *
 * Scientific responsibility: compare a fixed J2000 catalogue-star direction
 * with an exactly evaluated satellite direction and solve the times at which
 * their angular separation equals the satellite's apparent angular radius.
 * Stars are treated as point sources and the satellite as an opaque circular
 * disk. This module is pure: it does not propagate TLEs, access the catalogue,
 * publish event state, or draw a UI.
 *
 * CommonJS loading below is only a convenience for the focused Node harness;
 * the browser loads geometry.js and satellite-size.js before this file.
 */
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports &&
    typeof SAT !== 'undefined') {
  SAT.occultation = SAT.occultation || {};
  if (!SAT.occultation.geometry) require('./geometry.js');
  if (!SAT.occultation.satelliteSize) require('./satellite-size.js');
}
(function () {
  'use strict';

  const G = SAT.occultation.geometry;
  const SIZE = SAT.occultation.satelliteSize;
  const DEFAULTS = {
    sampleStepMs: 1000,
    timeToleranceMs: 1,
    maxEvaluations: 10000,
    maxSamples: 4096,
    maxIterations: 80,
    clearanceEpsilonArcsec: 1e-9,
  };

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  function positive(value, label) {
    const number = finiteNumber(value, label);
    if (!(number > 0)) throw new Error(label + ' must be greater than zero');
    return number;
  }

  function nonNegative(value, label) {
    const number = finiteNumber(value, label);
    if (number < 0) throw new Error(label + ' must be non-negative');
    return number;
  }

  function integerAtLeast(value, label) {
    const number = Math.floor(finiteNumber(value, label));
    if (number < 1) throw new Error(label + ' must be at least 1');
    return number;
  }

  function directionOf(value, label) {
    const source = value && value.vector ? value.vector
      : (value && value.direction ? value.direction : value);
    if (source && isFinite(Number(source.raDeg)) && isFinite(Number(source.decDeg))) {
      return G.unitFromRaDec(Number(source.raDeg), Number(source.decDeg));
    }
    const vector = G.normalize(source);
    if (!vector) throw new Error((label || 'direction') + ' must be a finite non-zero vector or RA/Dec point');
    return vector;
  }

  function uniqueFlag(flags, value) {
    if (flags.indexOf(value) < 0) flags.push(value);
  }

  function solverError(code, message) {
    const error = new Error(message);
    error.solverCode = code;
    return error;
  }

  function resolveOptions(options) {
    const source = options || {};
    const sampleStepMs = positive(
      source.sampleStepMs == null ? DEFAULTS.sampleStepMs : source.sampleStepMs,
      'sampleStepMs');
    const timeToleranceMs = positive(
      source.timeToleranceMs == null ? DEFAULTS.timeToleranceMs : source.timeToleranceMs,
      'timeToleranceMs');
    const maxSamples = integerAtLeast(
      source.maxSamples == null ? DEFAULTS.maxSamples : source.maxSamples, 'maxSamples');
    if (maxSamples < 2) throw new Error('maxSamples must be at least 2');
    return {
      sampleStepMs: sampleStepMs,
      timeToleranceMs: timeToleranceMs,
      maxEvaluations: integerAtLeast(
        source.maxEvaluations == null ? DEFAULTS.maxEvaluations : source.maxEvaluations,
        'maxEvaluations'),
      maxSamples: maxSamples,
      maxIterations: integerAtLeast(
        source.maxIterations == null ? DEFAULTS.maxIterations : source.maxIterations,
        'maxIterations'),
      clearanceEpsilonArcsec: nonNegative(
        source.clearanceEpsilonArcsec == null ? DEFAULTS.clearanceEpsilonArcsec
          : source.clearanceEpsilonArcsec, 'clearanceEpsilonArcsec'),
    };
  }

  function resolveInput(input) {
    if (!input || typeof input !== 'object') throw new Error('contact input is required');
    const pass = input.pass && typeof input.pass === 'object' ? input.pass : input;
    const evaluate = input.evaluate || input.at;
    if (typeof evaluate !== 'function') throw new Error('contact evaluate(tMs) is required');
    const star = input.star || input.candidate || input.starDirection;
    if (!star) throw new Error('contact star direction is required');
    const path = Array.isArray(input.path) ? input.path : pass.path;
    const pathStart = path && path.length ? Number(path[0].t) : null;
    const pathEnd = path && path.length ? Number(path[path.length - 1].t) : null;
    const startMs = input.startMs == null ? pass.startMs : input.startMs;
    const endMs = input.endMs == null ? pass.endMs : input.endMs;
    const start = startMs == null ? pathStart : finiteNumber(startMs, 'startMs');
    const end = endMs == null ? pathEnd : finiteNumber(endMs, 'endMs');
    if (!isFinite(start) || !isFinite(end)) throw new Error('contact startMs and endMs are required');
    if (end < start) throw new Error('endMs must be >= startMs');
    const requestedCa = input.tCaMs == null ? input.closestApproachMs : input.tCaMs;
    return {
      pass: pass,
      evaluate: evaluate,
      star: star,
      object: input.object || pass.object || null,
      startMs: start,
      endMs: end,
      tCaMs: requestedCa == null ? null : finiteNumber(requestedCa, 'tCaMs'),
    };
  }

  function sampleTimes(startMs, endMs, anchorMs, config, flags) {
    if (startMs === endMs) return [startMs];
    const span = endMs - startMs;
    const requested = Math.ceil(span / config.sampleStepMs) + 1;
    const count = Math.min(config.maxSamples, Math.max(2, requested));
    if (requested > config.maxSamples) uniqueFlag(flags, 'contact-sample-budget');
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(startMs + span * i / (count - 1));
    const anchor = Math.min(endMs, Math.max(startMs, anchorMs));
    let nearest = 0;
    for (let i = 1; i < rows.length; i++) {
      if (Math.abs(rows[i] - anchor) < Math.abs(rows[nearest] - anchor)) nearest = i;
    }
    rows[nearest] = anchor;
    rows.sort((a, b) => a - b);
    return rows.filter((time, index) => !index || time !== rows[index - 1]);
  }

  function emptyResult(radius, flags, state, status, complete, error) {
    const anchor = state.anchorMs;
    const ca = state.samples.find((row) => row.t === anchor) || null;
    return {
      status: status,
      complete: complete,
      contact: status === 'contact' || status === 'grazing',
      tCaMs: anchor,
      closestSeparationArcsec: ca ? ca.separationArcsec : null,
      clearanceArcsecAtCa: ca ? ca.clearanceArcsec : null,
      radiusM: radius ? radius.radiusM : null,
      radiusSource: radius ? radius.source : null,
      angularRadiusArcsecAtCa: ca ? ca.angularRadiusArcsec : null,
      angularDiameterArcsecAtCa: ca ? 2 * ca.angularRadiusArcsec : null,
      angularRadiusArcsec: ca ? ca.angularRadiusArcsec : null,
      angularDiameterArcsec: ca ? 2 * ca.angularRadiusArcsec : null,
      ingressMs: null,
      egressMs: null,
      durationMs: null,
      ingressBracket: null,
      egressBracket: null,
      intervals: state.intervals || [],
      evaluations: state.evaluations,
      samples: state.samples.length,
      roots: state.roots,
      searchStartMs: state.startMs,
      searchEndMs: state.endMs,
      flags: flags.slice(),
      error: error ? String(error.message || error) : null,
    };
  }

  /**
   * Solve opaque-disc ingress and egress around a P0-08 closest approach.
   *
   * Parameters
   * ----------
   * input : object
   *     `{pass, candidate, evaluate, tCaMs, object}`. Times are UTC Unix
   *     milliseconds. `evaluate(tMs)` must return finite J2000 `raDeg` and
   *     `decDeg`, plus `rangeKm` in topocentric kilometres. The fixed catalogue
   *     star is a point source in the same J2000 frame.
   * options : object, optional
   *     Contact search options and the size-model options documented by
   *     `satelliteSize.resolve()`. `sampleStepMs`, `timeToleranceMs`,
   *     `maxEvaluations`, `maxSamples`, and `maxIterations` bound the numerical
   *     work. The default radius is an explicit 1 m prior and is flagged.
   *
   * Returns
   * -------
   * object
   *     A JSON-safe result with `status` equal to `miss`, `grazing`, `contact`,
   *     or `failed`. `ingressMs` and `egressMs` are UTC milliseconds with their
   *     final root brackets; `durationMs` is their difference. `radiusM` is the
   *     effective radius in metres and angular-size fields are arcseconds.
   *     `complete` means the selected radius model and all required evaluator
   *     samples were solved within their budgets; a `miss` is a complete result
   *     under that model, not a probability statement.
   *
   * Equation
   * --------
   * At time t, contact is defined by
   * `d(t) <= alpha(t)`, where d is the exact star/satellite angular separation
   * and `alpha(t) = asin(r / R(t))` is the satellite angular radius. `r` is the
   * effective physical radius in kilometres and R is the topocentric range in
   * kilometres. The reported roots solve `f(t) = alpha(t) - d(t) = 0` by
   * bisection after a bounded millisecond-scale scan.
   *
   * Notes
   * -----
   * A point-source star and circular opaque satellite are deliberate P0-09
   * approximations. The result is geometric contact under the selected size
   * prior; it does not include stellar angular diameter, attitude-dependent
   * spacecraft shape, TLE uncertainty, atmospheric seeing, probability, or
   * event ranking. Contact intervals clipped by the pass bounds are disclosed.
   * Inputs are never mutated.
   */
  function solve(input, options) {
    const resolved = resolveInput(input);
    const config = resolveOptions(options);
    const starVector = directionOf(resolved.star, 'contact star direction');
    const radius = SIZE.resolve(resolved.object, options);
    const flags = radius.flags.slice();
    const anchor = resolved.tCaMs == null
      ? (resolved.startMs + resolved.endMs) / 2
      : Math.min(resolved.endMs, Math.max(resolved.startMs, resolved.tCaMs));
    if (resolved.tCaMs == null) uniqueFlag(flags, 'closest-time-missing');
    else if (resolved.tCaMs !== anchor) uniqueFlag(flags, 'closest-time-clipped');
    const state = {
      startMs: resolved.startMs, endMs: resolved.endMs, anchorMs: anchor,
      samples: [], intervals: [], evaluations: 0, roots: 0,
    };
    if (!radius.radiusM) {
      return emptyResult(radius, flags, state, 'failed', false,
        new Error('no effective satellite radius is available'));
    }

    const cache = new Map();
    function sampleAt(tMs) {
      const t = finiteNumber(tMs, 'evaluation time');
      if (cache.has(t)) return cache.get(t);
      if (state.evaluations >= config.maxEvaluations) {
        throw solverError('evaluation-budget', 'contact evaluation budget exhausted');
      }
      let raw;
      try { raw = resolved.evaluate(t); } catch (error) {
        throw solverError('evaluation-failed', 'contact direction evaluation failed: ' +
          String(error.message || error));
      }
      if (!raw || !isFinite(Number(raw.rangeKm)) || !(Number(raw.rangeKm) > 0)) {
        throw solverError('range-unavailable', 'contact evaluator must return positive rangeKm');
      }
      let vector;
      try { vector = directionOf(raw, 'evaluated satellite direction'); } catch (error) {
        throw solverError('evaluation-failed', 'contact evaluator returned no valid direction');
      }
      let angularRadius;
      try { angularRadius = SIZE.angularRadiusArcsec(radius.radiusM, Number(raw.rangeKm)); }
      catch (error) { throw solverError('range-unavailable', error.message); }
      const separation = G.angularSeparationArcsec(vector, starVector);
      const row = {
        t: t,
        rangeKm: Number(raw.rangeKm),
        separationArcsec: separation,
        angularRadiusArcsec: angularRadius,
        clearanceArcsec: angularRadius - separation,
        raw: raw,
      };
      state.evaluations++;
      cache.set(t, row);
      return row;
    }

    function rootBetween(first, second) {
      if (first.clearanceArcsec === 0) return { timeMs: first.t, bracket: { startMs: first.t, endMs: first.t } };
      if (second.clearanceArcsec === 0) return { timeMs: second.t, bracket: { startMs: second.t, endMs: second.t } };
      let left = first;
      let right = second;
      let iterations = 0;
      while (right.t - left.t > config.timeToleranceMs && iterations < config.maxIterations) {
        iterations++;
        const middle = sampleAt((left.t + right.t) / 2);
        if ((left.clearanceArcsec >= 0) === (middle.clearanceArcsec >= 0)) left = middle;
        else right = middle;
      }
      if (right.t - left.t > config.timeToleranceMs) uniqueFlag(flags, 'contact-time-iteration-limit');
      state.roots++;
      return {
        timeMs: (left.t + right.t) / 2,
        bracket: { startMs: left.t, endMs: right.t },
      };
    }

    function searchComplete() {
      return flags.indexOf('contact-sample-budget') < 0 &&
        flags.indexOf('contact-time-iteration-limit') < 0 &&
        flags.indexOf('closest-time-missing') < 0;
    }

    try {
      const times = sampleTimes(resolved.startMs, resolved.endMs, anchor, config, flags);
      state.samples = times.map(sampleAt).sort((a, b) => a.t - b.t);
      const eps = config.clearanceEpsilonArcsec;
      let run = null;
      const runs = [];
      state.samples.forEach((row, index) => {
        const inside = row.clearanceArcsec >= -eps;
        if (inside && !run) run = { startIndex: index, endIndex: index };
        else if (inside && run) run.endIndex = index;
        else if (run) { runs.push(run); run = null; }
      });
      if (run) runs.push(run);
      state.intervals = runs.map((candidateRun) => {
        const first = state.samples[candidateRun.startIndex];
        const last = state.samples[candidateRun.endIndex];
        const entry = candidateRun.startIndex === 0
          ? { timeMs: resolved.startMs, bracket: null, clipped: true }
          : Object.assign(rootBetween(state.samples[candidateRun.startIndex - 1], first), { clipped: false });
        const exit = candidateRun.endIndex === state.samples.length - 1
          ? { timeMs: resolved.endMs, bracket: null, clipped: true }
          : Object.assign(rootBetween(last, state.samples[candidateRun.endIndex + 1]), { clipped: false });
        if (entry.clipped) uniqueFlag(flags, 'contact-clipped-start');
        if (exit.clipped) uniqueFlag(flags, 'contact-clipped-end');
        return {
          ingressMs: entry.timeMs, egressMs: exit.timeMs,
          durationMs: Math.max(0, exit.timeMs - entry.timeMs),
          ingressBracket: entry.bracket, egressBracket: exit.bracket,
        };
      });
      if (state.intervals.length > 1) uniqueFlag(flags, 'multiple-contact-intervals');
      if (!state.intervals.length) {
        return emptyResult(radius, flags, state, 'miss', searchComplete(), null);
      }
      const selected = state.intervals.slice().sort((a, b) => {
        const ain = anchor >= a.ingressMs && anchor <= a.egressMs;
        const bin = anchor >= b.ingressMs && anchor <= b.egressMs;
        return (bin - ain) || (Math.abs((a.ingressMs + a.egressMs) / 2 - anchor) -
          Math.abs((b.ingressMs + b.egressMs) / 2 - anchor));
      })[0];
      const result = emptyResult(radius, flags,
        Object.assign(state, { intervals: state.intervals }),
        selected.durationMs <= config.timeToleranceMs ? 'grazing' : 'contact',
        searchComplete(), null);
      result.ingressMs = selected.ingressMs;
      result.egressMs = selected.egressMs;
      result.durationMs = selected.durationMs;
      result.ingressBracket = selected.ingressBracket;
      result.egressBracket = selected.egressBracket;
      return result;
    } catch (error) {
      if (error && error.solverCode === 'evaluation-budget') uniqueFlag(flags, 'contact-evaluation-budget');
      else if (error && error.solverCode === 'evaluation-failed') uniqueFlag(flags, 'contact-evaluation-failed');
      else if (error && error.solverCode === 'range-unavailable') uniqueFlag(flags, 'range-unavailable');
      else throw error;
      return emptyResult(radius, flags, state, 'failed', false, error);
    }
  }

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.contact = {
    solve: solve,
    calculate: solve,
    resolveOptions: resolveOptions,
    angularRadiusArcsec: SIZE.angularRadiusArcsec,
    angularDiameterArcsec: SIZE.angularDiameterArcsec,
  };
})();
