# P0-07 progress — stellar closest-approach refinement

**Date:** 2026-08-06
**Status:** implemented and verified

## Delivered

- `app/js/occultation/refine.js`
  - pure `SAT.occultation.refine.refine()` / `.solve()` API;
  - fixed J2000 catalogue-star direction and exact injected satellite-direction
    evaluator;
  - P0-06 spherical segment screening followed by golden-section time
    refinement over each retained interval;
  - explicit fractional-millisecond result, final bracket, evaluator geometry,
    work counts, failure flags, and no-state/no-mutation behavior.
- `app/index.html`
  - loads `refine.js` after geometry, passes, and star-candidate modules.
- `docs/occultation/CLOSEST_APPROACH_CONTRACT.md`.
- `tools/test_refine.js`.

## Acceptance evidence

```text
node --check app/js/occultation/refine.js       PASS
node tools/test_refine.js                      PASS
python3 tools/run_tests.py                     16/16 PASS
```

The deterministic quadratic synthetic trajectory has a true minimum at
`1234.37 ms`; the refined result was `1234.368486 ms` in the raw-path case and
`1234.372170 ms` after adaptive-path screening. The measured fixed miss was
`0.500000004 arcsec`, and the old piecewise `closestTMs` differed from the
refined time by more than 100 ms.

## Scope guard

P0-07 does not bind site/TLE propagation, propagate proper motion, calculate
contact duration or angular diameter, assign probability, rank events, write
`SAT.state.occultation`, or add UI. P0-08 remains responsible for binding the
solver to passes and candidates and for deterministic event/state assembly.
