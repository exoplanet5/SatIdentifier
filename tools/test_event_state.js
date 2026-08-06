/* Verification for app/js/occultation/event-state.js — P0-08.
 * Run: node tools/test_event_state.js
 *
 * The propagation service double returns a smooth J2000 direction but records
 * every SAT.prop.look() call. The harness therefore checks the production
 * binding boundary, P0-07 handoff, event-state isolation, deterministic event
 * assembly, and per-candidate failure retention without a browser or network.
 */
const path = require('path');

const APP = path.join(__dirname, '..', 'app', 'js');
const scanState = { sentinel: true, crossings: ['ordinary'] };
const object = { id: 'sat-1', norad: 1, name: 'SYNTHETIC SAT', type: 'PAY', radiusM: 10 };
const lookCalls = [];
const busEvents = [];
const TRUE_TIME = 1234.37;

function wrapRa(value) {
  return ((value % 360) + 360) % 360;
}

function trajectory(tMs) {
  const dt = tMs - TRUE_TIME;
  const alongArcsec = 0.04 * dt + 0.00001 * dt * dt;
  return {
    raDeg: wrapRa(10 + alongArcsec / 3600),
    decDeg: 0.5 / 3600,
  };
}

global.SAT = {
  occultation: {},
  state: {
    scan: scanState,
    getObj: (id) => id === object.id ? object : null,
  },
  prop: {
    look(site, obj, date, opts) {
      lookCalls.push({ site: site, object: obj, date: date, options: opts });
      if (site.kind !== 'ground' || obj !== object) return null;
      return Object.assign({ rangeKm: 42000, rateAsPerS: 40, azDeg: 210, elDeg: 44,
        shadow: 'none' },
        trajectory(date.getTime()));
    },
  },
  bus: {
    emit(name, payload) { busEvents.push({ name: name, payload: payload }); },
  },
};

require(path.join(APP, 'occultation', 'event-state.js'));
const E = SAT.occultation.eventState;
const pass = {
  passId: 'pass:synthetic', satId: object.id, norad: object.norad, name: object.name,
  cls: 'leo', orbitClass: 'leo', type: object.type,
  startMs: 0, culminationMs: 1000, endMs: 2000,
  pathMode: 'raw-worker', pathToleranceArcsec: null,
  path: [
    { t: 0, raDeg: trajectory(0).raDeg, decDeg: trajectory(0).decDeg },
    { t: 2000, raDeg: trajectory(2000).raDeg, decDeg: trajectory(2000).decDeg },
  ],
};
const candidate = {
  passId: pass.passId, starKey: 'id:star-1', catalogueId: 'star-1',
  raDeg: 10, decDeg: 0, mag: 8.2, sourceSegments: [0],
};
const site = { kind: 'ground', latDeg: -37.8, lonDeg: 145, altM: 30 };

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function near(name, got, want, tolerance, detail) {
  ok(name, isFinite(got) && Math.abs(got - want) <= tolerance,
    `${got} vs ${want}${detail ? ' ' + detail : ''}`);
}

console.log('\n[1] SAT.prop.look binding and exact closest approach');
ok('event-state API is attached', typeof E.build === 'function' &&
  typeof E.bindLook === 'function' && typeof E.resolve === 'function');
const adapter = E.bindLook({ pass: pass, site: site }, { refraction: false, dut1S: 0 }, {
  state: SAT.state, prop: SAT.prop,
});
const looked = adapter.evaluate(500);
ok('look adapter exposes the canonical service source',
  adapter.source === 'SAT.prop.look' && adapter.dateResolutionMs === 1);
ok('look adapter returns J2000 direction and preserves geometry',
  looked && isFinite(looked.raDeg) && looked.rangeKm === 42000);
ok('look receives the resolved site, object, Date, and options',
  lookCalls.length > 0 && lookCalls[0].site.kind === 'ground' &&
  lookCalls[0].object === object && lookCalls[0].date instanceof Date &&
  lookCalls[0].options.refraction === false && lookCalls[0].options.dut1S === 0);

const originalPass = JSON.stringify(pass);
const built = E.build({ site: site, passes: [pass], candidates: [candidate] }, {
  timeToleranceMs: 0.05,
});
const event = built.events[0];
ok('build returns one independent occultation candidate',
  built.status === 'ok' && built.events.length === 1 &&
  event.kind === 'occultation-candidate' && event.status === 'candidate');
ok('P0-07 result is retained under the event',
  event.refinementStatus === 'ok' && event.refinement &&
  event.refinement.status === 'ok');
ok('P0-09 contact stage retains an angular-size miss result',
  built.version === 'p0-09' && event.contactStatus === 'miss' &&
  event.contactResult && event.contactResult.complete === true &&
  isFinite(event.angularDiameterArcsec));
ok('top-level solver options reach P0-07', built.options.refine.timeToleranceMs === 0.05);
near('bound SAT.prop.look recovers the synthetic closest time', event.tCaMs, TRUE_TIME, 2);
ok('exact geometry is retained at closest approach',
  event.closestGeometry && event.closestGeometry.rangeKm === 42000);
ok('event carries scan class/type and exact Alt/Az',
  event.cls === 'leo' && event.orbitClass === 'leo' && event.type === 'PAY' &&
  event.azDeg === 210 && event.elDeg === 44);
ok('raw path precision remains disclosed', event.flags.includes('path-precision-unverified'));
ok('build does not publish or alter ordinary scan state',
  SAT.state.scan === scanState && JSON.stringify(SAT.state.scan) === JSON.stringify(scanState) &&
  SAT.state.occultation.status === 'idle');
ok('pass and candidate inputs are not mutated', JSON.stringify(pass) === originalPass);

console.log('\n[2] Independent state publication and deterministic provenance');
const stateObject = SAT.state.occultation;
const committed = E.commit(built, { state: SAT.state, bus: SAT.bus, nowMs: 9000 });
ok('commit preserves the occultation state object identity', committed === stateObject);
ok('commit writes only the independent occultation namespace',
  committed.status === 'ok' && committed.version === 'p0-09' && committed.updatedAtMs === 9000 &&
  SAT.state.scan === scanState);
ok('event IDs are deterministic and state is detached from inputs',
  event.eventId === 'event:' + pass.passId + ':' + candidate.starKey &&
  committed.passes[0] !== pass && committed.candidates[0] !== candidate);
pass.path[0].raDeg = 999;
candidate.mag = 99;
ok('published provenance is not backed by caller-owned objects',
  committed.passes[0].path[0].raDeg !== 999 && committed.candidates[0].mag === 8.2);
ok('publication emits a scoped state event',
  busEvents.some((row) => row.name === 'occultation-state-changed'));

const fromSearch = E.build({
  site: site,
  results: [{ sourcePass: Object.assign({}, pass, { path: [
    { t: 0, raDeg: trajectory(0).raDeg, decDeg: trajectory(0).decDeg },
    { t: 2000, raDeg: trajectory(2000).raDeg, decDeg: trajectory(2000).decDeg },
  ] }), candidates: [candidate] }],
}, { timeToleranceMs: 0.05 });
ok('star-candidate search results bind through sourcePass',
  fromSearch.events.length === 1 && fromSearch.events[0].passId === pass.passId);

const contactCandidate = {
  passId: pass.passId, starKey: 'id:star-contact', catalogueId: 'star-contact',
  raDeg: 10, decDeg: 0.5 / 3600, mag: 8.2, sourceSegments: [0],
};
const contactPass = Object.assign({}, pass, { path: [
  { t: 0, raDeg: trajectory(0).raDeg, decDeg: trajectory(0).decDeg },
  { t: 2000, raDeg: trajectory(2000).raDeg, decDeg: trajectory(2000).decDeg },
] });
const contactsOnly = E.build({ site: site, passes: [contactPass],
  candidates: [candidate, contactCandidate] },
{ timeToleranceMs: 0.05, defaultRadiusM: 10, contactsOnly: true });
ok('contacts-only assembly retains geometric contact/grazing events only',
  contactsOnly.options.contactsOnly === true && contactsOnly.events.length === 1 &&
  contactsOnly.events[0].contact === true && contactsOnly.candidates.length === 1 &&
  contactsOnly.passes.length === 1);
ok('contacts-only assembly reports filtered misses without publishing them',
  contactsOnly.stats.filteredEvents === 1 && contactsOnly.stats.filteredMisses === 1 &&
  contactsOnly.stats.filteredCandidates === 1 && contactsOnly.stats.events === 1);

console.log('\n[3] Failure isolation and clear semantics');
const missing = E.build({
  site: site, passes: [pass], candidates: [{
    passId: pass.passId, starKey: 'id:missing', raDeg: 10, decDeg: 0,
  }],
}, {}, { state: { getObj: () => null }, prop: SAT.prop, refine: SAT.occultation.refine });
ok('missing catalogue objects remain as incomplete events',
  missing.status === 'partial' && missing.events.length === 1 &&
  missing.events[0].flags.includes('missing-object') && missing.events[0].complete === false);
const invalid = E.build({ site: site, passes: [pass], candidates: [{
  passId: pass.passId, starKey: 'invalid', raDeg: 10, decDeg: 91,
}] }, {}, { state: SAT.state, prop: SAT.prop, refine: SAT.occultation.refine });
ok('invalid star directions are retained with a validation flag',
  invalid.events[0].flags.includes('invalid-star-direction') && invalid.failures.length === 1);
const cleared = E.clear({ state: SAT.state, bus: SAT.bus });
ok('clear resets only the independent event state',
  cleared.status === 'idle' && cleared.events.length === 0 && SAT.state.scan === scanState);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
