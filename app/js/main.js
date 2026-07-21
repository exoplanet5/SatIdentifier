/* main.js — boot: load state, start clock, register windows, menu bar */
(function () {
  'use strict';
  const U = SAT.util;

  function helpContent(body) {
    body.appendChild(U.el('div', { class: 'pane', style: 'font-size:12px;line-height:1.6;max-width:600px' }, [
      U.el('h3', { style: 'margin:4px 0' }, 'SatIdentifier'),
      U.el('p', { class: 'dim', style: 'margin:4px 0' },
        'The inverse of a satellite tracker: instead of asking where a satellite is, ' +
        'it asks who is in your field of view — so an unidentified trail on a frame ' +
        'can be matched against the catalogue.'),
      U.el('div', { class: 'sep' }),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Workflow: '),
        '1) Load the catalogue in Catalogue — “Load full catalogue” pulls the whole ' +
        'Space-Track GP set (credentials required; debris and rocket bodies are ' +
        'exactly what unexpected trails turn out to be). Add McCants classified ' +
        'elements or paste TLEs; everything merges into one catalogue, deduplicated ' +
        'by NORAD with the newest elements winning, and epoch-age statistics are ' +
        'shown per source. ',
        '2) Set your site in Sites. ',
        '3) In Pointing, enter the start time, timespan, pointing and field of view. ',
        '4) Press Scan in Crossings. ',
        '5) Compare the Sky Chart trails against your frame.']),
      U.el('div', { class: 'sep' }),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Accuracy — read this before trusting an identification: ')]),
      U.el('ul', { style: 'margin:4px 0 4px 18px;padding:0' }, [
        U.el('li', null, 'Coordinates are J2000 mean equinox. TEME (what SGP4 returns) is ' +
          'properly rotated to J2000 — that is a 0.36° correction in 2026, twenty times ' +
          'a typical telescope field.'),
        U.el('li', null, 'Frame handling is good to under an arcsecond. The truth is not: ' +
          'TLE position error runs from about 1 km when fresh to tens of km after a week, ' +
          'which at 500 km range is 7′ to 2°. TLE age is shown in the table and in Satellite ' +
          'Info for exactly this reason.'),
        U.el('li', null, 'UT1−UTC is ignored by default (≤0.9 s, up to ~2.9′ of apparent ' +
          'shift at LEO). Set DUT1 in Pointing if you need it.'),
        U.el('li', null, 'Annual aberration (≤20.5″) is applied to neither satellites nor ' +
          'stars, so the chart and the satellites stay mutually consistent. Do not correct ' +
          'one side alone.'),
        U.el('li', null, 'Magnitudes are estimates. “qsmag” uses a McCants standard ' +
          'magnitude; “rcs” assumes a diffuse sphere of the SATCAT radar cross-section; ' +
          '“default” assumes a 1 m sphere and is a guess, flagged as such.'),
      ]),
      U.el('div', { class: 'sep' }),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Clock: '),
        'The field accepts YYYY-MM-DD HH:MM:SS (UTC). Put the caret on a segment and press ↑/↓ ' +
        'to step it. Rates run time forward and backward; the chart animates the crossings ' +
        'it already found without rescanning.']),
      U.el('p', { style: 'margin:4px 0' }, [U.el('b', null, 'Shortcuts: '),
        'Space = run/pause · N = jump to real time · S = scan (when not typing in a field).']),
      U.el('div', { class: 'sep' }),
      U.el('p', { class: 'dim', style: 'margin:4px 0;font-size:11px' },
        'Propagation: satellite.js (SGP4/SDP4). Stars: Tycho-2 to V=9.0 (Hog+ 2000) with ' +
        'BSC5/HYG photometry at the bright end. Data: CelesTrak, Space-Track, Mike McCants. ' +
        'Scan algorithm owes its structure to Bill Gray’s sat_code. ' +
        'State is saved automatically next to server.py.'),
    ]));
  }

  function registerWindows() {
    const dt = document.getElementById('desktop');
    const W = dt.clientWidth, H = dt.clientHeight;
    // Sky Chart and Crossings are the two halves of the answer, so they get the
    // room; everything else opens on demand.
    const chartW = Math.round(W * 0.60);
    const defs = [
      { id: 'chart', title: 'Sky Chart', x: 8, y: 8,
        w: chartW - 16, h: Math.round(H * 0.66), minW: 380, minH: 320, open: true,
        build: (b, w) => { w.noScroll = true; SAT.chart.init(b, w); } },
      { id: 'crossings', title: 'Crossings', x: chartW, y: 8,
        w: W - chartW - 8, h: H - 16, minW: 460, minH: 300, open: true,
        build: (b, w) => SAT.ui.crossings.init(b, w) },
      { id: 'pointing', title: 'Pointing', x: 8, y: Math.round(H * 0.66) + 16,
        w: chartW - 16, h: H - Math.round(H * 0.66) - 24, minW: 420, minH: 200, open: true,
        build: (b, w) => SAT.ui.pointing.init(b, w) },
      { id: 'sources', title: 'Catalogue', x: Math.round(W * 0.18), y: Math.round(H * 0.18),
        w: 620, h: 300, minW: 460, minH: 220, open: false,
        build: (b, w) => SAT.ui.sources.init(b, w) },
      { id: 'locations', title: 'Sites', x: Math.round(W * 0.22), y: Math.round(H * 0.24),
        w: 560, h: 260, minW: 480, minH: 200, open: false,
        build: (b, w) => SAT.ui.locations.init(b, w) },
      { id: 'clock', title: 'Clock', x: Math.round(W * 0.30), y: Math.round(H * 0.30),
        w: 330, h: 250, minW: 300, minH: 210, open: false,
        build: (b, w) => SAT.clock.buildUI(b, w) },
      { id: 'allsky', title: 'All-Sky', x: Math.round(W * 0.26), y: Math.round(H * 0.10),
        w: 440, h: 470, minW: 320, minH: 340, open: false,
        build: (b, w) => { w.noScroll = true; SAT.allsky.init(b, w); } },
      { id: 'satinfo', title: 'Satellite Info', x: Math.round(W * 0.34), y: Math.round(H * 0.20),
        w: 460, h: 420, minW: 360, minH: 260, open: false,
        build: (b, w) => SAT.ui.satinfo.init(b, w) },
      { id: 'help', title: 'Help', x: Math.round(W * 0.22), y: Math.round(H * 0.10),
        w: 640, h: 520, open: false, build: helpContent },
    ];
    // A module that failed to load must not take the whole desktop down with it.
    defs.forEach(d => {
      const build = d.build;
      d.build = (b, w) => {
        try {
          build(b, w);
        } catch (e) {
          console.error('window ' + d.id + ' failed to build:', e);
          b.appendChild(U.el('div', { class: 'msg-empty err' },
            d.title + ' failed to load: ' + (e && e.message ? e.message : e)));
        }
      };
      SAT.windows.register(d);
    });

    const mb = document.getElementById('mb-buttons');
    defs.forEach(d => {
      mb.appendChild(U.el('span', {
        class: 'mb-btn', 'data-win': d.id,
        onclick: () => SAT.windows.toggle(d.id),
      }, d.title));
    });
    const refreshMb = () => {
      mb.querySelectorAll('.mb-btn').forEach(b => {
        const w = SAT.windows.get(b.dataset.win);
        b.classList.toggle('on', !!(w && w.isOpen()));
      });
    };
    SAT.bus.on('windows-changed', refreshMb);
    refreshMb();

    document.getElementById('mb-clock').addEventListener('click', () => {
      const w = SAT.windows.get('clock');
      if (w) { w.open(); w.focus(); }
    });
  }

  function keyboard() {
    // release focus after any button click so the Space shortcut keeps working
    window.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('button');
      if (b) b.blur();
    });
    window.addEventListener('keydown', e => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
                t.tagName === 'BUTTON' || t.isContentEditable)) return;
      if (e.code === 'Space') { e.preventDefault(); SAT.clock.toggle(); }
      else if (e.key === 'n' || e.key === 'N') SAT.clock.syncNow();
      else if (e.key === 's' || e.key === 'S') {
        if (SAT.scan && !SAT.scan.isRunning()) SAT.scan.run().catch(() => {});
      }
    });
  }

  async function boot() {
    // The star catalogue is 1.3 MB and the chart is useless without it, but a
    // failed load must not block the app — stars.js falls back to the bright
    // catalogue and reports it via isDeep().
    const starsReady = SAT.stars ? SAT.stars.load().catch(e => {
      console.warn('deep star catalogue unavailable:', e);
      return null;
    }) : Promise.resolve(null);

    await SAT.state.load();     // settings.layout must exist before windows restore geometry
    registerWindows();
    SAT.clock.init();
    keyboard();
    SAT.bus.emit('state-loaded', {});

    await starsReady;
    if (SAT.chart) SAT.chart.requestRender();
  }

  boot();
})();
