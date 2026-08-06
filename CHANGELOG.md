# Changelog

## Unreleased — P0-11 production pipeline and occultation UI (2026-08-06)

- Added the deterministic pipeline that connects nightly passes, conservative
  star candidates, closest approach, and geometric contact into one cancellable
  workflow with explicit stage provenance and failure isolation.
- Added independent Occultation Plan, Occultation Events, and Occultation Chart
  windows with CSV/JSON export and the fixed no-probability P0 disclosure.
- Added `OCCULTATION_PIPELINE_CONTRACT.md`, `P0-11_PROGRESS.md`, and the focused
  `tools/test_pipeline.js` harness. Ordinary crossings/state remain isolated.

## Unreleased — P0-10 no-miss recall and benchmark (2026-08-06)

- Added frozen small TLE and bright-star fixtures for an offline full-night
  optimized-versus-dense-truth comparison.
- Added propagation, spherical-distance, candidate, elapsed-time, cull, and
  process-memory accounting to the benchmark evidence.
- Added `NO_MISS_BENCHMARK_CONTRACT.md`, `P0-10_PROGRESS.md`, and the
  `tools/test_no_miss.js` regression harness.
- The acceptance relation is `optimizedCandidates ⊇ bruteForceCandidates`; extra
  conservative candidates are retained, and missing pairs fail the test.

## Unreleased — P0-09 angular diameter and contact timing (2026-08-06)

- Added the disclosed effective satellite-size model and angular radius/diameter
  conversion for occultation candidates.
- Added bounded physical contact timing with ingress/egress brackets, duration,
  pass-boundary clipping, multiple-interval provenance, and failure flags.
- Extended the independent occultation event payload to `version: 'p0-09'` while
  preserving P0-08 candidate semantics and ordinary scan-state isolation.
- Added `CONTACT_CONTRACT.md`, `P0-09_PROGRESS.md`, and `tools/test_contact.js`.
- Probability, ranking, persistence, UI, spacecraft shape, stellar diameter, and
  seeing remain out of scope.

## Unreleased — P0-08 look binding and independent event state (2026-08-06)

- Added the main-thread `SAT.prop.look()` adapter and P0-07 handoff for exact
  J2000 satellite directions.
- Added deterministic occultation-candidate assembly with retained closest
  geometry, solver brackets, provenance, and per-candidate failure flags.
- Added transient `SAT.state.occultation` publication isolated from ordinary
  scan state and `occultation-state-changed` notifications.
- Added `EVENT_STATE_CONTRACT.md`, `P0-08_PROGRESS.md`, and
  `tools/test_event_state.js`.
- Contact timing, probability, ranking, persistence, and UI remain out of scope.

## Unreleased — P0-07 stellar closest-approach refinement (2026-08-06)

- Added `SAT.occultation.refine` for exact time-dependent satellite--star
  separation minimization over P0-04/P0-05 pass candidates.
- Uses the P0-06 spherical geometry only for segment screening; final `tCaMs`
  and nominal separation come from an injected exact J2000 evaluator.
- Added explicit fractional-millisecond brackets, evaluator/work-budget
  failures, `CLOSEST_APPROACH_CONTRACT.md`, `P0-07_PROGRESS.md`, and
  `tools/test_refine.js`.
- Event state, contact timing, angular diameter, probability, ranking, and UI
  remain out of scope.

## Unreleased — P0-06 spherical tube geometry (2026-08-06)

- Added `SAT.occultation.geometry` for stable J2000 unit-sphere conversion,
  minor-arc distance, path distance, and conservative spherical-tube envelopes.
- Added explicit RA-wrap, polar, degenerate, and near-antipodal semantics;
  ambiguous near-antipodal segments use a whole-sphere recall-preserving
  fallback.
- Routed P0-05 star-candidate envelope construction through the shared core and
  added `docs/occultation/SPHERICAL_TUBE_CONTRACT.md` and
  `tools/test_geometry.js`.
- Closest-approach solving, probability, ranking, state, and UI remain out of
  scope.

## Unreleased — P0-05 OCCSTAR1 star candidates (2026-08-06)

- Added `SAT.occultation.starCandidates` for conservative spherical-corridor
  queries around normalized adaptive satellite paths.
- Deduplicated cone results while retaining pass, path-segment, query, and
  catalogue-identity provenance; query failures and all result/work caps are
  explicit rather than being reported as empty fields.
- Added `docs/occultation/OCCSTAR1_CONTRACT.md` and
  `tools/test_star_candidates.js`.
- Stellar closest approach, contact timing, satellite angular diameter,
  probability, ranking, state, and UI remain out of scope.

## Unreleased — P0-04 adaptive satellite paths (2026-08-06)

- Added `SAT.occultation.adaptivePath.refine()` with bounded spherical
  interpolation error, raw-worker seed timestamps, culmination anchors, and
  explicit tolerance/max-sample contracts.
- Integrated adaptive paths into `SAT.occultation.passes.discover()` while
  preserving `sourceCrossing`; missing direction evaluators fall back to the
  raw-worker path and capped refinements surface `adaptive-path-truncated`.
- Added `docs/occultation/ADAPTIVE_PATH_CONTRACT.md`,
  `tools/test_adaptive_path.js`, and `tools/test_passes_adaptive.js`.
- Star search, spherical corridors, stellar closest approach, probability,
  ranking, state, and UI remain out of scope.

## Unreleased — P0-03 deterministic satellite passes (2026-08-06)

- Added `SAT.occultation.passes.discover()` and pure crossing normalization for
  ground-site NightWindows.
- Reused `SAT.scan.runRaw()` with a zenith circular field (`90° - minimum
  elevation`) and explicit worker elevation filtering; no second SGP4 engine was
  introduced.
- Added `SAT.prop.look()` culmination checks, TLE-age/orbit metadata, clipped
  UTC pass boundaries, raw-worker path provenance, and per-pass fallback flags.
- Added `tools/test_passes.js` and `docs/occultation/PASSES_CONTRACT.md`; star
  search, adaptive paths, closest approach, probability, ranking, state, and UI
  remain out of scope.

## Unreleased — P0-02 deterministic night windows (2026-08-05)

- Added the pure `SAT.occultation.night` module with IANA time-zone/DST-aware
  local-date conversion, normal/polar-night/no-night semantics, and UTC Unix-ms
  `NightWindow` output.
- Added a dependency-free high-accuracy solar-altitude solver with explicit
  geometric-threshold, DUT1, topocentric-parallax, and 10 ms root-refinement
  contracts.
- Added `tools/test_night.js` and `docs/occultation/NIGHT_WINDOW_CONTRACT.md`;
  ordinary scan state and the P0-01 raw-scan boundary remain untouched.

## Unreleased — P0-01 isolated raw scan API (2026-08-05)

- Added `SAT.scan.runRaw(params, options)` on the existing Worker pool with a
  separate event namespace, shared cancellation, and shared running lock.
- Added raw geometry merging with deterministic ordering, explicit truncation,
  cull counts, propagation counts, and elapsed time; ordinary photometry and
  `SAT.state.scan` publication remain exclusive to `run()`.
- Added `tools/test_run_raw.js` and the P0-01 raw-scan contract.

## Unreleased — P0-00 offline regression baseline (2026-08-05)

- Added `tools/fixtures/mini_catalog.tle`, a frozen four-family TLE fixture for
  deterministic scan regression coverage.
- Added `tools/run_tests.py` to discover and execute all JavaScript test
  harnesses as offline child processes.
- Made `tools/test_scan.js` use the committed fixture by default and removed
  its temporary-path and download-command fallbacks.
- Added the occultation regression contract, implementation log, decisions, and
  pull-request checklist.
- Kept production JavaScript and the existing scan assertions unchanged.
