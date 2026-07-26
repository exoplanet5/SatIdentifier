/* SAT.ui.locations — observing sites.
 *
 * Ported from SatObserver with two changes forced by the new SAT.state: locations
 * here have no `show` field (there are no maps to show them on), and the active site
 * is not merely a readout preference — it is an input to the scan, so changing it
 * invalidates the result rather than silently leaving crossings computed from
 * somewhere else on Earth.
 */
(function () {
  'use strict';

  function init(body, win) {
    const U = SAT.util;
    const host = U.el('div');

    function commit(geometryChanged) {
      // Every field in this window is scan geometry: the site position is where the
      // topocentric vectors are differenced from. Marking the scan stale is what
      // makes the Crossings header say "parameters changed — rescan" instead of
      // presenting another site's answer as this one's.
      if (geometryChanged !== false) SAT.state.scan.stale = true;
      SAT.state.save();
      SAT.bus.emit('locations-changed', {});
    }

    // Coordinates are stored and shown at 4 decimals (~11 m) — finer than the
    // arcminute-level truth TLEs support, and fixed decimals keep the columns
    // aligned. Widths are ch-based on the longest legal value ("-179.1234").
    const r4 = v => Math.round(v * 1e4) / 1e4;
    const W_NAME = 'width:90px';
    const W_LAT = 'width:calc(8ch + 18px)';
    const W_LON = 'width:calc(9ch + 18px)';
    const W_ALT = 'width:calc(5ch + 18px)';

    // brief red flash on an input whose edit was rejected
    function rejectEdit(input, msg) {
      input.style.borderColor = 'var(--danger)';
      input.title = msg;
      setTimeout(() => { input.style.borderColor = ''; input.title = ''; }, 1200);
    }

    function render() {
      host.innerHTML = '';
      const tbl = U.el('table', { class: 'table' });
      tbl.appendChild(U.el('thead', null, U.el('tr', null,
        ['Act', '', 'Name', 'Lat °N', 'Lon °E', 'Alt m', ''].map(h => U.el('th', null, h)))));
      const tb = U.el('tbody');

      SAT.state.locations.forEach(loc => {
        const act = U.el('input', { type: 'radio', name: 'loc-active', checked: !!loc.active, title: 'active site — the one the scan and every readout use' });
        act.addEventListener('change', () => {
          SAT.state.locations.forEach(l => { l.active = false; });
          loc.active = true; commit(); render();
        });
        const col = U.el('input', { type: 'color', class: 'swatch', value: loc.color || '#ff5252' });
        // Colour is cosmetic, so it does not invalidate a scan that may have taken
        // ten seconds to run.
        col.addEventListener('input', () => { loc.color = col.value; commit(false); });
        const nameIn = U.el('input', { class: 'input', value: loc.name, style: W_NAME });
        nameIn.addEventListener('change', () => { loc.name = nameIn.value.trim() || loc.name; commit(false); });
        const del = U.el('span', {
          class: 'icon-btn', title: 'remove',
          onclick: () => {
            SAT.state.locations = SAT.state.locations.filter(l => l !== loc);
            commit(); render();
          },
        }, '✕');

        // Orbit site row: the three coordinate cells become one NORAD cell plus
        // the LIVE resolution against the loaded catalogue — the site stores only
        // the NORAD, never TLE lines (CONTRACT "Orbital observing stations").
        if ((loc.kind || 'ground') === 'orbit') {
          const nIn = U.el('input', { class: 'input', value: loc.norad != null ? loc.norad : '', style: 'width:calc(6ch + 18px)', title: 'NORAD catalogue number of the observing satellite' });
          nIn.addEventListener('change', () => {
            const v = parseInt(nIn.value, 10);
            if (isFinite(v) && v > 0) { loc.norad = v; commit(); render(); }
            else rejectEdit(nIn, 'NORAD must be a positive integer');
            nIn.value = loc.norad != null ? loc.norad : '';
          });
          const obj = loc.norad != null ? SAT.state.objByNorad(loc.norad) : null;
          const res = U.el('span', {
            class: 'dim',
            style: 'font-size:11px;' + (obj ? '' : 'color:var(--danger)'),
          }, obj ? (obj.name + (obj.intl ? ' · ' + obj.intl : ''))
                 : 'not in catalogue — load one that contains it');
          const cell = U.el('td', null, [
            U.el('span', { class: 'dim', style: 'font-size:11px;margin-right:4px' }, 'NORAD'),
            nIn, U.el('span', null, ' '), res,
          ]);
          cell.colSpan = 3;
          tb.appendChild(U.el('tr', null, [
            U.el('td', null, act), U.el('td', null, col),
            U.el('td', null, nameIn), cell, U.el('td', null, del),
          ]));
          return;
        }

        const latIn = U.el('input', { class: 'input', value: loc.latDeg.toFixed(4), style: W_LAT });
        latIn.addEventListener('change', () => {
          const v = parseFloat(latIn.value);
          if (isFinite(v) && Math.abs(v) <= 90) { loc.latDeg = r4(v); commit(); }
          else rejectEdit(latIn, 'latitude must be a number in −90…90');
          latIn.value = loc.latDeg.toFixed(4);
        });
        const lonIn = U.el('input', { class: 'input', value: loc.lonDeg.toFixed(4), style: W_LON });
        lonIn.addEventListener('change', () => {
          const v = parseFloat(lonIn.value);
          if (isFinite(v) && Math.abs(v) <= 180) { loc.lonDeg = r4(U.wrapLon(v)); commit(); }
          else rejectEdit(lonIn, 'longitude must be a number in −180…180');
          lonIn.value = loc.lonDeg.toFixed(4);
        });
        const altIn = U.el('input', { class: 'input', value: loc.altM, style: W_ALT });
        altIn.addEventListener('change', () => {
          const v = parseFloat(altIn.value);
          if (isFinite(v)) { loc.altM = v; commit(); }
          else rejectEdit(altIn, 'altitude must be a number (meters)');
          altIn.value = loc.altM;
        });
        tb.appendChild(U.el('tr', null, [
          U.el('td', null, act), U.el('td', null, col),
          U.el('td', null, nameIn), U.el('td', null, latIn), U.el('td', null, lonIn),
          U.el('td', null, altIn), U.el('td', null, del),
        ]));
      });
      tbl.appendChild(tb);
      host.appendChild(tbl);
      if (!SAT.state.locations.length) {
        host.appendChild(U.el('div', { class: 'msg-empty' },
          'No observing sites — add one below; the scan cannot run without one.'));
      }
    }

    // add form — two kinds (CONTRACT "Orbital observing stations"): a ground site
    // takes coordinates, an orbit site takes a NORAD picked out of the loaded
    // catalogue. One row, with the kind toggle swapping which inputs show.
    let addKind = 'ground';
    const aName = U.el('input', { class: 'input', placeholder: 'name', style: W_NAME });
    const aLat = U.el('input', { class: 'input', placeholder: 'lat °N', style: W_LAT });
    const aLon = U.el('input', { class: 'input', placeholder: 'lon °E', style: W_LON });
    const aAlt = U.el('input', { class: 'input', placeholder: 'alt m', style: W_ALT, value: '0' });
    const aErr = U.el('span', { class: 'err' }, '');

    // NORAD picker: type a number or a name fragment, pick from the catalogue.
    // The datalist alternative chokes on 32 k options; eight suggestions suffice.
    let picked = null;   // the catalogue object chosen from the suggestions
    const aNorad = U.el('input', {
      class: 'input', placeholder: 'NORAD or name — type to search',
      style: 'width:210px',
    });
    const sug = U.el('div', {
      style: 'position:absolute;left:0;top:100%;z-index:40;display:none;' +
        'background:var(--panel,#141a21);border:1px solid var(--border);' +
        'border-radius:4px;min-width:260px;max-height:170px;overflow-y:auto;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.5)',
    });
    const noradWrap = U.el('span', { style: 'position:relative;display:none' }, [aNorad, sug]);

    function hideSug() { sug.style.display = 'none'; sug.innerHTML = ''; }
    function showSug(list, note) {
      sug.innerHTML = '';
      if (note) {
        sug.appendChild(U.el('div', { class: 'dim', style: 'padding:4px 8px;font-size:11px' }, note));
      }
      list.forEach(o => {
        const it = U.el('div', {
          style: 'padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap',
          onmousedown: (ev) => {           // mousedown: fires before the input's blur
            ev.preventDefault();
            picked = o;
            aNorad.value = String(o.norad);
            if (!aName.value.trim()) aName.placeholder = o.name;
            hideSug();
          },
        }, o.norad + ' · ' + o.name + (o.intl ? ' · ' + o.intl : ''));
        it.addEventListener('mouseenter', () => { it.style.background = 'rgba(79,195,247,.15)'; });
        it.addEventListener('mouseleave', () => { it.style.background = ''; });
        sug.appendChild(it);
      });
      sug.style.display = 'block';
    }
    aNorad.addEventListener('input', () => {
      picked = null;
      const q = aNorad.value.trim();
      if (q.length < 1) { hideSug(); return; }
      const objs = (SAT.state.catalog && SAT.state.catalog.objs) || [];
      if (!objs.length) { showSug([], 'no catalogue loaded — Catalogue window first'); return; }
      const qU = q.toUpperCase();
      const out = [];
      for (let i = 0; i < objs.length && out.length < 8; i++) {
        const o = objs[i];
        if (String(o.norad).indexOf(q) === 0 ||
            (o.name && o.name.toUpperCase().indexOf(qU) >= 0)) out.push(o);
      }
      showSug(out, out.length ? null : 'no match in the loaded catalogue');
    });
    aNorad.addEventListener('blur', () => { setTimeout(hideSug, 150); });

    const kindBtns = [['ground', 'Ground'], ['orbit', 'Orbit']].map(([k, label]) => {
      const b = U.el('button', {
        class: 'btn small' + (k === addKind ? ' on' : ''),
        title: k === 'ground' ? 'a fixed site: latitude / longitude / altitude'
          : 'an orbital station: observe FROM a satellite in the loaded catalogue',
        onclick: () => {
          addKind = k;
          kindBtns.forEach(x => x.btn.classList.toggle('on', x.kind === k));
          const g = k === 'ground';
          aLat.style.display = aLon.style.display = aAlt.style.display = g ? '' : 'none';
          noradWrap.style.display = g ? 'none' : 'inline-block';
          aErr.textContent = '';
        },
      }, label);
      return { kind: k, btn: b };
    });

    const addBtn = U.el('button', {
      class: 'btn primary small', onclick: () => {
        aErr.textContent = '';
        if (addKind === 'orbit') {
          const norad = picked ? picked.norad : parseInt(aNorad.value.trim(), 10);
          if (!isFinite(norad) || norad <= 0) {
            aErr.textContent = 'type a NORAD number or pick an object from the search';
            return;
          }
          const obj = picked || SAT.state.objByNorad(norad);
          if (!obj) { aErr.textContent = 'NORAD ' + norad + ' is not in the loaded catalogue'; return; }
          SAT.state.locations.push({
            id: U.uuid('loc'), kind: 'orbit',
            name: aName.value.trim() || obj.name || ('NORAD ' + norad),
            norad: norad, latDeg: 0, lonDeg: 0, altM: 0,
            active: SAT.state.locations.length === 0, color: '#7e57c2',
          });
          aName.value = aNorad.value = ''; picked = null; aName.placeholder = 'name';
          commit(); render();
          return;
        }
        const lat = parseFloat(aLat.value), lon = parseFloat(aLon.value), alt = parseFloat(aAlt.value) || 0;
        if (!isFinite(lat) || Math.abs(lat) > 90) { aErr.textContent = 'lat must be −90…90'; return; }
        if (!isFinite(lon) || Math.abs(lon) > 180) { aErr.textContent = 'lon must be −180…180'; return; }
        SAT.state.locations.push({
          id: U.uuid('loc'), name: aName.value.trim() || 'Site ' + (SAT.state.locations.length + 1),
          latDeg: r4(lat), lonDeg: r4(U.wrapLon(lon)), altM: alt,
          active: SAT.state.locations.length === 0, color: '#ff5252',
        });
        aName.value = aLat.value = aLon.value = ''; aAlt.value = '0';
        commit(); render();
      },
    }, '+ Add');

    body.appendChild(U.el('div', null, [
      host,
      U.el('div', { class: 'pane', style: 'border-top:1px solid var(--border)' }, [
        U.el('div', { class: 'row' },
          kindBtns.map(k => k.btn).concat([aName, aLat, aLon, aAlt, noradWrap, addBtn, aErr])),
        U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:4px' },
          'The active site is where the scan is run from: it sets the topocentric ' +
          'geometry for every crossing, so changing it invalidates the current result. ' +
          'An Orbit site observes from a catalogue satellite (space-based SSA): its TLE ' +
          'is taken live from the loaded catalogue by NORAD number.'),
      ]),
    ]));

    SAT.bus.on('state-loaded', render);
    SAT.bus.on('locations-changed', () => { /* re-render only on structural change done locally */ });
    // orbit rows resolve their NORAD against the catalogue LIVE, so a catalogue
    // load must repaint "not in catalogue" into the object's name
    SAT.bus.on('catalog-changed', render);
    render();
  }

  SAT.ui.locations = { init };
})();
