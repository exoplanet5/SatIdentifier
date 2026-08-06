# P0-06 spherical-tube geometry contract

**Scope:** `app/js/occultation/geometry.js` and its use by
`app/js/occultation/star-candidates.js`

**Status:** implemented and verified on the current SatIdentifier working branch

## Purpose

P0-06 is the canonical spherical-geometry boundary between an adaptive
satellite path and later star/event stages. It represents J2000 directions as
unit vectors, measures distance to a minor great-circle segment or path, and
constructs a conservative cone that covers a segment plus angular padding.

The module is a scientific core: it has no DOM, file, network, TLE, catalogue,
clock, or application-state side effects. P0-05 remains responsible for
catalogue queries and candidate provenance; P0-07 will remain responsible for a
time-dependent satellite--star closest approach.

## Coordinate and unit contract

- Vector inputs and outputs are dimensionless, right-handed unit vectors in the
  J2000 mean-equator/mean-equinox frame.
- RA and declination inputs are degrees. RA is accepted with any finite wrap and
  is normalized to `[0, 360)` on conversion back to angles. Declination is in
  `[-90, 90]` degrees.
- Angular distances and corridor padding in the public distance/envelope APIs
  are arcseconds unless a field explicitly ends in `Rad` or `Deg`.
- Path row timestamps, when present, are UTC Unix milliseconds. They are only
  carried into `closestTMs` by linear interpolation of the geometric segment
  fraction; that value is not a closest-approach solution.
- Inputs are normalized or copied. No caller-owned vector, path, or pass is
  mutated.

## API

The browser exposes:

```js
const G = SAT.occultation.geometry;
const a = G.unitFromRaDec(359.9, 20);
const b = G.unitFromRaDec(0.1, 20);
const envelope = G.segmentEnvelope(a, b, 5);
const distance = G.segmentDistance(starVector, a, b);
const pathDistance = G.pathDistance(starVector, pass.path);
```

`segmentEnvelope(a, b, paddingArcsec)` returns:

```js
{
  center, arcRad, arcDeg, arcArcsec,
  radiusRad, radiusDeg, radiusArcsec,
  paddingArcsec, wholeSphere
}
```

For a regular segment, `center` is the spherical midpoint and
`radiusArcsec` is `min(180 deg, arcArcsec / 2 + paddingArcsec)`. For a
zero-length segment, the center is the endpoint and the radius is only the
padding. `wholeSphere` is true when the endpoints are near-antipodal or the
requested radius reaches 180 degrees.

`segmentDistance(point, a, b)` returns:

```js
{
  distanceArcsec,
  fraction,          // 0..1 on the minor arc; null for ambiguous arcs
  closestVector,
  ambiguous,
  wholeSphere         // present and true for an ambiguous near-antipodal arc
}
```

For a regular segment, the nearest point is the normalized projection of the
query direction into the great-circle plane when that projection lies on the
minor arc; otherwise the nearer endpoint is returned. The returned `fraction`
is a geometric segment coordinate, not an event time.

`pathDistance(point, path)` applies `segmentDistance` to every adjacent pair
and returns the minimum with `segmentIndex`, `fraction`, and (when both rows
have UTC timestamps) `closestTMs`. An empty path returns infinite distance.
`pointInTube(point, path, radiusArcsec)` and its `tubeContains` alias apply the
same distance test with a sub-microarcsecond numerical membership epsilon.

## Equations and conservative search guarantee

For unit endpoints `a` and `b`, the minor-arc length is

```text
L = atan2(|a × b|, a · b).
```

For a regular segment, the midpoint cone uses

```text
q = min(pi, L / 2 + P),
```

where `P` is the total padding in radians. Every point `s` on the minor arc
satisfies `d(s, m) <= L/2`, where `m` is the spherical midpoint. If a star
direction `p` is within `P` of some `s`, the spherical triangle inequality
gives `d(p, m) <= L/2 + P`; therefore the cone is a conservative over-query.

P0-05 passes `P = corridorArcsec + pathToleranceArcsec`. The first term is
caller-selected search padding. The second is the verified P0-04 adaptive
interpolation tolerance. Neither term is a TLE uncertainty, a confidence
interval, an occultation probability, or a physical satellite radius.

The point-to-arc projection uses the same stable angular metric as the rest of
the module:

```text
d(p, q) = atan2(|p × q|, p · q) * 206264.806247 arcsec.
```

This avoids the loss of precision of an inverse-cosine-only formula for both
small separations and nearly opposite directions.

## Degenerate and boundary semantics

- RA=0 crossing is handled in Cartesian vectors; no longitude subtraction or
  RA-band special case is used.
- Polar paths are handled without dividing by `cos(dec)`.
- Equal endpoints are treated as a point segment.
- A pair within `1e-10` radians of antipodal has no stable unique minor-arc
  midpoint. Its envelope is whole-sphere. A distance query returns
  `ambiguous: true` and zero distance so a later candidate filter cannot create
  a false negative from an arbitrary great-circle choice.
- A cone radius reaching 180 degrees is also represented as whole-sphere.
- The implementation's membership epsilon is `1e-7` arcsec and only covers
  floating-point round-off; it does not enlarge the catalogue query padding.

## P0-05 integration boundary

`star-candidates.js` now delegates arc length, midpoint, and radius construction
to this module. It still intentionally over-queries the catalogue and retains
false positives for the next closest-approach stage. Catalogue result caps,
query failures, path precision flags, and candidate provenance remain governed
by [OCCSTAR1_CONTRACT.md](OCCSTAR1_CONTRACT.md).

This stage does not calculate stellar proper-motion updates, contact times,
angular diameter, duration, probability, ranking, or persisted state.

## Verification

```sh
node tools/test_geometry.js
node tools/test_star_candidates.js
python3 tools/run_tests.py
```

The focused geometry harness covers an analytic point-to-arc distance, UTC
fraction handoff, RA wrap, polar and degenerate segments, antipodal fallback,
500 deterministic random envelope cases, and dense brute-force path recall.
The star-candidate harness verifies that the P0-05 query radius is unchanged
and is now supplied by the shared geometry core.
