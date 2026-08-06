# P0-11 occultation pipeline and UI contract

**Scope:** `app/js/occultation/pipeline.js`, `plan-ui.js`, `events-ui.js`,
`chart-ui.js`, and their loading/window integration.

**Status:** implemented and verified on the current SatIdentifier working tree

## Purpose

P0-11 is the production-facing handoff for the deterministic occultation core:

```text
local date + site
  -> P0-02 NightWindow / P0-03-P0-04 SatellitePass
  -> P0-05 spherical star candidates
  -> P0-07 closest approach + P0-09 geometric contact
  -> independent SAT.state.occultation
  -> Plan / Events / Chart windows
```

The pipeline owns stage ordering, cancellation, progress, provenance, and one
optional final publication. It does not duplicate propagation or spherical
geometry. The three windows are visual clients of the pipeline/state contract;
they do not call SGP4 or mutate ordinary scan state.

## Pipeline API

```js
const result = await SAT.occultation.pipeline.run({
  site: { kind: 'ground', latDeg: -37.8, lonDeg: 145, altM: 30 },
  localDate: '2026-07-20',
  timeZone: 'Australia/Melbourne',
  sunAltitudeLimitDeg: -12,
  minimumElevationDeg: 20,
  pathToleranceArcsec: 1,
  starOptions: { magLimit: 6, corridorArcsec: 10 },
  eventOptions: { defaultRadiusM: 1, contactsOnly: true },
}, { publish: true });
```

The direct pass fields follow `PASSES_CONTRACT.md`. `passOptions` is merged
into that input, `starOptions` follows `OCCSTAR1_CONTRACT.md`, and
`eventOptions` follows `EVENT_STATE_CONTRACT.md` and `CONTACT_CONTRACT.md`.
`passOptions.classes` and `passOptions.types` are applied inside the raw scan
worker using the same classification fields as the ordinary SatIdentifier scan:
orbital class (`leo`, `meo`, `geo`, `heo`) and SATCAT object type (`PAY`, `R/B`,
`DEB`). The mixed seven-label `passOptions.tags` form is also accepted. Catalogue
source names are not a search filter.
`publish` defaults to true. Setting it false returns a detached state without
replacing `SAT.state.occultation`. `options.nowMs` (or `input.nowMs`) is
forwarded into the event-state options and is recorded in the resolved
configuration for deterministic callers.

The result is:

```js
{
  version: 'p0-11',
  status: 'ok' | 'empty' | 'no-night' | 'partial' |
          'failed' | 'cancelled',
  complete,
  config: { pass, stars, events },
  discovery, search, state, published,
  flags, error,
  startedAtMs, finishedAtMs,
  timings: { discoveryMs, searchMs, eventsMs, totalMs },
  stats: { discovery, search, events },
}
```

`ok` means a non-empty run completed without truncation or retained event
failures. `empty` is a complete search with no candidate events. `partial` is
also used when a truncation flag leaves no event records, so an empty result
does not conceal an incomplete search. `no-night` is
a complete local-date result for which `night.js` returned no observing window;
the star search is not called. `partial` retains available records but exposes
pass/search truncation or incomplete event assembly. `failed` and `cancelled`
never clear a previously published event state.

The published state preserves the P0-09 event schema and adds a detached
`state.pipeline` record containing the P0-11 version, status, resolved config,
flags, timings, and stage statistics. This is transient metadata and is not
included in `state.js` persistence.

## Cancellation and event bus

`SAT.occultation.pipeline.cancel()` marks the active run and delegates to
`SAT.scan.cancel()`. A cancellation during the raw worker scan is converted to
`status: 'cancelled'`; a cancellation observed between synchronous stages is
handled at the next stage boundary.

The pipeline emits only the `occultation-*` namespace:

- `occultation-started`
- `occultation-progress`
- `occultation-passes-ready`
- `occultation-candidates-ready`
- `occultation-events-ready`
- `occultation-done`, `occultation-failed`, or `occultation-cancelled`

Raw worker progress is subscribed through the separate
`occultation-scan-progress` channel. No ordinary `scan-started`, `scan-done`,
or `SAT.state.scan` mutation is introduced.

## UI contract

The main window manager registers three independent windows:

| Window | Responsibility |
|---|---|
| `occultation-plan` | ground site/date/options, SatIdentifier scan-tag filters, Run/Cancel, stage progress |
| `occultation-events` | scan-tag filters, Alt/Az and quantitative event table, sortable headers, CSV/JSON export; row selection focuses the main Sky Chart at `tCaMs` |
| `occultation-chart` | selected-event tangent-plane path, star, closest point, corridor |

Selecting a row also sends the existing `occultation-selection-changed` payload to
the main `SAT.chart`. The main chart keeps the saved Pointing state unchanged,
pauses the simulation clock at closest approach, and overlays the candidate star,
the satellite direction from `closestGeometry`, and a time-ordered adjacent
passing track centred on `tCaMs`. The track window scales with `durationMs`
using practical display bounds and is clipped to pass bounds; path/live-
propagation fallbacks keep incomplete records inspectable. The focus can be cleared from the chart
toolbar; it is also cleared when the user edits Pointing or starts a new event run.

By default the event table retains incomplete records and geometric misses. When
`eventOptions.contactsOnly` is true (the Plan UI enables this by default), the
exact solver still evaluates every candidate but the published event/candidate/
pass arrays retain only complete geometric contacts or grazes. Filtered misses
remain in the stage statistics, not in the event table. Row selection uses
`occultation-selection-changed` and is local/transient. The chart labels the
represented adaptive path and conservative corridor; its line is not an
alternative closest-approach solution.

The Events table applies its scan-tag filters after the search without changing
the published event state. UTC, satellite, orbit class, object type, star magnitude, Alt/Az,
separation, size, duration, and flags columns are sortable; numeric columns are
the quantitative result view. CSV export follows the active table filters.

The UI displays the fixed P0 warning:

```text
Candidates use a conservative TLE search corridor.
No calibrated occultation probability is available yet.
```

No probability, ranking, historical uncertainty, physical-shape claim,
instrument detectability, or ordinary-crossings replacement is added in P0-11.

## Verification

```sh
node --check app/js/occultation/pipeline.js
node --check app/js/occultation/plan-ui.js
node --check app/js/occultation/events-ui.js
node --check app/js/occultation/chart-ui.js
node tools/test_pipeline.js
python3 tools/run_tests.py
git diff --check
```
