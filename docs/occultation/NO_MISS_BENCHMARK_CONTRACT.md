# P0-10 no-miss and benchmark contract

**Scope:** `tools/no_miss_fixture.js`, `tools/no_miss_benchmark.js`,
`tools/test_no_miss.js`, and the two committed P0-10 fixtures.

**Status:** implemented and verified on the current SatIdentifier working tree

## Purpose

P0-10 is the independent recall and cost check for the deterministic occultation
workflow. It compares the optimized path with a dense, separately written truth
loop on a frozen small catalogue. The fixture is synthetic regression data and
is not an observing prediction.

The optimized path is:

```text
NightWindow -> production scan-worker runScan()
            -> passes.discover()/SatellitePass normalization
            -> adaptive path
            -> OCCSTAR1 spherical-corridor queries
```

The browser `SAT.scan.runRaw()` boundary is already tested by P0-01. The
benchmark injects the exact worker core into `passes.discover()` so the check
remains offline and does not need a browser Worker implementation.

## Fixed inputs

| Input | Value |
|---|---|
| Site | latitude `-37.8136°`, longitude `144.9631°`, altitude `31 m` |
| Local date / zone | `2026-07-20`, `Australia/Melbourne` |
| Solar boundary | Sun altitude `-12°` |
| Minimum elevation | `20°` |
| Optimized coarse/fine steps | `30 s` / `1 s` |
| Adaptive path tolerance | `1 arcsec` |
| Search corridor | `1000 arcsec` |
| Brute-force step | `500 ms` by default; the harness accepts `100–500 ms` |
| TLE fixture | `tools/fixtures/p0_10_catalog.tle`, 13 records |
| Star fixture | `tools/fixtures/p0_10_bright_stars.json`, 24 stars, `V ≤ 4.6` |

The large `1000 arcsec` corridor is deliberate: the current synthetic TLE set
contains very fast LEO tracks, and a 30-arcsec event can be shorter than a
permitted 100-ms truth grid. The benchmark therefore tests the configured
conservative candidate corridor rather than claiming sub-arcsecond physical
contact recall. P0-09 contact timing remains the separate disclosed-size test.

## Truth calculation

For every object and every UTC sample in the complete NightWindow, the truth
loop calls the canonical `SAT.prop.look()` evaluator. Samples below the minimum
elevation are discarded. For each remaining sample it evaluates the exact
spherical separation against every fixture star:

```text
d = sep(ra_sat, dec_sat, ra_star, dec_star)
truthCandidate := d ≤ corridorArcsec
```

`frames.sep()` uses the stable `atan2(|a × b|, a · b)` spherical form. The truth
loop does not read optimized paths, cone results, pass IDs, or candidate lists.
It reports target propagation calls, star-distance evaluations, all hit samples,
and the deduplicated `(satellite catalogue id, star catalogue id)` truth set.

The identity deliberately omits pass fragmentation. A satellite may produce
multiple pass records during a night; the no-miss statement asks whether the
satellite/star pair is found anywhere in the night, while the pass-level record
and event IDs remain owned by P0-08/P0-09.

## Acceptance relation

Let `O` be the optimized deduplicated candidate-pair set and `B` the dense truth
set. P0-10 passes only when:

```text
B is non-empty
O is not truncated
O ⊇ B
```

Extra optimized pairs are expected because midpoint cones cover a segment and
the configured corridor is conservative. Missing pairs are a failure even if
the optimized run returns other candidates.

The harness also records:

- optimized raw crossings, normalized passes, query count, candidate count,
  propagation count, cull counters, and wall time;
- brute-force grid samples, propagation count, spherical-distance checks, hit
  samples, unique truth pairs, and wall time;
- RSS, heap, and external-memory snapshots before/after each phase and a sampled
  peak. Memory values are process-level diagnostics, not allocator guarantees.

## Commands

Run the focused check:

```sh
node tools/test_no_miss.js
```

Print the complete JSON evidence record, including fixture SHA-256 hashes,
environment, Git state, and the computed comparison:

```sh
node tools/test_no_miss.js --json
```

Run it with the complete offline regression suite:

```sh
python3 tools/run_tests.py
```

No command downloads data, opens a browser, or writes application state.

## Limitations and scope guard

This benchmark does not calibrate occultation probability, estimate TLE
uncertainty, validate physical satellite size, model seeing, rank events, or
replace an ephemeris-quality observing prediction. It also does not claim that a
500-ms grid can recover an arbitrary zero-width contact. Those questions belong
to later uncertainty/detectability work; P0-10 is a deterministic conservative
candidate-recall and work-accounting check.
