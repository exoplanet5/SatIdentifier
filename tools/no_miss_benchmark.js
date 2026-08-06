/* P0-10 no-miss benchmark support.
 *
 * The optimized side uses the production worker core, pass normalization, adaptive
 * paths, and OCCSTAR1 query envelope. The truth side deliberately uses a separate
 * dense time loop: every fixture object is propagated at every UTC grid time and
 * every visible sample is compared with every fixture star using frames.sep().
 * This file has no browser, network, or application-state publication dependency.
 */
'use strict';

const path = require('path');
const fixture = require('./no_miss_fixture.js');
const { ROOT, APP, TLE_PATH, STAR_PATH, DEFAULTS, loadModules, readTleObjects,
  readStars, sha256, gitMetadata, memorySnapshot, mergeMemory, validateOptions } = fixture;

function candidateKey(satId, starKey) {
  return String(satId) + '\u0000' + String(starKey);
}

function makeServices(objects) {
  const byId = new Map(objects.map((object) => [object.id, object]));
  return {
    state: {
      getObj: (id) => byId.get(String(id)) || null,
      objByNorad: (norad) => objects.find((object) => object.norad === Number(norad)) || null,
    },
    byId: byId,
  };
}

async function optimizedRun(config, objects, stars, services) {
  const worker = require(path.join(APP, 'worker', 'scan-worker.js'));
  worker.loadObjs(objects);
  const scan = {
    runRaw: async (params) => {
      const start = process.hrtime.bigint();
      const raw = await worker.runScan(params);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      return Object.assign({}, raw, { ms: elapsedMs });
    },
  };
  const discovery = await SAT.occultation.passes.discover({
    site: config.site, localDate: config.localDate, timeZone: config.timeZone,
    sunAltitudeLimitDeg: config.sunAltitudeLimitDeg,
    minimumElevationDeg: config.minimumElevationDeg,
    coarseStepS: config.coarseStepS, fineStepS: config.fineStepS,
    pathToleranceArcsec: config.pathToleranceArcsec, pathMaxSamples: 4096,
    maxResults: 100000, eventPrefix: null,
  }, {
    night: SAT.occultation.night, scan: scan, prop: SAT.prop,
    path: SAT.occultation.adaptivePath, state: services.state,
  });
  const cone = (raDeg, decDeg, radiusDeg, magLimit) => stars.filter((star) =>
    SAT.frames.sep(raDeg, decDeg, star.raDeg, star.decDeg) <= radiusDeg &&
    (magLimit == null || star.mag <= magLimit)).map((star) => ({
      raDeg: star.raDeg, decDeg: star.decDeg, mag: star.mag, starId: star.id,
    }));
  const search = SAT.occultation.starCandidates.search({
    passes: discovery.passes, corridorArcsec: config.corridorArcsec,
    magLimit: config.magLimit, maxCandidates: 10000, maxQueries: 10000,
    catalogueResultCap: 10000,
  }, { stars: { cone: cone } });
  const passById = new Map(discovery.passes.map((pass) => [pass.passId, pass]));
  const pairs = new Set();
  search.candidates.forEach((candidate) => {
    const pass = passById.get(candidate.passId);
    if (pass) pairs.add(candidateKey(pass.satId, candidate.starKey));
  });
  return { discovery: discovery, search: search, passById: passById, pairs: pairs };
}

function bruteForceRun(config, objects, stars, window, memory) {
  const startNs = process.hrtime.bigint();
  const pairs = new Set();
  let propagations = 0, distanceChecks = 0, hits = 0, samples = 0;
  let peak = memorySnapshot();
  const checkTime = (tMs) => {
    samples++;
    for (const object of objects) {
      const geometry = SAT.prop.look(config.site, object, new Date(tMs), { refraction: false });
      propagations++;
      if (!geometry || Number(geometry.elDeg) < config.minimumElevationDeg) continue;
      for (const star of stars) {
        distanceChecks++;
        const separationArcsec = SAT.frames.sep(
          geometry.raDeg, geometry.decDeg, star.raDeg, star.decDeg) * 3600;
        if (separationArcsec <= config.corridorArcsec) {
          hits++;
          pairs.add(candidateKey(object.id, 'id:' + star.id));
        }
      }
    }
    peak = mergeMemory(peak, memorySnapshot());
  };
  const step = config.bruteForceStepMs;
  let tMs = Math.round(window.startMs);
  const endMs = Math.round(window.endMs);
  while (tMs <= endMs) { checkTime(tMs); tMs += step; }
  if (tMs - step < endMs) checkTime(endMs);
  const after = memorySnapshot();
  memory.peak = mergeMemory(memory.peak, peak);
  return {
    stepMs: step, samples: samples, propagations: propagations,
    distanceChecks: distanceChecks, hits: hits, pairs: pairs,
    wallMs: Number(process.hrtime.bigint() - startNs) / 1e6,
    memoryAfter: after,
  };
}

/**
 * Compare optimized candidate recall with a dense UTC truth calculation.
 *
 * @param {object} [options] Benchmark configuration. `site` is WGS-84 ground
 *     latitude/longitude in degrees and altitude in metres; `corridorArcsec`
 *     is the angular candidate threshold; `bruteForceStepMs` is the truth-grid
 *     spacing in UTC milliseconds and must be 100--500 ms.
 * @returns {Promise<object>} JSON-safe evidence containing the NightWindow,
 *     fixture hashes, optimized and brute-force counts, pair-set comparison,
 *     elapsed times, process-memory snapshots, and environment metadata.
 *
 * The truth separation is the exact spherical distance in the J2000 frame,
 * `d = atan2(|u_sat × u_star|, u_sat · u_star)`, reported in arcseconds. The
 * returned `comparison.optimizedSuperset` is true only when every dense truth
 * pair is present in the optimized pair set.
 */
async function runBenchmark(options) {
  loadModules();
  const config = validateOptions(options);
  const objects = readTleObjects(TLE_PATH);
  const stars = readStars(STAR_PATH);
  const services = makeServices(objects);
  SAT.state = services.state;
  const memoryBefore = memorySnapshot();
  let memory = { before: memoryBefore, peak: memoryBefore };
  const optimizedStart = process.hrtime.bigint();
  const optimized = await optimizedRun(config, objects, stars, services);
  const optimizedAfter = memorySnapshot();
  memory.peak = mergeMemory(memory.peak, optimizedAfter);
  const window = optimized.discovery.windows[0];
  if (!window) throw new Error('benchmark night window is empty');
  const brute = bruteForceRun(config, objects, stars, window, memory);
  const missing = Array.from(brute.pairs).filter((key) => !optimized.pairs.has(key)).sort();
  const extra = Array.from(optimized.pairs).filter((key) => !brute.pairs.has(key)).sort();
  const memoryAfter = brute.memoryAfter;
  return {
    benchmark: 'P0-10', version: 'p0-10', generatedAtMs: Date.now(),
    config: Object.assign({}, config, { site: Object.assign({}, config.site) }),
    inputs: {
      tleFile: path.relative(ROOT, TLE_PATH), tleSha256: sha256(TLE_PATH),
      starFile: path.relative(ROOT, STAR_PATH), starSha256: sha256(STAR_PATH),
      objects: objects.length, stars: stars.length, window: window,
    },
    optimized: {
      wallMs: Number(process.hrtime.bigint() - optimizedStart) / 1e6,
      rawCrossings: optimized.discovery.stats.rawCrossings,
      passes: optimized.discovery.passes.length,
      candidateRecords: optimized.search.candidates.length,
      uniqueCandidatePairs: optimized.pairs.size,
      queries: optimized.search.stats.queries,
      propagations: optimized.discovery.stats.propagations,
      scanMs: optimized.discovery.stats.ms,
      truncated: !!(optimized.discovery.stats.truncated || optimized.search.stats.truncated),
      culled: optimized.discovery.stats.culled,
    },
    bruteForce: {
      stepMs: brute.stepMs, samples: brute.samples, propagations: brute.propagations,
      distanceChecks: brute.distanceChecks, hits: brute.hits,
      uniqueCandidatePairs: brute.pairs.size, wallMs: brute.wallMs,
    },
    comparison: {
      thresholdArcsec: config.corridorArcsec,
      key: 'satellite catalogue id + star catalogue id; pass fragmentation is not part of the truth key',
      optimizedSuperset: missing.length === 0,
      missing: missing,
      extra: extra,
    },
    memory: {
      before: memory.before, afterOptimized: optimizedAfter, afterBruteForce: memoryAfter,
      peak: memory.peak,
      peakRssDeltaBytes: memory.peak.rssBytes - memory.before.rssBytes,
    },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    git: gitMetadata(),
  };
}

module.exports = { runBenchmark: runBenchmark, DEFAULTS: DEFAULTS };
