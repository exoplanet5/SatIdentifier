/* SAT.occultation.lookAdapter — canonical SAT.prop.look() event binding.
 *
 * Scientific responsibility: resolve one pass to one catalogue object and
 * observing site, then expose a synchronous exact J2000 direction evaluator.
 * This module does not solve closest approach, assemble events, or write state.
 */
(function () {
  'use strict';

  const ROOT = SAT;
  const DEFAULTS = { refraction: false, dut1S: 0 };

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  /** Copy JSON-safe scientific records while dropping private runtime caches. */
  function copyValue(value, stack) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'function') return undefined;
    const parents = stack || [];
    if (parents.indexOf(value) >= 0) return null;
    const nextStack = parents.concat([value]);
    if (Array.isArray(value)) return value.map((item) => copyValue(item, nextStack));
    const result = {};
    Object.keys(value).forEach((key) => {
      if (key[0] === '_') return;
      const copied = copyValue(value[key], nextStack);
      if (copied !== undefined) result[key] = copied;
    });
    return result;
  }

  function services(overrides) {
    const injected = overrides || {};
    const occultation = ROOT.occultation || {};
    return {
      state: injected.state || ROOT.state || null,
      prop: injected.prop || ROOT.prop || null,
      refine: injected.refine || occultation.refine || null,
      bus: injected.bus || ROOT.bus || null,
    };
  }

  function passIdOf(pass) {
    if (pass && pass.passId != null) return String(pass.passId);
    const id = pass && pass.satId != null ? pass.satId
      : (pass && pass.norad != null ? pass.norad : 'unknown');
    const start = pass && isFinite(Number(pass.startMs)) ? Math.round(Number(pass.startMs)) : 'start';
    const end = pass && isFinite(Number(pass.endMs)) ? Math.round(Number(pass.endMs)) : 'end';
    return 'pass:' + String(id) + ':' + start + ':' + end;
  }

  function objectFor(pass, svc) {
    if (pass && pass.object && typeof pass.object === 'object') return pass.object;
    const state = svc.state;
    if (!state) return null;
    if (typeof state.getObj === 'function' && pass && pass.satId != null) {
      const byId = state.getObj(pass.satId);
      if (byId) return byId;
    }
    if (typeof state.objByNorad === 'function' && pass && pass.norad != null) {
      const byNorad = state.objByNorad(pass.norad);
      if (byNorad) return byNorad;
      const numeric = Number(pass.norad);
      if (isFinite(numeric) && numeric !== pass.norad) return state.objByNorad(numeric) || null;
    }
    return null;
  }

  function siteOf(input, svc) {
    const source = input || {};
    let site = source.site || source.observer || source.location ||
      (source.config && source.config.site) || null;
    const state = svc.state;
    if (!site && state) {
      const locations = Array.isArray(state.locations) ? state.locations : [];
      const active = typeof state.activeLocation === 'function'
        ? state.activeLocation() : (locations.find((row) => row.active) || locations[0]);
      if (active && typeof state.resolvedSite === 'function') site = state.resolvedSite(active);
      else site = active;
    }
    if (!site) return null;
    if (site.missing) throw new Error('occultation event site is missing its observing object');
    const result = copyValue(site);
    if (result.kind == null) result.kind = 'ground';
    return result;
  }

  function resolveOptions(input, options) {
    const source = Object.assign({}, DEFAULTS, (input && input.options) || {}, options || {});
    const nested = Object.assign({}, (input && input.refineOptions) || {},
      (input && input.solverOptions) || {}, source.refine || {}, source.solver || {});
    const contact = Object.assign({}, (input && input.contactOptions) || {}, source.contact || {});
    ['timeToleranceMs', 'coarseMarginArcsec', 'unverifiedSelectionMarginArcsec',
      'maxEvaluations', 'maxSegments', 'maxIterations'].forEach((key) => {
      if (source[key] != null && nested[key] == null) nested[key] = source[key];
    });
    ['sampleStepMs', 'timeToleranceMs', 'maxEvaluations', 'maxSamples', 'maxIterations',
      'clearanceEpsilonArcsec', 'radiusM', 'satelliteRadiusM', 'physicalRadiusM',
      'defaultRadiusM'].forEach((key) => {
      if (source[key] != null && contact[key] == null) contact[key] = source[key];
    });
    const dut1S = finiteNumber(source.dut1S == null ? DEFAULTS.dut1S : source.dut1S, 'dut1S');
    return {
      refraction: source.refraction == null ? DEFAULTS.refraction : !!source.refraction,
      dut1S: dut1S,
      refine: nested,
      contact: contact,
      retainOnlyCandidatePasses: source.retainOnlyCandidatePasses == null
        ? false : !!source.retainOnlyCandidatePasses,
      contactsOnly: source.contactsOnly == null ? false : !!source.contactsOnly,
      nowMs: source.nowMs == null ? null : finiteNumber(source.nowMs, 'nowMs'),
    };
  }

  /**
   * Bind one SatellitePass to `SAT.prop.look()`.
   *
   * `evaluate(tMs)` accepts UTC Unix milliseconds and returns the complete
   * topocentric look result with finite J2000 `{raDeg, decDeg}`, or `null` when
   * propagation fails. `Date` has millisecond resolution, so fractional solver
   * samples are rounded to the nearest UTC millisecond before the canonical
   * propagation service is called. No SGP4 or frame conversion is duplicated.
   */
  function bindLook(input, options, overrides) {
    const source = input && input.pass ? input.pass : input;
    const svc = services(overrides);
    const config = resolveOptions(input, options);
    const site = siteOf(input, svc);
    const object = objectFor(source, svc);
    if (!site) throw new Error('occultation event site is required');
    if (!object) throw new Error('occultation satellite object is not in the loaded catalogue');
    if (!svc.prop || typeof svc.prop.look !== 'function') {
      throw new Error('SAT.prop.look() is required for occultation event refinement');
    }
    function evaluate(tMs) {
      const time = finiteNumber(tMs, 'evaluation time');
      const date = new Date(Math.round(time));
      const geometry = svc.prop.look(site, object, date, {
        refraction: config.refraction,
        dut1S: config.dut1S,
      });
      if (!geometry || !isFinite(Number(geometry.raDeg)) ||
          !isFinite(Number(geometry.decDeg))) return null;
      return Object.assign({}, geometry, {
        raDeg: Number(geometry.raDeg),
        decDeg: Number(geometry.decDeg),
      });
    }
    return {
      evaluate: evaluate,
      at: evaluate,
      site: copyValue(site),
      object: object,
      source: 'SAT.prop.look',
      dateResolutionMs: 1,
    };
  }

  const API = {
    finiteNumber: finiteNumber,
    copyValue: copyValue,
    services: services,
    passIdOf: passIdOf,
    objectFor: objectFor,
    siteOf: siteOf,
    resolveOptions: resolveOptions,
    bindLook: bindLook,
  };
  SAT.occultation = SAT.occultation || {};
  SAT.occultation.lookAdapter = API;
})();
