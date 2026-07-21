/* SAT.ui.crossings — the crossing list: scan control, filters, sortable table.
 *
 * This is the answer window: everything else in the app exists to fill this table.
 * Three rules shape it.
 *
 * 1. Scanning and filtering are different things. The Scan button is the ONLY path
 *    that calls SAT.scan.run(); every filter control writes SAT.state.filters and
 *    emits 'filters-changed'. Re-running a 27k-object scan because someone dragged a
 *    magnitude slider would make the filters unusable, so the two are kept apart and
 *    the stale tag tells the user when the *parameters* (not the filters) moved.
 * 2. A cull this aggressive has to be visible. The summary line reports the per-stage
 *    counts, because "0 crossings" after a 90% geometric cull looks identical to a
 *    broken cull unless the numbers are on screen.
 * 3. Nothing is silently dropped. Truncation gets a banner, the render cap gets a
 *    "showing first N of M" line, and a magnitude derived from the 1-metre-sphere
 *    fallback is printed with a tilde — presenting that assumption as a measured
 *    magnitude is how a misidentification happens.
 * 4. Every rate says which frame it is in. Rate/PA follow SAT.state.obs.track and
 *    carry "(sky)" or "(mount)" in the header, because a GEO object moves at ~15″/s
 *    against the stars and ~0″/s against the horizon, and matching a measured trail
 *    requires knowing which frame the instrument was tracking in.
 */
(function () {
  'use strict';

  const U = SAT.util;
  const STYLE_ID = 'xin-style';

  // Rows are built as real DOM; 5000 of them at ~19 cells each is 95k nodes and a
  // visibly janky window. Cap and say so — a silent truncation would be a lie about
  // the scan result, which is the one thing this table must never tell.
  const RENDER_CAP = 400;

  const CLS_COLOR = { leo: '#4fc3f7', meo: '#7ad97a', geo: '#ffb84f', heo: '#c792ea' };
  const CLS_ORDER = ['leo', 'meo', 'geo', 'heo'];
  // Object-type palette: same chip treatment as the orbit classes but distinct
  // hues, so a row reading "leo · debris" is two colours, not one repeated.
  // Palette lives in SAT.state.typeColorOf (user-editable, round 6); this is only
  // a resolver so cells and chips repaint with whatever the user picked.
  const typeColour = k => (SAT.state.typeColorOf ? SAT.state.typeColorOf(k) : '#90a4ae');
  const TYPE_KEYS = ['PAY', 'R/B', 'DEB', 'UNK'];
  const typeOf = c => (c.type === 'PAY' || c.type === 'R/B' || c.type === 'DEB') ? c.type : 'UNK';

  let inst = null;              // the one live instance; refresh() drives it

  // ---- formatting ----------------------------------------------------------

  /** 27843 -> "27 843" (thin spaces). Six-figure catalogue counts are unreadable raw. */
  const grp = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  const isNum = v => typeof v === 'number' && isFinite(v);

  const fmtT = ms => (isNum(ms) ? U.fmtDate(new Date(ms)) : '—');
  /** CA and Exit print as HH:MM:SS only: a crossing of a telescope-sized field lasts
   *  seconds to minutes, so the date is always Enter's date and repeating it three
   *  times per row costs 20 characters of width for nothing. Full value in the title. */
  const fmtHms = ms => (isNum(ms) ? U.fmtDate(new Date(ms)).slice(11) : '—');

  const fmtKm = v => (!isNum(v) ? '—' : (v >= 10000 ? String(Math.round(v)) : v.toFixed(1)));
  const fixed = (v, d) => (isNum(v) ? v.toFixed(d) : '—');

  /** The photometry method that produced magEst. SAT.photo.magnitude() returns it as
   *  `method`; the scan writes it onto the Crossing as `magMethod`. Accept either
   *  rather than render a blank Method column if the field is renamed upstream. */
  const magMethod = c => c.magMethod || c.method || null;

  function magText(c) {
    if (!isNum(c.magEst)) return '—';
    const m = c.magEst.toFixed(1);
    // 'default' means "assume a 1 m diffuse sphere" — a guess with no measurement
    // behind it. The tilde is the only thing distinguishing it from a qsmag-derived
    // prediction, and identifying a trail off an unmarked guess is exactly the
    // failure mode this tool exists to prevent.
    return magMethod(c) === 'default' ? '~' + m : m;
  }

  // ---- the two angular rates ------------------------------------------------
  // A Crossing carries motion against the STARS (rateAsPerS/paDeg) and against the
  // HORIZON (rateMountAsPerS/paMountDeg). Which one matches a measured trail depends
  // on how the instrument was tracking, and for a GEO object the two differ by
  // everything: ~15″/s sidereal versus ~0″/s on a parked mount. So the primary
  // Rate/PA columns follow SAT.state.obs.track and say in the header which frame
  // they are; the other frame is available as its own columns.

  const trackMount = () => !!(SAT.state.obs && SAT.state.obs.track === 'mount');
  const frameTag = () => (trackMount() ? 'mount' : 'sky');
  const altTag = () => (trackMount() ? 'sky' : 'mount');

  const skyRate = c => (isNum(c.rateAsPerS) ? c.rateAsPerS : null);
  const skyPa = c => (isNum(c.paDeg) ? c.paDeg : null);
  // null, not a silent fallback to the sidereal value: a blank cell under a
  // "(mount)" header is a missing number, whereas the sky rate printed there would
  // be a confidently wrong one
  const mountRate = c => (isNum(c.rateMountAsPerS) ? c.rateMountAsPerS : null);
  const mountPa = c => (isNum(c.paMountDeg) ? c.paMountDeg : null);

  const primRate = c => (trackMount() ? mountRate(c) : skyRate(c));
  const altRate = c => (trackMount() ? skyRate(c) : mountRate(c));
  const primPa = c => (trackMount() ? mountPa(c) : skyPa(c));
  const altPa = c => (trackMount() ? skyPa(c) : mountPa(c));

  const rateText = get => c => {
    const v = get(c);
    return v == null ? '—' : v.toFixed(1);
  };
  const paText = get => c => {
    const v = get(c);
    return v == null ? '—' : v.toFixed(1) + '°';
  };

  const SHADOW_TEXT = { none: 'sunlit', penumbra: 'penumbra', umbra: 'umbra' };
  const SHADOW_MARK = { none: '●', penumbra: '◐', umbra: '✕' };
  const shadowOf = c => (c.shadow || (c.sunlit === false ? 'umbra' : 'none'));

  // ---- columns -------------------------------------------------------------
  // `val` is the sort key and MAY be null (missing magnitude, failed photometry);
  // the comparator puts nulls last in both directions. `text` is what the cell, the
  // TSV copy and the CSV export all show — one definition, so they cannot disagree.

  const COLS = [
    { key: 'name', label: 'Name', def: true,
      val: c => c.name || '', text: c => c.name || ('OBJECT ' + c.norad) },
    { key: 'norad', label: 'NORAD', def: true, num: true,
      val: c => c.norad, text: c => String(c.norad) },
    { key: 'intl', label: 'Int’l', def: true, num: true,
      val: c => c.intl || '', text: c => c.intl || '—' },
    { key: 'type', label: 'Type', def: true,
      val: c => TYPE_KEYS.indexOf(typeOf(c)),
      text: c => typeOf(c).toLowerCase(), cell: typeCell },
    { key: 'cls', label: 'Class', def: true,
      val: c => CLS_ORDER.indexOf(c.cls), text: c => c.cls || '—', cell: clsCell },
    { key: 'enter', label: 'Enter (UTC)', def: true, num: true,
      val: c => c.tEnterMs, text: c => fmtT(c.tEnterMs) },
    { key: 'ca', label: 'CA (UTC)', def: true, num: true,
      val: c => c.tCaMs, text: c => fmtHms(c.tCaMs), title: c => fmtT(c.tCaMs) },
    { key: 'exit', label: 'Exit', def: true, num: true,
      val: c => c.tExitMs, text: c => fmtHms(c.tExitMs), title: c => fmtT(c.tExitMs) },
    { key: 'dur', label: 'Dur', def: true, num: true,
      val: c => (isNum(c.tExitMs) && isNum(c.tEnterMs) ? c.tExitMs - c.tEnterMs : null),
      text: c => (isNum(c.tExitMs) && isNum(c.tEnterMs) ? U.fmtDur(c.tExitMs - c.tEnterMs) : '—') },
    { key: 'sep', label: 'Sep@CA', def: true, num: true,
      val: c => c.sepCaDeg, text: c => (isNum(c.sepCaDeg) ? U.fmtAngle(c.sepCaDeg, 1) : '—') },
    { key: 'radec', label: 'RA/Dec (J2000)', def: true, num: true,
      val: c => c.raDeg,
      text: c => (isNum(c.raDeg) && isNum(c.decDeg)
        ? U.fmtRA(c.raDeg, 1) + '  ' + U.fmtDec(c.decDeg, 0) : '—') },
    { key: 'az', label: 'Az', def: false, num: true,
      val: c => c.azDeg, text: c => fixed(c.azDeg, 1) + (isNum(c.azDeg) ? '°' : '') },
    { key: 'el', label: 'El', def: true, num: true,
      val: c => c.elDeg, text: c => fixed(c.elDeg, 1) + (isNum(c.elDeg) ? '°' : '') },
    { key: 'alt', label: 'Alt km', def: true, num: true,
      val: c => (isNum(c.altKm) ? c.altKm : null),
      text: c => fmtKm(c.altKm),
      // same number the altitude filter tests — geodetic height at closest approach
      title: () => 'geodetic height at closest approach' },
    { key: 'range', label: 'Range km', def: true, num: true,
      val: c => c.rangeKm, text: c => fmtKm(c.rangeKm) },
    { key: 'rate', label: () => 'Rate ″/s (' + frameTag() + ')', def: true, num: true,
      val: primRate, text: rateText(primRate),
      hint: () => (trackMount()
        ? 'motion against the horizon, d(alt,az)/dt — the mount is parked (obs.track = "mount")'
        : 'motion against the stars, d(RA,Dec)/dt — sidereal guiding (obs.track = "sky")') },
    { key: 'pa', label: () => 'PA (' + frameTag() + ')', def: false, num: true,
      val: primPa, text: paText(primPa),
      hint: () => 'position angle of the ' + frameTag() + '-frame motion, north through east' },
    { key: 'rateAlt', label: () => 'Rate ″/s (' + altTag() + ')', def: false, num: true,
      val: altRate, text: rateText(altRate),
      hint: () => (trackMount()
        ? 'the other frame: motion against the stars, d(RA,Dec)/dt'
        : 'the other frame: motion against the horizon, d(alt,az)/dt') },
    { key: 'paAlt', label: () => 'PA (' + altTag() + ')', def: false, num: true,
      val: altPa, text: paText(altPa),
      hint: () => 'position angle of the ' + altTag() + '-frame motion' },
    { key: 'mag', label: 'Mag', def: true, num: true,
      val: c => (isNum(c.magEst) ? c.magEst : null), text: magText, cell: magCell },
    { key: 'method', label: 'Method', def: false,
      val: c => magMethod(c) || '', text: c => magMethod(c) || '—' },
    { key: 'sunlit', label: 'Sunlit', def: true,
      val: c => ['none', 'penumbra', 'umbra'].indexOf(shadowOf(c)),
      text: c => SHADOW_TEXT[shadowOf(c)] || '—', cell: sunlitCell },
    { key: 'age', label: 'TLE age', def: true, num: true,
      val: c => (isNum(c.tleAgeDays) ? c.tleAgeDays : null),
      text: c => (isNum(c.tleAgeDays)
        ? (c.tleAgeDays < 10 ? c.tleAgeDays.toFixed(1) : String(Math.round(c.tleAgeDays))) + ' d'
        : '—'),
      cell: ageCell,
      hint: 'age of the elements this position came from — the per-row confidence ' +
        'number: TLE error, not frame handling, dominates the accuracy budget' },
  ];

  const colByKey = key => COLS.find(c => c.key === key) || null;
  /** Labels are functions where they depend on obs.track, so the header can never
   *  claim a frame the cells are not in. */
  const labelOf = col => (typeof col.label === 'function' ? col.label() : col.label);
  const hintOf = col => (typeof col.hint === 'function' ? col.hint() : col.hint || '');

  function clsCell(c, col) {
    const k = c.cls || '';
    return U.el('td', {}, U.el('span', {
      class: 'xin-chip on',
      style: 'background:' + (CLS_COLOR[k] || 'var(--bg3)') + ';border-color:transparent',
    }, col.text(c)));
  }

  function typeCell(c, col) {
    const k = typeOf(c);
    return U.el('td', {}, U.el('span', {
      class: 'xin-chip on',
      style: 'background:' + typeColour(k) + ';border-color:transparent',
      title: c.type ? 'SATCAT object type' : 'no SATCAT type on record',
    }, col.text(c)));
  }

  function magCell(c, col) {
    const guess = magMethod(c) === 'default';
    return U.el('td', {
      class: 'num' + (guess ? ' xin-guess' : ''),
      title: !isNum(c.magEst)
        ? 'eclipsed or no photometry at closest approach'
        : (guess
          ? 'guess: no qsmag and no RCS for this object, so a 1 m diffuse sphere was assumed'
          : 'from ' + (magMethod(c) || 'photometry')),
    }, col.text(c));
  }

  function sunlitCell(c, col) {
    const s = shadowOf(c);
    return U.el('td', {
      title: SHADOW_TEXT[s] || '',
      style: s === 'none' ? 'color:var(--ok)' : 'color:var(--fg-dim)',
    }, SHADOW_MARK[s] || '—');
  }

  /** Elements a week old on LEO mean kilometres of along-track error — the scan
   *  widens its search box (tleSlopDeg) to still catch the object, so a hit from an
   *  old TLE is a wider, weaker claim. Amber past 7 days for exactly that reason;
   *  the tooltip carries the slop the scan actually applied when it is available. */
  function ageCell(c, col) {
    const old = isNum(c.tleAgeDays) && c.tleAgeDays > 7;
    return U.el('td', {
      class: 'num' + (old ? ' xin-old' : ''),
      title: (old ? 'elements over a week old — position is a loose box, not a point; '
        + 'treat a match here as a candidate, not an identification'
        : 'age of the TLE behind this row')
        + (isNum(c.tleSlopDeg)
          ? '. Search slop applied: ±' + U.fmtAngle(c.tleSlopDeg, 1) : ''),
    }, col.text(c));
  }

  // ---- sorting -------------------------------------------------------------

  /** Compare on `col.val`, nulls always last.
   *
   * This is the classic bug in this table: a satellite in Earth's shadow has
   * magEst === null, and `a.magEst - b.magEst` turns that into NaN (sorts nowhere)
   * or, after a `|| 0`, into the brightest object in the list. Eclipsed objects must
   * sink to the bottom whichever way the arrow points, so the null test is applied
   * BEFORE the direction is. */
  function makeCmp(col, asc) {
    const dir = asc ? 1 : -1;
    return (a, b) => {
      const va = col.val(a), vb = col.val(b);
      const na = va == null || va === '' || (typeof va === 'number' && !isFinite(va));
      const nb = vb == null || vb === '' || (typeof vb === 'number' && !isFinite(vb));
      if (na && nb) return (a.tCaMs || 0) - (b.tCaMs || 0);
      if (na) return 1;
      if (nb) return -1;
      let d = (typeof va === 'string' || typeof vb === 'string')
        ? String(va).localeCompare(String(vb))
        : va - vb;
      if (d === 0) return (a.tCaMs || 0) - (b.tCaMs || 0);   // stable, chronological
      return dir * d;
    };
  }

  // ---- export --------------------------------------------------------------

  /** RFC-4180: quote when the cell holds a delimiter, a quote or a newline, and
   *  double the quotes inside. Satellite names really do contain both — Space-Track
   *  carries entries like `SL-16 R/B "DEB", 1` — and an unquoted comma silently
   *  shifts every later column of that row by one. */
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const tsvCell = v => (v == null ? '' : String(v)).replace(/[\t\r\n]+/g, ' ');

  function stamp() {
    const s = U.fmtDate(new Date());
    return s.slice(0, 10).replace(/-/g, '') + '-' + s.slice(11).replace(/:/g, '');
  }

  function download(name, mime, text) {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = U.el('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // revoked late: Safari cancels the download if the object URL dies first
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      console.warn('crossings: export failed', e);
    }
  }

  const saveState = () => { if (SAT.state && SAT.state.save) SAT.state.save(); };

  // ---- style ---------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.xin-root{display:flex;flex-direction:column;height:100%;font-size:12px;}',
      '.xin-head{flex:0 0 auto;padding:6px 8px;background:var(--bg2);',
      '  border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:5px;',
      '  position:relative;}',
      '.xin-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.xin-lbl{color:var(--fg-dim);white-space:nowrap;}',
      '.xin-mini{width:56px;padding:2px 4px;}',
      '.xin-search{flex:1 1 110px;min-width:90px;}',
      '.xin-prog{flex:1 1 90px;min-width:60px;height:6px;background:var(--bg3);',
      '  border:1px solid var(--border);border-radius:3px;overflow:hidden;}',
      '.xin-prog-fill{height:100%;width:0;background:var(--accent);}',
      '.xin-prog-txt{font-family:var(--mono);font-size:11px;color:var(--fg-dim);white-space:nowrap;}',
      '.xin-summary{font-size:11px;color:var(--fg-dim);font-variant-numeric:tabular-nums;}',
      '.xin-stale{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--warn);',
      '  color:#101418;font-weight:600;white-space:nowrap;}',
      '.xin-chip{cursor:pointer;font-size:10px;padding:1px 7px;border-radius:8px;',
      '  border:1px solid var(--border);background:var(--bg3);color:var(--fg-dim);',
      '  user-select:none;white-space:nowrap;}',
      '.xin-chip.on{color:#101418;font-weight:600;}',
      '.xin-chip.off{opacity:.55;text-decoration:line-through;}',
      '.xin-fbox{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);' +
        'border-radius:5px;padding:2px 7px;background:rgba(255,255,255,0.02);}',
      '.xin-pick{width:1%;text-align:center;padding:2px 4px !important;cursor:pointer;}',
      '.xin-pick input{accent-color:var(--accent);cursor:pointer;}',
      '.xin-wrap{flex:1 1 auto;overflow:auto;position:relative;}',
      '.xin-wrap thead th{position:sticky;top:0;z-index:2;background:var(--bg3);}',
      '.xin-th{cursor:pointer;user-select:none;white-space:nowrap;}',
      '.xin-th:hover{color:var(--fg);}',
      '.xin-row{cursor:pointer;}',
      '.xin-row.hov{background:rgba(79,195,247,.10);}',
      '.xin-guess{color:var(--fg-dim);font-style:italic;}',
      '.xin-old{color:var(--warn);}',
      '.xin-foot{flex:0 0 auto;padding:4px 8px;background:var(--bg2);',
      '  border-top:1px solid var(--border);display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.xin-note{font-size:11px;color:var(--fg-dim);padding:4px 8px;}',
      '.xin-warn{font-size:11px;color:var(--warn);padding:4px 8px;}',
      '.xin-cols{position:absolute;top:100%;right:8px;z-index:60;background:var(--bg2);',
      '  border:1px solid var(--border);border-radius:4px;padding:6px 10px;display:none;',
      '  box-shadow:0 8px 24px rgba(0,0,0,.6);max-height:340px;overflow:auto;}',
      '.xin-cols label{display:flex;align-items:center;gap:6px;padding:1px 0;',
      '  white-space:nowrap;cursor:pointer;}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ---- init ----------------------------------------------------------------

  function init(bodyEl, win) {
    injectStyle();
    if (win) win.noScroll = true;

    const st = {
      body: bodyEl,
      sortKey: 'ca',
      sortAsc: true,
      lastScan: null,       // {count, ms, truncated} from the last 'scan-done'
      lastError: null,
      running: false,
      shown: 0,
      total: 0,
    };

    // ---- settings.columns ---------------------------------------------------
    // Stored as an ARRAY of visible keys, not a {key:bool} map. state.js merges a
    // saved settings section with Object.assign(state.settings[k], saved[k]), and its
    // default for `columns` is null — Object.assign(null, …) throws. Arrays take the
    // else branch and are assigned wholesale, so an array survives a reload.
    function visibleKeys() {
      const s = SAT.state.settings;
      if (!Array.isArray(s.columns) || !s.columns.length) {
        s.columns = COLS.filter(c => c.def).map(c => c.key);
      }
      // Migration: 'type' arrived in round 4 as a default column, but a saved
      // column set from an earlier session would silently hide it forever —
      // defaults only apply on first run. Slot it in front of 'cls' once
      // (columnsVer 1); a user who later unticks it stays unticked, because the
      // version stamp — not the column's absence — gates the splice.
      if ((s.columnsVer || 0) < 1) {
        if (s.columns.indexOf('type') < 0) {
          const at = s.columns.indexOf('cls');
          s.columns.splice(at < 0 ? s.columns.length : at, 0, 'type');
        }
        s.columnsVer = 1;
        SAT.state.save();
      }
      // v2 (round 7): Alt km before Range km
      if (s.columnsVer < 2) {
        if (s.columns.indexOf('alt') < 0) {
          const at = s.columns.indexOf('range');
          s.columns.splice(at < 0 ? s.columns.length : at, 0, 'alt');
        }
        s.columnsVer = 2;
        SAT.state.save();
      }
      return s.columns;
    }
    const isShown = key => visibleKeys().indexOf(key) >= 0;
    const rateFilterActive = () => {
      const f = SAT.state.filters;
      return f.minRateAsPerS > 0 || f.maxRateAsPerS > 0;
    };

    /** The columns to draw, in table order.
     *
     * SAT.state.visibleCrossings() filters on `rateAsPerS` — the SIDEREAL rate,
     * always. On a parked mount the Rate column is showing d(alt,az)/dt instead, so
     * a rate filter would be culling rows on a number that appears nowhere on
     * screen. While such a filter is set, force the sky-rate column in rather than
     * filter invisibly; it drops back out when the filter is cleared, and the
     * persisted column set is never touched. */
    function shownCols() {
      const keys = visibleKeys();
      const out = COLS.filter(c => keys.indexOf(c.key) >= 0);
      if (rateFilterActive() && trackMount()) {
        const alt = colByKey('rateAlt');
        if (out.indexOf(alt) < 0) {
          const at = out.indexOf(colByKey('rate'));
          out.splice(at < 0 ? out.length : at + 1, 0, alt);
        }
      }
      return out;
    }

    // ================= header =================
    const scanBtn = U.el('button', { class: 'btn primary', onclick: onScanClick }, 'Scan');
    const estEl = U.el('span', { class: 'xin-prog-txt' }, '');
    const progWrap = U.el('div', { class: 'xin-prog' });
    const progFill = U.el('div', { class: 'xin-prog-fill' });
    progWrap.appendChild(progFill);
    const progTxt = U.el('span', { class: 'xin-prog-txt' }, '');
    const staleTag = U.el('span', { class: 'xin-stale' }, 'parameters changed — rescan');
    const summaryEl = U.el('div', { class: 'xin-summary' }, '');
    progWrap.style.display = 'none';

    const colsBtn = U.el('button', {
      class: 'btn small', title: 'show / hide columns',
      onclick: () => {
        colsPanel.style.display = colsPanel.style.display === 'none' ? 'block' : 'none';
      },
    }, 'Columns ▾');
    const colsPanel = U.el('div', { class: 'xin-cols' });
    colsPanel.style.display = 'none';
    // rebuilt on obs-changed: the Rate/PA labels name the tracking frame, so
    // switching track has to relabel the checkboxes as well as the headers
    function renderColsPanel() {
      while (colsPanel.firstChild) colsPanel.removeChild(colsPanel.firstChild);
      COLS.forEach(col => {
        const cb = U.el('input', { type: 'checkbox', checked: isShown(col.key) });
        cb.addEventListener('change', () => {
          const keys = visibleKeys();
          const i = keys.indexOf(col.key);
          if (cb.checked && i < 0) keys.push(col.key);
          else if (!cb.checked && i >= 0) keys.splice(i, 1);
          // never let the table become headless — a column set of zero looks like a
          // crash, and there is no visible control left to undo it from
          if (!keys.length) { keys.push(col.key); cb.checked = true; }
          saveState();
          renderTable();
        });
        colsPanel.appendChild(U.el('label', { title: hintOf(col) }, [cb, labelOf(col)]));
      });
    }

    const headLine1 = U.el('div', { class: 'xin-line' },
      [scanBtn, estEl, progWrap, progTxt, staleTag, colsBtn]);

    // ================= filter row =================
    // Everything here writes SAT.state.filters and emits 'filters-changed'. Nothing
    // here calls SAT.scan.
    const magInput = U.el('input', { class: 'input xin-mini', type: 'number', step: '0.5',
      title: 'estimated visual magnitude limit; blank = no limit' });
    magInput.addEventListener('change', () => {
      const v = parseFloat(magInput.value);
      SAT.state.filters.maxMag = isFinite(v) ? v : 99;
      filtersChanged();
    });

    const sunChk = U.el('input', { type: 'checkbox' });
    sunChk.addEventListener('change', () => {
      SAT.state.filters.sunlitOnly = !!sunChk.checked;
      filtersChanged();
    });

    const clsChips = CLS_ORDER.map(k => {
      const chip = U.el('span', { class: 'xin-chip', title: k.toUpperCase() + ' objects' }, k);
      chip.addEventListener('click', () => {
        const f = SAT.state.filters;
        if (!f.classes) f.classes = {};
        f.classes[k] = f.classes[k] === false;
        filtersChanged();
      });
      return chip;
    });

    // The rate filter tests c.rateAsPerS, i.e. motion against the STARS, whatever
    // obs.track says — that is state.visibleCrossings()'s single filter point and it
    // is shared with the chart. Label it with the frame so it cannot be mistaken for
    // the mount rate, and shownCols() forces the matching column visible while it is set.
    const RATE_TIP = 'apparent rate against the stars (sidereal frame), arcsec/s; ' +
      '0 or blank = no limit. The Rate (sky) column is the one this filters.';
    const rateLbl = U.el('span', { class: 'xin-lbl', title: RATE_TIP }, 'rate ″/s (sky)');
    const rateMin = U.el('input', { class: 'input xin-mini', type: 'number', step: '10',
      title: 'minimum ' + RATE_TIP });
    const rateMax = U.el('input', { class: 'input xin-mini', type: 'number', step: '10',
      title: 'maximum ' + RATE_TIP });
    rateMin.addEventListener('change', () => {
      SAT.state.filters.minRateAsPerS = parseFloat(rateMin.value) || 0;
      filtersChanged();
    });
    rateMax.addEventListener('change', () => {
      SAT.state.filters.maxRateAsPerS = parseFloat(rateMax.value) || 0;
      filtersChanged();
    });

    // Second chip row: SATCAT object type. Objects with no type sit in 'unk', so
    // switching 'unk' off is an explicit act — it never silently hides the objects
    // we know least about, which are the interesting ones.
    const TYPE_ORDER = [['PAY', 'payload'], ['R/B', 'rocket body'], ['DEB', 'debris'], ['UNK', 'unknown']];
    const typeChips = TYPE_ORDER.map(([k, label]) => {
      const chip = U.el('span', { class: 'xin-chip',
        title: label + ' (SATCAT object type)' }, label);
      chip.addEventListener('click', () => {
        const f = SAT.state.filters;
        if (!f.types) f.types = { 'PAY': true, 'R/B': true, 'DEB': true, 'UNK': true };
        f.types[k] = f.types[k] === false;
        filtersChanged();
      });
      return chip;
    });

    // Altitude range: geodetic height at closest approach, km. 0/blank = no limit.
    const ALT_TIP = 'satellite height above the ellipsoid at closest approach, km; blank = no limit';
    const altMin = U.el('input', { class: 'input xin-mini', type: 'number', step: '100',
      title: 'minimum ' + ALT_TIP });
    const altMax = U.el('input', { class: 'input xin-mini', type: 'number', step: '100',
      title: 'maximum ' + ALT_TIP });
    altMin.addEventListener('change', () => {
      SAT.state.filters.minAltKm = parseFloat(altMin.value) || 0;
      filtersChanged();
    });
    altMax.addEventListener('change', () => {
      SAT.state.filters.maxAltKm = parseFloat(altMax.value) || 0;
      filtersChanged();
    });

    const searchInput = U.el('input', { class: 'input xin-search', placeholder: 'name / NORAD / int’l…' });
    searchInput.addEventListener('input', U.debounce(() => {
      SAT.state.filters.search = searchInput.value;
      filtersChanged();
    }, 150));

    // Layout fixed in review round 4: chips (class, then type, unlabelled) and the
    // search up front; the three numeric range filters at the back, each in its own
    // box frame so a min–max pair reads as one control rather than four orphans.
    const fbox = (title, children) => U.el('span', { class: 'xin-fbox', title: title }, children);
    const headLine2 = U.el('div', { class: 'xin-line' }, [
      U.el('label', { class: 'xin-lbl', style: 'display:flex;align-items:center;gap:4px;cursor:pointer' },
        [sunChk, 'sunlit only']),
      clsChips,
      typeChips,
      searchInput,
    ]);
    // Type-colour swatches (round 6): the palette is a preference, not a truth —
    // debris-vs-payload legibility depends on the user's screen and eyes. One
    // change repaints chips, table cells, sky chart and all-sky together, since
    // everything routes through SAT.state.typeColorOf.
    const typeSwatches = TYPE_ORDER.map(([k, label]) => {
      const inp = U.el('input', {
        type: 'color', class: 'swatch', title: label + ' colour — applies to the ' +
          'sky chart, all-sky view and this table at once',
      });
      inp.value = typeColour(k);
      inp.addEventListener('change', () => {
        if (!SAT.state.settings.typeColors) SAT.state.settings.typeColors = {};
        SAT.state.settings.typeColors[k] = inp.value;
        SAT.state.save();
        refreshFilters();
        renderTable();
        SAT.bus.emit('settings-changed', { section: 'typeColors' });
      });
      return inp;
    });
    const typeColorReset = U.el('button', {
      class: 'btn small', title: 'restore the default type colours',
      onclick: () => {
        SAT.state.settings.typeColors = SAT.state.typeColorDefaults
          ? SAT.state.typeColorDefaults() : {};
        SAT.state.save();
        TYPE_ORDER.forEach(([k], i) => { typeSwatches[i].value = typeColour(k); });
        refreshFilters();
        renderTable();
        SAT.bus.emit('settings-changed', { section: 'typeColors' });
      },
    }, '↺');

    const headLine3 = U.el('div', { class: 'xin-line' }, [
      fbox(ALT_TIP, [U.el('span', { class: 'xin-lbl' }, 'alt km'), altMin,
        U.el('span', { class: 'xin-lbl' }, '–'), altMax]),
      fbox('estimated visual magnitude limit; blank = no limit',
        [U.el('span', { class: 'xin-lbl' }, 'mag ≤'), magInput]),
      fbox(RATE_TIP, [rateLbl, rateMin,
        U.el('span', { class: 'xin-lbl' }, '–'), rateMax]),
      fbox('object-type colours', [U.el('span', { class: 'xin-lbl' }, 'colours')]
        .concat(typeSwatches).concat([typeColorReset])),
    ]);

    const headEl = U.el('div', { class: 'xin-head' },
      [headLine1, headLine2, headLine3, summaryEl, colsPanel]);

    // ================= table =================
    const thead = U.el('thead');
    const tbody = U.el('tbody');
    const table = U.el('table', { class: 'table' }, [thead, tbody]);
    const noticeEl = U.el('div', { class: 'xin-warn' }, '');
    const emptyEl = U.el('div', { class: 'msg-empty' }, '');
    const wrapEl = U.el('div', { class: 'xin-wrap' }, [noticeEl, emptyEl, table]);

    // ================= footer =================
    const countEl = U.el('span', { class: 'xin-summary' }, '');
    const capEl = U.el('span', { class: 'xin-warn' }, '');
    const copyBtn = U.el('button', { class: 'btn small', title: 'copy the visible table as TSV',
      onclick: doCopyTsv }, 'Copy TSV');
    const csvBtn = U.el('button', { class: 'btn small', title: 'download the filtered crossings as CSV',
      onclick: doCsv }, 'CSV');
    const jsonBtn = U.el('button', { class: 'btn small', title: 'download the filtered crossings as JSON',
      onclick: doJson }, 'JSON');
    const footEl = U.el('div', { class: 'xin-foot' },
      [countEl, capEl, U.el('span', { style: 'margin-left:auto' }), copyBtn, csvBtn, jsonBtn]);

    const root = U.el('div', { class: 'xin-root' }, [headEl, wrapEl, footEl]);
    bodyEl.appendChild(root);

    // ---- helpers -------------------------------------------------------------

    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    function filtersChanged() {
      saveState();
      SAT.bus.emit('filters-changed', {});   // the chart and all-sky view listen too
    }

    function sortedRows() {
      const list = SAT.state.visibleCrossings();
      const col = colByKey(st.sortKey) || colByKey('ca');
      return list.slice().sort(makeCmp(col, st.sortAsc));
    }

    // ---- scan control --------------------------------------------------------

    function onScanClick() {
      if (!SAT.scan) { showEmpty('scan engine not loaded'); return; }
      if (SAT.scan.isRunning && SAT.scan.isRunning()) { SAT.scan.cancel(); return; }
      if (!SAT.state.activeLocation()) { renderAll(); return; }
      if (!SAT.state.catalog.objs.length) { renderAll(); return; }
      st.lastError = null;
      // run() emits 'scan-started'/'scan-done' itself; the .catch is only here so a
      // rejected promise cannot leave the button stuck on "Cancel"
      Promise.resolve(SAT.scan.run()).catch(e => {
        st.running = false;
        st.lastError = (e && e.message) || String(e);
        renderAll();
      });
    }

    function setRunning(on) {
      st.running = on;
      scanBtn.textContent = on ? 'Cancel' : 'Scan';
      scanBtn.className = on ? 'btn danger' : 'btn primary';
      progWrap.style.display = on ? '' : 'none';
      if (!on) progTxt.textContent = '';
    }

    // ---- rendering -----------------------------------------------------------

    function updateEstimate() {
      if (st.running || !SAT.scan || !SAT.scan.estimate) { estEl.textContent = ''; return; }
      let n = 0;
      try { n = SAT.scan.estimate(); } catch (e) { n = 0; }
      estEl.textContent = n > 0 ? '≈ ' + grp(Math.round(n / 1000)) + 'k props' : '';
      estEl.title = 'estimated SGP4 propagations for the current span and step';
    }

    /** "27 843 objects → 9 612 after geometry → 61 crossings in 2.3 s".
     *
     * `scan.culled` is written by SAT.scan; the worker protocol reports it as counts
     * REJECTED per stage, so survivors are total − stage1. An explicit
     * `afterGeometry` wins if the scan module provides one. */
    function summaryText() {
      const scan = SAT.state.scan;
      if (!scan.ranAt && !scan.culled) return '';
      const cul = scan.culled || {};
      const total = isNum(cul.total) ? cul.total : (SAT.state.catalog.count || 0);
      // scan.js reports `survivors` — the stage-1 survivor count — directly. Prefer
      // it to (total − stage1): `bad` TLEs are counted separately, so the
      // subtraction would over-report the survivors by however many objects failed
      // to parse. The subtraction stays as a fallback for older scan builds.
      let afterGeom = null;
      if (isNum(cul.survivors)) afterGeom = cul.survivors;
      else if (isNum(cul.afterGeometry)) afterGeom = cul.afterGeometry;
      else if (isNum(cul.stage1)) afterGeom = Math.max(0, total - cul.stage1);
      const parts = [grp(total) + ' objects'];
      if (afterGeom != null) parts.push(grp(afterGeom) + ' after geometry');
      parts.push(grp(scan.crossings.length) +
        (scan.crossings.length === 1 ? ' crossing' : ' crossings'));
      const ms = st.lastScan && isNum(st.lastScan.ms) ? st.lastScan.ms : null;
      return parts.join(' → ') + (ms == null ? '' : ' in ' + (ms / 1000).toFixed(1) + ' s');
    }

    function renderHeader() {
      staleTag.style.display = SAT.state.scan.stale ? '' : 'none';
      staleTag.title = 'the pointing, field, timespan or catalogue changed after this ' +
        'scan ran — the list below is from the old parameters. Press Scan.';
      summaryEl.textContent = summaryText();
      updateEstimate();
    }

    function syncFilterUI() {
      const f = SAT.state.filters;
      magInput.value = (f.maxMag == null || f.maxMag >= 99) ? '' : String(f.maxMag);
      sunChk.checked = !!f.sunlitOnly;
      altMin.value = f.minAltKm ? String(f.minAltKm) : '';
      altMax.value = f.maxAltKm ? String(f.maxAltKm) : '';
      rateMin.value = f.minRateAsPerS ? String(f.minRateAsPerS) : '';
      rateMax.value = f.maxRateAsPerS ? String(f.maxRateAsPerS) : '';
      if (searchInput.value !== (f.search || '')) searchInput.value = f.search || '';
      CLS_ORDER.forEach((k, i) => {
        const on = !f.classes || f.classes[k] !== false;
        clsChips[i].className = 'xin-chip ' + (on ? 'on' : 'off');
        clsChips[i].style.cssText = on
          ? 'background:' + CLS_COLOR[k] + ';border-color:transparent'
          : '';
      });
      TYPE_ORDER.forEach(([k], i) => {
        const on = !f.types || f.types[k] !== false;
        typeChips[i].className = 'xin-chip ' + (on ? 'on' : 'off');
        typeChips[i].style.cssText = on
          ? 'background:' + typeColour(k) + ';border-color:transparent'
          : '';
      });
    }

    /** If the pointing never rose above the horizon during the scanned span, say so
     *  and give the best elevation reached. Returns null when it was up at all, or
     *  when we cannot tell (no site, missing frames). Sampled at 32 points, which is
     *  plenty to catch a field that is up for any usable fraction of the span. */
    function horizonHint() {
      const st = SAT.state, site = st.activeLocation(), o = st.obs;
      if (!site || !SAT.frames || !st.scan.ranAt) return null;
      const t0 = st.scan.params && st.scan.params.t0Ms;
      if (t0 == null) return null;
      const span = (o.spanMin || 0) * 60000;
      let best = -91, bestT = t0;
      for (let i = 0; i <= 32; i++) {
        const t = new Date(t0 + span * (i / 32));
        let el;
        try {
          el = o.mode === 'altaz'
            ? o.elDeg
            : SAT.frames.raDecToAltAz(o.raDeg, o.decDeg, site, t, { refract: false }).elDeg;
        } catch (e) { return null; }
        if (el > best) { best = el; bestT = t.getTime(); }
      }
      if (best >= 0) return null;
      return 'The pointing is below the horizon for the whole timespan — it peaks at ' +
        best.toFixed(1) + '° at ' + U.fmtDate(new Date(bestT)) +
        ' UTC. Zero crossings is the correct answer; widening the field will not help. ' +
        'Choose a different epoch, or a target that is up from ' + site.name + '.';
    }

    /** The empty states, each naming the action that fixes it. Returns the
     *  message or null when there is a table to draw. */
    function emptyState() {
      if (!SAT.state.activeLocation()) {
        return 'No observing site. Open the Locations window, add a site and mark it active.';
      }
      if (!SAT.state.catalog.objs.length) {
        return 'No catalogue loaded. Open the Sources window and press “Full catalogue”.';
      }
      if (!SAT.state.scan.ranAt) {
        return 'Not scanned yet. Set the pointing and timespan in the Pointing window, ' +
          'then press Scan above.';
      }
      if (!SAT.state.scan.crossings.length) {
        // Distinguish "nothing was up there" from "you were pointing at the ground".
        // A below-horizon pointing returns a legitimate zero, and without this the
        // user is told to widen the FOV — advice that cannot possibly help. Found
        // in real use: Orion from Paranal in July sits at El -47.
        const below = horizonHint();
        if (below) return below;
        return 'Scan finished and nothing crossed this field. Widen the FOV, lengthen the ' +
          'timespan, or check the site and epoch in the Pointing window.';
      }
      if (!SAT.state.visibleCrossings().length) {
        return SAT.state.scan.crossings.length + ' crossings found, but every one is ' +
          'hidden by the filters above. Clear the magnitude limit, the rate range, the ' +
          'class chips or the search box.';
      }
      return null;
    }

    function renderTable() {
      const cols = shownCols();
      clear(thead);
      clear(tbody);

      const msg = emptyState();
      emptyEl.textContent = msg || '';
      emptyEl.style.display = msg ? '' : 'none';
      table.style.display = msg ? 'none' : '';

      // truncation is a fifth state that coexists with a full table: the list is
      // real but incomplete, and saying nothing would present it as complete
      const trunc = st.lastScan && st.lastScan.truncated;
      const cap = (SAT.state.settings.scan && SAT.state.settings.scan.maxCrossings) ||
        (st.lastScan && st.lastScan.count) || 0;
      noticeEl.textContent = trunc
        ? '⚠ Truncated at ' + grp(cap) +
          ' crossings — the field or timespan is too generous to enumerate. Shorten ' +
          'the timespan, narrow the FOV, or raise settings.scan.maxCrossings.'
        : (st.lastError ? '✗ scan failed: ' + st.lastError : '');
      noticeEl.style.display = noticeEl.textContent ? '' : 'none';

      if (msg) { st.shown = 0; st.total = 0; renderFooter(); return; }

      // The pick column lives outside COLS: it is not sortable, not toggleable and
      // not exported — it is a view control (show only these on the chart), not data.
      const ck = SAT.state.scan.checked || (SAT.state.scan.checked = new Set());
      const nTicked = ck.size;
      const pickTh = U.el('th', {
        class: 'xin-th xin-pick',
        title: nTicked
          ? 'chart shows only the ' + nTicked + ' ticked object' + (nTicked === 1 ? '' : 's') +
            ' — click to clear all ticks'
          : 'tick rows to show only those objects on the sky chart and all-sky view',
        onclick: () => {
          if (ck.size) {
            ck.clear();
            SAT.bus.emit('filters-changed', {});
            renderTable();
          }
        },
      }, nTicked ? '☑' + nTicked : '☐');

      const arrow = key => (st.sortKey === key ? (st.sortAsc ? ' ▲' : ' ▼') : '');
      const forced = rateFilterActive() && trackMount();
      thead.appendChild(U.el('tr', {}, [pickTh].concat(cols.map(col => U.el('th', {
        class: 'xin-th',
        title: (hintOf(col) ? hintOf(col) + ' — ' : '') + 'click to sort' +
          (forced && col.key === 'rateAlt'
            ? ' (shown because a rate filter is set and the filter tests this column)' : ''),
        onclick: () => {
          if (st.sortKey === col.key) st.sortAsc = !st.sortAsc;
          // time and name read naturally ascending; every other numeric column is
          // most useful biggest-first (brightest, closest, fastest)
          else { st.sortKey = col.key; st.sortAsc = !col.num || /^(enter|ca|exit|norad)$/.test(col.key); }
          renderTable();
        },
      }, labelOf(col) + arrow(col.key))))));

      const all = sortedRows();
      const list = all.slice(0, RENDER_CAP);
      st.total = all.length;
      st.shown = list.length;
      const selId = SAT.state.selection.satId;

      list.forEach(c => {
        const cb = U.el('input', { type: 'checkbox' });
        cb.checked = ck.has(c.satId);
        // the tick is a chart control, not a row action: it must not select the
        // row or jump the clock
        cb.addEventListener('click', ev => ev.stopPropagation());
        cb.addEventListener('dblclick', ev => ev.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) ck.add(c.satId); else ck.delete(c.satId);
          SAT.bus.emit('filters-changed', {});
          renderTable();          // header tick-count + chart both follow
        });
        const tr = U.el('tr', {
          class: 'xin-row' + (c.satId === selId ? ' sel' : ''),
          title: 'click to select · double-click to jump the clock to closest approach',
        }, [U.el('td', { class: 'xin-pick' }, cb)].concat(cols.map(col => {
          if (col.cell) return col.cell(c, col);
          return U.el('td', {
            class: col.num ? 'num' : null,
            title: col.title ? col.title(c) : null,
          }, col.text(c));
        })));
        tr.addEventListener('click', () => SAT.state.setSelection(c.satId));
        tr.addEventListener('dblclick', () => {
          if (SAT.clock) SAT.clock.setDate(new Date(c.tCaMs));
        });
        tr.addEventListener('mouseenter', () => setHover(c.satId));
        tr.addEventListener('mouseleave', () => setHover(null));
        tbody.appendChild(tr);
      });

      renderFooter();
    }

    /** Hover highlight. Runtime-only field on SAT.state (serialisable() never picks
     *  it up), plus an event so the chart can redraw without polling. */
    function setHover(satId) {
      if (SAT.state.hoverSatId === satId) return;
      SAT.state.hoverSatId = satId;
      SAT.bus.emit('crossing-hover', { satId: satId });
      if (SAT.chart && SAT.chart.requestRender) SAT.chart.requestRender();
    }

    function renderFooter() {
      const n = SAT.state.scan.crossings.length;
      countEl.textContent = st.total === n
        ? grp(st.total) + (st.total === 1 ? ' crossing' : ' crossings')
        : grp(st.total) + ' of ' + grp(n) + ' after filters';
      capEl.textContent = st.total > st.shown
        ? '· showing first ' + grp(st.shown) + ' of ' + grp(st.total) +
          ' — sort or filter to bring the rest into view'
        : '';
      const none = st.shown === 0;
      copyBtn.disabled = none; csvBtn.disabled = none; jsonBtn.disabled = none;
    }

    function renderAll() {
      syncFilterUI();
      renderColsPanel();
      renderHeader();
      renderTable();
    }

    // ---- copy / export -------------------------------------------------------

    function visibleMatrix() {
      const cols = shownCols();
      const rows = sortedRows();
      // the header carries the frame tag, so an exported CSV still says which rate
      // it holds long after the app has been closed
      return { header: cols.map(labelOf), rows: rows.map(c => cols.map(col => col.text(c))) };
    }

    function doCopyTsv() {
      const m = visibleMatrix();
      const text = [m.header.map(tsvCell).join('\t')]
        .concat(m.rows.map(r => r.map(tsvCell).join('\t'))).join('\n');
      const done = ok => {
        copyBtn.textContent = ok ? '✓ copied' : '✗ copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy TSV'; }, 2000);
      };
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      } else {
        done(false);
      }
    }

    function doCsv() {
      const m = visibleMatrix();
      const text = [m.header.map(csvCell).join(',')]
        .concat(m.rows.map(r => r.map(csvCell).join(','))).join('\r\n');
      download('crossings-' + stamp() + '.csv', 'text/csv;charset=utf-8', text);
    }

    function doJson() {
      // the raw Crossing records, path included: JSON is the machine-readable export
      // and a consumer plotting the track needs the samples
      const payload = {
        generated: new Date().toISOString(),
        site: SAT.state.activeLocation(),
        obs: SAT.state.obs,
        filters: SAT.state.filters,
        count: SAT.state.visibleCrossings().length,
        crossings: sortedRows(),
      };
      download('crossings-' + stamp() + '.json', 'application/json',
        JSON.stringify(payload, null, 2));
    }

    // ---- bus wiring ----------------------------------------------------------

    SAT.bus.on('scan-started', () => {
      st.lastScan = null; st.lastError = null;
      setRunning(true);
      progFill.style.width = '0%';
      progTxt.textContent = 'starting…';
      renderAll();
    });

    SAT.bus.on('scan-progress', p => {
      if (!p) return;
      const frac = p.total > 0 ? U.clamp(p.done / p.total, 0, 1) : 0;
      progFill.style.width = (frac * 100).toFixed(1) + '%';
      progTxt.textContent = (p.phase || 'scan') + ' ' + grp(p.done | 0) + '/' + grp(p.total | 0);
    });

    SAT.bus.on('scan-done', p => {
      st.lastScan = p || { count: 0, ms: null, truncated: false };
      setRunning(false);
      renderAll();
    });

    SAT.bus.on('scan-failed', p => {
      st.lastError = (p && p.error && p.error.message) || (p && String(p.error)) || 'unknown';
      setRunning(false);
      renderAll();
    });

    // filtering re-renders the table and NEVER touches the scan
    SAT.bus.on('filters-changed', () => { syncFilterUI(); renderTable(); });
    // obs-changed can flip obs.track, which changes which frame Rate/PA show and
    // relabels their headers — a header-only refresh would leave the labels
    // claiming a frame the cells are no longer in
    SAT.bus.on('obs-changed', renderAll);
    SAT.bus.on('catalog-changed', renderAll);
    SAT.bus.on('locations-changed', renderAll);
    SAT.bus.on('selection-changed', () => renderTable());
    SAT.bus.on('state-loaded', renderAll);

    inst = { renderAll, renderTable, st };
    renderAll();
    return inst;
  }

  /** Re-read state and redraw. Safe before init(). */
  function refresh() {
    if (inst) inst.renderAll();
  }

  SAT.ui.crossings = { init, refresh };
})();
