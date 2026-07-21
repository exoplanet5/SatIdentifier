/* SAT.ui.pointing — the observation setup window: site, epoch, timespan, pointing,
 * field of view. Everything on the left of "who is in my field of view".
 *
 * This window owns no data. Every edit lands in SAT.state.setObs(), which is what
 * keeps the Crossings window's "parameters changed — rescan" tag honest. Nothing
 * here ever starts a scan: re-aiming mid-scan is how you freeze a tab.
 *
 * Layout is one control row per line, no section-header lines — the window's
 * default slot is short and wide, and the round-1 review found anything taller
 * unusable. There is deliberately NO exposure length and NO plate scale (same
 * review): the scan timespan is the only time quantity here.
 *
 * Rules worth knowing before editing:
 *  - A rejected edit flashes the field red and is reverted from state, never
 *    written. util.parseRA/parseDec return null rather than NaN for exactly this
 *    reason, and a NaN in obs.raDeg would poison every consumer silently.
 *  - Each coordinate row has BOTH a sexagesimal and a decimal field, both
 *    editable. They are not two values: both commit to the same obs field and
 *    refresh() repaints both from state, which is the only sync mechanism —
 *    there is no field-to-field copying to fall out of step.
 *  - The degrees/arcmin toggle is a DISPLAY setting. It never touches state, so
 *    toggling units can never round a field size.
 *  - Switching mode converts through SAT.frames at the current clock time, so the
 *    two representations always describe the same patch of sky. The refraction
 *    inverse in frames.js is exact for this: a non-invertible pair would walk the
 *    pointing a little further every time the user toggled.
 */
(function () {
  'use strict';

  const U = SAT.util;
  const F = SAT.frames;

  const STYLE_ID = 'pnt-style';

  const NO_SITE = 'Alt/Az needs an active site — add one in the Locations window.';

  // 6h/24h chips removed in round 3: identification works on short windows, and a
// long span is still one keystroke in the field itself.
const SPAN_CHIPS = [['1m', 1], ['3m', 3], ['5m', 5], ['10m', 10], ['1h', 60]];

  // No built-in camera presets (round-2 review): they were one person's guesses
  // about other people's equipment. The dropdown holds only what the user saves.

  // ---- module state --------------------------------------------------------

  let ui = null;              // control references, filled by init()
  let fovUnit = 'deg';        // 'deg' | 'min' — display only, never persisted
  let lastEpochStr = '';      // so the 'time' tick at 60 Hz costs one string compare
  let camPendingDelete = null;

  // ---- style ---------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.pnt-root{padding:6px 8px;font-size:12px;display:flex;flex-direction:column;gap:4px;}',
      // rows must never wrap: a control breaking onto a second line at the default
      // window width was the round-1 layout complaint
      '.pnt-root .row{flex-wrap:nowrap;white-space:nowrap;}',
      '.pnt-root .row+.row{margin-top:0;}',
      '.pnt-lbl{color:var(--fg-dim);white-space:nowrap;min-width:46px;flex:none;}',
      '.pnt-echo{color:var(--fg-dim);font-family:var(--mono);font-size:11px;',
      '  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;',
      '  text-overflow:ellipsis;}',
      // 19 mono chars of content + the .input box (2x7px padding + 2x1px border),
      // so the full YYYY-MM-DD HH:MM:SS is never truncated (round-1 complaint)
      '.pnt-time{width:calc(19ch + 18px);flex:none;}',
      '.pnt-num{width:64px;font-family:var(--mono);text-align:right;flex:none;}',
      // ch-based widths sized to the longest legal value ("23 59 59.9" = 10ch,
      // "194.8326" = 8ch) + input chrome — the round-7 review found the old fixed
      // pixel widths left dead space after the coordinates
      '.pnt-dnum{width:calc(9ch + 18px);font-family:var(--mono);text-align:right;flex:none;}',
      '.pnt-wide{width:calc(11ch + 18px);font-family:var(--mono);flex:none;}',
      '.pnt-tog.on{background:var(--accent-dim);border-color:var(--accent-dim);color:#fff;}',
      '.pnt-bad{border-color:var(--danger)!important;color:var(--danger)!important;}',
      '.pnt-msg{min-height:14px;color:var(--fg-dim);font-size:11px;overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap;}',
      '.pnt-msg.pnt-err{color:var(--danger);}',
      '.pnt-gap{height:1px;background:var(--border);margin:3px 0;flex:none;}',
      '.pnt-root input:disabled{opacity:.5;}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ---- small helpers -------------------------------------------------------

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** Shortest decimal that still round-trips the value at display precision. */
  function trim(v, d) {
    return String(+(+v).toFixed(d == null ? 6 : d));
  }

  const uFac = () => (fovUnit === 'min' ? 60 : 1);
  const uSym = () => (fovUnit === 'min' ? '′' : '°');

  function setMsg(text, isErr) {
    if (!ui) return;
    ui.msg.textContent = text || '';
    ui.msg.classList.toggle('pnt-err', !!isErr);
  }

  /** Flash a field and say why. The caller always follows with refresh(), which
   *  restores the field from state — so a rejected edit leaves no trace in obs. */
  function reject(input, why) {
    input.classList.add('pnt-bad');
    input.title = why;
    setTimeout(() => { input.classList.remove('pnt-bad'); input.title = ''; }, 1100);
    setMsg('✗ ' + why, true);
  }

  /** refresh() repaints every field from state — but never one the user is typing
   *  in, or the once-a-second clock tick would eat the edit mid-keystroke. */
  function guardEdits(input) {
    input.addEventListener('focus', () => { input._pntEditing = true; });
    input.addEventListener('blur', () => { input._pntEditing = false; refresh(); });
    return input;
  }

  function setVal(input, v) {
    if (!input._pntEditing) input.value = v;
  }

  /** Sexagesimal sanity beyond what util.parseRA/parseDec enforce.
   *
   *  parseRA is deliberately lenient and wraps modulo 360, so "99 99 99" comes back
   *  as a perfectly valid 04h 42m — a different field entirely, silently accepted.
   *  Minutes and seconds must therefore be < 60, and the leading term inside its
   *  own range, before the value is allowed anywhere near state. */
  function sexSane(str, maxFirst) {
    const n = U.sexParts(str);
    if (!n) return false;
    if (n.length === 1) return true;                       // bare decimal degrees
    if (Math.abs(n[0]) >= maxFirst) return false;
    if (Math.abs(n[1]) >= 60) return false;
    if (n.length > 2 && Math.abs(n[2]) >= 60) return false;
    return true;
  }

  const parseRaField = s => (sexSane(s, 24) ? U.parseRA(s) : null);
  const parseDecField = s => (sexSane(s, 91) ? U.parseDec(s) : null);

  /** Azimuth: written like a declination but wrapped into [0,360) and unsigned. */
  function parseAzField(s) {
    if (!sexSane(s, 360)) return null;
    const n = U.sexParts(s);
    if (!n) return null;
    const a = n.length === 1 ? n[0]
      : (/^\s*-/.test(String(s)) ? -1 : 1) *
        (Math.abs(n[0]) + Math.abs(n[1] || 0) / 60 + Math.abs(n[2] || 0) / 3600);
    return isFinite(a) ? ((a % 360) + 360) % 360 : null;
  }

  /** Strict decimal degrees for the decimal coordinate fields: plain numbers only,
   *  no exponent forms, no unit letters — those belong in the sexagesimal field. */
  function parseDecimalDeg(s) {
    const t = String(s).trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  const parseDecimalWrap = s => {
    const v = parseDecimalDeg(s);
    return v == null ? null : ((v % 360) + 360) % 360;
  };

  const parseDecimalLat = s => {
    const v = parseDecimalDeg(s);
    return (v == null || v < -90 || v > 90) ? null : v;
  };

  function parseNum(s, lo, hi) {
    const v = parseFloat(String(s).trim());
    if (!isFinite(v) || v < lo || v > hi) return null;
    return v;
  }

  /** "YYYY-MM-DD HH:MM:SS" UTC. Impossible dates are rejected rather than let
   *  Date.UTC roll them over — 2026-02-31 quietly becoming Mar 3 would move the
   *  whole scan window without a word. */
  function parseEpoch(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    if (isNaN(d.getTime())) return null;
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() + 1 !== +m[2] ||
        d.getUTCDate() !== +m[3] || d.getUTCHours() !== +m[4] ||
        d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6]) return null;
    return d;
  }

  /** util.fmtDec zero-pads to two digits and always signs; azimuth wants three
   *  digits and no sign. */
  const fmtAz = d => U.fmtDec(((d % 360) + 360) % 360).replace(/^\+/, '');

  // ---- frame plumbing ------------------------------------------------------

  /** The options every frames call in this window shares. Refraction is always
   *  applied (round-2 review removed the checkbox): an Alt/Az pointing is what the
   *  telescope points at, which is apparent by definition. */
  function frameOpts() {
    const o = SAT.state.obs;
    return { refract: true, dut1S: o.dut1S || 0 };
  }

  /** The current pointing in both representations. `aa` is null when there is no
   *  active site — a normal state on a fresh install, and one that must produce a
   *  message rather than a throw. */
  function solve() {
    const o = SAT.state.obs;
    const loc = SAT.state.activeLocation();
    const date = SAT.clock.getDate();
    const opt = frameOpts();
    if (o.mode === 'radec') {
      return {
        raDeg: o.raDeg, decDeg: o.decDeg, loc: loc,
        aa: loc ? F.raDecToAltAz(o.raDeg, o.decDeg, loc, date, opt) : null,
      };
    }
    const rd = loc ? F.altAzToRaDec(o.azDeg, o.elDeg, loc, date, opt) : null;
    return {
      raDeg: rd ? rd.raDeg : o.raDeg, decDeg: rd ? rd.decDeg : o.decDeg, loc: loc,
      aa: { azDeg: o.azDeg, elDeg: o.elDeg },
    };
  }

  /** Write a J2000 pointing, carrying the alt/az representation with it so the mode
   *  toggle stays a change of view rather than a re-aim. */
  function applyRaDec(raDeg, decDeg) {
    const loc = SAT.state.activeLocation();
    const patch = { raDeg: raDeg, decDeg: decDeg };
    if (loc) {
      const aa = F.raDecToAltAz(raDeg, decDeg, loc, SAT.clock.getDate(), frameOpts());
      patch.azDeg = aa.azDeg;
      patch.elDeg = aa.elDeg;
    }
    SAT.state.setObs(patch);
    return true;
  }

  /** Same, the other way round. Needs a site: alt/az has no meaning without one. */
  function applyAltAz(azDeg, elDeg) {
    const loc = SAT.state.activeLocation();
    if (!loc) { setMsg(NO_SITE, true); return false; }
    const rd = F.altAzToRaDec(azDeg, elDeg, loc, SAT.clock.getDate(), frameOpts());
    SAT.state.setObs({ azDeg: azDeg, elDeg: elDeg, raDeg: rd.raDeg, decDeg: rd.decDeg });
    return true;
  }

  function setMode(mode) {
    const o = SAT.state.obs;
    if (mode === o.mode) return;
    const loc = SAT.state.activeLocation();
    if (!loc) { setMsg(NO_SITE, true); refresh(); return; }
    const date = SAT.clock.getDate();
    const opt = frameOpts();
    // The conversion has to be redone at the current time rather than reusing the
    // representation applyRaDec/applyAltAz stored, because the two drift apart as
    // the clock runs. Toggling back and forth is therefore lossless only to the
    // accuracy of the refraction inverse: exact to double precision above ~20 deg
    // elevation, ~0.1" at the horizon, where the fixed-point iteration in
    // frames.refractionInvDeg converges slowest. See tools/test_pointing.js.
    //
    // track follows the mode: a field given in RA/Dec is one you track sidereally,
    // a field given in Alt/Az is what a parked or drift-scanning mount sees. The
    // user can override it immediately below; this is only the sane default.
    if (mode === 'altaz') {
      const aa = F.raDecToAltAz(o.raDeg, o.decDeg, loc, date, opt);
      SAT.state.setObs({ mode: mode, azDeg: aa.azDeg, elDeg: aa.elDeg, track: 'mount' });
    } else {
      const rd = F.altAzToRaDec(o.azDeg, o.elDeg, loc, date, opt);
      SAT.state.setObs({ mode: mode, raDeg: rd.raDeg, decDeg: rd.decDeg, track: 'sky' });
    }
    setMsg('');
    refresh();
  }

  // ---- readouts ------------------------------------------------------------


  // ---- camera presets ------------------------------------------------------
  // A preset is {id, name, wDeg, hDeg}. Saves from before review round 1 may carry
  // a plate-scale key; it is simply never read — that IS the migration, and
  // rewriting the user's settings to strip it would be churn for nothing.

  function userCameras() {
    const st = SAT.state.settings;
    if (!Array.isArray(st.cameras)) st.cameras = [];
    return st.cameras;
  }

  function cameraByKey(key) {
    if (!key) return null;
    return userCameras().find(c => c.id === key.slice(1)) || null;
  }

  function buildCameras(selectKey) {
    if (!ui) return;
    clear(ui.camSel);
    ui.camSel.appendChild(U.el('option', { value: '' },
      userCameras().length ? '— presets —' : '— none saved —'));
    userCameras().forEach(c => {
      ui.camSel.appendChild(U.el('option', { value: 'u' + c.id }, c.name));
    });
    ui.camSel.value = selectKey || '';
    camPendingDelete = null;
    ui.camDel.textContent = '✕';
  }

  function saveCamera() {
    const o = SAT.state.obs;
    const name = String(ui.camName.value || '').trim();
    if (!name) { reject(ui.camName, 'give the preset a name first'); return; }
    const cams = userCameras();
    const found = cams.find(c => c.name === name);
    const rec = {
      id: found ? found.id : U.uuid('cam'), name: name,
      wDeg: o.fovWDeg, hDeg: o.fovHDeg,
    };
    if (found) Object.assign(found, rec); else cams.push(rec);
    SAT.state.save();
    ui.camName.value = '';
    buildCameras('u' + rec.id);
    setMsg('✓ camera preset "' + name + '" saved');
  }

  /** Two-click confirm, no modal — the house pattern for anything destructive. */
  function deleteCamera() {
    const key = String(ui.camSel.value || '');
    if (key.charAt(0) !== 'u') { setMsg('select a preset to delete first', true); return; }
    const id = key.slice(1);
    if (camPendingDelete !== id) {
      camPendingDelete = id;
      ui.camDel.textContent = '⚠ delete?';
      setTimeout(() => {
        if (camPendingDelete === id) { camPendingDelete = null; ui.camDel.textContent = '✕'; }
      }, 5000);
      return;
    }
    SAT.state.settings.cameras = userCameras().filter(c => c.id !== id);
    SAT.state.save();
    buildCameras('');
    setMsg('✓ preset removed');
  }

  // ---- presets -------------------------------------------------------------

  function fromSelection() {
    const satId = SAT.state.selection && SAT.state.selection.satId;
    const obj = satId ? SAT.state.getObj(satId) : null;
    if (!obj) { setMsg('no object selected — pick a row in the Crossings list', true); return; }
    const loc = SAT.state.activeLocation();
    if (!loc || !SAT.prop || !SAT.prop.look) { setMsg(NO_SITE, true); return; }
    const lk = SAT.prop.look(loc, obj, SAT.clock.getDate());
    if (!lk) { setMsg('SGP4 failed for ' + obj.name + ' at this epoch', true); return; }
    applyRaDec(lk.raDeg, lk.decDeg);
    setMsg('✓ pointing set from ' + obj.name);
  }

  function presetActions() {
    return [
      ['zenith', 'Zenith', () => applyAltAz(0, 90)],
      ['sun', 'Sun', () => {
        const s = F.sunJ2000(SAT.clock.getDate());
        applyRaDec(s.raDeg, s.decDeg);
      }],
      ['moon', 'Moon', () => {
        const m = F.moonJ2000(SAT.clock.getDate());
        applyRaDec(m.raDeg, m.decDeg);
      }],
      ['antisun', 'Anti-sun', () => {
        // where the Earth's shadow is: the field most likely to be full of
        // eclipsed, and therefore invisible, objects
        const s = F.sunJ2000(SAT.clock.getDate());
        applyRaDec(s.raDeg + 180, -s.decDeg);
      }],
      ['sel', 'Selected', fromSelection],
    ];
  }

  // ---- build ---------------------------------------------------------------

  function buildSites() {
    if (!ui) return;
    const active = SAT.state.activeLocation();
    clear(ui.siteSel);
    if (!SAT.state.locations.length) {
      ui.siteSel.appendChild(U.el('option', { value: '' }, '— no sites —'));
    }
    SAT.state.locations.forEach(l => {
      ui.siteSel.appendChild(U.el('option', { value: l.id }, l.name));
    });
    ui.siteSel.value = active ? active.id : '';
  }

  /** One coordinate row's fields: sexagesimal and decimal degrees, both editable,
   *  both committing the same obs value. refresh() repaints both from state. */
  function makeCoord(el, id, cfg) {
    const sexIn = guardEdits(el('input', {
      class: 'input pnt-wide', id: id, title: cfg.sexTitle,
    }));
    sexIn.addEventListener('change', () => {
      const v = cfg.parseSex(sexIn.value);
      if (v == null) { reject(sexIn, cfg.sexErr); refresh(); return; }
      cfg.commit(v);
      setMsg('');
      refresh();
    });
    const decIn = guardEdits(el('input', {
      class: 'input pnt-dnum', id: id + '-d', title: cfg.decTitle,
    }));
    decIn.addEventListener('change', () => {
      const v = cfg.parseDec(decIn.value);
      if (v == null) { reject(decIn, cfg.decErr); refresh(); return; }
      cfg.commit(v);
      setMsg('');
      refresh();
    });
    return { sexIn: sexIn, decIn: decIn };
  }

  function init(body, win) {
    injectStyle();
    const el = U.el;

    // ---- site --------------------------------------------------------------
    const siteSel = el('select', { class: 'select', id: 'pnt-site' });
    siteSel.addEventListener('change', () => {
      const id = siteSel.value;
      SAT.state.locations.forEach(l => { l.active = (l.id === id); });
      SAT.state.save();
      SAT.bus.emit('locations-changed', {});
      setMsg('');
      refresh();
    });
    const siteInfo = el('span', { class: 'pnt-echo', id: 'pnt-siteinfo' }, '');
    const locBtn = el('button', {
      class: 'btn small', title: 'open the Locations window',
      onclick: () => {
        const w = SAT.windows && SAT.windows.get('locations');
        if (w) w.open(); else setMsg('Locations window is not registered', true);
      },
    }, 'Locations…');

    // ---- start + span ------------------------------------------------------
    const epochIn = guardEdits(el('input', {
      class: 'input pnt-time', id: 'pnt-epoch', spellcheck: 'false',
      title: 'UTC start of the scan window — this is the master simulation clock',
    }));
    epochIn.addEventListener('change', () => {
      const d = parseEpoch(epochIn.value);
      if (!d) { reject(epochIn, 'start must be YYYY-MM-DD HH:MM:SS (UTC)'); refresh(); return; }
      SAT.clock.setDate(d);
      setMsg('');
      refresh();
    });
    const nowBtn = el('button', {
      class: 'btn small', id: 'pnt-now', title: 'jump the clock to the real current time',
      onclick: () => { SAT.clock.syncNow(); setMsg(''); refresh(); },
    }, '⦿ Now');

    const spanIn = guardEdits(el('input', { class: 'input pnt-num', id: 'pnt-span' }));
    spanIn.addEventListener('change', () => {
      const v = parseNum(spanIn.value, 0.1, 7 * 1440);
      if (v == null) { reject(spanIn, 'timespan must be 0.1…10080 minutes'); refresh(); return; }
      SAT.state.setObs({ spanMin: v });
      setMsg('');
      refresh();
    });
    const spanChips = SPAN_CHIPS.map(([lbl, m]) => ({
      min: m,
      btn: el('button', {
        class: 'btn small pnt-tog', id: 'pnt-span-' + m,
        onclick: () => { SAT.state.setObs({ spanMin: m }); setMsg(''); refresh(); },
      }, lbl),
    }));

    // ---- pointing ----------------------------------------------------------
    const modeBtns = [['radec', 'RA/Dec'], ['altaz', 'Alt/Az']].map(([m, lbl]) => ({
      mode: m,
      btn: el('button', {
        class: 'btn small pnt-tog', id: 'pnt-mode-' + m, onclick: () => setMode(m),
      }, lbl),
    }));
    const trackBtns = [['sky', 'Sky'], ['mount', 'Mount']].map(([t, lbl]) => ({
      track: t,
      btn: el('button', {
        class: 'btn small pnt-tog', id: 'pnt-track-' + t,
        title: t === 'sky' ? 'field fixed on the celestial sphere (sidereal tracking)'
          : 'field fixed in alt/az (parked mount / drift scan)',
        onclick: () => { SAT.state.setObs({ track: t }); refresh(); },
      }, lbl),
    }));

    const ra = makeCoord(el, 'pnt-ra', {
      sexTitle: 'hh mm ss.s · hh:mm:ss · 5h35m17.3s · or bare decimal DEGREES',
      sexErr: 'RA: use hh mm ss, hh:mm:ss or decimal degrees',
      decTitle: 'RA in decimal degrees, J2000',
      decErr: 'RA: decimal degrees, e.g. 83.822',
      parseSex: parseRaField, parseDec: parseDecimalWrap,
      commit: v => applyRaDec(v, SAT.state.obs.decDeg),
    });
    const dec = makeCoord(el, 'pnt-dec', {
      sexTitle: '±dd mm ss · ±dd:mm:ss · or bare decimal degrees',
      sexErr: 'Dec: use ±dd mm ss or decimal degrees, −90…90',
      decTitle: 'Dec in decimal degrees, J2000',
      decErr: 'Dec: decimal degrees, −90…90',
      parseSex: parseDecField, parseDec: parseDecimalLat,
      commit: v => applyRaDec(SAT.state.obs.raDeg, v),
    });
    const az = makeCoord(el, 'pnt-az', {
      sexTitle: 'ddd mm ss or decimal degrees, north through east',
      sexErr: 'Az: use ddd mm ss or decimal degrees',
      decTitle: 'azimuth in decimal degrees, north through east',
      decErr: 'Az: decimal degrees',
      parseSex: parseAzField, parseDec: parseDecimalWrap,
      commit: v => applyAltAz(v, SAT.state.obs.elDeg),
    });
    const elc = makeCoord(el, 'pnt-el', {
      sexTitle: '±dd mm ss or decimal degrees above the horizon',
      sexErr: 'El: use ±dd mm ss or decimal degrees, −90…90',
      decTitle: 'elevation in decimal degrees',
      decErr: 'El: decimal degrees, −90…90',
      parseSex: parseDecField, parseDec: parseDecimalLat,
      commit: v => applyAltAz(SAT.state.obs.azDeg, v),
    });
    const elNote = el('span', { class: 'pnt-echo', id: 'pnt-el-note' }, '');

    const presetBtns = presetActions().map(([key, lbl, fn]) => ({
      key: key,
      btn: el('button', {
        class: 'btn small', id: 'pnt-preset-' + key,
        onclick: () => { fn(); refresh(); },
      }, lbl),
    }));

    // ---- field of view -----------------------------------------------------
    const shapeBtns = [['rect', 'Rect'], ['circ', 'Circ']].map(([s, lbl]) => ({
      shape: s,
      btn: el('button', {
        class: 'btn small pnt-tog', id: 'pnt-shape-' + s,
        onclick: () => { SAT.state.setObs({ fovShape: s }); refresh(); },
      }, lbl),
    }));
    // Units are a display choice only: switching them must never rewrite obs, or a
    // user flicking between ° and ′ would quietly round their field size away.
    const unitBtns = [['deg', '°'], ['min', '′']].map(([u, lbl]) => ({
      unit: u,
      btn: el('button', {
        class: 'btn small pnt-tog', id: 'pnt-unit-' + u,
        title: u === 'deg' ? 'show field size in degrees' : 'show field size in arcminutes',
        onclick: () => { fovUnit = u; refresh(); },
      }, lbl),
    }));

    const fovField = (id, key, hi) => {
      const inp = guardEdits(el('input', { class: 'input pnt-num', id: id }));
      inp.addEventListener('change', () => {
        const v = parseNum(inp.value, (1 / 3600) * uFac(), hi * uFac());
        if (v == null) {
          reject(inp, 'field size must be ' + trim((1 / 3600) * uFac(), 6) + '…' + (hi * uFac()) + uSym());
          refresh();
          return;
        }
        const patch = {};
        patch[key] = v / uFac();
        SAT.state.setObs(patch);
        setMsg('');
        refresh();
      });
      return inp;
    };
    const wIn = fovField('pnt-fovw', 'fovWDeg', 180);
    const hIn = fovField('pnt-fovh', 'fovHDeg', 180);
    const rIn = fovField('pnt-fovr', 'fovRDeg', 90);
    const fovTimes = el('span', { class: 'pnt-echo' }, '×');
    const fovRLbl = el('span', { class: 'pnt-echo' }, 'r =');
    const fovEcho = el('span', { class: 'pnt-echo', id: 'pnt-fov-echo' }, '');

    const rotIn = guardEdits(el('input', { class: 'input pnt-num', id: 'pnt-rot' }));
    rotIn.addEventListener('change', () => {
      const v = parseNum(rotIn.value, -360, 360);
      if (v == null) { reject(rotIn, 'rotation must be −360…360 degrees'); refresh(); return; }
      SAT.state.setObs({ rotDeg: v });
      setMsg('');
      refresh();
    });
    const flipIn = el('input', { type: 'checkbox', id: 'pnt-flip' });
    flipIn.addEventListener('change', () => {
      SAT.state.setObs({ flipEW: !!flipIn.checked });
      refresh();
    });

    // width capped so the Camera line stays as short as the coordinate rows
    // (round-7 review); the select ellipsises long preset names itself
    const camSel = el('select', {
      class: 'select', id: 'pnt-cam',
      style: 'width:calc(11ch + 18px);max-width:calc(11ch + 18px)',
    });
    camSel.addEventListener('change', () => {
      const c = cameraByKey(camSel.value);
      if (!c) return;
      // FOV only: a legacy preset's plate-scale key is deliberately not read
      // (plate scale left the data model in review round 1)
      SAT.state.setObs({ fovShape: 'rect', fovWDeg: c.wDeg, fovHDeg: c.hDeg });
      setMsg('✓ ' + c.name);
      refresh();
    });
    const camName = el('input', {
      class: 'input', id: 'pnt-camname', placeholder: 'name', style: 'width:calc(9ch + 18px)',
    });
    const camSave = el('button', {
      class: 'btn small', id: 'pnt-camsave', title: 'save the current FOV as a preset',
      onclick: saveCamera,
    }, '+ Save');
    const camDel = el('button', {
      class: 'btn small danger', id: 'pnt-camdel', title: 'delete the selected user preset',
      onclick: deleteCamera,
    }, '✕');

    const msg = el('div', { class: 'pnt-msg', id: 'pnt-msg' }, '');

    // ---- layout ------------------------------------------------------------
    // One row per line, no section-header lines (round-1 review): groups are
    // separated by a hairline instead of a heading that costs a text line.
    const row = children => el('div', { class: 'row' }, children);
    const gap = () => el('div', { class: 'pnt-gap' });
    const lbl = t => el('span', { class: 'pnt-lbl' }, t);
    const dsym = () => el('span', { class: 'pnt-echo' }, '°');

    body.appendChild(el('div', { class: 'pnt-root' }, [
      row([lbl('Site'), siteSel, locBtn, siteInfo]),
      row([lbl('Start'), epochIn, nowBtn, el('span', { class: 'pnt-echo' }, 'UTC')]),
      row([lbl('Span'), spanIn, el('span', { class: 'pnt-echo' }, 'min')]
        .concat(spanChips.map(c => c.btn))),
      gap(),
      row([lbl('Mode')].concat(modeBtns.map(m => m.btn))
        .concat([el('span', { class: 'pnt-echo' }, '· track')])
        .concat(trackBtns.map(t => t.btn))),
      row([lbl('RA'), ra.sexIn, ra.decIn, dsym()]),
      row([lbl('Dec'), dec.sexIn, dec.decIn, dsym()]),
      row([lbl('Az'), az.sexIn, az.decIn, dsym()]),
      row([lbl('El'), elc.sexIn, elc.decIn, dsym(), elNote]),
      row([lbl('Preset')].concat(presetBtns.map(p => p.btn))),
      gap(),
      row([lbl('FOV')].concat(shapeBtns.map(s => s.btn))
        .concat([wIn, fovTimes, hIn, fovRLbl, rIn])
        .concat(unitBtns.map(u => u.btn))),
      row([lbl('Rot'), rotIn, el('span', { class: 'pnt-echo' }, '°'),
        el('label', { class: 'chk' }, [flipIn, ' flip E/W']), fovEcho]),
      row([lbl('Camera'), camSel, camName, camSave, camDel]),
      msg,
    ]));

    ui = {
      win: win,
      siteSel, siteInfo, epochIn, spanIn, spanChips,
      modeBtns, trackBtns,
      ra, dec, az, elc, elNote, presetBtns,
      shapeBtns, unitBtns, wIn, hIn, rIn, fovTimes, fovRLbl, fovEcho,
      rotIn, flipIn,
      camSel, camName, camSave, camDel,
      msg,
    };

    buildSites();
    buildCameras('');

    SAT.bus.on('state-loaded', () => { buildSites(); buildCameras(''); refresh(); });
    SAT.bus.on('locations-changed', () => { buildSites(); refresh(); });
    SAT.bus.on('obs-changed', refresh);
    SAT.bus.on('selection-changed', refresh);
    SAT.bus.on('time', onTime);

    refresh();
  }

  /** The clock ticks every animation frame; the readouts only change once a second,
   *  and the pointing readout costs a precession/nutation pass. One string compare
   *  keeps this window off the animation budget. */
  function onTime(p) {
    if (!ui) return;
    if (ui.win && ui.win.isOpen && !ui.win.isOpen()) return;
    const str = U.fmtDate(p.date);
    if (str === lastEpochStr) return;
    lastEpochStr = str;
    refresh();
  }

  // ---- refresh -------------------------------------------------------------

  function refresh() {
    if (!ui) return;
    const o = SAT.state.obs;
    const loc = SAT.state.activeLocation();

    // site
    const wantSite = loc ? loc.id : '';
    if (ui.siteSel.value !== wantSite) ui.siteSel.value = wantSite;
    ui.siteInfo.textContent = loc
      ? loc.latDeg.toFixed(4) + '°N ' + loc.lonDeg.toFixed(4) + '°E ' +
        Math.round(loc.altM || 0) + ' m'
      : 'no active site — Alt/Az and the scan are unavailable';

    // start + span
    setVal(ui.epochIn, U.fmtDate(SAT.clock.getDate()));
    setVal(ui.spanIn, trim(o.spanMin, 3));
    ui.spanChips.forEach(c => c.btn.classList.toggle('on', Math.abs(o.spanMin - c.min) < 1e-9));

    // pointing
    const radec = o.mode === 'radec';
    ui.modeBtns.forEach(m => m.btn.classList.toggle('on', m.mode === o.mode));
    ui.trackBtns.forEach(t => t.btn.classList.toggle('on', t.track === o.track));

    const s = solve();
    const setPair = (pair, disabled, sexV, decV) => {
      pair.sexIn.disabled = disabled;
      pair.decIn.disabled = disabled;
      setVal(pair.sexIn, sexV);
      setVal(pair.decIn, decV);
    };
    // both notations, always, in both editable fields — the parsers are lenient
    // about which one was typed, so the repaint is how the user sees which
    // reading was taken
    setPair(ui.ra, !radec, U.fmtRA(s.raDeg), s.raDeg.toFixed(4));
    setPair(ui.dec, !radec, U.fmtDec(s.decDeg), s.decDeg.toFixed(4));
    if (s.aa) {
      setPair(ui.az, radec, fmtAz(s.aa.azDeg), s.aa.azDeg.toFixed(4));
      setPair(ui.elc, radec, U.fmtDec(s.aa.elDeg), s.aa.elDeg.toFixed(4));
      ui.elNote.textContent = 'apparent';
    } else {
      setPair(ui.az, true, '—', '—');
      setPair(ui.elc, true, '—', '—');
      ui.elNote.textContent = 'needs an active site';
    }
    const selBtn = ui.presetBtns.find(p => p.key === 'sel');
    if (selBtn) selBtn.btn.disabled = !(SAT.state.selection && SAT.state.selection.satId);

    // field of view: rect shows W x H, circle shows the radius — swapping rather
    // than stacking three inputs keeps the group to one line
    const rect = o.fovShape === 'rect';
    ui.shapeBtns.forEach(b => b.btn.classList.toggle('on', b.shape === o.fovShape));
    ui.unitBtns.forEach(b => b.btn.classList.toggle('on', b.unit === fovUnit));
    setVal(ui.wIn, trim(o.fovWDeg * uFac()));
    setVal(ui.hIn, trim(o.fovHDeg * uFac()));
    setVal(ui.rIn, trim(o.fovRDeg * uFac()));
    ui.wIn.style.display = rect ? '' : 'none';
    ui.fovTimes.style.display = rect ? '' : 'none';
    ui.hIn.style.display = rect ? '' : 'none';
    ui.fovRLbl.style.display = rect ? 'none' : '';
    ui.rIn.style.display = rect ? 'none' : '';
    ui.fovEcho.textContent = '· encl ' + U.fmtAngle(SAT.state.fovRadiusDeg(), 2);
    setVal(ui.rotIn, trim(o.rotDeg, 3));
    ui.flipIn.checked = !!o.flipEW;

  }

  SAT.ui.pointing = { init, refresh };
})();
