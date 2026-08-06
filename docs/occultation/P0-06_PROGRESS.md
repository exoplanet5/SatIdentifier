# P0-06 progress — spherical tube geometry

**Date:** 2026-08-06
**Status:** implemented and verified

## Delivered

- `app/js/occultation/geometry.js`
  - J2000 RA/Dec and unit-vector conversion;
  - stable `atan2(|cross|, dot)` angular distances;
  - spherical linear interpolation and minor-arc segment envelopes;
  - point-to-segment and point-to-polyline tube distances;
  - explicit RA-wrap, polar, degenerate, and near-antipodal semantics.
- `app/js/occultation/star-candidates.js`
  - delegates the P0-05 conservative cone radius and midpoint to the shared
    geometry core, preventing duplicate spherical-envelope implementations.
- `app/index.html`
  - loads the geometry core before pass and star-candidate modules.
- `docs/occultation/SPHERICAL_TUBE_CONTRACT.md`.
- `tools/test_geometry.js`.

## Acceptance evidence

```text
node --check app/js/occultation/geometry.js                 PASS
node tools/test_geometry.js                                PASS
node tools/test_star_candidates.js                         PASS
```

The deterministic geometry harness covers 2,500 conservative random tube
samples and dense brute-force path recall. Near-antipodal paths deliberately
fall back to a whole-sphere envelope; they never claim a narrow, unstable
minor-arc corridor.

## Scope guard

P0-06 does not propagate satellites, query catalogues, calculate stellar
closest-approach time, assign probability, rank events, write occultation
state, or add UI. The `closestTMs` field exposed by `pathDistance()` is only a
linear geometric diagnostic for a piecewise path and is not P0-07's solver.
