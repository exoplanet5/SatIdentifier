/* SAT.ui.satinfo — one object in detail: the last step of an identification.
 *
 * Ported from SatObserver, but two numbers that were previously decoration are given
 * top billing here, because they are what decides whether a match is believable:
 *
 *   TLE epoch age — the frame maths is good to under an arcsecond; the elements are
 *     not. A week-old LEO element set is tens of km out, i.e. degrees on the sky. An
 *     object matched on 20-day-old elements is a hypothesis, not an identification.
 *   Photometry method — 'qsmag' is an observed standard magnitude, 'rcs' assumes the
 *     object is a diffuse sphere with the area of its radar cross-section, and
 *     'default' additionally assumes it is 1 m across. Only the first is evidence.
 */
(function () {
  'use strict';

  const CLS_COLOR = { leo: '#4fc3f7', meo: '#7ad97a', geo: '#ffb84f', heo: '#c792ea' };
  const CLS_NAME = { leo: 'LEO', meo: 'MEO', geo: 'GEO', heo: 'HEO' };

  // Thresholds for the epoch-age banner. 3 d is where LEO drift passes a typical
  // field width; past ~14 d a LEO TLE is barely worth propagating at all.
  const STALE_DAYS = 3, VERY_STALE_DAYS = 14;

  // How the magnitude was arrived at: [label, what it is worth]
  const METHOD = {
    qsmag: ['McCants standard magnitude',
      'observed photometry, referred to 1000 km and 50% illumination — good to a few tenths'],
    rcs: ['SATCAT radar cross-section',
      'diffuse sphere of radius √(RCS/π) and albedo 0.20 — the object is not a sphere, so treat this as an order of magnitude'],
    default: ['assumed 1 m sphere',
      'a guess: this object has neither a standard magnitude nor an RCS'],
    eclipsed: ['eclipsed', 'in the Earth’s shadow — not visible at all, at any exposure'],
    none: ['no geometry', 'no range, so no magnitude'],
  };

  // CelesTrak SATCAT launch-site codes
  const SITES = {
    AFETR: 'Air Force Eastern Test Range, Florida, USA',
    AFWTR: 'Air Force Western Test Range, California, USA',
    CAS: 'Canaries Airspace (air launch)',
    DLS: 'Dombarovskiy Launch Site, Russia',
    ERAS: 'Eastern Range Airspace (air launch)',
    FRGUI: "Europe's Spaceport, Kourou, French Guiana",
    HGSTR: 'Hammaguira Space Track Range, Algeria',
    JSC: 'Jiuquan Satellite Launch Center, China',
    KODAK: 'Kodiak Launch Complex, Alaska, USA',
    KSCUT: 'Uchinoura Space Center, Japan',
    KWAJ: 'US Army Kwajalein Atoll, Marshall Islands',
    KYMSC: 'Kapustin Yar Missile and Space Complex, Russia',
    NSC: 'Naro Space Center, South Korea',
    PLMSC: 'Plesetsk Missile and Space Complex, Russia',
    RLLB: 'Rocket Lab Launch Base, Mahia, New Zealand',
    SEAL: 'Sea Launch platform (mobile)',
    SEMLS: 'Semnan Satellite Launch Site, Iran',
    SMTS: 'Shahrud Missile Test Site, Iran',
    SNMLP: 'San Marco Launch Platform, Kenya',
    SRILR: 'Satish Dhawan Space Centre, India',
    SUBL: 'Submarine launch (mobile)',
    SVOBO: 'Svobodnyy Launch Complex, Russia',
    TAISC: 'Taiyuan Space Launch Center, China',
    TANSC: 'Tanegashima Space Center, Japan',
    TNGH: 'Tonghae Satellite Launching Ground, North Korea',
    TYMSC: 'Tyuratam (Baikonur), Kazakhstan',
    VOSTO: 'Vostochny Cosmodrome, Russia',
    WLPIS: 'Wallops Island, Virginia, USA',
    WOMRA: 'Woomera, Australia',
    WRAS: 'Western Range Airspace (air launch)',
    WSC: 'Wenchang Satellite Launch Center, China',
    XICLF: 'Xichang Launch Facility, China',
    YAVNE: 'Yavne Launch Facility, Israel',
    YUN: 'Sohae Satellite Launching Station, North Korea',
  };

  let host = null, winRef = null, current = null;
  let live = null;            // {cell: fn} refs into the rendered table
  let lastLiveMs = 0;
  const satcatCache = new Map();   // norad -> record|null

  // ---- formatting ----------------------------------------------------------

  const f1 = v => (v == null || !isFinite(v)) ? '—' : v.toFixed(1);
  const f2 = v => (v == null || !isFinite(v)) ? '—' : v.toFixed(2);

  function fmtAge(days) {
    if (days == null || !isFinite(days)) return '—';
    if (days < 0) return 'in ' + fmtAge(-days);
    if (days < 1 / 24) return Math.round(days * 1440) + ' min';
    if (days < 2) return (days * 24).toFixed(1) + ' h';
    return days.toFixed(2) + ' d';
  }

  /** "98067A" -> "1998-067A" (the raw form is what sits in TLE line 1). */
  function fmtIntl(raw) {
    const m = /^(\d{2})(\d{3})\s*([A-Z]*)$/.exec((raw || '').trim());
    if (!m) return (raw || '').trim() || '—';
    const yy = +m[1];
    return (yy >= 57 ? 1900 + yy : 2000 + yy) + '-' + m[2] + m[3];
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- data ----------------------------------------------------------------

  /** Mean elements at epoch, straight from the satrec. */
  function elements(obj) {
    if (!SAT.prop.ensureSatrec(obj)) return null;
    const rec = obj._satrec;
    const alt = SAT.prop.altitudes(obj);
    if (!alt) return null;
    const R2D = 180 / Math.PI;
    return {
      smaKm: alt.aKm, ecc: alt.ecc, incDeg: alt.incDeg, raanDeg: alt.raanDeg,
      aopDeg: rec.argpo * R2D, maDeg: rec.mo * R2D,
      perKm: alt.perigeeKm, apoKm: alt.apogeeKm,
      periodMin: SAT.prop.periodMinutes(obj),
      epoch: SAT.prop.tleEpoch(obj),
    };
  }

  /** Current topocentric solution plus the photometry that follows from it. */
  function geometry(obj, date) {
    const loc = SAT.state.activeLocation();
    if (!loc) return null;
    const o = SAT.state.obs;
    let la = null;
    try {
      la = SAT.prop.look(loc, obj, date, { dut1S: o.dut1S });
    } catch (e) { la = null; }
    if (!la) return null;
    let mag = { mag: null, method: 'none' };
    if (SAT.photo) {
      try {
        mag = SAT.photo.magnitude(obj,
          { rangeKm: la.rangeKm, phaseDeg: la.phaseDeg, shadow: la.shadow });
      } catch (e) { mag = { mag: null, method: 'none' }; }
    }
    return { loc, la, mag };
  }

  /** The crossing for this object in the current scan result, if any. */
  function crossingFor(obj) {
    let list = [];
    try { list = SAT.state.visibleCrossings() || []; } catch (e) { return null; }
    for (const c of list) if (c.satId === obj.id) return c;
    return null;
  }

  // ---- rows ----------------------------------------------------------------

  function row(label, value) {
    const U = SAT.util;
    const cell = U.el('td', { class: 'num sin-v' }, value);
    return {
      tr: U.el('tr', null, [U.el('td', { class: 'dim sin-k' }, label), cell]),
      cell,
    };
  }

  function table(rows) {
    return SAT.util.el('table', { class: 'sin-tbl' },
      SAT.util.el('tbody', null, rows.map(r => r.tr)));
  }

  function section(title) {
    return SAT.util.el('div', { class: 'sin-sec' }, title);
  }

  // ---- render --------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById('sin-style')) return;
    const s = document.createElement('style');
    s.id = 'sin-style';
    s.textContent =
      '.sin-tbl{border-collapse:collapse;font-size:12px;width:100%;}' +
      '.sin-tbl td{padding:2px 0;vertical-align:top;}' +
      '.sin-k{white-space:nowrap;padding-right:10px !important;width:1%;}' +
      '.sin-v{word-break:break-word;}' +
      '.sin-sec{font-size:11px;color:#9aa4ae;text-transform:uppercase;' +
        'letter-spacing:.06em;margin:9px 0 3px;}' +
      '.sin-age{font-size:12px;line-height:1.45;padding:5px 8px;border-radius:3px;' +
        'border:1px solid transparent;margin-bottom:6px;}' +
      '.sin-age.ok{color:#9aa4ae;background:rgba(122,217,122,0.06);' +
        'border-color:rgba(122,217,122,0.28);}' +
      '.sin-age.warn{color:#ffb84f;background:rgba(255,184,79,0.08);' +
        'border-color:rgba(255,184,79,0.40);}' +
      '.sin-age.bad{color:#ff8a65;background:rgba(255,82,82,0.10);' +
        'border-color:rgba(255,82,82,0.45);}' +
      '.sin-note{font-size:11px;opacity:.85;margin-top:2px;}' +
      '.sin-chip{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;' +
        'line-height:15px;color:#0a0e13;font-weight:600;}' +
      '.sin-tle{font-family:var(--mono,ui-monospace,Menlo,monospace);font-size:10px;' +
        'white-space:pre;overflow-x:auto;color:#9aa4ae;}';
    document.head.appendChild(s);
  }

  /** Epoch-age banner text and severity. This is the headline of the window. */
  function ageBanner(ageDays) {
    if (!isFinite(ageDays)) {
      return ['bad', '⚠ No usable epoch — this object’s TLE could not be parsed.', ''];
    }
    const a = fmtAge(ageDays);
    if (ageDays < 0) {
      return ['warn', '⚠ Epoch is ' + a + ' in the future — you are propagating backwards.',
        'SGP4 runs happily either way, but the elements were fitted to data after this time.'];
    }
    if (ageDays <= STALE_DAYS) {
      return ['ok', '✓ Elements are ' + a + ' old.',
        'Position error at this age is of order 1 km, i.e. a few arcminutes at LEO range.'];
    }
    if (ageDays <= VERY_STALE_DAYS) {
      return ['warn', '⚠ Elements are ' + a + ' old.',
        'Expect several km of along-track error — tens of arcminutes at LEO range, which ' +
        'is wider than most fields. A match at this age is a candidate, not a conclusion.'];
    }
    return ['bad', '⚠ Elements are ' + a + ' old.',
      'Far past useful life for a LEO object: the along-track error can exceed a degree. ' +
      'Refresh the catalogue in the Catalogue window before believing — or disbelieving — this match.'];
  }

  function render() {
    if (!host) return;
    const U = SAT.util;
    clear(host);
    live = null;

    if (!current) {
      host.appendChild(U.el('div', { class: 'msg-empty' },
        'Select an object — click a row in Crossings or a marker on the Sky Chart — ' +
        'to inspect it here.'));
      return;
    }

    const obj = current;
    const date = SAT.clock.getDate();
    const el = elements(obj);
    const cls = SAT.prop.classOf(obj);
    const ageDays = SAT.prop.tleAgeDays(obj, date);

    // ---- header ----
    const head = U.el('div', { class: 'row', style: 'gap:8px;margin-bottom:6px;align-items:center' }, [
      U.el('span', { class: 'sin-chip', style: 'background:' + (CLS_COLOR[cls] || '#4fc3f7') },
        CLS_NAME[cls] || cls),
      U.el('b', { style: 'font-size:14px' }, obj.name || ('OBJECT ' + obj.norad)),
    ]);

    // ---- epoch age: the headline ----
    const [sev, headline, note] = ageBanner(ageDays);
    const ageEl = U.el('div', { class: 'sin-age ' + sev }, [
      U.el('span', null, headline),
      U.el('div', { class: 'sin-note' }, note),
    ]);

    // ---- identity ----
    const rEpoch = row('TLE epoch (UTC)', el && el.epoch
      ? U.fmtDate(el.epoch) + '  (' + fmtAge(ageDays) + ' old)' : '—');
    const idRows = [
      row('NORAD ID', String(obj.norad)),
      row('Int’l designator', obj.intl || fmtIntl((obj.l1 || '').slice(9, 17))),
      row('Orbit class', (CLS_NAME[cls] || cls) + '  ·  ' +
        f1(SAT.prop.revsPerDay(obj)) + ' rev/day'),
      rEpoch,
      // the catalogue is multi-source now; the object's own src tag is the
      // relevant provenance, not a single global source string
      row('Source', obj.src === 'spacetrack' ? 'Space-Track'
        : obj.src === 'mccants' ? 'McCants'
        : obj.src === 'paste' ? 'pasted TLE' : '—'),
      row('Launch date', '…'),
      row('Launch site', '…'),
      row('Owner / type', '…'),
      row('Status', '…'),
    ];

    // ---- live geometry ----
    const rRaDec = row('RA / Dec (J2000)', '—');
    const rAzEl = row('Az / El', '—');
    const rRange = row('Range', '—');
    const rRate = row('Apparent rate', '—');
    const rPhase = row('Phase / shadow', '—');
    const geomRows = [rRaDec, rAzEl, rRange, rRate, rPhase];

    // ---- photometry breakdown ----
    const rMag = row('Estimated mag', '—');
    const rMethod = row('Method', '—');
    const rRcs = row('RCS', obj.rcs != null
      ? f2(obj.rcs) + ' m²  (sphere radius ' + f2(Math.sqrt(obj.rcs / Math.PI)) + ' m)'
      : '— (not in SATCAT)');
    const rStdMag = row('Standard magnitude', obj.stdMag != null
      ? f1(obj.stdMag) + '  (McCants, at 1000 km and 50% illumination)'
      : '— (not in the qsmag list)');
    const methodNote = U.el('div', { class: 'sin-note dim' }, '');
    const photoRows = [rMag, rMethod, rRcs, rStdMag];

    // ---- this object in the current scan ----
    const cross = crossingFor(obj);
    const crossEl = cross
      ? U.el('div', { class: 'sin-note' },
        'In the current scan: in field ' + U.fmtDate(new Date(cross.tEnterMs)).slice(11) +
        ' → ' + U.fmtDate(new Date(cross.tExitMs)).slice(11) + ' UTC, closest approach ' +
        U.fmtAngle(cross.sepCaDeg) + ' from the field centre.')
      : U.el('div', { class: 'sin-note dim' },
        'Not in the current crossing list (it may not have been scanned, or it never ' +
        'enters the field).');

    const elemRows = el ? [
      row('Perigee', f2(el.perKm) + ' km'),
      row('Apogee', f2(el.apoKm) + ' km'),
      row('Period', f2(el.periodMin) + ' min'),
      row('SMA', f2(el.smaKm) + ' km'),
      row('ECC', el.ecc.toFixed(7)),
      row('INC', f2(el.incDeg) + ' °'),
      row('RAAN', f2(el.raanDeg) + ' °'),
      row('AOP', f2(el.aopDeg) + ' °'),
      row('Mean anomaly', f2(el.maDeg) + ' °'),
    ] : [row('Elements', 'TLE could not be parsed by SGP4')];

    host.appendChild(U.el('div', { class: 'pane' }, [
      head,
      ageEl,
      table(idRows),
      section('Now, from ' + ((SAT.state.activeLocation() || {}).name || 'no site')),
      table(geomRows),
      crossEl,
      section('Photometry'),
      table(photoRows),
      methodNote,
      section('Mean elements at epoch'),
      table(elemRows),
      U.el('div', { class: 'sep' }),
      U.el('div', { class: 'sin-tle' }, (obj.l1 || '') + '\n' + (obj.l2 || '')),
    ]));

    live = {
      obj, ageRow: rEpoch.cell, ageEl,
      raDec: rRaDec.cell, azEl: rAzEl.cell, range: rRange.cell,
      rate: rRate.cell, phase: rPhase.cell,
      mag: rMag.cell, method: rMethod.cell, methodNote,
    };
    updateLive();

    // ---- SATCAT record (async fill) ----
    const cells = {
      launch: idRows[5].cell, site: idRows[6].cell,
      owner: idRows[7].cell, status: idRows[8].cell,
    };
    const applyRec = rec => {
      if (current !== obj) return;      // the window has moved on to another object
      if (!rec) {
        cells.launch.textContent = '—';
        cells.site.textContent = '— (no SATCAT record for this NORAD id)';
        cells.owner.textContent = '—';
        cells.status.textContent = '—';
        return;
      }
      cells.launch.textContent = rec.LAUNCH_DATE || '—';
      const site = (rec.LAUNCH_SITE || '').trim();
      cells.site.textContent = site ? (SITES[site] ? site + ' — ' + SITES[site] : site) : '—';
      cells.owner.textContent = [(rec.OWNER || '').trim(), (rec.OBJECT_TYPE || '').trim()]
        .filter(Boolean).join(' / ') || '—';
      cells.status.textContent = [(rec.OPS_STATUS_CODE || rec.OPERATIONAL_STATUS || '').trim(),
        (rec.DECAY_DATE || '').trim() ? 'decayed ' + rec.DECAY_DATE : '']
        .filter(Boolean).join('  ·  ') || '—';
    };
    if (satcatCache.has(obj.norad)) {
      applyRec(satcatCache.get(obj.norad));
    } else {
      fetch('/api/satcat?norad=' + obj.norad)
        .then(r => r.json())
        .then(d => {
          const rec = (d && d.ok) ? (d.record || null) : null;
          satcatCache.set(obj.norad, rec);
          applyRec(rec);
        })
        .catch(() => {
          if (current !== obj) return;
          cells.launch.textContent = 'lookup failed';
          cells.site.textContent = 'lookup failed';
          cells.owner.textContent = '—';
          cells.status.textContent = '—';
        });
    }
  }

  /** Refresh only the time-dependent cells. Called from the clock, so it must not
   *  rebuild the DOM — the SATCAT fetch and the scroll position both live there. */
  function updateLive() {
    if (!live || !host) return;
    const U = SAT.util;
    const obj = live.obj;
    const date = SAT.clock.getDate();

    const ageDays = SAT.prop.tleAgeDays(obj, date);
    const ep = SAT.prop.tleEpoch(obj);
    live.ageRow.textContent = ep
      ? U.fmtDate(ep) + '  (' + fmtAge(ageDays) + ' old)' : '—';
    const [sev, headline, note] = ageBanner(ageDays);
    live.ageEl.className = 'sin-age ' + sev;
    live.ageEl.firstChild.textContent = headline;
    live.ageEl.lastChild.textContent = note;

    const g = geometry(obj, date);
    if (!g) {
      const why = SAT.state.activeLocation()
        ? 'SGP4 failed at this time (decayed, or elements out of range)'
        : 'no active site — set one in Sites';
      live.raDec.textContent = why;
      live.azEl.textContent = '—';
      live.range.textContent = '—';
      live.rate.textContent = '—';
      live.phase.textContent = '—';
      live.mag.textContent = '—';
      live.method.textContent = '—';
      live.methodNote.textContent = '';
      return;
    }

    const la = g.la;
    live.raDec.textContent = U.fmtRA(la.raDeg) + '   ' + U.fmtDec(la.decDeg) +
      '   (' + la.raDeg.toFixed(4) + '°, ' + la.decDeg.toFixed(4) + '°)';
    live.azEl.textContent = f2(la.azDeg) + '° / ' + f2(la.elDeg) + '°' +
      (la.elDeg < 0 ? '  — below the horizon' : '') +
      '  (refracted)';
    live.range.textContent = f1(la.rangeKm) + ' km,  ' +
      (la.rangeRateKmS >= 0 ? '+' : '') + f2(la.rangeRateKmS) + ' km/s';
    // both frames, since which one matches a measured trail depends on tracking
    live.rate.textContent = f1(la.rateAsPerS) + ' ″/s at PA ' + f1(la.paDeg) + '° (sky)' +
      (la.rateMountAsPerS != null
        ? '  ·  ' + f1(la.rateMountAsPerS) + ' ″/s at PA ' + f1(la.paMountDeg) + '° (mount)'
        : '');
    live.phase.textContent = (la.phaseDeg == null ? '—' : f1(la.phaseDeg) + '°') +
      '  ·  ' + (la.shadow === 'none' ? 'sunlit' : la.shadow);

    const m = g.mag;
    live.mag.textContent = (m.mag == null ? '—' : f1(m.mag) + ' V') +
      (m.method === 'default' ? '   ⚠ guess' : '');
    const desc = METHOD[m.method] || [m.method, ''];
    live.method.textContent = m.method + ' — ' + desc[0];
    live.methodNote.textContent = desc[1];
  }

  // ---- public --------------------------------------------------------------

  function init(body, win) {
    host = body;
    winRef = win;
    injectStyle();

    // Selection is the app's central verb: a row click in Crossings or a marker
    // click on the chart should land here without a second gesture.
    SAT.bus.on('selection-changed', p => {
      const id = p && p.satId;
      const obj = id ? SAT.state.getObj(id) : null;
      if (obj !== current) { current = obj; render(); }
      if (winRef && obj) winRef.setTitle('Satellite Info — ' + (obj.name || obj.norad));
    });
    SAT.bus.on('catalog-changed', () => {
      // The catalogue was replaced wholesale, so the held object is a stale copy.
      current = current ? SAT.state.getObj(current.id) : null;
      render();
    });
    SAT.bus.on('scan-done', render);
    SAT.bus.on('state-loaded', render);
    SAT.bus.on('obs-changed', updateLive);
    SAT.bus.on('time', () => {
      // 4 Hz is plenty for a readout and keeps a 1000x clock rate from spending the
      // frame budget formatting numbers nobody can read.
      const now = Date.now();
      if (now - lastLiveMs < 250) return;
      lastLiveMs = now;
      if (winRef && !winRef.isOpen()) return;
      updateLive();
    });

    // Restored open with a selection already in state: show it immediately.
    if (!current && SAT.state.selection && SAT.state.selection.satId) {
      current = SAT.state.getObj(SAT.state.selection.satId);
    }
    render();
  }

  /** Show an object: accepts an ObjEntry or a satId. */
  function show(satOrId) {
    const obj = typeof satOrId === 'string' ? SAT.state.getObj(satOrId) : satOrId;
    if (!obj) return;
    current = obj;
    const built = !!host;
    const w = winRef || SAT.windows.get('satinfo');
    // open() builds the window on first use, and build() calls init() -> render(),
    // which is why `current` is set before this and not after — and why an already
    // built window is the only one that needs rendering again here.
    if (w) {
      w.setTitle('Satellite Info — ' + (obj.name || obj.norad));
      w.open();
      w.focus();
    }
    if (built) render();
  }

  SAT.ui.satinfo = { init, show };
})();
