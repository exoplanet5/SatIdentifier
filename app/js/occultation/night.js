/* SAT.occultation.night — deterministic twilight windows for the P0 workflow.
 *
 * Scientific responsibility: convert a ground site's local civil date and IANA
 * time zone into UTC intervals during which the Sun is below a requested
 * geometric altitude.  This module is pure: it does not read application state,
 * touch the DOM, persist data, or start a scan.  Satellite passes and UI state
 * consume its returned NightWindow objects in later stages.
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const DAY_MS = 86400000;
  const SECOND_MS = 1000;
  const SAMPLE_STEP_MS = 10000;
  const ROOT_TOLERANCE_MS = 10;
  const CLASSIFICATION_EPS_DEG = 1e-9;

  const FORMATTERS = new Map();

  function finiteNumber(value, label) {
    const n = Number(value);
    if (!isFinite(n)) throw new Error(label + ' must be finite');
    return n;
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  function wrap360(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function wrap180(deg) {
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }

  function dateFromCivil(parts) {
    const date = new Date(0);
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    date.setUTCHours(parts.hour || 0, parts.minute || 0, parts.second || 0,
      parts.millisecond || 0);
    return date;
  }

  function civilMilliseconds(parts) {
    return dateFromCivil(parts).getTime();
  }

  function parseLocalDate(value) {
    const text = String(value == null ? '' : value).trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) throw new Error('localDate must be YYYY-MM-DD');
    const parts = {
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
      hour: 0, minute: 0, second: 0,
    };
    const date = dateFromCivil(parts);
    if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() !== parts.month - 1 ||
        date.getUTCDate() !== parts.day) {
      throw new Error('localDate is not a valid Gregorian calendar date');
    }
    return { year: parts.year, month: parts.month, day: parts.day };
  }

  function addCivilDays(dateParts, days) {
    const date = dateFromCivil({
      year: dateParts.year, month: dateParts.month, day: dateParts.day,
    });
    date.setUTCDate(date.getUTCDate() + days);
    return {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }

  function formatterFor(timeZone) {
    const key = String(timeZone == null ? 'UTC' : timeZone).trim();
    if (!key) throw new Error('timeZone must be a valid IANA time-zone name');
    if (FORMATTERS.has(key)) return FORMATTERS.get(key);
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: key,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      });
      // Force validation now; some engines defer an invalid time zone until use.
      formatter.format(new Date(0));
    } catch (error) {
      throw new Error('timeZone must be a valid IANA time-zone name: ' + key);
    }
    FORMATTERS.set(key, formatter);
    return formatter;
  }

  function partsAt(utcMs, formatter) {
    const out = {};
    formatter.formatToParts(new Date(utcMs)).forEach((part) => {
      if (part.type !== 'literal') out[part.type] = Number(part.value);
    });
    // h24 can still appear on older engines despite hourCycle:'h23'. Treat it as
    // the first hour of the displayed civil day, not as hour 24 of the prior one.
    if (out.hour === 24) out.hour = 0;
    return out;
  }

  function sameCivilSecond(a, b) {
    return a.year === b.year && a.month === b.month && a.day === b.day &&
      a.hour === b.hour && a.minute === b.minute && a.second === b.second;
  }

  /** Return the UTC offset at an instant, in milliseconds east of UTC. */
  function offsetAt(utcMs, formatter) {
    const wholeSecond = Math.floor(utcMs / SECOND_MS) * SECOND_MS;
    return civilMilliseconds(partsAt(wholeSecond, formatter)) - wholeSecond;
  }

  /** Convert a local civil clock value to UTC without using the host time zone.
   *
   * The fixed-point update solves
   *
   *     utc = pseudoUtc(localFields) - offset(timeZone, utc).
   *
   * Midnight and noon are deliberately used by the night-window API; they are
   * unambiguous in ordinary DST transitions.  The final field check catches
   * unusual historical skipped/duplicated civil times instead of silently
   * returning a value in a different local date.
   */
  function localToUtcMs(parts, formatter) {
    const target = civilMilliseconds(parts);
    let candidate = target;
    for (let i = 0; i < 8; i++) {
      const next = target - offsetAt(candidate, formatter);
      if (next === candidate) break;
      candidate = next;
    }
    const shown = partsAt(candidate, formatter);
    if (!sameCivilSecond(shown, parts)) {
      throw new Error('local civil time does not exist in timeZone: ' +
        parts.year + '-' + String(parts.month).padStart(2, '0') + '-' +
        String(parts.day).padStart(2, '0') + ' ' +
        String(parts.hour).padStart(2, '0') + ':00');
    }
    return candidate;
  }

  function siteFrom(input) {
    const source = input && input.site ? input.site : input;
    if (!source || typeof source !== 'object') {
      throw new Error('site with latDeg and lonDeg is required');
    }
    if ((source.kind || 'ground') === 'orbit') {
      throw new Error('night windows require a ground observing site');
    }
    const latDeg = finiteNumber(source.latDeg, 'site.latDeg');
    const lonDeg = finiteNumber(source.lonDeg, 'site.lonDeg');
    if (latDeg < -90 || latDeg > 90) throw new Error('site.latDeg must be in [-90, 90]');
    if (lonDeg < -180 || lonDeg > 180) {
      throw new Error('site.lonDeg must be in [-180, 180]');
    }
    const altM = source.altM == null ? 0 : finiteNumber(source.altM, 'site.altM');
    return { latDeg: latDeg, lonDeg: lonDeg, altM: altM };
  }

  function resolvedInput(input) {
    if (!input || typeof input !== 'object') throw new Error('night-window parameters are required');
    const site = siteFrom(input);
    const localDate = parseLocalDate(input.localDate);
    const timeZone = String(input.timeZone == null ? 'UTC' : input.timeZone).trim();
    const formatter = formatterFor(timeZone);
    const sunAltitudeLimitDeg = finiteNumber(
      input.sunAltitudeLimitDeg == null ?
        (input.twilightDeg == null ? -12 : input.twilightDeg) : input.sunAltitudeLimitDeg,
      'sunAltitudeLimitDeg');
    if (sunAltitudeLimitDeg < -90 || sunAltitudeLimitDeg > 90) {
      throw new Error('sunAltitudeLimitDeg must be in [-90, 90]');
    }
    const dut1S = input.dut1S == null ? 0 : finiteNumber(input.dut1S, 'dut1S');
    return { site, localDate, timeZone, formatter, sunAltitudeLimitDeg, dut1S };
  }

  function julianUtc(ms) {
    return ms / DAY_MS + 2440587.5;
  }

  /*
   * The following compact VSOP87 Earth series is the same numerical family used
   * by the NREL Solar Position Algorithm.  Coefficients are in the conventional
   * A, B, C form: sum(A*cos(B + C*jme)), with jme = Julian Ephemeris Millennium;
   * the resulting radians are divided by 1e8.  The retained Earth terms are
   * sufficient for an arcsecond-level solar direction near the supported 2026
   * observing dates while keeping this browser module dependency-free.
   *
   * Arrays are intentionally kept local to night.js.  They are not a replacement
   * for SAT.frames.sunJ2000(), whose documented ~0.01° result remains appropriate
   * for ordinary chart photometry; twilight boundaries need the tighter model.
   */
  const VSOP_L = [
    [
      [175347046, 0, 0], [3341656, 4.6692568, 6283.07585],
      [34894, 4.6261, 12566.1517], [3497, 2.7441, 5753.3849],
      [3418, 2.8289, 3.5231], [3136, 3.6277, 77713.7715],
      [2676, 4.4181, 7860.4194], [2343, 6.1352, 3930.2097],
      [1324, 0.7425, 11506.7698], [1273, 2.0371, 529.691],
      [1199, 1.1096, 1577.3435], [990, 5.233, 5884.927],
      [902, 2.045, 26.298], [857, 3.508, 398.149],
      [780, 1.179, 5223.694], [753, 2.533, 5507.553],
      [505, 4.583, 18849.228], [492, 4.205, 775.523],
      [357, 2.92, 0.067], [317, 5.849, 11790.629],
      [284, 1.899, 796.298], [271, 0.315, 10977.079],
      [243, 0.345, 5486.778], [206, 4.806, 2544.314],
      [205, 1.869, 5573.143], [202, 2.458, 6069.777],
      [156, 0.833, 213.299], [132, 3.411, 2942.463],
      [126, 1.083, 20.775], [115, 0.645, 0.98],
      [103, 0.636, 4694.003], [102, 0.976, 15720.839],
      [102, 4.267, 7.114], [99, 6.21, 2146.17],
      [98, 0.68, 155.42], [86, 5.98, 161000.69],
      [85, 1.3, 6275.96], [85, 3.67, 71430.7],
      [80, 1.81, 17260.15], [79, 3.04, 12036.46],
      [75, 1.76, 5088.63], [74, 3.5, 3154.69],
      [74, 4.68, 801.82], [70, 0.83, 9437.76],
      [62, 3.98, 8827.39], [61, 1.82, 7084.9],
      [57, 2.78, 6286.6], [56, 4.39, 14143.5],
      [56, 3.47, 6279.55], [52, 0.19, 12139.55],
      [52, 1.33, 1748.02], [51, 0.28, 5856.48],
      [49, 0.49, 1194.45], [41, 5.37, 8429.24],
      [41, 2.4, 19651.05], [39, 6.17, 10447.39],
      [37, 6.04, 10213.29], [37, 2.57, 1059.38],
      [36, 1.71, 2352.87], [36, 1.78, 6812.77],
      [33, 0.59, 17789.85], [30, 0.44, 83996.85],
      [30, 2.74, 1349.87], [25, 3.16, 4690.48],
    ],
    [
      [628331966747, 0, 0], [206059, 2.678235, 6283.07585],
      [4303, 2.6351, 12566.1517], [425, 1.59, 3.523],
      [119, 5.796, 26.298], [109, 2.966, 1577.344],
      [93, 2.59, 18849.23], [72, 1.14, 529.69],
      [68, 1.87, 398.15], [67, 4.41, 5507.55],
      [59, 2.89, 5223.69], [56, 2.17, 155.42],
      [45, 0.4, 796.3], [36, 0.47, 775.52],
      [29, 2.65, 7.11], [21, 5.34, 0.98],
      [19, 1.85, 5486.78], [19, 4.97, 213.3],
      [17, 2.99, 6275.96], [16, 0.03, 2544.31],
      [16, 1.43, 2146.17], [15, 1.21, 10977.08],
      [12, 2.83, 1748.02], [12, 3.26, 5088.63],
      [12, 5.27, 1194.45], [12, 2.08, 4694],
      [11, 0.77, 553.57], [10, 1.3, 6286.6],
      [10, 4.24, 1349.87], [9, 2.7, 242.73],
      [9, 5.64, 951.72], [8, 5.3, 2352.87],
      [6, 2.65, 9437.76], [6, 4.67, 4690.48],
    ],
    [
      [52919, 0, 0], [8720, 1.0721, 6283.0758],
      [309, 0.867, 12566.152], [27, 0.05, 3.52],
      [16, 5.19, 26.3], [16, 3.68, 155.42],
      [10, 0.76, 18849.23], [9, 2.06, 77713.77],
      [7, 0.83, 775.52], [5, 4.66, 1577.34],
      [4, 1.03, 7.11], [4, 3.44, 5573.14],
      [3, 5.14, 796.3], [3, 6.05, 5507.55],
      [3, 1.19, 242.73], [3, 6.12, 529.69],
      [3, 0.31, 398.15], [3, 2.28, 553.57],
      [2, 4.38, 5223.69], [2, 3.75, 0.98],
    ],
    [
      [289, 5.844, 6283.076], [35, 0, 0],
      [17, 5.49, 12566.15], [3, 5.2, 155.42],
      [1, 4.72, 3.52], [1, 5.3, 18849.23],
      [1, 5.97, 242.73],
    ],
    [[114, 3.142, 0], [8, 4.13, 6283.08], [1, 3.84, 12566.15]],
    [[1, 3.14, 0]],
  ];

  const VSOP_B = [
    [[280, 3.199, 84334.662], [102, 5.422, 5507.553],
      [80, 3.88, 5223.69], [44, 3.7, 2352.87], [32, 4, 1577.34]],
    [[9, 3.9, 5507.55], [6, 1.73, 5223.69]],
  ];

  const NUTATION_TERMS = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
    [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
    [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
    [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
    [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
    [1, 0, 2, 0, 2, -301, 0, 129, -0.1],
    [0, -1, 2, -2, 2, 217, -0.5, -95, 0.3],
    [1, 0, 0, -2, 0, -158, 0, 0, 0],
    [0, 0, 2, -2, 1, 129, 0.1, -70, 0],
    [-1, 0, 2, 0, 2, 123, 0, -53, 0],
    [1, 0, 0, 0, 1, 63, 0.1, -33, 0],
    [0, 0, 0, 2, 0, 63, 0, -2, 0],
    [-1, 0, 2, 2, 2, -59, 0, 26, 0],
    [-1, 0, 0, 0, 1, -58, -0.1, 32, 0],
    [1, 0, 2, 0, 1, -51, 0, 27, 0],
    [2, 0, 0, -2, 0, 48, 0, 1, 0],
    [-2, 0, 2, 0, 1, 46, 0, -24, 0],
  ];

  const LEAP_SECONDS = [
    [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
    [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35],
    [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37],
  ];

  function sumVsop(terms, jme) {
    let sum = 0;
    for (let i = 0; i < terms.length; i++) {
      const row = terms[i];
      sum += row[0] * Math.cos(row[1] + row[2] * jme);
    }
    return sum;
  }

  function taiMinusUtc(utcMs) {
    let seconds = LEAP_SECONDS[0][1];
    for (let i = 0; i < LEAP_SECONDS.length; i++) {
      if (utcMs >= LEAP_SECONDS[i][0]) seconds = LEAP_SECONDS[i][1];
    }
    return seconds;
  }

  function solarNutation(jce) {
    const x = [
      297.85036 + 445267.111480 * jce - 0.0019142 * jce * jce + jce * jce * jce / 189474,
      357.52772 + 35999.050340 * jce - 0.0001603 * jce * jce - jce * jce * jce / 300000,
      134.96298 + 477198.867398 * jce + 0.0086972 * jce * jce + jce * jce * jce / 56250,
      93.27191 + 483202.017538 * jce - 0.0036825 * jce * jce + jce * jce * jce / 327270,
      125.04452 - 1934.136261 * jce + 0.0020708 * jce * jce + jce * jce * jce / 450000,
    ];
    let dPsi = 0, dEps = 0;
    for (let i = 0; i < NUTATION_TERMS.length; i++) {
      const t = NUTATION_TERMS[i];
      let arg = 0;
      for (let j = 0; j < 5; j++) arg += t[j] * x[j];
      arg *= D2R;
      dPsi += (t[5] + t[6] * jce) * Math.sin(arg);
      dEps += (t[7] + t[8] * jce) * Math.cos(arg);
    }
    return { dPsiDeg: dPsi / 36000000, dEpsDeg: dEps / 36000000 };
  }

  function meanObliquityDeg(jme) {
    const u = jme / 10;
    return (84381.448 - 4680.93 * u - 1.55 * u * u + 1999.25 * u * u * u -
      51.38 * Math.pow(u, 4) - 249.67 * Math.pow(u, 5) - 39.05 * Math.pow(u, 6) +
      7.12 * Math.pow(u, 7) + 27.87 * Math.pow(u, 8) + 5.79 * Math.pow(u, 9) +
      2.45 * Math.pow(u, 10)) / 3600;
  }

  function earthRadiusAu(jme) {
    // The aberration correction only needs R to much better than 0.1%; this
    // compact orbital-radius expression is below that error budget.
    const T = jme * 10;
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R;
    return 1.00014 - 0.01671 * Math.cos(M) - 0.00014 * Math.cos(2 * M);
  }

  function solarGeometry(utcMs, dut1S, deltaTS) {
    const jdUtc = julianUtc(utcMs);
    const jde = jdUtc + deltaTS / DAY_MS;
    const jce = (jde - 2451545.0) / 36525;
    const jme = jce / 10;
    let longitudeRad = 0;
    for (let i = 0, power = 1; i < VSOP_L.length; i++, power *= jme) {
      longitudeRad += sumVsop(VSOP_L[i], jme) * power;
    }
    longitudeRad /= 1e8;
    let latitudeRad = 0;
    for (let i = 0, power = 1; i < VSOP_B.length; i++, power *= jme) {
      latitudeRad += sumVsop(VSOP_B[i], jme) * power;
    }
    latitudeRad /= 1e8;
    const radiusAu = earthRadiusAu(jme);
    const thetaDeg = wrap360(longitudeRad * R2D + 180);
    const betaDeg = -latitudeRad * R2D;
    const nut = solarNutation(jce);
    const epsilonDeg = meanObliquityDeg(jme) + nut.dEpsDeg;
    const lambdaDeg = thetaDeg + nut.dPsiDeg - 20.4898 / (3600 * radiusAu);
    const lambda = lambdaDeg * D2R;
    const beta = betaDeg * D2R;
    const epsilon = epsilonDeg * D2R;
    const raDeg = wrap360(Math.atan2(Math.sin(lambda) * Math.cos(epsilon) -
      Math.tan(beta) * Math.sin(epsilon), Math.cos(lambda)) * R2D);
    const decDeg = Math.asin(clamp(Math.sin(beta) * Math.cos(epsilon) +
      Math.cos(beta) * Math.sin(epsilon) * Math.sin(lambda), -1, 1)) * R2D;
    const gastDeg = gmstDeg(utcMs, dut1S) + nut.dPsiDeg * Math.cos(epsilon);
    return { raDeg, decDeg, gastDeg, radiusAu };
  }

  /** Greenwich mean sidereal time, degrees, from the UT1 Julian date. */
  function gmstDeg(utcMs, dut1S) {
    const jd = julianUtc(utcMs + dut1S * SECOND_MS);
    const T = (jd - 2451545.0) / 36525;
    return wrap360(280.46061837 + 360.98564736629 * (jd - 2451545.0) +
      0.000387933 * T * T - T * T * T / 38710000);
  }

  /** Geometric altitude of the solar centre above a WGS-84 site's horizon.
   *
   * Parameters are `(latDeg, lonDeg, date, options)` or, for callers that
   * already hold a site object, `(site, date, options)`. `date` is a Date or a
   * finite UTC Unix-millisecond number. `dut1S` is an optional UT1-UTC offset;
   * it defaults to zero, matching the rest of SatIdentifier's UTC-only model.
   * `deltaTS` may supply TT-UTC in seconds; otherwise the module's leap-second
   * table is used. No atmospheric refraction or solar-disc radius is applied:
   * callers choose the physical altitude threshold explicitly (for example
   * -12° or -18°).
   */
  function sunAltitudeDeg(a, b, c, d) {
    let site, date, options;
    if (a && typeof a === 'object' && a.latDeg != null) {
      site = siteFrom(a);
      date = b;
      options = c || {};
    } else {
      site = siteFrom({ latDeg: a, lonDeg: b });
      date = c;
      options = d || {};
    }
    const utcMs = date instanceof Date ? date.getTime() : finiteNumber(date, 'date');
    if (!isFinite(utcMs)) throw new Error('date must be a valid Date or UTC millisecond value');
    const dut1S = options.dut1S == null ? 0 : finiteNumber(options.dut1S, 'dut1S');
    const deltaTS = options.deltaTS == null
      ? taiMinusUtc(utcMs) + 32.184
      : finiteNumber(options.deltaTS, 'deltaTS');
    const sun = solarGeometry(utcMs, dut1S, deltaTS);
    const H = wrap180(sun.gastDeg + site.lonDeg - sun.raDeg);
    const phi = site.latDeg * D2R;
    const dec = sun.decDeg * D2R;

    // Geocentric-to-topocentric correction follows the standard equatorial
    // horizontal-parallax construction.  Twilight is a local observing-site
    // quantity, so the ellipsoidal observer displacement is retained even though
    // the later satellite geometry uses the full WGS-84 site vector.
    const xi = 8.794 / (3600 * sun.radiusAu);
    const u = Math.atan(0.99664719 * Math.tan(phi));
    const observerX = Math.cos(u) + (site.altM / 6378140) * Math.cos(phi);
    const observerY = 0.99664719 * Math.sin(u) + (site.altM / 6378140) * Math.sin(phi);
    const h = H * D2R;
    const xiRad = xi * D2R;
    const deltaAlpha = Math.atan2(-observerX * Math.sin(xiRad) * Math.sin(h),
      Math.cos(dec) - observerX * Math.sin(xiRad) * Math.cos(h));
    const topocentricDec = Math.atan2(
      (Math.sin(dec) - observerY * Math.sin(xiRad)) * Math.cos(deltaAlpha),
      Math.cos(dec) - observerX * Math.sin(xiRad) * Math.cos(h));
    const topocentricH = (H * D2R) - deltaAlpha;
    const sinAlt = Math.sin(phi) * Math.sin(topocentricDec) +
      Math.cos(phi) * Math.cos(topocentricDec) * Math.cos(topocentricH);
    return Math.asin(clamp(sinAlt, -1, 1)) * R2D;
  }

  function localClockUtc(dateParts, hour, formatter) {
    return localToUtcMs({
      year: dateParts.year, month: dateParts.month, day: dateParts.day,
      hour: hour, minute: 0, second: 0,
    }, formatter);
  }

  function localMidnightBounds(localDate, formatter) {
    const nextDate = addCivilDays(localDate, 1);
    return {
      startMs: localClockUtc(localDate, 0, formatter),
      endMs: localClockUtc(nextDate, 0, formatter),
      nextDate: nextDate,
    };
  }

  function crossingRoot(left, right, leftValue, rightValue, valueAt) {
    if (leftValue === 0) return left;
    if (rightValue === 0) return right;
    let a = left, b = right, fa = leftValue;
    while (b - a > ROOT_TOLERANCE_MS) {
      const mid = Math.floor((a + b) / 2);
      const fm = valueAt(mid);
      if (fm === 0) return mid;
      if ((fa < 0 && fm < 0) || (fa > 0 && fm > 0)) {
        a = mid;
        fa = fm;
      } else {
        b = mid;
      }
    }
    return Math.round((a + b) / 2);
  }

  function uniqueRoots(roots) {
    roots.sort((a, b) => a - b);
    const out = [];
    roots.forEach((root) => {
      if (!out.length || root - out[out.length - 1] > ROOT_TOLERANCE_MS * 4) out.push(root);
    });
    return out;
  }

  function makeWindow(startMs, endMs, kind, params) {
    return {
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      sunAltitudeLimitDeg: params.sunAltitudeLimitDeg,
      kind: kind,
    };
  }

  /** Return UTC night windows for one local civil date.
   *
   * Parameters
   * ----------
   * input : object
   *     `{site:{latDeg,lonDeg}, localDate:'YYYY-MM-DD', timeZone,`
   *     `sunAltitudeLimitDeg}`. `latDeg`/`lonDeg` may also be top-level. The
   *     longitude is degrees east, latitude degrees north, and `timeZone` is an
   *     IANA name used only for civil-date/DST conversion. `dut1S` is optional.
   *
   * Returns
   * -------
   * NightWindow[]
   *     Sorted, disjoint UTC intervals with `startMs <= endMs`. A normal night
   *     has `kind:'normal'`; polar night has one full local-civil-day window with
   *     `kind:'polar-night'`; polar day/no night returns `[]`.
   *
   * Numerical method
   * ----------------
   * The local noon-to-next-noon interval contains the evening descent and next
   * morning ascent for a normal observing night. The solar-altitude residual is
   * sampled every 10 s, each sign-changing bracket is refined by bisection to a
   * 10 ms time bracket, and the result is rounded to integer milliseconds. The
   * 10 s sampling is much shorter than the shortest ordinary twilight transition
   * and the no-root branch is classified from the sampled extrema.
   */
  function windowsForDate(input) {
    const p = resolvedInput(input);
    const civil = localMidnightBounds(p.localDate, p.formatter);
    const startSearch = localClockUtc(p.localDate, 12, p.formatter);
    const nextDate = civil.nextDate;
    const endSearch = localClockUtc(nextDate, 12, p.formatter);
    const residual = (ms) => sunAltitudeDeg(p.site, ms, { dut1S: p.dut1S }) -
      p.sunAltitudeLimitDeg;

    const roots = [];
    let minValue = Infinity;
    let maxValue = -Infinity;
    let previousMs = startSearch;
    let previousValue = residual(previousMs);
    minValue = Math.min(minValue, previousValue);
    maxValue = Math.max(maxValue, previousValue);
    for (let nextMs = startSearch + SAMPLE_STEP_MS; nextMs < endSearch; nextMs += SAMPLE_STEP_MS) {
      const value = residual(nextMs);
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
      if (previousValue === 0 || value === 0 ||
          (previousValue < 0 && value > 0) || (previousValue > 0 && value < 0)) {
        roots.push(crossingRoot(previousMs, nextMs, previousValue, value, residual));
      }
      previousMs = nextMs;
      previousValue = value;
    }
    const finalValue = residual(endSearch);
    minValue = Math.min(minValue, finalValue);
    maxValue = Math.max(maxValue, finalValue);
    if (previousValue === 0 || finalValue === 0 ||
        (previousValue < 0 && finalValue > 0) || (previousValue > 0 && finalValue < 0)) {
      roots.push(crossingRoot(previousMs, endSearch, previousValue, finalValue, residual));
    }

    if (maxValue <= CLASSIFICATION_EPS_DEG) {
      return [makeWindow(civil.startMs, civil.endMs, 'polar-night', p)];
    }
    if (minValue >= -CLASSIFICATION_EPS_DEG) return [];

    const boundaries = [startSearch].concat(uniqueRoots(roots), [endSearch]);
    const windows = [];
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const a = boundaries[i], b = boundaries[i + 1];
      if (b <= a) continue;
      if (residual((a + b) / 2) < 0) {
        windows.push(makeWindow(a, b, 'normal', p));
      }
    }
    return windows;
  }

  function describeDate(input) {
    const p = resolvedInput(input);
    const windows = windowsForDate(input);
    return {
      localDate: input.localDate,
      timeZone: p.timeZone,
      sunAltitudeLimitDeg: p.sunAltitudeLimitDeg,
      kind: windows.length ? windows[0].kind : 'no-night',
      windows: windows,
    };
  }

  /** Return the single canonical window for ordinary P0 callers, or null when
   * the selected date is polar day/no-night. Multiple windows remain available
   * through `windowsForDate()` for unusual thresholds. */
  function windowForDate(input) {
    const windows = windowsForDate(input);
    return windows.length === 1 ? windows[0] : (windows.length ? windows[0] : null);
  }

  const API = {
    sunAltitudeDeg: sunAltitudeDeg,
    windowsForDate: windowsForDate,
    nightWindows: windowsForDate,
    windowForDate: windowForDate,
    describeDate: describeDate,
  };

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.night = API;
})();
