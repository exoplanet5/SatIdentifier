/* SAT.windows — internal floating window manager */
(function () {
  'use strict';
  const wins = new Map();   // id -> win handle
  let zTop = 100;

  function desktop() { return document.getElementById('desktop'); }

  function saveLayout(win) {
    try {
      if (!SAT.state || !SAT.state.settings) return;
      const lay = SAT.state.settings.layout || (SAT.state.settings.layout = {});
      lay[win.id] = {
        x: win.el.offsetLeft, y: win.el.offsetTop,
        w: win.el.offsetWidth, h: win.el.offsetHeight,
        open: win.isOpen(),
      };
      SAT.state.save();
    } catch (e) { /* state not ready yet */ }
  }

  function notifyChanged() {
    if (SAT.bus) SAT.bus.emit('windows-changed', {});
  }

  function fireResize(win) {
    win.body.dispatchEvent(new CustomEvent('win-resize'));
  }

  function register(opts) {
    const U = SAT.util;
    const id = opts.id;
    const saved = (SAT.state && SAT.state.settings && SAT.state.settings.layout &&
      SAT.state.settings.layout[id]) || null;

    const geo = {
      x: saved ? saved.x : (opts.x != null ? opts.x : 60),
      y: saved ? saved.y : (opts.y != null ? opts.y : 60),
      w: saved ? saved.w : (opts.w || 420),
      h: saved ? saved.h : (opts.h || 300),
    };
    const minW = opts.minW || 260, minH = opts.minH || 160;
    let openFlag = saved ? !!saved.open : (opts.open !== false);
    let built = false;

    const elWin = U.el('div', { class: 'win', style: 'display:none' });
    const titleEl = U.el('span', null, opts.title || id);
    const closeEl = U.el('span', { class: 'win-close', title: 'Close' }, '×');
    const titleBar = U.el('div', { class: 'win-title' }, [titleEl, closeEl]);
    const body = U.el('div', { class: 'win-body' });
    const grip = U.el('div', { class: 'win-grip' });
    elWin.appendChild(titleBar); elWin.appendChild(body); elWin.appendChild(grip);
    desktop().appendChild(elWin);

    function applyGeo() {
      const dt = desktop();
      // cap size to the viewport so the resize grip stays reachable
      if (dt.clientWidth > minW) geo.w = Math.min(geo.w, dt.clientWidth);
      if (dt.clientHeight > minH) geo.h = Math.min(geo.h, dt.clientHeight);
      geo.w = Math.max(minW, geo.w); geo.h = Math.max(minH, geo.h);
      const maxX = Math.max(0, dt.clientWidth - 80), maxY = Math.max(0, dt.clientHeight - 30);
      geo.x = U.clamp(geo.x, -geo.w + 120, maxX);
      geo.y = U.clamp(geo.y, 0, maxY);
      elWin.style.left = geo.x + 'px'; elWin.style.top = geo.y + 'px';
      elWin.style.width = geo.w + 'px'; elWin.style.height = geo.h + 'px';
    }

    const win = {
      id, el: elWin, body,
      noScroll: false,
      _applyGeo: applyGeo,
      isOpen: () => openFlag && elWin.style.display !== 'none',
      setTitle: s => { titleEl.textContent = s; },
      focus() {
        zTop += 1; elWin.style.zIndex = zTop;
        document.querySelectorAll('.win.focused').forEach(w => w.classList.remove('focused'));
        elWin.classList.add('focused');
      },
      open() {
        openFlag = true;
        elWin.style.display = 'flex';
        if (!built) {
          built = true;
          try { opts.build && opts.build(body, win); } catch (e) { console.error('build ' + id, e); }
          if (win.noScroll) body.classList.add('noscroll');
        }
        win.focus();
        applyGeo();
        fireResize(win);
        saveLayout(win); notifyChanged();
      },
      close() {
        openFlag = false;
        elWin.style.display = 'none';
        saveLayout(win); notifyChanged();
      },
      toggle() { win.isOpen() ? win.close() : win.open(); },
    };

    closeEl.addEventListener('click', e => { e.stopPropagation(); win.close(); });
    elWin.addEventListener('pointerdown', () => win.focus());

    // drag by title bar
    titleBar.addEventListener('pointerdown', e => {
      if (e.target === closeEl || e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX - geo.x, sy = e.clientY - geo.y;
      const move = ev => { geo.x = ev.clientX - sx; geo.y = ev.clientY - sy; applyGeo(); };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        saveLayout(win);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // resize by grip
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const sw = geo.w - e.clientX, sh = geo.h - e.clientY;
      const move = ev => {
        geo.w = Math.max(minW, sw + ev.clientX);
        geo.h = Math.max(minH, sh + ev.clientY);
        applyGeo(); fireResize(win);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        saveLayout(win); fireResize(win);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    wins.set(id, win);
    if (openFlag) win.open();
    return win;
  }

  window.addEventListener('resize', () => {
    wins.forEach(w => {
      w._applyGeo();               // keep every window reachable in the new viewport
      if (w.isOpen()) fireResize(w);
    });
  });

  SAT.windows = {
    register,
    get: id => wins.get(id) || null,
    toggle: id => { const w = wins.get(id); if (w) w.toggle(); },
    all: () => [...wins.values()],
  };
})();
