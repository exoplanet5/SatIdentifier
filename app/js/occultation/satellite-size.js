/* SAT.occultation.satelliteSize — effective opaque-satellite size model.
 *
 * Scientific responsibility: resolve one effective physical radius in metres
 * from an object record or an explicit caller override. This is a documented
 * size prior, not a recovered spacecraft shape or an uncertainty distribution;
 * contact.js uses it to turn a point-source closest approach into a geometric
 * disk-contact test. The module has no TLE, propagation, DOM, or state dependency.
 */
(function () {
  'use strict';

  const TYPE_RADIUS_M = {
    'R/B': 2.0,
    'PAY': 1.0,
    'DEB': 0.15,
  };
  const TYPE_ALIAS = {
    'ROCKET BODY': 'R/B',
    'PAYLOAD': 'PAY',
    'DEBRIS': 'DEB',
    'UNKNOWN': 'UNK',
  };
  const DEFAULT_RADIUS_M = 1.0;
  const ARCSEC_PER_RAD = 180 * 3600 / Math.PI;

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  function positiveRadius(value, label) {
    const radius = finiteNumber(value, label);
    if (!(radius > 0)) throw new Error(label + ' must be greater than zero');
    return radius;
  }

  function typeRadiusM(type) {
    if (typeof type !== 'string') return null;
    const key = type.trim().toUpperCase();
    return TYPE_RADIUS_M[TYPE_ALIAS[key] || key] || null;
  }

  function rcsRadiusM(rcs) {
    const area = Number(rcs);
    return area > 0 && isFinite(area) ? Math.sqrt(area / Math.PI) : null;
  }

  /**
   * Resolve an effective opaque-disc radius.
   *
   * Parameters
   * ----------
   * object : object, optional
   *     Catalogue object. `radiusM` is a direct physical prior, `diameterM`
   *     and `sizeM` are interpreted as full diameters, `rcs` is radar
   *     cross-section in m², and `type` is a SATCAT object class.
   * options : object, optional
   *     `radiusM`/`satelliteRadiusM`/`physicalRadiusM` override the object;
   *     `defaultRadiusM` controls the final fallback and may be `null` to
   *     reject unknown-size objects.
   *
   * Returns
   * -------
   * object
   *     `{radiusM, source, flags}`. `radiusM` is positive metres or `null`;
   *     `source` is `explicit`, `rcs`, `type`, `object`, or `default`.
   *     The `radius-assumed` flag is present for type and default priors, while
   *     an RCS conversion remains an effective diffuse-sphere prior.
   *
   * Equation
   * --------
   * For a positive radar cross-section A, the equivalent diffuse-sphere radius
   * is `r = sqrt(A / pi)`. The type values are coarse engineering priors already
   * used by SAT.photo; they are not physical measurements of individual objects.
   *
   * Notes
   * -----
   * Precedence is explicit option, object radius/diameter, RCS, type, then
   * default. Inputs are read only and never mutated.
   */
  function resolve(object, options) {
    const obj = object && typeof object === 'object' ? object : {};
    const config = options || {};
    const flags = [];
    const explicit = config.radiusM != null ? config.radiusM
      : (config.satelliteRadiusM != null ? config.satelliteRadiusM
        : config.physicalRadiusM);
    if (explicit != null) {
      return { radiusM: positiveRadius(explicit, 'radiusM'), source: 'explicit', flags: flags };
    }
    if (obj.radiusM != null) {
      return { radiusM: positiveRadius(obj.radiusM, 'object.radiusM'), source: 'object', flags: flags };
    }
    const diameter = obj.diameterM != null ? obj.diameterM : obj.sizeM;
    if (diameter != null) {
      return { radiusM: positiveRadius(diameter, 'object diameterM') / 2,
        source: 'object', flags: flags };
    }
    const rcs = rcsRadiusM(obj.rcs);
    if (rcs != null) return { radiusM: rcs, source: 'rcs', flags: ['radius-from-rcs'] };
    const type = typeRadiusM(obj.type);
    if (type != null) return { radiusM: type, source: 'type', flags: ['radius-assumed'] };
    const fallback = Object.prototype.hasOwnProperty.call(config, 'defaultRadiusM')
      ? config.defaultRadiusM : DEFAULT_RADIUS_M;
    if (fallback == null) return { radiusM: null, source: null, flags: ['radius-unavailable'] };
    return {
      radiusM: positiveRadius(fallback, 'defaultRadiusM'),
      source: 'default',
      flags: ['radius-assumed'],
    };
  }

  /** Convert a positive radius in metres and range in kilometres to angular radius. */
  function angularRadiusArcsec(radiusM, rangeKm) {
    const radius = positiveRadius(radiusM, 'radiusM') / 1000;
    const range = finiteNumber(rangeKm, 'rangeKm');
    if (!(range > 0) || radius >= range) {
      throw new Error('rangeKm must exceed the satellite radius');
    }
    return Math.asin(radius / range) * ARCSEC_PER_RAD;
  }

  function angularDiameterArcsec(radiusM, rangeKm) {
    return 2 * angularRadiusArcsec(radiusM, rangeKm);
  }

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.satelliteSize = {
    DEFAULT_RADIUS_M: DEFAULT_RADIUS_M,
    TYPE_RADIUS_M: Object.assign({}, TYPE_RADIUS_M),
    typeRadiusM: typeRadiusM,
    rcsRadiusM: rcsRadiusM,
    resolve: resolve,
    resolveRadius: resolve,
    radiusOf: resolve,
    angularRadiusArcsec: angularRadiusArcsec,
    angularDiameterArcsec: angularDiameterArcsec,
  };
})();
