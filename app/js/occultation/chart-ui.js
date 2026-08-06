/* SAT.occultation.chartUI — local tangent-plane candidate chart.
 *
 * Visualization responsibility: draw one selected event's fixed J2000 star,
 * represented satellite path, closest-approach marker, and conservative search
 * corridor. The path is a diagnostic representation; the chart never replaces
 * the exact P0-07 evaluator result or turns a candidate into a detection claim.
 */
(function () {
  'use strict';

  const U = SAT.util;
  let canvas = null;
  let ctx = null;
  let statusEl = null;
  let detailEl = null;
  let selectedId = null;
  let body = null;

  function state() {
    return SAT.state && SAT.state.occultation && typeof SAT.state.occultation === 'object'
      ? SAT.state.occultation : { events: [], passes: [], pipeline: null };
  }

  function eventOf() {
    const events = Array.isArray(state().events) ? state().events : [];
    return events.find((event) => event.eventId === selectedId) || events[0] || null;
  }

  function passOf(event) {
    if (!event) return null;
    const passes = Array.isArray(state().passes) ? state().passes : [];
    return passes.find((pass) => String(pass.passId) === String(event.passId)) || null;
  }

  function project(row, star) {
    if (!row || !isFinite(Number(row.raDeg)) || !isFinite(Number(row.decDeg))) return null;
    return SAT.frames.tanProject(Number(row.raDeg), Number(row.decDeg), star.raDeg, star.decDeg);
  }

  function resizeCanvas() {
    if (!canvas || !body) return;
    const width = Math.max(120, body.clientWidth);
    const height = Math.max(120, body.clientHeight - 42);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(width, height);
  }

  function draw(width, height) {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0c1014'; ctx.fillRect(0, 0, width, height);
    const event = eventOf();
    if (!event) {
      statusEl.textContent = 'No occultation event selected';
      detailEl.textContent = 'Run a search and select a row in Occultation Events.';
      return;
    }
    const candidate = event.candidate || {};
    if (!isFinite(Number(candidate.raDeg)) || !isFinite(Number(candidate.decDeg))) {
      statusEl.textContent = 'Selected event has no valid star direction';
      detailEl.textContent = event.eventId || '';
      return;
    }
    const star = { raDeg: Number(candidate.raDeg), decDeg: Number(candidate.decDeg) };
    const pass = passOf(event);
    const path = pass && Array.isArray(pass.path) ? pass.path : [];
    const points = path.map((row) => {
      const p = project(row, star);
      return p ? { x: p.xi, y: p.eta, t: Number(row.t) } : null;
    }).filter(Boolean);
    const pipeline = state().pipeline || {};
    const pipelineConfig = pipeline.config || {};
    const starOptions = pipelineConfig.stars || {};
    const corridorArcsec = isFinite(Number(starOptions.corridorArcsec))
      ? Math.max(0, Number(starOptions.corridorArcsec)) : 10;
    let extent = corridorArcsec / 3600;
    points.forEach((point) => { extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y)); });
    extent = Math.max(extent * 1.35, 1 / 3600);
    const scale = Math.min(width, height) * 0.38 / extent;
    const cx = width / 2, cy = height / 2;
    const xy = (point) => ({ x: cx + point.x * scale, y: cy - point.y * scale });
    const gridArcsec = extent * 3600 > 30 ? 10 : (extent * 3600 > 5 ? 1 : 0.1);
    ctx.strokeStyle = 'rgba(154,164,174,.22)'; ctx.lineWidth = 1;
    [1, 2, 3, 4].forEach((n) => {
      const r = gridArcsec * n / 3600 * scale;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(154,164,174,.28)';
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
    if (points.length) {
      ctx.save(); ctx.strokeStyle = 'rgba(255,184,79,.18)';
      ctx.lineWidth = Math.max(1, 2 * corridorArcsec / 3600 * scale);
      ctx.lineCap = 'round'; ctx.beginPath();
      points.forEach((point, index) => {
        const q = xy(point); if (index) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke(); ctx.restore();
      ctx.strokeStyle = '#ffb84f'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath();
      points.forEach((point, index) => {
        const q = xy(point); if (index) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,184,79,.65)';
      points.forEach((point) => { const q = xy(point); ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fill(); });
    }
    ctx.fillStyle = '#4fc3f7'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#e8eaed'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
    let closest = null;
    if (event.closestVector && SAT.occultation.geometry) {
      const rd = SAT.occultation.geometry.raDecFromUnit(event.closestVector);
      const projected = rd && project(rd, star);
      closest = projected ? { x: projected.xi, y: projected.eta } : null;
    }
    if (!closest && points.length && isFinite(Number(event.tCaMs))) {
      closest = points.reduce((best, point) => !best ||
        Math.abs(point.t - Number(event.tCaMs)) < Math.abs(best.t - Number(event.tCaMs)) ? point : best, null);
    }
    if (closest) {
      const q = xy(closest); ctx.strokeStyle = '#f06292'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = '#e8eaed'; ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText('N', cx + 6, 16); ctx.fillText('E', width - 20, cy - 6);
    ctx.fillStyle = '#9aa4ae'; ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('star', cx + 9, cy + 16);
    if (points.length) ctx.fillText('path + ' + corridorArcsec.toFixed(2) + '″ corridor', 10, height - 12);
    statusEl.textContent = (event.name || event.satId || 'Satellite') + ' · ' + (event.starKey || 'star');
    detailEl.textContent = 'CA ' + (event.tCaMs == null ? '—' : U.fmtDate(new Date(event.tCaMs))) +
      ' · miss ' + (event.nominalSeparationArcsec == null ? '—' : Number(event.nominalSeparationArcsec).toFixed(3) + '″') +
      ' · ' + (event.contactStatus || 'candidate');
  }

  function render() { resizeCanvas(); }

  function build(container, win) {
    body = container; win.noScroll = true;
    const head = U.el('div', { class: 'occ-chart-head' });
    statusEl = U.el('span', { class: 'occ-status' }, 'No event');
    detailEl = U.el('span', { class: 'occ-detail dim' }, '');
    head.appendChild(statusEl); head.appendChild(detailEl); body.appendChild(head);
    canvas = U.el('canvas', { class: 'occ-canvas' }); ctx = canvas.getContext('2d'); body.appendChild(canvas);
    body.addEventListener('win-resize', resizeCanvas);
    SAT.bus.on('occultation-selection-changed', (payload) => {
      selectedId = payload && payload.eventId ? payload.eventId : null; render();
    });
    SAT.bus.on('occultation-state-changed', render);
    SAT.bus.on('occultation-done', render);
    render();
  }

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.chartUI = { init: build, refresh: render };
})();
