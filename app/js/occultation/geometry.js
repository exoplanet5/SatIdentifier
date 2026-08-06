/* SAT.occultation.geometry — deterministic geometry on the unit celestial sphere.
 *
 * Scientific responsibility: represent J2000 directions as unit vectors, measure
 * distances to minor great-circle segments, and construct conservative spherical
 * tube envelopes for catalogue queries. This module does not propagate TLEs,
 * query a star catalogue, solve a time-dependent closest approach, or write UI
 * or application state.
 *
 * The browser loads this file as a classic script. It has no runtime dependency;
 * the focused Node harness can load it without a DOM or a network connection.
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const ARCSEC_PER_RAD = R2D * 3600;
  const ZERO_ARC_RAD = 1e-14;
  const MEMBERSHIP_EPS_ARCSEC = 1e-7;
  // A near-antipodal pair does not define a numerically stable unique minor arc.
  // Treating it as whole-sphere is conservative for candidate recall.
  const ANTIPODAL_EPS_RAD = 1e-10;
  const ARC_MEMBERSHIP_EPS_RAD = 1e-10;

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!isFinite(number)) throw new Error(label + ' must be finite');
    return number;
  }

  function nonNegative(value, label) {
    const number = finiteNumber(value, label);
    if (number < 0) throw new Error(label + ' must be non-negative');
    return number;
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  function norm(vector) {
    if (!vector || !isFinite(Number(vector.x)) || !isFinite(Number(vector.y)) ||
        !isFinite(Number(vector.z))) return null;
    const length = Math.hypot(Number(vector.x), Number(vector.y), Number(vector.z));
    if (!(length > 0) || !isFinite(length)) return null;
    return {
      x: Number(vector.x) / length,
      y: Number(vector.y) / length,
      z: Number(vector.z) / length,
    };
  }

  /** Convert a J2000 RA/Dec direction in degrees to a dimensionless unit vector. */
  function unitFromRaDec(raDeg, decDeg) {
    const ra = finiteNumber(raDeg, 'raDeg') * D2R;
    const dec = finiteNumber(decDeg, 'decDeg') * D2R;
    if (dec < -Math.PI / 2 || dec > Math.PI / 2) {
      throw new Error('decDeg must be in [-90, 90]');
    }
    const c = Math.cos(dec);
    return { x: c * Math.cos(ra), y: c * Math.sin(ra), z: Math.sin(dec) };
  }

  /** Convert a non-zero vector to normalized J2000 RA/Dec degrees. */
  function raDecFromUnit(vector) {
    const unit = norm(vector);
    if (!unit) return null;
    return {
      raDeg: ((Math.atan2(unit.y, unit.x) * R2D) % 360 + 360) % 360,
      decDeg: Math.asin(clamp(unit.z, -1, 1)) * R2D,
    };
  }

  function directionOf(value, label) {
    const source = value && value.vector ? value.vector : value;
    if (source && isFinite(Number(source.raDeg)) && isFinite(Number(source.decDeg))) {
      return unitFromRaDec(Number(source.raDeg), Number(source.decDeg));
    }
    const unit = norm(source);
    if (!unit) throw new Error((label || 'direction') + ' must be a finite non-zero vector or RA/Dec point');
    return unit;
  }

  function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  function cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  /** Return the angular distance between two directions in radians. */
  function arcRad(a, b) {
    const aa = directionOf(a, 'first direction');
    const bb = directionOf(b, 'second direction');
    const c = cross(aa, bb);
    return Math.atan2(Math.hypot(c.x, c.y, c.z), clamp(dot(aa, bb), -1, 1));
  }

  /** Return the angular distance between two directions in arcseconds. */
  function angularSeparationArcsec(a, b) {
    return arcRad(a, b) * ARCSEC_PER_RAD;
  }

  /** Spherical linear interpolation along the shortest stable great-circle route. */
  function slerp(a, b, fraction) {
    const aa = directionOf(a, 'first direction');
    const bb = directionOf(b, 'second direction');
    const f = finiteNumber(fraction, 'fraction');
    if (f < 0 || f > 1) throw new Error('fraction must be in [0, 1]');
    const cosine = clamp(dot(aa, bb), -1, 1);
    if (cosine > 1 - 1e-12) {
      return norm({
        x: aa.x + f * (bb.x - aa.x),
        y: aa.y + f * (bb.y - aa.y),
        z: aa.z + f * (bb.z - aa.z),
      });
    }
    if (cosine < -1 + 1e-12) {
      const axis = Math.abs(aa.x) <= Math.abs(aa.y) && Math.abs(aa.x) <= Math.abs(aa.z)
        ? { x: 1, y: 0, z: 0 }
        : (Math.abs(aa.y) <= Math.abs(aa.z)
          ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 });
      const perpendicular = norm(cross(aa, axis));
      const angle = Math.PI * f;
      return norm({
        x: Math.cos(angle) * aa.x + Math.sin(angle) * perpendicular.x,
        y: Math.cos(angle) * aa.y + Math.sin(angle) * perpendicular.y,
        z: Math.cos(angle) * aa.z + Math.sin(angle) * perpendicular.z,
      });
    }
    const angle = Math.acos(cosine);
    const sine = Math.sin(angle);
    return norm({
      x: (Math.sin((1 - f) * angle) * aa.x + Math.sin(f * angle) * bb.x) / sine,
      y: (Math.sin((1 - f) * angle) * aa.y + Math.sin(f * angle) * bb.y) / sine,
      z: (Math.sin((1 - f) * angle) * aa.z + Math.sin(f * angle) * bb.z) / sine,
    });
  }

  function endpointResult(point, a, b) {
    const da = angularSeparationArcsec(point, a);
    const db = angularSeparationArcsec(point, b);
    return da <= db
      ? { distanceArcsec: da, fraction: 0, closestVector: a, ambiguous: false }
      : { distanceArcsec: db, fraction: 1, closestVector: b, ambiguous: false };
  }

  /**
   * Find the nearest point on a minor great-circle segment.
   *
   * Parameters
   * ----------
   * point, a, b : object
   *     Dimensionless vectors or `{raDeg, decDeg}` J2000 points. Inputs are
   *     normalized internally and are never mutated.
   *
   * Returns
   * -------
   * object
   *     `{distanceArcsec, fraction, closestVector, ambiguous}`. `fraction` is
   *     the position on the minor arc from `a` to `b`, and `closestVector` is a
   *     unit vector. For a near-antipodal pair the minor arc is not unique;
   *     `ambiguous` is true and zero distance is returned as a conservative
   *     whole-sphere representation.
   *
   * Equation
   * --------
   * For great-circle normal `n = normalize(a × b)`, project the point into the
   * great-circle plane with `q = normalize(p - (p · n)n)`. If `q` lies on the
   * minor arc, its angular separation from `p` is the segment distance;
   * otherwise the nearer endpoint is the solution.
   *
   * Notes
   * -----
   * Distances are computed with `atan2(|p × q|, p · q)` for stable behavior at
   * both sub-arcsecond and nearly antipodal separations. A time-dependent closest
   * approach is deliberately out of scope; the returned fraction is geometric.
   */
  function segmentDistance(point, a, b) {
    const p = directionOf(point, 'point');
    const aa = directionOf(a, 'first segment endpoint');
    const bb = directionOf(b, 'second segment endpoint');
    const normalRaw = cross(aa, bb);
    const angle = Math.atan2(Math.hypot(normalRaw.x, normalRaw.y, normalRaw.z),
      clamp(dot(aa, bb), -1, 1));
    if (Math.PI - angle <= ANTIPODAL_EPS_RAD) {
      return {
        distanceArcsec: 0, fraction: null, closestVector: null,
        ambiguous: true, wholeSphere: true,
      };
    }
    if (angle <= ZERO_ARC_RAD) return endpointResult(p, aa, bb);

    const normal = norm(normalRaw);
    const height = dot(p, normal);
    const projected = {
      x: p.x - height * normal.x,
      y: p.y - height * normal.y,
      z: p.z - height * normal.z,
    };
    const projectedLength = Math.hypot(projected.x, projected.y, projected.z);
    if (projectedLength > ZERO_ARC_RAD) {
      const q = {
        x: projected.x / projectedLength,
        y: projected.y / projectedLength,
        z: projected.z / projectedLength,
      };
      const aq = arcRad(aa, q);
      const qb = arcRad(q, bb);
      if (aq + qb <= angle + ARC_MEMBERSHIP_EPS_RAD) {
        return {
          distanceArcsec: angularSeparationArcsec(p, q),
          fraction: clamp(aq / angle, 0, 1),
          closestVector: q,
          ambiguous: false,
        };
      }
    }
    return endpointResult(p, aa, bb);
  }

  /**
   * Construct a conservative cone covering a great-circle segment and padding.
   *
   * `radiusArcsec` is `L/2 + paddingArcsec`, capped at 180 degrees, where `L`
   * is the minor-arc length. Every point on the represented minor arc is inside
   * this cone. Near-antipodal endpoints set `wholeSphere: true` because a unique
   * minor-arc midpoint cannot be selected without a possible recall failure.
   */
  function segmentEnvelope(a, b, paddingArcsec) {
    const aa = directionOf(a, 'first segment endpoint');
    const bb = directionOf(b, 'second segment endpoint');
    const padding = nonNegative(paddingArcsec == null ? 0 : paddingArcsec, 'paddingArcsec');
    const raw = cross(aa, bb);
    const angle = Math.atan2(Math.hypot(raw.x, raw.y, raw.z), clamp(dot(aa, bb), -1, 1));
    const arcArcsec = angle * ARCSEC_PER_RAD;
    if (Math.PI - angle <= ANTIPODAL_EPS_RAD) {
      return {
        center: aa, arcRad: angle, arcDeg: angle * R2D, arcArcsec: arcArcsec,
        radiusRad: Math.PI, radiusDeg: 180, radiusArcsec: 180 * 3600,
        paddingArcsec: padding, wholeSphere: true,
      };
    }
    const center = slerp(aa, bb, 0.5);
    const radiusRad = Math.min(Math.PI, angle / 2 + padding / ARCSEC_PER_RAD);
    return {
      center: center, arcRad: angle, arcDeg: angle * R2D, arcArcsec: arcArcsec,
      radiusRad: radiusRad, radiusDeg: radiusRad * R2D,
      radiusArcsec: radiusRad * ARCSEC_PER_RAD, paddingArcsec: padding,
      wholeSphere: radiusRad >= Math.PI,
    };
  }

  /** Return the nearest point-to-polyline result for a J2000 path. */
  function pathDistance(point, path) {
    if (!Array.isArray(path)) throw new Error('path must be an array');
    if (!path.length) {
      return { distanceArcsec: Infinity, segmentIndex: -1, fraction: null,
        closestVector: null, ambiguous: false };
    }
    const p = directionOf(point, 'point');
    const rows = path.map((row, index) => ({
      vector: directionOf(row, 'path[' + index + ']'),
      t: row && isFinite(Number(row.t)) ? Number(row.t) : null,
    }));
    if (rows.length === 1) {
      return {
        distanceArcsec: angularSeparationArcsec(p, rows[0].vector),
        segmentIndex: 0, fraction: 0, closestVector: rows[0].vector,
        ambiguous: false,
      };
    }
    let best = null;
    for (let i = 1; i < rows.length; i++) {
      const result = segmentDistance(p, rows[i - 1].vector, rows[i].vector);
      if (result.ambiguous) {
        return { distanceArcsec: 0, segmentIndex: i - 1, fraction: null,
          closestVector: null, closestTMs: null, ambiguous: true, wholeSphere: true };
      }
      if (!best || result.distanceArcsec < best.distanceArcsec) {
        best = Object.assign({}, result, { segmentIndex: i - 1 });
        if (rows[i - 1].t != null && rows[i].t != null && result.fraction != null) {
          best.closestTMs = rows[i - 1].t + (rows[i].t - rows[i - 1].t) * result.fraction;
        }
      }
    }
    return best;
  }

  /** Return whether a point is within an angular tube around a path. */
  function pointInTube(point, path, radiusArcsec) {
    const radius = nonNegative(radiusArcsec, 'radiusArcsec');
    // The epsilon is far below the catalogue/query padding and prevents a
    // numerically exact path point from failing a zero-width membership check.
    return pathDistance(point, path).distanceArcsec <= radius + MEMBERSHIP_EPS_ARCSEC;
  }

  const API = {
    ARCSEC_PER_RAD: ARCSEC_PER_RAD,
    unitFromRaDec: unitFromRaDec,
    raDecFromUnit: raDecFromUnit,
    normalize: norm,
    dot: dot,
    cross: cross,
    slerp: slerp,
    arcRad: arcRad,
    arcDeg: function (a, b) { return arcRad(a, b) * R2D; },
    angularSeparationArcsec: angularSeparationArcsec,
    segmentDistance: segmentDistance,
    distanceToSegment: segmentDistance,
    segmentEnvelope: segmentEnvelope,
    pathDistance: pathDistance,
    distanceToPath: pathDistance,
    pointInTube: pointInTube,
    tubeContains: pointInTube,
  };

  SAT.occultation = SAT.occultation || {};
  SAT.occultation.geometry = API;
})();
