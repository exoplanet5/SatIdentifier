/* SAT.prop — SGP4 propagation and the topocentric solution (satellite.js 5.0).
 *
 * Much smaller than SatObserver's propagate.js: no ground tracks, no footprints, no
 * orbit rings. This tool only ever asks "where is it on the sky from here, how fast
 * is it moving, and how bright is it" — so look() is the whole module.
 *
 * Satrecs are built once and memoised on the object. The scan workers build their
 * own; this module serves the main thread (chart, table, info window), where the
 * working set is the few hundred objects in the current crossing list.
 */
(function () {
  'use strict';

  const F = SAT.frames;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const OMEGA_E = 7.292115146706979e-5;   // Earth rotation rate, rad/s

  const Re = 6378.137;                     // equatorial, km
  const Rp = 6356.752314245;               // polar, km

  /** Mean motion in rad/min.
   *
   *  satellite.js 5.0 names this field `no` (the un-Kozai'd mean motion SGP4
   *  actually integrates); other builds and the Vallado reference call it
   *  `no_kozai`. Accept either — reading the wrong one yields undefined, and
   *  `undefined > 5` is false, so every object would silently classify as MEO.
   */
  function meanMotion(rec) {
    return rec.no_kozai != null ? rec.no_kozai : rec.no;
  }

  /** Build and memoise the satrec. Returns false for a TLE satellite.js rejects.
   *
   *  Checking `rec.error` is NOT enough: twoline2satrec('1 garbage','2 garbage')
   *  returns error === 0 with inclo/ecco/jdsatepoch all NaN. Those NaNs then
   *  propagate silently into every downstream number instead of being counted as
   *  a bad object, so validate the fields we actually depend on.
   */
  function ensureSatrec(obj) {
    if (obj._satrec) return true;
    if (obj._satrecBad) return false;
    let rec = null;
    try {
      rec = satellite.twoline2satrec(obj.l1, obj.l2);
    } catch (e) {
      rec = null;
    }
    const n = rec ? meanMotion(rec) : NaN;
    const good = rec && !rec.error
      && isFinite(n) && n > 0
      && isFinite(rec.inclo)
      && isFinite(rec.ecco) && rec.ecco >= 0 && rec.ecco < 1
      && isFinite(rec.jdsatepoch);
    if (!good) {
      obj._satrecBad = true;
      return false;
    }
    obj._satrec = rec;
    return true;
  }

  /** Minutes since the TLE epoch — what sgp4() actually wants. */
  function tsinceMin(rec, date) {
    return (date.getTime() / 86400000 + 2440587.5 - rec.jdsatepoch) * 1440;
  }

  /** Position and velocity in TEME, km and km/s. Null if SGP4 fails at this time
   *  (decayed objects and bad elements do this routinely — callers skip silently). */
  function temeKm(obj, date) {
    if (!ensureSatrec(obj)) return null;
    let pv = null;
    try {
      pv = satellite.sgp4(obj._satrec, tsinceMin(obj._satrec, date));
    } catch (e) {
      return null;
    }
    if (!pv || !pv.position || !isFinite(pv.position.x)) return null;
    return { r: pv.position, v: pv.velocity };
  }

  /** True for an orbit-kind site; a missing kind IS 'ground' (pre-v0.2 saves). */
  function isOrbitSite(loc) {
    return !!loc && (loc.kind || 'ground') === 'orbit';
  }

  /** Observer state {r, v} in TEME km, km/s for a site of EITHER kind — the
   *  main-thread mirror of the scan worker's obsStateAt (CONTRACT "Orbital
   *  observing stations"). An orbit site resolves its object out of the loaded
   *  catalogue by NORAD at call time; null when the catalogue lacks it or SGP4
   *  fails — callers show that, they do not guess. */
  function obsState(loc, date, opts) {
    if (isOrbitSite(loc)) {
      const st = SAT.state;
      const obj = (st && st.objByNorad && loc.norad != null)
        ? st.objByNorad(loc.norad) : null;
      if (!obj) return null;
      return temeKm(obj, date);
    }
    const r = F.siteTemeKm(loc, date, opts && opts.dut1S);
    return { r: r, v: { x: -OMEGA_E * r.y, y: OMEGA_E * r.x, z: 0 } };
  }

  /** Kind-dispatching converters — every UI module calls THESE instead of
   *  SAT.frames.altAzToRaDec/raDecToAltAz directly (CONTRACT v0.2). Ground
   *  delegates verbatim, refraction included, so behaviour is byte-identical to
   *  v0.1. Orbit converts through the LVLH basis — az from along-track toward the
   *  orbit normal, el from the local horizontal toward zenith — with refraction
   *  never applied. Null when an orbit site cannot be resolved. */
  function siteAltAzToRaDec(loc, azDeg, elDeg, date, opts) {
    if (!isOrbitSite(loc)) return F.altAzToRaDec(azDeg, elDeg, loc, date, opts);
    const os = obsState(loc, date);
    if (!os) return null;
    const basis = F.lvlhBasis(os.r, os.v);
    if (!basis) return null;
    const rd = F.vecToRaDec(F.temeToJ2000(F.lvlhToVec(azDeg, elDeg, basis), date));
    return { raDeg: rd.raDeg, decDeg: rd.decDeg };
  }

  function siteRaDecToAltAz(loc, raDeg, decDeg, date, opts) {
    if (!isOrbitSite(loc)) return F.raDecToAltAz(raDeg, decDeg, loc, date, opts);
    const os = obsState(loc, date);
    if (!os) return null;
    const basis = F.lvlhBasis(os.r, os.v);
    if (!basis) return null;
    return F.vecToLvlh(F.j2000ToTeme(F.raDecToVec(raDeg, decDeg), date), basis);
  }

  /** Full topocentric solution, J2000 for RA/Dec and apparent-sky rates.
   *
   * Returns null when SGP4 fails (target OR an orbit site's observer). Does NOT
   * filter on elevation — a negative elevation is a valid answer and callers
   * decide what to do with it. On an orbit site azDeg/elDeg are LVLH angles and
   * the mount rate is measured against the LVLH frame (CONTRACT v0.2).
   */
  function look(loc, obj, date, opts) {
    const pv = temeKm(obj, date);
    if (!pv) return null;
    const o = opts || {};

    const os = obsState(loc, date, o);
    if (!os) return null;
    const siteTeme = os.r;
    // The observer's own inertial velocity. Required for d(RA,Dec)/dt to be
    // right: the sky rate is measured between two inertially-moving points.
    const siteVel = os.v;

    const rho = {
      x: pv.r.x - siteTeme.x, y: pv.r.y - siteTeme.y, z: pv.r.z - siteTeme.z,
    };
    const rhoDot = {
      x: pv.v.x - siteVel.x, y: pv.v.y - siteVel.y, z: pv.v.z - siteVel.z,
    };

    const rangeKm = Math.sqrt(rho.x * rho.x + rho.y * rho.y + rho.z * rho.z);
    if (!(rangeKm > 0)) return null;
    const rangeRate = (rho.x * rhoDot.x + rho.y * rhoDot.y + rho.z * rhoDot.z) / rangeKm;

    // TEME -> J2000 is a rotation, so velocity rotates too. The frame's own rotation
    // rate (precession+nutation, ~8e-12 rad/s) contributes under 1e-7 km/s here and
    // is dropped.
    const rhoJ = F.temeToJ2000(rho, date);
    const rhoDotJ = F.temeToJ2000(rhoDot, date);
    const rd = F.vecToRaDec(rhoJ);

    // Angular velocity, resolved into a north/east sky basis at the satellite's
    // direction, so the position angle is directly comparable to a streak measured
    // on an image.
    const ux = rhoJ.x / rangeKm, uy = rhoJ.y / rangeKm, uz = rhoJ.z / rangeKm;
    let ex = -uy, ey = ux, ez = 0;               // east = zhat x uhat
    const en = Math.hypot(ex, ey);
    if (en < 1e-12) { ex = 1; ey = 0; ez = 0; } else { ex /= en; ey /= en; }
    const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;

    function skyRate(vel) {
      const radial = vel.x * ux + vel.y * uy + vel.z * uz;
      const tx = vel.x - radial * ux, ty = vel.y - radial * uy, tz = vel.z - radial * uz;
      const dE = (tx * ex + ty * ey + tz * ez) / rangeKm;      // rad/s
      const dN = (tx * nx + ty * ny + tz * nz) / rangeKm;
      return {
        rate: Math.hypot(dE, dN) * R2D * 3600,
        pa: (Math.atan2(dE, dN) * R2D + 360) % 360,
      };
    }

    // TWO rates, because which one streaks your exposure depends on how you were
    // tracking, and they can differ by everything:
    //
    //   sky   — d(RA,Dec)/dt, motion against the STARS. This is the streak on a
    //           sidereally-guided exposure. A geostationary satellite is NOT
    //           stationary here: it co-rotates with the Earth, so it drifts through
    //           the star field at very nearly the sidereal rate, ~15"/s, which is
    //           exactly why GEO objects show up as dashes in tracked images.
    //   mount — d(alt,az)/dt, motion against the HORIZON, i.e. what a parked or
    //           alt-az-fixed instrument sees. Here a geostationary satellite really
    //           is a stationary dot and the stars are what trail.
    //
    // Subtracting omega x rho converts the inertial rate into the rotating frame:
    // omega_E z for a ground horizon, Omega_LVLH = (r x v)/|r|^2 for an orbit site.
    const sky = skyRate(rhoDotJ);
    let frameOm;
    if (isOrbitSite(loc)) {
      const r2o = siteTeme.x * siteTeme.x + siteTeme.y * siteTeme.y + siteTeme.z * siteTeme.z;
      frameOm = {
        x: (siteTeme.y * siteVel.z - siteTeme.z * siteVel.y) / r2o,
        y: (siteTeme.z * siteVel.x - siteTeme.x * siteVel.z) / r2o,
        z: (siteTeme.x * siteVel.y - siteTeme.y * siteVel.x) / r2o,
      };
    } else {
      frameOm = { x: 0, y: 0, z: OMEGA_E };
    }
    const omegaCrossRho = F.temeToJ2000({
      x: frameOm.y * rho.z - frameOm.z * rho.y,
      y: frameOm.z * rho.x - frameOm.x * rho.z,
      z: frameOm.x * rho.y - frameOm.y * rho.x,
    }, date);
    const mount = skyRate({
      x: rhoDotJ.x - omegaCrossRho.x,
      y: rhoDotJ.y - omegaCrossRho.y,
      z: rhoDotJ.z - omegaCrossRho.z,
    });
    const rateAsPerS = sky.rate, paDeg = sky.pa;

    // refract defaults ON: the app always applies refraction (round-2 review);
    // pass {refraction:false} only for tests needing the geometric path. An orbit
    // site reads out LVLH angles instead — and never refraction (CONTRACT v0.2).
    let aa;
    if (isOrbitSite(loc)) {
      const basis = F.lvlhBasis(siteTeme, siteVel);
      aa = basis ? F.vecToLvlh(rho, basis) : { azDeg: 0, elDeg: 90 };
    } else {
      aa = F.raDecToAltAz(rd.raDeg, rd.decDeg, loc, date,
        { refract: o.refraction !== false, dut1S: o.dut1S });
    }

    // Photometry lives in SAT.photo; it loads after this module, so resolve it at
    // call time rather than at definition time.
    let shadow = 'none', phaseDeg = null;
    if (SAT.photo) {
      const sun = F.sunTemeKm(date);
      const sh = SAT.photo.shadowState(pv.r, date, sun);
      shadow = sh.state;
      phaseDeg = SAT.photo.phaseAngleDeg(sun, siteTeme, pv.r);
    }

    return {
      raDeg: rd.raDeg, decDeg: rd.decDeg,
      azDeg: aa.azDeg, elDeg: aa.elDeg,
      rangeKm: rangeKm, rangeRateKmS: rangeRate,
      rateAsPerS: rateAsPerS, paDeg: paDeg,
      rateMountAsPerS: mount.rate, paMountDeg: mount.pa,
      phaseDeg: phaseDeg, shadow: shadow, sunlit: shadow === 'none',
      teme: pv.r, temeVel: pv.v,
    };
  }

  /** Orbital period in minutes, from the SGP4 mean motion. */
  function periodMinutes(obj) {
    if (!ensureSatrec(obj)) return NaN;
    const n = meanMotion(obj._satrec);   // rad/min
    return n > 0 ? (2 * Math.PI) / n : NaN;
  }

  function revsPerDay(obj) {
    if (!ensureSatrec(obj)) return NaN;
    return meanMotion(obj._satrec) * 1440 / (2 * Math.PI);
  }

  /** Orbit class, used for colour and for the class filter chips.
   *  Eccentricity is tested before altitude: a Molniya is HEO even though its
   *  mean motion would otherwise read as MEO. */
  function classOf(obj) {
    if (!ensureSatrec(obj)) return 'leo';
    const rec = obj._satrec;
    const n = revsPerDay(obj);
    const e = rec.ecco;
    if (e >= 0.25) return 'heo';
    if (n >= 0.9 && n <= 1.1 && e < 0.05) return 'geo';
    if (n > 5) return 'leo';
    return 'meo';
  }

  /** Semi-major axis (km) and apogee/perigee heights (km above the equator),
   *  from the elements alone. Stage 1 of the scan needs these without propagating. */
  function altitudes(obj) {
    if (!ensureSatrec(obj)) return null;
    const rec = obj._satrec;
    const n = meanMotion(rec);                 // rad/min
    if (!(n > 0)) return null;
    const MU = 398600.4418;                    // km^3/s^2
    const nRadS = n / 60;
    const a = Math.pow(MU / (nRadS * nRadS), 1 / 3);
    // satellite.js already carries alta/altp (apogee/perigee height in EARTH RADII)
    // from SGP4's own initialisation; prefer them so the scan's Stage 1 cull uses
    // exactly the geometry the propagator will use, not a re-derivation of it.
    const hasAlt = isFinite(rec.alta) && isFinite(rec.altp);
    return {
      aKm: a,
      apogeeKm: hasAlt ? rec.alta * Re : a * (1 + rec.ecco) - Re,
      perigeeKm: hasAlt ? rec.altp * Re : a * (1 - rec.ecco) - Re,
      incDeg: rec.inclo * R2D,
      raanDeg: rec.nodeo * R2D,
      ecc: rec.ecco,
    };
  }

  /** TLE epoch as a Date, and its age in days at `date` — the per-object tolerance
   *  in the scan and the confidence caveat in the UI both key off this. */
  function tleEpoch(obj) {
    if (!ensureSatrec(obj)) return null;
    return new Date((obj._satrec.jdsatepoch - 2440587.5) * 86400000);
  }

  function tleAgeDays(obj, date) {
    const ep = tleEpoch(obj);
    return ep ? (date.getTime() - ep.getTime()) / 86400000 : NaN;
  }

  SAT.prop = {
    Re, Rp,
    ensureSatrec, meanMotion, tsinceMin, temeKm, look,
    isOrbitSite, obsState, siteAltAzToRaDec, siteRaDecToAltAz,
    periodMinutes, revsPerDay, classOf, altitudes, tleEpoch, tleAgeDays,
  };
})();
