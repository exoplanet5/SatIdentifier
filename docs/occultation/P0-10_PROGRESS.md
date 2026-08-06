# P0-10 progress — no-miss recall and benchmark

**Date:** 2026-08-06
**Status:** implemented and verified

## Delivered

- Added the frozen 13-object `p0_10_catalog.tle` and 24-star bright fixture.
- Added `tools/no_miss_fixture.js` for fixture parsing, hashes, runtime metadata,
  and memory snapshots.
- Added `tools/no_miss_benchmark.js`, which runs the production worker core and
  P0-03/P0-04/P0-05 pipeline path, then independently propagates every object
  over the complete Melbourne NightWindow and compares every star direction.
- Added `tools/test_no_miss.js`; the test is discovered automatically by
  `tools/run_tests.py`.
- Added `NO_MISS_BENCHMARK_CONTRACT.md` and the P0-10 decision record.

## Acceptance evidence

One offline run with the committed fixtures produced:

```text
truth unique pairs:       19
optimized unique pairs:   24
conservative extras:       5
missing pairs:              0
optimized propagations: 18,863
brute propagations:   1,130,649
brute distance checks:3,264,408
optimized candidates:      24
```

The run passed `optimized ⊇ bruteForce`. Exact elapsed time and process-memory
snapshots are emitted by `node tools/test_no_miss.js --json`; they are recorded
as diagnostics because they vary with the host and Node runtime.

The fixture hashes in the same evidence record were:

```text
p0_10_catalog.tle:       1d83b2bce2f02911e499dde3fde7db6080c3c06fa631b316e74f00f71fdc1de3
p0_10_bright_stars.json: ae51916f7cc890d57b43e2ea23e58674db42f62fbed32597ea460edaa955eed2
```

## Scope guard

P0-10 adds no probability, ranking, persistence, UI, calibrated uncertainty,
or physical-contact claim. The 1000-arcsec corridor is an explicit benchmark
configuration for conservative candidate recall; P0-09 remains responsible for
the disclosed angular-disc contact calculation.
