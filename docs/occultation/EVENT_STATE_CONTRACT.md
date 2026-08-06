# P0-08 occultation event-state contract

**Scope:** `app/js/occultation/look-adapter.js`,
`app/js/occultation/event-assembly.js`, and
`app/js/occultation/event-state.js`

**Status:** implemented and verified on the current SatIdentifier working tree

## Purpose

P0-08 is the main-thread handoff from a `SatellitePass` plus an OCCSTAR1 star
candidate to a time-refined occultation candidate. It binds the exact direction
evaluator to the existing `SAT.prop.look()` implementation, calls the P0-07
closest-approach solver, and publishes a separate `SAT.state.occultation`
namespace.

It does not run a worker scan, query the star catalogue, modify
`SAT.state.scan`, publish ordinary `scan-*` events, or claim that a candidate is
an observed occultation. Contact timing, satellite angular diameter,
probability, ranking, and UI remain later-stage responsibilities.

## Exact look binding

```js
const adapter = SAT.occultation.eventState.bindLook({
  site: { kind: 'ground', latDeg: -37.8, lonDeg: 145.0, altM: 30 },
  pass: satellitePass,
}, { refraction: false, dut1S: 0 });

const geometry = adapter.evaluate(tMs);
```

`evaluate(tMs)` receives a numeric UTC Unix timestamp in milliseconds and calls

```text
SAT.prop.look(site, object, new Date(round(tMs)), {refraction, dut1S})
```

where `object` is resolved by `satId` or `norad` from the loaded catalogue.
The returned object must contain finite J2000 `raDeg` and `decDeg`; all other
finite look fields, including range, rates, shadow, and TEME vectors, are
retained by P0-07 as `closestGeometry`. A propagation failure returns `null`
and becomes an incomplete event rather than aborting the batch. The explicit
`dateResolutionMs: 1` evaluator metadata records the `Date` millisecond
quantisation.

The default `refraction: false` matches the occultation pass/path geometry. The
option is forwarded consistently when a caller explicitly selects another
value; DUT1 is forwarded in seconds.

## Assembly API

```js
const result = SAT.occultation.eventState.build({
  site,
  passes: [satellitePass],
  candidates: [{
    passId: satellitePass.passId,
    starKey: 'id:example',
    catalogueId: 'example',
    raDeg: 10.12,
    decDeg: 20.0,
    mag: 8.4,
    sourceSegments: [2],
  }],
}, {
  timeToleranceMs: 0.05,
  contactsOnly: true,
});
```

The builder also accepts an OCCSTAR1 search result with
`results[].sourcePass` and `results[].candidates`. A flat candidate is matched
by `passId`; when exactly one pass is supplied, a missing candidate `passId`
uses that pass deterministically. Candidates are deduplicated by
`passId + NUL + starKey` and event IDs are
`event:<passId>:<starKey>`.

`contactsOnly: true` is an output filter applied after the exact P0-07/P0-09
calculation. It retains only complete events whose `contact` is true and whose
`contactStatus` is `contact` or `grazing`; it does not narrow the conservative
OCCSTAR1 cone query or claim a probabilistic detection. Filtered misses and
incomplete candidates are counted in `stats.filteredEvents`,
`stats.filteredMisses`, and `stats.filteredIncomplete`, while the published
`events`, `candidates`, and `passes` arrays contain only retained contacts.

Each successful event has the following important fields:

```js
{
  eventId: 'event:pass:25544:...:id:example',
  kind: 'occultation-candidate',
  status: 'candidate',
  refinementStatus: 'ok',
  complete: true,
  passId, satId, norad, name, cls, orbitClass, type, starKey, candidate,
  tCaMs, closestApproachMs,
  azDeg, elDeg,
  nominalSeparationArcsec, distanceArcsec,
  closestGeometry, closestVector,
  bracket, bracketWidthMs,
  pathMode, pathToleranceArcsec,
  flags, error, refinement,
}
```

`tCaMs` and `bracket` come from P0-07. `closestGeometry` is the exact
`SAT.prop.look()` return at the selected solver sample, not a copied path row.
`azDeg` and `elDeg` are copied from that exact closest-approach geometry. `cls`
and `orbitClass` are the SatIdentifier orbital-class scan tag; `type` is the
SATCAT object type. Incomplete events expose null geometry fields.
The event status deliberately remains `candidate`; a small separation alone is
not yet a physical occultation claim.

Invalid directions, missing passes/sites/objects, unavailable services, look
failures, and P0-07 incomplete results are retained with `status:
'incomplete'`, `complete: false`, explicit flags, and a failure record. Other
candidates continue to be refined.

## Independent state

`build()` is side-effect free with respect to application state. `commit()` or
`resolve()` publishes a JSON-safe state under `SAT.state.occultation`:

```js
{
  version: 'p0-08',
  status: 'idle' | 'empty' | 'ok' | 'partial',
  complete,
  stale,
  updatedAtMs,
  site,
  options,
  passes,
  candidates,
  events,
  failures,
  stats,
}
```

The statistics also retain the distinction between evaluated and published
records: `evaluatedCandidates`, `evaluatedEvents`, `filteredCandidates`, and
`retainedPasses` are populated when the contacts-only filter is active.

The state object is transient and intentionally excluded from `state.js`
persistence in P0-08. `clear()` resets only this namespace. Publication emits
`occultation-state-changed` when the application event bus is available; no
ordinary scan event is emitted. Input passes, paths, candidates, and runtime
catalogue caches are copied, so later caller mutation cannot rewrite the
published event state.

## Verification

```sh
node --check app/js/occultation/look-adapter.js
node --check app/js/occultation/event-assembly.js
node --check app/js/occultation/event-state.js
node tools/test_event_state.js
python3 tools/run_tests.py
```

The focused harness verifies the `SAT.prop.look()` call boundary, exact-time
handoff, geometry retention, deterministic IDs, search-result association,
ordinary scan-state isolation, detached provenance, scoped publication, missing
object handling, invalid-star handling, and clear semantics.
