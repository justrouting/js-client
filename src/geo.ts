/**
 * Geographic primitives shared by every service.
 */

import { DecodeError, InvalidCoordinatesError } from './errors.js';

/** A geographic coordinate expressed as [longitude, latitude] — the order
 * used by GeoJSON, OSRM and VROOM, and the reverse of the "lat, lng"
 * convention used by most map UIs. */
export type Point = [number, number];

/** Anything the request builders accept as a [longitude, latitude] pair: a
 * plain array of two numbers works anywhere a Point is expected. */
export type PointLike = readonly number[];

/** validatePoint throws InvalidCoordinatesError when p is not a
 * well-formed [longitude, latitude] pair within the valid ranges. */
export function validatePoint(p: PointLike): void {
  if (p.length !== 2) {
    throw new InvalidCoordinatesError(
      `justrouting: expected [longitude, latitude], got ${p.length} value(s)`,
    );
  }
  const lon = p[0]!;
  const lat = p[1]!;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new InvalidCoordinatesError('justrouting: longitude and latitude must be finite numbers');
  }
  if (lon < -180 || lon > 180) {
    throw new InvalidCoordinatesError(`justrouting: longitude ${lon} is outside [-180, 180]`);
  }
  if (lat < -90 || lat > 90) {
    // Catches the common mistake of passing [lat, lon].
    throw new InvalidCoordinatesError(
      `justrouting: latitude ${lat} is outside [-90, 90] (coordinates are [longitude, latitude])`,
    );
  }
}

/** formatCoord renders v in fixed notation using the shortest
 * representation that round-trips exactly, like Go's
 * strconv.FormatFloat(v, 'f', -1, 64). */
export function formatCoord(v: number): string {
  let s = String(v);
  if (!s.includes('e') && !s.includes('E')) return s;
  // Scientific notation: convert to fixed point with enough digits to
  // round-trip exactly, then strip trailing zeros.
  const [mantissa, expPart] = s.toLowerCase().split('e');
  const exponent = Number(expPart);
  const digits = mantissa.replace('.', '').replace(/^[+-]/, '').length;
  const precision = Math.max(0, digits - 1 - exponent);
  let fixed = v.toFixed(precision);
  if (fixed.includes('.')) {
    fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  }
  return fixed;
}

/** formatPoint renders p as "longitude,latitude". */
export function formatPoint(p: PointLike): string {
  return `${formatCoord(p[0]!)},${formatCoord(p[1]!)}`;
}

/** encodePoints renders points as the "lon,lat;lon,lat" path segment that
 * the OSRM services expect, validating each point along the way. */
export function encodePoints(points: PointLike[]): string {
  if (points.length === 0) {
    throw new InvalidCoordinatesError('justrouting: at least one coordinate is required');
  }
  const parts: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    try {
      validatePoint(p);
    } catch (err) {
      if (err instanceof InvalidCoordinatesError) {
        throw new InvalidCoordinatesError(`coordinate ${i}: ${err.message}`);
      }
      throw err;
    }
    parts.push(formatPoint(p));
  }
  return parts.join(';');
}

/** asPoint coerces a decoded JSON value into a two-element Point, or
 * [0, 0] when it is not an array of numbers. */
export function asPoint(v: unknown): Point {
  if (Array.isArray(v)) {
    const lon = typeof v[0] === 'number' && Number.isFinite(v[0]) ? v[0] : 0;
    const lat = typeof v[1] === 'number' && Number.isFinite(v[1]) ? v[1] : 0;
    return [lon, lat];
  }
  return [0, 0];
}

/**
 * A route geometry. OSRM encodes it either as an encoded polyline string
 * (geometries=polyline, the default, or polyline6) or as a GeoJSON
 * LineString object (geometries=geojson). Geometry preserves whichever form
 * the server sent; read it with polyline() or geoJSON().
 */
export class Geometry {
  // raw is the decoded JSON value: a string for polylines, an object for
  // GeoJSON, or null when the server omitted the geometry.
  private readonly rawValue: unknown;

  constructor(raw: unknown = null) {
    this.rawValue = raw;
  }

  /** Whether the server omitted the geometry, which happens when a request
   * sets overview=false. */
  isZero(): boolean {
    return this.rawValue === null || this.rawValue === undefined;
  }

  /** The geometry exactly as the server encoded it. */
  raw(): unknown {
    return this.rawValue;
  }

  /** The geometry as an encoded polyline string.
   *
   * Throws DecodeError if the request asked for GeoJSON instead.
   */
  polyline(): string {
    if (this.isZero()) throw new DecodeError('justrouting: geometry is empty');
    if (typeof this.rawValue !== 'string') {
      throw new DecodeError(
        'justrouting: geometry is not an encoded polyline; set geometries to "polyline" or "polyline6"',
      );
    }
    return this.rawValue;
  }

  /** The geometry as a GeoJSON LineString.
   *
   * Throws DecodeError if the request used the default polyline encoding.
   */
  geoJSON(): LineString {
    if (this.isZero()) throw new DecodeError('justrouting: geometry is empty');
    if (typeof this.rawValue !== 'object' || this.rawValue === null || Array.isArray(this.rawValue)) {
      throw new DecodeError('justrouting: geometry is not GeoJSON; set geometries to "geojson"');
    }
    return decodeLineString(this.rawValue as Record<string, unknown>);
  }
}

/** A GeoJSON LineString geometry. */
export interface LineString {
  type: string;
  coordinates: Point[];
}

function decodeLineString(d: Record<string, unknown>): LineString {
  return {
    type: typeof d.type === 'string' ? d.type : '',
    coordinates: Array.isArray(d.coordinates) ? d.coordinates.map((c) => asPoint(c)) : [],
  };
}

/** An input coordinate snapped to the road network.
 *
 * Fields:
 * - name: the street the coordinate snapped to, if known.
 * - location: the snapped position.
 * - distance: the metres between the input coordinate and location.
 * - hint: an opaque token that can speed up subsequent requests.
 */
export interface Waypoint {
  name: string;
  location: Point;
  distance: number;
  hint?: string;
}

export function decodeWaypoint(v: unknown): Waypoint {
  const d = (v ?? {}) as Record<string, unknown>;
  const hint = typeof d.hint === 'string' ? d.hint : undefined;
  return {
    name: typeof d.name === 'string' ? d.name : '',
    location: asPoint(d.location),
    distance: typeof d.distance === 'number' && Number.isFinite(d.distance) ? d.distance : 0,
    ...(hint !== undefined ? { hint } : {}),
  };
}
