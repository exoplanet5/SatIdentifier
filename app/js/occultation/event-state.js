/* SAT.occultation.eventState — independent occultation event state lifecycle.
 *
 * Scientific responsibility: publish the P0-09 extension of the event-assembly
 * payload under SAT.state.occultation. The namespace is transient and independent
 * from the ordinary scan store; this module never writes SAT.state.scan or scan events.
 */
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports &&
    typeof SAT !== 'undefined') {
  SAT.occultation = SAT.occultation || {};
  if (!SAT.occultation.refine) require('./refine.js');
  if (!SAT.occultation.contact) require('./contact.js');
  if (!SAT.occultation.lookAdapter) require('./look-adapter.js');
  if (!SAT.occultation.eventAssembly) require('./event-assembly.js');
}
(function () {
  'use strict';

  const ROOT = SAT;
  const A = ROOT.occultation.lookAdapter;
  const ASSEMBLY = ROOT.occultation.eventAssembly;

  function emptyState() {
    return {
      version: 'p0-09', status: 'idle', complete: true, stale: false, updatedAtMs: null,
      site: null, options: null, passes: [], candidates: [], events: [], failures: [],
      stats: { passes: 0, candidates: 0, events: 0, refined: 0, incomplete: 0,
        failed: 0, duplicateCandidates: 0, contacted: 0, contactMisses: 0,
        contactIncomplete: 0, evaluatedCandidates: 0, evaluatedEvents: 0,
        filteredEvents: 0, filteredMisses: 0, filteredIncomplete: 0,
        filteredCandidates: 0, retainedPasses: 0 },
    };
  }

  function stateFor(svc) {
    if (!svc.state) svc.state = ROOT.state || (ROOT.state = {});
    if (!svc.state.occultation || typeof svc.state.occultation !== 'object') {
      svc.state.occultation = emptyState();
    }
    return svc.state.occultation;
  }

  /** Publish a built payload while preserving the existing occultation object.
   *
   * `adoptDetached: true` is reserved for pipeline results produced by
   * `eventAssembly.build()`/`buildAsync()`. Those builders copy every input
   * record while constructing the independent state, so copying the complete
   * result a second time during publication would briefly double the largest
   * full-night event graph. Ordinary callers keep the defensive deep copy.
   *
   * Parameters
   * ----------
   * result : object
   *     JSON-like P0-09 event state. Times are UTC Unix milliseconds and angles
   *     remain in the documented J2000 degree frame.
   * overrides : object, optional
   *     State/bus services plus `adoptDetached`, which may only be used when the
   *     caller owns an already detached result graph.
   *
   * Returns
   * -------
   * object
   *     The stable `SAT.state.occultation` object identity, populated with the
   *     published state and a UTC `updatedAtMs` timestamp.
   */
  function commit(result, overrides) {
    if (!result || typeof result !== 'object') throw new Error('event-state result is required');
    const injected = overrides || {};
    const svc = A.services(injected);
    const target = stateFor(svc);
    const copied = injected.adoptDetached === true ? result : A.copyValue(result);
    const nowMs = result.updatedAtMs != null ? result.updatedAtMs
      : (injected.nowMs != null ? A.finiteNumber(injected.nowMs, 'nowMs') : Date.now());
    Object.keys(target).forEach((key) => { delete target[key]; });
    Object.assign(target, copied, { updatedAtMs: nowMs, stale: false });
    if (svc.bus && typeof svc.bus.emit === 'function') {
      svc.bus.emit('occultation-state-changed', {
        state: target, count: target.events.length, status: target.status,
      });
    }
    return target;
  }

  /** Assemble and publish one independent occultation event state. */
  function resolve(input, options, overrides) {
    return commit(ASSEMBLY.build(input, options, overrides), overrides);
  }

  function clear(overrides) {
    const svc = A.services(overrides);
    const target = stateFor(svc);
    const next = emptyState();
    Object.keys(target).forEach((key) => { delete target[key]; });
    Object.assign(target, next);
    if (svc.bus && typeof svc.bus.emit === 'function') {
      svc.bus.emit('occultation-state-changed', { state: target, count: 0, status: 'idle' });
    }
    return target;
  }

  const API = {
    emptyState: emptyState,
    eventId: ASSEMBLY.eventId,
    bindLook: A.bindLook,
    lookEvaluator: A.bindLook,
    build: ASSEMBLY.build,
    assemble: ASSEMBLY.build,
    buildAsync: ASSEMBLY.buildAsync,
    assembleAsync: ASSEMBLY.buildAsync,
    commit: commit,
    publish: commit,
    resolve: resolve,
    run: resolve,
    clear: clear,
    state: function (overrides) { return stateFor(A.services(overrides)); },
  };

  ROOT.occultation = ROOT.occultation || {};
  ROOT.occultation.eventState = API;
  ROOT.occultation.events = API;
  stateFor(A.services());
})();
