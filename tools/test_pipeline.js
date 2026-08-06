/* Verification for app/js/occultation/pipeline.js — P0-11.
 *
 * The harness injects deterministic stage doubles. It checks stage ordering,
 * no-night short-circuiting, partial provenance, cancellation, single state
 * publication, and isolation from ordinary SAT.state.scan.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

const listeners = new Map();
const emitted = [];
const scanState = { sentinel: true, crossings: ['ordinary'] };
global.SAT = {
  occultation: {}, state: { scan: scanState },
  bus: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    off(name, fn) { if (listeners.has(name)) listeners.get(name).delete(fn); },
    emit(name, payload) {
      emitted.push({ name, payload });
      (listeners.get(name) || []).forEach((fn) => fn(payload));
    },
  },
};
require(path.join(APP, 'occultation', 'pipeline.js'));
const P = SAT.occultation.pipeline;

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

const config = {
  site: { kind: 'ground', latDeg: -37.8, lonDeg: 145, altM: 30 },
  localDate: '2026-07-20', timeZone: 'Australia/Melbourne',
  starOptions: { corridorArcsec: 10, magLimit: 6 },
  eventOptions: { defaultRadiusM: 1 },
};
const pass = { passId: 'pass:1:0:100', satId: 'sat-1', startMs: 0, culminationMs: 50, endMs: 100,
  path: [{ t: 0, raDeg: 10, decDeg: 20 }, { t: 100, raDeg: 10.1, decDeg: 20 }] };
const candidate = { passId: pass.passId, starKey: 'id:star-1', raDeg: 10, decDeg: 20, mag: 4.2 };

function doubles(order, mode) {
  let commits = 0;
  let scanCancels = 0;
  let eventNowMs = null;
  return {
    commits: () => commits,
    scanCancels: () => scanCancels,
    eventNowMs: () => eventNowMs,
    passes: {
      async discover(input) {
        order.push('passes');
        assert.strictEqual(input.eventPrefix, 'occultation-scan');
        if (mode === 'failure') throw new Error('synthetic pass failure');
        if (mode === 'no-night') return { status: 'no-night', windows: [], passes: [], stats: {
          windows: 0, passes: 0, rawCrossings: 0, truncated: false,
        } };
        if (mode === 'cancel') await new Promise((resolve) => { this.release = resolve; });
        return { status: 'ok', windows: [{ startMs: 0, endMs: 100 }], passes: [pass], stats: {
          windows: 1, passes: 1, rawCrossings: 1, truncated: mode === 'partial',
        } };
      },
    },
    starCandidates: {
      search(input) {
        order.push('stars');
        if (mode === 'partial') return { status: 'partial', results: [{ flags: ['candidate-limit'] }],
          candidates: [candidate], stats: { passes: 1, candidates: 1, truncated: true } };
        return { status: 'ok', results: [{ sourcePass: pass, candidates: [candidate] }],
          candidates: [candidate], stats: { passes: 1, candidates: 1, truncated: false } };
      },
    },
    eventState: {
      build(input, options) {
        order.push('events');
        eventNowMs = options && options.nowMs;
        const hasCandidate = input.search && input.search.candidates && input.search.candidates.length;
        return { version: 'p0-09', status: hasCandidate ? 'ok' : 'empty', complete: true,
          passes: input.passes || [], candidates: hasCandidate ? [candidate] : [],
          events: hasCandidate ? [{ eventId: 'event:1', complete: true, contactStatus: 'miss' }] : [],
          stats: { events: hasCandidate ? 1 : 0, contacted: 0, contactMisses: hasCandidate ? 1 : 0 } };
      },
      commit(state) { order.push('commit'); commits++; SAT.state.occultation = state; return state; },
    },
    night: {}, scan: { cancel() { scanCancels++; } }, prop: {}, path: {}, state: SAT.state,
    stars: { cone() { return []; } }, bus: SAT.bus,
  };
}

(async () => {
  console.log('\n[1] Complete ordering and publication');
  let order = [];
  let d = doubles(order, 'ok');
  let result = await P.run(config, { nowMs: 9000 }, d);
  ok('complete run returns p0-11 ok', result.version === 'p0-11' && result.status === 'ok' && result.complete);
  ok('stages run in order and commit once', order.join(',') === 'passes,stars,events,commit' && d.commits() === 1);
  ok('raw event prefix is isolated', result.config.pass.eventPrefix === 'occultation-scan');
  ok('deterministic event timestamp reaches the event stage', d.eventNowMs() === 9000);
  ok('pipeline provenance is attached to published state', result.state.pipeline.version === 'p0-11' &&
    result.state.pipeline.config.stars.corridorArcsec === 10);
  ok('ordinary scan state is untouched', SAT.state.scan === scanState && scanState.sentinel);
  ok('stage lifecycle events are emitted', emitted.some((row) => row.name === 'occultation-started') &&
    emitted.some((row) => row.name === 'occultation-events-ready') &&
    emitted.some((row) => row.name === 'occultation-done' && row.payload.stats.events.events === 1));

  console.log('\n[2] No-night and partial provenance');
  order = []; d = doubles(order, 'no-night');
  result = await P.run(config, {}, d);
  ok('no-night skips star search', result.status === 'no-night' && order.join(',') === 'passes,events,commit');
  ok('no-night is complete but explicitly flagged', result.complete && result.flags.includes('no-night'));
  order = []; d = doubles(order, 'partial');
  result = await P.run(config, {}, d);
  ok('partial stages remain visible', result.status === 'partial' && !result.complete &&
    result.flags.includes('pass-discovery-truncated') && result.flags.includes('candidate-limit'));
  ok('partial result is still committed once', d.commits() === 1 && result.published);
  order = []; d = doubles(order, 'partial');
  d.passes.discover = async function () {
    order.push('passes');
    return { status: 'ok', windows: [{ startMs: 0, endMs: 100 }], passes: [pass], stats: {
      windows: 1, passes: 1, rawCrossings: 1, truncated: true,
    } };
  };
  d.starCandidates.search = function () {
    order.push('stars');
    return { status: 'empty', results: [], candidates: [], stats: { passes: 1, candidates: 0, truncated: false } };
  };
  d.eventState.build = function (input) {
    order.push('events');
    return { version: 'p0-09', status: 'empty', complete: true, passes: input.passes || [],
      candidates: [], events: [], stats: { events: 0, contacted: 0, contactMisses: 0 } };
  };
  result = await P.run(config, {}, d);
  ok('truncated empty runs remain explicitly partial', result.status === 'partial' && !result.complete);

  console.log('\n[3] Failure isolation and cancellation');
  order = []; d = doubles(order, 'failure');
  result = await P.run(config, {}, d);
  ok('runtime failure returns a failed report', result.status === 'failed' && !result.complete &&
    result.flags.includes('pipeline-failed'));
  ok('failed discovery does not commit stale state', d.commits() === 0 && !order.includes('commit'));
  order = []; d = doubles(order, 'cancel');
  const pending = P.run(config, {}, d);
  await new Promise((resolve) => setImmediate(resolve));
  ok('cancel request is accepted', P.cancel() === true && d.scanCancels() === 1);
  d.passes.release();
  result = await pending;
  ok('cancelled run is explicit and unpublished', result.status === 'cancelled' && !result.published &&
    !order.includes('commit'));

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
