/* SAT.occultation.eventsUI — independent occultation event table.
 *
 * Visualization responsibility: display and export the transient
 * `SAT.state.occultation` payload. Unless the plan requests `contactsOnly`, rows
 * remain candidates, including complete geometric misses and incomplete records;
 * this table never invents a rank or a calibrated probability and never touches
 * ordinary crossing state.
 */
(function () {
  'use strict';

  const U = SAT.util;
  let body = null;
  let tableWrap = null;
  let summary = null;
  let filterBar = null;
  let selectedId = null;
  let timeZone = 'UTC';
  let selectedClasses = null;
  let selectedTypes = null;
  let filterStateKey = null;
  let sortKey = 'tCaMs';
  let sortAscending = true;
  // DOM nodes scale much worse than the compact event state. Keep exports based
  // on the full state, but render a bounded chronological preview so a partial
  // full-night search cannot crash the renderer while building thousands of rows.
  const MAX_RENDERED_EVENTS = 500;
  const ORBIT_TAGS = [['class', 'leo', 'leo'], ['class', 'meo', 'meo'],
    ['class', 'geo', 'geo'], ['class', 'heo', 'heo']];
  const OBJECT_TAGS = [['type', 'PAY', 'payload'], ['type', 'R/B', 'rocket body'],
    ['type', 'DEB', 'debris']];
  const SCAN_TAGS = ORBIT_TAGS.concat(OBJECT_TAGS);
  const TYPE_LABELS = { PAY: 'payload', 'R/B': 'rocket body', DEB: 'debris', UNK: 'unknown' };

  function currentState() {
    return SAT.state && SAT.state.occultation && typeof SAT.state.occultation === 'object'
      ? SAT.state.occultation : { events: [], stats: {}, status: 'idle' };
  }

  function fmtTime(ms, local) {
    if (ms == null || !isFinite(Number(ms))) return '—';
    const date = new Date(Number(ms));
    if (!local) return U.fmtDate(date);
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
        minute: '2-digit', second: '2-digit', hour12: false }).format(date);
    } catch (error) { return U.fmtDate(date); }
  }

  function num(value, digits, suffix) {
    return value == null || !isFinite(Number(value)) ? '—' : Number(value).toFixed(digits) + (suffix || '');
  }

  function eventLabel(event) {
    return event && event.eventId ? String(event.eventId) : '';
  }

  function contactLabel(event) {
    if (!event) return '—';
    if (event.contactStatus === 'contact' || event.contactStatus === 'grazing') {
      return event.contactStatus;
    }
    if (event.contactStatus === 'miss') return 'geometric miss';
    return event.contactStatus || 'incomplete';
  }

  function flagsText(event) {
    return Array.isArray(event && event.flags) && event.flags.length
      ? event.flags.join(', ') : '—';
  }

  function normaliseList(value, upper) {
    if (value == null) return null;
    const values = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
    return new Set(values.map((item) => String(item).trim())
      .filter(Boolean).map((item) => upper ? item.toUpperCase() : item.toLowerCase()));
  }

  function eventClass(event) {
    const value = event && (event.cls != null ? event.cls : event.orbitClass);
    const cls = value == null ? '' : String(value).trim().toLowerCase();
    return ['leo', 'meo', 'geo', 'heo'].indexOf(cls) >= 0 ? cls : '';
  }

  function eventType(event) {
    const value = event && event.type;
    const type = value == null ? '' : String(value).trim().toUpperCase();
    return type === 'PAY' || type === 'R/B' || type === 'DEB' ? type : 'UNK';
  }

  function normaliseTag(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function normaliseTypeTag(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (raw === 'pay' || raw === 'payload') return 'PAY';
    if (raw === 'r/b' || raw === 'rocket body' || raw === 'rocket-body') return 'R/B';
    if (raw === 'deb' || raw === 'debris') return 'DEB';
    if (raw === 'unk' || raw === 'unknown') return 'UNK';
    return '';
  }

  function splitStoredTags(value) {
    const classes = [], types = [];
    const values = Array.isArray(value) ? value : (value == null ? [] : String(value).split(/[\s,]+/));
    values.forEach((item) => {
      const raw = normaliseTag(item);
      if (['leo', 'meo', 'geo', 'heo'].indexOf(raw) >= 0 && classes.indexOf(raw) < 0) {
        classes.push(raw);
      }
      const type = normaliseTypeTag(item);
      if (type && types.indexOf(type) < 0) types.push(type);
    });
    return { classes: classes.length ? new Set(classes) : null,
      types: types.length ? new Set(types) : null };
  }

  function syncFilters(state, events) {
    const first = events.length ? eventLabel(events[0]) : '';
    const key = String(state.updatedAtMs == null ? '' : state.updatedAtMs) + ':' +
      events.length + ':' + first + ':' + JSON.stringify(state.options || {});
    if (key === filterStateKey) return;
    filterStateKey = key;
    const options = state.options || {};
    selectedClasses = normaliseList(options.satelliteClasses, false);
    selectedTypes = normaliseList(options.satelliteTypes, true);
    if (selectedClasses == null && options.satelliteTags != null) {
      const stored = splitStoredTags(options.satelliteTags);
      selectedClasses = stored.classes;
      if (selectedTypes == null) selectedTypes = stored.types;
    }
  }

  function matchesFilters(event) {
    return (!selectedClasses || selectedClasses.has(eventClass(event))) &&
      (!selectedTypes || selectedTypes.has(eventType(event)));
  }

  function filteredEvents(state) {
    const events = Array.isArray(state.events) ? state.events : [];
    syncFilters(state, events);
    return events.filter(matchesFilters);
  }

  function sortValue(event, key) {
    const star = event && event.candidate || {};
    if (key === 'satellite') return (event && event.name || event && event.satId || '') +
      (event && event.norad == null ? '' : ' #' + event.norad);
    if (key === 'star') return event && event.starKey || '';
    if (key === 'cls' || key === 'orbitClass') return eventClass(event);
    if (key === 'tags') return [eventClass(event), TYPE_LABELS[eventType(event)] || ''].filter(Boolean).join(' · ');
    if (key === 'starMag') return star.mag;
    if (key === 'contact') return contactLabel(event);
    if (key === 'flags') return flagsText(event);
    return event ? event[key] : null;
  }

  function compareValues(a, b, key) {
    const av = sortValue(a, key), bv = sortValue(b, key);
    const an = Number(av), bn = Number(bv);
    const aNum = av != null && av !== '' && isFinite(an);
    const bNum = bv != null && bv !== '' && isFinite(bn);
    if (!aNum && !bNum) return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv));
    if (!aNum) return 1;
    if (!bNum) return -1;
    return an - bn;
  }

  function sortedEvents(events) {
    return events.slice().sort((a, b) => {
      const cmp = compareValues(a, b, sortKey);
      return (sortAscending ? cmp : -cmp) || eventLabel(a).localeCompare(eventLabel(b));
    });
  }

  function setSort(key) {
    if (sortKey === key) sortAscending = !sortAscending;
    else { sortKey = key; sortAscending = true; }
    render();
  }

  function sortIndicator(key) {
    return sortKey === key ? (sortAscending ? ' ▲' : ' ▼') : '';
  }

  function filterButton(label, checked, onclick) {
    return U.el('button', { class: 'btn small occ-filter-button', title: checked
      ? 'Remove ' + label + ' filter' : 'Add ' + label + ' filter', onclick: onclick },
      (checked ? '✓ ' : '○ ') + label);
  }

  function renderFilterGroup(title, values, selected, setter) {
    const group = U.el('span', { class: 'occ-filter-group' }, [
      U.el('span', { class: 'occ-filter-title' }, title),
    ]);
    values.forEach(([kind, value, label]) => {
      const canonical = kind === 'class' ? normaliseTag(value) : normaliseTypeTag(value);
      const current = kind === 'class' ? selectedClasses : selectedTypes;
      const allValues = values.filter((item) => item[0] === kind)
        .map((item) => item[1]).map((item) => kind === 'class' ? normaliseTag(item) : normaliseTypeTag(item));
      const checked = !current || current.has(canonical);
      group.appendChild(filterButton(label, checked, () => {
        let next = current ? new Set(current) : new Set(allValues);
        if (next.has(canonical)) next.delete(canonical); else next.add(canonical);
        if (kind === 'class') setter('class', next, allValues.length);
        else setter('type', next, allValues.length);
        render();
      }));
    });
    return group;
  }

  function renderFilters(state, events) {
    if (!filterBar) return;
    filterBar.textContent = '';
    filterBar.appendChild(renderFilterGroup('Scan tags', SCAN_TAGS,
      null, (kind, value, allCount) => {
        if (kind === 'class') selectedClasses = value.size === allCount ? null : value;
        else selectedTypes = value.size === allCount ? null : value;
      }));
    filterBar.appendChild(U.el('button', { class: 'btn small', onclick: () => {
      selectedClasses = null; selectedTypes = null; render();
    } }, 'All'));
    filterBar.appendChild(U.el('span', { class: 'occ-filter-hint' },
      'Click numeric headers to sort quantitative results'));
  }

  async function download(name, mime, text) {
    try {
      // A Blob URL can be interpreted as a navigation by macOS WKWebView.
      // Route desktop exports through pywebview's native save dialog so the
      // application window remains on the current page.
      if (typeof window !== 'undefined' && window.pywebview &&
          window.pywebview.api && typeof window.pywebview.api.save_export === 'function') {
        return await window.pywebview.api.save_export(name, mime, text);
      }
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = U.el('a', { href: url, download: name });
      link.addEventListener('click', (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      });
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { ok: true };
    } catch (error) { console.warn('occultation export failed:', error); }
  }

  function jsonExport() {
    download('occultation-events.json', 'application/json',
      JSON.stringify(currentState(), null, 2));
  }

  function csvCell(value) {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function csvExport() {
    const state = currentState();
    const rows = [['eventId', 'utc', 'local', 'satellite', 'norad', 'orbitClass', 'type',
      'starKey', 'starVmag', 'azDeg', 'elDeg', 'closestSeparationArcsec', 'contact',
      'angularDiameterArcsec', 'durationMs', 'flags']];
    sortedEvents(filteredEvents(state)).forEach((event) => rows.push([
      eventLabel(event), fmtTime(event.tCaMs, false), fmtTime(event.tCaMs, true),
      event.name || event.satId || '', event.norad == null ? '' : event.norad,
      eventClass(event), TYPE_LABELS[eventType(event)] || '', event.starKey || '', event.candidate && event.candidate.mag,
      event.azDeg, event.elDeg,
      event.nominalSeparationArcsec, contactLabel(event), event.angularDiameterArcsec,
      event.durationMs, flagsText(event),
    ]));
    download('occultation-events.csv', 'text/csv;charset=utf-8',
      rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }

  function choose(event) {
    selectedId = eventLabel(event);
    // The main Sky Chart is already visible in the normal desktop layout, but it
    // may have been closed while the results window stayed open. Open it before
    // emitting the selection so its listener can focus the chart immediately.
    const chartWindow = SAT.windows && SAT.windows.get
      ? SAT.windows.get('chart') : null;
    if (chartWindow && !chartWindow.isOpen()) chartWindow.open();
    if (SAT.bus && typeof SAT.bus.emit === 'function') {
      SAT.bus.emit('occultation-selection-changed', { eventId: selectedId, event: event });
    }
    render();
  }

  function cell(text, className, title) {
    return U.el('td', { class: className || '', title: title || null }, text);
  }

  function render() {
    if (!tableWrap) return;
    const state = currentState();
    const events = Array.isArray(state.events) ? state.events : [];
    syncFilters(state, events);
    renderFilters(state, events);
    const matchingEvents = filteredEvents(state);
    const visibleEvents = sortedEvents(matchingEvents).slice(0, MAX_RENDERED_EVENTS);
    const pipeline = state.pipeline || {};
    const passConfig = pipeline.config && pipeline.config.pass ? pipeline.config.pass : {};
    if (passConfig.timeZone) timeZone = String(passConfig.timeZone);
    if (selectedId && !visibleEvents.some((event) => eventLabel(event) === selectedId)) selectedId = null;
    if (!selectedId && visibleEvents.length) selectedId = eventLabel(visibleEvents[0]);
    const stats = state.stats || {};
    const contactsOnly = !!(state.options && state.options.contactsOnly);
    const matchingContacts = matchingEvents.filter((event) =>
      event.contactStatus === 'contact' || event.contactStatus === 'grazing').length;
    const matchingMisses = matchingEvents.filter((event) => event.contactStatus === 'miss').length;
    summary.textContent = (state.status || 'idle') + ' · ' + matchingEvents.length + ' of ' +
      events.length + ' event records · ' +
      matchingContacts + ' geometric contacts · ' +
      (contactsOnly ? (stats.filteredMisses || 0) + ' misses filtered'
        : matchingMisses + ' misses') +
      (visibleEvents.length < matchingEvents.length
        ? ' · showing first ' + visibleEvents.length + ' in current sort' : '');
    tableWrap.textContent = '';
    if (!events.length) {
      tableWrap.appendChild(U.el('div', { class: 'msg-empty' }, state.status === 'idle'
        ? 'Run an occultation search from Occultation Plan.'
        : 'No candidate events for this configuration.'));
      return;
    }
    if (!matchingEvents.length) {
      tableWrap.appendChild(U.el('div', { class: 'msg-empty' },
        'No events match the current SatIdentifier scan-tag filters.'));
      return;
    }
    const table = U.el('table', { class: 'table occ-table' });
    const header = (label, key, title) => U.el('th', { title: title || 'Click to sort' },
      U.el('button', { class: 'occ-sort-button', onclick: () => setSort(key) },
        label + sortIndicator(key)));
    table.appendChild(U.el('thead', null, U.el('tr', null, [
      header('UTC closest', 'tCaMs'), header('Local', 'tCaMs'),
      header('Satellite', 'satellite'), header('Class', 'cls'), header('Type', 'type'),
      header('Star', 'star'), header('V', 'starMag'), header('Az°', 'azDeg'),
      header('El°', 'elDeg'), header('Sep″', 'nominalSeparationArcsec',
        'Quantitative closest-approach separation; click to sort'),
      header('Contact', 'contact'), header('Size″', 'angularDiameterArcsec'),
      header('Duration ms', 'durationMs'), header('Flags', 'flags'),
    ])));
    const tbody = U.el('tbody');
    visibleEvents.forEach((event) => {
      const selected = eventLabel(event) === selectedId;
      const star = event.candidate || {};
      const row = U.el('tr', { class: selected ? 'sel' : '',
        onclick: () => choose(event) }, [
        cell(fmtTime(event.tCaMs, false), 'num'),
        cell(fmtTime(event.tCaMs, true), 'num'),
        cell((event.name || event.satId || '—') + (event.norad == null ? '' : ' #' + event.norad), null,
          'TLE age: ' + num(event.tleAgeDays, 2, ' d')),
        cell(eventClass(event) || '—'),
        cell(TYPE_LABELS[eventType(event)] || '—'),
        cell(event.starKey || '—', null,
          star.raDeg == null ? '' : 'J2000 RA ' + num(star.raDeg, 5) + '°, Dec ' + num(star.decDeg, 5) + '°'),
        cell(num(star.mag, 2), 'num'),
        cell(num(event.azDeg, 3, '°'), 'num'),
        cell(num(event.elDeg, 3, '°'), 'num'),
        cell(num(event.nominalSeparationArcsec, 3, '″'), 'num'),
        cell(contactLabel(event), event.contact ? 'occ-good' : ''),
        cell(event.angularDiameterArcsec == null ? '—' : num(event.angularDiameterArcsec, 3, '″'), 'num'),
        cell(num(event.durationMs, 0), 'num'),
        cell(flagsText(event), 'occ-flags'),
      ]);
      tbody.appendChild(row);
    });
    table.appendChild(tbody); tableWrap.appendChild(table);
    if (visibleEvents.length < matchingEvents.length) {
      tableWrap.appendChild(U.el('div', { class: 'msg-empty' },
        'Only the first ' + MAX_RENDERED_EVENTS +
        ' records in the current sort are rendered here; CSV/JSON export follows the current filters.'));
    }
  }

  function build(container) {
    body = container;
    const toolbar = U.el('div', { class: 'occ-toolbar' });
    summary = U.el('span', { class: 'occ-summary' }, 'Idle');
    const csv = U.el('button', { class: 'btn small', onclick: csvExport }, 'Export CSV');
    const json = U.el('button', { class: 'btn small', onclick: jsonExport }, 'Export JSON');
    toolbar.appendChild(summary); toolbar.appendChild(csv); toolbar.appendChild(json);
    body.appendChild(toolbar);
    filterBar = U.el('div', { class: 'occ-toolbar occ-filter-toolbar' });
    body.appendChild(filterBar);
    tableWrap = U.el('div', { class: 'occ-table-wrap' });
    body.appendChild(tableWrap);
    body.appendChild(U.el('div', { class: 'occ-note' },
      'Filter by the SatIdentifier scan tags above. Click a row to pause at closest approach and mark its target star, satellite, and adjacent passing track in the main Sky Chart. Click table headers to sort, including Alt/Az and other quantitative results. P0 records deterministic geometry; contacts/grazes are not calibrated probabilities or observing detections.'));
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (error) {}
    SAT.bus.on('occultation-state-changed', render);
    SAT.bus.on('occultation-done', render);
    SAT.bus.on('occultation-cancelled', render);
    SAT.bus.on('state-loaded', render);
    render();
  }

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.eventsUI = { init: build, refresh: render, exportJSON: jsonExport, exportCSV: csvExport,
    filterEvents: (state) => filteredEvents(state || currentState()),
    sortEvents: (events) => sortedEvents(Array.isArray(events) ? events : []),
    setSort: setSort,
  };
})();
