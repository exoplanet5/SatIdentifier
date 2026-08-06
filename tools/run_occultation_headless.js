#!/usr/bin/env node
/* Run a complete P0-11 occultation search without a browser window.
 *
 * The calculation process reuses the production JavaScript scientific modules,
 * but replaces Web Workers, browser state, and DOM publication with a direct
 * Node adapter. Full mode disables the interactive 5,000-candidate safety cap;
 * contacts-only output still discards misses before the result file is written.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const runtime = require('./headless_occultation_runtime.js');
const chunkedPipeline = require('./headless_chunked_pipeline.js');

const ROOT = runtime.ROOT;
const DEFAULTS = {
  state: path.join(ROOT, 'data', 'state.json'),
  catalogue: path.join(ROOT, 'data', 'cache', 'catalog_full.json'),
  localDate: null, timeZone: null, twilight: -12, minElevation: 20,
  coarse: 30, fine: 1, pathTolerance: 1, corridor: 10, magLimit: 6,
  radius: 1, tags: null, classes: null, types: null, output: null, contactsOnly: true,
};

function usage() {
  console.log(`Usage: node tools/run_occultation_headless.js [options]

Required data are read from data/state.json and data/cache/catalog_full.json by
default. The output is written as JSON plus CSV beside the requested output.

Options:
  --state FILE       application state JSON
  --catalogue FILE   TLE text or catalogue JSON
  --stars FILE       STR1 binary star catalogue
  --date YYYY-MM-DD local civil date
  --timezone ZONE    IANA time zone
  --lat DEG --lon DEG --alt M   override the active ground site
  --mag-limit V --corridor ARCSEC --radius M
  --twilight DEG --min-elevation DEG --coarse SEC --fine SEC
  --tags leo,payload,...   mixed SatIdentifier scan tags
  --classes leo,meo,geo,heo --types PAY,R/B,DEB
  --output FILE      JSON result path
  --all-candidates   retain misses and incomplete events in the JSON/CSV
  --help             show this message`);
}

function number(value, label) {
  const out = Number(value);
  if (!Number.isFinite(out)) throw new Error(label + ' must be finite');
  return out;
}

function parseArgs(argv) {
  const out = Object.assign({}, DEFAULTS);
  const args = argv.slice();
  const takesValue = new Set(['state', 'catalogue', 'stars', 'date', 'timezone', 'lat', 'lon', 'alt',
    'mag-limit', 'corridor', 'radius', 'twilight', 'min-elevation', 'coarse', 'fine',
    'path-tolerance', 'tags', 'classes', 'types', 'output']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--help' || token === '-h') { out.help = true; continue; }
    if (token === '--all-candidates') { out.contactsOnly = false; continue; }
    if (!token.startsWith('--')) throw new Error('unknown argument: ' + token);
    const key = token.slice(2);
    if (!takesValue.has(key) || i + 1 >= args.length) throw new Error('missing value for --' + key);
    const value = args[++i];
    if (key === 'state' || key === 'catalogue' || key === 'stars' || key === 'date' ||
        key === 'timezone' || key === 'tags' || key === 'classes' || key === 'types' || key === 'output') {
      out[key.replace('-', '')] = value;
    }
    else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = number(value, '--' + key);
  }
  return out;
}

function listArg(value) {
  if (value == null || String(value).trim() === '') return null;
  const values = String(value).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return values.length ? values : null;
}

function classificationFilters(args) {
  const tags = listArg(args.tags) || [];
  const classes = listArg(args.classes) || tags.filter((value) =>
    ['leo', 'meo', 'geo', 'heo'].includes(String(value).trim().toLowerCase()));
  const types = listArg(args.types) || tags.filter((value) =>
    ['pay', 'payload', 'r/b', 'rocket body', 'rocket-body', 'deb', 'debris'].includes(
      String(value).trim().toLowerCase()));
  return {
    tags: tags.length ? tags : null,
    classes: classes.length ? classes : null,
    types: types.length ? types : null,
  };
}

function readState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function activeSite(saved) {
  const rows = Array.isArray(saved.locations) ? saved.locations : [];
  return rows.find((row) => row && row.active) || rows[0] || null;
}

function resolvedOptions(args, saved) {
  const savedSite = activeSite(saved) || {};
  const site = {
    kind: 'ground', latDeg: args.lat == null ? Number(savedSite.latDeg) : args.lat,
    lonDeg: args.lon == null ? Number(savedSite.lonDeg) : args.lon,
    altM: args.alt == null ? Number(savedSite.altM || 0) : args.alt,
  };
  if (!Number.isFinite(site.latDeg) || !Number.isFinite(site.lonDeg)) {
    throw new Error('set --lat and --lon, or provide an active site in --state');
  }
  const zone = args.timezone || defaultTimeZone();
  const date = args.date || new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const filters = classificationFilters(args);
  return {
    site: site, localDate: date, timeZone: zone,
    sunAltitudeLimitDeg: args.twilight, minimumElevationDeg: args.minElevation,
    coarseStepS: args.coarse, fineStepS: args.fine,
    pathToleranceArcsec: args.pathTolerance,
    fullSearch: true,
    // Full mode keeps a bounded worker path for every pass and postpones
    // expensive adaptive chart-path refinement. The exact P0-07/P0-09 solver
    // still evaluates every retained star candidate; no candidate cap is applied
    // in this separate process. `rawPathPaddingArcsec` is a conservative query
    // buffer for the bounded raw path, while the result keeps the explicit
    // path-precision provenance flag.
    passOptions: {
      maxResults: Number.MAX_SAFE_INTEGER, deferExactPasses: true,
      exactPassLimit: 0, pathMaxSamples: 4096,
      tags: filters.tags, classes: filters.classes, types: filters.types,
      // The desktop runner consumes crossings through the worker stream, so a
      // denser raw path is affordable and substantially shrinks the conservative
      // star-cone over-query. Only one crossing path is live at a time.
      workerPathMaxSamples: 512,
    },
    starOptions: {
      corridorArcsec: args.corridor, magLimit: args.magLimit,
      maxCandidates: Number.MAX_SAFE_INTEGER, maxTotalCandidates: null,
      maxQueries: Number.MAX_SAFE_INTEGER, catalogueResultCap: Number.MAX_SAFE_INTEGER,
      rawPathPaddingArcsec: 30, rawPathMaxSamples: 512,
      retainQueries: false, retainSourcePass: false,
    },
    eventOptions: { defaultRadiusM: args.radius, contactsOnly: args.contactsOnly,
      // Contacts-only mode screens the broad OCCSTAR1 cone against the dense
      // worker path before invoking the expensive exact solver. This is a
      // conservative 2-arcmin gate around the actual sampled trajectory; the
      // raw search remains uncapped and its screening count is reported.
      candidateScreeningMarginArcsec: 120,
      // The worker path is sampled at the full fine step. This bound is only a
      // screening margin for an unverified raw path; the final separation and
      // contact timing still come from SAT.prop.look() and P0-09.
      refine: { unverifiedSelectionMarginArcsec: 10, maxSegments: 64 } },
    publish: false,
  };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function writeOutputs(result, outputPath) {
  const state = result.state || {};
  const report = {
    version: result.version, status: result.status, complete: result.complete,
    error: result.error || null,
    startedAtMs: result.startedAtMs, finishedAtMs: result.finishedAtMs,
    config: result.config, flags: result.flags, timings: result.timings,
    stats: result.stats,
    state: { version: state.version, status: state.status, complete: state.complete,
      site: state.site, options: state.options, passes: state.passes,
      candidates: state.candidates, events: state.events, failures: state.failures,
      stats: state.stats },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  const csvPath = outputPath.replace(/\.json$/i, '') + '.csv';
  const fields = ['eventId', 'status', 'contactStatus', 'passId', 'satId', 'norad', 'name',
    'orbitClass', 'type', 'starKey', 'tCaMs', 'azDeg', 'elDeg', 'nominalSeparationArcsec',
    'distanceArcsec', 'radiusM',
    'angularRadiusArcsec', 'ingressMs', 'egressMs', 'durationMs'];
  const rows = [fields.join(',')];
  (state.events || []).forEach((event) => rows.push(fields.map((field) => csvCell(event[field])).join(',')));
  fs.writeFileSync(csvPath, rows.join('\n') + '\n');
  return { json: outputPath, csv: csvPath };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return; }
  const saved = readState(args.state);
  const input = resolvedOptions(args, saved);
  const rt = runtime.createRuntime({ cataloguePath: args.catalogue, starPath: args.stars });
  rt.bus.on('occultation-progress', (payload) => {
    process.stdout.write(JSON.stringify({ type: 'progress', progress: payload || {} }) + '\n');
  });
  process.stdout.write(JSON.stringify({ type: 'started', objects: rt.objects.length,
    stars: rt.stars.count(), starCatalogue: rt.starPath, date: input.localDate }) + '\n');
  const result = await chunkedPipeline.run(input, {
    passes: rt.SAT.occultation.passes, starCandidates: rt.SAT.occultation.starCandidates,
    eventState: rt.SAT.occultation.eventState, night: rt.SAT.occultation.night,
    path: rt.SAT.occultation.adaptivePath, scan: rt.scan, prop: rt.SAT.prop,
    refine: rt.SAT.occultation.refine, state: rt.state, stars: rt.stars,
    geometry: rt.SAT.occultation.geometry, bus: rt.bus,
  });
  const outputPath = args.output || path.join(ROOT, 'data', 'occultation-results',
    'occultation-' + input.localDate + '.json');
  const files = writeOutputs(result, outputPath);
  process.stdout.write(JSON.stringify({ type: 'finished', status: result.status,
    complete: result.complete, error: result.error || null, flags: result.flags, stats: result.stats,
    files: files }) + '\n');
  if (result.status === 'failed' || result.status === 'cancelled') process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
