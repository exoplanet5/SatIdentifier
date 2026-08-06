# P0-09 angular-disc contact contract

**Scope:** `app/js/occultation/satellite-size.js`,
`app/js/occultation/contact.js`, and the P0-08 event-assembly handoff.

**Status:** implemented and verified on the current SatIdentifier working tree

## Purpose

P0-09 turns a P0-08 time-refined closest approach into a geometric contact
result. The star catalogue supplies a point source in J2000; the satellite is
represented by an opaque circular disc with an explicitly disclosed effective
physical radius. The stage calculates apparent angular size, ingress, egress,
duration, and pass-boundary clipping.

This is a geometric model, not an observation or probability claim. It does not
model spacecraft attitude or shape, stellar angular diameter, TLE uncertainty,
atmospheric seeing, probability, ranking, persistence, or UI.

## Size model

`SAT.occultation.satelliteSize.resolve(object, options)` returns a positive
effective radius in metres and its provenance. Precedence is:

| Source | Radius | Interpretation |
|---|---:|---|
| `options.radiusM` (or `satelliteRadiusM`/`physicalRadiusM`) | supplied | explicit caller prior |
| `object.radiusM` | supplied | object-level physical prior |
| `object.diameterM`/`sizeM` | half the supplied value | object-level diameter prior |
| `object.rcs` | `sqrt(rcs / pi)` m | equivalent diffuse sphere from RCS in m² |
| `object.type` | R/B 2 m, PAY 1 m, DEB 0.15 m | coarse SATCAT class prior |
| fallback | 1 m by default | unknown-size prior, flagged `radius-assumed` |

Set `defaultRadiusM: null` to reject an unknown-size object. Type and default
values are engineering priors already used by the photometry model; they are
not measurements of an individual spacecraft. The RCS conversion is also an
effective sphere, not a physical shape reconstruction.

The angular radius is computed from the topocentric range:

```text
alpha(t) = asin(r / R(t))
```

where `r` is the effective radius in kilometres and `R(t)` is the topocentric
range in kilometres. `alpha` and the returned diameter are reported in
arcseconds. A range that is non-positive or no larger than `r` is invalid.

## Solver API

```js
const result = SAT.occultation.contact.solve({
  pass: satellitePass,
  candidate: { raDeg: 10.12, decDeg: 20.0 },
  object: catalogueObject,
  evaluate: (tMs) => SAT.prop.look(site, catalogueObject, new Date(tMs), opts),
  tCaMs: event.tCaMs,
}, {
  sampleStepMs: 1000,
  timeToleranceMs: 1,
  defaultRadiusM: 1,
});
```

The evaluator receives UTC Unix milliseconds and must return finite J2000
`raDeg`/`decDeg` plus positive topocentric `rangeKm` for every evaluated time.
The production handoff uses the P0-08 `SAT.prop.look()` adapter, so the
canonical evaluator still owns SGP4, site motion, frame conversion, DUT1, and
millisecond `Date` quantisation.

## Contact equation and numerical method

Let `d(t)` be the exact spherical separation between the fixed star direction
and the evaluated satellite direction. A contact exists when

```text
d(t) <= alpha(t)
```

or, equivalently, when `f(t) = alpha(t) - d(t) >= 0`. The solver samples a
bounded time grid over `[startMs, endMs]`, always replacing the nearest grid
sample with `tCaMs` when it is supplied. Each sign-changing interval is then
solved by bisection until its time bracket is at most `timeToleranceMs` or the
iteration budget is reached. The returned ingress/egress time is the midpoint
of its final bracket; the bracket is retained for auditability.

The default `sampleStepMs: 1000` and `maxSamples: 4096` are engineering
budgets. P0-08 supplies the closest-approach anchor, so a complete `miss` means
no contact under the selected radius model and evaluator over the searched
pass. A sample budget, missing closest-time anchor, evaluator failure, missing
range, or root iteration limit makes `complete: false` and is surfaced through
flags rather than silently becoming a miss.

## Result schema

```js
{
  status: 'miss' | 'grazing' | 'contact' | 'failed',
  complete,
  contact,
  tCaMs,
  closestSeparationArcsec,
  clearanceArcsecAtCa,
  radiusM,
  radiusSource,
  angularRadiusArcsecAtCa,
  angularDiameterArcsecAtCa,
  ingressMs,
  egressMs,
  durationMs,
  ingressBracket,
  egressBracket,
  intervals,
  evaluations,
  samples,
  roots,
  searchStartMs,
  searchEndMs,
  flags,
  error,
}
```

All times are UTC Unix milliseconds; angular fields are arcseconds; duration
and bracket widths are milliseconds; `radiusM` is metres; ranges used in the
calculation are kilometres. `miss` has null contact times and a complete
numeric search. `grazing` is a zero-width or tolerance-width contact. A pass
that begins or ends inside the disc reports `contact-clipped-start` or
`contact-clipped-end`, and uses the pass boundary as the corresponding time.
Multiple sampled contact intervals are retained in `intervals`; the interval
containing `tCaMs` is promoted to the top-level fields.

## Event-state integration

P0-09 keeps P0-08's `kind: 'occultation-candidate'`, deterministic event ID,
closest-approach fields, exact `closestGeometry`, and failure isolation. A
successful event additionally carries:

```js
{
  contactStatus,
  contact,
  contactResult,
  radiusM,
  radiusSource,
  angularRadiusArcsec,
  angularDiameterArcsec,
  ingressMs,
  egressMs,
  durationMs,
  contactIntervals,
}
```

The independent state version is `p0-09`. `SAT.state.scan`, ordinary scan
events, persistence, probability, ranking, and UI remain untouched.

## Verification

```sh
node --check app/js/occultation/satellite-size.js
node --check app/js/occultation/contact.js
node --check app/js/occultation/event-assembly.js
node tools/test_contact.js
node tools/test_event_state.js
python3 tools/run_tests.py
```

The focused harness uses a fixed 1000 km range and a 10 m synthetic disc. It
recovers ingress and egress to sub-0.05 ms in an analytic track, verifies the
`asin(r/R)` angular-size equation, RCS/type provenance, clipped boundaries,
complete misses, unknown-size rejection, and missing-range failure isolation.
