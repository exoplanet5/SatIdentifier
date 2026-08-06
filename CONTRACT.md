# SatIdentifier — Architecture Contract

The inverse of [SatObserver-MX](../satobserver): instead of asking *where is this
satellite*, it asks **who is in my field of view**. Given a site, an epoch and a
timespan, a pointing (RA/Dec J2000 or Alt/Az) and a field of view, it finds every
catalogued object that crosses that field, draws them on a gnomonic sky chart, and
draws the trail each would leave across the field — so an unidentified trail on a
real frame can be matched against the list.

Local Python backend (TLE/catalogue fetching + persistence, stdlib only) + browser
frontend (SGP4 in Web Workers, canvas chart). This document is the **binding
contract** between modules. Every module MUST expose exactly the API written here and
MAY rely on every other module exposing exactly its API. Plain ES2020 browser JS, **no
build step, no ES modules** — each file is a classic `<script>` attaching to the global
`SAT` namespace. No external network access from the frontend except the local backend.

Namespace stays `SAT` (not `SATID`) so modules ported from SatObserver work unchanged.

## File layout

```
/Users/mickey/sda/satidentifier/
  server.py                  # backend: static file server + JSON API (stdlib only)
  desktop.py                 # pywebview shell (native window), ~27 lines, as SatObserver
  SatOccult.command           # double-click dev launcher
  tools/make_starcat.py      # one-shot: build assets/stars_m9.bin from Tycho-2 (dev only)
  app/
    index.html               # loads CSS + scripts in fixed order (see below)
    css/app.css
    assets/stars_m9.bin      # deep star catalogue, ~120k stars to V=9.0 (binary, ~1.4 MB)
    js/vendor/satellite.min.js   # satellite.js 5.0 UMD -> global `satellite`
    js/vendor/starcat.js         # bright stars + constellation lines/names (from SatObserver)
    js/vendor/mwdata.js          # Milky Way isophotes -> SAT.mwdata (from SatObserver)
    js/util.js               # SAT.util      (port from SatObserver + additions)
    js/frames.js             # SAT.frames    NEW  (AGENT F)
    js/windows.js            # SAT.windows   (port, unchanged)
    js/clock.js              # SAT.clock     (port, unchanged)
    js/propagate.js          # SAT.prop      (port, trimmed)
    js/state.js              # SAT.state, SAT.bus
    js/stars.js              # SAT.stars     NEW  (AGENT S)
    js/photometry.js         # SAT.photo     NEW  (AGENT P)
    js/scan.js               # SAT.scan      NEW  (AGENT E)
    js/worker/scan-worker.js # worker-side scan engine (AGENT E)
    js/sources.js            # SAT.ui.sources   (port)
    js/locations.js          # SAT.ui.locations (port, unchanged)
    js/satinfo.js            # SAT.ui.satinfo   (port + extend)
    js/pointing.js           # SAT.ui.pointing  NEW  (AGENT I)
    js/chart.js              # SAT.chart        NEW  (AGENT C) — main view
    js/crossings.js          # SAT.ui.crossings NEW  (AGENT T) — main list
    js/allsky.js             # SAT.allsky       (port of skychart.js, context view)
    js/main.js               # boot
  data/                      # backend persistence (state.json, config.json, cache/)
```

`index.html` script order: vendor libs, then `util, frames, windows, clock, propagate,
state, stars, photometry, scan, sources, locations, satinfo, pointing, chart,
crossings, allsky, main`. `window.SAT = {ui:{}}` is created inline in index.html before
any script loads.

## Conventions

- Angles at module boundaries are **degrees** (suffix `Deg`); longitude normalized to
  **[-180, 180]**; RA in **[0, 360)**; position angles measured **north through east**.
- Small angles in tables/readouts may be arcmin (`Am`) or arcsec (`As`) — always
  suffixed. Angular **rates are arcsec/s** (`AsPerS`).
- Altitudes: satellite height in **km**, ground station altitude in **m**, ranges in **km**.
- Times are JS `Date` objects (internally UTC); millisecond epochs are `*Ms`.
  Display format `YYYY-MM-DD HH:MM:SS`.
- **All catalogue and chart RA/Dec are J2000 mean equinox** unless a field is
  explicitly named `*OfDate`. Alt/Az is *apparent* (refracted) when
  refraction is always applied (round-2 review removed the toggle: an Alt/Az
  pointing is what the telescope points at, which is apparent by definition).
  `SAT.frames` keeps the `{refract}` option so tests can reach the geometric path.
- Colors are CSS hex strings, e.g. `"#ffcc00"`.
- Every module is defensive: an object whose SGP4 propagation fails at a given time is
  silently skipped (no throws in render or scan loops).

## Performance decisions (measured, not assumed — do not re-litigate without new numbers)

Benchmarked 2026-07-21 on this machine, node 25, satellite.js 5.0, real CelesTrak
`GROUP=active` catalogue (16 056 objects), in
`scratchpad/bench.js`:

```
init:      16 056 satrecs in 106 ms          (6.6 us each, ONE TIME)
propagate: 321k propagations in 196 ms       (0.61 us each)
hot loop:  9.2 ms per coarse step over 16 056 objects
           (propagate + topocentric vector + horizon + dot-product separation)
```

Extrapolated to a 27 000-object catalogue, before any geometric cull:

| Scan | Coarse steps | 1 thread | 6 workers |
|---|---|---|---|
| 10 min @ 30 s | 20 | 0.3 s | 0.1 s |
| 1 h @ 30 s | 120 | 1.9 s | 0.3 s |
| 6 h @ 30 s | 720 | 11.1 s | 1.9 s |
| 24 h @ 60 s | 1440 | 22.2 s | 3.7 s |

**Decision: satellite.js, no WebAssembly.** A WASM port of Bill Gray's `sat_code`
(assessed: 4–6 self-contained files, no malloc/stdio, fully re-entrant, caller-owned
`params` — a genuinely clean port) would buy perhaps 3× on a stage that already costs
0.3 s for the common case. It would cost an emscripten toolchain dependency, a build
step, a committed binary artifact, and `-fno-strict-aliasing` care around
`sgp4.cpp`'s int-punned-through-double `simple_flag`. Not worth it.

**Revisit only if** a measured full-catalogue 24 h scan exceeds ~10 s on 6 workers,
or the catalogue grows past ~100 k objects. The structural optimisations below are
worth far more than the language, and they are what the budget above already assumes.

### Structural rules for the hot loop (from Bill Gray's `sat_id`)

These are the difference between the table above and something 50× slower:

1. **Init once, propagate many.** `sat_id` hoists `SGP4_init` outside its object loop.
   Build every satrec **once when the catalogue loads** (106 ms for 16 k) and never
   again — not lazily per scan, not per time step. `_satrec` lives for the session.
2. **Rotate the pointing, not the catalogue.** Convert the FOV centre J2000 → TEME
   **once per epoch** and compare in TEME. Never convert 27 000 satellite vectors to
   J2000 inside the loop. Only the handful of confirmed crossings are converted to
   J2000, at the end, for display. This is worth more than everything else combined,
   and it has the happy side effect of keeping precession out of the hot loop
   entirely — see the accuracy note below.
3. **No trig in the cull.** Test separation as a dot product against
   `cos(margin)`, and the horizon as `dot(topoVec, siteVec) > 0`. No `acos`, no
   `atan2`, no `sqrt` beyond the one range. `acos` at 27 000 × N steps is not free.
4. **Everything JD-keyed is computed once per epoch**: GMST, the site's TEME vector,
   the pointing's TEME vector, the Sun vector for the shadow test, the precession
   matrix. `sat_id` memoises `lunar_solar_position` on JD for exactly this reason.
5. **Call `satellite.sgp4(satrec, tsinceMinutes)` directly**, not
   `satellite.propagate(satrec, date)` — the latter re-derives minutes-since-epoch
   from a `Date` on every call. Precompute `tsince` per epoch per satellite.

## Why `SAT.frames` exists (read this before touching coordinates)

SatObserver only ever needed alt/az and sub-points, so it used satellite.js's
TEME→ECEF (`gstime`) path and never worried about equinox. This tool reports **RA/Dec
to arcminute precision against a star field**, so the following are mandatory:

- **TEME is not J2000.** satellite.js SGP4 returns True Equator Mean Equinox of date.
  Precession since J2000 is ≈ 0.36° in 2026 — 20× a typical telescope FOV. Reporting
  TEME as J2000 would be the single largest error in the tool.
- **Refraction** is ~1.7′ at 30° elevation and ~5′ at 10°. When the user gives an
  Alt/Az pointing they mean where the *telescope points*, i.e. apparent; when they
  compare against a star field they need geometric. Convert explicitly.
- **Topocentric parallax** is handled implicitly (we always difference against the
  observer's geocentric position vector) — never use geocentric satellite RA/Dec.
- **Light-time** (≤ 0.13 s, ≤ 0.005″ of motion) and **diurnal aberration** (≤ 0.3″)
  are negligible against TLE error (~1 km ⇒ several arcminutes) and are NOT applied.
  **Annual aberration** (≤ 20.5″) is likewise not applied to satellites, and star
  positions are left at catalogue J2000 mean places, so chart and satellites stay
  mutually consistent. Document this in the Help window; do not "fix" one side alone.

### Precession — the specific ways this goes wrong

Bill Gray rewrote his own precession code twice; the reasons are documented in
`lunar/precess.cpp` and are worth obeying rather than rediscovering.

1. **Only ever build the matrix J2000 → date, and transpose it to invert.** Do not
   use the general "precess from t1 to t2" cubic polynomials (the form in the
   deprecated `lunar/precess2.cpp`). Those are not self-inverse: precessing forward
   then back does not return the original vector, and the error grows with span.
   `frames.js` therefore exposes one primitive, `precessionMatrix(date)` meaning
   J2000 → mean-of-date, and every other direction is its transpose. This makes
   `j2000ToTeme(temeToJ2000(v, t), t) === v` exact to rounding, which is a test.
2. **Use the equatorial IAU-1976 form, and say so in a comment.** The ecliptic form
   is more stable over millennia (the equatorial cubic terms are ~600× larger and
   diverge), and Bill Gray recommends it for long spans — but for near-term epochs
   he notes the equatorial form is preferred, and the two differ by only about a
   nanoradian per 3 years from J2000, i.e. **~2 milliarcsec in 2026**. Irrelevant
   here. Comment it so nobody "fixes" it later thinking the ecliptic form is a bug.
   Polynomials, arcsec, `t` = Julian centuries TT from J2000:
   `ζ = t(2306.2181 + t(0.30188 + 0.017998t))`,
   `z = t(2306.2181 + t(1.09468 + 0.018203t))`,
   `θ = t(2004.3109 + t(−0.42665 − 0.041833t))`.
3. **TEME is not true-equinox-of-date.** The chain is
   `TEME --R3(−Eq_eq)--> TOD --N^T--> MOD --P^T--> J2000`.
   The *sign* of the equation-of-equinoxes step is not a matter of taste: TEME→PEF
   uses GMST (the SGP4 convention satellite.js implements) while TOD→PEF uses
   GAST = GMST + Eq_eq, so `R3(GMST)·v_TEME = R3(GAST)·v_TOD` forces
   `v_TOD = R3(−Eq_eq)·v_TEME`. The cross-check test below verifies it.
   Bill Gray's `sat_id` skips the equation of the equinoxes entirely and uses a
   linear-rate precession approximation (`observe.cpp:80`), fine at his 4° search
   radius. **Eq_eq reaches ±1.15 seconds of time — that is ±17″ of arc, not ±1.1″**;
   the seconds-of-time/arcsec confusion is easy to make and this document made it
   once. We do the full rotation because our FOV boundary is the answer, not a
   loose filter.
4. **Time scales.** Precession and nutation take TT; GMST takes **UT1**.

### Accuracy budget — be honest about which term dominates

| Term | Magnitude | Applied? |
|---|---|---|
| TLE position error (fresh → 1 week old) | ~1–20 km ⇒ **7′–2°** at 500 km range | irreducible |
| **UT1−UTC (DUT1) ignored** | ≤ 0.9 s ⇒ 0.42 km site shift ⇒ **≤ 2.9′** | optional `dut1S` setting, default 0 |
| Refraction (if toggled off) | 1.7′ at El 30°, 5′ at El 10° | user's choice |
| Annual aberration | ≤ 20.5″ | no (consistently, both sides) |
| Precession + nutation, done properly | < 1″ | **yes** |
| Equatorial vs ecliptic precession form | ~2 mas | irrelevant |
| Light-time, diurnal aberration | < 0.3″ | no |

So: **`frames.js` must not be the dominant error, and it easily is not.** The claim
to make in the UI is "arcsecond-level frame handling; arcminute-level truth, limited
by TLE age" — never "arcsecond accuracy". Expose `dut1S` in settings because it is
the largest term we could remove and choose not to by default.

### Mandatory verification (`frames.js` ships with these or it is not done)

- **Round trip**: `j2000ToTeme(temeToJ2000(v, t), t)` matches `v` to < 1e-12 for a
  spread of dates. Guaranteed by construction if rule 1 is obeyed — so it is really
  a test that rule 1 was obeyed.
- **Cross-check against the well-tested path**: for a real satellite, compute alt/az
  two ways — (a) satellite.js `eciToEcf(teme, gmst)` → `ecfToLookAngles`, the path
  SatObserver has used all along, and (b) `temeToJ2000` → `raDecToAltAz` with
  refraction off. **They must agree to < 1″.** This single test catches sign errors
  in the equation of the equinoxes, nutation or precession, wrong units, and a
  GMST/GAST mix-up. It needs no external data.
- **Absolute sanity**: precessing the J2000 vernal equinox to 2026.5 must move it by
  ≈ 0.363°, and a known star's J2000 → mean-of-date offset must match a published
  value to < 1″.

## SAT.bus — event bus (in state.js)

`SAT.bus.on(event, fn)`, `SAT.bus.off(event, fn)`, `SAT.bus.emit(event, payload)`.

Events (payloads):
- `'time'` `{date: Date, jumped: bool}` — every animation tick from the clock.
- `'obs-changed'` `{field: string}` — pointing / FOV / timespan edited.
  Consumers redraw; `SAT.scan` marks its result **stale** but does not auto-rerun.
- `'scan-started'`, `'scan-progress'` `{done, total, phase:'coarse'|'fine'}`,
  `'scan-done'` `{count, ms, truncated: bool}`, `'scan-failed'` `{error}`.
- `'catalog-changed'` — the loaded object set changed (sources window updated it).
- `'locations-changed'` — site list / active flag changed.
- `'selection-changed'` `{satId: string|null}`.
- `'filters-changed'` — crossing display filters changed (no rescan needed).
- `'settings-changed'` `{section: string}`.
- `'state-loaded'` — initial state restored from backend; rebuild UI.

## SAT.state (state.js)

Data (JSON-serializable, persisted to backend `/api/state` debounced 800 ms):

```js
SAT.state.obs = {
  mode: "radec",            // "radec" | "altaz"
  raDeg: 83.822, decDeg: -5.391,      // J2000, used when mode === "radec"
  azDeg: 180, elDeg: 60,              // apparent, used when mode === "altaz"
  track: "sky",             // "sky" = field fixed on the celestial sphere (sidereal
                            //   tracking); "mount" = field fixed in alt/az (parked /
                            //   drift scan). Default "sky" in radec, "mount" in altaz.
  fovShape: "rect",         // "rect" | "circ"
  fovWDeg: 1.5, fovHDeg: 1.0,         // rect: full width/height on sky
  fovRDeg: 0.75,                      // circ: radius
  rotDeg: 0,                // position angle of chart +Y (up), north through east
  flipEW: false,            // mirror the chart (odd number of reflections)
  spanMin: 60,              // scan timespan, minutes, starting at the clock time
  dut1S: 0                  // UT1-UTC seconds; 0 unless the user cares about 2.9'
}
// refraction left obs in round 2: always applied, never a per-observation choice.
// exposureS / plateScaleAsPerPx were removed in the round-1 review: the trail
// across the FOV (path + entry/exit + rate + duration) is the identification
// tool, and a separate per-exposure streak length duplicated it while demanding
// a plate scale the user did not want to supply.

SAT.state.filters = {
  maxMag: 14,               // estimated visual magnitude cut; 99 = off
  sunlitOnly: false,        // drop eclipsed objects
  minElDeg: 0,              // horizon cut applied during the scan
  classes: { leo:true, meo:true, geo:true, heo:true },
  types: { "PAY":true, "R/B":true, "DEB":true, "UNK":true },  // SATCAT object type;
                            // typeless objects sit in UNK so they never vanish silently
  minAltKm: 0, maxAltKm: 0, // geodetic height at closest approach; 0 = no limit
  maxRateAsPerS: 0, minRateAsPerS: 0   // 0 = no limit
}

SAT.state.catalog = {       // the object set the scan runs against — a MERGED set
  objs: [ObjEntry, ...], count: N, bad: N,
  sources: {                // per-source rehydrate refs + presence
    spacetrack: [{source, fetched, cacheKey}, ...],   // most recent last, capped 8
    mccants:    [{source, fetched, cacheKey}, ...],
    paste:      {fetched} | null,
  }
}
// ObjEntry — deliberately flat and small; ~27k of these live in memory
{ id: "o_25544", norad: 25544, name: "ISS (ZARYA)", intl: "1998-067A",
  l1: "1 25544U ...", l2: "2 25544U ...",
  rcs: 399.05,            // m^2 from SATCAT, or null (absent above NORAD 50000)
  type: "PAY",            // SATCAT OBJECT_TYPE: PAY | R/B | DEB | UNK, or null
  stdMag: -1.3,           // McCants qsmag standard magnitude, or null
  src: "spacetrack" }     // 'spacetrack' | 'mccants' | 'paste' — drives per-source stats
// non-persisted runtime fields (stripped on save): _satrec, _satrecBad.
// Deduplicated by NORAD across sources, NEWEST TLE EPOCH WINS regardless of
// source — so after a collision the owning src reflects whose elements are
// fresher, and the per-source statistics count final ownership, not loads.
// Cached sources are NOT written into state.json (too large): they re-hydrate
// from /api/cache/<cacheKey> via catalogRefs. Pasted TLEs have no server cache,
// so they persist inline as `pasted` (capped 2000 — paste means a handful).

SAT.state.locations = [{ id, name, kind, latDeg, lonDeg, altM, norad, active: false, color }]
// kind: 'ground' (default — a missing kind IS 'ground', so pre-v0.2 saves need no
// migration) | 'orbit'. An orbit site observes from a catalogue object: `norad`
// names it, and the TLE is RESOLVED FROM THE LOADED CATALOGUE at use time — the
// site never stores element lines of its own, so it can never silently go stale
// relative to the catalogue it identifies against. latDeg/lonDeg/altM stay 0 on
// orbit sites (numeric, so a missed ground-only code path degrades, not throws).
// state.resolvedSite(loc?) is the ONE resolution point: ground sites pass through;
// orbit sites come back with {l1, l2, objName} attached, or {missing:true} when the
// catalogue lacks the NORAD — callers show that, they do not guess.

SAT.state.settings = {
  chart:  { stars:true, starNames:false, constLines:true, constNames:false,
            sunMoon:true, mw:false, grid:true, magAuto:true, magLimit:9.0,
            labels:true, padFrac:0.7 },
  // round 14: magAuto (default true) makes the chart's star depth follow the view
  // span (see the chart section); magLimit is the pinned MANUAL limit, used only
  // when magAuto is false. Old saved states lack magAuto and so pick up the
  // adaptive default on first load — that migration is deliberate.
  allsky: { eastLeft:true, elStep:30, stars:true, sunMoon:true, mw:false },
  // round 12: allsky.magLimit retired — the All-Sky star field is the bright
  // catalogue only (see its panel section); a stored value is ignored.
  scan:   { coarseStepS:30, fineStepS:1.0, marginDeg:0 /*0 = auto*/,
            workers:0 /*0 = auto: hardwareConcurrency-1, capped 8*/,
            maxCrossings:5000 },
  layout: { <windowId>: {x,y,w,h,open} }   // maintained by SAT.windows
}

SAT.state.scan = {          // runtime only, not persisted
  crossings: [Crossing, ...], ranAt: Date|null, stale: bool, params: {...}
}
SAT.state.selection = { satId: null }
```

Methods:
- `activeLocation() -> location|null`
- `getObj(id) -> ObjEntry|null`, `objByNorad(n) -> ObjEntry|null`
- `setSelection(satId|null)` / `clickSelect(satId|null)` — emit `'selection-changed'`.
- `visibleCrossings() -> Crossing[]` — `scan.crossings` after applying
  `SAT.state.filters`. **The single filter point.**
- `chartCrossings() -> Crossing[]` — `visibleCrossings()` narrowed to the rows
  ticked in the Crossings table (`scan.checked`, a runtime Set cleared on every
  new scan) when any are ticked. The chart and all-sky view draw THIS; the table
  keeps listing `visibleCrossings()` so boxes can still be unticked.
- `setObs(patch)` — merge into `obs`, normalize (wrap RA, clamp Dec/El, keep
  `fovWDeg/fovHDeg` > 0), mark `scan.stale = true`, emit `'obs-changed'`, `save()`.
- `addTles(tag, payload, {replace}) -> {count, bad, added, updated}` — merge a
  TlePayload into the catalogue under `tag` ('spacetrack'|'mccants'|'paste') and
  build every satrec up front. `replace:true` drops the tag's previous objects
  first (Load-full-catalogue semantics); otherwise additive (queries, successive
  files, successive pastes). Emits `'catalog-changed'`.
- `clearSource(tag)` — remove everything a source contributed.
- `sourceStats() -> {tag: {count, newestD, medianD, oldestD}}` — TLE-epoch ages in
  days **against the sim clock** (scanning yesterday's exposure against today's
  ages would misstate every number); tags with no objects are absent.
- `save()` — debounced push to backend. Call after ANY mutation.
- `load() -> Promise` — restore state, replay `catalogRefs` through `addTles`, then
  restore `pasted`, then emit `'state-loaded'`.

## SAT.frames (frames.js) — AGENT F

Pure functions, no state. Accuracy target **better than 1 arcsec** for every
transformation below; it must never be the dominant error.

- `jdTT(date) -> number` — Julian Date in TT (TAI+32.184 s; UTC→TAI uses a built-in
  leap-second table through 2026, extrapolate flat and note it).
- `gmstRad(date) -> number`, `gastRad(date) -> number` (GMST + equation of equinoxes).
- `precessionMatrix(date) -> M[3][3]` — IAU-1976, J2000 → mean of date (zeta, z,
  theta polynomials).
- `nutation(date) -> {dPsiRad, dEpsRad, epsARad}` — IAU-1980 truncated to the 20
  largest terms (≤ 0.05″ residual).
- `temeToJ2000(v, date) -> {x,y,z}` — TEME of date → J2000 mean equinox. This is
  `P^T · N^T · R3(+eqeq)` applied to `v`. **Every satellite RA/Dec in this app goes
  through here.** Inverse: `j2000ToTeme(v, date)`.
- `siteEcefKm(loc) -> {x,y,z}` — WGS-84 geodetic → ECEF, using `altM`.
- `siteTemeKm(loc, date) -> {x,y,z}` — the above rotated by GAST (not GMST — TEME's
  x-axis is the *uniform* equinox; use `gmstRad` here to match satellite.js's own
  convention and stay self-consistent with `SAT.prop`).
- `topoTeme(loc, satTemeKm, date) -> {x,y,z}` — satellite minus site, in TEME.
- `vecToRaDec(v) -> {raDeg, decDeg, rKm}` and `raDecToVec(raDeg, decDeg) -> {x,y,z}` (unit).
- `raDecToAltAz(raDeg, decDeg, loc, date, {refract:bool}) -> {azDeg, elDeg}` — J2000
  → alt/az. Applies precession/nutation to date, hour angle from GAST + longitude,
  then refraction if requested.
- `altAzToRaDec(azDeg, elDeg, loc, date, {refract:bool}) -> {raDeg, decDeg}` — inverse.
- `refractionDeg(elDeg, {tempC=10, pressureMb=1010}) -> number` — Bennett's formula
  with the Sæmundsson inverse; returns 0 below −1° elevation.
- `sep(ra1, dec1, ra2, dec2) -> Deg` — Vincenty great-circle (stable at small angles).
- `posAngle(ra1, dec1, ra2, dec2) -> Deg` — of point 2 from point 1, N through E.
- `sunJ2000(date) -> {raDeg, decDeg, rAu}`, `sunTemeKm(date) -> {x,y,z}` — low
  precision (±0.01°), enough for phase angle and eclipse.
- `moonJ2000(date) -> {raDeg, decDeg, rKm}` — ±0.3°, used for a moon marker + a
  "moon separation" column.

### Gnomonic projection (also in frames.js)

- `SAT.frames.tanProject(raDeg, decDeg, ra0, dec0) -> {xi, eta} | null` — standard
  coordinates in **degrees**, xi east, eta north; `null` when the point is more than
  90° from the tangent point.
- `SAT.frames.tanDeproject(xi, eta, ra0, dec0) -> {raDeg, decDeg}` — inverse.

The chart then applies rotation and E/W flip on top of `{xi, eta}` — projection and
orientation stay separate so the crossing geometry never depends on display settings.

## SAT.prop (propagate.js) — SGP4 via global `satellite`

Trimmed from SatObserver: no ground tracks, no footprints, no orbit lines.

- `ensureSatrec(obj) -> bool` — build+memoize `_satrec`; false if the TLE is invalid.
- `temeKm(obj, date) -> null | {r:{x,y,z}, v:{x,y,z}}` — position and velocity, TEME.
- `look(loc, obj, date, opts) -> null | {raDeg, decDeg, azDeg, elDeg, rangeKm,
  rangeRateKmS, rateAsPerS, paDeg, rateMountAsPerS, paMountDeg, phaseDeg, sunlit,
  shadow:'none'|'penumbra'|'umbra', teme, temeVel}` — the full topocentric solution
  used by chart, table and info window. RA/Dec are J2000 via
  `SAT.frames.temeToJ2000`.

  **Two angular rates, because which one streaks the exposure depends on how the
  instrument was tracking, and for some orbits they differ by everything:**

  - `rateAsPerS` / `paDeg` — `d(RA,Dec)/dt`, motion against the **stars**. This is
    the streak on a sidereally-guided exposure, and it is the default. A
    geostationary object is *not* stationary here: it co-rotates with the Earth and
    so drifts through the star field at very nearly the sidereal rate, ~15″/s —
    which is precisely why GEO objects appear as dashes in tracked images.
  - `rateMountAsPerS` / `paMountDeg` — `d(alt,az)/dt`, motion against the
    **horizon**: what a parked or alt-az-fixed instrument sees. Here a
    geostationary object really is a fixed dot and the stars are what trail.

  Both are verified against finite-differenced sky and alt/az positions in
  `tools/test_propagate.js`. Consumers pick by `SAT.state.obs.track`: `'sky'` ⇒ the
  sidereal pair, `'mount'` ⇒ the mount pair. Getting this wrong is not a rounding
  error — it is 15″/s, which over a 30 s exposure is 7.5′ of streak that either
  exists or does not.
- `classOf(obj) -> 'leo'|'meo'|'geo'|'heo'` — from mean motion and eccentricity
  (geo: 0.9 ≤ n ≤ 1.1 rev/day and e < 0.05; heo: e ≥ 0.25; leo: n > 5; else meo).
- `periodMinutes(obj) -> number`, `Re = 6378.137`, `Rp = 6356.752`.

## SAT.scan (scan.js + worker/scan-worker.js) — AGENT E

**The heart of the tool.** Finds every object whose topocentric direction enters the
field between `t0` and `t0 + spanMin`, running SGP4 in a pool of Web Workers.

`SAT.scan.run() -> Promise<Crossing[]>` — reads `SAT.state.obs/filters/settings.scan`
and the active location; emits `'scan-started'`, then `'scan-progress'`, then
`'scan-done'`. `SAT.scan.cancel()`. `SAT.scan.isRunning() -> bool`.

```js
// Crossing
{ satId, norad, name, intl,
  tEnterMs, tExitMs, tCaMs,        // FOV entry, exit, closest approach to field centre
  sepCaDeg,                        // separation from pointing at closest approach
  raDeg, decDeg,                   // J2000 at tCaMs
  azDeg, elDeg, rangeKm, rangeRateKmS,
  rateAsPerS, paDeg,               // vs the STARS (sidereal guiding) — see SAT.prop.look
  rateMountAsPerS, paMountDeg,     // vs the HORIZON (parked mount)
  magEst, phaseDeg, shadow,        // photometry at tCaMs
  cls, sunElDeg,                   // orbit class, site solar elevation at tCaMs
  type, altKm,                     // SATCAT object type; geodetic height at tCaMs
  path: [{t, raDeg, decDeg}, ...]  // <=64 samples spanning tEnter..tExit, for drawing
}
```

### Algorithm — three stages, in this order

Stage 1 and 2 are what make a full-catalogue scan interactive; do not skip them.

**Stage 1 — static geometric cull (no SGP4 at all).** Bill Gray's `sat_id` has no
such cull — it brute-forces the catalogue at a single epoch, which is cheap. We scan a
*timespan*, so every object removed here is removed from every step. From `satrec`
alone (`inclo`, `nodeo`, `no_kozai`, `ecco`) compute the semi-major axis and hence
apogee/perigee heights, then reject the object outright when any test fails:

- *Horizon reachability.* The sub-satellite point never leaves `|lat| ≤ i`. The site
  is at geodetic latitude φ. The minimum possible ground-arc between site and
  sub-point is `max(0, |φ| − i)`; the object is above the horizon only if that is less
  than the horizon half-angle `acos(Re / (Re + h_apogee))`. Fail ⇒ never visible.
- *Declination reachability.* A satellite seen along the pointing ray sits at
  geocentric position `siteVec + ρ · rayVec` for some range ρ ∈ [h_perigee, h_apogee +
  2·Re]. Sweep ρ over ~24 log-spaced samples and keep the min/max geocentric
  declination. The satellite's own geocentric declination is bounded by `|δ| ≤ i`.
  If the whole ray-declination interval lies outside `[−i, +i]` padded by the FOV
  radius, the object can never appear in this field.
- *Orbit-plane test* — **the strong one, and strictly tighter than the two above.**
  The satellite's geocentric position always lies *in* its orbital plane, so it is
  exactly perpendicular to the plane normal `n̂(i, Ω)`. For each sampled range ρ along
  the sightline, the candidate geocentric position `p = siteVec + ρ·rayVec` must
  satisfy `|p̂ · n̂| ≲ tol`. If no ρ satisfies it, the object can never be in the field.
  The tolerance must absorb the nodal regression of Ω over the timespan:
  `tol = sin(fovRadius) + |Ω̇| · spanMin/1440 + margin`, with
  `Ω̇ = −1.5 · J2 · (Re/p)² · n · cos i` (rad/day). Fresh, short scans get a very tight
  test; a 24 h scan on a LEO object relaxes it by the ~5°/day the plane actually
  sweeps. Unlike the declination test this uses Ω, so it discriminates *which*
  polar orbits can reach the field, not merely whether the inclination is high enough.

Typical survival on a 27 k catalogue is 10–40% depending on pointing; a pointing near
the pole kills the entire GEO belt outright. Report the counts (see below) — a cull
this aggressive must be visible, or a bug in it looks like "no satellites tonight".

**Stage 2 — coarse time sweep, in TEME.** Survivors are sharded across workers. Per
epoch, **once**, each worker computes GMST, the site's TEME vector, and the pointing's
TEME unit vector (J2000 → TEME via `frames`, i.e. the *pointing* is rotated, never the
catalogue). Then per satellite: `sgp4(satrec, tsince)`, topocentric vector by
subtraction, horizon test `dot(topo, site) > 0`, and separation as a **dot product
against `cos(margin)`** — no `acos`, no `atan2` anywhere in this loop.

The margin is adaptive, recomputed per step from that step's own range and speed:

```
margin = fovRadiusDeg + omegaDeg * coarseStepS + tleSlopDeg,  omega = |v_topo| / rangeKm
```

so a GEO object gets arcminutes while an overhead LEO object gets tens of degrees.
`tleSlopDeg` is a **per-object tolerance from TLE age** — Bill Gray's `# Max error`
idea: elements a month old on a decaying LEO object need a much wider box than
fresh ones. Grow it roughly linearly with `now − epoch`, and surface it in the UI so
a match found only inside the slop is not presented as a confident identification.

A step whose separation is under the margin opens (or extends) a *candidate window*
`[t − coarseStep, t + coarseStep]`. Where consecutive coarse positions straddle the
field, prefer the **great-circle arc** between them to a point test with a padded
radius: it is a cheaper-to-satisfy and tighter criterion, and it permits a larger
`coarseStepS` for the same recall.

**Stage 3 — fine refinement.** Each candidate window is re-stepped at `fineStepS`
(default 1 s). Separation vs. the FOV boundary (rectangular in the rotated chart frame,
or circular) gives the in-field samples; `tEnterMs`/`tExitMs` are bisected to 50 ms
against that boundary, `tCaMs` by parabolic fit on the separation minimum. Photometry,
rate, PA and up to 64 `path` samples are computed here. Objects that never actually
enter the field are dropped.

Rejected-at-each-stage counts are reported in `'scan-done'` and shown in the UI —
a scan that culls 90% of the catalogue should say so, not look like it found nothing.

**Budget.** Stage 2 dominates. Measured at 0.61 µs per propagation (see Performance
decisions), 27 k objects × 40% survival × 120 coarse steps ≈ 1.3 M propagations ≈
0.8 s single-threaded, ~0.15 s across 6 workers. If the estimate exceeds ~60 M
propagations, `run()` refuses and reports the estimate plus the two knobs that fix it
(`coarseStepS`, `spanMin`) rather than freezing the tab.

`maxCrossings` truncates the result set; `'scan-done'` carries `truncated:true` so the
UI can say so explicitly. Never silently drop.

### Worker protocol (`js/worker/scan-worker.js`)

Classic worker, `importScripts('../vendor/satellite.min.js')` plus an inlined copy of
the handful of `SAT.frames` functions it needs (workers cannot see the main-thread
`SAT`; keep the duplicated maths in a clearly-marked block and keep it byte-identical
in behaviour to `frames.js` — `frames.js` is the reference implementation).

- main → worker `{cmd:'load', objs:[{id,norad,name,intl,l1,l2,rcs,stdMag}]}`
- main → worker `{cmd:'scan', params:{t0Ms, spanMin, site, pointing, fov, filters, steps}}`
  — `site` is either `{kind:'ground', latDeg, lonDeg, altM}` or
  `{kind:'orbit', norad, l1, l2, name}`: scan.js resolves the TLE from the catalogue
  *before* posting, because the worker owns satrecs for its shard only and the
  observer must exist in every worker.
- worker → main `{type:'progress', done, total}`
- worker → main `{type:'result', crossings:[...], culled:{stage1, stage2}}`
- main → worker `{cmd:'cancel'}`

## Orbital observing stations (v0.2) — the moving-observer amendment

A site may be a satellite (`kind:'orbit'`, space-based SSA: who crosses *my sensor's*
field). The scan pipeline was built so that the observer enters the geometry at
exactly one point — the TEME position/velocity provider — and this amendment keeps it
that way. **Nothing downstream of the provider may ever ask what kind of observer it
serves**, with the short list of physics gates below as the only exceptions.

### The observer provider

`obsStateAt(t) → {r, v}` in TEME km, km/s — the ONE place observer kind matters:

- ground: `r = R3(−gmst)·ecef`, `v = ω⊕ ẑ × r` (what siteTemeAt + the inline
  velocity always were; now they also hand back `v` so no caller reconstructs it);
- orbit: one `sgp4(obsRec, tsince)` — the observer's satrec is built once in
  `prepare()` from the TLE resolved out of the catalogue. One extra propagation per
  epoch against 32 k targets: unmeasurable. An invalid observer TLE fails the scan
  loudly at prepare time; it must never fail open into "scanned from (0,0,0)".

Main-thread mirror: `SAT.prop.obsState(loc, date)`, plus the dispatching converters
`SAT.prop.siteAltAzToRaDec / siteRaDecToAltAz` which every UI module now calls
instead of `SAT.frames.altAzToRaDec / raDecToAltAz` directly. For ground sites they
delegate verbatim (refraction included) — behaviour is byte-identical to v0.1.

### The LVLH frame — what "Az/El" means on an orbit site

Basis from the observer PV: `R̂ = r̂` (zenith, radially out), `Ŵ = (r×v)/|r×v|`
(orbit normal), `Ŝ = Ŵ×R̂` (along-track). Pointing angles:

```
boresight = cos(el)·(cos(az)·Ŝ + sin(az)·Ŵ) + sin(el)·R̂
```

so El is measured from the local-horizontal plane toward zenith (nadir = −90°), and
Az from the along-track direction toward the orbit normal — the same rotational
sense as ground azimuth N→E, with "north" played by the velocity direction. The
existing Az/El inputs, `track:'mount'`, and the parked-mount drift machinery all
carry over with this reading: a `track:'mount'` field on an orbit site is fixed in
LVLH (a body-mounted staring sensor) and its chart frame drifts at the orbital rate
through the stars, exactly as a parked ground mount drifts at the sidereal rate.
**No refraction, ever, on an orbit site** — the always-on refraction rule is a
ground-site rule; the converters gate it on kind, not the callers.

### Physics gates (the exhaustive list — do not add one without amending this)

1. **Horizon → Earth limb.** The ground gate `dot(topo, site) > 0` and `minElDeg`
   are meaningless in orbit (you can look down at a target against the Earth). An
   orbit site instead drops a sample iff the observer→target segment intersects the
   hard Earth sphere: with `t* = −s·ρ̂`, occluded when `0 < t* < ρ` and
   `|s + t*ρ̂| < Re`. Hard `Re`, no atmosphere pad — inclusion-conservative: a
   limb-grazing LOS is kept and the observer merely sees it against bright air.
   The limb test is part of `insideField`, so entry/exit bisection resolves a target
   *rising from behind the Earth* the same way it resolves a field edge.
2. **Sky/mount rates.** The sky rate is inertial and unchanged. The mount rate
   subtracts the observer frame's rotation: `ω⊕ ẑ × ρ` on the ground,
   `Ω_LVLH × ρ` with `Ω_LVLH = (r×v)/|r|²` in orbit.
3. **sunElDeg** keeps its formula (Sun's angle above the observer's local
   horizontal) — on an orbit site it reads as the observer's day/night state, which
   is what the twilight readout was for anyway.
4. **azDeg/elDeg on a Crossing** are LVLH angles on an orbit site (limb clearance is
   `elDeg` + 90° from nadir if anyone asks). Columns keep their headers.
5. **Self-exclusion.** The observer is removed from its own target list by NORAD at
   stage-2 shard setup: identifying yourself is never the answer.

### Stage 1 under a moving observer

The two quadratic culls (declination, orbit-plane) are already parameterized by
sampled observer positions and survive untouched *in form*. What breaks is the
sampling contract: 15-minute cadence assumed a site that moves 3.75°/15 min, and the
tests OR over samples, so sparse sampling on a LEO observer (56°/15 min) would cull
real objects — the one failure a cull must never have. On an orbit site:

- the *latitude/horizon-reachability* cull is **skipped** (fail open; the plane test
  was always the strong one);
- sightline range bounds widen to `ρ ∈ [max(1, rPeri_t − rObsMax), rApo_t + rObsMax]`
  with `rObsMin/Max` from the observer's own `orbitRadii`;
- observer samples come from `obsStateAt` at a cadence targeting ~2° of observer
  arc, capped at 600 samples; whatever arc the cap leaves unresolved is repaid as a
  *pad*: the between-sample chord `δ = 2·rObsMax·sin(Δθ/2)` is charged per object as
  `δ / max(rPeri_target, Re)` radians added to the declination limit and the plane
  tolerance. Provably conservative: a true observer position is within δ km of some
  sample, so the true candidate point `p` moves by ≤ δ and `|p| ≥ rPeri_target`.
- The soundness proof is the same one v0.1 shipped with: `useStage1:false` must
  return the identical crossing set, now exercised over orbital geometries too
  (tools/test_scan.js).

### Stage 2/3 under a moving observer

Adaptive margin `ω·Δt` with `ω = |v_target − v_obs|/ρ` was already
observer-general. Close conjunctions self-protect: `ω·Δt ≥ π` forces the step to
hit, so a target passing within `v_rel·Δt/π` (~100 km at 30 s steps) can never slip
between samples. The great-circle chord rescue keeps its justification — over one
coarse step the *relative* motion is near-rectilinear, and a straight relative
track sweeps a great circle for any observer. The residual is relative-acceleration
curvature, so **orbit sites clamp `coarseStepS` to ≤ 10 s** (curvature scales with
Δt², so 30 s → 10 s buys 9×) — the estimate/refusal maths must use the clamped
value, not the setting. TLE slop doubles up: `(slopKm_target + slopKm_obs)/ρ`,
because the observer's ephemeris error is indistinguishable from the target's at
the sensor.

### Documented omissions (measured against the TLE-slop floor, ~arcmin at best)

Light time (≤ ~5″ at 1 000 km for LEO-on-LEO) and the observer's orbital aberration
(v/c ≈ 25 µrad ≈ 5″) are ignored, as annual aberration already is for ground sites.
Both are two orders under the slop the UI already discloses. Do not "fix" one
without the other and without a use case that resolves 5″.

### UI consequences

- Sites window: Ground | Orbit toggle on the add form; orbit rows show a NORAD box
  plus the live-resolved catalogue name (or a red "not in catalogue" — the site
  stays, the *scan* is what refuses, with the same message).
- Pointing: the site line reads `NORAD n · name`; Az/El row labels grow an L
  subscript on orbit sites; the track toggle relabels Mount → LVLH. Same fields,
  same persistence, no second pointing model.
- All-Sky is a ground-horizon projection and says so on an orbit site instead of
  rendering nonsense. The chart, crossings table, sat-info and exports work
  unchanged through the converters.

## SAT.photo (photometry.js) — AGENT P

`magnitude(obj, geom) -> {mag, method}` where `geom = {rangeKm, phaseDeg, shadow}`.

### Why there are five tiers and not two (measured 2026-07-21)

The obvious design — McCants standard magnitude, else RCS-derived sphere — collapses
on a real modern catalogue, and the UI would have shown a column of identical guesses:

- **CelesTrak publishes no RCS at all above NORAD 50000.** Measured coverage:
  41–97% below NORAD 40000, 25.6% for 40000–49999, **0.0% for 50000+**. Of the 16 078
  objects in CelesTrak `active`, only **879** carry an RCS — because two-thirds of that
  catalogue is Starlink, and no Starlink has a published RCS.
- **`mmccants.org/programs/qsmag.zip` currently returns HTTP 404** while still being
  linked. The graceful-empty path is the live path today, so the qsmag tier is
  presently contributing nothing.

`OBJECT_TYPE` in `satcat.csv`, by contrast, is **100% populated** (DEB 35 832 /
PAY 27 088 / R/B 6 867 / UNK 160), so it carries the size information RCS no longer
does. Hence the `type` tier, and a `model` tier for constellations whose brightness is
actually documented. If a future reader finds the RCS join returning almost nothing,
**it is not a join bug** — verify against the NORAD ranges above before "fixing" it.

Tiers, best available first (`method` names which was used):

1. `"qsmag"` — McCants standard magnitude `obj.stdMag`, defined at 1000 km range and
   50% illumination:
   `m = stdMag − 15.75 + 2.5·log10(range²  / F(φ))` with `F` normalised so that
   `F(90°) = 1`, i.e. `m = stdMag + 5·log10(range/1000) − 2.5·log10(F(φ)/F(90°))`.
2. `"rcs"` — effective radius `r = sqrt(rcs/π)` metres from SATCAT, treated as a
   diffuse sphere of albedo 0.20:
   `m = −26.74 − 2.5·log10( albedo · r² · F(φ) / d² )`, `r` and `d = range` in metres.
3. `"model"` — a documented per-constellation brightness where one exists (Starlink,
   OneWeb). Coarse: real scatter exceeds a magnitude with orientation and hardware
   revision, so round numbers only.
4. `"type"` — size prior from SATCAT `OBJECT_TYPE`, treated as a diffuse sphere:
   R/B ~2.0 m, PAY ~1.0 m, DEB ~0.15 m. Order-of-magnitude size classes, nothing more.
5. `"default"` — `r = 1.0 m`; flag it as a guess in the UI.

`"eclipsed"` is returned with `mag: null` when the object is in shadow.
**Every tier below `"rcs"` is a prior, not a measurement.** The table shows `method`
per row so a user can see exactly how much to trust a magnitude, and the magnitude
filter must never silently drop rows whose magnitude is a guess.

`F(φ) = (2/(3π²))·[(π−φ)·cos φ + sin φ]` — Lambertian sphere phase function, φ in
radians. `shadow !== 'none'` ⇒ `mag = null` (eclipsed objects are not visible;
penumbra dims by `2.5·log10` of the unobscured solar fraction).

- `phaseAngleDeg(sunTeme, siteTeme, satTeme) -> Deg` — Sun–satellite–observer angle.
- `shadowState(satTemeKm, date) -> {state:'none'|'penumbra'|'umbra', frac}` — conical
  Earth shadow with the solar angular radius, oblateness ignored (≤ 0.3 s of timing
  error at the terminator).

## SAT.stars (stars.js) — AGENT S

Loads `assets/stars_m9.bin` once (fetch → ArrayBuffer → typed-array views) and answers
cone queries. Since round 12 the only cone consumer is the **sky chart** — the
All-Sky panel's star field is the bright catalogue only (its SatObserver fallback;
see its panel section). The chart also uses `named()` / `constellationLines()`,
which are bright-catalogue helpers anyway. Falls back to `SAT.stardata` (the
bright-star catalogue
from SatObserver, mag ≤ 4.6) when the deep file is absent, so the app still runs
before `tools/make_starcat.py` has been executed.

**Built and verified 2026-07-21: 130 183 stars to V = 9.0, 1.30 MB** (Tycho-2).
Round 2 added a Gaia DR3 build (`--source gaia`, `assets/stars_deep.bin`, V ≤ 10.5,
proper motions propagated to epoch 2026.5); `stars.js` prefers it when present and
falls back to the Tycho file, then to the bright catalogue. The PM propagation is
not cosmetic: the Tycho build's J2000 mean places put 169 stars more than 13″ off
at the 2026 epoch, the worst by ~227″ (61 Cyg class) — visibly wrong on the chart.

Binary format — little-endian, **structure of arrays** so the frontend builds
`Float32Array`/`Int16Array` views directly over the buffer with no per-star parsing.
An interleaved 10-byte record would be misaligned and force a slow `DataView`.
Declination is sorted ascending so a cone query is a binary search over a dec band:

```
offset 0              magic "STR1"      4 bytes
offset 4              count uint32      4 bytes
offset 8              magLimit float32  4 bytes
offset 12             ra   float32[count]   degrees, [0, 360)
offset 12 + 4*count   dec  float32[count]   degrees, ASCENDING
offset 12 + 8*count   mag  int16[count]     V * 100
```

`float32` holds RA to ~0.08″, far finer than the ~0.5″ of proper motion we ignore by
keeping J2000 mean places. Both are negligible against arcminute-scale TLE error.

Three data-quality decisions in `make_starcat.py`, each of which was a bug first:

- **Tycho-2 main is not enough.** Its reduction saturates on the brightest stars, so
  the main catalogue is missing Sirius, Vega, Arcturus, Betelgeuse and Acrux. Fetch
  supplement 1 (`I/259/suppl_1`) as well.
- **Take BSC5 magnitudes, keep Tycho positions.** Tycho VT/BT saturate at the bright
  end and BT is often blank there (Sirius comes out at V = −1.10 instead of −1.46),
  but `starcat.js` positions are rounded to 0.01° ≈ 20–36″. So the merge overwrites
  *only the magnitude* of the nearest Tycho star — adopting BSC5 positions would trade
  two orders of magnitude of astrometry for a photometric fix. Match radius must be
  ≫ 0.01° (90″ is used) or the bright stars silently fail to match; within the radius
  take the **brightest** candidate, not the nearest.
- **Dedupe near-coincident entries** (< 2″, keep the brighter). Main and supplement
  overlap slightly — Arcturus appears twice, 0.2″ apart, with V = −0.1 and a saturated
  V = 3.47 — and which one a lookup returns is otherwise a coin toss. 539 removed.

The builder ships a `sanity_check()` that asserts six named bright stars are present
with the right magnitude. It caught every one of the above. Keep it.

- `SAT.stars.load() -> Promise<{count, deep: bool}>` — called once from `main.js`.
- `SAT.stars.cone(ra0, dec0, radiusDeg, magLimit) -> [{raDeg, decDeg, mag}, ...]`
  — dec-band binary search, then exact separation test; capped at 20000 results.
- `SAT.stars.named(ra0, dec0, radiusDeg) -> [{raDeg, decDeg, name}, ...]` and
  `SAT.stars.constellationLines(ra0, dec0, radiusDeg) -> [[{raDeg,decDeg},...], ...]`
  — both from `SAT.stardata`; used for wide fields only.
- `SAT.stars.isDeep() -> bool`.
- `SAT.stars.localLimit() -> number` (round 14) — the live catalogue's magnitude
  limit, read from the binary header (10.5 Gaia build / 9.0 Tycho / 4.6 on the
  bright fallback). The chart compares its wanted depth against this to decide
  when the deep tile set is needed at all.
- `SAT.stars.deepField(ra0, dec0, radiusDeg, magLimit, onReady)
  -> {state:'ready'|'loading'|'error', stars, truncated}` (round 15 — LOCAL deep
  tiles; the round-14 online VizieR cone is REMOVED, no runtime network fetch) —
  the deep star source behind the chart's < 3° fields, reading the tiled local
  catalogue that `make_starcat.py --deep17` builds (see below) through
  `GET /api/stars/deep` (presence probe, once) and `GET /api/stars/tile/<name>`
  (one small binary per tile, LRU-cached ~16 tiles in memory). Never throws,
  never rejects. When every tile covering the cone is cached the result is
  computed synchronously — per-tile cone queries (the same kernel `cone()` uses)
  merged and capped at the brightest 20000 — and the state is `'ready'`;
  missing tiles are fetched (local server, milliseconds) and `'loading'` returns
  with `stars:null`, the chart drawing the bundled catalogue until `onReady`
  fires. If the tile set has not been built (probe says absent, or a tile 404s)
  the state parks in `'error'` and the chart stays on the bundled catalogue with
  a footer note saying the deep catalogue is not built — quietly, no per-frame
  retries (re-probe only on a fresh page load).
- `SAT.stars.tilesForCone(ra0, dec0, radiusDeg) -> [name, ...]` (round 15, pure,
  unit-tested) — the tile names covering a cone under the scheme below, handling
  the RA wrap and the polar caps.

**Deep tile set** (round 15): `data/stars17/` (gitignored — several hundred MB;
per-machine, built once by the user; the packaged app reads it from its own
DATA_DIR, so copy or rebuild it into Application Support for the .app). Scheme:
4° declination bands indexed 0..44 from −90; bands with |dec| ≥ 86 are single
polar tiles, every other band splits into twelve 30° RA columns; names are
`t<band>_<col>.bin` (polar caps use col 0). Each tile is the same STR1
structure-of-arrays binary as the bundled asset (header magLimit = the build's
V cut), dec-sorted for the shared cone kernel. `index.json` records
`{magLimit, count, tiles, builtIso, epochYr}` and is what the presence probe
serves. Gaia DR3 via VizieR per tile (Gmag < cut + 0.5, G→V by Riello+ 2021,
proper motions to the build-time decimal year), with the BSC5 bright-star merge
applied per tile — Gaia genuinely lacks its saturated brightest stars (Vega,
Sirius class), and a 2° field containing Vega must still show Vega. A fetch
that trips the size guard splits recursively in RA. The build is resumable:
tiles whose file already exists are skipped.

`tools/make_starcat.py` fetches Tycho-2 from VizieR, keeps `VT ≤ 9.0`, converts to
Johnson V, sorts by declination and writes the file. Dev-time only; the generated
asset is committed so users never need it. `--source gaia` builds the deeper
bundled asset; `--deep17` (round 15) builds the deep tile set above.

## Panel modules (window content)

Each is registered from main.js via
`SAT.windows.register({... build: (body, win) => SAT.<mod>.init(body, win)})`.

### SAT.chart.init(bodyEl, win) — AGENT C (js/chart.js) — MAIN VIEW

Gnomonic (TAN) sky chart on `<canvas>`, tangent at the pointing. This is the primary
view and gets the largest default window.

- Scale set so the FOV fits with a configurable padding (default: FOV occupies 70% of
  the shorter axis, so context outside the field is visible). Wheel zooms about the
  cursor (0.2×–20× relative to fit), drag pans; **double-click re-aims** — the
  clicked sky position becomes the new pointing, centred (round-3 review; drag
  somewhere, double-click the spot). Fit-to-window lives on the ⤢ toolbar button.
- Orientation: apply `rotDeg` then `flipEW` to `{xi, eta}`. A compass rosette in a
  corner shows N and E arrows *after* the transform, so the user can verify the
  chart matches their frame. Always visible; this is the thing people get wrong.
- Layers, respecting `settings.chart` and redrawing on `time / obs-changed /
  scan-done / filters-changed / selection-changed / settings-changed / state-loaded`:
  - **Chart star background (round 15 — adaptive depth, all local, binding).**
    Stars from `SAT.stars.cone` down to an *effective* magnitude limit. Default
    is **auto** (`settings.chart.magAuto`): the limit follows the view span D —
    the diameter in degrees of the circle enclosing the viewport — via the pure
    helper `SAT.chart.autoMagLimit(D)`:
    - **D < 3°: 17.0**, served by the LOCAL deep tile set through
      `SAT.stars.deepField` (round 15; the round-14 online VizieR fetch is
      REMOVED — no runtime network access, ever). While tiles load (local
      server, milliseconds) or when the tile set has not been built, the
      bundled catalogue draws at its own `localLimit()` and the footer says
      which of those it is.
    - **D ≥ 3°: clamp(10.5 − 5·log10(D/3), 4.5, 10.5)** — 10.5 at 3°, 9 at 6°,
      7.5 at 12°, 6 at 24°, floor 4.5 from ~48° up — entirely from the bundled
      catalogue, so star counts stay bounded as the field grows.
    The m-limit toolbar button cycles auto → 4.5/6/7.5/9/11 → auto (a manual
    value pins `magLimit` and clears `magAuto`; the footer always states the
    effective limit).
    **Star rendering (round 15 — Stellarium-derived, binding).** The mapping
    from magnitude to dot follows Stellarium's `StelSkyDrawer::computeRCMag`
    design, adapted to a fixed-tone canvas (pure helper
    `SAT.chart.starDot(mag, mlim) -> {rad, lum}|null`, unit-tested; `mlim` is
    the *drawn* depth — the delivered catalogue's limit, not the wanted one):
    - Exposure shift (Stellarium's FOV factor): `m = mag − max(0, mlim − 11)`,
      so deep narrow fields behave like a longer exposure — an m17 star at an
      m17 limit renders like m11 did at m11 — while limits ≤ 11 keep the
      round-9 look for every star above the faint floor.
    - Flux-law radius (round 9, kept): `rr = 5.2·10^(−0.085·m)`; luminance ramp
      `lum = clamp(1.04 − 0.058·m, 0, 1)`.
    - **Faint end (the round-15 change): below `rr = 1 px` the dot stops
      shrinking and FADES instead** — `lum *= rr³` (Stellarium's cubic
      sub-floor falloff), radius pinned at 1 px, and dots with `lum < 0.02`
      are culled entirely (Stellarium's 0.3-radius cutoff). The old hard
      floors (0.7 px, alpha 0.42) that turned every star of the faint tail
      into identical pepper are GONE — the field now grades smoothly to
      invisibility at the limit.
    - Bright end: radius past 6.5 px is sqrt-compressed
      (`6.5 + sqrt(1 + rr − 6.5) − 1`, Stellarium's MAX_LINEAR_RADIUS device),
      so Alcyone in a deep Pleiades field is prominent, not a blob.
    Round-12 note kept: the deep background is REAFFIRMED — the SatObserver
    bright-only fallback belongs to the **All-Sky panel** (see its section;
    the All-Sky keeps its own SatObserver dot law and is NOT changed by round
    15). Star names, constellation lines AND constellation names (`constNames`,
    round 11) draw on fields wider than 5°.
  - **Milky Way** isophote layer (`settings.chart.mw`, default off): the d3-celestial
    contours from `vendor/mwdata.js`, ported from the SatObserver polar chart to the
    gnomonic frame — far-hemisphere / near-90° vertices are clamped radially to an
    off-screen rim so fills stay finite, and any ring whose projected outline
    swallows the north galactic pole (a point outside every isophote) gets a
    rim-circle subpath to flip even-odd parity back, exactly as in SatObserver.
    **Documented deviation from SatObserver:** NO twilight/daylight sky tint and no
    MW twilight fade — the chart is a J2000 field view, not a local-sky view, so its
    background stays the fixed dark theme regardless of the sun.
  - **Sun and Moon** (`settings.chart.sunMoon`, default on): SatObserver-style icons
    — rayed sun disc, moon with its phase terminator, bright limb facing the sun's
    chart direction (via a waypoint 1° along the moon→sun great circle, since the
    sun itself may be over the tangent-plane horizon) — plus the
    "moon %.0f° away" footer note while the layer is on.
  - the FOV outline: solid rectangle (or circle) in the accent colour, with the
    field's angular size labelled on the edges; the region outside is dimmed ~25%.
  - a grid of RA/Dec lines with labels when `settings.chart.grid` (spacing chosen
    from the field size: 1°, 10′, 1′ …), plus a scale bar.
  - **per crossing** (from `SAT.state.chartCrossings()`): its **whole-timespan
    track** at low alpha (0.16) underneath everything — the object's sky path over
    the entire scan window while above the horizon, computed once per scan and
    cached on the crossing (adaptive step, ≤400 points, built ≤30 tracks per frame
    so the post-scan hiccup is spread) — then the scan's fine `path` (tEnter..tExit)
    as the bright polyline in the object's class colour, the portion already swept
    (before the current clock time) dimmed;
    the current-position marker + label follow the extended track at reduced alpha
    once the object has left the field, so a two-second crossing does not mean a
    two-second label;
    the current position at `SAT.clock.getDate()` as a filled square + label
    (name, and magnitude when known); the selected object gets a white ring.
- Interaction: hover shows a readout of cursor RA/Dec (and Alt/Az); click within 8 px
  of a marker selects that object; click elsewhere deselects; shift-click also
  re-aims but keeps the view still (both paths mark the scan stale; in alt/az mode
  the az/el pair is carried along so a parked mount re-aims too).
- Performance: dirty flag + rAF, devicePixelRatio aware, `'win-resize'` listener.
  Star cone results are cached and only re-queried when the tangent point or radius
  changes by more than 10% of the field.
- Expose: `SAT.chart = { init, requestRender, fitView }`.

### SAT.ui.crossings.init(bodyEl, win) — AGENT T (js/crossings.js) — MAIN LIST

The satellite list. Second-largest default window, docked beside the chart.

- Header: **Scan** button (primary; disabled while running, becomes **Cancel**),
  a progress bar with `done/total` and the current phase, and a summary line
  (`27 843 objects → 9 612 after geometry → 61 crossings in 2.3 s`). When
  `SAT.state.scan.stale`, the header shows an amber "parameters changed — rescan"
  tag rather than silently showing old results.
- Filter rows (order fixed in round 2): sunlit-only, altitude range (geodetic
  height at CA, km), magnitude limit, orbit-class chips, rate range, free-text
  name/NORAD search; a second chip row filters by SATCAT object type
  (payload / rocket body / debris / unknown — typeless objects sit in `unknown`).
  All write to `SAT.state.filters` and emit `'filters-changed'` — filtering never
  triggers a rescan.
- A **pick column** (checkboxes) sits before Name, outside the sortable/togglable
  column set: ticked rows narrow what the sky chart and all-sky view draw
  (`state.chartCrossings()`), while the table keeps listing everything so ticks
  can be undone. The header shows the tick count and clears all on click; ticks
  are runtime-only and reset on every new scan.
- Table columns (all sortable; a **Columns** button toggles visibility, persisted in
  `settings`): Name, NORAD, Int'l, Class, Enter (UTC), CA (UTC), Exit, Dur,
  Sep@CA, RA/Dec (J2000), Az, El, Range, Rate ″/s, PA, Mag, Method, Sunlit, TLE age.
  Rate/PA follow `obs.track` ('sky' ⇒ vs stars, 'mount' ⇒ vs horizon), the header
  names the frame, and the orbit-class chips/column stay — class is the fastest
  first cut a user makes on a candidate list.
  Numeric cells use `.num` (tabular monospace).
- Row click → select the object (`'selection-changed'`, chart highlights + centres if
  off-screen). Row double-click → `SAT.clock.setDate(tCaMs)`, i.e. jump the animation
  to that crossing. Row hover → chart highlights that path.
- **Copy / Export** buttons: copy the visible table as TSV, or download CSV / JSON of
  the filtered crossings (client-side Blob; no backend round-trip).
- Empty states are explicit: no site, no catalogue, not scanned yet, scanned and
  genuinely empty, and truncated — each with the action that fixes it.
- Expose: `SAT.ui.crossings = { init, refresh }`.

### SAT.ui.pointing.init(bodyEl, win) — AGENT I (js/pointing.js)

The input window — everything on the left of the problem statement. **Compact**:
one control row per line, label column narrow ("Start", "Span", "Mode", "RA", …),
no section headers taking their own line, no wrapped rows.

- Site: dropdown of `SAT.state.locations` (active one selected), with a link to open
  the Locations window.
- **Start**: bound to `SAT.clock` (a **Now** button syncs). The field is wide enough
  to show the FULL `YYYY-MM-DD HH:MM:SS` — a truncated timestamp was a round-1
  review complaint. **Span** with quick chips (1 m, 3 m, 5 m, 10 m, 1 h — the 6 h /
  24 h chips were dropped in round 3; a long span is still typable).
- **Mode**: toggle **RA/Dec** ⇄ **Alt/Az** plus the track toggle (Sky/Mount).
  Switching mode converts the current pointing through `SAT.frames` at the current
  time (so the two views agree), and sets `track` to the mode's default.
- Coordinates, four rows (RA, Dec, Az, El): each row carries BOTH a sexagesimal
  field and a decimal-degrees field, **both editable**, kept in sync — editing
  either updates state and rewrites the other. The active mode's pair is live; the
  other pair is derived and read-only. RA accepts `hh mm ss.s`, `hh:mm:ss` or
  decimal; Dec `±dd mm ss` etc. Reject out-of-range sexagesimal fields ("99 99 99"
  wraps into a plausible but wrong pointing — SAT.util.sexParts guards this).
- Presets: **Zenith**, **Sun**, **Moon**, **Anti-sun**, and "from selected object".
- FOV: shape toggle, width/height (or radius) with a °/′ unit toggle, rotation,
  E/W flip, and a **camera preset** dropdown (name, w, h) persisted in settings —
  laid out as a tight grid, not a tall stack. **No built-in presets** (round-2
  review): they were one person's guesses about other people's equipment; the
  dropdown holds only what the user saves.
- There is deliberately NO exposure length and NO plate scale (round-1 review):
  the scan timespan is the only time quantity, and the trail across the field is
  the identification tool.
- Every edit routes through `SAT.state.setObs(patch)`; nothing here starts a scan.
- Expose: `SAT.ui.pointing = { init, refresh }`.

### SAT.allsky.init(bodyEl, win) — (js/allsky.js)

Port of SatObserver's `skychart.js`, reduced to a **context view**: polar alt/az
all-sky chart of the active site. **All-Sky star background (round 12 — SatObserver
fallback, binding):** the star field is the bright catalogue `SAT.stardata` ONLY
(BSC5/HYG, V ≤ 4.6), drawn whole-hemisphere with SatObserver's radius/alpha law
(`rad = max(0.6, 2.7 − 0.45·mag)`, `alpha = max(0.25, 0.95 − 0.13·mag)`) —
`SAT.stars.cone` and the old `allsky.magLimit` are not used. With it come the
original's SN / CL / CN toggles and the two layers ported alongside:

- **Milky Way** isophotes (`vendor/mwdata.js`, `mw` toggle, default off) with
  SatObserver's rim-parity fill; the per-vertex J2000→horizontal conversion goes
  through a per-frame rotation matrix built from three `SAT.frames.raDecToAltAz`
  probes, so the glow shares the star layer's precession/nutation chain instead of
  re-deriving hour angles inline.
- **Sun & Moon** on a `sunMoon` toggle (default on): rayed sun disc; moon with its
  phase terminator, the mean-parallax elevation correction (−0.95°·cos el), bright
  limb toward the sun's chart position (valid below the horizon too — `project()`
  clamps elevation but keeps azimuth direction). Drawn only above the horizon, as
  in SatObserver.
- **Documented deviation from SatObserver:** NO twilight/daylight sky tint and no
  MW twilight fade — the background stays the fixed dark theme.

Also shows the horizon grid and — the point of it here — the **FOV footprint**
(the projected outline of the current field) plus the tracks of the objects in
`chartCrossings()`. Answers "where am I actually looking, and what else is up".
Secondary window, closed by default. Expose: `SAT.allsky = { init, requestRender }`.

### SAT.ui.sources.init / SAT.ui.locations.init / SAT.ui.satinfo.init

Ported from SatObserver. `sources` loses the family concept AND (round-1 review)
the CelesTrak **group** tab: a group subset invites "identify against Starlink
only", and a negative result from a subset means nothing. Round 13 brings
CelesTrak back as **single-object queries only** — no group fetch — which carry
no such trap: a CelesTrak tab with NORAD IDs (≤ 20; gp.php answers one CATNR per
request) / INTLDES–COSPAR (whole launch; a piece letter narrows it) / Name-contains
queries via `GET /api/celestrak/query`, merged additively under the `celestrak`
source tag (own ✕ clear button, own line in the freshness block, rehydrated via
`catalogRefs` like Space-Track and McCants). The same tab carries a **Fetch full
SATCAT** row: downloads `satcat.csv` into the `satcat_bulk` cache — the exact
table that feeds the rcs/type photometry enrichment and the info panel — with an
on-file status line (`/api/satcat/bulk?status=1`, a slim probe that must never
trigger the 7 MB download by itself). Query-value inputs are deliberately narrow
(130 px): the row has to fit type selector, value, and buttons in the default
window width.

The catalogue is thus built from **Space-Track** (Load full catalogue,
`replace:true`, plus one-off NORAD/name queries merged additively), **CelesTrak
object queries**, **McCants** (files merged additively), and **Paste** (each paste
merges additively; a clear button removes the pasted set). All loads go through
`SAT.state.addTles`. The
freshness display shows **epoch-age statistics per source** — count, newest, median,
oldest vs the sim clock, from `SAT.state.sourceStats()` — with the >3 d warning per
source, since a single merged "newest" line hides exactly the staleness that breaks
an identification. `satinfo` gains the photometry breakdown (which `method` produced
the magnitude, RCS, standard magnitude) and the SATCAT record.

## Backend — server.py (Python 3.13 stdlib ONLY)

`ThreadingHTTPServer` on `127.0.0.1:8476` (fall back +1.. if busy), same structure,
MIME table, `ApiError`, atomic-write and disk-cache conventions as SatObserver's
`server.py`. Port these hardening patterns verbatim — each of them fixes a bug that
was already paid for once:

- `_route()` resets per-request state (`_head_only`, `_body_cache`) at the top and
  **drains the request body before any error response**. One handler instance serves
  many keep-alive requests; a cached body replayed into the next request wiped
  `state.json` in SatObserver.
- `atomic_write()` creates the temp file with its final mode (never briefly
  world-readable), then `os.replace()`; a module-level `_IO_LOCK` serializes writes.
- Anchored regexes validate every path-ish parameter (`CACHE_KEY_RE`, `GROUP_ID_RE`);
  static files are served only after `target.is_relative_to(APP_DIR)`.
- Download caps (32 MB fetched / 128 MB unzipped) on every outbound fetch.
- Cache reads follow one shape: fresh → serve; stale + network error → serve with
  `"stale": true`; no cache + error → `ApiError(502, ...)`.

Ported endpoints, unchanged in behaviour:

- `GET /api/ping`, `GET /api/celestrak/groups`, `GET /api/celestrak/tle?group=`
- `POST /api/spacetrack/tle`, `GET /api/spacetrack/config`
- `POST /api/mccants/tle`, `POST /api/text/tle`
- `GET|DELETE /api/cache[/<key>]`, `GET|PUT /api/state`
- `GET /api/satcat?norad=N`
- `GET /api/celestrak/query?type=norad|intldes|name&value=…[&refresh=1]` (round 13,
  ported from SatObserver's `celestrak_query_urls` + `_celestrak_query`): gp.php
  single-object lookups — one CATNR request per NORAD id (≤ 20), INTDES takes the
  yyyy-nnn launch with piece letters as a post-filter on OBJECT_ID, NAME is a
  substring. Two SatIdentifier adaptations: the result is **enriched** via
  `enrich_best_effort` (its objects enter the scanning catalogue) and carries
  `cacheKey` (`celestrak_q_<sha1[:12]>`) so `catalogRefs` re-hydration works.

New or changed:

- `GET /api/catalog/full[?refresh=1]` — the object set the scan runs against.
  Space-Track `class/gp/decay_date/null-val/epoch/>now-30` — **Space-Track only**
  (round-1 review removed the CelesTrak fallback: the UI reports provenance per
  source, and a silently swapped dataset would scramble it). 401 with a message
  naming the fix when no credentials are saved. Returns a `TlePayload` **enriched**
  with `rcs`, `type` and `stdMag` per object by joining the two tables below, and
  carrying `cacheKey` so the frontend can re-hydrate the exact payload from
  `/api/cache/<key>` on reload. Cached as `catalog_full.json`, fresh < 6 h, stale
  fallback with `"stale":true`. Every other TLE endpoint (Space-Track queries,
  McCants, pasted text) applies the same enrichment best-effort and carries
  `cacheKey` where a cache exists — their objects enter the same scanning
  catalogue and need the same photometry joins.

### Catalog numbers past 100000 — do not regress this

The public catalogue passed NORAD 100000 in June 2026, so **every provider is fetched
as `FORMAT=json` (OMM), never `FORMAT=tle`/`3le`**. The authoritative NORAD id is the
integer `NORAD_CAT_ID` field; the TLE line pair is taken from the record when present
or synthesized by the server-side `omm_to_tle` writer, which encodes columns 3–7 as
Alpha-5 for 100000–339999 and writes the placeholder `'00000'` above that (checksums
recomputed). Propagation never reads `satnum`, so the placeholder is harmless — but
the payload's integer `norad` must always be the true id, because it is the join key
for SATCAT/qsmag and the thing the user types into a search box. Port `catnum()`,
`catnum5()` and `omm_to_tle()` from SatObserver's `server.py` verbatim.

This matters more here than in SatObserver: that app imports hand-picked objects,
whereas this one runs against the **whole** catalogue, where the high-numbered recent
launches and analyst objects are exactly the unidentified trails people are chasing.
- `GET /api/satcat/bulk[?refresh=1]` — the whole CelesTrak SATCAT
  (`https://celestrak.org/pub/satcat.csv`), parsed to `{norad: {intl, rcs, name,
  launch, owner, opStatus}}`. Cached 30 d as `satcat_bulk.json`. This is what
  supplies `rcs` for the photometry fallback. Round 13 adds `?status=1`: a slim
  `{present, count, fetched, stale}` probe for the Catalogue window's status line —
  alone it only PEEKS at the disk cache (never triggers the 7 MB download);
  combined with `refresh=1` it downloads first, which also warms the enrichment
  join every TLE endpoint uses.
- `GET /api/qsmag[?refresh=1]` — McCants standard magnitudes
  (`https://www.mmccants.org/programs/qsmag.zip`), extracted in memory and parsed to
  `{norad: stdMag}`. Cached 30 d as `qsmag.json`. Missing file ⇒ `{ok:true, mags:{}}`
  and the UI simply falls back to the RCS tier — never a hard failure.
- `GET /api/stars/deep` (round 15) — presence probe for the deep tile set:
  `{ok, present}` plus, when present, the `index.json` fields
  `{magLimit, count, tiles, builtIso, epochYr}`. Reads `DATA_DIR/stars17/`;
  never touches the network (the round-14 online `/api/stars/cone` endpoint is
  REMOVED — the backend does no star fetching at runtime at all).
- `GET /api/stars/tile/<name>` (round 15) — one deep tile as raw bytes
  (`application/octet-stream`, the STR1 binary). `<name>` must match
  `^t\d{1,2}_\d{1,2}\.bin$` (400 otherwise — the path is user-influenced and
  goes to the filesystem); 404 when the tile set or the tile is absent, which
  the frontend treats as "not built", not as an error to retry.
- `GET /api/state` payload carries `catalogRefs` (per-source cache keys) and
  `pasted` (inline pasted TLEs); cached catalogues themselves are never stored in
  `state.json`.

`TlePayload = {ok:true, source, fetched:"<iso>", count:N,
tles:[{name, l1, l2, norad, intl, rcs, stdMag}]}`.

Shared TLE parser identical to SatObserver's (3-line, 2-line, McCants `0 NAME`,
Alpha-5 catalog numbers, malformed pairs skipped). Fetch timeouts 30 s;
`User-Agent: SatOccult/0.2.0`. On startup print the URL and `webbrowser.open` it
unless `--no-browser`. `--port N`. NO third-party imports.

## House style (binding — agents match this, not their own habits)

**Python.** Module docstring, grouped stdlib imports, constants block with inline unit
comments, `# ---- banner ----` section dividers. `snake_case`, private handler methods
prefixed `_`. PEP 257 one-line docstrings for small helpers, multi-paragraph where
there is subtlety. **No type hints, no logging module, no third-party imports.**
Request logging is one hand-formatted `print(..., flush=True)` line.

**JavaScript.** Two dialects, split by module kind — follow the one that matches:
- *Core / UI modules* (`util, state, clock, propagate, frames, stars, photometry,
  scan, sources, locations, satinfo, pointing, crossings, main`): modern — `const`/
  `let`, arrow functions, `async/await`.
- *Canvas view modules* (`chart, allsky`): conservative ES5 flavour — `var`
  throughout, `function () {}` callbacks, module state hoisted to the top of the IIFE,
  and a boxed `/* ===== file — SAT.x : one-line purpose ===== */` header.

Both: 2-space indent, semicolons, single quotes, one IIFE per file with `'use strict'`,
exactly one `SAT.*` assignment at the bottom. Never `innerHTML` for dynamic content —
build DOM with `SAT.util.el(tag, attrs, children)`, which is the backbone of all UI
code here.

**Comments explain *why*, and name the consequence.** This is the most distinctive
trait of the codebase; a comment that restates the code is worse than none:

```js
// pass tracks are cut at 1° rather than 0°: below that, refraction and TLE
// error dominate and the AOS time is not meaningful to the second
```

**Canvas panels** follow one template: `injectStyle()` guarded by an element id and
prefixed per module (`chart-`, `ask-`); dirty-flag + rAF `requestRender()` that skips
work when the window is closed and swallows render errors after one `console.warn`;
`resize()` driven by both `'win-resize'` and a `ResizeObserver`; `ctx.setTransform(dpr,
0,0,dpr,0,0)` for HiDPI; a top-left toolbar of `.btn.small` chips at `opacity:.85`
(accent outline when active); `rgba(10,14,18,0.62)` HUD pills with
`font-variant-numeric: tabular-nums`; and every label stroked in `rgba(5,8,12,0.85)`
with `lineJoin:'round'` before filling, so text stays legible over the star field.

**Backend calls** go through one `api(path, opts)` wrapper that throws on
`{ok:false}`. Status text uses `✓` success, `✗` failure, `⟳` refresh, `…` in progress,
`⚠` confirm-danger. Destructive actions confirm by requiring a second click on a
re-labelled button within 5 s — no modal dialogs. Empty states use `.msg-empty` and
always name the action that fixes them.

## Packaging

Same as SatObserver: `desktop.py` opens a pywebview window on the local server, and
PyInstaller bundles it. macOS build is a one-liner; Windows is produced by a
`windows-latest` GitHub Actions runner (PyInstaller cannot cross-compile) which
commits the zip back into `release/` with `[skip ci]`.

```sh
.venv-build/bin/pyinstaller --noconfirm --clean --windowed \
  --name "SatOccult" --icon build_icon/SatOccult.icns \
  --add-data "app:app" --osx-bundle-identifier "local.satoccult" desktop.py
```

When frozen, static assets come from `sys._MEIPASS` and user data goes to
`~/Library/Application Support/SatIdentifier` (or `%APPDATA%`), never inside the
bundle — port the `IS_BUNDLED` / `DATA_DIR` block from SatObserver's `server.py`.
`data/` is gitignored (it holds Space-Track credentials); `release/` is committed.

## Look & feel

Identical dark technical theme to SatObserver — same CSS variables (`--bg #101418`,
`--fg #e8eaed`, `--accent #4fc3f7`, `--mono`), same `.btn / .input / .select / .table /
.win / .tag` classes, same menubar pattern (title, window toggles, clock + rate on the
right). `app.css` is ported wholesale; per-window styling is injected by each module
with a prefixed class (`chart-`, `xin-`, `pnt-`) exactly as `skychart.js` does.

**Targets are coloured by OBJECT TYPE** (round-5 review), one palette across the
sky chart, all-sky view and the table's Type chips — **user-editable** (round 6)
via swatches in the Crossings filter row, stored in `settings.typeColors` and
resolved everywhere through `SAT.state.typeColorOf(t)` so one override applies to
every view at once (invalid saved values fall back to defaults). Defaults:
`PAY #ffd54f` (deliberately warm — LEO payloads dominate any scan and must not read
as the blue/pale-green UI theme), `R/B #ff7043`, `DEB #f06292` (pink — the round-5
brown-grey read as darker yellow next to PAY at trail alpha), `UNK #90a4ae`.
Orbit-class colours survive only on the table's Class chips:
`leo #4fc3f7`, `meo #7ad97a`, `geo #ffb84f`, `heo #c792ea`.
Every trail carries one arrowhead ~60% along showing the pass motion direction —
a streak on a real frame has no arrow, so the chart must supply the disambiguation.

Default layout on first run: Sky Chart top-left (large), Crossings right (full
height), Pointing bottom-left, everything else closed.
