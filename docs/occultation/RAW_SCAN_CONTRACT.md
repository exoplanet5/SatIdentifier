# Raw scan contract

**Scope:** P0-01 — expose `SAT.scan.runRaw()`

**Status:** accepted on the current SatIdentifier working branch

**Implementation:** `app/js/scan.js`

## API

```js
const raw = await SAT.scan.runRaw(params, {
  maxResults: 100000,
  eventPrefix: 'occultation',
});
```

The returned `RawScanResult` is:

```js
{
  crossings: Crossing[],
  culled: { total, bad, stage1, stage2, stage3, survivors, candidates },
  truncated: boolean,
  propagations: number,
  ms: number,
}
```

`crossings` is the time-sorted concatenation of the existing worker results,
truncated after all shards have been merged. It remains at the worker geometry
boundary: `runRaw()` does not run main-thread photometry or ordinary scan
object/altitude enrichment. `maxResults` defaults to 100,000 and must be a
finite non-negative number; truncation is reported explicitly.

The caller supplies the worker-compatible `params` object. The pool receives a
copy with `maxCrossings` set to the resolved `maxResults`; the caller's object
is not mutated.

## Event and isolation contract

Raw execution uses the existing Worker pool, the same `SAT.scan.isRunning()`
lock and the same `SAT.scan.cancel()` path as ordinary scans. Its event channel
is scoped by `eventPrefix`:

- default: `scan-raw-started`, `scan-raw-progress`, `scan-raw-done`,
  `scan-raw-failed`;
- `eventPrefix: 'occultation'`: the corresponding `occultation-*` events;
- `eventPrefix: null`, `false`, or `''`: no raw events;
- `eventPrefix: 'scan'`: rejected, so raw execution cannot emit ordinary scan
  events by accident.

`runRaw()` must not write `SAT.state.scan`, clear
`SAT.state.scan.checked`, publish ordinary `scan-*` events, or alter ordinary
scan parameters. `SAT.scan.run()` remains the only path that performs the
ordinary photometry merge and publishes `SAT.state.scan`.

## Verification

```sh
node tools/test_run_raw.js
python3 tools/run_tests.py
```

The focused harness checks result ordering and truncation, raw/ordinary event
separation, state and checked-row identity, shared locking, cancellation, pool
reuse, and preservation of ordinary `run()` publication. The complete runner
also keeps the P0-00 offline scan and geometry regression suite green.
