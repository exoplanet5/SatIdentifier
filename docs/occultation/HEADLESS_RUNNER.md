# Headless complete search

`tools/run_occultation_headless.js` runs the existing P0-11 scientific modules
without a browser window or DOM. It loads a TLE catalogue and the same `STR1`
star catalogue used by the application, then runs the pass, candidate,
closest-approach, and angular-disc contact stages in a separate Node process.
The scan worker streams one confirmed crossing into the stages below it; the
path and candidate graph for that crossing are released before the next one.

The headless configuration intentionally differs from the interactive safety
profile:

- worker paths use a bounded 512-point representation per pass, with a
  conservative 30-arcsec raw-path query buffer;
- crossings are processed one at a time, so the full catalogue is not retained
  as one JavaScript object graph;
- expensive adaptive pass-path refinement is deferred because the exact event
  stage evaluates the satellite trajectory directly for every star candidate;
- per-pass and aggregate candidate limits are effectively unbounded;
- detailed query/source audit graphs are not retained;
- `Contacts only` is enabled by default. A 120-arcsec trajectory-distance
  screen removes obvious cone over-queries before P0-07/P0-09; the raw
  candidate total and the screened count are both reported, while miss records
  are counted but not copied into the output event table.

These choices keep duplicate audit data out of the result and avoid the native
WebView memory boundary. The report may retain provenance flags such as
`pass-refinement-deferred`, `path-precision-unverified`, and
`candidate-geometric-screening`; these are not the interactive 5,000-candidate
truncation. `candidateLimit` is `null`, and the final status is complete unless
the scan, star queries, or event solver reports a real failure or truncation.
The process is still CPU-intensive for a full catalogue. Use the generated
JSON/CSV as the durable result.

## Command line

From the repository root:

```sh
node tools/run_occultation_headless.js \
  --date 2026-08-06 \
  --timezone Australia/Melbourne \
  --lat -37.7966 --lon 144.9633 --alt 50
```

Use `--tags leo,payload`, or `--classes leo,meo,geo,heo` and/or
`--types PAY,R/B,DEB`, to filter the raw scan by SatIdentifier classification
tags. Event CSV output includes `orbitClass`, `type`, and closest-approach
`azDeg`/`elDeg`.

Defaults read the active site from `data/state.json`, the TLE catalogue from
`data/cache/catalog_full.json`, and the deepest available star binary from
`app/assets/`. Use `--catalogue`, `--stars`, and `--output` to override them.
Progress is emitted as JSON lines, and the final report is written as
`data/occultation-results/occultation-YYYY-MM-DD.json` plus a CSV with the same
base name.

## Tk GUI

```sh
python3 occultation_gui.py
```

The GUI is only a controller. It starts the Node process in the background,
shows stage progress, supports termination, and never loads the large event
graph into a browser/WebKit tab.
