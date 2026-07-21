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
```

All green as of 2026-07-21.
