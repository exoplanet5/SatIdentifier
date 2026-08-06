# P0-08 progress — look binding and independent event state

**Date:** 2026-08-06
**Status:** implemented and verified

## Delivered

- `app/js/occultation/look-adapter.js`
  - resolves pass objects and observing sites;
  - binds the exact J2000 evaluator to `SAT.prop.look()`;
  - forwards refraction/DUT1 options and records millisecond Date resolution.
- `app/js/occultation/event-assembly.js`
  - accepts P0-04 passes and P0-05 candidates or search results;
  - invokes P0-07 for every deduplicated pass/star pair;
  - retains exact look geometry, solver brackets, flags, and per-event failures;
  - produces deterministic IDs and time/event-ID ordering.
- `app/js/occultation/event-state.js`
  - exposes `SAT.occultation.eventState` and the `SAT.occultation.events` alias;
  - provides side-effect-free `build()` plus `commit()`/`resolve()` publication;
  - maintains independent transient `SAT.state.occultation` state.
- `app/index.html`
  - loads the adapter, assembly, and state modules after `refine.js`.
- `docs/occultation/EVENT_STATE_CONTRACT.md`.
- `tools/test_event_state.js`.

## Acceptance evidence

```text
node --check app/js/occultation/look-adapter.js       PASS
node --check app/js/occultation/event-assembly.js     PASS
node --check app/js/occultation/event-state.js        PASS
node tools/test_event_state.js                        PASS
python3 tools/run_tests.py                            17/17 PASS
```

The deterministic look double recovered the synthetic closest time at
`1233.500858 ms` versus the `1234.37 ms` analytic target. The sub-millisecond
difference is expected because the production adapter rounds `Date` inputs to
the nearest millisecond; P0-07 remains capable of fractional-millisecond
results for evaluators with finer time resolution.

## Scope guard

P0-08 does not calculate contact ingress/egress, satellite angular diameter,
occultation probability, ranking, UI, or persistent state. It does not alter
ordinary scan results or `SAT.state.scan`.
