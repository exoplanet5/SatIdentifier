# SatOccult

**SatOccult** is an independently maintained derivative project based on
[SatIdentifier](https://github.com/exoplanet5/SatIdentifier), originally created
by Zhuoxiao. It is not an official release of, affiliated with, or endorsed by
the upstream project.

SatOccult focuses on planning and searching satellite occultations: identifying
when a satellite passes in front of a catalogue star, refining closest approach
and contact times, and preparing an observing plan.

Module APIs are in [CONTRACT.md](CONTRACT.md); how it was built and what was
measured is in [DEVLOG.md](DEVLOG.md).

## Upstream, license, and modifications

This repository is a fork and modified distribution of
[SatIdentifier](https://github.com/exoplanet5/SatIdentifier). Original upstream
code remains attributed to Zhuoxiao, and the upstream MIT copyright and license
notice are retained in [LICENSE](LICENSE). The MIT license permits modification
and redistribution as long as the copyright and license notices are preserved.

SatOccult adds and changes satellite-occultation planning and event-search
features, together with related native-window and headless workflows, tests,
and documentation. These changes are maintained separately from upstream
SatIdentifier and are not part of the upstream project's official release.
See [NOTICE.md](NOTICE.md) for attribution and third-party notices.

The repository and project are called **SatOccult**. Some application labels,
source filenames, and release artifacts still use **SatIdentifier** for
compatibility with the upstream codebase.

For normal satellite finding and identification, refer to the upstream
[SatIdentifier README](https://github.com/exoplanet5/SatIdentifier). It covers
the original catalogue, crossings scan, sky chart, orbit/SSA mode, calculated
quantities, accuracy notes, and general usage.

## Running SatOccult

For ordinary SatIdentifier requirements, packaged builds, and normal launch
instructions, refer to the upstream [SatIdentifier README](https://github.com/exoplanet5/SatIdentifier).

To run the SatOccult occultation workflow from source in browser mode:

```sh
python3 server.py
```

For the native-window workflow, install `pywebview` and run:

```sh
python3 desktop.py
```

The native occultation search uses Node.js outside the WebView and streams
progress back to the Plan window. The browser-independent command is documented
under the satellite-occultation workflow below.

## Workflow

### Normal satellite-finding workflow

For the original satellite-finding and crossing-identification workflow, refer
to the upstream [SatIdentifier README](https://github.com/exoplanet5/SatIdentifier).

### Satellite-occultation workflow

The occultation workflow is separate from the ordinary *Crossings* scan:

1. Load the catalogue in **Catalogue** and make a ground site active in **Sites**.
2. Open **Occultation Plan**, choose the local date and IANA time zone, then set
   the twilight altitude, minimum satellite elevation, the SatIdentifier scan tags
   (`leo`, `meo`, `geo`, `heo`, `payload`, `rocket body`, `debris`), star magnitude
   limit, search corridor, effective satellite radius, and **Contacts only**. The
   classification filters are applied during pass scanning
   and remain available for a second filter in the Events table. The last
   option is enabled by default and keeps only complete geometric contacts or
   grazes in the published event table; misses are still counted in the run
   statistics.
3. Press **Run occultation search**. In the native app, the original Plan
   window remains the interface while the full calculation runs in a separate
   Node process. Results appear in **Occultation Events**; click an event row to
   pause at closest approach and focus the main **Sky Chart**, where the target
   star, satellite, and the adjacent time-ordered passing track are marked. The
   displayed track grows with the event duration and is clipped to the pass
   bounds. The event table includes closest-approach Alt/Az and sortable
   quantitative columns such as separation, size, duration, and geometry.
   **Occultation Chart** remains available for the detailed tangent-plane path
   view.
4. **Contacts only** is enabled by default. The native run removes the
   interactive 5,000-candidate cap, processes crossings one at a time, and
   reports both the raw candidate count and the exact candidates evaluated.
   Misses are counted but are not copied into the event table. The browser-only
   Pass/Candidate limit fields do not cap the native complete run.

#### Browser-independent complete search

For a full-catalogue run, use the headless process so the calculation is not
held inside a browser tab:

```sh
node tools/run_occultation_headless.js \
  --date 2026-08-06 \
  --timezone Australia/Melbourne \
  --lat -37.7966 --lon 144.9633 --alt 50
```

Add `--tags leo,payload` or use `--classes leo,meo,geo,heo` and/or
`--types PAY,R/B,DEB` to apply the same SatIdentifier scan-tag filters in the
headless search.

It uses the same P0-11 SGP4 and contact solver, streams each crossing through a
bounded 512-point path, removes the interactive 5,000-candidate cap, and writes
JSON/CSV results under `data/occultation-results/`. The original pywebview Plan
window is the UI; Node performs the calculation outside WebKit and sends back
stage progress. A small Tk controller is also available with
`python3 occultation_gui.py`.

## Repository layout

```
server.py                  Python 3 stdlib-only backend: static files + JSON API
desktop.py                 pywebview shell for a native window
SatIdentifier.command      double-click launcher (dev mode)
app/
  index.html               loads CSS + scripts in a fixed order
  css/app.css              the whole design system, dark theme
  assets/stars_deep.bin    Gaia DR3 to V=10.5, 549 037 stars, 5.5 MB (preferred)
  assets/stars_m9.bin      Tycho-2 to V=9.0, 130 183 stars, 1.3 MB (fallback)
  js/frames.js             coordinate frames, precession/nutation, refraction, TAN
  js/propagate.js          SGP4 wrapper and the topocentric solution
  js/scan.js               worker pool, merge, budgeting
  js/worker/scan-worker.js the three-stage scan engine
  js/stars.js              deep star catalogue, cone queries
  js/photometry.js         five-tier magnitude model, Earth shadow
  js/chart.js              gnomonic sky chart (main view)
  js/crossings.js          crossings table (main list)
  js/pointing.js           the input window
  js/allsky.js             all-sky context view with the FOV footprint
  js/state.js  util.js  clock.js  windows.js  sources.js  locations.js  satinfo.js
tools/
  make_starcat.py          builds the star catalogue asset; --deep17 builds the
                           local V=17 tile set into data/stars17/ (gitignored)
  test_*.js                verification harnesses — see DEVLOG
docs/                      occultation contracts, decisions, and progress logs
data/                      state, caches, credentials, deep star tiles (gitignored)
```

## Credits

Propagation: [satellite.js](https://github.com/shashwatak/satellite-js) (SGP4/SDP4).
Stars: Gaia DR3 (Gaia Collaboration 2022) and Tycho-2 (Hog+ 2000) via VizieR, plus
BSC5/HYG bright-star photometry by way of
[d3-celestial](https://github.com/ofrohn/d3-celestial). Catalogue data: CelesTrak,
Space-Track, Mike McCants. The scan's structure — hoisting SGP4 init out of the time
loop, rotating the pointing rather than the catalogue, and gating expensive work
behind a cheap scalar test — is taken from Bill Gray's
[sat_code](https://github.com/Bill-Gray/sat_code); the precession handling follows the
reasoning in his `lunar/precess.cpp`. Problem framing owes a debt to
[SatSkyMap](https://github.com/lnicastro/SatSkyMap).
