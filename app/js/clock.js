/* SAT.clock — master simulation clock (engine + clock window UI) */
(function () {
  'use strict';
  let simMs = Date.now();
  let running = true;
  let rate = 1;
  let lastWall = null;
  let rafId = null;

  function getDate() { return new Date(simMs); }
  function emit(jumped) {
    if (SAT.bus) SAT.bus.emit('time', { date: getDate(), jumped: !!jumped });
  }

  function loop(t) {
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    if (lastWall == null) lastWall = now;
    const dt = now - lastWall;
    lastWall = now;
    if (running && dt > 0) {
      simMs += dt * rate;
      // a long rAF gap (backgrounded tab) lands as one big discontinuous step:
      // flag it as a jump so consumers invalidate their caches
      emit(dt > 5000);
      updateUI(); // keep clock displays in lockstep at high rates
    }
  }

  function setRunning(b) {
    b = !!b;
    if (b === running) return;
    running = b;
    lastWall = null;
    emit(false);
    updateUI();
  }
  function setRate(r) {
    if (!isFinite(r) || r === 0) return;
    rate = r;
    emit(false);
    updateUI();
  }
  function setDate(d) {
    simMs = d.getTime();
    emit(true);
    updateUI();
  }
  function syncNow() { rate = 1; running = true; setDate(new Date()); }

  // ---------------- clock window UI ----------------
  // "YYYY-MM-DD HH:MM:SS" caret segments
  const SEGS = [
    { a: 0, b: 4, unit: 'year' }, { a: 5, b: 7, unit: 'month' }, { a: 8, b: 10, unit: 'day' },
    { a: 11, b: 13, unit: 'hour' }, { a: 14, b: 16, unit: 'min' }, { a: 17, b: 19, unit: 'sec' },
  ];
  function segAt(pos) {
    for (const s of SEGS) if (pos >= s.a && pos <= s.b) return s;
    return SEGS[SEGS.length - 1];
  }
  function stepUnit(date, unit, dir) {
    const d = new Date(date.getTime());
    const day = d.getUTCDate();
    switch (unit) {
      case 'year': d.setUTCFullYear(d.getUTCFullYear() + dir); break;
      case 'month': d.setUTCMonth(d.getUTCMonth() + dir); break;
      case 'day': d.setUTCDate(d.getUTCDate() + dir); break;
      case 'hour': d.setUTCHours(d.getUTCHours() + dir); break;
      case 'min': d.setUTCMinutes(d.getUTCMinutes() + dir); break;
      case 'sec': d.setUTCSeconds(d.getUTCSeconds() + dir); break;
    }
    // month/year steps from e.g. Jan 31 must not roll into the next month —
    // snap back to the last day of the intended month
    if ((unit === 'month' || unit === 'year') && d.getUTCDate() !== day) {
      d.setUTCDate(0);
    }
    return d;
  }
  function parseField(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    if (isNaN(d.getTime())) return null;
    // reject impossible dates instead of letting Date.UTC roll them over
    // (2026-02-31 -> Mar 3 would silently corrupt the simulation time)
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() + 1 !== +m[2] ||
        d.getUTCDate() !== +m[3] || d.getUTCHours() !== +m[4] ||
        d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6]) return null;
    return d;
  }

  let ui = null; // {field, local, playBtn, rateBtns, editing}

  function updateUI() {
    // menu bar (always present)
    const mbClock = document.getElementById('mb-clock');
    const mbRate = document.getElementById('mb-rate');
    if (mbClock) mbClock.textContent = SAT.util.fmtDate(getDate()) + ' UTC';
    if (mbRate) {
      mbRate.textContent = running ? rate + '×' : '❚❚ paused';
      mbRate.classList.toggle('rt', running && rate === 1);
    }
    if (!ui) return;
    if (!ui.editing) {
      ui.field.value = SAT.util.fmtDate(getDate());
      ui.field.style.color = running ? '' : 'var(--warn)'; // amber while paused
    }
    ui.local.textContent = 'local ' + SAT.util.fmtDateLocal(getDate()) +
      (running ? '' : '  ·  PAUSED');
    ui.playBtn.textContent = running ? '❚❚ Pause' : '▶ Run';
    ui.rateBtns.forEach(b => b.classList.toggle('on', +b.dataset.rate === rate));
  }

  function buildUI(body, win) {
    const U = SAT.util;
    const field = U.el('input', { class: 'clk-time', spellcheck: 'false' });
    const local = U.el('div', { class: 'clk-local' }, '');
    const hint = U.el('div', { class: 'clk-hint' },
      '↑/↓ steps the segment under the caret · type + Enter to set · Esc cancels');

    field.addEventListener('focus', () => { ui.editing = true; field.classList.add('editing'); });
    field.addEventListener('blur', () => {
      ui.editing = false; field.classList.remove('editing'); updateUI();
    });
    field.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const pos = field.selectionStart || 0;
        const seg = segAt(pos);
        // step from what's displayed (accept a valid typed value as base)
        const base = parseField(field.value) || getDate();
        setDate(stepUnit(base, seg.unit, e.key === 'ArrowUp' ? 1 : -1));
        field.value = U.fmtDate(getDate());
        field.setSelectionRange(seg.a, seg.b);
      } else if (e.key === 'Enter') {
        const d = parseField(field.value);
        if (d) { setDate(d); field.blur(); }
        else { field.classList.add('err'); setTimeout(() => field.classList.remove('err'), 400); }
      } else if (e.key === 'Escape') {
        field.blur();
      }
    });

    const playBtn = U.el('button', { class: 'btn primary', onclick: () => setRunning(!running) }, '❚❚ Pause');
    const nowBtn = U.el('button', { class: 'btn', title: 'Jump to real current time, rate 1×, running', onclick: () => syncNow() }, '⦿ Real time');

    const rates = [-1000, -100, -10, -1, 1, 10, 100, 1000];
    const rateBtns = rates.map(r =>
      U.el('button', {
        class: 'btn small clk-rate-btn', 'data-rate': r,
        onclick: () => { setRate(r); setRunning(true); },
      }, (r > 0 ? '+' : '') + r + '×'));

    const steps = [['−1d', -86400], ['−1h', -3600], ['−1m', -60], ['−10s', -10],
                   ['+10s', 10], ['+1m', 60], ['+1h', 3600], ['+1d', 86400]];
    const stepBtns = steps.map(([lbl, s]) =>
      U.el('button', { class: 'btn small', onclick: () => setDate(new Date(getDate().getTime() + s * 1000)) }, lbl));

    body.appendChild(U.el('div', { class: 'pane' }, [
      field, local, hint,
      U.el('div', { class: 'clk-main-btns' }, [playBtn, nowBtn]),
      U.el('div', { class: 'clk-rates' }, rateBtns),
      U.el('div', { class: 'sep' }),
      U.el('div', { class: 'clk-rates' }, stepBtns),
    ]));
    ui = { field, local, playBtn, rateBtns, editing: false };
    updateUI();
  }

  function init() {
    if (rafId == null) rafId = requestAnimationFrame(loop);
    // keep menubar fresh even when paused (1 Hz)
    setInterval(updateUI, 1000);
    // the menu-bar rate indicator doubles as an always-reachable run/pause toggle
    const mbRate = document.getElementById('mb-rate');
    if (mbRate) {
      mbRate.style.cursor = 'pointer';
      mbRate.title = 'click to run / pause the simulation clock';
      mbRate.addEventListener('click', () => setRunning(!running));
    }
    emit(true);
  }

  SAT.clock = {
    getDate, isRunning: () => running, setRunning, toggle: () => setRunning(!running),
    getRate: () => rate, setRate, setDate, syncNow, init, buildUI,
  };
})();
