/* P0-10 fixture and runtime metadata helpers.
 *
 * This module owns benchmark input I/O and reproducibility metadata. It does not
 * calculate sky geometry or decide whether an optimized candidate is correct.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const TLE_PATH = path.join(__dirname, 'fixtures', 'p0_10_catalog.tle');
const STAR_PATH = path.join(__dirname, 'fixtures', 'p0_10_bright_stars.json');
const DEFAULTS = {
  localDate: '2026-07-20', timeZone: 'Australia/Melbourne',
  site: { latDeg: -37.8136, lonDeg: 144.9631, altM: 31 },
  sunAltitudeLimitDeg: -12, minimumElevationDeg: 20,
  coarseStepS: 30, fineStepS: 1, pathToleranceArcsec: 1,
  corridorArcsec: 1000, magLimit: 4.6, bruteForceStepMs: 500,
};

function loadModules() {
  if (global.SAT && global.SAT.occultation && global.SAT.prop) return;
  global.window = global;
  global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
  global.SAT = { ui: {} };
  require(path.join(APP, 'frames.js'));
  require(path.join(APP, 'propagate.js'));
  require(path.join(APP, 'occultation', 'night.js'));
  require(path.join(APP, 'occultation', 'adaptive-path.js'));
  require(path.join(APP, 'occultation', 'geometry.js'));
  require(path.join(APP, 'occultation', 'passes.js'));
  require(path.join(APP, 'occultation', 'star-candidates.js'));
}

function readTleObjects(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const objects = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const name = lines[i].trim();
    const l1 = lines[i + 1] && lines[i + 1].trim();
    const l2 = lines[i + 2] && lines[i + 2].trim();
    if (!name || !l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') continue;
    const norad = Number(l2.slice(2, 7));
    if (!Number.isInteger(norad)) throw new Error('invalid NORAD in ' + filePath);
    objects.push({
      id: 'o_' + norad, norad: norad, name: name, intl: l1.slice(9, 17).trim(),
      l1: l1, l2: l2, rcs: null, stdMag: null,
    });
    i += 2;
  }
  if (!objects.length) throw new Error('no TLE records in ' + filePath);
  return objects;
}

function readStars(filePath) {
  const source = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(source.stars) || !source.stars.length) {
    throw new Error('bright-star fixture is empty: ' + filePath);
  }
  return source.stars.map((row) => ({
    id: String(row.id), raDeg: Number(row.raDeg), decDeg: Number(row.decDeg), mag: Number(row.mag),
  }));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitMetadata() {
  try {
    const commit = childProcess.execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = childProcess.execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    return { commit: commit, dirty: status.trim().length > 0 };
  } catch (error) {
    return { commit: null, dirty: null, error: String(error.message || error) };
  }
}

function memorySnapshot() {
  const m = process.memoryUsage();
  return { rssBytes: m.rss, heapUsedBytes: m.heapUsed, externalBytes: m.external };
}

function mergeMemory(a, b) {
  return {
    rssBytes: Math.max(a.rssBytes, b.rssBytes),
    heapUsedBytes: Math.max(a.heapUsedBytes, b.heapUsedBytes),
    externalBytes: Math.max(a.externalBytes, b.externalBytes),
  };
}

function validateOptions(options) {
  const config = Object.assign({}, DEFAULTS, options || {});
  config.site = Object.assign({}, DEFAULTS.site, (options && options.site) || {});
  config.bruteForceStepMs = Number(config.bruteForceStepMs);
  if (!Number.isFinite(config.bruteForceStepMs) || config.bruteForceStepMs < 100 || config.bruteForceStepMs > 500) {
    throw new Error('bruteForceStepMs must be between 100 and 500 ms');
  }
  return config;
}

module.exports = {
  ROOT, APP, TLE_PATH, STAR_PATH, DEFAULTS,
  loadModules, readTleObjects, readStars, sha256, gitMetadata,
  memorySnapshot, mergeMemory, validateOptions,
};
