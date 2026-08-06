/* SAT.occultation.adaptivePath — bounded, spherical satellite-path refinement.
 *
 * Scientific responsibility: replace the worker's display path with a J2000
 * polyline whose piecewise great-circle interpolation has a measured angular
 * residual below the requested tolerance. This module does not propagate TLEs,
 * search for stars, refine a stellar closest approach, or write application
 * state. The caller supplies the propagation-backed direction evaluator.
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const ARCSEC_PER_RAD = R2D * 3600;
  const DEFAULT_TOLERANCE_ARCSEC = 1;
  const DEFAULT_MAX_SAMPLES = 4096;
  const MAX_DEPTH = 32;
  const SAFETY_FACTOR = 0.8;
  const PROBE_FRACTIONS = [0.125, 0.25, 0.5, 0.75, 0.875];

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  function wrap360(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function normalizeVector(vector) {
    const norm = Math.hypot(vector.x, vector.y, vector.z);
    if (!(norm > 0) || !isFinite(norm)) return null;
    return { x: vector.x / norm, y: vector.y / norm, z: vector.z / norm };
  }

  function directionOf(point) {
    if (!point || !isFinite(Number(point.raDeg)) || !isFinite(Number(point.decDeg))) {
      return null;
    }
    const ra = Number(point.raDeg) * D2R;
    const dec = Number(point.decDeg) * D2R;
    const cosDec = Math.cos(dec);
    return normalizeVector({
      x: cosDec * Math.cos(ra),
      y: cosDec * Math.sin(ra),
      z: Math.sin(dec),
    });
  }

  function publicPoint(t, vector) {
    const ra = Math.atan2(vector.y, vector.x) * R2D;
    return {
      t: Math.round(t),
      raDeg: wrap360(ra),
      decDeg: Math.asin(clamp(vector.z, -1, 1)) * R2D,
    };
  }

  function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  function cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  /** Return the angular separation between two unit vectors in arcseconds. */
  function angularSeparationArcsec(a, b) {
    const c = cross(a, b);
    return Math.atan2(Math.hypot(c.x, c.y, c.z), clamp(dot(a, b), -1, 1)) * ARCSEC_PER_RAD;
  }

  function orthogonalUnit(vector) {
    const axis = Math.abs(vector.x) <= Math.abs(vector.y) && Math.abs(vector.x) <= Math.abs(vector.z)
      ? { x: 1, y: 0, z: 0 }
      : (Math.abs(vector.y) <= Math.abs(vector.z)
        ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 });
    return normalizeVector(cross(vector, axis));
  }

  /** Spherical linear interpolation between two unit directions. */
  function slerp(a, b, fraction) {
    let cosine = clamp(dot(a, b), -1, 1);
    if (cosine > 0.999999999) {
      return normalizeVector({
        x: a.x + fraction * (b.x - a.x),
        y: a.y + fraction * (b.y - a.y),
        z: a.z + fraction * (b.z - a.z),
      });
    }
    if (cosine < -0.999999999) {
      const perpendicular = orthogonalUnit(a);
      const angle = Math.PI * fraction;
      return normalizeVector({
        x: Math.cos(angle) * a.x + Math.sin(angle) * perpendicular.x,
        y: Math.cos(angle) * a.y + Math.sin(angle) * perpendicular.y,
        z: Math.cos(angle) * a.z + Math.sin(angle) * perpendicular.z,
      });
    }
    const angle = Math.acos(cosine);
    const denominator = Math.sin(angle);
    return normalizeVector({
      x: (Math.sin((1 - fraction) * angle) * a.x + Math.sin(fraction * angle) * b.x) / denominator,
      y: (Math.sin((1 - fraction) * angle) * a.y + Math.sin(fraction * angle) * b.y) / denominator,
      z: (Math.sin((1 - fraction) * angle) * a.z + Math.sin(fraction * angle) * b.z) / denominator,
    });
  }

  function validSeed(point, lo, hi) {
    return point && isFinite(Number(point.t)) && Number(point.t) >= lo && Number(point.t) <= hi &&
      directionOf(point);
  }

  function normalizedSeed(path, startMs, endMs, anchorTimes) {
    const byTime = new Map();
    const add = (point) => {
      if (!validSeed(point, startMs, endMs)) return;
      const t = Math.round(Number(point.t));
      if (!byTime.has(t)) {
        byTime.set(t, { t: t, raDeg: Number(point.raDeg), decDeg: Number(point.decDeg) });
      }
    };
    (Array.isArray(path) ? path : []).forEach(add);
    [startMs, endMs].concat(Array.isArray(anchorTimes) ? anchorTimes : []).forEach((t) => {
      const number = Math.round(Number(t));
      if (!isFinite(number) || number < startMs || number > endMs || byTime.has(number)) return;
      // A valid direction is supplied later by the evaluator. This placeholder
      // keeps the timestamp in the seed set without inventing a sky position.
      byTime.set(number, { t: number, raDeg: NaN, decDeg: NaN });
    });
    return Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  }

  function resolveOptions(options) {
    const o = options || {};
    const toleranceArcsec = finiteNumber(
      o.toleranceArcsec == null ? DEFAULT_TOLERANCE_ARCSEC : o.toleranceArcsec,
      'path toleranceArcsec');
    const maxSamples = Math.floor(finiteNumber(
      o.maxSamples == null ? DEFAULT_MAX_SAMPLES : o.maxSamples,
      'path maxSamples'));
    if (!(toleranceArcsec > 0)) throw new Error('path toleranceArcsec must be greater than zero');
    if (maxSamples < 2) throw new Error('path maxSamples must be at least 2');
    return { toleranceArcsec: toleranceArcsec, maxSamples: maxSamples };
  }

  function boundedSeed(seed, maxSamples) {
    const valid = seed.filter((point) => isFinite(point.raDeg) && isFinite(point.decDeg));
    if (valid.length <= maxSamples) return { path: valid, truncated: false };
    const kept = [];
    for (let i = 0; i < maxSamples; i++) {
      const index = Math.round(i * (valid.length - 1) / (maxSamples - 1));
      if (!kept.length || kept[kept.length - 1].t !== valid[index].t) kept.push(valid[index]);
    }
    return { path: kept, truncated: true };
  }

  function fallback(seed, reason, maxSamples) {
    const bounded = boundedSeed(seed, maxSamples == null ? DEFAULT_MAX_SAMPLES : maxSamples);
    return {
      path: bounded.path
        .map((point) => ({ t: point.t, raDeg: wrap360(point.raDeg), decDeg: point.decDeg })),
      pathMode: 'raw-worker',
      pathToleranceArcsec: null,
      pathTruncated: bounded.truncated,
      pathWorstErrorArcsec: null,
      reason: reason,
    };
  }

  /** Refine a raw-worker path against a caller-supplied exact direction function.
   *
   * Parameters
   * ----------
   * input : object
   *     `{path, startMs, endMs, evaluate, anchorTimes}`. `path` is an array of
   *     J2000 direction samples `{t, raDeg, decDeg}`, with `t` in UTC Unix ms.
   *     `evaluate(tMs)` must synchronously return a J2000 `{raDeg, decDeg}` at
   *     the requested UTC millisecond, or `null` when propagation fails.
   *     `anchorTimes` are optional UTC-ms timestamps that must remain in the
   *     seed set, for example a pass culmination.
   * options : object
   *     `toleranceArcsec` is the requested maximum angular interpolation error;
   *     `maxSamples` bounds the returned polyline length.
   *
   * Returns
   * -------
   * object
   *     `{path, pathMode, pathToleranceArcsec, pathTruncated,
   *     pathWorstErrorArcsec}`. `pathWorstErrorArcsec` is the largest sampled
   *     residual between exact directions and the great-circle interpolation
   *     between retained endpoints. When the exact evaluator is unavailable,
   *     the raw-worker path is returned with `pathMode: 'raw-worker'` because
   *     no error claim can be made.
   *
   * Equation
   * --------
   * For a probe fraction `f` in a segment `[u_a, u_b]`, the reference direction
   * is spherical linear interpolation `slerp(u_a, u_b, f)`. The measured error is
   * `epsilon = acos(u_true · u_slerp)` in arcseconds. A segment is accepted when
   * every probe has `epsilon <= 0.8 * toleranceArcsec`; the safety factor leaves
   * headroom for the unprobed interior when the caller performs dense validation.
   *
   * Notes
   * -----
   * This is an adaptive representation error bound, not a TLE uncertainty bound.
   * Integer UTC milliseconds are the output grid. If `maxSamples` or the
   * recursion depth prevents further subdivision, `pathTruncated` is true and
   * the requested tolerance is not claimed.
   */
  function refine(input, options) {
    if (!input || typeof input !== 'object') throw new Error('adaptive path input is required');
    const startMs = Math.round(finiteNumber(input.startMs, 'path startMs'));
    const endMs = Math.round(finiteNumber(input.endMs, 'path endMs'));
    if (endMs < startMs) throw new Error('path endMs must be >= startMs');
    const resolved = resolveOptions(options);
    const evaluate = typeof input.evaluate === 'function' ? input.evaluate : input.at;
    const seed = normalizedSeed(input.path || input.seedPath, startMs, endMs, input.anchorTimes);
    if (typeof evaluate !== 'function') return fallback(seed, 'missing-evaluator', resolved.maxSamples);

    const seedByTime = new Map(seed.map((point) => [point.t, point]));
    const cache = new Map();
    let unverified = false;

    function sampleAt(t, allowSeed) {
      const key = Math.round(t);
      if (cache.has(key)) return cache.get(key);
      let exact = null;
      try { exact = evaluate(key); } catch (error) { exact = null; }
      const direction = directionOf(exact);
      let result = null;
      if (direction) {
        result = { t: key, raDeg: Number(exact.raDeg), decDeg: Number(exact.decDeg),
          vector: direction, verified: true };
      } else if (allowSeed && seedByTime.has(key) && directionOf(seedByTime.get(key))) {
        const point = seedByTime.get(key);
        result = { t: key, raDeg: point.raDeg, decDeg: point.decDeg,
          vector: directionOf(point), verified: false };
      }
      cache.set(key, result);
      return result;
    }

    const retained = [];
    const retainedTimes = new Set();
    for (let i = 0; i < seed.length; i++) {
      const sample = sampleAt(seed[i].t, true);
      if (!sample) return fallback(seed, 'endpoint-evaluation-failed', resolved.maxSamples);
      if (!sample.verified) unverified = true;
      retained.push(sample);
      retainedTimes.add(sample.t);
    }
    if (unverified) return fallback(seed, 'seed-evaluation-unverified', resolved.maxSamples);

    // With a zero-length pass there is no segment to approximate. The exact
    // direction is still returned as a one-point adaptive path.
    if (retained.length < 2 || endMs === startMs) {
      return {
        path: retained.map((point) => publicPoint(point.t, point.vector)),
        pathMode: 'adaptive', pathToleranceArcsec: resolved.toleranceArcsec,
        pathTruncated: false, pathWorstErrorArcsec: 0,
      };
    }

    let pathTruncated = retained.length > resolved.maxSamples;
    let worstErrorArcsec = 0;
    const threshold = resolved.toleranceArcsec * SAFETY_FACTOR;

    // A raw worker path is at most 64 points. If a caller deliberately chooses
    // a smaller budget, keep the endpoints and evenly spaced seed times so the
    // returned object still satisfies the advertised maximum length.
    if (retained.length > resolved.maxSamples) {
      const kept = [];
      for (let i = 0; i < resolved.maxSamples; i++) {
        const index = Math.round(i * (retained.length - 1) / (resolved.maxSamples - 1));
        if (!kept.length || kept[kept.length - 1].t !== retained[index].t) kept.push(retained[index]);
      }
      retained.length = 0;
      kept.forEach((point) => retained.push(point));
      retainedTimes.clear();
      retained.forEach((point) => retainedTimes.add(point.t));
    }

    function inspect(a, b) {
      const probes = [];
      for (let i = 0; i < PROBE_FRACTIONS.length; i++) {
        const fraction = PROBE_FRACTIONS[i];
        const t = Math.round(a.t + (b.t - a.t) * fraction);
        if (t <= a.t || t >= b.t || probes.some((point) => point.t === t)) continue;
        const sample = sampleAt(t, false);
        if (!sample) return null;
        const reference = slerp(a.vector, b.vector, fractionForTime(a.t, b.t, t));
        const error = reference ? angularSeparationArcsec(sample.vector, reference) : Infinity;
        probes.push({ sample: sample, error: error });
      }
      let maxError = 0;
      for (let i = 0; i < probes.length; i++) if (probes[i].error > maxError) maxError = probes[i].error;
      return { maxError: maxError };
    }

    function fractionForTime(a, b, t) {
      return b === a ? 0.5 : (t - a) / (b - a);
    }

    function refineSegment(a, b, depth) {
      const inspection = inspect(a, b);
      if (!inspection) {
        unverified = true;
        pathTruncated = true;
        return [a, b];
      }
      if (inspection.maxError <= threshold) {
        if (inspection.maxError > worstErrorArcsec) worstErrorArcsec = inspection.maxError;
        return [a, b];
      }
      if (retainedTimes.size >= resolved.maxSamples || depth >= MAX_DEPTH || b.t - a.t <= 1) {
        pathTruncated = true;
        if (inspection.maxError > worstErrorArcsec) worstErrorArcsec = inspection.maxError;
        return [a, b];
      }
      const midT = Math.round((a.t + b.t) / 2);
      if (midT <= a.t || midT >= b.t) {
        pathTruncated = true;
        return [a, b];
      }
      const midpoint = sampleAt(midT, false);
      if (!midpoint) {
        unverified = true;
        pathTruncated = true;
        if (inspection.maxError > worstErrorArcsec) worstErrorArcsec = inspection.maxError;
        return [a, b];
      }
      retainedTimes.add(midpoint.t);
      const left = refineSegment(a, midpoint, depth + 1);
      const right = refineSegment(midpoint, b, depth + 1);
      return left.slice(0, -1).concat(right);
    }

    let output = [];
    for (let i = 1; i < retained.length; i++) {
      const segment = refineSegment(retained[i - 1], retained[i], 0);
      if (!output.length) output = segment;
      else output = output.slice(0, -1).concat(segment);
    }
    if (!output.length) output = retained.slice();
    if (unverified) return fallback(seed, 'interior-evaluation-failed', resolved.maxSamples);

    return {
      path: output.map((point) => publicPoint(point.t, point.vector)),
      pathMode: 'adaptive',
      pathToleranceArcsec: resolved.toleranceArcsec,
      pathTruncated: pathTruncated,
      pathWorstErrorArcsec: isFinite(worstErrorArcsec) ? worstErrorArcsec : null,
    };
  }

  const API = {
    refine: refine,
    build: refine,
    angularSeparationArcsec: angularSeparationArcsec,
    slerp: slerp,
  };

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.adaptivePath = API;
})();
