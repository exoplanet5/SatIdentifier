# P0-11 progress — production pipeline and occultation UI

**Date:** 2026-08-06
**Status:** implemented and verified

## Delivered

- Added `app/js/occultation/pipeline.js` to connect the existing deterministic
  pass, star-candidate, closest-approach, and contact stages.
- Added explicit stage status, UTC/local configuration provenance, timing and
  count summaries, raw-scan progress relay, cancellation, and failure isolation.
- Added the three independent windows required by the design:
  `plan-ui.js`, `events-ui.js`, and `chart-ui.js`.
- Added CSV/JSON event export and a tangent-plane diagnostic chart without
  modifying ordinary crossings or chart state.
- Added large-search safeguards: the worker path is capped for transfer, exact
  pass-path refinement is automatically deferred above 2,000 crossings, and
  star-candidate search plus event refinement yield back to the browser between
  work slices. Deferred runs keep explicit `Partial`/provenance flags instead
  of claiming verified path precision. Worker transfer paths are capped at 8
  samples, and raw-worker query paths are bounded to four samples. Large
  discovery reports compact the duplicate raw crossing audit graph, while the
  normalized pass path remains available to the event solver. Large candidate
  searches retain at most 5,000 event records and omit duplicated per-pass query
  transcripts/source-pass references; both choices are exposed as provenance
  flags rather than presented as complete recall.
- The event table renders a maximum of 500 chronological rows. CSV/JSON export
  still uses the full retained state, so DOM size cannot turn a valid partial
  result into a renderer crash.
- Added the Plan UI's default `Contacts only` filter. P0-07/P0-09 still evaluate
  every retained candidate, but the published arrays keep only complete
  `contact`/`grazing` events; filtered misses remain visible in statistics.
- Added `tools/test_pipeline.js`, the P0-11 contract, and the implementation
  decision record.

## Acceptance evidence

The focused harness verifies:

- pass → star → event → commit ordering;
- raw progress event namespace and ordinary `SAT.state.scan` isolation;
- no-night short-circuiting without a star query;
- explicit partial status for truncation and candidate-search flags;
- deterministic event-stage timestamps and partial status even when truncation
  produces zero candidate events;
- runtime failure retention and no stale-state clearing;
- cancellation before event publication;
- detached pipeline configuration in the published state.
- large-result fallback preserves the raw worker path without main-thread
  `SAT.prop.look()` normalization calls, and the complete regression runner
  passes after cooperative star/event processing and raw-path query bounding
  were added.

The occultation JavaScript modules pass `node --check`, and the complete
offline runner remains the required regression check. Browser windows are
loaded only after the scientific modules and are registered independently of
the existing Sky Chart, Crossings, Pointing, Catalogue, and Sites windows.

## Scope guard

P0-11 adds no calibrated probability, ranking, TLE uncertainty distribution,
physical spacecraft shape, detectability model, historical persistence, or
ordinary-scan state mutation. A displayed contact remains geometric under the
P0-09 effective-radius prior.
