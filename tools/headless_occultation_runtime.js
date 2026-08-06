/* Headless P0-11 runtime.
 *
 * This adapter supplies the browser-owned catalogue, star-cone, and worker
 * services to the production occultation pipeline. It deliberately contains no
 * scientific equations: SGP4, frames, pass normalization, candidate search,
 * closest approach, and contact timing remain the application modules.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const DEFAULT_STAR_BINARY = path.join(ROOT, 'app', 'assets', 'stars_deep.bin');
const FALLBACK_STAR_BINARY = path.join(ROOT, 'app', 'assets', 'stars_m9.bin');

function installModules() {
  if (global.SAT && global.SAT.occultation && global.SAT.occultation.pipeline) return;
  global.window = global;
  global.satellite = require(path.join(APP, 'vendor', 'satellite.min.js'));
  global.SAT = { ui: {}, occultation: {} };
  require(path.join(APP, 'frames.js'));
  require(path.join(APP, 'propagate.js'));
  require(path.join(APP, 'occultation', 'night.js'));
  require(path.join(APP, 'occultation', 'adaptive-path.js'));
  require(path.join(APP, 'occultation', 'geometry.js'));
  require(path.join(APP, 'occultation', 'passes.js'));
  require(path.join(APP, 'occultation', 'star-candidates.js'));
  require(path.join(APP, 'occultation', 'refine.js'));
  require(path.join(APP, 'occultation', 'satellite-size.js'));
  require(path.join(APP, 'occultation', 'contact.js'));
  require(path.join(APP, 'occultation', 'look-adapter.js'));
  require(path.join(APP, 'occultation', 'event-assembly.js'));
  require(path.join(APP, 'occultation', 'event-state.js'));
  require(path.join(APP, 'occultation', 'pipeline.js'));
}

function makeBus() {
  const listeners = new Map();
  return {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    off(name, listener) {
      if (listeners.has(name)) listeners.get(name).delete(listener);
    },
    emit(name, payload) {
      (listeners.get(name) || []).forEach((listener) => listener(payload));
    },
  };
}

function tleObjectsFromJson(filePath) {
  const source = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(source) ? source : source.tles;
  if (!Array.isArray(rows)) throw new Error('catalogue JSON has no tles array: ' + filePath);
  return rows.map((row, index) => {
    if (!row || !row.l1 || !row.l2) throw new Error('catalogue row ' + index + ' has no TLE');
    const norad = Number(row.norad == null ? row.l2.slice(2, 7) : row.norad);
    if (!Number.isInteger(norad)) throw new Error('invalid NORAD in ' + filePath + ' row ' + index);
    return {
      id: row.id == null ? 'o_' + norad : String(row.id),
      norad: norad,
      name: row.name == null ? 'NORAD ' + norad : String(row.name),
      intl: row.intl == null ? '' : String(row.intl),
      l1: String(row.l1).trim(), l2: String(row.l2).trim(),
      rcs: row.rcs == null ? null : Number(row.rcs),
      type: row.type == null ? null : String(row.type),
      stdMag: row.stdMag == null ? null : Number(row.stdMag),
    };
  });
}

function tleObjectsFromText(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const objects = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const name = lines[i].trim(), l1 = lines[i + 1].trim(), l2 = lines[i + 2].trim();
    if (!name || l1[0] !== '1' || l2[0] !== '2') continue;
    const norad = Number(l2.slice(2, 7));
    if (!Number.isInteger(norad)) throw new Error('invalid NORAD in ' + filePath);
    objects.push({ id: 'o_' + norad, norad: norad, name: name,
      intl: l1.slice(9, 17).trim(), l1: l1, l2: l2, rcs: null, type: null,
      stdMag: null });
    i += 2;
  }
  if (!objects.length) throw new Error('no TLE records in ' + filePath);
  return objects;
}

function readCatalogue(filePath) {
  return path.extname(filePath).toLowerCase() === '.json'
    ? tleObjectsFromJson(filePath) : tleObjectsFromText(filePath);
}

function readStarBinary(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'STR1') {
    throw new Error('invalid star catalogue header: ' + filePath);
  }
  const count = buffer.readUInt32LE(4);
  const wanted = 12 + count * 10;
  if (!count || buffer.length < wanted) throw new Error('truncated star catalogue: ' + filePath);
  const ra = new Float32Array(count), dec = new Float32Array(count), mag = new Int16Array(count);
  for (let i = 0; i < count; i++) ra[i] = buffer.readFloatLE(12 + i * 4);
  for (let i = 0; i < count; i++) dec[i] = buffer.readFloatLE(12 + count * 4 + i * 4);
  for (let i = 0; i < count; i++) mag[i] = buffer.readInt16LE(12 + count * 8 + i * 2);
  return { ra: ra, dec: dec, mag: mag, count: count, file: filePath };
}

function lowerBound(values, value, strict) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? values[mid] <= value : values[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Build the same spherical cone predicate used by app/js/stars.js. */
function makeStars(binary) {
  const D2R = Math.PI / 180;
  return {
    count: () => binary.count,
    cone(ra0, dec0, radiusDeg, magLimit) {
      const out = [];
      if (!(radiusDeg > 0)) return out;
      const decLo = Math.max(-90, dec0 - radiusDeg), decHi = Math.min(90, dec0 + radiusDeg);
      const first = lowerBound(binary.dec, decLo, false);
      const last = lowerBound(binary.dec, decHi, true);
      const sd0 = Math.sin(dec0 * D2R), cd0 = Math.cos(dec0 * D2R);
      const cosR = Math.cos(radiusDeg * D2R);
      for (let i = first; i < last; i++) {
        const mag = binary.mag[i] / 100;
        if (magLimit != null && mag > magLimit) continue;
        const dec = binary.dec[i], dRa = ra0 - binary.ra[i];
        const dot = sd0 * Math.sin(dec * D2R) + cd0 * Math.cos(dec * D2R) * Math.cos(dRa * D2R);
        if (dot >= cosR) out.push({ raDeg: binary.ra[i], decDeg: dec, mag: mag });
      }
      out.sort((a, b) => a.mag - b.mag);
      return out.length > 20000 ? out.slice(0, 20000) : out;
    },
  };
}

function makeState(objects) {
  const byId = new Map(objects.map((object) => [String(object.id), object]));
  const byNorad = new Map(objects.map((object) => [Number(object.norad), object]));
  return {
    catalog: { objs: objects, count: objects.length },
    getObj: (id) => byId.get(String(id)) || null,
    objByNorad: (norad) => byNorad.get(Number(norad)) || null,
  };
}

function makeScan(worker, objects, bus) {
  worker.loadObjs(objects);
  return {
    async runRaw(params, options) {
      const raw = await worker.runScan(params, (progress) => {
        bus.emit('occultation-scan-progress', progress);
      }, options && typeof options.onCrossing === 'function' ? options.onCrossing : null);
    const maxResults = options && options.maxResults != null
      ? Number(options.maxResults) : null;
      if (maxResults != null && raw.crossings.length > maxResults) {
        raw.crossings.sort((a, b) => a.tCaMs - b.tCaMs);
        raw.crossings.length = Math.floor(maxResults);
        raw.truncated = true;
      }
      return raw;
    },
  };
}

function createRuntime(options) {
  installModules();
  const config = options || {};
  const objects = config.objects || readCatalogue(config.cataloguePath);
  const binaryPath = config.starPath || (fs.existsSync(DEFAULT_STAR_BINARY)
    ? DEFAULT_STAR_BINARY : FALLBACK_STAR_BINARY);
  const bus = makeBus();
  const state = makeState(objects);
  const worker = require(path.join(APP, 'worker', 'scan-worker.js'));
  const stars = makeStars(readStarBinary(binaryPath));
  SAT.bus = bus;
  SAT.state = state;
  SAT.stars = stars;
  return {
    SAT: SAT,
    APP: APP,
    objects: objects,
    state: state,
    stars: stars,
    worker: worker,
    scan: makeScan(worker, objects, bus),
    bus: bus,
    starPath: binaryPath,
  };
}

module.exports = {
  ROOT: ROOT,
  APP: APP,
  DEFAULT_STAR_BINARY: DEFAULT_STAR_BINARY,
  FALLBACK_STAR_BINARY: FALLBACK_STAR_BINARY,
  installModules: installModules,
  readCatalogue: readCatalogue,
  readStarBinary: readStarBinary,
  makeStars: makeStars,
  createRuntime: createRuntime,
};
