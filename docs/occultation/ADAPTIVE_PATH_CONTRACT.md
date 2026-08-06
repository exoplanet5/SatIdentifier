# Adaptive satellite-path contract

**Scope:** P0-04 — `app/js/occultation/adaptive-path.js` and the
`SatellitePass` path handoff in `passes.js`

**Status:** accepted on the current SatIdentifier working branch

## Purpose

The worker's `Crossing.path` is a bounded display polyline with at most 64
samples. P0-04 keeps those UTC timestamps as the seed set, re-evaluates the
satellite direction through the canonical main-thread `SAT.prop.look()`, and
adds samples only where spherical interpolation is not accurate enough. This
is a representation-error contract; it is not a TLE uncertainty or occultation
probability model.

## API

The standalone scientific-core API is:

```js
const refined = SAT.occultation.adaptivePath.refine({
  path: [{ t, raDeg, decDeg }],
  startMs,
  endMs,
  anchorTimes: [culminationMs],
  evaluate: (utcMs) => ({ raDeg, decDeg }),
}, {
  toleranceArcsec: 1,
  maxSamples: 4096,
});
```

`t` and `startMs`/`endMs` are UTC Unix milliseconds. `raDeg` and `decDeg` are
J2000 mean-equator/mean-equinox directions in degrees; RA is normalized to
`[0, 360)` in the returned path and declination is in `[-90, 90]`. `evaluate`
must be synchronous and return the exact direction at the requested time, or
`null` when propagation fails. `anchorTimes` are optional timestamps that are
kept in the seed set; the pass culmination is supplied by `passes.js`.

The resolved pass input accepts:

```js
{
  pathToleranceArcsec: 1,
  pathMaxSamples: 4096,
}
```

`maxPathSamples` and `path: { toleranceArcsec, maxSamples }` are accepted as
input compatibility aliases. The public `SatellitePass` fields are:

```js
{
  path: [{ t, raDeg, decDeg }],
  pathMode: 'adaptive' | 'raw-worker',
  pathToleranceArcsec: number | null,
  pathTruncated: boolean,
  pathWorstErrorArcsec: number | null,
}
```

## Error metric and refinement

For each retained segment with unit directions `u_a` and `u_b`, the reference
direction at fraction `f` is spherical linear interpolation:

```text
u_ref(f) = slerp(u_a, u_b, f)
epsilon(f) = atan2(|u_true(f) × u_ref(f)|,
                   u_true(f) · u_ref(f)) × 206264.806247  arcsec
```

The implementation probes fractions `1/8`, `1/4`, `1/2`, `3/4`, and `7/8`.
A segment is accepted when the largest measured probe error is at most
`0.8 × pathToleranceArcsec`. Otherwise its midpoint is retained and the two
subsegments are tested recursively. The safety factor is an implementation
margin for the unprobed interior; the P0-04 harness additionally evaluates 99
independent points per final segment and requires the dense error to be no more
than `1.1 × tolerance`.

The returned `pathWorstErrorArcsec` is the largest probe residual on accepted
segments, or the largest residual measured before a budget/depth truncation.
It is a numerical interpolation diagnostic, not a confidence interval.

## Truncation and propagation failures

- `maxSamples` must be at least 2. If the sample budget or the fixed recursion
  depth prevents another split, `pathTruncated` is `true`; the path remains
  usable for drawing but the tolerance is not claimed.
- A missing object, missing `SAT.prop.look()`, or unavailable J2000 direction
  returns the copied raw-worker path with `pathMode: 'raw-worker'`, null error
  fields, and `adaptive-path-fallback` in `flags`. If the raw seed itself is
  longer than `maxSamples`, it is evenly bounded and `pathTruncated` is also
  true.
- A successful adaptive result with a capped budget adds
  `adaptive-path-truncated` to `flags`.
- The input `sourceCrossing` and its path are never mutated. One failed path does
  not abort discovery of other passes.

## Isolation and verification

The module has no DOM, file, network, or `SAT.state` side effects. It does not
run SGP4 itself; `SAT.prop.look()` remains the single propagation source. It
does not search stars, build spherical corridors, refine stellar closest
approach, assign probability, rank events, or publish state.

Focused checks:

```sh
node tools/test_adaptive_path.js
node tools/test_passes_adaptive.js
node tools/test_passes.js
```

The P0-04 checks cover a straight path, curved path, RA wrap, independent dense
truth validation, explicit sample-budget truncation, evaluator fallback, input
validation, pass integration, and provenance preservation.
