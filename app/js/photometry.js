/* SAT.photo — brightness estimation, phase angle, Earth shadow.
 *
 * The whole point of this app is matching an unidentified trail on a real exposure
 * against a candidate list, so "how bright would it have been" is a first-class
 * answer, not decoration. It is also the least certain number the app produces, and
 * how uncertain varies enormously between objects, so magnitude() always returns
 * WHICH tier produced the number and the UI shows it. Best first:
 *
 *   'qsmag'   observed McCants standard magnitude          good to a few tenths
 *   'rcs'     SATCAT radar cross-section, diffuse sphere   right order of magnitude
 *   'model'   published constellation brightness by name   ~1 mag scatter
 *   'type'    OBJECT_TYPE size class                       ~1-2 mag scatter
 *   'default' 1 m sphere, i.e. we know nothing at all      a placeholder, not an estimate
 *
 * The two middle tiers exist because of a measured gap, not for completeness:
 * CelesTrak publishes NO RCS at all above NORAD 50000 (and only ~26% for
 * 40000-49999), while the McCants qsmag file is currently 404. Without them
 * essentially every object in a modern catalogue lands on 'default', which would
 * make both the magnitude column and the magnitude FILTER useless at exactly the
 * moment they matter most — two thirds of the active catalogue is Starlink, and
 * recent launches are precisely the unidentified trails people are chasing.
 * OBJECT_TYPE, by contrast, is 100% populated.
 *
 * Depends on SAT.frames for the solar position only.
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const SUN_R_KM = 696000;          // solar photospheric radius
  const SUN_MAG_V = -26.74;         // apparent V of the Sun at 1 AU
  const ALBEDO = 0.20;              // diffuse albedo assumed for bare-RCS objects
  const DEFAULT_RADIUS_M = 1.0;     // "we have nothing at all" sphere
  const QSMAG_RANGE_KM = 1000;      // range McCants standard magnitudes are defined at

  /* Effective sphere radius by OBJECT_TYPE, metres. These are COARSE SIZE CLASSES,
   * not measurements: real objects of one type scatter by a magnitude or more, and
   * a tumbling flat panel or a cylinder seen end-on can miss by several. They are
   * deliberately round numbers — quoting them to two decimals would imply a
   * precision that does not exist, and would invite someone to "refine" them.
   * Their job is to put debris, payloads and rocket bodies in the right ORDER and
   * roughly the right decade, so the magnitude filter stops discarding everything.
   *
   * Rocket bodies are the brightest population in any catalogue: typical spent
   * upper stages are 3-4 m diameter cylinders, hence ~2 m effective radius. */
  const TYPE_RADIUS_M = {
    'R/B': 2.0,     // rocket body
    'PAY': 1.0,     // payload
    'DEB': 0.15,    // debris
    // 'UNK' is deliberately absent: unknown means unknown, so it falls to 'default'
    // rather than being given a fabricated size class.
  };

  // CelesTrak's SATCAT uses the short codes; the OMM/gp endpoint spells them out.
  // Accept both, because silently dropping the whole catalogue to 'default' is
  // exactly the failure this tier was added to fix.
  const TYPE_ALIAS = {
    'ROCKET BODY': 'R/B', 'PAYLOAD': 'PAY', 'DEBRIS': 'DEB', 'UNKNOWN': 'UNK',
  };

  /* Standard magnitudes (1000 km, 90 deg phase — the qsmag convention) for
   * constellations whose brightness is actually documented, matched by name prefix.
   *
   * Round numbers again, and the scatter here is real: Starlink v2 Mini are not
   * v1.5, brightness swings strongly with orientation, and the figure below is the
   * post-mitigation design target (visors, then dielectric mirror film) rather than
   * a fleet-wide measurement. Treat +-1 mag as normal and more during slew. Still
   * far better than a 1 m sphere for the two thirds of the catalogue this covers. */
  const MODEL_STD_MAG = [
    ['STARLINK', 7.0],
    ['ONEWEB', 7.5],
  ];

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const norm = (v) => Math.sqrt(dot(v, v));

  // ---- phase function ------------------------------------------------------

  /** Lambertian sphere phase function, phi in radians; F(0) = 2/(3*pi) is the
   *  full-phase peak and F(pi) = 0 exactly (a fully back-lit sphere shows no
   *  illuminated area at all). */
  const phaseFn = (phi) => (2 / (3 * Math.PI * Math.PI)) *
    ((Math.PI - phi) * Math.cos(phi) + Math.sin(phi));

  // McCants standard magnitudes are quoted at 50% illumination, i.e. phase 90 deg,
  // so the qsmag tier needs F normalised to F(90) rather than to the peak.
  const F90 = phaseFn(Math.PI / 2);

  // ---- magnitude -----------------------------------------------------------

  /** Diffuse-sphere magnitude for radius rM metres at range rangeKm, given F(phi). */
  function sphereMag(rM, rangeKm, F) {
    const dM = rangeKm * 1000;
    return SUN_MAG_V - 2.5 * Math.log10(ALBEDO * rM * rM * F / (dM * dM));
  }

  /** Scale a standard magnitude (defined at 1000 km, phase 90) to this geometry.
   *  Shared by the 'qsmag' and 'model' tiers — both quote the same convention. */
  function stdMagAt(std, rangeKm, F) {
    return std + 5 * Math.log10(rangeKm / QSMAG_RANGE_KM) - 2.5 * Math.log10(F / F90);
  }

  /** Documented standard magnitude for a known constellation, or null. */
  function modelStdMag(name) {
    if (typeof name !== 'string') return null;
    const n = name.trim().toUpperCase();
    for (let i = 0; i < MODEL_STD_MAG.length; i++) {
      if (n.startsWith(MODEL_STD_MAG[i][0])) return MODEL_STD_MAG[i][1];
    }
    return null;
  }

  /** Effective radius in metres from OBJECT_TYPE, or null for UNK/missing. */
  function typeRadiusM(type) {
    if (typeof type !== 'string') return null;
    const t = type.trim().toUpperCase();
    return TYPE_RADIUS_M[TYPE_ALIAS[t] || t] || null;
  }

  /** Accept `shadow` either as the bare string SAT.prop.look() carries or as the
   *  whole {state, frac} object shadowState() returns — only the latter knows how
   *  deeply a penumbral object is dimmed. */
  function shadowOf(geom) {
    const s = geom.shadow;
    if (s && typeof s === 'object') return { state: s.state || 'none', frac: s.frac };
    return { state: s || 'none', frac: geom.sunFrac };
  }

  /** Estimated visual magnitude.
   *
   * obj  = ObjEntry; reads stdMag, rcs, name and type, any of which may be missing.
   * geom = {rangeKm, phaseDeg, shadow[, sunFrac]}.
   *
   * Returns {mag, method} with method one of 'qsmag' | 'rcs' | 'model' | 'type' |
   * 'default' | 'eclipsed' | 'none', best first — the UI shows it so the user can
   * see how much to trust each row. mag is null whenever no honest number exists;
   * note that even the best tier here is an estimate, and an eclipsed
   * object is not a very faint object, it is an invisible one, and the crossings
   * table must be able to say so rather than print a misleading figure.
   */
  function magnitude(obj, geom) {
    const g = geom || {};
    const sh = shadowOf(g);
    // Umbra is a hard null. Penumbra is only recoverable when we were given the
    // unobscured fraction; a bare 'penumbra' string carries no depth, and guessing
    // one would silently fabricate the answer.
    if (sh.state === 'umbra' || (sh.state === 'penumbra' && !(sh.frac > 0))) {
      return { mag: null, method: 'eclipsed' };
    }

    const rangeKm = g.rangeKm;
    if (!(rangeKm > 0) || !isFinite(rangeKm)) return { mag: null, method: 'none' };

    const phi = clamp(g.phaseDeg == null ? 90 : g.phaseDeg, 0, 180) * D2R;
    // F(180) is exactly zero, and log10(0) would put -Infinity into a sortable
    // table column; floor it at a magnitude no display cares about (~1e-9 -> +22 mag
    // of extinction, far below anything this tool reports).
    const F = Math.max(phaseFn(phi), 1e-9);

    // Tiers in strict best-first order. Anything measured about THIS object beats
    // any prior about its population, so qsmag and rcs come first; a documented
    // constellation brightness beats a bare type class; UNK falls all the way through.
    const std = obj && obj.stdMag;
    const rcs = obj && obj.rcs;
    const model = modelStdMag(obj && obj.name);
    const typeR = typeRadiusM(obj && obj.type);
    let mag, method;
    if (typeof std === 'number' && isFinite(std)) {
      // qsmag: an observed standard magnitude at 1000 km and 50% illumination.
      mag = stdMagAt(std, rangeKm, F);
      method = 'qsmag';
    } else if (typeof rcs === 'number' && rcs > 0) {
      // Radar cross-section is not an optical area, but sqrt(rcs/pi) is the right
      // order of magnitude for the effective radius, and it is measured from the
      // object itself rather than assumed from its class.
      mag = sphereMag(Math.sqrt(rcs / Math.PI), rangeKm, F);
      method = 'rcs';
    } else if (model != null) {
      mag = stdMagAt(model, rangeKm, F);
      method = 'model';
    } else if (typeR != null) {
      mag = sphereMag(typeR, rangeKm, F);
      method = 'type';
    } else {
      mag = sphereMag(DEFAULT_RADIUS_M, rangeKm, F);
      method = 'default';
    }

    // Penumbral dimming: the object still shines, just under a partly eclipsed Sun.
    if (sh.state === 'penumbra') mag += -2.5 * Math.log10(clamp(sh.frac, 1e-6, 1));
    return { mag: mag, method: method };
  }

  // ---- geometry ------------------------------------------------------------

  /** Sun-satellite-observer angle in degrees: 0 = fully lit (Sun behind the
   *  observer), 180 = back-lit. All three vectors geocentric, same frame (TEME). */
  function phaseAngleDeg(sunTeme, siteTeme, satTeme) {
    const toSun = sub(sunTeme, satTeme);
    const toObs = sub(siteTeme, satTeme);
    const d = norm(toSun) * norm(toObs);
    if (!(d > 0)) return 0;
    return Math.acos(clamp(dot(toSun, toObs) / d, -1, 1)) * R2D;
  }

  /** Conical Earth shadow: {state:'none'|'penumbra'|'umbra', frac}.
   *
   * frac is the unobscured fraction of the solar disc (1 in full sunlight, 0 in the
   * umbra), computed as the overlap of two circles on the sky as seen from the
   * satellite — the Earth's disc and the Sun's. Modelling the Sun as a disc rather
   * than a point is what produces a penumbra at all, and the penumbra is where an
   * object visibly fades over several seconds instead of vanishing.
   *
   * Earth's oblateness is ignored: it moves the terminator crossing by at most a
   * few tenths of a second, which is nothing against TLE-age errors of minutes of arc.
   */
  function shadowState(satTemeKm, date) {
    const sun = SAT.frames.sunTemeKm(date);
    const r = norm(satTemeKm);
    if (!(r > 0)) return { state: 'none', frac: 1 };

    const toSun = sub(sun, satTemeKm);
    const dSun = norm(toSun);
    const thS = Math.asin(clamp(SUN_R_KM / dSun, -1, 1));            // solar radius
    const thE = Math.asin(clamp(SAT.frames.RE_EQ / r, -1, 1));       // Earth's radius
    // Angular separation of the two discs: Earth's centre lies along -satTemeKm.
    const th = Math.acos(clamp(-dot(satTemeKm, toSun) / (r * dSun), -1, 1));

    if (th >= thS + thE) return { state: 'none', frac: 1 };
    if (th <= thE - thS) return { state: 'umbra', frac: 0 };
    if (th <= thS - thE) {
      // Annular: Earth sits entirely inside the solar disc. Only reachable past the
      // umbral cone (~1.4 million km), i.e. for cislunar objects, never for GEO.
      return { state: 'penumbra', frac: 1 - (thE * thE) / (thS * thS) };
    }

    // Partial: standard two-circle lens area, in units of solid angle on the sky.
    const a = thE * thE * Math.acos(clamp((th * th + thE * thE - thS * thS) / (2 * th * thE), -1, 1)) +
      thS * thS * Math.acos(clamp((th * th + thS * thS - thE * thE) / (2 * th * thS), -1, 1)) -
      0.5 * Math.sqrt(Math.max(0, (-th + thE + thS) * (th + thE - thS) *
        (th - thE + thS) * (th + thE + thS)));
    return { state: 'penumbra', frac: clamp(1 - a / (Math.PI * thS * thS), 0, 1) };
  }

  SAT.photo = { magnitude, phaseAngleDeg, shadowState };
})();
