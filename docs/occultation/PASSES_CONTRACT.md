# Satellite-pass contract

**Scope:** P0-03 pass discovery plus P0-04 adaptive-path handoff

**Status:** accepted on the current SatIdentifier working branch

## API

```js
const result = await SAT.occultation.passes.discover({
  site: { latDeg: -37.8136, lonDeg: 144.9631, altM: 30 },
  localDate: '2026-07-23',
  timeZone: 'Australia/Melbourne',
  sunAltitudeLimitDeg: -12,
  minimumElevationDeg: 20,
  coarseStepS: 30,
  fineStepS: 1,
  pathToleranceArcsec: 1,
  pathMaxSamples: 4096,
  passOptions: { classes: ['leo', 'geo'], types: ['PAY', 'DEB'] },
  maxResults: 100000,
});
```

`site` may be supplied at the top level for the same compatibility shape as
`night.js`. P0-03 accepts ground sites only. A site with `kind: 'orbit'` fails
explicitly; it is never silently interpreted as a ground station.

`discover()` returns:

```js
{
  status: 'ok' | 'no-night',
  config: { ...resolved input..., site },
  windows: NightWindow[],
  passes: SatellitePass[],
  rawResults: [{ window, params, raw }],
  stats: {
    windows, rawCrossings, passes, rejected, truncated,
    culled, propagations, ms, rawAuditCompacted,
  },
}
```

The optional second argument is a test-only service override for `night`,
`scan`, `prop`, `path`, and `state`. Normal callers use
`SAT.occultation.night`, `SAT.scan`, `SAT.prop`,
`SAT.occultation.adaptivePath`, and `SAT.state`.

## Raw scan mapping

For every NightWindow `[startMs, endMs)`, `passes.js` invokes
`SAT.scan.runRaw()` with:

```js
{
  t0Ms: startMs,
  spanMin: (endMs - startMs) / 60000,
  site: { kind: 'ground', latDeg, lonDeg, altM },
  pointing: { track: 'mount', mode: 'altaz', azDeg: 0, elDeg: 90 },
  fov: { shape: 'circ', rDeg: 90 - minimumElevationDeg },
  filters: {
    minElDeg: minimumElevationDeg,
    classes: satelliteClasses,
    types: satelliteTypes,
  },
  steps: { coarseStepS, fineStepS, marginDeg },
  dut1S,
}
```

The zenith azimuth is set to zero because azimuth is undefined exactly at the
zenith; it has no effect on a circular zenith field. The complementary radius
and the worker elevation filter describe the same geometric domain:

```text
zenith distance <= 90° - h_min  and  elevation >= h_min.
```

All scan times are UTC Unix milliseconds. The local civil date and IANA time
zone are consumed only by `night.js`. A no-night result returns without calling
`runRaw()`.

## SatellitePass

Each valid raw crossing is clipped to its NightWindow and normalized as follows.
P0-03 uses the raw worker path as the initial representation; P0-04 may replace
it with a verified adaptive path when `SAT.prop.look()` can return J2000 RA/Dec:

```js
{
  passId,
  satId, norad, name, intl, cls, type,
  startMs, culminationMs, endMs,
  maxElevationDeg, minRangeKm, azDeg, elDeg,
  tleAgeDays, orbitClass,
  shadowAtCulmination, sunElevationDeg,
  path: [{ t, raDeg, decDeg }],
  pathMode: 'adaptive' | 'raw-worker',
  pathToleranceArcsec: number | null,
  pathTruncated: boolean,
  pathWorstErrorArcsec: number | null,
  sourceCrossing,
  flags,
}
```

The scan classification tags are the four orbital classes (`leo`, `meo`, `geo`,
`heo`) and the three known SATCAT object types (`payload`, `rocket body`,
`debris`, represented in data as `PAY`, `R/B`, and `DEB`). The optional mixed
input form `passOptions.tags` accepts these same seven labels and is split into
`classes` and `types` before the worker scan. Catalogue source names are not
part of occultation filtering.

The following invariants are required:

- `window.startMs <= startMs <= culminationMs <= endMs <= window.endMs`;
- `maxElevationDeg >= minimumElevationDeg`;
- `culminationMs` is selected by bounded maximization of `SAT.prop.look()`
  elevation over the clipped pass interval, not by interpreting
  `90 - sepCaDeg` as the final answer;
- `tleAgeDays` is the absolute TLE epoch difference in days at
  `culminationMs` when the object metadata and propagation service are
  available;
- `sourceCrossing` is retained without mutation for audit and later path work on
  exact-size runs. When a window exceeds `exactPassLimit` and uses the deferred
  raw-worker representation, the pass retains a scalar copy with
  `pathOmittedFromAudit: true`; its normalized `pass.path` remains available to
  OCCSTAR1/P0-07, and the discovery `rawResults[].raw` record retains counts and
  culling accounting while setting `rawCrossingsOmitted: true`.
- P0-03/P0-04 do not assign a probability, star match, candidate rank, or TLE
  uncertainty claim.

`SAT.prop.look()` is evaluated with the configured `refraction` option, which
defaults to `false` so the minimum-elevation gate remains geometric and agrees
with the worker's `elSin` filter. If the object cannot be found or propagation
fails, the raw crossing's geometry is retained with `culmination-fallback` in
`flags`; one failed satellite does not abort the other passes.

The worker's existing path samples are copied as the P0-04 seed set. When the
canonical `SAT.prop.look()` direction evaluator is available,
`SAT.occultation.adaptivePath.refine()` adds samples until its spherical
interpolation residual is below the requested tolerance, or marks
`pathTruncated`. If the direction cannot be verified, the raw path is retained
with `pathMode: 'raw-worker'`, null error fields, and an explicit fallback flag.
For exact-size runs `sourceCrossing` remains the unmodified audit record. The
deferred compaction is a memory-boundary choice and does not assert adaptive
path precision.

## Isolation and verification

The module does not create or write `SAT.state.occultation`, ordinary scan
state, checked rows, files, or DOM nodes. It only consumes the raw-scan API and
returns an explicit result object.

Focused and full checks:

```sh
node tools/test_passes.js
python3 tools/run_tests.py
```

The focused harness checks the zenith/FOV mapping, UTC span conversion, raw
scan invocation, clipping, culmination ordering and look-based maximum,
metadata, malformed-crossing rejection, no-night short-circuit, orbit-site
rejection, and state isolation. P0-04 adds
`tools/test_adaptive_path.js` and `tools/test_passes_adaptive.js` for the
spherical error/tolerance and truncation contract.
