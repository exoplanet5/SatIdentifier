/* SAT.ui.sources — where the object set comes from.
 *
 * The catalogue is a MERGED set from four sources — Space-Track (full GP
 * catalogue plus one-off queries), CelesTrak (full bulk catalogue plus
 * single-object queries), McCants classified files, and pasted TLEs —
 * deduplicated by NORAD with the newest elements winning. Every action here
 * goes through state.addTles(tag, payload, {replace}), which also rebuilds
 * every satrec up front (see "Performance decisions" in CONTRACT.md). There is
 * deliberately no CelesTrak GROUP fetch (round-1 review): a group subset
 * invites "identify against Starlink only", and a negative result from a
 * subset means nothing. The round-13 CelesTrak tab is single-OBJECT queries
 * only (NORAD / COSPAR / name), and the round-21 CelesTrak FULL catalogue is
 * the whole set, not a subset — neither carries that trap; the ban is on
 * groups.
 *
 * The per-source freshness block is the reason this window is worth opening. A
 * failed identification is far more often stale elements than a wrong pointing, and
 * a single merged "newest element" line hides exactly that: one fresh paste would
 * mask a fortnight-old Space-Track set. So each source reports its own count,
 * newest, median and oldest age — against the SIM clock, since the user may be
 * working a night from last week.
 */
(function () {
  'use strict';

  // Above this a source is called stale. 3 d of LEO drift is already several
  // arcminutes, i.e. bigger than a typical field — past that a non-detection means
  // nothing. The warning keys on the MEDIAN: one recently-launched object keeps
  // "newest" at minutes while half the set is a week behind.
  const STALE_DAYS = 3;

  const TAG_LABEL = { spacetrack: 'Space-Track', celestrak: 'CelesTrak',
                      mccants: 'McCants', paste: 'Pasted' };

  let headerHost = null;

  // ---- backend -------------------------------------------------------------

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch (e) { /* fallthrough */ }
    if (!data) throw new Error('Bad response from backend (' + r.status + ')');
    if (data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  function busy(btn, status, msg) {
    btn.disabled = true;
    status.textContent = '… ' + msg;
    status.className = 'dim';
  }

  function fail(btn, status, e) {
    btn.disabled = false;
    status.textContent = '✗ ' + (e && e.message ? e.message : e);
    status.className = 'err';
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtAge(days) {
    if (days == null || !isFinite(days)) return '—';
    if (days < 0) return 'in ' + fmtAge(-days);
    if (days < 1 / 24) return Math.round(days * 1440) + ' min';
    if (days < 2) return (days * 24).toFixed(1) + ' h';
    return days.toFixed(1) + ' d';
  }

  // ---- header: per-source statistics ---------------------------------------

  function refreshHeader() {
    const U = SAT.util;
    if (!headerHost) return;
    clear(headerHost);
    const cat = SAT.state.catalog;
    const stats = SAT.state.sourceStats();
    const tags = Object.keys(stats);

    if (!cat.count) {
      headerHost.appendChild(U.el('div', { class: 'src-banner src-warn' },
        '⚠ No catalogue loaded — the scan has nothing to search. Load the full ' +
        'catalogue below, fetch a McCants file, or paste TLEs.'));
      return;
    }

    const line = U.el('div', { class: 'src-summary' });
    line.appendChild(U.el('b', null, String(cat.count) + ' objects'));
    line.appendChild(U.el('span', { class: 'dim' },
      '  ·  merged from ' + tags.map(t => TAG_LABEL[t]).join(' + ') +
      ', deduplicated by NORAD (newest elements win)'));
    if (cat.bad) {
      // Unparseable pairs are normal in a full catalogue (decayed objects, analyst
      // entries with junk lines). Saying how many keeps "fewer objects than I
      // expected" from looking like a fetch bug.
      line.appendChild(U.el('span', { class: 'dim' },
        '  ·  ' + cat.bad + ' with unparseable TLEs (skipped by the scan)'));
    }
    headerHost.appendChild(line);

    let anyStale = false;
    for (const tag of ['spacetrack', 'celestrak', 'mccants', 'paste']) {
      const s = stats[tag];
      if (!s) continue;
      const stale = s.medianD > STALE_DAYS;
      if (stale) anyStale = true;
      const cls = stale ? 'src-srcline src-danger' : 'src-srcline src-ok';
      // The actual payload source string is shown, not just the tag: a stale disk
      // cache can serve data whose true provenance differs from the button that
      // loaded it, and hiding that behind the tag label would misstate where the
      // elements came from.
      const refs = cat.sources[tag];
      const prov = Array.isArray(refs) && refs.length
        ? refs[refs.length - 1].source + (refs.length > 1 ? ' +' + (refs.length - 1) : '')
        : null;
      headerHost.appendChild(U.el('div', { class: cls }, [
        U.el('b', null, (stale ? '⚠ ' : '✓ ') + TAG_LABEL[tag]),
        U.el('span', null,
          (prov && prov !== TAG_LABEL[tag] ? '  ·  ' + prov : '') +
          '  ·  ' + s.count + ' object' + (s.count === 1 ? '' : 's') +
          '  ·  newest ' + fmtAge(s.newestD) +
          '  ·  median ' + fmtAge(s.medianD) +
          '  ·  oldest ' + fmtAge(s.oldestD) +
          (stale ? '  — stale, refresh before trusting a result' : '')),
      ]));
    }
    if (anyStale) {
      headerHost.appendChild(U.el('div', { class: 'src-note' },
        'TLE position error grows from ~1 km when fresh to tens of km after a week; ' +
        'at 500 km range that is 7′ to 2°, i.e. wider than most fields. An object may ' +
        'be in your frame and not in the list, or listed and not in the frame. Ages ' +
        'are measured against the simulation clock.'));
    }
  }

  /** Merge a TlePayload into the catalogue and report what changed. */
  function acceptPayload(tag, payload, status, replace) {
    const res = SAT.state.addTles(tag, payload, { replace: !!replace });
    let msg = '✓ ' + res.count + ' objects from ' + (payload.source || tag);
    if (!replace) msg += '  ·  +' + res.added + ' new, ' + res.updated + ' updated';
    if (res.bad) msg += '  ·  ' + res.bad + ' unparseable';
    if (payload.stale) msg += '  ·  served from stale disk cache (network failed)';
    // Server-side caveats (round 21) — e.g. "legacy TLE file: post-2026-07
    // objects absent" — must reach the user, not just sit in the JSON.
    if (payload.notes && payload.notes.length) msg += '  ·  ' + payload.notes.join('  ·  ');
    status.textContent = msg;
    status.className = payload.stale ? 'warn' : 'dim';
    return res;
  }

  /** Two-click confirm for a source clear — house pattern, no modal. */
  function clearButton(tag, label, status) {
    const U = SAT.util;
    let armed = null;
    const btn = U.el('button', { class: 'btn small danger', title: 'Remove every ' + label + ' object from the catalogue' }, '✕ clear');
    btn.addEventListener('click', () => {
      if (!armed) {
        btn.textContent = '⚠ clear ' + label + '?';
        armed = setTimeout(() => { armed = null; btn.textContent = '✕ clear'; }, 5000);
        return;
      }
      clearTimeout(armed); armed = null;
      btn.textContent = '✕ clear';
      SAT.state.clearSource(tag);
      status.textContent = '✓ ' + label + ' objects removed';
      status.className = 'dim';
    });
    return btn;
  }

  // ---- styles --------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById('src-style')) return;
    const s = document.createElement('style');
    s.id = 'src-style';
    s.textContent =
      '.src-head{padding:6px 8px;border-bottom:1px solid var(--border);}' +
      '.src-summary{font-size:12px;margin-bottom:4px;}' +
      '.src-banner{font-size:12px;line-height:1.45;padding:5px 8px;border-radius:3px;' +
        'border:1px solid transparent;}' +
      '.src-banner.src-warn{color:#ffb84f;background:rgba(255,184,79,0.08);' +
        'border-color:rgba(255,184,79,0.40);}' +
      '.src-srcline{font-size:11.5px;line-height:1.5;padding:1px 8px;border-radius:3px;' +
        'font-variant-numeric:tabular-nums;}' +
      '.src-srcline.src-ok{color:#9aa4ae;}' +
      '.src-srcline.src-ok b{color:#7ad97a;font-weight:600;}' +
      '.src-srcline.src-danger{color:#ff8a65;background:rgba(255,82,82,0.08);}' +
      '.src-srcline.src-danger b{font-weight:600;}' +
      '.src-note{margin-top:3px;font-size:11px;color:#9aa4ae;opacity:.9;padding:0 8px;}' +
      '.src-full{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:7px;}' +
      '.src-hint{font-size:11px;color:#9aa4ae;margin-top:4px;}';
    document.head.appendChild(s);
  }

  // ---- window --------------------------------------------------------------

  function init(body, win) {
    const U = SAT.util;
    injectStyle();

    headerHost = U.el('div');

    // ---------- top billing: the full catalogue ----------
    // This is the action the tool exists for: identification against everything,
    // including the debris and rocket bodies unexpected trails usually turn out to
    // be. Buttons, not menu entries inside tabs, for that reason. Round 21: TWO
    // providers, each named on its button with a source note beneath — CelesTrak
    // (bulk file, no account) above Space-Track (the complete set, account
    // required) — after the SATCAT metadata button was mistaken for a CelesTrak
    // catalogue loader. Each replaces only its OWN source tag, so the freshness
    // block's provenance stays truthful whichever is pressed; selected-object
    // queries live in the tabs below.
    const ctStatus = U.el('span', { class: 'dim', style: 'font-size:11px' }, '');
    const ctGo = async (refresh) => {
      if (ctBtn.disabled) return;
      busy(ctBtn, ctStatus, refresh
        ? 'Re-fetching the CelesTrak full catalogue…'
        : 'Fetching the CelesTrak full catalogue…');
      ctRefresh.disabled = true;
      try {
        const d = await api('/api/celestrak/full' + (refresh ? '?refresh=1' : ''));
        ctBtn.disabled = false; ctRefresh.disabled = false;
        acceptPayload('celestrak', d, ctStatus, true);   // replaces the CelesTrak set
      } catch (e) {
        fail(ctBtn, ctStatus, e);
        ctRefresh.disabled = false;
      }
    };
    const ctBtn = U.el('button', {
      class: 'btn primary', style: 'font-size:13px;padding:5px 12px',
      onclick: () => ctGo(false),
    }, 'Load full catalogue (CelesTrak)');
    const ctRefresh = U.el('button', {
      class: 'btn', title: 'Bypass the 6 h disk cache and re-fetch from CelesTrak',
      onclick: () => ctGo(true),
    }, '⟳ Force refresh');

    const fullStatus = U.el('span', { class: 'dim', style: 'font-size:11px' }, '');
    const fullGo = async (refresh) => {
      if (fullBtn.disabled) return;
      busy(fullBtn, fullStatus, refresh
        ? 'Re-fetching the full catalogue (Space-Track login can take ~10 s)…'
        : 'Fetching the full catalogue…');
      fullRefresh.disabled = true;
      try {
        const d = await api('/api/catalog/full' + (refresh ? '?refresh=1' : ''));
        fullBtn.disabled = false; fullRefresh.disabled = false;
        acceptPayload('spacetrack', d, fullStatus, true);   // replaces the Space-Track set
      } catch (e) {
        fail(fullBtn, fullStatus, e);
        fullRefresh.disabled = false;
        // The 401 message names the Space-Track section as the fix — put the user
        // in front of it rather than making them hunt for the right tab.
        if (/credential/i.test(String(e && e.message))) showTab('Space-Track');
      }
    };
    const fullBtn = U.el('button', {
      class: 'btn primary', style: 'font-size:13px;padding:5px 12px',
      onclick: () => fullGo(false),
    }, 'Load full catalogue (Space-Track)');
    const fullRefresh = U.el('button', {
      class: 'btn', title: 'Bypass the 6 h disk cache and re-fetch from Space-Track',
      onclick: () => fullGo(true),
    }, '⟳ Force refresh');

    body.appendChild(U.el('div', { class: 'src-head' }, [
      headerHost,
      // Hints are credentials-only (round 21 follow-up, user request): the
      // button labels already name the provider, and caveats like the
      // legacy-file warning arrive via payload notes[] on the status line —
      // shown when they actually apply instead of as standing text.
      U.el('div', { class: 'src-full' }, [ctBtn, ctRefresh, ctStatus]),
      U.el('div', { class: 'src-hint' }, 'No account needed.'),
      U.el('div', { class: 'src-full' }, [fullBtn, fullRefresh, fullStatus]),
      U.el('div', { class: 'src-hint' },
        'Free space-track.org account required — saved in the Space-Track tab below.'),
    ]));

    // ---------- tabs ----------
    const tabs = ['Space-Track', 'CelesTrak', 'McCants', 'Paste TLE', 'Cache'];
    const panes = {};
    const tabBtns = {};
    const tabBar = U.el('div', { class: 'row', style: 'gap:2px;margin-bottom:8px;flex-wrap:wrap' });
    const paneHost = U.el('div');

    function showTab(name) {
      tabs.forEach(t => {
        panes[t].style.display = t === name ? '' : 'none';
        tabBtns[t].classList.toggle('primary', t === name);
      });
      if (name === 'Cache') refreshCache();
    }
    tabs.forEach(t => {
      tabBtns[t] = U.el('button', { class: 'btn small', onclick: () => showTab(t) }, t);
      tabBar.appendChild(tabBtns[t]);
      panes[t] = U.el('div', { style: 'display:none' });
      paneHost.appendChild(panes[t]);
    });

    // ---------- Space-Track ----------
    {
      const idIn = U.el('input', { class: 'input', placeholder: 'identity (email)', style: 'width:190px' });
      const pwIn = U.el('input', { class: 'input', type: 'password', placeholder: 'password', style: 'width:150px' });
      const saveChk = U.el('input', { type: 'checkbox', checked: true });
      const credNote = U.el('span', { class: 'dim', style: 'font-size:11px' }, '');
      api('/api/spacetrack/config').then(d => {
        if (d.identity) idIn.value = d.identity;
        if (d.hasPassword) credNote.textContent = '(saved credentials on file — leave password blank to use them)';
      }).catch(() => {});
      const qType = U.el('select', { class: 'select' }, [
        U.el('option', { value: 'norad' }, 'NORAD IDs'),
        U.el('option', { value: 'intldes' }, 'INTLDES / COSPAR'),
        U.el('option', { value: 'name' }, 'Name contains'),
      ]);
      const Q_HINT = {
        norad: '25544, 100057, …',
        intldes: '2026-162A or 98067A (partial ok)',
        name: 'e.g. LACROSSE',
      };
      // narrow on purpose (round 13): the row must fit selector + value + button
      // in the default window width
      const qVal = U.el('input', { class: 'input', placeholder: Q_HINT.norad, style: 'width:130px' });
      qType.addEventListener('change', () => {
        qVal.placeholder = Q_HINT[qType.value] || '';
      });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const btn = U.el('button', {
        class: 'btn primary', onclick: async () => {
          busy(btn, status, 'Querying Space-Track… (login + query, can take ~10 s)');
          try {
            const d = await api('/api/spacetrack/tle', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                identity: idIn.value.trim() || undefined,
                password: pwIn.value || undefined,
                save: saveChk.checked,
                query: { type: qType.value, value: qVal.value.trim() },
              }),
            });
            btn.disabled = false; pwIn.value = '';
            api('/api/spacetrack/config').then(c => {
              if (c.hasPassword) credNote.textContent = '(saved credentials on file — leave password blank to use them)';
            }).catch(() => {});
            // one-off queries ADD to the Space-Track set; the full catalogue
            // (button above) replaces it
            acceptPayload('spacetrack', d, status, false);
          } catch (e) { fail(btn, status, e); }
        },
      }, 'Fetch');
      panes['Space-Track'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [idIn, pwIn,
          U.el('label', { class: 'chk' }, [saveChk, 'save']), credNote]),
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'Query'), qType, qVal, btn]),
        U.el('div', { class: 'src-hint' },
          'Credentials are stored locally (data/config.json) and used by ' +
          'Load full catalogue above. Queries merge additively.'),
        status,
      ]));
    }

    // ---------- CelesTrak ----------
    // Object queries only — no group fetch (see the module header). Ported from
    // SatObserver's TLE Sources panel, round 13.
    {
      const qType = U.el('select', { class: 'select' }, [
        U.el('option', { value: 'norad' }, 'NORAD IDs'),
        U.el('option', { value: 'intldes' }, 'INTLDES / COSPAR'),
        U.el('option', { value: 'name' }, 'Name contains'),
      ]);
      const Q_HINT = {
        norad: '25544, 48274, … (≤20)',
        intldes: '1998-067A or 98067A',
        name: 'e.g. TIANHE',
      };
      // narrow on purpose (round 13): the row must fit selector + value + buttons
      const qVal = U.el('input', { class: 'input', placeholder: Q_HINT.norad, style: 'width:130px' });
      qType.addEventListener('change', () => { qVal.placeholder = Q_HINT[qType.value] || ''; });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const goQ = async (refresh) => {
        if (!qVal.value.trim() || qBtn.disabled) return;
        busy(qBtn, status, 'Querying CelesTrak…');
        qBtnR.disabled = true;
        try {
          const d = await api('/api/celestrak/query?type=' + qType.value +
            '&value=' + encodeURIComponent(qVal.value.trim()) + (refresh ? '&refresh=1' : ''));
          qBtn.disabled = false; qBtnR.disabled = false;
          acceptPayload('celestrak', d, status, false);   // queries merge additively
        } catch (e) { fail(qBtn, status, e); qBtnR.disabled = false; }
      };
      qVal.addEventListener('keydown', e => { if (e.key === 'Enter') goQ(false); });
      const qBtn = U.el('button', { class: 'btn primary', onclick: () => goQ(false) }, 'Fetch');
      const qBtnR = U.el('button', { class: 'btn', title: 'Bypass 2 h cache', onclick: () => goQ(true) }, '⟳');

      // SATCAT snapshot — METADATA (rcs/type/owner/launch), not TLEs; the same
      // satcat_bulk table that enriches every fetch and feeds the info panel.
      // Round 21: labelled "metadata" loudly, with a hint — this button used to
      // say "Fetch full SATCAT" and was mistaken for a catalogue loader (it
      // adds no objects); the full catalogue buttons live at the top now.
      const scStatus = U.el('span', { class: 'dim', style: 'font-size:11px' }, '');
      function scShow(d) {
        scStatus.textContent = d.present
          ? d.count.toLocaleString('en-US') + ' records on file · fetched ' +
            (d.fetched || '').slice(0, 10) + (d.stale ? ' (stale — network failed)' : '')
          : 'not downloaded yet — info panels look objects up one by one';
      }
      api('/api/satcat/bulk?status=1').then(scShow).catch(() => {});
      const scBtn = U.el('button', {
        class: 'btn small',
        title: 'Download the complete CelesTrak SATCAT metadata table (satcat.csv, ' +
          '~7 MB): radar cross-section, object type, owner and launch data used by ' +
          'the photometry tiers and the info panel. Adds NO objects to the catalogue ' +
          '— to load elements use "Load full catalogue (CelesTrak)" at the top',
        onclick: async () => {
          scBtn.disabled = true;
          scStatus.textContent = 'downloading satcat.csv…';
          try { scShow(await api('/api/satcat/bulk?refresh=1&status=1')); }
          catch (e) { scStatus.textContent = '✗ ' + (e && e.message ? e.message : e); }
          scBtn.disabled = false;
        },
      }, 'Fetch SATCAT metadata');

      panes['CelesTrak'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'Object'),
          qType, qVal, qBtn, qBtnR, clearButton('celestrak', 'CelesTrak', status)]),
        U.el('div', { class: 'src-hint' },
          'Single-object gp.php queries, no account; results merge additively. ' +
          'Group fetch is deliberately absent — a subset makes a negative ' +
          'result meaningless.'),
        status,
        U.el('div', { class: 'sep' }),
        U.el('div', { class: 'row' }, [scBtn, scStatus]),
        U.el('div', { class: 'src-hint' },
          'Metadata only (RCS / type / owner / launch) — does not load ' +
          'orbital elements.'),
      ]));
    }

    // ---------- McCants ----------
    {
      const urlIn = U.el('input', {
        class: 'input', style: 'width:320px', list: 'src-mccants-urls',
        value: 'https://www.mmccants.org/tles/classfd.zip',
      });
      const dl = U.el('datalist', { id: 'src-mccants-urls' }, [
        U.el('option', { value: 'https://www.mmccants.org/tles/classfd.zip' }),
        U.el('option', { value: 'https://www.mmccants.org/tles/inttles.zip' }),
        U.el('option', { value: 'https://www.prismnet.com/~mmccants/tles/classfd.zip' }),
      ]);
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const btn = U.el('button', {
        class: 'btn primary', onclick: async () => {
          busy(btn, status, 'Downloading ' + urlIn.value + ' …');
          try {
            const d = await api('/api/mccants/tle', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: urlIn.value.trim() }),
            });
            btn.disabled = false;
            // additive: classfd + inttles are complementary files, not alternatives
            acceptPayload('mccants', d, status, false);
          } catch (e) { fail(btn, status, e); }
        },
      }, 'Fetch');
      panes['McCants'].appendChild(U.el('div', null, [
        U.el('div', { class: 'row' }, [U.el('span', { class: 'dim' }, 'Zip / TLE URL'), urlIn, btn,
          clearButton('mccants', 'McCants', status), dl]),
        U.el('div', { class: 'src-hint' },
          'Classified TLE zips (or any .zip/.tle/.txt URL) — objects absent ' +
          'from the public catalogue. Files merge.'),
        status,
      ]));
    }

    // ---------- Paste TLE ----------
    {
      const ta = U.el('textarea', {
        class: 'input', rows: 8, style: 'width:100%;resize:vertical',
        placeholder: 'Paste 2-line or 3-line element sets here…',
      });
      const labelIn = U.el('input', { class: 'input', placeholder: 'label (optional)', style: 'width:160px' });
      const status = U.el('div', { class: 'dim', style: 'margin-top:6px' }, '');
      const btn = U.el('button', {
        class: 'btn primary', onclick: async () => {
          busy(btn, status, 'Parsing…');
          try {
            const d = await api('/api/text/tle', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: ta.value, label: labelIn.value.trim() || 'pasted' }),
            });
            btn.disabled = false;
            acceptPayload('paste', d, status, false);
            ta.value = '';        // accepted — an un-cleared box invites double-pasting
          } catch (e) { fail(btn, status, e); }
        },
      }, 'Add to catalogue');
      panes['Paste TLE'].appendChild(U.el('div', null, [
        ta,
        U.el('div', { class: 'row', style: 'margin-top:6px' }, [labelIn, btn,
          clearButton('paste', 'pasted', status)]),
        U.el('div', { class: 'src-hint' },
          'Pastes merge (newest elements win) and persist across restarts; ' +
          '✕ clear removes them.'),
        status,
      ]));
    }

    // ---------- Cache ----------
    const cacheHost = U.el('div');
    panes['Cache'].appendChild(cacheHost);

    /** A cache entry re-merges under the tag it came from, inferred from its key —
     *  loading a cached McCants file as "spacetrack" would corrupt the per-source
     *  statistics that are the whole point of the header. */
    function tagForCacheKey(key) {
      if (/^mccants_/.test(key)) return 'mccants';
      if (/^celestrak_/.test(key)) return 'celestrak';
      if (/^spacetrack_/.test(key) || key === 'catalog_full') return 'spacetrack';
      return 'paste';
    }

    async function refreshCache() {
      clear(cacheHost);
      const status = U.el('div', { class: 'dim' }, '… loading cache list');
      cacheHost.appendChild(status);
      try {
        const d = await api('/api/cache');
        clear(cacheHost);
        if (!d.entries.length) {
          cacheHost.appendChild(U.el('div', { class: 'msg-empty' },
            'Nothing cached yet — fetch a catalogue above and it will appear here.'));
          return;
        }
        const tbl = U.el('table', { class: 'table' });
        tbl.appendChild(U.el('thead', null, U.el('tr', null,
          ['Source', 'Fetched (UTC)', 'Objects', ''].map(h => U.el('th', null, h)))));
        const tb = U.el('tbody');
        d.entries.sort((a, b) => (b.fetched || '').localeCompare(a.fetched || ''));
        d.entries.forEach(en => {
          const loadBtn = U.el('button', {
            class: 'btn small', onclick: async () => {
              try {
                const payload = await api('/api/cache/' + encodeURIComponent(en.key));
                acceptPayload(tagForCacheKey(en.key), payload, status, false);
              } catch (e) { status.textContent = '✗ ' + e.message; status.className = 'err'; }
            },
          }, 'Load');
          // Destructive: the second click within 5 s does it. No modal — the house
          // pattern is a re-labelled button, and it keeps the list on screen.
          let armed = null;
          const delBtn = U.el('button', { class: 'btn small danger' }, '✕');
          delBtn.addEventListener('click', async () => {
            if (!armed) {
              delBtn.textContent = '⚠ delete?';
              armed = setTimeout(() => {
                armed = null; delBtn.textContent = '✕';
              }, 5000);
              return;
            }
            clearTimeout(armed); armed = null;
            try { await api('/api/cache/' + encodeURIComponent(en.key), { method: 'DELETE' }); refreshCache(); }
            catch (e) { status.textContent = '✗ ' + e.message; status.className = 'err'; }
          });
          tb.appendChild(U.el('tr', null, [
            U.el('td', null, en.source || en.key),
            U.el('td', { class: 'num' }, (en.fetched || '').replace('T', ' ').slice(0, 19)),
            U.el('td', { class: 'num' }, String(en.count != null ? en.count : '—')),
            U.el('td', null, [loadBtn, ' ', delBtn]),
          ]));
        });
        tbl.appendChild(tb);
        cacheHost.appendChild(tbl);
        cacheHost.appendChild(status);
        status.textContent = '';
      } catch (e) {
        status.textContent = '✗ ' + e.message;
        status.className = 'err';
      }
    }

    body.appendChild(U.el('div', { class: 'pane' }, [tabBar, paneHost]));
    showTab('Space-Track');

    // The statistics are time-dependent: a set that was fresh when fetched is stale
    // by the time the user has driven the clock a week forward, and it must say so.
    SAT.bus.on('catalog-changed', refreshHeader);
    SAT.bus.on('state-loaded', refreshHeader);
    SAT.bus.on('time', p => { if (p && p.jumped) refreshHeader(); });
    refreshHeader();
  }

  SAT.ui.sources = { init };
})();
