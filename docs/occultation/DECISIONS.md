# Occultation decisions

## ADR-0001 — Reuse the existing scan worker for pass discovery

**Status:** accepted

**Date:** 2026-08-05

**Decision:** The future P0 occultation workflow will reuse the existing
`app/js/worker/scan-worker.js`, its SGP4 implementation, and its established
stage-1/stage-2/stage-3 geometry path. It will not introduce a second SGP4
pass engine.

**Reason:** A single propagation and crossing implementation keeps coordinate,
time, culling, and cancellation behavior aligned with the existing SatIdentifier
workflow. The P0-00 fixture and runner protect that shared baseline before any
new occultation code is added.

**Consequence:** P0-01 must extract an isolated raw-scan interface without
changing ordinary `SAT.scan.run()` behavior. Any later occultation comparison
must record the same TLE text, epoch, coordinate convention, and tolerance
metadata used by this baseline.

## ADR-0002 — Make the regression fixture repository-local and deterministic

**Status:** accepted

**Date:** 2026-08-05

**Decision:** The scan regression uses
`tools/fixtures/mini_catalog.tle` by default. Network catalogues and temporary
paths are permitted only when a caller explicitly supplies a local alternative.

**Reason:** A test that silently fetches a moving catalogue cannot distinguish
software changes from input changes and cannot serve as an offline baseline.

**Consequence:** The fixture is synthetic and is not a prediction input. Any
future change to its records, epochs, or ordering is a regression-contract
change and must be explained in the implementation log.

## ADR-0003 — Keep raw scan results at the worker geometry boundary

**Status:** accepted

**Date:** 2026-08-05

**Decision:** `SAT.scan.runRaw()` returns merged, time-sorted worker crossings
plus cull, propagation, truncation, and timing metadata. It does not perform
the main-thread photometry/object enrichment owned by `SAT.scan.run()` and it
does not publish to `SAT.state.scan`.

**Reason:** The occultation workflow needs the existing three-stage pass
discovery without inheriting ordinary Crossings-table state or a 5,000-row UI
cap. Keeping the boundary explicit lets later pipeline stages own their state
and choose a larger result cap while preserving the normal identification path.

**Consequence:** Raw callers must provide worker-compatible scan parameters and
must use a non-`scan` event prefix when they want progress events. Ordinary
`SAT.scan.run()` remains the only path that clears checked rows and publishes
ordinary scan events/state.

## ADR-0004 — Use conservative midpoint cones for OCCSTAR1

**Status:** accepted

**Date:** 2026-08-06

**Decision:** OCCSTAR1 queries the star catalogue once per adaptive path segment
at the spherical segment midpoint. The cone radius is half the segment's
great-circle arc plus caller padding and the verified adaptive interpolation
tolerance. Results are deduplicated by catalogue identity when available, or by
the returned RA/Dec/magnitude tuple otherwise.

**Reason:** A cone around the midpoint is a simple conservative cover of every
point on a minor great-circle segment and remains correct across the RA=0 seam.
It avoids treating linearly interpolated RA as a sky geometry and leaves the
next stage free to perform the time-dependent closest-approach calculation.

**Consequence:** OCCSTAR1 can return false positives by design. It must expose
catalogue/query/candidate truncation and failed-query flags, and it must not
describe its corridor padding as a TLE uncertainty, occultation probability, or
event ranking. A raw-worker path without a verified error bound is explicitly
marked incomplete unless the caller supplies fallback padding.

## ADR-0005 — Make one spherical geometry core authoritative

**Status:** accepted

**Date:** 2026-08-06

**Decision:** P0-06 uses `app/js/occultation/geometry.js` as the sole source for
unit-sphere conversion, great-circle arc length, segment envelopes, and
point-to-path distances. P0-05 delegates its conservative catalogue-query
envelope to this module rather than retaining a second midpoint implementation.

**Reason:** RA-wrap, polar directions, sub-arcsecond distances, and near-
antipodal endpoints are numerical boundary cases. Duplicated implementations
could disagree exactly where the no-miss contract matters. A shared pure core
also gives P0-07 a tested distance primitive without importing catalogue or UI
state.

**Consequence:** A regular segment's catalogue envelope is the spherical
midpoint cone with radius `L/2 + padding`, capped at 180 degrees. A pair within
`1e-10` radians of antipodal is represented as whole-sphere and cannot claim a
narrow minor arc. `pathDistance().closestTMs` remains only a linear geometric
diagnostic; P0-07 must solve the time-dependent closest approach independently.

## ADR-0006 — Refine closest approach from the exact time evaluator

**Status:** accepted

**Date:** 2026-08-06

**Decision:** P0-07 uses P0-06 spherical segment distances only for candidate
segment screening and time bracketing. It minimizes the exact angular
separation returned by an injected J2000 direction evaluator with a bounded
golden-section search, and returns its final timestamp with a final bracket.

**Reason:** A path midpoint or linearly interpolated segment fraction is not a
time-dependent satellite trajectory. Curvature, non-uniform angular speed,
and RA-wrap geometry can move the true minimum away from the diagnostic
`closestTMs`. The existing `SAT.prop.look()` implementation remains the only
propagation source; the scientific core must not duplicate SGP4 or site/frame
logic.

**Consequence:** P0-07 accepts a P0-05 candidate plus a `SatellitePass.path`
and exact evaluator, returns `tCaMs`/`nominalSeparationArcsec`, and exposes
evaluation failures and work limits as incomplete results. An untruncated
adaptive path may use its verified angular tolerance to discard segments with
the triangle-inequality bound `best + 2T + margin`; raw or truncated paths
refine every available segment and disclose the missing representation claim.

## ADR-0007 — Keep occultation event state independent from ordinary scans

**Status:** accepted

**Date:** 2026-08-06

**Decision:** P0-08 publishes refined occultation candidates under the transient
`SAT.state.occultation` namespace. The event assembler must not write
`SAT.state.scan`, ordinary scan events, or the existing state persistence
payload. A successful record remains `kind: 'occultation-candidate'` until later
stages establish physical contact semantics.

**Reason:** The occultation workflow is a separate pipeline with its own pass,
star-candidate, solver, truncation, and failure provenance. Reusing ordinary
crossing state would make a partial occultation run look like a completed normal
scan and would allow a failed candidate to erase unrelated scan results.

**Consequence:** `build()` is side-effect free; `commit()`/`resolve()` replace
only the occultation state object and emit `occultation-state-changed`. The
state copies pass and candidate records, retains incomplete events, and leaves
contact timing, angular diameter, probability, ranking, persistence, and UI to
later P0 stages.

## ADR-0008 — Represent P0-09 contact with a disclosed effective satellite disc

**Status:** accepted

**Date:** 2026-08-06

**Decision:** P0-09 treats the catalogue star as a point source and the
satellite as an opaque circular disc. It resolves an effective radius from an
explicit override, object metadata, RCS, SATCAT type, or a flagged default,
then solves `asin(r / range) - separation = 0` for ingress and egress.

**Reason:** P0-08 already supplies an exact time-dependent J2000 direction and
topocentric range. A physical contact boundary must use the apparent angular
size at that same time; a fixed angular threshold or a piecewise path fraction
would mix frames or ignore range variation. The available catalogue metadata
does not describe individual spacecraft shape, so the size prior must remain
visible instead of being presented as a hard physical diameter.

**Consequence:** Contact results disclose `radiusSource`, angular size, root
brackets, clipping, and incomplete-search flags. A complete `miss` is only a
geometric miss under the selected radius model. Probability, spacecraft shape,
stellar diameter, seeing, ranking, persistence, and UI remain later stages.

## ADR-0009 — Make P0-10 recall comparison independent and pair-based

**Status:** accepted

**Date:** 2026-08-06

**Decision:** P0-10 compares the optimized worker/pass/adaptive-path/OCCSTAR1
pipeline with a separate dense UTC propagation loop. The truth loop calls the
canonical `SAT.prop.look()` for every fixture object and compares every visible
sample with every fixture star using the exact spherical separation. The
acceptance key is `(satellite catalogue id, star catalogue id)` rather than a
pass record ID.

**Reason:** A stage can return plausible events while silently dropping an
object between pass discovery, path representation, or star-catalogue query.
Reusing an optimized pass or candidate list in the truth calculation would
make that failure invisible. Pass fragmentation is an optimized record detail;
pair-level truth lets the independent loop cover the whole night without
inheriting optimized interval boundaries.

**Consequence:** The benchmark must satisfy `optimized ⊇ bruteForce`, keep extra
midpoint-cone candidates, and expose missing pairs. The fixture, UTC grid,
corridor, input hashes, runtime, Git state, and process-memory diagnostics are
part of the evidence. The result is a deterministic candidate-recall check,
not a probability, TLE-uncertainty calibration, or physical-contact claim.

## ADR-0010 — Make P0-11 the single production handoff and keep UI clients thin

**Status:** accepted

**Date:** 2026-08-06

**Decision:** `app/js/occultation/pipeline.js` is the only production orchestration
entry point for the P0 nightly occultation workflow. It calls pass discovery,
OCCSTAR1, and event assembly in order, publishes only after all stages return,
and exposes cancellation/failure provenance. The Plan, Events, and Chart
windows consume this result/state contract and do not call propagation or write
ordinary scan state.

**Reason:** Direct UI-to-core calls would make cancellation, partial search
semantics, and state publication order depend on which window happened to be
open. A single pipeline lets the same deterministic workflow run from tests,
the browser, and a later export entry point while preserving P0's independent
`SAT.state.occultation` namespace.

**Consequence:** A failed or cancelled run leaves the last published event state
untouched and returns an explicit non-complete report. A complete empty/no-night
run may publish an empty state. P0-11 adds no probability, ranking, persistence,
or uncertainty model.
