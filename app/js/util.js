/* SAT.util — shared helpers, low-precision solar/lunar ephemeris */
(function () {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function pad2(n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); }
  function pad4(n) { return String(Math.floor(Math.abs(n))).padStart(4, '0'); }

  function fmtDate(d) {
    return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }
  function fmtDateLocal(d) {
    return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function wrapLon(deg) {
    let x = ((deg + 180) % 360 + 360) % 360 - 180;
    return x;
  }
  function deg(rad) { return rad * R2D; }
  function rad(d) { return d * D2R; }

  function uuid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Tiny DOM helper: el('div', {class:'row', onclick: fn, title:'x'}, [child, 'text'])
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'checked' || k === 'disabled' || k === 'selected') { if (v) e[k] = true; }
        else if (k === 'value') e.value = v;
        else e.setAttribute(k, v);
      }
    }
    if (children != null) {
      const add = c => {
        if (c == null) return;
        if (Array.isArray(c)) { c.forEach(add); return; }
        e.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      };
      add(children);
    }
    return e;
  }

  // ---- ephemerides (low precision, Meeus-style) ----

  function julian(date) { return date.getTime() / 86400000 + 2440587.5; }

  // Subsolar point, accuracy ~0.01 deg
  function sunEclipticRaDec(date) {
    const n = julian(date) - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = rad((357.528 + 0.9856003 * n) % 360);
    const lam = rad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
    const eps = rad(23.439 - 0.0000004 * n);
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    return { ra, dec };
  }

  function raDecToSubpoint(ra, dec, date) {
    const gmst = satellite.gstime(date); // rad
    return { latDeg: deg(dec), lonDeg: wrapLon(deg(ra - gmst)) };
  }

  function sunSubpoint(date) {
    const s = sunEclipticRaDec(date);
    return raDecToSubpoint(s.ra, s.dec, date);
  }

  // Sublunar point, accuracy ~0.3 deg (truncated ELP series)
  function moonSubpoint(date) {
    const T = (julian(date) - 2451545.0) / 36525.0;
    const Lp = rad((218.316 + 481267.8813 * T) % 360);
    const M = rad((357.529 + 35999.0503 * T) % 360);
    const Mp = rad((134.963 + 477198.8676 * T) % 360);
    const D = rad((297.850 + 445267.1115 * T) % 360);
    const F = rad((93.272 + 483202.0175 * T) % 360);
    const lam = Lp
      + rad(6.289) * Math.sin(Mp)
      - rad(1.274) * Math.sin(Mp - 2 * D)
      + rad(0.658) * Math.sin(2 * D)
      + rad(0.214) * Math.sin(2 * Mp)
      - rad(0.186) * Math.sin(M)
      - rad(0.114) * Math.sin(2 * F);
    const bet = rad(5.128) * Math.sin(F)
      + rad(0.280) * Math.sin(Mp + F)
      + rad(0.277) * Math.sin(Mp - F)
      + rad(0.173) * Math.sin(2 * D - F);
    const eps = rad(23.439 - 0.013 * T);
    const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
    const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
    return raDecToSubpoint(ra, dec, date);
  }

  // Terminator curve: n+1 points ordered by longitude from -180 to +180.
  // Night side determination is up to the consumer (see isNight / sun latitude sign).
  function nightPolygon(date, n) {
    n = n || 180;
    const sun = sunSubpoint(date);
    let latS = sun.latDeg;
    if (Math.abs(latS) < 0.01) latS = latS < 0 ? -0.01 : 0.01; // avoid tan() blowup at equinox instant
    const tanLatS = Math.tan(rad(latS));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const lon = -180 + 360 * i / n;
      const lat = deg(Math.atan(-Math.cos(rad(lon - sun.lonDeg)) / tanLatS));
      pts.push({ latDeg: lat, lonDeg: lon });
    }
    return pts;
  }

  function isNight(latDeg, lonDeg, sunSub) {
    const cosd = Math.sin(rad(latDeg)) * Math.sin(rad(sunSub.latDeg)) +
      Math.cos(rad(latDeg)) * Math.cos(rad(sunSub.latDeg)) * Math.cos(rad(lonDeg - sunSub.lonDeg));
    return cosd < 0;
  }

  // Sun direction unit vector in ECI (TEME-adequate for visibility tests)
  function sunEciUnit(date) {
    const s = sunEclipticRaDec(date);
    const cd = Math.cos(s.dec);
    return { x: cd * Math.cos(s.ra), y: cd * Math.sin(s.ra), z: Math.sin(s.dec) };
  }

  // Sun altitude above the horizon at a ground site, degrees
  function sunAltitudeDeg(latDeg, lonDeg, date) {
    const s = sunEclipticRaDec(date);
    const gmst = satellite.gstime(date);
    const ha = gmst + rad(lonDeg) - s.ra; // local hour angle
    const la = rad(latDeg);
    const sinAlt = Math.sin(la) * Math.sin(s.dec) +
      Math.cos(la) * Math.cos(s.dec) * Math.cos(ha);
    return deg(Math.asin(clamp(sinAlt, -1, 1)));
  }

  // Is a satellite at ECI position (km) illuminated by the sun?
  // Cylinder shadow model: eclipsed when behind the terminator plane and
  // within one Earth radius of the anti-sun axis.
  function satSunlit(eciPos, date) {
    const s = sunEciUnit(date);
    const d = eciPos.x * s.x + eciPos.y * s.y + eciPos.z * s.z;
    if (d >= 0) return true;
    const px = eciPos.x - d * s.x, py = eciPos.y - d * s.y, pz = eciPos.z - d * s.z;
    return Math.sqrt(px * px + py * py + pz * pz) > 6371.0;
  }

  // Great-circle destination given bearing and angular distance (all degrees)
  function destPoint(latDeg, lonDeg, bearingDeg, angDistDeg) {
    const la1 = rad(latDeg), lo1 = rad(lonDeg), th = rad(bearingDeg), dl = rad(angDistDeg);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(dl) + Math.cos(la1) * Math.sin(dl) * Math.cos(th));
    const lo2 = lo1 + Math.atan2(Math.sin(th) * Math.sin(dl) * Math.cos(la1),
      Math.cos(dl) - Math.sin(la1) * Math.sin(la2));
    return { latDeg: deg(la2), lonDeg: wrapLon(deg(lo2)) };
  }

  // ---- sky coordinate formatting & parsing --------------------------------
  // Added for SatIdentifier: the Pointing window and the crossings table both need
  // to show and accept RA/Dec, and observers type them in every notation there is.

  /** RA degrees -> "hh mm ss.s". */
  function fmtRA(raDeg, decimals) {
    const d = decimals == null ? 1 : decimals;
    let h = (((raDeg % 360) + 360) % 360) / 15;
    let hh = Math.floor(h);
    let m = (h - hh) * 60;
    let mm = Math.floor(m);
    let ss = (m - mm) * 60;
    // carry, so 23 59 59.96 never prints as "23 59 60.0"
    const p = Math.pow(10, d);
    if (Math.round(ss * p) >= 60 * p) { ss = 0; mm += 1; }
    if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
    return pad2(hh) + ' ' + pad2(mm) + ' ' + (ss < 10 ? '0' : '') + ss.toFixed(d);
  }

  /** Dec degrees -> "+dd mm ss". */
  function fmtDec(decDeg, decimals) {
    const d = decimals == null ? 0 : decimals;
    const sign = decDeg < 0 ? '-' : '+';
    const a = Math.abs(decDeg);
    let dd = Math.floor(a);
    let m = (a - dd) * 60;
    let mm = Math.floor(m);
    let ss = (m - mm) * 60;
    const p = Math.pow(10, d);
    if (Math.round(ss * p) >= 60 * p) { ss = 0; mm += 1; }
    if (mm >= 60) { mm = 0; dd += 1; }
    return sign + pad2(dd) + ' ' + pad2(mm) + ' ' + (ss < 10 ? '0' : '') + ss.toFixed(d);
  }

  /** Split a sexagesimal-ish string into numeric parts. Accepts ':', whitespace,
   *  and the h/m/s and d/'/" unit letters. Returns null if it is not numeric.
   *
   *  Also rejects out-of-range minute/second fields. Without that check "99 99 99"
   *  parses happily and, because parseRA wraps modulo 360, comes back as a
   *  perfectly plausible 04h 42m — a typo silently becomes a valid pointing
   *  several hours from where the user meant. */
  function sexParts(str) {
    const s = String(str).trim().replace(/[hdms°'"′″]/gi, ' ')
      .replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const parts = s.split(' ');
    const nums = [];
    for (const p of parts) {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(p)) return null;
      nums.push(parseFloat(p));
    }
    if (!nums.length) return null;
    // minutes and seconds must be sexagesimal; only the leading term may exceed 60
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] < 0 || nums[i] >= 60) return null;
    }
    return nums.length > 3 ? null : nums;
  }

  /** Parse RA. A single bare number is DEGREES; two or more parts are
   *  hours/minutes/seconds. That is the common convention, and it is why the
   *  Pointing window always echoes back both forms — so the user can see which
   *  reading it took. Returns degrees in [0,360) or null. */
  function parseRA(str) {
    const n = sexParts(str);
    if (!n) return null;
    let deg0;
    if (n.length === 1) {
      deg0 = n[0];
    } else {
      const sign = n[0] < 0 ? -1 : 1;
      const h = Math.abs(n[0]) + (n[1] || 0) / 60 + (n[2] || 0) / 3600;
      deg0 = sign * h * 15;
    }
    if (!isFinite(deg0)) return null;
    return ((deg0 % 360) + 360) % 360;
  }

  /** Parse Dec. A single bare number is degrees; two or more parts are
   *  degrees/arcminutes/arcseconds. Returns degrees in [-90,90] or null.
   *  The sign has to be read from the string, not from n[0]: "-00 30 00" has a
   *  first part of -0, and -0 === 0 in JS, which would silently flip the sign. */
  function parseDec(str) {
    const n = sexParts(str);
    if (!n) return null;
    let d;
    if (n.length === 1) {
      d = n[0];
    } else {
      const neg = /^\s*-/.test(String(str));
      const a = Math.abs(n[0]) + Math.abs(n[1] || 0) / 60 + Math.abs(n[2] || 0) / 3600;
      d = neg ? -a : a;
    }
    if (!isFinite(d) || d < -90 || d > 90) return null;
    return d;
  }

  /** Angle with an automatically chosen unit: degrees, arcmin or arcsec. */
  function fmtAngle(deg0, decimals) {
    const a = Math.abs(deg0);
    const d = decimals == null ? 2 : decimals;
    if (a >= 1) return deg0.toFixed(d) + '°';
    if (a >= 1 / 60) return (deg0 * 60).toFixed(d) + '′';
    return (deg0 * 3600).toFixed(d) + '″';
  }

  /** "1h 05m" / "45s" — for crossing durations. */
  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return m + 'm ' + pad2(rs) + 's';
    return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
  }

  SAT.util = {
    pad2, pad4, fmtDate, fmtDateLocal, clamp, wrapLon, deg, rad, uuid,
    escapeHtml, debounce, el, julian,
    sunSubpoint, moonSubpoint, nightPolygon, isNight, destPoint,
    sunEciUnit, sunAltitudeDeg, satSunlit,
    fmtRA, fmtDec, parseRA, parseDec, fmtAngle, fmtDur, sexParts,
  };
})();
