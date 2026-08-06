# P0-07 closest-approach refinement contract

**Scope:** `app/js/occultation/refine.js` and its handoff from P0-05 star
candidates plus the P0-04 `SatellitePass.path` representation.

**Status:** implemented and verified on the current SatIdentifier working tree

## Purpose

P0-07 converts a conservative corridor candidate into a time-dependent
satellite--star closest-approach result. It uses the P0-06 unit-sphere
distance only to select path segments and construct local time brackets. The
final time and angular separation are always evaluated from the caller's exact
J2000 satellite-direction function; `geometry.pathDistance().closestTMs` is
never promoted to the event time.

The module is a scientific core. It has no TLE, site, catalogue, DOM, network,
clock, file, or application-state dependency. P0-08 will bind `evaluate()` to
the existing `SAT.prop.look()` service and will decide how a returned result
becomes an `OccultationEvent`.

## API

```js
const result = SAT.occultation.refine.refine({
  pass: {
    passId: 'pass:25544:1000:3000',
    startMs: 1000,
    endMs: 3000,
    pathMode: 'adaptive',
    pathToleranceArcsec: 1,
    pathTruncated: false,
    path: [
      { t: 1000, raDeg: 10, decDeg: 20 },
      { t: 2000, raDeg: 10.1, decDeg: 20 },
      { t: 3000, raDeg: 10.2, decDeg: 20 },
    ],
  },
  candidate: { starKey: 'id:example', raDeg: 10.12, decDeg: 20 },
  evaluate: (tMs) => ({ raDeg: 10.12, decDeg: 20, rangeKm: 42000 }),
}, {
  timeToleranceMs: 0.05,
});
```

`evaluate(tMs)` is synchronous and receives a numeric UTC Unix timestamp in
milliseconds. It returns an exact J2000 direction as `{raDeg, decDeg}` or a
finite non-zero unit vector; extra fields are retained as
`closestGeometry`. A production adapter may call `SAT.prop.look()` and map its
J2000 `raDeg`/`decDeg` fields into this shape. The pure core does not construct
a `Date`, so deterministic tests can resolve fractional milliseconds.

`candidate` is the P0-05 star candidate schema. Its direction is treated as a
fixed J2000 catalogue position in P0. Proper-motion propagation, if added in
a later stage, belongs in the star-direction contract rather than being
silently invented here.

The optional `pass` object supplies `path`, `startMs`, `endMs`,
`pathMode`, `pathToleranceArcsec`, and `pathTruncated`. Top-level `path`,
`startMs`, and `endMs` are accepted for focused scientific tests.

## Result schema

Successful results contain:

```js
{
  status: 'ok', complete: true,
  tCaMs,
  nominalSeparationArcsec,
  distanceArcsec,             // alias of nominalSeparationArcsec
  closestVector,
  closestGeometry,
  coarseTMs,
  coarseDistanceArcsec,
  bracket: { startMs, endMs },
  bracketWidthMs,
  searchStartMs, searchEndMs,
  pathToleranceArcsec,
  evaluations, iterations,
  segmentsConsidered, segmentsSelected, segmentsRefined,
  flags: [], error: null,
}
```

All angles are arcseconds unless a field ends in `Deg` or `Rad`; all times are
UTC Unix milliseconds. `tCaMs` may be fractional because the scientific core
accepts a numeric evaluator. `closestGeometry` is the exact evaluator return
value at `tCaMs`, not a copied path sample. `coarseTMs` and
`coarseDistanceArcsec` are diagnostics from the spherical path and are not
the refined solution. Inputs and caller-owned path rows are copied and never
mutated.

Runtime evaluator failures and explicit work-budget exhaustion return
`{status: 'failed', complete: false}` with the best evaluated sample retained
when one exists. Invalid input schema and invalid numerical options throw
before a scientific result is claimed.

## Numerical method

For fixed catalogue direction `q` and exact satellite direction `s(t)`, the
objective is

```text
d(t) = atan2(|s(t) × q|, s(t) · q) × 206264.806247 arcsec.
```

The solver computes the geometric distance of every available path segment.
For an untruncated adaptive path with interpolation tolerance `T`, a segment
whose geometric distance is greater than

```text
bestGeometricDistance + 2T + coarseMarginArcsec
```

cannot contain the global exact minimum under the spherical triangle
inequality, apart from the explicit numerical margin. Each retained segment
is then minimized over its full UTC interval by a golden-section search. The
bracket stops when its width is at most `timeToleranceMs`, or the configured
iteration/evaluation budget is reported as incomplete.

Unverified or truncated paths do not use the tolerance-based segment screen;
the solver refines every available positive-time segment until
`maxSegments`/`maxEvaluations` is reached. The result exposes the provenance
flags instead of silently asserting an adaptive error bound.

## Boundary and failure flags

- `path-precision-unverified`: the pass is not an untruncated adaptive path;
- `path-truncated`: the pass reports a capped adaptive representation;
- `path-boundary-evaluated`: an explicit search boundary was not present in the
  supplied path and was evaluated directly;
- `segment-budget`: `maxSegments` limited the selected intervals;
- `time-iteration-limit`: a bracket did not reach `timeToleranceMs`;
- `evaluation-failed`: the exact direction evaluator threw or returned an
  invalid direction;
- `evaluation-budget`: `maxEvaluations` was exhausted;
- `no-segments`: no positive-time segment was available.

## Verification

```sh
node --check app/js/occultation/refine.js
node tools/test_refine.js
python3 tools/run_tests.py
```

The focused harness uses a deterministic smooth quadratic synthetic trajectory
whose exact minimum differs by more than 100 ms from the old linear
`closestTMs` diagnostic. It verifies exact time refinement, a fixed
cross-track miss, adaptive-path segment screening, endpoint minima, RA-wrap and
polar directions, evaluator failure isolation, explicit budgets, validation,
path immutability, and state isolation. The observed synthetic time error is
about `0.002 ms`, below the P0-07 acceptance target of `0.2 ms`.
