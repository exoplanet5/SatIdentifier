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

  // updateUI runs EVERY animation frame while the clock runs. Writing textContent
  // unconditionally replaced text nodes at 60 Hz — wasted work, and needless DOM
  // churn under the user's cursor exactly when they press a button. Write only
  // on change.
  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }

  function updateUI() {
    // menu bar (always present)
    const mbClock = document.getElementById('mb-clock');
    const mbRate = document.getElementById('mb-rate');
    if (mbClock) setText(mbClock, SAT.util.fmtDate(getDate()) + ' UTC');
    if (mbRate) {
      setText(mbRate, running ? rate + '×' : '❚❚ paused');
      mbRate.classList.toggle('rt', running && rate === 1);
    }
    if (!ui) return;
    if (!ui.editing) {
      const v = SAT.util.fmtDate(getDate());
      if (ui.field.value !== v) ui.field.value = v;
      ui.field.style.color = running ? '' : 'var(--warn)'; // amber while paused
    }
    setText(ui.local, 'local ' + SAT.util.fmtDateLocal(getDate()) +
      (running ? '' : '  ·  PAUSED'));
    setText(ui.playBtn, running ? '❚❚ Pause' : '▶ Run');
    ui.rateBtns.forEach(b => b.classList.toggle('on', +b.dataset.rate === rate));
  }

  /** A button that acts on POINTERDOWN, not click.
   *
   *  A click only lands if mousedown and mouseup resolve to the same element, so
   *  any mid-press relayout — a window snapping to its stored geometry, DOM
   *  churn under the cursor, a focus dance — makes the browser quietly dissolve
   *  it. That is exactly the reported bug: Space always paused (global keydown,
   *  no hit-testing) while the mouse sometimes did nothing. For instantaneous
   *  clock controls, acting on the press is both immune to that whole class and
   *  what the user means anyway. Keyboard activation of a focused control still
   *  arrives as a bare click with no preceding pointerdown, so it stays live;
   *  the timestamp guard keeps the pointer path from firing the handler twice. */
  function pressAct(el, fn) {
    let pressedAt = 0;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      pressedAt = performance.now();
      fn();
    });
    el.addEventListener('click', () => {
      if (performance.now() - pressedAt < 800) return;   // already handled on press
      fn();
    });
    return el;
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

    const playBtn = pressAct(
      U.el('button', { class: 'btn primary' }, '❚❚ Pause'),
      () => setRunning(!running));
    const nowBtn = pressAct(
      U.el('button', { class: 'btn', title: 'Jump to real current time, rate 1×, running' }, '⦿ Real time'),
      () => syncNow());

    const rates = [-1000, -100, -10, -1, 1, 10, 100, 1000];
    const rateBtns = rates.map(r =>
      pressAct(U.el('button', { class: 'btn small clk-rate-btn', 'data-rate': r },
        (r > 0 ? '+' : '') + r + '×'),
        () => { setRate(r); setRunning(true); }));

    const steps = [['−1d', -86400], ['−1h', -3600], ['−1m', -60], ['−10s', -10],
                   ['+10s', 10], ['+1m', 60], ['+1h', 3600], ['+1d', 86400]];
    const stepBtns = steps.map(([lbl, s]) =>
      pressAct(U.el('button', { class: 'btn small' }, lbl),
        () => setDate(new Date(getDate().getTime() + s * 1000))));

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
      pressAct(mbRate, () => setRunning(!running));
    }
    emit(true);
  }

  SAT.clock = {
    getDate, isRunning: () => running, setRunning, toggle: () => setRunning(!running),
    getRate: () => rate, setRate, setDate, syncNow, init, buildUI,
  };
})();
