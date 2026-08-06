# Occultation implementation log

## P0-00 — Offline regression baseline

**Date:** 2026-08-05

**Branch:** `codex/p0-00-offline-regression`

**Upstream base:** `main@351bbb89ee987b31ae3fb62f92ca0fe5ef9d3f5b`

### Implemented

- Added the frozen `tools/fixtures/mini_catalog.tle` with 87 TLE records
  spanning LEO, GEO, MEO, and HEO.
- Added `tools/run_tests.py`, a standard-library-only runner that discovers
  `tools/test_*.js`, executes each test from the repository root, streams output,
  and reports child exit codes.
- Changed `tools/test_scan.js` to use the committed fixture by default. An
  explicitly supplied local TLE path remains available for investigation, but
  no network or temporary catalogue fallback remains.
- Added `OCCULTATION_CONTRACT.md`, this log, `DECISIONS.md`, `CHANGELOG.md`, and
  `.github/pull_request_template.md` as the P0-00 change-tracking surface.

### Scope guard

No production file under `app/js/` was changed. No `runRaw()` API, occultation
pipeline, night-window calculation, UI state, probability model, or ranking
logic was introduced.

### Verification record

- Fixture validation: 87 records; all 174 TLE lines are 69 characters and have
  valid modulo-10 checksum digits.
- `node tools/test_scan.js`: all checks passed with the committed fixture.
- `python3 tools/run_tests.py --list`: discovered 8 JavaScript harnesses in
  stable lexical order.
- `python3 tools/run_tests.py`: all 8 discovered harnesses passed without
  network access (`test_chart.js`, `test_crossings.js`, `test_frames.js`,
  `test_pointing.js`, `test_ports.js`, `test_propagate.js`, `test_scan.js`, and
  `test_stars.js`).
- The scan fixture produced 46 wide-field crossings, 10 narrow-field
  crossings, 10 GEO candidates in the GEO-rate field, and passed all cull
  soundness, coarse-sweep recall, orbital-station visibility/occlusion, and
  self-exclusion checks.

## P0-01 — Isolated raw scan API

**Date:** 2026-08-05

**Scope:** add `SAT.scan.runRaw()` only; no night-window, occultation state,
pipeline, probability, ranking, or UI implementation.

### Implemented

- Added `SAT.scan.runRaw(params, options)` to the existing Worker-pool scan
  module. It shares the ordinary running lock and `SAT.scan.cancel()` path.
- Added a raw merge boundary that sorts worker geometry by `tCaMs`, applies
  `maxResults` after shard merging, and returns explicit cull, propagation,
  timing, and truncation metadata without main-thread photometry enrichment.
- Added scoped raw events (`scan-raw-*` by default, or the caller's non-`scan`
  prefix) while preserving the ordinary `scan-*` channel for `run()`.
- Added `tools/test_run_raw.js`, including a deterministic Worker double for
  state-isolation, event-separation, lock, cancellation, pool-reuse, and
  ordinary-run regression checks.

### Scope guard

No `SAT.state.occultation`, night-window logic, pass normalization, star
catalogue, probability model, ranking logic, or UI was introduced. The
P0-00 fixture and production worker scan algorithm remain unchanged.

### Verification record

- `node tools/test_run_raw.js`: all focused raw-scan checks passed.
- `python3 tools/run_tests.py --list`: discovers 9 harnesses, including the
  new raw-scan harness.
- `python3 tools/run_tests.py`: all 9 JavaScript harnesses passed offline.
- The existing `test_scan.js` retained its 87-object, four-family fixture
  checks, including cull soundness, coarse-sweep recall, GEO rates, orbital
  visibility/occlusion, and self-exclusion.

## P0-02 — Deterministic night windows

**Date:** 2026-08-05

**Scope:** add the pure `app/js/occultation/night.js` module only; no pass
normalization, star search, probability, ranking, or occultation UI.

### Implemented

- Added `SAT.occultation.night.windowsForDate()` with explicit `normal`,
  `polar-night`, and no-night (`[]`) semantics. `describeDate()` supplies the
  no-night status without inventing a `NightWindow` kind outside the accepted
  contract.
- Converted IANA local civil dates to UTC without reading the host time zone,
  including DST-aware local midnight/noon boundaries and Gregorian date rollover.
- Added a dependency-free high-accuracy solar-altitude core using compact Earth
  VSOP terms, nutation, obliquity, solar parallax, and configurable DUT1. Boundary
  brackets are sampled at 10 s and refined by bisection to 10 ms.
- Loaded the module in `app/index.html` without touching ordinary `SAT.state`
  or `SAT.scan` behavior. Added `NIGHT_WINDOW_CONTRACT.md` and the focused
  `tools/test_night.js` harness.

### Scope guard

No `SAT.state.occultation`, pass normalization, raw scan invocation, star
catalogue, probability model, ranking logic, or UI was introduced. The existing
P0-00 fixture, worker scan algorithm, and P0-01 raw-scan boundary remain
unchanged.

### Verification record

- `node tools/test_night.js`: all P0-02 checks passed, including Melbourne
  winter/summer DST, independent UTC boundaries within 1 s, boundary residuals,
  Gregorian rollover, polar day, polar night, and invalid-input handling.
- `node tools/test_night.js` leaves `SAT.state` undefined, proving the module's
  state-isolation boundary in the standalone harness.

## P0-03 — Deterministic satellite passes

**Date:** 2026-08-06

**Scope:** add `app/js/occultation/passes.js` only; no adaptive path, star
catalogue, stellar closest approach, probability, ranking, state, or UI.

### Implemented

- Added `SAT.occultation.passes.discover()` to obtain NightWindows from
  `SAT.occultation.night` and run the existing `SAT.scan.runRaw()` worker path
  once per UTC night interval.
- Encoded the P0 ground-site search as a fixed zenith mount with a circular
  radius of `90° - minimumElevationDeg` and the matching worker elevation gate.
  Orbit sites are rejected explicitly.
- Normalized raw crossings into clipped `SatellitePass` records with stable
  identifiers, ordered UTC boundaries, look-based culmination/max-elevation,
  range, shadow, orbit class, TLE age, and source-crossing provenance.
- Preserved the worker's bounded path as `pathMode: 'raw-worker'`; adaptive
  path tolerance fields remain null until P0-04. A missing object or failed
  propagation falls back to raw geometry and records `culmination-fallback`.
- Added `docs/occultation/PASSES_CONTRACT.md` and the deterministic focused
  harness `tools/test_passes.js`.

### Scope guard

The module does not create or mutate `SAT.state.occultation` or ordinary scan
state, and it does not begin star search, spherical corridors, stellar closest
approach, probability, ranking, or UI work.

## P0-04 — Adaptive satellite paths

**Date:** 2026-08-06

**Scope:** add the bounded adaptive path scientific core and connect it to the
P0-03 `SatellitePass` normalization boundary. No star catalogue, spherical
corridor, closest approach, probability, ranking, state, or UI was added.

### Implemented

- Added `app/js/occultation/adaptive-path.js`, which consumes the raw worker
  path timestamps and exact synchronous J2000 directions supplied by
  `SAT.prop.look()`.
- Uses unit-vector spherical linear interpolation and five interior probes per
  segment. Segments are recursively bisected when the measured residual exceeds
  `0.8 * pathToleranceArcsec`; the requested tolerance and maximum sample count
  are resolved in `passes.js`.
- Added culmination as a retained path anchor, explicit `pathMode`,
  `pathToleranceArcsec`, `pathWorstErrorArcsec`, and `pathTruncated` fields, plus
  fallback/truncation flags. The raw crossing object is retained without
  mutation.
- Loaded the module before `passes.js` and kept all work isolated from ordinary
  scan state and `SAT.state.occultation`.
- Added deterministic module and integration harnesses for spherical error,
  RA-wrap, dense truth validation, truncation, propagation fallback, input
  validation, and source provenance.

### Verification record

- `node tools/test_adaptive_path.js`: passed; independent dense validation is
  within `1.1 * tolerance`.
- `node tools/test_passes_adaptive.js`: passed; adaptive pass integration and
  explicit maximum-sample truncation are covered.
- `node tools/test_passes.js`: passed; the P0-03 service double without J2000
  path directions correctly remains on the raw-worker fallback.

## P0-05 — OCCSTAR1 star candidates

**Date:** 2026-08-06

**Scope:** add the stateless star-candidate handoff only. The module consumes
P0-04 `SatellitePass` paths and the existing `SAT.stars.cone()` provider. It
does not solve stellar closest approach, contact times, angular diameter,
probability, ranking, state, or UI.

### Implemented

- Added `app/js/occultation/star-candidates.js` and loaded it after the pass
  and adaptive-path modules in `app/index.html`.
- Queries each path segment at its spherical midpoint with a conservative
  radius of half the segment arc plus the configured corridor padding and the
  verified adaptive path tolerance. This handles RA=0 wrapping without a
  longitude-linear shortcut and intentionally permits false positives for the
  later closest-approach stage.
- Deduplicates catalogue rows across overlapping segment queries, retains
  `sourcePass`, segment provenance, optional catalogue IDs, query metadata, and
  explicit incomplete/truncated flags. A raw-worker path remains searchable but
  cannot claim completeness without caller-supplied fallback padding.
- Added `tools/test_star_candidates.js` with deterministic catalogue doubles;
  no browser star asset or network access is required.

### Verification record

- `node tools/test_star_candidates.js`: all focused OCCSTAR1 checks passed.
- `python3 tools/run_tests.py --list`: discovers 14 JavaScript harnesses,
  including `test_star_candidates.js`.
- `node --check app/js/occultation/star-candidates.js` and the focused harness:
  passed.
- `python3 tools/run_tests.py`: all 14 discovered offline harnesses passed.
- `git diff --check`: passed.

## P0-06 — Spherical tube geometry

**Date:** 2026-08-06

**Scope:** add the pure `app/js/occultation/geometry.js` spherical core and
route P0-05's segment-envelope construction through it. No closest-approach
solver, event state, probability, ranking, or UI was added.

### Implemented

- Added stable unit-vector conversion, spherical interpolation, angular
  separation, minor-arc point distance, polyline distance, and conservative
  midpoint-cone envelopes in one dependency-free module.
- Added explicit whole-sphere fallback for near-antipodal endpoints, avoiding a
  false narrow corridor when the minor-arc midpoint is numerically ambiguous.
- Added `pointInTube()`/`pathDistance()` for the later closest-approach stage;
  `closestTMs` is documented as a geometric diagnostic rather than a solver.
- Updated `star-candidates.js` to use the shared envelope implementation while
  preserving the P0-05 query radius, candidate schema, flags, and provenance.
- Loaded the core in `app/index.html`, added the P0-06 contract/progress page,
  and added `tools/test_geometry.js`.

### Verification record

- `node --check app/js/occultation/geometry.js`: passed.
- `node tools/test_geometry.js`: passed analytic, RA-wrap, polar, degenerate,
  antipodal, deterministic random-envelope, and dense brute-force recall checks.
- `node tools/test_star_candidates.js`: passed with the shared geometry core;
  the existing P0-05 query-radius assertion remains unchanged.

## P0-07 — Stellar closest-approach refinement

**Date:** 2026-08-06

**Scope:** add the pure time-dependent closest-approach scientific core. The
module consumes a P0-05 candidate, a P0-04 path, and a caller-supplied exact
J2000 direction evaluator. It does not bind `SAT.prop.look()`, write event
state, calculate probability, or add UI.

### Implemented

- Added `app/js/occultation/refine.js` with `SAT.occultation.refine.refine()`
  and `.solve()` aliases.
- Uses P0-06 point-to-segment distances for conservative segment selection,
  then minimizes exact angular separation with a bounded golden-section search.
  `geometry.pathDistance().closestTMs` remains a diagnostic only.
- Added explicit final time brackets, fractional-millisecond results, exact
  evaluator geometry handoff, path-precision flags, work budgets, runtime
  failure isolation, and state/path immutability.
- Loaded the module after the existing occultation scientific cores and added
  `docs/occultation/CLOSEST_APPROACH_CONTRACT.md`,
  `docs/occultation/P0-07_PROGRESS.md`, and `tools/test_refine.js`.

### Verification record

- `node --check app/js/occultation/refine.js`: passed.
- `node tools/test_refine.js`: passed analytic exact-time, fixed-miss,
  adaptive-screening, endpoint, RA-wrap, polar, failure, budget, and
  state-isolation checks.
- `python3 tools/run_tests.py`: all 16 discovered JavaScript harnesses passed
  offline.
- The synthetic trajectory recovered the true closest time within 0.002 ms and
  the 0.5 arcsec miss within 4e-9 arcsec; this is below the P0-07 acceptance
  thresholds of 0.2 ms and 0.01 arcsec.

## P0-08 — Look binding and independent occultation event state

**Date:** 2026-08-06

**Scope:** bind P0-07 to the canonical main-thread `SAT.prop.look()` service
and assemble a transient `SAT.state.occultation` namespace. Ordinary scan
state, ordinary scan events, persistence, contact timing, probability, ranking,
and UI remain outside this stage.

### Implemented

- Added `app/js/occultation/look-adapter.js` for pass/object/site resolution and
  exact J2000 look evaluation. It rounds fractional solver samples to the
  nearest UTC millisecond before calling `SAT.prop.look()` and preserves the
  complete look geometry returned at the solver minimum.
- Added `app/js/occultation/event-assembly.js` for deterministic candidate
  deduplication, P0-07 invocation, event IDs, event ordering, provenance, and
  per-candidate incomplete results.
- Added `app/js/occultation/event-state.js` with `build`, `commit`, `resolve`,
  `clear`, and `SAT.occultation.events` compatibility alias. Published state is
  copied and isolated from `SAT.state.scan`.
- Loaded the three modules after `refine.js` and added
  `docs/occultation/EVENT_STATE_CONTRACT.md`, `docs/occultation/P0-08_PROGRESS.md`,
  and `tools/test_event_state.js`.

### Verification record

- All three new modules pass `node --check`.
- `node tools/test_event_state.js`: passed look-call boundary, exact solver
  handoff, state isolation, deterministic provenance, search-result association,
  missing-object, invalid-star, publication, and clear checks.
- `python3 tools/run_tests.py`: all 17 discovered offline harnesses passed.
- `git diff --check`: passed.

## P0-09 — Angular diameter and physical contact timing

**Date:** 2026-08-06

**Scope:** extend the P0-08 candidate handoff with an effective satellite disc,
apparent angular diameter, and geometric ingress/egress timing. Probability,
ranking, persistence, UI, spacecraft shape, stellar diameter, and seeing remain
out of scope.

### Implemented

- Added `app/js/occultation/satellite-size.js` with one documented radius
  precedence: explicit radius, object radius/diameter, RCS equivalent sphere,
  SATCAT type prior, then a flagged 1 m default or an explicit unknown-size
  rejection.
- Added `app/js/occultation/contact.js`. For each exact evaluator sample it
  computes `alpha(t) = asin(r / R(t))`, compares it with the J2000 star/satellite
  separation, and bisects each sign-changing boundary. Final brackets, contact
  intervals, pass clipping, size provenance, work budgets, and evaluator/range
  failures are retained.
- Extended `event-assembly.js` and `event-state.js` to version `p0-09` while
  preserving P0-08 event IDs, candidate kind, closest geometry, and independent
  `SAT.state.occultation` publication. Ordinary scan state remains untouched.
- Added `docs/occultation/CONTACT_CONTRACT.md`,
  `docs/occultation/P0-09_PROGRESS.md`, and `tools/test_contact.js`.

### Verification record

- `node --check` passed for the new modules and the P0-08 handoff modules.
- `node tools/test_contact.js` passed analytic angular-size, ingress/egress,
  RCS/type provenance, miss, clipping, unknown-size, validation, and failure
  checks.
- `node tools/test_event_state.js` passed with P0-09 contact fields while
  retaining ordinary scan-state isolation.
- `python3 tools/run_tests.py` passed all 18 discovered offline harnesses.
- `git diff --check` passed.

## P0-10 — No-miss recall and benchmark

**Date:** 2026-08-06

**Scope:** add an independent offline recall/benchmark harness for the complete
deterministic candidate path. No production UI, probability, ranking, or
uncertainty model was added.

### Implemented

- Added `tools/fixtures/p0_10_catalog.tle` with 13 fixed LEO/MEO/GEO-family
  regression records and `p0_10_bright_stars.json` with 24 fixed `V <= 4.6`
  J2000 star directions.
- Added `tools/no_miss_benchmark.js` and `no_miss_fixture.js`. The optimized
  side runs the production worker core through `passes.discover()`, adaptive
  path construction, and OCCSTAR1. The truth side calls `SAT.prop.look()` for
  every object at every 500-ms UTC sample over the complete NightWindow and
  compares every visible sample with every fixture star using `frames.sep()`.
- Added explicit pair-level comparison, propagation counts, distance checks,
  candidate/query/cull counts, elapsed times, fixture hashes, environment/Git
  metadata, and process-memory snapshots.
- Added `NO_MISS_BENCHMARK_CONTRACT.md`, `P0-10_PROGRESS.md`, ADR-0009, and
  `tools/test_no_miss.js`. The existing offline runner discovers the new test.

### Verification record

- `node --check tools/no_miss_fixture.js`: passed.
- `node --check tools/no_miss_benchmark.js`: passed.
- `node tools/test_no_miss.js --json`: passed with 19 dense-truth pairs, 24
  optimized pairs, 5 conservative extras, and zero missing pairs.
- The same run reported 18,863 optimized worker propagations, 1,130,649 dense
  truth propagations, 3,264,408 exact spherical-distance checks, and 24
  optimized candidate records.
- `git diff --check` passed after the implementation and documentation changes.

### Scope guard

The 1000-arcsec corridor is an explicit non-vacuous benchmark configuration,
not a physical occultation radius. P0-10 does not estimate probability, TLE
uncertainty, seeing, ranking, or contact detectability.

## P0-11 — Production pipeline and occultation UI

**Date:** 2026-08-06

**Scope:** connect the completed deterministic core to one cancellable browser
workflow and three independent visualization/export windows.

### Implemented

- Added `app/js/occultation/pipeline.js`. It calls P0-03/P0-04 pass discovery,
  P0-05 OCCSTAR1, and P0-08/P0-09 event assembly exactly once and publishes only
  after the final immutable payload exists.
- Added `occultation-*` lifecycle/progress events, cancellation delegation to
  `SAT.scan.cancel()`, stage timings/counts, explicit partial flags, and the
  rule that failed/cancelled runs do not clear the previous occultation state.
- Added `plan-ui.js`, `events-ui.js`, and `chart-ui.js`; registered them as
  independent windows in `main.js` and loaded them after the scientific modules.
  The table exports JSON/CSV and the chart is a local tangent-plane diagnostic
  of the represented path, star, closest point, and conservative corridor.
- Forwarded deterministic event timestamps, made truncation partial even when
  it yields zero events, and made the event table follow the run's IANA zone.
- Added `OCCULTATION_PIPELINE_CONTRACT.md`, `P0-11_PROGRESS.md`, ADR-0010, and
  `tools/test_pipeline.js`.

### Verification record

- `node --check` passed for all four new JavaScript modules.
- `node tools/test_pipeline.js` passed complete ordering/publication, no-night
  short-circuiting, partial provenance (including truncated empty results),
  deterministic event time, failure isolation, and cancellation.
- `python3 tools/run_tests.py` passed all 20 regression test suites, including
  the 165-item Crossings harness; `git diff --check` passed.
- Browser smoke loaded all three windows with no console warnings or errors.

### Scope guard

P0-11 does not estimate calibrated probability, rank events, persist transient
occultation state, add TLE uncertainty distributions, or replace ordinary
crossings/Sky Chart behavior.
