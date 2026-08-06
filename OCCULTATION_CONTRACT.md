# Offline regression contract

**Scope:** P0-00 — establish the SatIdentifier offline regression baseline

**Status:** accepted for the `codex/p0-00-offline-regression` branch

**Upstream baseline:** `main@351bbb89ee987b31ae3fb62f92ca0fe5ef9d3f5b`

## Purpose

This document defines the test and fixture boundary needed before adding the
occultation workflow. It does not define a production occultation API and it
does not change the existing scan algorithm, state model, or UI.

## Commands

Run the complete offline suite from the SatIdentifier repository root:

```sh
python3 tools/run_tests.py
```

Run only the scan-engine regression:

```sh
node tools/test_scan.js
```

`test_scan.js` uses the committed fixture when no argument is supplied. A
caller may pass another local TLE file explicitly for exploratory comparison;
that path is never downloaded or inferred from a temporary directory.

The runner discovers every `tools/test_*.js` file in lexical order, executes
each as a separate Node.js process, streams its output, and returns non-zero if
any child fails. It sets `SATIDENTIFIER_REGRESSION_OFFLINE=1` as an audit
marker; the runner itself has no network code.

## Fixture contract

`tools/fixtures/mini_catalog.tle` is a frozen, deterministic three-line TLE
catalogue with 87 records:

| Orbit family | Records | Role in the baseline |
|---|---:|---|
| LEO | 46 | wide-field crossings, narrow-field crossings, and rate checks |
| GEO | 37 | GEO sky/mount rates, orbital-station visibility, and pole culling |
| MEO | 2 | deep-space classification coverage |
| HEO | 2 | Molniya-like deep-space propagation coverage |

The fixture contains the exact NORAD 25544 ISS record required by the orbital
observing-station checks and several low-inclination GEO records. The named
variants are intentionally synthetic regression objects: selected RAAN,
inclination, and mean-anomaly values exercise specific field geometries, while
the TLE format and checksum rules remain real. They are not current ephemerides
and must not be used for observing predictions or scientific claims.

The newest fixture epoch is resolved by `test_scan.js` itself, so the tests do
not depend on the machine clock. The fixture is kept in the repository rather
than generated during a test, making a failure reproducible from the checkout
alone.

## Acceptance criteria

P0-00 is complete when all of the following remain true:

1. `python3 tools/run_tests.py` completes without network access and every
   discovered harness exits zero.
2. `node tools/test_scan.js` succeeds with no argument and therefore exercises
   `tools/fixtures/mini_catalog.tle` by default.
3. The scan regression retains its independent geometry checks, stage-1
   cull-on/cull-off set comparisons, coarse-sweep recall check, GEO rate check,
   and orbital-station checks.
4. A missing fixture produces a clear local-file error and never prints a
   download command.
5. No P0-01 or later implementation is included: `runRaw()`, night windows,
   occultation state, UI, probability, and event ranking remain out of scope.

## Change boundary

P0-00 may change test harnesses and repository documentation. It must not
modify production files under `app/js/`, alter existing test assertions merely
to fit the fixture, or introduce a runtime dependency on Python packages,
Astropy, NumPy, or a network service.
