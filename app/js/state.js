/* SAT.bus + SAT.state — event bus, store, persistence.
 *
 * Ported in shape from SatObserver's state.js, but the data is different: this app
 * has no families and no per-satellite display flags. It has one observation setup
 * (site, epoch, span, pointing, FOV, exposure), one catalogue, and one scan result.
 */
(function () {
  'use strict';

  const U = SAT.util;

  // ---- bus -----------------------------------------------------------------
  const listeners = new Map();
  SAT.bus = {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    off(ev, fn) {
      const s = listeners.get(ev);
      if (s) s.delete(fn);
    },
    emit(ev, payload) {
      const s = listeners.get(ev);
      if (!s) return;
      s.forEach(fn => {
        try { fn(payload); } catch (e) { console.error('bus:' + ev, e); }
      });
    },
  };

  // ---- defaults ------------------------------------------------------------
  // Default pointing is the Orion Nebula: an unambiguous, easily recognised field
  // that makes the chart obviously correct on first run.
  function defaultObs() {
    return {
      mode: 'radec',
      raDeg: 83.822, decDeg: -5.391,
      azDeg: 180, elDeg: 60,
      track: 'sky',
      fovShape: 'rect',
      fovWDeg: 1.5, fovHDeg: 1.0,
      fovRDeg: 0.75,
      rotDeg: 0,
      flipEW: false,
      spanMin: 60,
      dut1S: 0,
      // refraction is no longer a choice: it is always applied (round-2 review).
      // SAT.frames keeps the {refract} option for tests that need the geometric
      // path, but nothing user-facing toggles it any more.
    };
  }

  function defaultFilters() {
    return {
      maxMag: 99, sunlitOnly: false, minElDeg: 0,
      classes: { leo: true, meo: true, geo: true, heo: true },
      // SATCAT object type; objects with no type land in UNK so switching UNK off
      // never silently hides "we don't know what this is" — the most interesting kind
      types: { 'PAY': true, 'R/B': true, 'DEB': true, 'UNK': true },
      minAltKm: 0, maxAltKm: 0,      // satellite height at closest approach; 0 = no limit
      maxRateAsPerS: 0, minRateAsPerS: 0,
      search: '',
    };
  }

  // Object-type colour defaults. DEB moved from brown-grey to pink in round 6 —
  // at trail alpha the brown read as a darker yellow next to the dominant PAY.
  // PAY stays deliberately warm: the dominant population must not look like the
  // blue/pale-green UI theme. Users can override all four (settings.typeColors).
  const TYPE_COLOR_DEFAULTS = {
    'PAY': '#ffd54f', 'R/B': '#ff7043', 'DEB': '#f06292', 'UNK': '#90a4ae',
  };

  function defaultSettings() {
    return {
      chart: {
        stars: true, starNames: false, constLines: true, constNames: false,
        sunMoon: true, mw: false, grid: true, magAuto: true, magLimit: 9.0,
        labels: true, padFrac: 0.7,
      },
      allsky: { eastLeft: true, elStep: 30, stars: true, sunMoon: true, mw: false,
                starNames: false, constLines: false, constNames: false },
      scan: {
        coarseStepS: 30, fineStepS: 1.0, marginDeg: 0,
        workers: 0, maxCrossings: 5000,
      },
      typeColors: Object.assign({}, TYPE_COLOR_DEFAULTS),   // user-editable
      columns: null,        // crossings.js fills this on first run
      columnsVer: 0,        // migration level applied to a saved columns array —
                            // scalar, so the load merge round-trips it (a key
                            // absent from defaults would never be restored)
      cameras: [],          // user-defined FOV presets
      layout: {},
    };
  }

  // The catalogue is a MERGED set from up to four sources, deduplicated by NORAD
  // (newest TLE epoch wins). Each object carries src:
  // 'spacetrack'|'celestrak'|'mccants'|'paste'
  // so the Catalogue window can report epoch-age statistics per source — a single
  // "newest element" line over a merged set hides exactly the staleness that breaks
  // an identification. sources.* holds the refs needed to re-hydrate from the
  // backend disk cache on reload; pasted TLEs (small) persist inline in state.json.
  const state = {
    obs: defaultObs(),
    filters: defaultFilters(),
    settings: defaultSettings(),
    locations: [],
    catalog: {
      objs: [], count: 0, bad: 0,
      sources: { spacetrack: [], celestrak: [], mccants: [], paste: null },
    },
    scan: { crossings: [], ranAt: null, stale: true, params: null, culled: null,
            checked: new Set() },   // ticked rows; views show only these when non-empty
    selection: { satId: null },
  };
  SAT.state = state;

  const SRC_TAGS = ['spacetrack', 'celestrak', 'mccants', 'paste'];
  const MAX_REFS_PER_SRC = 8;     // rehydrate list cap; oldest refs fall off
  const MAX_PASTED = 2000;        // pasted sets persist inline — protect the 4 MB state cap

  // ---- accessors -----------------------------------------------------------

  state.activeLocation = function () {
    return state.locations.find(l => l.active) || state.locations[0] || null;
  };

  /** THE one resolution point for site kind (CONTRACT "Orbital observing
   *  stations"). Ground sites pass through with kind stamped; orbit sites come
   *  back with the TLE resolved OUT OF THE LOADED CATALOGUE — never stored on the
   *  site, so it can never silently go stale relative to the catalogue it
   *  identifies against — or with missing:true, which callers must show rather
   *  than guess around. */
  state.resolvedSite = function (loc) {
    const l = loc || state.activeLocation();
    if (!l) return null;
    if ((l.kind || 'ground') !== 'orbit') return Object.assign({ kind: 'ground' }, l);
    const obj = l.norad != null ? state.objByNorad(l.norad) : null;
    return Object.assign({}, l, {
      kind: 'orbit',
      l1: obj ? obj.l1 : null,
      l2: obj ? obj.l2 : null,
      objName: obj ? obj.name : null,
      missing: !obj,
    });
  };

  state.getObj = function (id) {
    return state.catalog.objs.find(o => o.id === id) || null;
  };

  state.objByNorad = function (n) {
    return state.catalog.objs.find(o => o.norad === n) || null;
  };

  state.setSelection = function (satId) {
    state.selection.satId = satId || null;
    SAT.bus.emit('selection-changed', { satId: state.selection.satId });
  };

  /** Click-to-select with toggle-off, so clicking empty sky or the same marker
   *  twice clears the selection. */
  state.clickSelect = function (satId) {
    state.setSelection(satId && satId !== state.selection.satId ? satId : null);
  };

  /** The single filter point. Chart, table and all-sky view all read this, so a
   *  filter can never mean one thing in the list and another on the chart. */
  state.visibleCrossings = function () {
    const f = state.filters;
    const q = (f.search || '').trim().toLowerCase();
    return state.scan.crossings.filter(c => {
      if (f.classes && f.classes[c.cls] === false) return false;
      const ty = (c.type === 'PAY' || c.type === 'R/B' || c.type === 'DEB') ? c.type : 'UNK';
      if (f.types && f.types[ty] === false) return false;
      if (f.sunlitOnly && c.shadow !== 'none') return false;
      // null altKm (propagation failed at CA) is kept, not hidden: an altitude
      // filter must never silently remove "could not compute"
      if (c.altKm != null) {
        if (f.minAltKm > 0 && c.altKm < f.minAltKm) return false;
        if (f.maxAltKm > 0 && c.altKm > f.maxAltKm) return false;
      }
      if (f.maxMag < 99 && !(c.magEst != null && c.magEst <= f.maxMag)) return false;
      if (f.minRateAsPerS > 0 && !(c.rateAsPerS >= f.minRateAsPerS)) return false;
      if (f.maxRateAsPerS > 0 && !(c.rateAsPerS <= f.maxRateAsPerS)) return false;
      if (q) {
        const hay = (c.name + ' ' + c.norad + ' ' + (c.intl || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  };

  /** The one colour authority for object types. Chart, all-sky and the table's
   *  chips all route through here, so a user override applies everywhere at once
   *  and the views can never disagree. Bad saved values fall back to defaults. */
  state.typeColorOf = function (t) {
    const k = (t === 'PAY' || t === 'R/B' || t === 'DEB') ? t : 'UNK';
    const tc = state.settings.typeColors || {};
    const v = tc[k];
    return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))
      ? v : TYPE_COLOR_DEFAULTS[k];
  };
  state.typeColorDefaults = function () { return Object.assign({}, TYPE_COLOR_DEFAULTS); };

  /** What the sky chart and all-sky view draw: the filtered set, narrowed to the
   *  ticked rows when any are ticked. Deliberately NOT part of visibleCrossings —
   *  the table must keep listing everything so boxes can still be unticked. */
  state.chartCrossings = function () {
    const list = state.visibleCrossings();
    const ck = state.scan.checked;
    return (ck && ck.size) ? list.filter(c => ck.has(c.satId)) : list;
  };

  /** Merge a patch into obs, normalise, invalidate the scan, notify, persist.
   *  Everything that edits the pointing goes through here — that is what keeps
   *  "the parameters changed, rescan" honest. */
  state.setObs = function (patch) {
    const o = state.obs;
    Object.assign(o, patch);
    o.raDeg = ((o.raDeg % 360) + 360) % 360;
    o.decDeg = U.clamp(o.decDeg, -90, 90);
    o.azDeg = ((o.azDeg % 360) + 360) % 360;
    o.elDeg = U.clamp(o.elDeg, -90, 90);
    o.fovWDeg = U.clamp(o.fovWDeg, 1 / 3600, 180);
    o.fovHDeg = U.clamp(o.fovHDeg, 1 / 3600, 180);
    o.fovRDeg = U.clamp(o.fovRDeg, 1 / 3600, 90);
    o.spanMin = U.clamp(o.spanMin, 0.1, 7 * 1440);
    o.rotDeg = ((o.rotDeg % 360) + 360) % 360;
    state.scan.stale = true;
    SAT.bus.emit('obs-changed', { field: Object.keys(patch)[0] || null });
    state.save();
  };

  /** Radius of the circle that encloses the field — the scan's cull radius. */
  state.fovRadiusDeg = function () {
    const o = state.obs;
    return o.fovShape === 'circ'
      ? o.fovRDeg
      : 0.5 * Math.hypot(o.fovWDeg, o.fovHDeg);
  };

  // ---- persistence ---------------------------------------------------------
  // The catalogue is deliberately NOT persisted: 27k TLE pairs is several MB and
  // the backend already caches it on disk. We store a reference and re-hydrate.

  function serialisable() {
    return {
      obs: state.obs,
      filters: state.filters,
      settings: state.settings,
      locations: state.locations.map(l => {
        const c = Object.assign({}, l);
        Object.keys(c).forEach(k => { if (k[0] === '_') delete c[k]; });
        return c;
      }),
      catalogRefs: {
        spacetrack: state.catalog.sources.spacetrack,
        celestrak: state.catalog.sources.celestrak,
        mccants: state.catalog.sources.mccants,
      },
      // Pasted TLEs have no server-side cache, so they persist inline. Capped:
      // paste is meant for a handful of objects, and state.json has a 4 MB limit.
      pasted: state.catalog.objs
        .filter(o => o.src === 'paste')
        .slice(0, MAX_PASTED)
        .map(o => ({
          name: o.name, l1: o.l1, l2: o.l2, norad: o.norad, intl: o.intl,
          rcs: o.rcs, type: o.type, stdMag: o.stdMag,
        })),
      selection: state.selection,
    };
  }

  let saveTimer = null;
  let savePending = false;

  function pushState(useBeacon) {
    savePending = false;
    const body = JSON.stringify(serialisable());
    if (useBeacon && navigator.sendBeacon) {
      // pagehide: fetch() may be cancelled, sendBeacon is not
      navigator.sendBeacon('/api/state', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    }).catch(() => { /* offline: the next save will carry the same data */ });
  }

  state.save = function () {
    savePending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => pushState(false), 800);
  };

  // Without this the last action of a session — a re-aim, a filter, a window drag —
  // is lost, because it is still sitting in the debounce timer.
  window.addEventListener('pagehide', () => {
    if (savePending) { clearTimeout(saveTimer); pushState(true); }
  });

  function toObj(t, tag) {
    return {
      id: 'o_' + t.norad,
      norad: t.norad,
      name: t.name,
      intl: t.intl || null,
      l1: t.l1, l2: t.l2,
      rcs: t.rcs == null ? null : t.rcs,
      // SATCAT OBJECT_TYPE. Carries the size information RCS no longer does:
      // CelesTrak publishes no RCS above NORAD 50000, so for most of a modern
      // catalogue this is the only size prior SAT.photo has to work with.
      type: t.type || null,
      stdMag: t.stdMag == null ? null : t.stdMag,
      src: tag,
    };
  }

  function epochOf(o) {
    // invalid TLEs get -Infinity so any valid element set wins the dedup
    return o._satrec ? o._satrec.jdsatepoch : -Infinity;
  }

  function refreshCatalogTotals() {
    const c = state.catalog;
    c.count = c.objs.length;
    c.bad = c.objs.reduce((n, o) => n + (o._satrecBad ? 1 : 0), 0);
  }

  /** Merge a TlePayload into the catalogue under a source tag and build every
   * satrec up front.
   *
   * Init is hoisted here deliberately: ~6.6 us per object, so 27k objects cost
   * about 180 ms once and the scan's hot loop never pays for it (see
   * "Performance decisions" in CONTRACT.md).
   *
   * opts.replace: drop the tag's existing objects (and rehydrate refs) first —
   * "Load full catalogue" semantics. Without it the payload merges additively —
   * Space-Track one-off queries, successive McCants files, successive pastes.
   *
   * Duplicates are resolved by NORAD across the WHOLE catalogue, newest TLE
   * epoch wins regardless of source. Which source "owns" an object after a
   * collision therefore reflects whose elements are fresher, and the per-source
   * statistics count final ownership, not what was loaded.
   */
  state.addTles = function (tag, payload, opts) {
    if (SRC_TAGS.indexOf(tag) < 0) throw new Error('unknown source tag: ' + tag);
    const o = opts || {};
    const incoming = (payload.tles || []).map(t => toObj(t, tag));
    let bad = 0;
    for (const obj of incoming) if (!SAT.prop.ensureSatrec(obj)) bad++;

    const base = o.replace
      ? state.catalog.objs.filter(x => x.src !== tag)
      : state.catalog.objs;
    const byNorad = new Map(base.map(x => [x.norad, x]));
    let added = 0, updated = 0;
    for (const obj of incoming) {
      const prev = byNorad.get(obj.norad);
      if (!prev) { byNorad.set(obj.norad, obj); added++; }
      else if (epochOf(obj) >= epochOf(prev)) { byNorad.set(obj.norad, obj); updated++; }
    }
    state.catalog.objs = Array.from(byNorad.values());
    refreshCatalogTotals();

    if (tag === 'paste') {
      state.catalog.sources.paste = { fetched: payload.fetched || null };
    } else {
      const refs = o.replace ? [] : (state.catalog.sources[tag] || []);
      if (payload.cacheKey) {
        refs.push({ source: payload.source, fetched: payload.fetched,
                    cacheKey: payload.cacheKey });
        while (refs.length > MAX_REFS_PER_SRC) refs.shift();
      }
      state.catalog.sources[tag] = refs;
    }

    state.scan.stale = true;
    SAT.bus.emit('catalog-changed', { count: state.catalog.count, bad: state.catalog.bad });
    state.save();
    return { count: incoming.length, bad: bad, added: added, updated: updated };
  };

  /** Remove every object a source contributed (and its rehydrate refs). */
  state.clearSource = function (tag) {
    state.catalog.objs = state.catalog.objs.filter(o => o.src !== tag);
    state.catalog.sources[tag] = tag === 'paste' ? null : [];
    refreshCatalogTotals();
    state.scan.stale = true;
    SAT.bus.emit('catalog-changed', { count: state.catalog.count, bad: state.catalog.bad });
    state.save();
  };

  /** Per-source epoch-age statistics against the SIM clock (not wall time —
   *  scanning yesterday's exposure against today's ages would misstate every
   *  number). Returns {spacetrack: {count, newestD, medianD, oldestD}, ...},
   *  tag absent when it has no objects. */
  state.sourceStats = function () {
    const nowMs = SAT.clock ? SAT.clock.getDate().getTime() : Date.now();
    const stats = {};
    for (const tag of SRC_TAGS) {
      const ages = [];
      for (const o of state.catalog.objs) {
        if (o.src !== tag) continue;
        const ep = epochOf(o);
        if (isFinite(ep)) ages.push(nowMs / 86400000 + 2440587.5 - ep);
      }
      if (!ages.length) continue;
      ages.sort((a, b) => a - b);
      stats[tag] = {
        count: ages.length,
        newestD: ages[0],
        medianD: ages[Math.floor(ages.length / 2)],
        oldestD: ages[ages.length - 1],
      };
    }
    return stats;
  };

  state.load = async function () {
    let saved = null;
    try {
      const r = await fetch('/api/state');
      saved = await r.json();
    } catch (e) {
      saved = null;
    }
    if (saved && typeof saved === 'object') {
      if (saved.obs) Object.assign(state.obs, saved.obs);
      if (saved.filters) Object.assign(state.filters, saved.filters);
      if (saved.settings) {
        // merge per-section so a new setting added in a later version still gets
        // its default instead of coming back undefined
        for (const k of Object.keys(state.settings)) {
          if (saved.settings[k] && typeof saved.settings[k] === 'object'
              && !Array.isArray(saved.settings[k])) {
            Object.assign(state.settings[k], saved.settings[k]);
          } else if (saved.settings[k] != null) {
            state.settings[k] = saved.settings[k];
          }
        }
      }
      if (Array.isArray(saved.locations)) state.locations = saved.locations;
      if (saved.selection) state.selection = saved.selection;
    }
    if (!state.locations.length) {
      state.locations = [{
        id: U.uuid('loc'), name: 'Greenwich', latDeg: 51.4779, lonDeg: -0.0015,
        altM: 47, active: true, color: '#ff5252',
      }];
    }
    if (!state.locations.some(l => l.active)) state.locations[0].active = true;

    // Re-hydrate the catalogue: cached sources from the backend disk cache (each
    // ref replayed additively, in load order), then pasted TLEs from state.json.
    // A vanished cache entry is skipped silently — the Catalogue window shows
    // per-source counts, so an absence is visible there rather than fatal here.
    const refs = (saved && saved.catalogRefs) || {};
    for (const tag of ['spacetrack', 'celestrak', 'mccants']) {
      for (const ref of (Array.isArray(refs[tag]) ? refs[tag] : [])) {
        if (!ref || !ref.cacheKey) continue;
        try {
          const r = await fetch('/api/cache/' + encodeURIComponent(ref.cacheKey));
          const payload = await r.json();
          if (payload && payload.ok !== false && payload.tles) {
            state.addTles(tag, payload, { replace: false });
          }
        } catch (e) { /* skip this ref */ }
      }
    }
    if (saved && Array.isArray(saved.pasted) && saved.pasted.length) {
      try {
        state.addTles('paste', { tles: saved.pasted, fetched: null }, { replace: false });
      } catch (e) { /* pasted set malformed — start without it */ }
    }

    SAT.bus.emit('state-loaded');
  };
})();
