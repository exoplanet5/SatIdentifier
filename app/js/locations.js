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
        const nameIn = U.el('input', { class: 'input', value: loc.name, style: 'width:130px' });
        nameIn.addEventListener('change', () => { loc.name = nameIn.value.trim() || loc.name; commit(false); });
        const latIn = U.el('input', { class: 'input', value: loc.latDeg, style: 'width:75px' });
        latIn.addEventListener('change', () => {
          const v = parseFloat(latIn.value);
          if (isFinite(v) && Math.abs(v) <= 90) { loc.latDeg = v; commit(); }
          else rejectEdit(latIn, 'latitude must be a number in −90…90');
          latIn.value = loc.latDeg;
        });
        const lonIn = U.el('input', { class: 'input', value: loc.lonDeg, style: 'width:80px' });
        lonIn.addEventListener('change', () => {
          const v = parseFloat(lonIn.value);
          if (isFinite(v) && Math.abs(v) <= 180) { loc.lonDeg = U.wrapLon(v); commit(); }
          else rejectEdit(lonIn, 'longitude must be a number in −180…180');
          lonIn.value = loc.lonDeg;
        });
        const altIn = U.el('input', { class: 'input', value: loc.altM, style: 'width:60px' });
        altIn.addEventListener('change', () => {
          const v = parseFloat(altIn.value);
          if (isFinite(v)) { loc.altM = v; commit(); }
          else rejectEdit(altIn, 'altitude must be a number (meters)');
          altIn.value = loc.altM;
        });
        const del = U.el('span', {
          class: 'icon-btn', title: 'remove',
          onclick: () => {
            SAT.state.locations = SAT.state.locations.filter(l => l !== loc);
            commit(); render();
          },
        }, '✕');
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

    // add form
    const aName = U.el('input', { class: 'input', placeholder: 'name', style: 'width:130px' });
    const aLat = U.el('input', { class: 'input', placeholder: 'lat °N', style: 'width:75px' });
    const aLon = U.el('input', { class: 'input', placeholder: 'lon °E', style: 'width:80px' });
    const aAlt = U.el('input', { class: 'input', placeholder: 'alt m', style: 'width:60px', value: '0' });
    const aErr = U.el('span', { class: 'err' }, '');
    const addBtn = U.el('button', {
      class: 'btn primary small', onclick: () => {
        const lat = parseFloat(aLat.value), lon = parseFloat(aLon.value), alt = parseFloat(aAlt.value) || 0;
        aErr.textContent = '';
        if (!isFinite(lat) || Math.abs(lat) > 90) { aErr.textContent = 'lat must be −90…90'; return; }
        if (!isFinite(lon) || Math.abs(lon) > 180) { aErr.textContent = 'lon must be −180…180'; return; }
        SAT.state.locations.push({
          id: U.uuid('loc'), name: aName.value.trim() || 'Site ' + (SAT.state.locations.length + 1),
          latDeg: lat, lonDeg: U.wrapLon(lon), altM: alt,
          active: SAT.state.locations.length === 0, color: '#ff5252',
        });
        aName.value = aLat.value = aLon.value = ''; aAlt.value = '0';
        commit(); render();
      },
    }, '+ Add');

    body.appendChild(U.el('div', null, [
      host,
      U.el('div', { class: 'pane', style: 'border-top:1px solid var(--border)' }, [
        U.el('div', { class: 'row' }, [aName, aLat, aLon, aAlt, addBtn, aErr]),
        U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:4px' },
          'The active site is where the scan is run from: it sets the topocentric ' +
          'geometry for every crossing, so changing it invalidates the current result.'),
      ]),
    ]));

    SAT.bus.on('state-loaded', render);
    SAT.bus.on('locations-changed', () => { /* re-render only on structural change done locally */ });
    render();
  }

  SAT.ui.locations = { init };
})();
