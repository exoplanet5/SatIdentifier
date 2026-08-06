/* SAT.occultation.planUI — controls and progress for the P0-11 pipeline.
 *
 * Visualization responsibility: collect a ground site and local-civil-date
 * configuration, start/cancel the deterministic pipeline, and expose its stage
 * status. It does not perform propagation or store configuration in ordinary
 * `SAT.state`; the pipeline owns the scientific handoff and state publication.
 */
(function () {
  'use strict';

  const U = SAT.util;
  let root = null;
  let controls = null;
  let statusEl = null;
  let detailEl = null;
  let progressEl = null;
  let runButton = null;
  let cancelButton = null;
  let desktopJobId = null;
  let desktopApiRef = null;
  let filterInputs = [];
  let classChecks = {};
  let typeChecks = {};

  // These are the same seven classification chips used by the ordinary scan:
  // four orbital classes plus the three SATCAT object-type labels. The catalogue
  // source (Space-Track/CelesTrak/etc.) is deliberately not a search dimension.
  const ORBIT_TAGS = [['leo', 'leo'], ['meo', 'meo'], ['geo', 'geo'], ['heo', 'heo']];
  const OBJECT_TAGS = [['PAY', 'payload'], ['R/B', 'rocket body'], ['DEB', 'debris']];

  function selectedValues(checks, values, label) {
    const selected = values.filter((item) => checks[item[0]] && checks[item[0]].checked)
      .map((item) => item[0]);
    if (!selected.length) throw new Error('Select at least one ' + label + '.');
    // All known chips selected means no restrictive filter. This preserves scan's
    // fail-open behaviour for catalogue records whose SATCAT type is unknown.
    return selected.length === values.length ? null : selected;
  }

  function localDate(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const byType = {};
      parts.forEach((part) => { byType[part.type] = part.value; });
      return byType.year + '-' + byType.month + '-' + byType.day;
    } catch (error) {
      const date = new Date();
      return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') +
        '-' + String(date.getUTCDate()).padStart(2, '0');
    }
  }

  function defaultTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (error) { return 'UTC'; }
  }

  function activeSite() {
    const state = SAT.state || {};
    const location = typeof state.activeLocation === 'function' ? state.activeLocation() : null;
    if (!location) return null;
    if (typeof state.resolvedSite === 'function') return state.resolvedSite(location);
    return Object.assign({ kind: 'ground' }, location);
  }

  function inputField(key, type, value, width) {
    const input = U.el('input', { class: 'input occ-input', type: type, value: value });
    if (width) input.style.width = width;
    controls[key] = input;
    return input;
  }

  function checkboxField(key, label, checked, title) {
    const input = U.el('input', { class: 'occ-check-input', type: 'checkbox',
      checked: checked, title: title || null });
    controls[key] = input;
    return U.el('label', { class: 'occ-field occ-check-field', title: title || null }, [
      input, U.el('span', { class: 'occ-label' }, label),
    ]);
  }

  function field(label, input, suffix) {
    return U.el('label', { class: 'occ-field' }, [
      U.el('span', { class: 'occ-label' }, label), input,
      suffix ? U.el('span', { class: 'occ-unit' }, suffix) : null,
    ]);
  }

  function numberValue(key, label) {
    const value = Number(controls[key].value);
    if (!isFinite(value)) throw new Error(label + ' must be finite');
    return value;
  }

  function filterRow(title, values, checks) {
    const row = U.el('div', { class: 'occ-filter-row' }, [
      U.el('span', { class: 'occ-filter-title' }, title),
    ]);
    values.forEach((item) => {
      const input = U.el('input', { class: 'occ-check-input', type: 'checkbox', checked: true });
      checks[item[0]] = input;
      filterInputs.push(input);
      row.appendChild(U.el('label', { class: 'occ-filter-chip' }, [
        input, U.el('span', null, item[1]),
      ]));
    });
    return row;
  }

  function readInput() {
    const site = activeSite();
    if (!site) throw new Error('No active site — choose one in the Sites window.');
    return {
      site: site,
      localDate: controls.localDate.value,
      timeZone: controls.timeZone.value.trim() || 'UTC',
      sunAltitudeLimitDeg: numberValue('twilight', 'twilight altitude'),
      minimumElevationDeg: numberValue('minEl', 'minimum elevation'),
      coarseStepS: numberValue('coarse', 'coarse step'),
      fineStepS: numberValue('fine', 'fine step'),
      pathToleranceArcsec: numberValue('pathTolerance', 'path tolerance'),
      passOptions: {
        maxResults: numberValue('maxResults', 'pass result limit'),
        classes: selectedValues(classChecks, ORBIT_TAGS, 'orbit-class tag'),
        types: selectedValues(typeChecks, OBJECT_TAGS, 'object-type tag'),
      },
      starOptions: {
        magLimit: numberValue('magLimit', 'star magnitude limit'),
        corridorArcsec: numberValue('corridor', 'search corridor'),
        maxCandidates: numberValue('maxCandidates', 'candidate limit'),
      },
      eventOptions: {
        defaultRadiusM: numberValue('radius', 'default satellite radius'),
        contactsOnly: !!controls.contactsOnly.checked,
      },
    };
  }

  function siteText() {
    const site = activeSite();
    if (!site) return 'No active site';
    return (site.name || 'Active site') + ' · ' + Number(site.latDeg).toFixed(4) + '°, ' +
      Number(site.lonDeg).toFixed(4) + '°' + (site.kind === 'orbit' ? ' · orbit site' : '');
  }

  function setBusy(busy) {
    runButton.disabled = busy;
    cancelButton.disabled = !busy;
    Object.keys(controls).forEach((key) => { controls[key].disabled = busy; });
    filterInputs.forEach((input) => { input.disabled = busy; });
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'occ-status ' + (kind || '');
  }

  function setProgress(done, total) {
    const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    setFraction(fraction);
  }

  function setFraction(fraction) {
    const value = Math.max(0, Math.min(1, Number(fraction) || 0));
    progressEl.style.width = (value * 100).toFixed(1) + '%';
  }

  function stageProgress(payload) {
    const data = payload || {};
    const stage = data.stage || data.phase || 'running';
    const phase = data.phase || stage;
    let start = 0, width = 1, label = String(stage);
    if (stage === 'pass-scan' || phase === 'coarse' || phase === 'fine') {
      start = 0; width = 0.40; label = 'pass scan / ' + phase;
    } else if (stage === 'star-search' || phase === 'star-search') {
      start = 0.40; width = 0.30; label = 'star search';
    } else if (stage === 'event-refinement' || phase === 'event-refinement') {
      start = 0.70; width = 0.30; label = 'exact contact refinement';
    }
    const done = Number(data.done) || 0;
    const total = Number(data.total) || 0;
    const reportedFraction = Number(data.fraction);
    const ratio = total > 0 ? done / total
      : (isFinite(reportedFraction) ? reportedFraction : 0);
    setFraction(start + width * Math.max(0, Math.min(1, ratio)));
    const count = total > 0 ? done + '/' + total : (done > 0 ? String(done) : '…');
    setStatus(label + ' · ' + count, '');
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function desktopApi() {
    if (typeof window !== 'undefined' && window.pywebview && window.pywebview.api) {
      return Promise.resolve(window.pywebview.api);
    }
    // The native bridge is installed after the WebView document starts. In a
    // normal browser this simply falls through after a short bounded wait.
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('pywebviewready', finish);
        resolve(window.pywebview && window.pywebview.api ? window.pywebview.api : null);
      };
      window.addEventListener('pywebviewready', finish, { once: true });
      setTimeout(finish, 250);
    });
  }

  async function runInDesktopProcess(input, api) {
    const started = await api.start_occultation(input);
    if (!started || started.error) throw new Error(started && started.error || 'desktop search did not start');
    desktopJobId = started.jobId;
    desktopApiRef = api;
    let cursor = 0;
    try {
      while (true) {
        const update = await api.poll_occultation(started.jobId, cursor);
        if (!update || update.error) throw new Error(update && update.error || 'desktop search polling failed');
        cursor = Number(update.nextCursor) || cursor;
        (update.messages || []).forEach((message) => {
          if (message.type === 'progress') stageProgress(message.progress);
          else if (message.type === 'started') {
            detailEl.textContent = 'Complete search · ' + (message.objects || 0) +
              ' satellites · ' + (message.stars || 0) + ' stars';
          } else if (message.type === 'log') {
            detailEl.textContent = message.text || '';
          }
        });
        if (update.done) {
          if (update.result) return update.result;
          throw new Error(update.returnCode ? 'desktop search exited with code ' + update.returnCode
            : 'desktop search ended without a report');
        }
        await wait(250);
      }
    } finally {
      desktopJobId = null;
      desktopApiRef = null;
    }
  }

  function publishDesktopResult(result) {
    if (!result || !result.state || !SAT.occultation || !SAT.occultation.eventState) return result;
    const state = SAT.occultation.eventState.commit(result.state, {
      adoptDetached: true, nowMs: result.finishedAtMs,
    });
    result.state = state;
    return result;
  }

  function showResult(result) {
    setBusy(false);
    setFraction(result && result.status !== 'failed' && result.status !== 'cancelled' ? 1 : 0);
    if (!result) return;
    const stats = result.stats || {};
    const discovery = stats.discovery || {};
    const search = stats.search || {};
    const events = stats.events || {};
    const flags = Array.isArray(result.flags) ? result.flags : [];
    const flagText = flags.length
      ? ' · flags: ' + flags.slice(0, 4).join(', ') + (flags.length > 4 ? '…' : '') : '';
    const screeningText = Number(search.screenedCandidates) > 0
      ? ' · screened ' + search.screenedCandidates : '';
    detailEl.textContent = (result.status || 'unknown') + ' · ' +
      (discovery.passes || 0) + ' passes · ' + (search.candidates || 0) +
      ' candidates · ' + (events.events || 0) + ' events' +
      screeningText +
      (result.timings && isFinite(result.timings.totalMs)
        ? ' · ' + Math.round(result.timings.totalMs) + ' ms' : '') + flagText;
    if (result.status === 'ok' || result.status === 'empty' || result.status === 'no-night') {
      setStatus(result.status === 'ok' ? 'Complete' : result.status, result.status === 'ok' ? 'ok' : '');
    } else if (result.status === 'partial') {
      setStatus('Partial — see flags and event table', 'warn');
    } else if (result.status === 'cancelled') setStatus('Cancelled', 'warn');
    else setStatus(result.error || 'Pipeline failed', 'err');
  }

  async function run() {
    if (!SAT.occultation || !SAT.occultation.pipeline) {
      setStatus('Occultation pipeline is unavailable', 'err');
      return;
    }
    let input;
    try { input = readInput(); }
    catch (error) { setStatus(error.message, 'err'); return; }
    setBusy(true); setFraction(0); setStatus('Running…', ''); detailEl.textContent = siteText();
    try {
      const api = await desktopApi();
      const result = api
        ? publishDesktopResult(await runInDesktopProcess(input, api))
        : await SAT.occultation.pipeline.run(input);
      showResult(result);
      if (result && result.status !== 'failed' && result.status !== 'cancelled') {
        const eventsWindow = SAT.windows && SAT.windows.get('occultation-events');
        if (eventsWindow) eventsWindow.open();
      }
    } catch (error) {
      setBusy(false); setStatus(error.message || String(error), 'err');
    }
  }

  function renderSite() {
    const site = root && root.querySelector('.occ-site');
    if (site) site.textContent = siteText();
  }

  function build(body, win) {
    controls = {};
    filterInputs = [];
    classChecks = {};
    typeChecks = {};
    winRef = win;
    root = U.el('div', { class: 'occ-root occ-plan' });
    const form = U.el('div', { class: 'occ-form' });
    const zone = defaultTimeZone();
    form.appendChild(U.el('div', { class: 'occ-site-line' }, [
      U.el('span', { class: 'occ-label' }, 'Site'),
      U.el('span', { class: 'occ-site' }, siteText()),
      U.el('button', { class: 'btn small', onclick: renderSite }, 'Refresh site'),
    ]));
    form.appendChild(U.el('div', { class: 'occ-grid' }, [
      field('Local date', inputField('localDate', 'date', localDate(zone), '130px')),
      field('IANA time zone', inputField('timeZone', 'text', zone, '180px')),
      field('Twilight', inputField('twilight', 'number', '-12', '72px'), '°'),
      field('Min elevation', inputField('minEl', 'number', '20', '72px'), '°'),
      field('Star limit', inputField('magLimit', 'number', '6', '72px'), 'V mag'),
      field('Corridor', inputField('corridor', 'number', '10', '72px'), 'arcsec'),
      field('Coarse step', inputField('coarse', 'number', '30', '72px'), 's'),
      field('Fine step', inputField('fine', 'number', '1', '72px'), 's'),
      field('Path tolerance', inputField('pathTolerance', 'number', '1', '72px'), 'arcsec'),
      field('Effective radius', inputField('radius', 'number', '1', '72px'), 'm'),
      field('Pass limit (browser)', inputField('maxResults', 'number', '100000', '82px')),
      field('Candidate limit (browser)', inputField('maxCandidates', 'number', '20000', '82px')),
      checkboxField('contactsOnly', 'Contacts only', true,
        'Keep only complete geometric contacts or grazes; non-contact candidates are still evaluated and counted as filtered misses.'),
    ]));
    form.appendChild(U.el('div', { class: 'occ-filter-block' }, [
      filterRow('Scan tags · orbit', ORBIT_TAGS, classChecks),
      filterRow('Scan tags · object', OBJECT_TAGS, typeChecks),
    ]));
    const buttons = U.el('div', { class: 'occ-actions' });
    runButton = U.el('button', { class: 'btn primary', onclick: run }, 'Run occultation search');
    cancelButton = U.el('button', { class: 'btn danger', disabled: true,
      onclick: () => {
        if (desktopApiRef && desktopJobId) desktopApiRef.cancel_occultation(desktopJobId);
        else if (SAT.occultation.pipeline) SAT.occultation.pipeline.cancel();
      } }, 'Cancel');
    const eventsButton = U.el('button', { class: 'btn', onclick: () => {
      const target = SAT.windows && SAT.windows.get('occultation-events'); if (target) target.open();
    } }, 'Open events');
    buttons.appendChild(runButton); buttons.appendChild(cancelButton); buttons.appendChild(eventsButton);
    form.appendChild(buttons);
    root.appendChild(form);
    const progress = U.el('div', { class: 'occ-progress' }, [U.el('div', { class: 'occ-progress-fill' })]);
    progressEl = progress.firstChild;
    root.appendChild(progress);
    statusEl = U.el('div', { class: 'occ-status' }, 'Idle');
    detailEl = U.el('div', { class: 'occ-detail dim' }, 'No run yet.');
    root.appendChild(statusEl); root.appendChild(detailEl);
    root.appendChild(U.el('div', { class: 'occ-note' },
      'SatIdentifier scan-tag filters are applied during pass scanning and can be refined again in the Events table. Desktop pywebview mode runs the complete search in a separate Node process, with no 5,000-candidate cap; the browser-only development fallback keeps its bounded interactive profile. Contacts only is enabled by default: the exact solver evaluates candidates, then keeps only geometric contacts/grazes.'));
    body.appendChild(root);
    SAT.bus.on('occultation-started', () => { if (!SAT.occultation.pipeline.isRunning()) return;
      setStatus('Starting…', ''); });
    SAT.bus.on('occultation-progress', (payload) => {
      if (!SAT.occultation.pipeline.isRunning()) return;
      stageProgress(payload);
    });
    SAT.bus.on('occultation-done', showResult);
    SAT.bus.on('occultation-failed', showResult);
    SAT.bus.on('occultation-cancelled', showResult);
    SAT.bus.on('locations-changed', renderSite);
    SAT.bus.on('state-loaded', renderSite);
  }

  let winRef = null;
  SAT.occultation = SAT.occultation || {};
  SAT.occultation.planUI = { init: build, refresh: renderSite };
})();
