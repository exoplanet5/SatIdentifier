# OCCSTAR1 star-candidate contract

**Scope:** P0-05 — `app/js/occultation/star-candidates.js`

**Status:** accepted on the current SatIdentifier working branch

## Purpose

OCCSTAR1 is the first handoff from normalized satellite passes to the star
catalogue. It searches for catalogue stars in a conservative spherical corridor
around each P0-04 `SatellitePass.path`. The output is a candidate set for the
next occultation stage; it is not a claim that an occultation occurred.

The module is pure from the application's point of view: it does not propagate
SGP4, mutate a pass or its path, write `SAT.state`, publish events, access the
DOM, or assign a closest-approach time, probability, uncertainty, or rank.

## API

The browser loads the classic script and exposes:

```js
const result = SAT.occultation.starCandidates.search({
  passes: [satellitePass],
  corridorArcsec: 10,
  magLimit: 12,
});
```

The single-pass form is:

```js
const result = SAT.occultation.starCandidates.searchPass(
  satellitePass,
  { corridorArcsec: 10, magLimit: 12 },
);
```

The optional second argument to `search()` or third argument to `searchPass()`
is a service override used by deterministic tests:

```js
{ stars: { cone(raDeg, decDeg, radiusDeg, magLimit) -> StarRecord[] } }
```

`find()` aliases `search()`, and `candidatesForPass()` aliases `searchPass()`.

## Inputs and outputs

`SatellitePass.path` is a time-ordered array of `{t, raDeg, decDeg}` where `t`
is UTC Unix milliseconds and RA/Dec are J2000 mean-equator/mean-equinox degrees.
RA is normalized to `[0, 360)` for query centers and output records; declination
must be in `[-90, 90]`. The input pass and path are never changed.

The resolved options are:

| Field | Default | Meaning |
|---|---:|---|
| `corridorArcsec` | `1` | Additional search padding. This is an engineering input, not TLE uncertainty or probability. |
| `rawPathPaddingArcsec` | `0` | Explicit padding for a `raw-worker` path without an adaptive error claim. |
| `magLimit` | `null` | Passed unchanged to `SAT.stars.cone`; null requests the provider's full available range. |
| `maxCandidates` | `20000` | Per-pass result bound; dropping candidates sets `candidate-limit`. |
| `maxTotalCandidates` | `null` | Optional aggregate bound across all passes; dropping later candidates sets `candidate-total-limit` and makes the aggregate partial. |
| `maxQueries` | `4096` | Per-pass segment-query bound; excess work sets `star-query-truncated`. |
| `catalogueResultCap` | `20000` | Provider result count at which catalogue truncation is conservatively reported. |
| `rawPathMaxSamples` | `4` | Query-only sample cap for `raw-worker` paths; downsampling sets `raw-path-downsampled` and keeps the result incomplete. |
| `retainQueries` | `true` | Retain per-segment query transcripts. Large interactive runs may set this false after query accounting. |
| `retainSourcePass` | `true` | Retain the original pass reference in each audit result. Large interactive runs may set this false because the event input already carries the pass list. |

`searchPass()` returns:

```js
{
  passId, satId, norad,
  sourcePass,                 // original pass reference, never mutated
  candidates: [{
    passId, starKey, raDeg, decDeg, mag, catalogueId,
    sourceSegments: [0, 1],   // path segments whose query returned the star
  }],
  queries: [{
    segmentIndex, center, radiusDeg, radiusArcsec, segmentArcsec,
    magLimit, count, failed,
  }],
  pathSampleCount, queryCount, duplicateCount,
  corridorArcsec, pathToleranceArcsec, pathPaddingArcsec,
  complete, truncated, flags,
}
```

Candidates are sorted by increasing catalogue magnitude, then by a deterministic
key. A provider `starId`/`id` is retained as `catalogueId`; otherwise `starKey`
is derived from RA, Dec, and magnitude because the existing binary catalogue has
no identity column. `sourceSegments` is provenance, not a closest-approach
measurement.

`search()` returns `{status, results, candidates, stats}`. `results` contains one
audit result per input pass, `candidates` is the retained flat concatenation, and
`status` is `ok`, `partial`, or `empty`. `stats.candidateMatches` counts the
per-pass candidates before an aggregate `maxTotalCandidates` cut, while
`stats.candidates` is the number retained for downstream refinement. The stats
also expose `candidateLimitReached`, `auditCompacted`, `queriesRetained`, and
`sourcePassesRetained`.

## Spherical corridor guarantee

For each adjacent path pair with unit vectors `a` and `b`, OCCSTAR1 computes the
minor great-circle arc length

```text
L = atan2(|a × b|, a · b)
```

and queries the spherical midpoint `m` with radius

```text
q = min(180°, L / 2 + (C + T) / 3600)
```

where `C` is `corridorArcsec` and `T` is the pass's verified adaptive
`pathToleranceArcsec`. Every point on the minor arc is within `L/2` of `m`; the
P0-04 adaptive contract bounds the true path's interpolation residual by `T`.
Thus a star within the requested corridor of the represented path is included in
at least one query, subject to the catalogue provider's own result cap. The
deliberately broad midpoint circle creates false positives; the next stage must
solve the stellar closest approach.

An exactly antipodal segment has no unique spherical midpoint. OCCSTAR1 queries
the whole sphere and records `long-path-segment` rather than selecting an
arbitrary narrow corridor.

## Fallback and failure semantics

- `pathMode: 'adaptive'` with a finite non-negative tolerance is the verified path
  mode. Its tolerance is included in every query radius.
- A `raw-worker` path remains searchable but receives
  `path-precision-unverified`. With zero fallback padding the result is marked
  `complete: false`; a caller must not treat it as a complete search. Supplying
  `rawPathPaddingArcsec > 0` records the padding and permits a complete claim for
  path representation, without converting it into a TLE uncertainty claim.
- When a raw path exceeds `rawPathMaxSamples`, the star-search query path is
  uniformly downsampled while `sourcePass.path` remains untouched for audit and
  event refinement. The result carries `raw-path-downsampled` and remains
  incomplete, because this query-budget representation is not a recall proof.
- Missing/invalid path points, failed cone calls, catalogue result caps, query
  caps, per-pass candidate caps, and aggregate candidate caps are explicit in
  `flags`, `complete`, and/or `truncated`. The module never converts a query
  failure into an empty star list with `complete: true`. Query/pass audit
  compaction changes retained provenance only; it does not change the cone
  geometry or query counts.
- A missing `SAT.stars.cone()` service throws a clear dependency error. A failed
  individual query returns the other query results and marks the pass incomplete.

## Scope guard

OCCSTAR1 does not calculate satellite angular diameter, stellar proper-motion
updates, time-dependent closest approach, contact times, occultation duration,
probability, ranking, persisted occultation state, or UI. It consumes the star
coordinates provided by `SAT.stars.cone()` in the existing chart coordinate
convention and leaves all astrometric policy to later stages.

## Verification

```sh
node tools/test_star_candidates.js
python3 tools/run_tests.py
```

The focused harness uses a deterministic cone service double and verifies the
RA-wrap midpoint, conservative radius, deduplication/provenance, raw-path
fallback, explicit truncation, malformed-input handling, service failures, batch
flattening, validation, input immutability, and state isolation.
