# SatIdentifier — Development Log

Project: the inverse of [SatObserver-MX](../satobserver) — not *where is this
satellite* but *who is in my field of view* — built 2026-07-21 in
`/Users/mickey/sda/satidentifier`. Development followed the SatObserver pattern:
architecture and correctness-critical core written directly, a binding `CONTRACT.md`
frozen first, then seven large modules built by parallel sub-agents against it, each
shipping its own verification harness, then integrated and driven end-to-end in a live
browser.

---

## 1. Requirements (2026-07-21)

From the user, following a request to study SatObserver and build its inverse:

| # | Requirement | Status |
|---|---|---|
| R1 | Given site, time, timespan, pointing (RA/Dec or Alt/Az), FOV → which satellites are there | ✅ three-stage scan, full catalogue |
| R2 | Sky map / sky chart as the main view | ✅ gnomonic TAN chart on canvas, Tycho-2 star field |
| R3 | Satellite list as the other main part | ✅ 19-column sortable table, CSV/TSV/JSON export |
| R4 | Telescope fields (0.1–5°) and wide fields (5–40°) | ✅ both; grid and star density scale with the field |
| R5 | Timespan scan + crossing list | ✅ entry/CA/exit, bisected to 50 ms |
| R6 | Animation / time slider | ✅ master clock drives the chart without rescanning |
| R7 | Exposure simulator | ✅ streaks in degrees and pixels, drawn from the sampled path so curvature survives |
| R8 | Full catalogue + Space-Track | ✅ `/api/catalog/full`, SATCAT and qsmag joins |
| R9 | Follow SatObserver's practice and manners | ✅ same namespace, dialects, CSS, window manager, contract-first process |
| + | "more functions than you think needed" | two tracking frames, all-sky context view, five-tier photometry, TLE-age confidence, DUT1 |

Explicitly **de-scoped** by the user: reverse trail-matching (input an observed streak,
rank candidates). The exposure simulator covers the visual comparison; the `Crossing`
record already carries rate, PA and streak, so a matcher can be added later against the
same data.

---

## 2. Architecture

Same two-process shape as SatObserver: a stdlib-only Python backend that does *no*
astronomy, and a browser frontend that does all of it. No build step, no frontend
framework, no third-party Python packages at runtime. Namespace stays `SAT` so
SatObserver modules port unchanged.

```
server.py                  static files + JSON API (Python 3 stdlib only)
app/js/frames.js           NEW — the module SatObserver never needed
app/js/scan.js + worker/   NEW — the engine
app/js/chart.js            NEW — gnomonic sky chart
app/js/crossings.js        NEW — the list
app/js/pointing.js         NEW — the inputs
app/js/{util,windows,clock,locations}.js   ported ~unchanged
app/js/{sources,satinfo,allsky}.js         ported and reshaped
```

### How it was built

1. Studied SatObserver end to end — architecture, conventions, `CONTRACT.md` as a
   *process artifact*, and the DEVLOG's verification discipline.
2. Studied the reference implementations: `SatSkyMap`, and Bill Gray's `sat_code`
   for the identification algorithm.
3. **Measured before choosing.** Benchmarked satellite.js on the real catalogue
   before committing to an implementation language (§3).
4. Wrote `CONTRACT.md` — module APIs, event payloads, data shapes, the scan
   algorithm, the accuracy budget, house style — and froze it.
5. Built the correctness-critical core directly (`frames.js`, `propagate.js`,
   `state.js`) with verification harnesses.
6. Fanned out seven sub-agents against the contract, each required to ship a test
   harness and report measured numbers honestly.
7. Integrated, then drove the real app in a live browser against the real catalogue.

---

## 3. The WASM decision — measured, then declined

Bill Gray's `sat_code` was the obvious candidate for the scan engine: `sat_id` solves
almost exactly this problem. Investigating it produced two surprises.

**`sat_id` has no geometric pre-filter at all.** No bounding box, no spatial index, no
coarse-then-fine. It brute-forces the catalogue, and in field mode (`sat_id3.cpp`, the
CGI behind projectpluto's "what artsats are in this field") even its one physics
filter — a revs/day cut — is deliberately disabled. Its speed comes from evaluating
*one epoch per tracklet* and from hoisting `SGP4_init` outside the object loop.

That reframed the problem: per-epoch full-catalogue brute force is genuinely cheap;
**the cost is entirely in the number of time steps.** So the engineering had to go into
culling objects across the whole timespan, which `sat_id` never needs.

Then the benchmark (node 25, satellite.js 5.0, real CelesTrak `active`, 16 056 objects):

```
init:      16 056 satrecs in 106 ms       (6.6 us each, ONE TIME)
propagate: 321k propagations in 196 ms    (0.61 us each)
hot loop:  9.2 ms per coarse step over the whole catalogue
```

**0.61 µs per propagation — 40× faster than the 25 µs assumed when scoping.** A 1-hour
full-catalogue scan is ~0.3 s across six workers before any culling. A WASM port of
`sat_code` (assessed as a clean one: 4–6 self-contained files, no malloc/stdio, fully
re-entrant, caller-owned `params`) would buy perhaps 3× on a stage already costing
0.3 s, against an emscripten toolchain dependency, a build step, a committed binary,
and `-fno-strict-aliasing` care around `sgp4.cpp`'s int-punned-through-double
`simple_flag`. **Declined**, with the numbers and a revisit trigger recorded in
`CONTRACT.md` so it is not re-litigated on vibes.

What *was* taken from `sat_id` is worth more than the language: init once and propagate
many; **rotate the pointing into TEME rather than the catalogue into J2000** (one
vector per epoch instead of 27 000, and it removes precession from the hot loop);
dot-product culls with no `acos`/`atan2`; per-epoch caching of everything JD-keyed;
and his `# Max error` idea as a per-object tolerance scaled by TLE age.

---

## 4. Precession — the part most likely to be silently wrong

SatObserver only ever needed alt/az, so TEME-vs-J2000 never mattered. Here it is the
single largest potential error: **precession since J2000 is 0.36° in 2026, twenty
times a typical telescope field.**

Bill Gray has rewritten his own precession code twice, and the reasons are documented
in `lunar/precess.cpp`. Two were adopted directly:

1. **Only ever build the matrix J2000 → date, and transpose to invert.** The general
   "t1 → t2" cubic form is not self-inverse — precess forward then back and you do not
   land where you started, with error growing over the span. `frames.js` therefore
   exposes exactly one primitive and derives every other direction from its transpose,
   which turns a correctness worry into an assertion.
2. **Equatorial rather than ecliptic IAU-1976**, commented so nobody "fixes" it. The
   ecliptic form is more stable over millennia; near-term the equatorial form is
   preferred and the two differ by ~2 milliarcsec in 2026.

The sign of the equation-of-equinoxes step is not a matter of taste: TEME→PEF uses
GMST while TOD→PEF uses GAST, which forces `v_TOD = R3(−Eq_eq)·v_TEME`.

### Verification

Three tests, and the middle one is load-bearing:

- **Round trip**: `j2000ToTeme(temeToJ2000(v))` matches `v` to 4.7e-16 — really a test
  that rule 1 above was obeyed.
- **Cross-check against the well-trodden path**: alt/az computed via `frames.js`
  versus satellite.js's own `eciToEcf`→`ecfToLookAngles`, over **1102 above-horizon
  samples across LEO/HEO/GEO and four sites including one below sea level**. Worst
  disagreement **1.4e-5 arcsec**. This single test catches a sign error in the equation
  of the equinoxes, nutation or precession, a units slip, or a GMST/GAST mix-up — and
  needs no external data.
- **Absolute sanity**: general precession 5029.1″/century, obliquity at J2000, the
  nutation and equation-of-equinoxes envelopes, refraction at 30° and 10°.

**Three of my own expectations were wrong and the code was right**, which is the useful
kind of test failure: the vernal-equinox precession (I used 26 years instead of 26.55);
an arcsec-per-century vs arcsec-per-year slip; and the equation of the equinoxes, where
I had written "±1.1″" in the contract when the real figure is **±1.15 seconds of time,
i.e. ±17 arcsec**. The seconds-of-time/arcsec confusion is easy to make and this
document's own contract made it once.

**One real bug**: `altAzToRaDec` had two sign errors, returning azimuth 56.6° where
123.4° was correct. Caught by the round-trip assertion.

### The accuracy budget is honest about what dominates

Frames are good to well under an arcsecond, and that is *not* the limiting error: TLE
position error is 7′–2° at LEO range, and ignoring UT1−UTC costs up to 2.9′. Both are
tabulated in `CONTRACT.md` and the README, DUT1 is an exposed setting, and TLE age is
shown per row. The claim made in the UI is "arcsecond-level frames, arcminute-level
truth, limited by TLE age" — never "arcsecond accuracy".

---

## 5. The scan algorithm

Three stages, in order (full prose in `CONTRACT.md`):

1. **Static geometric cull, no SGP4 at all.** Horizon reachability, declination
   reachability, and an orbit-plane test using inclination *and* RAAN with the
   tolerance widened by nodal regression over the timespan.
2. **Coarse time sweep in TEME**, pointing rotated once per epoch, adaptive margin
   from each step's own range and speed plus a per-object TLE-age slop.
3. **Fine refinement**: entry/exit bisected to 50 ms, closest approach by parabolic
   fit, photometry and up to 64 path samples.

The sub-agent improved on the specification in a way worth recording: the contract
called for sampling the sightline at ~24 log-spaced ranges, and the agent replaced that
with **exact closed-form minimisation of the quadratics**, on the grounds that a
sampled sweep can straddle a narrow admissible band and silently drop a real object —
the one failure mode a cull must not have. It is also O(1) instead of O(24). The cull
additionally **fails open**: any object with non-finite derived geometry is kept.

### Soundness, tested two independent ways

The agent compared the exact crossing sets with the cull on and off:

| Geometry | cull OFF | cull ON | lost |
|---|---|---|---|
| 30° circle, 1 h | 1475 | 1475 | 0 |
| 4×3° rect rot 25°, 6 h | 688 | 688 | 0 |
| 2° circle at the pole, 1 h | 53 | 53 | 0 |
| 5° circle, mount-tracked | 130 | 130 | 0 |

And at integration I brute-forced a 2 294-object subset at 10 s steps with no culling
whatsoever, in the live browser: **48 hits, 0 missed by the scan.** Every reported
crossing was independently recomputed through `propagate.js` (which shares no code with
the worker): none fell outside the field, separations agreed to 0.0004°, positions to
1.9″.

**Honest caveat on the cull rate**: the contract's "10–40% survival" holds for realistic
telescope fields (60–76% culled), but **not** for very wide ones — at a 30° radius
`sin(fovRadius)` swamps the orbit-plane tolerance and only ~10–14% is removed. That is
correct behaviour (a 30° field genuinely is reachable by most of the catalogue), not a
bug, and the UI does not promise a big cull number.

### Measured (single-threaded, node, 16 056 objects)

| Scan | Wall | Propagations | Stage 1 cull |
|---|---|---|---|
| 1 h @ 30 s, 30° circle | 1.56 s | 1.67 M | 14.2% |
| 6 h @ 30 s, 4×3° rect | 4.34 s | 7.02 M | 39.3% |
| 1 h @ 30 s, 2° at pole | 0.28 s | 0.46 M | **76.3%** |
| 1 h @ 30 s, 5° mount | 0.41 s | 0.59 M | 69.7% |

In the browser across the worker pool: a 90-minute scan of a 4°×3° field ran in
**1.4 s**, culling 16 056 → 3 262 → 40 crossings.

---

## 6. Two rates, not one — found by a test that was expected to pass trivially

The propagate harness asserted that a geostationary object's apparent rate should be
~0″/s. It came back **14.99″/s** — almost exactly the sidereal rate.

The code was right and the expectation was wrong. A geostationary satellite co-rotates
with the Earth, so against the **stars** it drifts at ~15″/s — which is precisely why
GEO objects show up as dashes in sidereally-guided images. Against the **horizon** it
is a fixed dot.

That is not a rounding difference; it is 15″/s, or **7.5′ of streak over a 30 s
exposure that either exists or does not** — the difference between "that is my trail"
and "that is not". So the tool now computes both:

- `rateAsPerS` / `paDeg` — `d(RA,Dec)/dt`, for sidereal guiding
- `rateMountAsPerS` / `paMountDeg` — `d(alt,az)/dt`, for a parked mount

`obs.track` already distinguished the two tracking modes; nothing had been consuming
it. Both rates are verified against finite-differenced sky *and* alt/az positions
(0.03% worst error over 179 samples spanning LEO/GEO/HEO).

The chart agent then took this further than asked, and correctly: in mount mode the
tangent point **and its orientation** are functions of time, so it restructured around
a `frameAt(tMs)` in which sidereal tracking is simply the constant case. Star trailing,
a stationary GEO, and the parallactic rotation of a parked field then fall out of one
code path instead of being special-cased.

---

## 7. Data findings that changed the design

**satellite.js field names.** The vendored build calls the mean motion `no`, not
`no_kozai`. Reading the wrong one yields `undefined`, and `undefined > 5` is silently
`false` — every object would have classified as MEO and the Stage 1 cull would have
computed NaN altitudes without erroring. Separately,
`twoline2satrec('1 garbage','2 garbage')` returns **`error: 0`** with NaN elements, so
checking `.error` is not enough; bad objects would have entered the scan and silently
matched nothing. Both are now validated numerically.

**RCS has a cliff, and it is not a join bug.** CelesTrak publishes no RCS above
NORAD 50000 (measured: 41–97% below 40000, 25.6% for 40000–49999, **0.0% above
50000**). Of the 16 078 objects in `active`, only **879** carry one — two-thirds of
that catalogue is Starlink, and no Starlink has a published RCS. Meanwhile
`mmccants.org/programs/qsmag.zip` currently returns **HTTP 404**. Together those would
have made every magnitude an identical 1 m-sphere guess.

`OBJECT_TYPE` is 100% populated at every NORAD band, so the photometry gained two
tiers — `model` for documented constellation brightness, `type` for a size class from
the object type — giving R/B 6.4, PAY 7.9, DEB 12.1, Starlink 7.0 at 1000 km and 90°
phase. The tier is reported per row, and everything below `rcs` is labelled a prior
rather than a measurement.

**But the `type` tier barely discriminates on the CelesTrak fallback path.** Over
`GROUP=active` the histogram is PAY 16 076 / R/B 2 — essentially constant, so it
upgrades the guess from "generic 1 m sphere" to "payload-sized prior" and no further.
Its real value arrives on the Space-Track `latest_all` path, where DEB is **51%** of
the catalogue (35 832 / 69 947) and R/B another 10%. Since debris and spent stages are
exactly what an unidentified trail usually turns out to be, the tier matters most
precisely where it has not yet been exercised on live data.

**The qsmag parser.** The suggested "take the last float-looking field" fallback would
have been **wrong**: `qs.mag` is fixed-width and the radar cross-section sits to the
*right* of the magnitude, so ~2200 lines carrying an RCS but no magnitude would have
been assigned one (Landsat 8 would have become stdMag 7.4). The agent pulled the real
file from a Wayback mirror and wrote a column-correct parser instead. The empty result
is deliberately not cached, so the file is picked up if it returns.

---

## 8. Star catalogue

`starcat.js` stops at V = 4.6, which in a 1° field is **zero stars**. So
`tools/make_starcat.py` builds `stars_m9.bin` from Tycho-2 via VizieR: 130 183 stars to
V = 9.0, 1.30 MB, structure-of-arrays and declination-sorted so the frontend maps typed
arrays straight over the buffer and answers a cone query by binary search (5° cone:
497 stars in 0.12 ms; 0.5° cone: 10 stars in 0.017 ms).

The builder's `sanity_check()` — six named bright stars — caught three real bugs in
succession, and is the reason the asset is trustworthy:

1. Tycho-2's main catalogue is **missing Sirius, Vega, Arcturus, Betelgeuse and
   Acrux** — its reduction saturates on the brightest stars. Fixed by also fetching
   supplement 1.
2. Cross-matching at 20″ silently failed, because `starcat.js` positions are rounded to
   0.01° (20–36″). Fixed at 90″ — and the merge now takes only BSC5's *magnitude*,
   keeping Tycho's positions, since adopting BSC5 positions would have traded
   milliarcsecond astrometry for a photometric fix.
3. Arcturus appears **twice**, 0.2″ apart, with V = −0.1 and a saturated V = 3.47 —
   main and supplement overlap. 539 such duplicates deduped, keeping the brighter.

---

## 9. Integration and live verification

Driven in Chrome against the real 16 056-object catalogue:

- All 17 modules present, deep catalogue loaded (130 183 stars), 16 056 satrecs built
  in 295 ms with **0 unparseable TLEs**, max NORAD 69 998 (6-digit ids handled).
- Zenith over Greenwich, 15° radius, 1 h: **329 crossings in 2.4 s**, 16 056 → 6 226
  after Stage 1 → 959 candidates → 329.
- Paranal at −13° twilight, 4°×3°, 90 min: **40 crossings, 24 sunlit**, Starlinks at
  mag 5.3 (model tier at 550 km range — arithmetically exactly where it should be).
- Paranal at local midnight, zenith: 27 crossings, **all in umbra** — correct, since
  objects overhead at midnight are in the Earth's shadow.

**One UX gap found only by using it.** Orion from Paranal in July returns zero
crossings — correctly, because it sits at El −47 — but the app said "widen the FOV or
lengthen the timespan", advice that cannot possibly help. The empty state now detects a
pointing that stays below the horizon for the whole span and says so, with the peak
elevation and the time it occurs.

**Also fixed at integration:** `state.setCatalog` was dropping the new `type` field
(written before the tier existed); `refractionInvDeg`'s fixed-point iteration converged
to only ~0.1″ near the horizon against a contract comment claiming better, now
iterated to convergence (5e-11″ everywhere); and `parseRA` accepted `"99 99 99"`, which
wraps modulo 360 into a perfectly plausible 04h 42m — a typo silently becoming a valid
pointing hours from the intended one.

---

## 10. Known limitations

- ~~Space-Track untested~~ **Closed during review round 2**: the user saved
  credentials and force-refreshed — `latest_all` returned **32 092 objects** from the
  live service (PAY 18 889 / DEB 10 317 / R/B 2 198 / UNK 47 / no-type 641), which
  then survived reload via the rehydration path. First scan against it: 32 092 → 5 107
  after geometry (84% culled) → 81 crossings in 2.4 s — **36 of the 81 were debris**,
  the population the CelesTrak fallback never carried and the reason the full
  catalogue is the default.
- **The catalogue used in testing was CelesTrak `active`** (16 056 objects, 99.99%
  payloads). Debris and rocket bodies — often exactly what an unidentified trail turns
  out to be — need Space-Track. The `type` photometry tier is built for them but has
  only been exercised on synthetic inputs.
- **qsmag is unavailable upstream**, so the best photometry tier contributes nothing
  today.
- **No reverse trail-matcher** (de-scoped). The `Crossing` record already carries what
  one would need.
- ~~Not packaged~~ **Closed**: macOS .app built (pywebview + PyInstaller, 31 MB /
  16.9 MB zipped, `release/SatIdentifier-macOS-arm64.zip`) and verified end to end —
  launched, backend serving with the bundled deep star catalogue, user data in
  `~/Library/Application Support/SatIdentifier/`, clean quit. Icon: star field +
  accent FOV box + yellow trail with motion arrow (`build_icon/make_icon.py`).
  Windows CI workflow ported from SatObserver-MX (untested on real hardware, as
  there).
- The worker duplicates a handful of `frames.js` functions, since workers cannot see
  the main-thread `SAT`. `frames.js` is the reference implementation and the block is
  marked, but the two could drift.

## 11. A process note on parallel agents

Two verification hazards showed up, both worth remembering for the next build of this
shape:

- **`data/cache/` is shared mutable state.** Concurrent agents each ran a server from
  the same directory on the same port. One agent's re-verification returned a payload
  that made no sense — `type` present on every object but no `withType` count — because
  its request hit the fresh-cache branch and was served *another agent's* payload
  verbatim. The agent correctly diagnosed it, re-ran with a private `DATA_DIR`, and
  said so rather than reporting the confusing number as a result. A cache entry written
  by a test is also served as "fresh" for hours afterwards; both agents had to clean up
  fixtures they had written.
- **Upstream rate limits are a shared resource too.** CelesTrak began hard-403ing
  `gp.php` under the combined load of several agents plus the benchmark. That is also
  why the browser integration ran against a seeded cache of the genuinely-fetched
  16 056 objects rather than a live pull — every layer below the fetch was the real
  code path, but the fetch itself was not exercised at that moment.

Neither invalidates a result, because in both cases the agent noticed and said so. The
transferable lesson is that "it returned a number" is not verification when the number
could have come from a neighbour's cache.

## 12. User-review iterations

### Round 1 (2026-07-21)

From the user, after driving the built app:

| # | Feedback | Change |
|---|---|---|
| 1a | Pointing rows too tall / wrapping; "Epoch start" → "Start" with the FULL timestamp; "Pointing mode" → "Mode" | One control row per line, section headers replaced by hairlines, `Start` field sized 19ch so `YYYY-MM-DD HH:MM:SS` never truncates |
| 1b | Decimal degrees should be editable too, kept in sync with hms/dms | Each coordinate row now has BOTH a sexagesimal and a decimal field, both editable, both committing the same obs value; refresh() repaints both from state — sync by single source of truth, not field-to-field copying |
| 1c | FOV + camera arranged nicely | Tight grid: shape/W×H/unit toggle on one row, rot/flip on the next, camera preset row under it |
| 1d | Exposure length confusing (only the scan timespan matters); drop plate scale and streak-in-pixels; drop the chart streaks toggle | `exposureS`/`plateScaleAsPerPx` removed from obs, `SAT.photo.streak()` deleted, streak columns out of the table and exports, streak layer + toggle out of the chart. The trail across the FOV (path + entry/exit + rate + duration) is the identification tool |
| 2 | Catalogue: drop the CelesTrak tab; full catalogue = Space-Track; McCants and pasted TLEs merge in; epoch-age statistics per source | Multi-source catalogue: `addTles(tag, payload, {replace})` with NORAD dedup, newest epoch wins; `/api/catalog/full` is Space-Track-only (401 names the fix; stale cache still served); per-source count/newest/median/oldest vs the sim clock, stale warning keyed on the **median**; pasted TLEs persist inline in state.json, cached sources re-hydrate via `cacheKey` |
| 3 | Keep the leo/meo/geo/heo classification | Untouched — chips and Class column stay |

Verified live after the round: full catalogue + a pasted TLE merge to 16 057 objects
with correct per-source statistics; the merged set **survives a reload** (Space-Track
re-hydrated from the disk cache, the paste from state.json); a 1 h scan over the new
set runs in 0.2 s and the table carries no streak columns; the per-source line shows
the true payload provenance (`celestrak:active` during testing — see below), not just
the loading button's label, so a stale cache cannot silently misstate where elements
came from.

**Casualties and recoveries.** Three of the four rework agents were killed mid-flight
by a session usage limit. Assessing what had actually landed — rather than assuming
"failed = nothing happened" — showed the crossings and pointing rewrites were already
complete and passing, and only sources.js plus three test harnesses needed finishing
by hand. The dead agents' claimed state matched the files in two cases and not the
third; the file system, not the exit status, was the ground truth worth trusting.

### Round 2 (2026-07-21)

| # | Feedback | Change |
|---|---|---|
| 1 | Remove built-in camera presets | Dropdown holds only user-saved presets; empty state says how to add one |
| 2 | Remove the refraction checkbox — always apply it | `obs.refraction` deleted; every conversion refracts; `frames.js` keeps `{refract}` for tests reaching the geometric path; Alt/Az elevations labelled "apparent" |
| 3 | 3 m / 5 m span chips | Added |
| 4 | Filter order sunlit → **altitude** → mag → class; new altitude filter | `c.altKm` (geodetic height at closest approach) computed at merge; null = "could not compute" is kept, never hidden |
| 5 | Checkbox column to show only ticked sats on the chart | Pick column outside the sortable/exported set; `state.chartCrossings()` = filtered ∩ ticked; the **table still lists everything** so ticks can be undone — that asymmetry is the design |
| 6 | Object-type filter (payload / rocket body / debris / unknown) | Second chip row; typeless objects sit in `unknown` so they never vanish silently |
| 7 | All-sky gains SatObserver's SN / CL / CN toggles | Star names, constellation lines and names from `SAT.stardata`, same drawing as the original skychart |
| 8 | No magnitude in sky-chart labels | Removed from marker labels |
| 9 | Review the star catalogue | See below |

Round 2 was verified live against that real catalogue from the user's site
(Xinglong, 40.4°N): altitude filter 0–2000 km keeps 76/81; switching the payload
chip off keeps 42/81; ticking two rows narrows the chart to 2 drawn objects while
the table still lists all 81 — the asymmetry that makes ticks undoable.

### The star-catalogue review (round 2 §9)

The Tycho-2 build's one **measured** defect is epoch, not depth: its positions are
J2000 mean places, and 26 years of ignored proper motion puts **169 stars more than
13″ off** at the 2026 epoch — the worst (61 Cyg class) by **~227″, nearly 4′**,
visibly wrong on a 1° chart. Depth (V ≤ 9) is adequate for orientation but thin for
matching a real frame, where a 30 s exposure reaches V 14+.

Chosen upgrade: **Gaia DR3, G ≤ 11 fetched, V ≤ 10.5 written, proper motions
propagated to epoch 2026.5**, G→V via the Riello+ 2021 colour relation, keeping the
BSC5 bright-star merge (Gaia's astrometry is poor or absent for the brightest ~200
stars — the same bright hole Tycho-2 had, patched the same way). `stars.js` tries
`stars_deep.bin` → `stars_m9.bin` → bright catalogue, so the committed Tycho file
remains the working fallback.

**Built and verified**: 549 037 stars, 5.49 MB (the VizieR pull was 46.4 MB and took
an hour). The sanity probes caught one real bug on the first build: Gaia DR3
genuinely lacks its very brightest stars, so the bright-star merge painted Vega's
magnitude onto a V≈9 field star 90″ away while Vega itself stayed missing. Fixed
with a plausibility guard (a match must be within 3 mag of the star it claims to
be, else the star is added whole); all six probes then pass, and the Tycho build
is byte-identical under the same guard. Live checks: a 0.5° Orion cone deepened
from 10 stars to 44, and 61 Cygni's two components (V 5.2/6.0) sit at the
PM-corrected 2026.5 position with nothing left at the stale J2000 place. Alternatives considered: full-depth Tycho-2 (V ≤ 11.5)
— no PM fix and poor faint photometry; Gaia G ≤ 12 (~3 M stars, ~30 MB) — matching
a frame is better served by the user's own plate solution at that depth.

### Round 3 (2026-07-21)

A debugging note worth keeping: mid-round, every live probe of the new track code
reported "0 tracks built" while the code was provably correct — the tab was
BACKGROUND while being driven remotely, and Chrome suspends requestAnimationFrame
for hidden tabs, so no render had ever run. Verification of anything rAF-driven
needs the tab visible (a screenshot focuses it). An hour of stale-cache theories
died to one `document.visibilityState` check.

| # | Feedback | Change |
|---|---|---|
| 1 | Trail-matcher: stand down | Stays de-scoped; the `Crossing` record keeps carrying what one would need |
| 2 | Sky chart: show each crossing object's WHOLE pass track over the timespan, out-of-FOV parts at low alpha, so a two-second crossing does not mean a two-second label | Extended track per crossing: sampled over the full scan window while above the horizon (adaptive step, ≤400 pts), computed once per scan and cached on the crossing, built ≤30 tracks/frame so the post-scan cost is spread; drawn at alpha 0.16 under everything; the current-position marker + label fall back to it at reduced alpha once the object leaves the field. Unit-tested (7 checks: caching, horizon gaps never interpolated across, rebuild on new scan) and verified live: a 2 s STARLINK crossing keeps its marker a minute after exit |
| 3 | Remove the 6 h / 24 h span chips | Gone; 1 h is the longest chip, longer spans still typable |
| 2b | Sky chart: after dragging the view, double-click should set a new RA/Dec | Double-click now re-aims — the clicked sky position becomes the pointing, centred in the window (pan zeroed). Shift-click still re-aims without moving the view; fit-to-window lives solely on the ⤢ toolbar button. In alt/az mode the az/el pair is carried along so a parked mount re-aims too. Verified live: a double-click 120 px up-left of centre moved the pointing 1.08° north-east (the correct direction on an east-left chart) and the Pointing panel followed |

### Round 4 (2026-07-21)

| # | Feedback | Change |
|---|---|---|
| 1 | Type column before Class, coloured chips like the orbit classes | New default column with its own palette (pay teal / r/b orange / deb brown / unk grey), distinct from the class hues so "leo · debris" reads as two colours. Saved column sets from earlier sessions get a **versioned migration** (`settings.columnsVer`) — defaults only apply on first run, so without it the new column would have stayed invisible forever; the version stamp, not the column's absence, gates the splice, so unticking it later sticks |
| 2 | Drop the "type" label before the filter chips; chips coloured like the class ones | Done — filled chips when on, struck-through when off |
| 3 | Alt / mag / rate filters moved to the back, each in a box frame | A second filter line of three bordered groups, so a min–max pair reads as one control rather than four orphans |
| 4 | Sky-chart faint stars too small — size should follow brightness | Radius/alpha curve retuned: the old one clamped everything fainter than m7 to a 0.6 px dot at alpha 0.25, making the deep catalogue's m9–10.5 stars invisible; new floors 0.9 px / alpha 0.5 with gentler slopes keep the faint end visible and the brightness ordering legible |

### Round 5 (2026-07-21)

| # | Feedback | Change |
|---|---|---|
| 1 | Colour targets by object type, not orbit class | Chart trails/markers, extended tracks and all-sky markers now use the type palette; class colours survive only on the table's Class chips |
| 2 | Payload must not be blue/pale green (dominant population vs UI theme) | PAY is warm yellow `#ffd54f`; R/B `#ff7043`, DEB `#a1887f`, UNK `#90a4ae`. The FOV outline's accent blue now stands alone on the chart |
| 3 | Show pass motion direction on the sky chart | One arrowhead per trail, ~60% along, searching forward for an on-screen segment long enough (≥6 px) to define a direction |

### Round 6 (2026-07-21)

| # | Feedback | Change |
|---|---|---|
| 1 | Debris colour too close to payload | Default DEB moved brown-grey → pink `#f06292`: at trail alpha the brown read as a darker yellow beside the dominant PAY |
| 2 | Let the user choose the object-type colours | Four swatches + reset in the Crossings filter row, persisted as `settings.typeColors`; every consumer (chart trails/markers, all-sky, table cells and chips) resolves through the one authority `SAT.state.typeColorOf`, so an override repaints everything at once. Verified live: an override was seen by the resolver, survived the debounced save to disk, and reset restored the defaults |

### Round 7 (2026-07-21)

| # | Feedback | Change |
|---|---|---|
| 1 | Camera preset dropdown too verbose; Camera line should be as short as the coordinate rows | Dropdown capped to the coordinate-field width with terse placeholders ("— presets —" / "— none saved —"); name field shrunk to match |
| 2 | Sexagesimal/decimal inputs leave dead space after the coordinates | Widths are now ch-based, sized to the longest legal value ("23 59 59.9" = 11ch, "194.8326" = 9ch) instead of fixed pixels |
| 3 | Altitude km column before Range km, at closest approach | New default column reading the same `c.altKm` the altitude filter tests (one number, two consumers, no drift); saved column sets migrate via `columnsVer` 2, preserving user customisations — verified against a column set the user had already edited |

macOS app rebuilt and re-verified after the round (launch, port-fallback to 8477
beside the dev server, new table served from the bundle, clean quit);
`release/SatIdentifier-macOS-arm64.zip` refreshed, and the CI-built
`SatIdentifier-windows-x64.zip` pulled in from origin.

### Round 8 (2026-07-26) — orbital observing stations (v0.2)

The site can now be a satellite: space-based SSA, "who crosses *my sensor's*
field". Contract-first as always — CONTRACT.md gained the binding section
"Orbital observing stations (v0.2)" before any code moved.

| # | Feedback | Change |
|---|---|---|
| 1 | Sites get two type selection | `kind: 'ground' \| 'orbit'` on locations (a missing kind IS ground — pre-v0.2 saves need no migration). Sites window grew a Ground/Orbit toggle on the add form; orbit rows show a NORAD box plus the LIVE catalogue resolution |
| 2 | Input orbital station by NORAD ID from the catalogue | The site stores ONLY the NORAD; the TLE is resolved out of the loaded catalogue at use time (`state.resolvedSite`), so it can never go stale against the catalogue it identifies with. Picker searches by number or name, eight suggestions, no 32k-option datalist |

Engine: the observer was already one provider away — `obsStateAt(t) → {r,v}`
is now the ONE place kind matters (ground = GMST rotation + ω×r; orbit = one
SGP4 call, throwing loudly rather than scanning from (0,0,0)). Physics gates:
horizon → hard-Earth limb occlusion (inside `insideField`, so bisection
resolves a target rising from behind the Earth); refraction never in orbit;
mount rate against Ω_LVLH = (r×v)/|r|²; Az/El mean LVLH angles (az from
along-track toward the orbit normal, el toward zenith); the observer excludes
itself by NORAD on both cull paths. Stage 1 keeps both quadratic culls with
observer samples every ~2° of arc (cap 600) and repays the capped remainder as
a per-object chord/rPeri pad; the latitude cull is ground-only. Orbit scans
clamp coarseStepS ≤ 10 s (chord-rescue curvature ~ Δt²), mirrored in the
estimate.

Proofs (`tools/test_scan.js` section [o], run on the live CelesTrak snapshot):
cull on/off identity from an LVLH zenith stare (56 = 56, stage 1 still culls);
independent recompute of every reported position through raw satellite.js
agrees to 0.013″; the same GEO pointing flips 92 crossings → 0 while the Earth
is in the way; the observer never identifies itself. LVLH basis: orthonormal
to 1e-12, named axes land where inspection says (tools/test_frames.js [4]).

Two pre-existing engine bugs surfaced by running the identity proof on a
STALE catalogue (both also failed on the unmodified baseline — bisected by
stashing the worker):

- **Stage 1 plane tolerance ignored TLE age.** `nodeo` is Ω at *epoch*; the
  tolerance only charged nodal regression across the scan span, so a 5-day-old
  LEO element set (node already ~25° away) could lose a boundary object. Now
  charges `spanDays + ageDays` per object.
- **tCa rounding skew.** RA/Dec was solved at the unrounded tCa but reported
  with integer-ms `tCaMs` — up to ~2″ of self-disagreement on a fast pass.
  Round first, then solve: independent recompute went 1.78″ → 0.078″.

Also: the GEO "mount rate ~0" check now selects i ≤ 0.5° birds — an old GEO
drifted to i = 13° genuinely moves at ~3.4″/s against the horizon (physics,
not regression; 52 uninclined birds still verify < 0.24″/s). Live check from
ISS (ZARYA) over the real 32k catalogue: 61 steps @ 10 s, stage 1 culled 54%,
4.6 s wall, 10 crossings at the zenith — closest a FENGYUN 1C fragment at
455 km crossing at 1.8°/s. All-Sky (a horizon projection) now says so on an
orbit site instead of rendering nonsense.

Build trap for future rounds: PyInstaller's `--clean` did NOT invalidate a
`build/` tree left by an earlier round — the first rebuild froze the OLD
`server.py` (bundle pinged `0.1.0` after the bump). `rm -rf build dist` before
a release build; verify with `/api/ping` on the bundled instance, which is the
check that caught it.

### Round 10 (2026-08-04) — "only Space can pause; the mouse does nothing"

Could not reproduce in Chrome despite exhaustive probing: real clicks (fast and
slow via a zero-distance drag), both toggle targets (the Clock window button
and the menu-bar indicator), elementFromPoint sweeps over the whole panel (no
transparent overlay), the user's own saved layout from the packaged app's
Application Support (nothing overlaps the button; the menu bar is z-5000 and
windows live below it in #desktop). The packaged WKWebView app could not be
driven directly (no Screen Recording / Accessibility TCC grants for the shell).

What the investigation DID establish: a `click` only lands if mousedown and
mouseup resolve to the same element, so any mid-press disturbance — a window
re-applying stored geometry (windows.js applies geo to every window on every
`resize` event), DOM churn under the cursor, a focus dance — makes the browser
dissolve it silently. One of this session's own probe clicks died exactly that
way. Space never suffers: the global keydown does no hit-testing.

Fix, immune to the whole class rather than chasing the one disturber we cannot
observe inside WKWebView: clock controls now act on POINTERDOWN (`pressAct`
helper — press fires the action; the click that follows within 800 ms is
swallowed; a bare click with no preceding press, i.e. keyboard activation of a
focused control, still works). Applied to Pause/Run, Real time, the rate and
step chips, and the menu-bar indicator. Also stopped updateUI's 60 Hz
unconditional textContent writes (now write-on-change) — wasted work, and
needless churn under the cursor at the worst possible moment.

Verified in Chrome: press pauses, Space resumes, menu-bar press pauses, the
follow-on click is deduplicated (no double-toggle).

### Round 11 (2026-08-04) — chart star background falls back to SatObserver

User verdict on the deep-catalogue background (after two rounds of curve
tuning): fall back to the SatObserver-MX logic outright. So the sky chart's
star layer is now the bright catalogue (`SAT.stardata`, V ≤ 4.6) with
SatObserver's radius/alpha law verbatim, and the chart gained the rest of that
chart's background kit: a Milky Way isophote layer (`vendor/mwdata.js`, MW
toggle, off by default), Sun/Moon on their own ☉ toggle (rayed sun disc, moon
drawn with its phase terminator, bright limb facing the sun), and a CN
constellation-names toggle. The m-limit button is gone — there is nothing to
limit at mag 4.6. One documented deviation, per the user: NO twilight/daylight
sky tint (and hence no MW twilight fade) — this chart is a J2000 field view,
not a local-sky view, so the background stays dark.

The deep Tycho-2/Gaia catalogue is NOT deleted: the All-Sky panel still cones
into it, `stars.js` and its asset ship unchanged, and the chart still uses the
bright-catalogue `named()`/`constellationLines()` helpers. A new harness check
pins the fallback: the chart render must make **zero** `SAT.stars.cone` calls.

Porting notes, the two things that actually needed thought:

- **Gnomonic Milky Way.** The polar chart projects the whole sphere into a
  disc; a TAN projection diverges at 90° and has no image of the far
  hemisphere at all. Every contour vertex is therefore clamped radially to an
  off-screen rim (direction from centre preserved, long chords subdivided
  along the great circle), which keeps fills finite and exact inside the
  viewport. The fill-parity trap is the same as SatObserver's and so is the
  fix: any ring whose projected outline swallows the north galactic pole — a
  point outside every isophote — gets a rim-circle subpath to flip even-odd
  parity back.
- **Moon bright limb without a projectable sun.** The sun can be over the
  tangent-plane horizon while the moon is in the field, so the limb direction
  comes from a waypoint 1° along the moon→sun great circle, which is always
  projectable next to an on-screen moon.

Verified live in Chrome (dev :8500): Cygnus 60°×45° shows the star cloud with
the Great Rift; the same field at the north galactic pole is glow-free (parity
correct); the waning-gibbous moon (~79% lit at the check epoch) renders with
the bright limb toward the sun; ☉ off removes both icons and the footer's
"moon N° away" note; toolbar reads ☉ ✶ MW SN CL CN # Ab E⇄ ⤢.

### Round 12 (2026-08-04) — the fallback was meant for the All-Sky panel

Round 11 was a misread: "sky chart" in the instruction meant the **All-Sky
panel**. Corrected in both directions —

- **Sky chart:** the deep multi-level star background is back (SAT.stars.cone,
  m-limit button cycling 4.5/6/7.5/9/11, the round-9 flux-law curve, the
  "bright stars only" footer warning when the deep asset is absent). The
  round-11 additions the user wants kept stay: the Milky Way layer, the ☉
  sun/moon toggle with the phase moon, and the CN constellation-names toggle.
- **All-Sky panel:** now the SatObserver fallback. Star field is the bright
  catalogue (SAT.stardata, V ≤ 4.6) drawn whole-hemisphere — SAT.stars.cone
  and the old allsky.magLimit are gone, and no cache with them (the ~500
  conversions per render ride frames.js's time-keyed memos; sub-ms). Gained
  the MW layer and the ☉ toggle with SatObserver's icons (rayed sun, phase
  moon with the mean-parallax correction). Still no twilight/daylight tint.

One deliberate difference from SatObserver in the All-Sky MW port: instead of
inline hour-angle math off gmst, the per-vertex J2000→horizontal conversion
goes through a rotation matrix built once per render from three
SAT.frames.raDecToAltAz probes — the glow shares the star layer's
precession/nutation chain, and the harness's "no inline conversion helper"
rule keeps holding.

Harness coverage moved with the code: test_chart re-asserts the deep cone
(400-star stub, arc > 100); test_ports gained [5e] — allsky never calls
SAT.stars.cone (comment-stripped source check), bright dots actually land on
the dome, MW off draws nothing / on fills one path per isophote level, the
rayed sun appears at noon, and star drawing has no daylight gating.

### Round 13 (2026-08-04) — CelesTrak object queries + full SATCAT

Requested from the SatObserver TLE Sources panel: CelesTrak queries by NORAD,
COSPAR and name-contains, plus the full-SATCAT download, with a narrower
query-value box. Ported with the round-1 rationale intact: the CelesTrak
**group** fetch stays gone (a subset makes a negative identification
meaningless) — the new tab is single-OBJECT queries only, which carry no such
trap.

- Backend: `/api/celestrak/query?type=norad|intldes|name&value=…` ported from
  SatObserver (`celestrak_query_urls` — one CATNR request per NORAD id ≤ 20,
  INTDES takes the yyyy-nnn launch with piece letters as a post-filter, NAME
  substring) with two SatIdentifier adaptations: results are ENRICHED via
  `enrich_best_effort` (they enter the scanning catalogue and need the same
  rcs/type/stdMag joins as everything else) and carry `cacheKey` so reload
  re-hydration works. `/api/satcat/bulk?status=1` added as a slim
  `{present, count, fetched, stale}` probe — the status line must never pay
  for (or trigger) the 7 MB download; with `refresh=1` it downloads first,
  which also warms the enrichment join.
- Frontend: new `celestrak` source tag end to end (SRC_TAGS, catalog.sources,
  catalogRefs serialisation + re-hydration, per-source freshness line, cache
  tag inference, ✕ clear). Query-value inputs shrunk to 130 px — the
  Space-Track one included (was 220 px) — so selector + value + buttons fit
  the default window width.

Verified live against real CelesTrak: `25544, 48274` → 2 objects enriched
(ISS type PAY rcs 399), `98067A` piece-filters the 1998-067 launch to ISS
alone, `TIANHE` finds CSS, the merged header reads "Space-Track + CelesTrak"
with a fresh ✓ CelesTrak line beside the stale Space-Track set, and a page
reload re-hydrates the query set from `celestrak_q_*` via catalogRefs.
test_ports [3] updated: tab list, object-query-only source check, SATCAT row,
and the 130 px width pinned.

### Round 14 (2026-08-06) — adaptive star depth, m17 online for narrow fields

Requested: go deeper — V = 17 — when the field is under 3°, without drowning
wider fields in stars. V 17 over the whole sky is ~50M+ objects, two orders of
magnitude past anything bundleable, so the depth had to split by field size:

- **Auto depth law** (`SAT.chart.autoMagLimit(D)`, D = enclosing-circle
  diameter of the view, pure + unit-tested): D < 3° → **17.0**; D ≥ 3° →
  `clamp(10.5 − 5·log10(D/3), 4.5, 10.5)` — 10.5 at 3°, 9 at 6°, 7.5 at 12°,
  6 at 24°, floor 4.5 from ~48°. Default on (`settings.chart.magAuto`; old
  saved states migrate to it by omission). The m-limit button now cycles
  auto → 4.5/6/7.5/9/11 → auto; the footer always states the effective limit.
- **Online deep field**: `GET /api/stars/cone?ra&dec&r&mag` — Gaia DR3 cone
  via VizieR asu-tsv (the make_starcat.py interface), G→V by the same
  Riello+ 2021 relation, proper motions to the *current* decimal year, sorted
  by G with a 60 000-row guard, brightest 20 000 kept (the chart's own draw
  cap). r ≤ 3° / mag ≤ 18 enforced — wide fields must never reach the
  network. Cached forever (star fields don't go stale), family pruned to the
  24 newest files. Frontend `SAT.stars.deepField()`: single slot, fetch
  centre snapped to a 0.05° grid and radius rounded UP to a bucket so pans
  and wheel-zoom ticks re-hit both caches instead of refetching per tick;
  while loading (or offline/failed, 30 s backoff) the chart draws the local
  catalogue and the footer says which state it is in. `localLimit()` (new)
  reads the binary header so the chart knows when the local file cannot serve
  the wanted depth.
- **Deep-limit display compression**: the round-9 flux-law curve was tuned
  for limits ≤ 11; at m17 everything past m11 would sit on the 0.7 px floor.
  For deeper limits the faint tail maps m 9..mlim onto the display 9..11 ramp
  (`mdisp = 9 + 2(m−9)/(mlim−9)`) — bright stars render identically at every
  depth, and the m17 field still grades down to its limit.

Verified live: Pleiades at 1.5° × 1.0° draws 15 743 Gaia stars with
"m17.0 auto · Gaia online" in the footer (3 816 in the 1°-radius probe cone,
brightest Alcyone V 2.93, worst separation 0.9999° of r = 1.0); the same
pointing at 8° × 6° reads "m7.0 auto" from the local catalogue with no
network fetch; a VizieR cone of the Scutum cloud (6 465 stars to V 17)
exercises the dense-plane path; cache hit serves in 18 ms; r = 5 / mag = 20 /
non-numeric params all answer 400. test_stars [8b] pins the deepField
quantisation, slot containment, v100 decode and failure backoff; test_chart
[12] pins the law anchors and the loading→ready swap without a local
re-cone. One verification dead-end worth recording: with the Chrome window
occluded, macOS suspends rAF, so a queued render never fires and the footer
reads stale — twenty minutes were spent hunting an onReady "bug" that was
the window manager's throttling, not the code's.

### Round 15 (2026-08-06) — local m17 tiles + Stellarium's star rendering

Two corrections to round 14, both requested. First: **no online fetch** — the
VizieR round-trip (6–16 s per cone, and an observatory machine may be offline)
is replaced by a local tiled star database. Second: **the faint-star rendering
was bad** — the round-14 compression squeezed m 12–17 onto the 0.7 px / 0.42
alpha floors, so a deep field read as uniform pepper. The fix is Stellarium's.

- **Local deep tile set** (`data/stars17/`, gitignored, ~45M stars — round-14's
  own cone measurements put V ≤ 17 at ~900–1200 stars/deg², so the whole sky
  fits in a few hundred MB; my earlier ~150M guess was G < 17 without the V
  conversion): 4° dec bands × twelve 30° RA columns, single polar caps at
  |dec| ≥ 86, each tile the same STR1 binary as the bundled asset. Built once
  by `make_starcat.py --deep17` — VizieR box queries per tile with recursive
  RA splitting when a galactic-plane tile trips the 64 MB guard, a retry per
  request, resumable (existing tiles skipped), the BSC5 bright-star merge
  applied per tile (Gaia genuinely lacks Vega and Sirius — a 2° field
  containing Vega must still show Vega), and `index.json` written only at
  completion so a half-built set reads as absent. Served by
  `GET /api/stars/deep` (presence probe) and `GET /api/stars/tile/<name>`
  (strict name regex — the path reaches the filesystem). The round-14
  `/api/stars/cone` endpoint and its VizieR client are REMOVED.
- **stars.js**: `deepField()` reimplemented over the tiles with the same
  signature the chart already used — tile LRU (16 in memory), `tilesForCone()`
  pure and unit-tested (RA wrap, polar caps), per-tile cones through the same
  `coneInto` kernel `cone()` uses (one implementation, both catalogues), 404 ⇒
  parked 'error' until the next page load. `parseStr1` factored out so tiles
  and the bundled asset share one validated parser.
- **Star rendering — Stellarium's law** (read from
  `StelSkyDrawer::computeRCMag`): flux-law radius, and **below a 1 px floor
  the dot stops shrinking and FADES — luminance × rr³ (Stellarium's cubic
  sub-floor falloff), culled below 0.02** (its 0.3-radius cutoff analogue);
  bright radii past 6.5 px sqrt-compressed (its MAX_LINEAR_RADIUS device);
  deep limits get an exposure shift (its FOV factor): at an m17 limit an m17
  star renders as m11 did at m11, so the field grades smoothly to invisibility
  at whatever the limit is. `SAT.chart.starDot(mag, mlim)` is pure and pinned
  by test_chart [13]; it keys on the DRAWN depth (`drawnMag`), not the wanted
  one, so a deep request served by the shallow bundled catalogue renders
  honestly. The old hard floors (0.7 px, alpha 0.42) are gone.

test_stars [8b] rewritten for the tile set (scheme coverage incl. RA wrap +
polar caps, probe/load/ready flow, in-tile mag filter, 404 parking);
test_chart [13] pins the dot law's anchors (round-9 parity above the floor,
cubic fade below it, exposure-shift equality m17@17 == m11@11, cutoff, bright
compression, monotonicity).

### Round 16 (2026-08-06) — the deep tiles go to m13, not m17

The m17 build was too heavy — the user stopped it mid-download. Measured on
the 1609 deg² (57 tiles) it had fetched before being stopped:

| depth  | whole sky | tile set |
|--------|-----------|----------|
| V ≤ 11 | ~1M stars | ~10 MB   |
| V ≤ 13 | ~6M       | ~60 MB   |
| V ≤ 15 | ~32M      | ~320 MB  |
| V ≤ 17 | ~137M     | ~1.4 GB  |

(The round-15 "~45M / few hundred MB" estimate extrapolated two mid-density
cones; the southern galactic-plane bands the build actually walked run
3–10× denser.) The user chose **m13** — a 1° field still holds ~120 stars
(~150/deg²), at 1/20th of m17's weight.

- Depth is now data-driven end to end: `deepField()` reports the tile set's
  `magLimit` from the index, and the chart's dot law keys its exposure shift
  on the DELIVERED depth (`drawnMag = min(wanted, delivered)`), so a tile set
  built at any `--vmax` renders honestly with no code change. The auto law's
  deep branch asks for 13.
- Renames, since "17" was in the names: `--deep17` → `--deep-tiles`,
  `data/stars17/` → `data/deepstars/`, `DEEP_MAG_LIMIT = 13.0`.
- The 57 already-fetched m17 tiles were NOT refetched: they contain m13 as a
  subset, so a one-off filter cut them to V ≤ 13 (240 525 stars kept) and the
  resumable builder picked up from there — zero wasted download.
- No net change to the round-15 architecture or the Stellarium dot law; the
  harness anchors moved to 13 where they pinned 17.

Mid-build incident worth its lesson: CDS VizieR degraded ~30× on big box
scans partway through the day (every query died on their ~2-minute execution
cap and returned a truncated, nearly-empty result **with HTTP 200**), and the
builder silently wrote five husk tiles before it was caught. Hardening: each
tile response is now validated against a minimum plausible density (~1
row/deg² — even the galactic poles hold ~25 stars/deg² at V ≤ 13), a sparse
response is retried against the host list and then aborts the build resumably
rather than writing junk. The CfA mirror turned out not to serve the gaiadr3
table at all (instant empty result, so it stays in the list only as a cheap
second opinion). Tiny probe queries recover long before full-size scans do —
a service-health check must use the workload's own shape.

### Round 17 (2026-08-06) — honest manual steps, deep tiles gated to narrow

- The m-limit cycle is now auto → 4.5/6/7.5/9/**10.5**/**13** → auto: every
  manual step exactly deliverable (10.5 = the bundled catalogue's full depth,
  13 = the deep tiles'). The legacy **m11** step — an aspiration from the m9
  Tycho days that the bundled file could only serve at 10.5 — is gone; a
  saved m11 falls back to auto on the next press. This closes the
  user-spotted discrepancy between the m11 toggle and the "m10.5 local"
  footer.
- **Deep tiles are gated to fields narrower than 3°** — the auto law's own
  boundary — regardless of the pinned limit. A pinned m13 on a wide view
  draws the bundled catalogue with a `wide field — m10.5 local` footer note;
  without the gate a 40° pan would have churned dozens of tiles through the
  16-tile LRU. test_chart [12] pins both sides of the gate.

### Round 18 (2026-08-06) — the tile builder moves to the ESA Gaia Archive

VizieR never recovered within the day (its interactive endpoint is simply the
wrong tool for a bulk job — see round 16), so on the user's decision the tile
builder now sources from the **ESA Gaia Archive TAP** (`gea.esac.esa.int`),
the authoritative bulk service: one asynchronous ADQL job per 20° declination
slab (five tile bands, boundary-aligned), served from a server-side magnitude
index with no execution cap, one CSV download per slab, tiles cut locally.
Nine slabs replace ~520 interactive queries; a slab whose tiles all exist is
skipped, so the build stays resumable and the salvaged southern tiles cost
nothing.

Guards carried forward and new ones, each from a real incident:
- **Silent row-cap truncation**: anonymous TAP truncates CSV output at its row
  cap with NO overflow marker in this format — a slab at ≥ 2.5M rows is
  assumed cut and splits into sub-slabs (band-aligned).
- **Sparse response** (< 1 row/deg², the round-16 VizieR husk lesson): abort
  resumably, never write a husk tile.
- **Poll errors are not job errors**: ESA's front end drops TLS connections in
  bursts (measured: four straight `SSL: UNEXPECTED_EOF` failures in 40 s while
  the job ran happily server-side — it killed the first two launches; the
  user's local proxy on 127.0.0.1 is the likely chokepoint). The phase poll
  now tolerates minutes of solid failure before giving a job up, and the
  result download retries independently.
- **The UWS create redirect is not guaranteed**: ESA occasionally answers the
  submit with 200 at the base URL instead of the 303 to the job record —
  every poll of `<base>/phase` then 404s (it cost slab 9 of the first full
  run). The submit now falls back to extracting `<uws:jobId>` from the
  response body.

No frontend or backend changes: the tile format, scheme, endpoints and chart
behaviour are exactly round 17's; only the acquisition method changed.

### Round 19 (2026-08-06) — HUD slimming, both sky views

At user request, while the round-18 tile build ran:

- **Sky chart**: the third text line (site name, crossing count,
  selected-object rate, ⚠ stale-scan warning, moon separation, star-depth
  state) is gone — the warning and the rates live in the Crossings window,
  the depth behaviour in the mA button tooltip. FOV prints with ONE decimal
  (`1.5° × 1.0°`), the zoom factor (`1.00×`) is dropped, and the tracking
  mode reads `sidereal on` / `sidereal off` instead of
  "sidereal: satellites streak" / "parked: stars trail".
- **All-Sky**: FOV to one decimal too, and its footer line (site,
  `sky view (E left)`, `N of M crossing objects above the horizon`,
  `tracks capped at 500` / `tracks off`) is removed — with the deliberate
  loss of the track-cap truncation note, accepted as part of the request.

### Round 20 (2026-08-06) — tracks toggle, MW off the chart, NORAD in labels

Three sky-chart requests in one round:

- **Satellite tracks toggle** (`settings.chart.tracks`, default on): a ↗
  button directly after the label toggle Ab, mirroring the All-Sky's. Off
  hides BOTH trail layers (the dim whole-timespan track and the bright
  in-FOV path with its motion arrow) and leaves markers + labels only — the
  clean view for holding label positions against a frame. The extended
  tracks are still *built* with the toggle off, because the off-field marker
  position follows them; only the strokes are skipped. Verified live on a
  390-crossing GEO-belt scan: trails to zero, every marker and label stayed.
- **Milky Way removed from the chart** — the toggle *and* the layer (the
  gnomonic isophote port, ~120 lines). It was off by default, invisible in
  any telescope-sized field, and removing only the button would have locked
  whatever value was saved. The glow lives on in the All-Sky panel, whose
  own port is untouched; `vendor/mwdata.js` stays for it. A saved
  `settings.chart.mw` is ignored.
- **Labels read `NAME [NORAD]`** via the new pure export
  `SAT.chart.satLabel(cr)` (test_chart [14]). The bracket always prints the
  full decimal catalogue number: every ingest path (Space-Track OMM,
  CelesTrak, McCants, paste) runs through server-side `catnum`, which
  decodes Alpha-5 at parse time — 'A0000' arrives as the integer 100000 —
  so the letter form can never reach a label. Confirmed live on
  analyst-range objects: `TBA - TO BE ASSIGNED [270375]`.

### Round 21 (2026-08-08) — CelesTrak full catalogue; SATCAT button was metadata

User report: the CelesTrak tab's "Fetch full SATCAT" button "downloads the
file but does not load". **Verified, and it was working as built**: the button
hits `/api/satcat/bulk`, which returns the `satcat.csv` *metadata* table
(RCS / type / owner / launch — the photometry-enrichment join) and carries no
elements at all, so `addTles` is never called and the catalogue count never
moves. The label was the bug: "Fetch full SATCAT" reads as a catalogue loader.

- **New endpoint `GET /api/celestrak/full`** — a real no-account full
  catalogue. gp.php offers no full-catalogue query (probed GROUP=all/
  catalog/full: "Invalid query"; the master-gp-index is a per-CATNR search
  page), so the endpoint walks the bulk files: `catalog.csv` first (modern
  OMM field names, full integer NORAD_CAT_ID, parsed by the new
  `parse_omm_csv` through the same `omm_to_tle` path as the JSON endpoints),
  then legacy `catalog.txt` via `parse_tles` — the one documented exception
  to the FORMAT=json rule, since no OMM full-catalogue product exists. A
  catalog.txt payload carries a `notes[]` caveat: by CelesTrak's stated
  policy the TLE format never includes the 6-digit objects catalogued after
  2026-07-11. Cached 6 h as `celestrak_full` (rehydrates via `catalogRefs`;
  the Cache tab tags it `celestrak` by prefix). `enrich_full_catalog` is the
  factored SATCAT/qsmag join + coverage counters now shared with
  `/api/catalog/full`.
- **Sources window**: top billing is now TWO buttons, **Load full catalogue
  (CelesTrak)** above **Load full catalogue (Space-Track)** (the order the
  user asked for), each with its own ⟳, status line and source note;
  selected-object queries stay in the tabs. Each replaces only its own tag.
  `acceptPayload` now surfaces payload `notes[]` on the status line. The
  SATCAT button is relabelled **Fetch SATCAT metadata** with a
  metadata-only hint — same behaviour, honest name.
- **CelesTrak politeness, learned the hard way**: during verification this
  network's IP was already temp-blocked for `/pub/TLE/catalog.txt`
  ("excessive downloads … restored once ceased for 2 hours" — NOT caused by
  SatIdentifier or SatObserver; neither ever fetched that path). To urllib
  the block manifests as an SSL EOF mid-read, not a 403 page. The 6 h
  `CATALOG_FRESH_S` cache is therefore load-bearing politeness, and the
  502 message names the cooldown when a 403 does come through. The happy
  path could not be exercised live against CelesTrak while blocked; it is
  pinned by fixtures instead (below), and the UI error path was verified
  live in the browser (clean ✗ status line, button re-enabled).
- **New harness `tools/test_server.py`** (24 checks, no network — http_get
  stubbed, cache in a tempdir): OMM-CSV parse incl. Alpha-5 synthesis and
  checksum recompute, csv→txt fallback ladder, the legacy-file caveat note,
  stale-cache serving, the no-cache ApiError with the cooldown text, and
  catnum/catnum5 round trips at 100000/339999. test_ports [3] updated to
  pin the two-provider layout, the button order, the source notes, and the
  metadata relabel (76 checks).

## 13. Running the checks

```sh
node tools/test_frames.js       # coordinate frames — the cross-check
node tools/test_propagate.js    # topocentric solution, both angular rates
node tools/test_stars.js        # star catalogue + photometry tiers
node tools/test_scan.js         # scan engine, incl. Stage 1 soundness
node tools/test_chart.js        # projection and orientation
node tools/test_crossings.js    # table, sorting, filters, export
node tools/test_pointing.js     # parsing, mode-switch round trips
node tools/test_ports.js        # sources / satinfo / allsky
python3 tools/test_server.py    # backend catalogue fetching (network stubbed)
```

All green as of 2026-07-21.
