/* SAT.occultation.passes — nightly raw-scan orchestration and pass contracts.
 *
 * Scientific responsibility: turn one or more NightWindow intervals into the
 * existing worker scan's zenith-field parameters, then normalize each returned
 * Crossing into a SatellitePass. This module does not search for stars, refine
 * star closest approach, assign probability, rank events, or write UI/state data.
 */
// The browser entry point loads adaptive-path.js explicitly before this file.
// This CommonJS-only convenience keeps standalone Node contract harnesses that
// require passes.js directly on the same production dependency boundary.
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports &&
    typeof SAT !== 'undefined') {
  SAT.occultation = SAT.occultation || {};
  if (!SAT.occultation.adaptivePath) require('./adaptive-path.js');
}
(function () {
  'use strict';

  const MINUTE_MS = 60000;
  const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
  const CULMINATION_ITERATIONS = 18;
  const ORBIT_CLASSES = new Set(['leo', 'meo', 'geo', 'heo']);
  const DEFAULTS = {
    sunAltitudeLimitDeg: -12,
    minimumElevationDeg: 20,
    coarseStepS: 30,
    fineStepS: 1,
    marginDeg: 0,
    pathToleranceArcsec: 1,
    pathMaxSamples: 4096,
    // Exact culmination/adaptive-path work is expensive when a whole night and
    // the full catalogue produce tens of thousands of raw crossings. Small runs
    // keep the P0-04 representation; large runs retain the worker path and expose
    // the deferred representation as an explicit partial-search condition.
    exactPassLimit: 2000,
    deferExactPasses: true,
    // A deferred full-night run keeps only a compact worker path. Eight samples
    // preserve the temporal shape needed by that raw representation while
    // halving the transient postMessage payload relative to the old 16-sample
    // cap. Exact small runs still use the adaptive path below.
    workerPathMaxSamples: 8,
    maxResults: 100000,
    refraction: false,
    dut1S: 0,
  };

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  function integerMs(value, label) {
    const number = finiteNumber(value, label);
    return Math.round(number);
  }

  function filterValues(input, key, aliases) {
    const sources = [];
    if (input && input.satelliteFilters && typeof input.satelliteFilters === 'object') {
      sources.push(input.satelliteFilters);
    }
    if (input && input.passOptions && typeof input.passOptions === 'object') {
      sources.push(input.passOptions);
    }
    if (input && input.passes && typeof input.passes === 'object' && !Array.isArray(input.passes)) {
      sources.push(input.passes);
    }
    if (input && input.filters && typeof input.filters === 'object') sources.push(input.filters);
    if (input && typeof input === 'object') sources.push(input);
    const names = [key].concat(aliases || []);
    for (let i = 0; i < sources.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (Object.prototype.hasOwnProperty.call(sources[i], names[j])) {
          const value = sources[i][names[j]];
          if (value == null) return null;
          let values = value;
          if (!Array.isArray(values)) {
            if (typeof values === 'object') {
              values = Object.keys(values).filter((name) => values[name]);
            } else {
              values = String(values).split(/[\s,]+/);
            }
          }
          return values.map((item) => String(item).trim()).filter(Boolean);
        }
      }
    }
    return null;
  }

  function typeOf(crossing, obj) {
    const value = crossing && crossing.type != null ? crossing.type : obj && obj.type;
    const type = value == null ? '' : String(value).trim().toUpperCase();
    return type === 'PAY' || type === 'R/B' || type === 'DEB' ? type : 'UNK';
  }

  function classOf(crossing, obj) {
    const value = crossing && (crossing.cls != null ? crossing.cls : crossing.orbitClass != null
      ? crossing.orbitClass : null);
    const fallback = value == null && obj ? obj.cls : value;
    const cls = fallback == null ? '' : String(fallback).trim().toLowerCase();
    return ORBIT_CLASSES.has(cls) ? cls : null;
  }

  function normaliseClass(value) {
    const cls = String(value == null ? '' : value).trim().toLowerCase();
    return ORBIT_CLASSES.has(cls) ? cls : null;
  }

  function normaliseType(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (raw === 'pay' || raw === 'payload') return 'PAY';
    if (raw === 'r/b' || raw === 'rocket body' || raw === 'rocket-body') return 'R/B';
    if (raw === 'deb' || raw === 'debris') return 'DEB';
    if (raw === 'unk' || raw === 'unknown') return 'UNK';
    return null;
  }

  function splitTags(values) {
    const classes = [], types = [];
    (Array.isArray(values) ? values : []).forEach((value) => {
      const cls = normaliseClass(value), type = normaliseType(value);
      if (cls && classes.indexOf(cls) < 0) classes.push(cls);
      if (type && types.indexOf(type) < 0) types.push(type);
    });
    return { classes: classes.length ? classes : null, types: types.length ? types : null };
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  function siteOf(input) {
    const source = input && input.site ? input.site : input;
    if (!source || typeof source !== 'object') {
      throw new Error('passes require a ground site with latDeg and lonDeg');
    }
    if ((source.kind || 'ground') === 'orbit') {
      throw new Error('occultation passes require a ground observing site; orbit sites are unsupported');
    }
    const latDeg = finiteNumber(source.latDeg, 'site.latDeg');
    const lonDeg = finiteNumber(source.lonDeg, 'site.lonDeg');
    const altM = source.altM == null ? 0 : finiteNumber(source.altM, 'site.altM');
    if (latDeg < -90 || latDeg > 90) throw new Error('site.latDeg must be in [-90, 90]');
    if (lonDeg < -180 || lonDeg > 180) throw new Error('site.lonDeg must be in [-180, 180]');
    return { kind: 'ground', latDeg: latDeg, lonDeg: lonDeg, altM: altM };
  }

  function resolvedInput(input) {
    if (!input || typeof input !== 'object') throw new Error('pass parameters are required');
    const steps = input.steps || {};
    const site = siteOf(input);
    const sunAltitudeLimitDeg = finiteNumber(
      input.sunAltitudeLimitDeg == null
        ? (input.twilightDeg == null ? DEFAULTS.sunAltitudeLimitDeg : input.twilightDeg)
        : input.sunAltitudeLimitDeg,
      'sunAltitudeLimitDeg');
    const minimumElevationDeg = finiteNumber(
      input.minimumElevationDeg == null
        ? (input.minElDeg == null ? DEFAULTS.minimumElevationDeg : input.minElDeg)
        : input.minimumElevationDeg,
      'minimumElevationDeg');
    const coarseStepS = finiteNumber(
      input.coarseStepS == null ? (steps.coarseStepS == null ? DEFAULTS.coarseStepS : steps.coarseStepS) : input.coarseStepS,
      'coarseStepS');
    const fineStepS = finiteNumber(
      input.fineStepS == null ? (steps.fineStepS == null ? DEFAULTS.fineStepS : steps.fineStepS) : input.fineStepS,
      'fineStepS');
    const marginDeg = finiteNumber(
      input.marginDeg == null ? (steps.marginDeg == null ? DEFAULTS.marginDeg : steps.marginDeg) : input.marginDeg,
      'marginDeg');
    const pathOptions = input.path && typeof input.path === 'object' ? input.path : {};
    const pathToleranceArcsec = finiteNumber(
      input.pathToleranceArcsec == null
        ? (pathOptions.toleranceArcsec == null ? DEFAULTS.pathToleranceArcsec : pathOptions.toleranceArcsec)
        : input.pathToleranceArcsec,
      'pathToleranceArcsec');
    const pathMaxSamples = Math.floor(finiteNumber(
      input.pathMaxSamples == null
        ? (input.maxPathSamples == null
          ? (pathOptions.maxSamples == null ? DEFAULTS.pathMaxSamples : pathOptions.maxSamples)
          : input.maxPathSamples)
      : input.pathMaxSamples,
      'pathMaxSamples'));
    const exactPassLimit = Math.floor(finiteNumber(
      input.exactPassLimit == null ? DEFAULTS.exactPassLimit : input.exactPassLimit,
      'exactPassLimit'));
    const workerPathMaxSamples = Math.floor(finiteNumber(
      input.workerPathMaxSamples == null ? DEFAULTS.workerPathMaxSamples : input.workerPathMaxSamples,
      'workerPathMaxSamples'));
    const maxResults = Math.floor(finiteNumber(
      input.maxResults == null ? DEFAULTS.maxResults : input.maxResults, 'maxResults'));
    const dut1S = finiteNumber(input.dut1S == null ? DEFAULTS.dut1S : input.dut1S, 'dut1S');
    if (sunAltitudeLimitDeg < -90 || sunAltitudeLimitDeg > 90) {
      throw new Error('sunAltitudeLimitDeg must be in [-90, 90]');
    }
    if (minimumElevationDeg < 0 || minimumElevationDeg > 90) {
      throw new Error('minimumElevationDeg must be in [0, 90]');
    }
    if (!(coarseStepS > 0) || !(fineStepS > 0)) {
      throw new Error('coarseStepS and fineStepS must be greater than zero');
    }
    if (marginDeg < 0) throw new Error('marginDeg must be non-negative');
    if (!(pathToleranceArcsec > 0)) throw new Error('pathToleranceArcsec must be greater than zero');
    if (pathMaxSamples < 2) throw new Error('pathMaxSamples must be at least 2');
    if (exactPassLimit < 0) throw new Error('exactPassLimit must be non-negative');
    if (workerPathMaxSamples < 2) throw new Error('workerPathMaxSamples must be at least 2');
    if (maxResults < 0) throw new Error('maxResults must be non-negative');
    const tagValues = filterValues(input, 'tags', ['tag', 'satelliteTags']);
    const explicitClasses = filterValues(input, 'classes', ['class', 'orbitClasses', 'satelliteClasses']);
    const explicitTypes = filterValues(input, 'types', ['type', 'objectTypes', 'satelliteTypes']);
    const tagParts = splitTags(tagValues);
    const classes = explicitClasses == null ? tagParts.classes
      : explicitClasses.map(normaliseClass).filter(Boolean);
    const types = explicitTypes == null ? tagParts.types
      : explicitTypes.map(normaliseType).filter(Boolean);
    return {
      site: site,
      localDate: String(input.localDate == null ? '' : input.localDate).trim(),
      timeZone: String(input.timeZone == null ? 'UTC' : input.timeZone).trim(),
      sunAltitudeLimitDeg: sunAltitudeLimitDeg,
      minimumElevationDeg: minimumElevationDeg,
      coarseStepS: coarseStepS,
      fineStepS: fineStepS,
      marginDeg: marginDeg,
      pathToleranceArcsec: pathToleranceArcsec,
      pathMaxSamples: pathMaxSamples,
      exactPassLimit: exactPassLimit,
      deferExactPasses: input.deferExactPasses == null
        ? DEFAULTS.deferExactPasses : !!input.deferExactPasses,
      workerPathMaxSamples: workerPathMaxSamples,
      maxResults: maxResults,
      refraction: input.refraction == null ? !!input.refract : !!input.refraction,
      dut1S: dut1S,
      // `tags` is accepted as the mixed seven-chip API; the worker receives the
      // two dimensions used by SatIdentifier's ordinary scan directly.
      satelliteTags: tagValues,
      satelliteClasses: classes,
      satelliteTypes: types,
    };
  }

  function services(overrides) {
    const d = overrides || {};
    const root = typeof SAT === 'undefined' ? {} : SAT;
    return {
      night: d.night || (root.occultation && root.occultation.night),
      scan: d.scan || root.scan,
      prop: d.prop || root.prop,
      path: d.path || (root.occultation && root.occultation.adaptivePath),
      state: d.state || root.state,
    };
  }

  function nightWindows(config, svc) {
    if (!svc.night || typeof svc.night.windowsForDate !== 'function') {
      throw new Error('SAT.occultation.night.windowsForDate() is required');
    }
    return svc.night.windowsForDate({
      site: config.site,
      localDate: config.localDate,
      timeZone: config.timeZone,
      sunAltitudeLimitDeg: config.sunAltitudeLimitDeg,
      dut1S: config.dut1S,
    });
  }

  /** Build the worker-compatible zenith scan for one NightWindow.
   *
   * The circular radius is `90° - minimumElevationDeg`, so the worker's existing
   * FOV boundary and elevation gate describe the same ground-sky domain. Times are
   * UTC Unix milliseconds; no local civil time is passed to the worker.
   */
  function scanParameters(config, window) {
    const startMs = integerMs(window.startMs, 'window.startMs');
    const endMs = integerMs(window.endMs, 'window.endMs');
    if (!(endMs > startMs)) throw new Error('night window must have endMs > startMs');
    return {
      t0Ms: startMs,
      spanMin: (endMs - startMs) / MINUTE_MS,
      site: Object.assign({}, config.site),
      pointing: {
        track: 'mount', mode: 'altaz', azDeg: 0, elDeg: 90,
        refract: config.refraction,
      },
      fov: {
        shape: 'circ', rDeg: 90 - config.minimumElevationDeg,
        wDeg: 0, hDeg: 0, rotDeg: 0,
      },
      filters: {
        minElDeg: config.minimumElevationDeg,
        classes: config.satelliteClasses,
        types: config.satelliteTypes,
      },
      steps: {
        coarseStepS: config.coarseStepS,
        fineStepS: config.fineStepS,
        marginDeg: config.marginDeg,
      },
      workerPathMaxSamples: config.workerPathMaxSamples,
      dut1S: config.dut1S,
      maxCrossings: config.maxResults,
    };
  }

  function objectFor(crossing, svc) {
    const state = svc.state;
    if (!state) return null;
    if (typeof state.getObj === 'function' && crossing.satId != null) {
      const byId = state.getObj(crossing.satId);
      if (byId) return byId;
    }
    if (typeof state.objByNorad === 'function' && crossing.norad != null) {
      return state.objByNorad(crossing.norad) || null;
    }
    return null;
  }

  function validElevation(geometry) {
    return geometry && isFinite(Number(geometry.elDeg));
  }

  function normalizePath(path, startMs, endMs) {
    if (!Array.isArray(path)) return [];
    return path.filter((point) => point && isFinite(Number(point.t)) &&
      isFinite(Number(point.raDeg)) && isFinite(Number(point.decDeg)))
      .map((point) => ({
        t: Math.round(Number(point.t)),
        raDeg: Number(point.raDeg),
        decDeg: Number(point.decDeg),
      }))
      .filter((point) => (startMs == null || point.t >= startMs) &&
        (endMs == null || point.t <= endMs))
      .sort((a, b) => a.t - b.t);
  }

  function boundedPath(path, maxSamples) {
    if (path.length <= maxSamples) return { path: path, truncated: false };
    const kept = [];
    for (let i = 0; i < maxSamples; i++) {
      const index = Math.round(i * (path.length - 1) / (maxSamples - 1));
      if (!kept.length || kept[kept.length - 1].t !== path[index].t) kept.push(path[index]);
    }
    return { path: kept, truncated: true };
  }

  function fallbackGeometry(crossing) {
    return {
      azDeg: Number(crossing.azDeg),
      elDeg: Number(crossing.elDeg),
      rangeKm: Number(crossing.rangeKm),
      shadow: crossing.shadow,
    };
  }

  function makeLooker(config, crossing, svc) {
    const obj = objectFor(crossing, svc);
    const prop = svc.prop;
    if (!obj || !prop || typeof prop.look !== 'function') return { object: obj, at: null };
    const cache = new Map();
    return {
      object: obj,
      at: (ms) => {
        const key = Math.round(ms);
        if (cache.has(key)) return cache.get(key);
        let geometry = null;
        try {
          geometry = prop.look(config.site, obj, new Date(key), {
            refraction: config.refraction, dut1S: config.dut1S,
          });
        } catch (error) {
          geometry = null;
        }
        cache.set(key, geometry);
        return geometry;
      },
    };
  }

  /** Refine a raw worker path when an exact J2000 look evaluator is available.
   *
   * The adaptive-path module owns the spherical interpolation and error metric;
   * this wrapper binds it to the same object, site, refraction, and DUT1 options
   * used by culmination(). A missing object, missing evaluator, or failed
   * direction evaluation deliberately preserves the raw-worker path because a
   * trajectory error claim would otherwise be fabricated.
   */
  function adaptivePath(config, crossing, startMs, endMs, culminationMs, svc) {
    const rawPath = normalizePath(crossing.path, startMs, endMs);
    const pathToleranceArcsec = config.pathToleranceArcsec == null
      ? DEFAULTS.pathToleranceArcsec : config.pathToleranceArcsec;
    const pathMaxSamples = config.pathMaxSamples == null
      ? DEFAULTS.pathMaxSamples : config.pathMaxSamples;
    const boundedRaw = boundedPath(rawPath, pathMaxSamples);
    const fallback = {
      path: boundedRaw.path,
      pathMode: 'raw-worker',
      pathToleranceArcsec: null,
      pathTruncated: boundedRaw.truncated,
      pathWorstErrorArcsec: null,
      flags: boundedRaw.truncated ? ['adaptive-path-truncated'] : [],
    };
    const obj = objectFor(crossing, svc);
    const prop = svc.prop;
    const solver = svc.path;
    if (!obj || !prop || typeof prop.look !== 'function' ||
        !solver || typeof solver.refine !== 'function') {
      fallback.flags.push('adaptive-path-fallback');
      return fallback;
    }

    const evaluate = (ms) => {
      let geometry = null;
      try {
        geometry = prop.look(config.site, obj, new Date(Math.round(ms)), {
          refraction: config.refraction, dut1S: config.dut1S,
        });
      } catch (error) {
        geometry = null;
      }
      return geometry && isFinite(Number(geometry.raDeg)) && isFinite(Number(geometry.decDeg))
        ? { raDeg: Number(geometry.raDeg), decDeg: Number(geometry.decDeg) } : null;
    };

    let refined;
    try {
      refined = solver.refine({
        path: rawPath,
        startMs: startMs,
        endMs: endMs,
        anchorTimes: [culminationMs],
        evaluate: evaluate,
      }, {
        toleranceArcsec: pathToleranceArcsec,
        maxSamples: pathMaxSamples,
      });
    } catch (error) {
      fallback.flags.push('adaptive-path-fallback');
      return fallback;
    }
    if (!refined || refined.pathMode !== 'adaptive' || !Array.isArray(refined.path)) {
      fallback.flags.push('adaptive-path-fallback');
      if (refined && refined.pathTruncated) {
        fallback.path = refined.path;
        fallback.pathTruncated = true;
        fallback.flags.push('adaptive-path-truncated');
      }
      return fallback;
    }
    return {
      path: refined.path,
      pathMode: refined.pathMode,
      pathToleranceArcsec: refined.pathToleranceArcsec,
      pathTruncated: !!refined.pathTruncated,
      pathWorstErrorArcsec: refined.pathWorstErrorArcsec,
      flags: refined.pathTruncated ? ['adaptive-path-truncated'] : [],
    };
  }

  /** Re-evaluate the pass maximum with the canonical main-thread look() result.
   *
   * The worker already supplies a closest-to-zenith estimate. A bounded golden
   * section around the complete in-field interval removes any disagreement caused
   * by integer-ms reporting or by the worker/main-thread refraction option while
   * keeping this stage independent of the later stellar closest-approach solver.
   */
  function culmination(config, crossing, startMs, endMs, svc) {
    const rawMs = clamp(integerMs(crossing.tCaMs, 'crossing.tCaMs'), startMs, endMs);
    const looker = makeLooker(config, crossing, svc);
    const fallback = fallbackGeometry(crossing);
    if (!looker.at) return { ms: rawMs, geometry: fallback, fallback: true };

    const evaluate = (ms) => {
      const geometry = looker.at(ms);
      return validElevation(geometry) ? geometry : null;
    };
    let bestMs = rawMs;
    let bestGeometry = evaluate(rawMs);
    const startGeometry = evaluate(startMs);
    const endGeometry = evaluate(endMs);
    if (validElevation(startGeometry) && (!bestGeometry || startGeometry.elDeg > bestGeometry.elDeg)) {
      bestMs = startMs; bestGeometry = startGeometry;
    }
    if (validElevation(endGeometry) && (!bestGeometry || endGeometry.elDeg > bestGeometry.elDeg)) {
      bestMs = endMs; bestGeometry = endGeometry;
    }

    let lo = startMs, hi = endMs;
    let left = hi - GOLDEN_RATIO * (hi - lo);
    let right = lo + GOLDEN_RATIO * (hi - lo);
    let leftGeometry = evaluate(left);
    let rightGeometry = evaluate(right);
    for (let i = 0; i < CULMINATION_ITERATIONS; i++) {
      if (validElevation(leftGeometry) && (!bestGeometry || leftGeometry.elDeg > bestGeometry.elDeg)) {
        bestMs = left; bestGeometry = leftGeometry;
      }
      if (validElevation(rightGeometry) && (!bestGeometry || rightGeometry.elDeg > bestGeometry.elDeg)) {
        bestMs = right; bestGeometry = rightGeometry;
      }
      const leftEl = validElevation(leftGeometry) ? leftGeometry.elDeg : -Infinity;
      const rightEl = validElevation(rightGeometry) ? rightGeometry.elDeg : -Infinity;
      if (leftEl < rightEl) {
        lo = left;
        left = right;
        leftGeometry = rightGeometry;
        right = lo + GOLDEN_RATIO * (hi - lo);
        rightGeometry = evaluate(right);
      } else {
        hi = right;
        right = left;
        rightGeometry = leftGeometry;
        left = hi - GOLDEN_RATIO * (hi - lo);
        leftGeometry = evaluate(left);
      }
    }
    if (!bestGeometry) return { ms: rawMs, geometry: fallback, fallback: true };
    bestMs = clamp(Math.round(bestMs), startMs, endMs);
    const roundedGeometry = evaluate(bestMs) || bestGeometry;
    return { ms: bestMs, geometry: roundedGeometry, fallback: false };
  }

  function passId(crossing, startMs, endMs) {
    const id = crossing.satId != null ? crossing.satId : crossing.norad;
    return 'pass:' + String(id) + ':' + startMs + ':' + endMs;
  }

  /** Convert one raw Crossing into a SatellitePass, or return null if malformed.
   *
   * `context` is the resolved pass configuration plus `{window}`. The optional
   * third argument is dependency injection for deterministic tests; production
   * callers use the loaded SAT.night, SAT.prop, and SAT.state services.
   */
  function normalizeCrossing(crossing, context, overrides) {
    if (!crossing || typeof crossing !== 'object') return null;
    const config = context.config || context;
    const window = context.window;
    if (!window) throw new Error('normalizeCrossing requires a NightWindow context');
    const windowStart = integerMs(window.startMs, 'window.startMs');
    const windowEnd = integerMs(window.endMs, 'window.endMs');
    const enter = Number(crossing.tEnterMs), exit = Number(crossing.tExitMs);
    if (!isFinite(enter) || !isFinite(exit) || !isFinite(Number(crossing.tCaMs)) || exit < enter) {
      return null;
    }
    const startMs = clamp(Math.round(enter), windowStart, windowEnd);
    const endMs = clamp(Math.round(exit), windowStart, windowEnd);
    if (!(endMs >= startMs)) return null;
    const svc = services(overrides);
    const ca = culmination(config, crossing, startMs, endMs, svc);
    const geometry = ca.geometry || fallbackGeometry(crossing);
    const flags = Array.isArray(crossing.flags) ? crossing.flags.slice() : [];
    if (ca.fallback) flags.push('culmination-fallback');
    const maxElevationDeg = validElevation(geometry)
      ? Number(geometry.elDeg)
      : (isFinite(Number(crossing.elDeg)) ? Number(crossing.elDeg) : 90 - Number(crossing.sepCaDeg));
    if (!isFinite(maxElevationDeg) || maxElevationDeg < config.minimumElevationDeg - 1e-7) return null;

    const obj = objectFor(crossing, svc);
    let orbitClass = classOf(crossing, obj);
    let tleAgeDays = isFinite(Number(crossing.tleAgeDays)) ? Math.abs(Number(crossing.tleAgeDays)) : null;
    const prop = svc.prop;
    if (obj && prop) {
      try {
        if (typeof prop.classOf === 'function') {
          const derivedClass = normaliseClass(prop.classOf(obj));
          if (derivedClass) orbitClass = derivedClass;
        }
        if (typeof prop.tleAgeDays === 'function') {
          const age = prop.tleAgeDays(obj, new Date(ca.ms));
          if (isFinite(age)) tleAgeDays = Math.abs(age);
        }
      } catch (error) {
        flags.push('metadata-fallback');
      }
    }

    const pathResult = adaptivePath(config, crossing, startMs, endMs, ca.ms, svc);
    pathResult.flags.forEach((flag) => { if (flags.indexOf(flag) < 0) flags.push(flag); });

    return {
      passId: passId(crossing, startMs, endMs),
      satId: crossing.satId,
      norad: crossing.norad,
      name: crossing.name,
      intl: crossing.intl,
      cls: orbitClass,
      type: typeOf(crossing, obj),
      startMs: startMs,
      culminationMs: ca.ms,
      endMs: endMs,
      maxElevationDeg: maxElevationDeg,
      azDeg: isFinite(Number(geometry.azDeg)) ? Number(geometry.azDeg)
        : (isFinite(Number(crossing.azDeg)) ? Number(crossing.azDeg) : null),
      elDeg: isFinite(Number(geometry.elDeg)) ? Number(geometry.elDeg)
        : (isFinite(Number(crossing.elDeg)) ? Number(crossing.elDeg) : null),
      minRangeKm: isFinite(Number(geometry.rangeKm)) ? Number(geometry.rangeKm) : null,
      tleAgeDays: tleAgeDays,
      orbitClass: orbitClass,
      shadowAtCulmination: geometry.shadow == null ? crossing.shadow : geometry.shadow,
      sunElevationDeg: isFinite(Number(crossing.sunElDeg)) ? Number(crossing.sunElDeg) : null,
      path: pathResult.path,
      pathMode: pathResult.pathMode,
      pathToleranceArcsec: pathResult.pathToleranceArcsec,
      pathTruncated: pathResult.pathTruncated,
      pathWorstErrorArcsec: pathResult.pathWorstErrorArcsec,
      sourceCrossing: crossing,
      flags: flags,
    };
  }

  function normalizeCrossings(crossings, context, overrides, options) {
    options = options || {};
    const out = [];
    (Array.isArray(crossings) ? crossings : []).forEach((crossing) => {
      const pass = options.deferExact
        ? normalizeRawCrossing(crossing, context, overrides)
        : normalizeCrossing(crossing, context, overrides);
      if (pass) out.push(pass);
    });
    return out;
  }

  /**
   * Normalize a worker crossing without repeating SGP4 on the main thread.
   *
   * Parameters
   * ----------
   * crossing : object
   *     Worker geometry with UTC Unix-millisecond boundaries and a sampled J2000
   *     path. The path is a representation seed, not an adaptive error bound.
   * context : object
   *     Resolved pass configuration and the NightWindow used to clip the record.
   * overrides : object, optional
   *     Production services or deterministic test doubles. Kept for the same
   *     boundary as `normalizeCrossing()`.
   *
   * Returns
   * -------
   * SatellitePass or null
   *     A valid pass using worker-reported culmination/elevation metadata and
   *     `pathMode: 'raw-worker'`. `adaptive-path-deferred` is always recorded so
   *     downstream candidate search can expose the incomplete representation.
   *
   * Notes
   * -----
   * This is deliberately used only after a large raw result set is known. It
   * avoids tens of thousands of synchronous `SAT.prop.look()` calls while
   * preserving the worker's already-computed crossing geometry. Exact path
   * refinement remains the default below `exactPassLimit`.
   */
  function normalizeRawCrossing(crossing, context, overrides) {
    if (!crossing || typeof crossing !== 'object') return null;
    const config = context.config || context;
    const window = context.window;
    if (!window) throw new Error('normalizeRawCrossing requires a NightWindow context');
    const windowStart = integerMs(window.startMs, 'window.startMs');
    const windowEnd = integerMs(window.endMs, 'window.endMs');
    const enter = Number(crossing.tEnterMs), exit = Number(crossing.tExitMs);
    if (!isFinite(enter) || !isFinite(exit) || !isFinite(Number(crossing.tCaMs)) || exit < enter) {
      return null;
    }
    const startMs = clamp(Math.round(enter), windowStart, windowEnd);
    const endMs = clamp(Math.round(exit), windowStart, windowEnd);
    if (!(endMs >= startMs)) return null;
    const maxElevationDeg = Number(crossing.elDeg);
    if (!isFinite(maxElevationDeg) || maxElevationDeg < config.minimumElevationDeg - 1e-7) return null;
    const flags = Array.isArray(crossing.flags) ? crossing.flags.slice() : [];
    const obj = objectFor(crossing, services(overrides));
    if (flags.indexOf('adaptive-path-deferred') < 0) flags.push('adaptive-path-deferred');
    const path = normalizePath(crossing.path, startMs, endMs);
    if (!path.length && flags.indexOf('missing-path') < 0) flags.push('missing-path');
    return {
      passId: passId(crossing, startMs, endMs),
      satId: crossing.satId,
      norad: crossing.norad,
      name: crossing.name,
      intl: crossing.intl,
      cls: classOf(crossing, obj),
      type: typeOf(crossing, obj),
      startMs: startMs,
      culminationMs: clamp(Math.round(Number(crossing.tCaMs)), startMs, endMs),
      endMs: endMs,
      maxElevationDeg: maxElevationDeg,
      azDeg: isFinite(Number(crossing.azDeg)) ? Number(crossing.azDeg) : null,
      elDeg: isFinite(Number(crossing.elDeg)) ? Number(crossing.elDeg) : null,
      minRangeKm: isFinite(Number(crossing.rangeKm)) ? Number(crossing.rangeKm) : null,
      tleAgeDays: isFinite(Number(crossing.tleAgeDays)) ? Math.abs(Number(crossing.tleAgeDays)) : null,
      orbitClass: classOf(crossing, obj),
      shadowAtCulmination: crossing.shadow == null ? null : crossing.shadow,
      sunElevationDeg: isFinite(Number(crossing.sunElDeg)) ? Number(crossing.sunElDeg) : null,
      path: path,
      pathMode: 'raw-worker',
      pathToleranceArcsec: null,
      pathTruncated: false,
      pathWorstErrorArcsec: null,
      sourceCrossing: crossing,
      flags: flags,
    };
  }

  /** Compact one deferred pass without mutating the worker-owned crossing.
   *
   * A deferred full-night discovery keeps `pass.path` as the normalized
   * representation consumed by OCCSTAR1 and P0-07. The raw worker crossing also
   * contains the same path, however, so retaining it under `sourceCrossing` would
   * keep a second copy alive for every crossing. This copy preserves scalar worker
   * provenance and marks the omitted path explicitly; exact-size runs retain the
   * original object and its identity contract.
   *
   * Parameters
   * ----------
   * pass : object
   *     Normalized `SatellitePass` with `pathMode: 'raw-worker'`.
   *
   * Returns
   * -------
   * object
   *     The same pass object, with a compact, path-free `sourceCrossing` audit
   *     record and an explicit `source-crossing-path-omitted` flag.
   *
   * Notes
   * -----
   * The pass path is not removed: it is the only representation needed by the
   * downstream candidate and closest-approach stages. The omitted path is an
   * audit-memory policy, not a scientific claim that the path was verified.
   */
  function compactDeferredPass(pass) {
    if (!pass || !pass.sourceCrossing || typeof pass.sourceCrossing !== 'object') return pass;
    const audit = Object.assign({}, pass.sourceCrossing, { path: [] });
    audit.pathOmittedFromAudit = true;
    pass.sourceCrossing = audit;
    if (Array.isArray(pass.flags) && pass.flags.indexOf('source-crossing-path-omitted') < 0) {
      pass.flags.push('source-crossing-path-omitted');
    }
    return pass;
  }

  /** Return a scalar raw-scan audit record after a large deferred scan.
   *
   * The worker crossing list is already represented by the normalized pass list
   * above. Keeping that list again under `rawResults[].raw.crossings` creates a
   * second full-night object graph, so only counts and culling accounting remain
   * in the detached discovery report. Small exact runs preserve the complete raw
   * result object.
   */
  function compactDeferredRaw(raw) {
    const compact = Object.assign({}, raw || {});
    compact.crossings = [];
    compact.rawCrossingsOmitted = true;
    compact.rawCrossingCount = Array.isArray(raw && raw.crossings) ? raw.crossings.length : 0;
    return compact;
  }

  function emptyCulled() {
    return { total: 0, bad: 0, stage1: 0, stage2: 0, stage3: 0, survivors: 0, candidates: 0 };
  }

  function addCulled(total, value) {
    if (!value) return;
    Object.keys(total).forEach((key) => { total[key] += Number(value[key]) || 0; });
  }

  /** Discover all ground-site passes in the selected local civil date. */
  async function discover(input, overrides) {
    const config = resolvedInput(input);
    const svc = services(overrides);
    const windows = nightWindows(config, svc);
    if (windows.length && (!svc.scan || typeof svc.scan.runRaw !== 'function')) {
      throw new Error('SAT.scan.runRaw() is required for pass discovery');
    }
    const rawResults = [];
    const passes = [];
    const culled = emptyCulled();
    let rawCrossings = 0, rejected = 0, propagations = 0, ms = 0, truncated = false;
    let exactRefined = 0, deferred = 0, rawAuditCompacted = false;
    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      const params = scanParameters(config, window);
      const raw = await svc.scan.runRaw(params, {
        maxResults: config.maxResults,
        eventPrefix: Object.prototype.hasOwnProperty.call(input, 'eventPrefix')
          ? input.eventPrefix : 'occultation',
      });
      const list = Array.isArray(raw && raw.crossings) ? raw.crossings : [];
      rawCrossings += list.length;
      propagations += Number(raw && raw.propagations) || 0;
      ms += Number(raw && raw.ms) || 0;
      truncated = truncated || !!(raw && raw.truncated);
      addCulled(culled, raw && raw.culled);
      const before = passes.length;
      const deferExact = config.deferExactPasses && list.length > config.exactPassLimit;
      const normalized = normalizeCrossings(list, { config: config, window: window }, svc, {
        deferExact: deferExact,
      });
      if (deferExact) {
        normalized.forEach(compactDeferredPass);
        rawAuditCompacted = true;
      }
      rawResults.push({ window: window, params: params,
        raw: deferExact ? compactDeferredRaw(raw) : raw });
      passes.push.apply(passes, normalized);
      if (deferExact) deferred += normalized.length;
      else exactRefined += normalized.length;
      rejected += list.length - (passes.length - before);
    }
    return {
      status: windows.length ? 'ok' : 'no-night',
      config: Object.assign({}, config, { site: Object.assign({}, config.site) }),
      windows: windows.slice(),
      passes: passes,
      rawResults: rawResults,
      stats: {
        windows: windows.length,
        rawCrossings: rawCrossings,
        passes: passes.length,
        exactRefined: exactRefined,
        deferred: deferred,
        exactPassLimit: config.exactPassLimit,
        rawAuditCompacted: rawAuditCompacted,
        rejected: rejected,
        truncated: truncated,
        culled: culled,
        propagations: propagations,
        ms: ms,
      },
    };
  }

  const API = {
    buildScanParameters: (input, window) => scanParameters(resolvedInput(input), window),
    resolveInput: resolvedInput,
    adaptivePath: (input, options) => {
      const root = typeof SAT === 'undefined' ? {} : SAT;
      const solver = root.occultation && root.occultation.adaptivePath;
      if (!solver || typeof solver.refine !== 'function') {
        throw new Error('SAT.occultation.adaptivePath.refine() is required');
      }
      return solver.refine(input, options);
    },
    buildAdaptivePath: (input, options) => {
      const root = typeof SAT === 'undefined' ? {} : SAT;
      const solver = root.occultation && root.occultation.adaptivePath;
      if (!solver || typeof solver.refine !== 'function') {
        throw new Error('SAT.occultation.adaptivePath.refine() is required');
      }
      return solver.refine(input, options);
    },
    normalizeCrossing: normalizeCrossing,
    normalizeCrossings: normalizeCrossings,
    discover: discover,
    run: discover,
  };

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.passes = API;
})();
