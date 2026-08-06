# Night-window contract

**Scope:** P0-02 — `app/js/occultation/night.js`

**Status:** accepted on the current SatIdentifier working branch

## API

```js
const windows = SAT.occultation.night.windowsForDate({
  site: { latDeg: -37.8136, lonDeg: 144.9631, altM: 30 },
  localDate: '2026-07-23',
  timeZone: 'Australia/Melbourne',
  sunAltitudeLimitDeg: -12,
  dut1S: 0,
});
```

`site` may be supplied at the top level as `latDeg`, `lonDeg`, and optional
`altM`. Latitude is degrees north, longitude is degrees east, and altitude is
metres above the WGS-84 reference ellipsoid. P0-02 accepts ground-site
coordinates only. `localDate` is a proleptic Gregorian `YYYY-MM-DD` civil date;
`timeZone` must be an IANA name resolved by the host's `Intl` implementation.

The canonical result is a sorted array of:

```js
{
  startMs,                 // UTC Unix milliseconds, inclusive boundary
  endMs,                   // UTC Unix milliseconds, exclusive boundary by use
  sunAltitudeLimitDeg,    // geometric solar-centre threshold, degrees
  kind: 'normal' | 'polar-night'
}
```

`kind: 'normal'` is the dark interval beginning after local noon on the selected
date and ending before the following local noon. `kind: 'polar-night'` covers
the complete local civil date `[local midnight, next local midnight)`. A polar
day/no-night date returns `[]`. `describeDate()` adds `kind: 'no-night'` for
that empty result; `windowForDate()` returns the only window or `null`.

## Solar and time model

- All returned times and all numerical solving are UTC Unix milliseconds.
- The solar centre is geometric: no atmospheric refraction and no solar-disc
  radius are silently added. The caller chooses `sunAltitudeLimitDeg`, normally
  `-6`, `-12`, or `-18` degrees.
- The solar direction uses a compact VSOP87 Earth series, apparent longitude,
  20-term IAU-1980 nutation, true obliquity, and the topocentric solar-parallax
  correction for the supplied site altitude. The browser has no astronomy
  package or network dependency.
- `dut1S` is UT1−UTC in seconds and defaults to zero, matching the existing
  SatIdentifier UTC-only convention. The UTC-to-TT offset defaults to the
  repository's leap-second table and can only be overridden by the internal
  `sunAltitudeDeg(..., {deltaTS})` option used by deterministic validation.

The high-accuracy solar-position target is consistent with the public NREL SPA
accuracy statement (approximately 0.0003 degrees):
[NREL Solar Position Algorithm](https://midcdmz.nrel.gov/spa/).
The implementation is a compact browser-side numerical core, not a runtime
installation of the NREL C package.

## Boundary solver and edge cases

The interval from local noon to the following local noon is sampled every 10 s.
Every sign-changing solar-altitude bracket is refined by bisection until its
time width is at most 10 ms. No-root intervals are classified from the sampled
minimum and maximum, so polar day and polar night are explicit rather than
being reported as a failed normal crossing.

The P0-02 harness verifies:

```sh
node tools/test_night.js
python3 tools/run_tests.py
```

It covers Melbourne winter/summer and DST conversion, independent UTC boundary
checks to 1 s, boundary residuals, Gregorian date increment, polar day,
polar night, aliases, and invalid inputs. The module does not create or modify
`SAT.state`.
