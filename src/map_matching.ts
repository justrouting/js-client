/**
 * The Map Matching service: snap a noisy GPS trace onto the road network
 * and assemble the route that was driven.
 */

import { profileOrDefault } from './consts.js';
import {
  ApiError,
  InvalidRequestError,
  osrmStatusError,
  truncateBody,
} from './errors.js';
import { asPoint, encodePoints, formatCoord } from './geo.js';
import type { Point, PointLike } from './geo.js';
import { decodeRoute } from './routes.js';
import type { Route } from './routes.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** A map-matching query. coordinates is required and must hold at least two
 * points in chronological order.
 *
 * The number of coordinates is capped by the account plan; exceeding it
 * throws an error matching PlanLimitExceededError.
 *
 * Fields:
 * - coordinates: the trace to match, in chronological order.
 * - timestamps: UNIX seconds for each coordinate. When set, its length must
 *   equal the number of coordinates.
 * - radiuses: the maximum distance in metres each coordinate may snap, one
 *   value per coordinate. The engine's default snap distance is only a few
 *   metres, so GPS points further from the road need this set.
 * - gaps: how a trace with gaps is matched: "split" (the default) or
 *   "ignore".
 * - tidy: drop tracepoints that cannot be matched from the response.
 * - waypoints: which coordinates to use as waypoints, by index into
 *   coordinates. Empty means all of them.
 * - snapping: edge snapping: "default" or "any".
 * - profile: the routing profile. Defaults to "driving".
 * - steps: request turn-by-turn instructions on each leg.
 * - annotations: per-segment metadata. Valid values include "duration",
 *   "distance", "speed" and "nodes".
 * - geometries: the geometry encoding: "polyline" (the default),
 *   "polyline6" or "geojson". See Geometry.
 * - overview: geometry detail: "simplified" (the default), "full" or
 *   "false" to omit it.
 * - exclude: road classes to avoid, such as "motorway" or "ferry".
 *   Supported values depend on the profile.
 */
export interface MapMatchingRequest {
  coordinates: PointLike[];
  timestamps?: number[];
  radiuses?: number[];
  gaps?: string;
  tidy?: boolean;
  waypoints?: number[];
  snapping?: string;
  profile?: string;
  steps?: boolean;
  annotations?: string[];
  geometries?: string;
  overview?: string;
  exclude?: string[];
}

/** The full result of a map-matching query.
 *
 * Fields:
 * - code: the engine status, "Ok" on success.
 * - message: explains a non-Ok code.
 * - tracepoints: the input coordinates snapped to the road network, aligned
 *   with req.coordinates. An entry is null when that coordinate could not be
 *   matched.
 * - matchings: the routes assembled from the trace, best first.
 */
export interface MapMatchingResponse {
  code: string;
  message?: string;
  tracepoints: (Tracepoint | null)[];
  matchings: Match[];
}

/** One route assembled from a trace, extending Route with the engine's
 * confidence in the match. */
export interface Match extends Route {
  /** The engine's trust in the match, from 0 to 1. */
  confidence: number;
}

/** One input coordinate snapped to the road network. */
export interface Tracepoint {
  /** How many other plausible matches exist for this tracepoint. */
  alternativesCount?: number;
  /** The index of this point within the matched route's waypoints. */
  waypointIndex?: number;
  /** Which entry of matchings this tracepoint belongs to. */
  matchingsIndex?: number;
  /** The metres between the input coordinate and location. */
  distance: number;
  /** The street the coordinate snapped to, if known. */
  name: string;
  /** The snapped position. */
  location: Point;
  /** An opaque token that can speed up subsequent requests. */
  hint?: string;
}

/** MapMatchingService snaps a noisy GPS trace onto the road network. */
export class MapMatchingService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** The best matching for req.
   *
   *     const match = await client.mapMatching.get({
   *         coordinates: trace, // GPS points, in order
   *     });
   *     console.log(`${Math.round(match.confidence * 100)}% confidence`);
   *
   * Throws an error with osrmCode "NoMatch" when no coordinate can be
   * matched. Use getAll() for the snapped tracepoints.
   */
  async get(req: MapMatchingRequest, opts?: CallOptions): Promise<Match> {
    const resp = await this.getAll(req, opts);
    if (resp.matchings.length === 0) {
      throw new ApiError('no matching found for the given coordinates', {
        statusCode: 200,
        osrmCode: 'NoMatch',
      });
    }
    return resp.matchings[0]!;
  }

  /** Every matching the engine produced for req, along with the snapped
   * tracepoints. */
  async getAll(
    req: MapMatchingRequest,
    opts?: CallOptions,
  ): Promise<MapMatchingResponse> {
    validateMapMatchingRequest(req);
    const coords = encodePoints(req.coordinates);
    return await this.transport.do(
      {
        method: 'GET',
        path: `/match/v1/${profileOrDefault(req.profile ?? '')}/${coords}`,
        query: mapMatchingQuery(req),
        needsAuth: true,
      },
      decodeMapMatchingResponse,
      opts,
    );
  }
}

function validateMapMatchingRequest(req: MapMatchingRequest): void {
  if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
  if (req.coordinates.length < 2) {
    throw new InvalidRequestError(
      `justrouting: Coordinates needs at least 2 points, got ${req.coordinates.length}`,
    );
  }
  if (req.timestamps && req.timestamps.length !== req.coordinates.length) {
    throw new InvalidRequestError(
      `justrouting: Timestamps has ${req.timestamps.length} values for ${req.coordinates.length} coordinates`,
    );
  }
  // The engine accepts exactly one radius per coordinate; a single shared
  // value is rejected, so catch it locally.
  if (req.radiuses && req.radiuses.length > 0 && req.radiuses.length !== req.coordinates.length) {
    throw new InvalidRequestError(
      `justrouting: Radiuses needs one value per coordinate, got ${req.radiuses.length} for ${req.coordinates.length} coordinates`,
    );
  }
  req.radiuses?.forEach((radius, i) => {
    if (radius < 0) {
      throw new InvalidRequestError(
        `justrouting: Radiuses[${i}] must not be negative, got ${radius}`,
      );
    }
  });
}

function mapMatchingQuery(req: MapMatchingRequest): Record<string, string> {
  const q: Record<string, string> = {};
  if (req.timestamps && req.timestamps.length > 0) {
    q.timestamps = req.timestamps.map(String).join(';');
  }
  if (req.radiuses && req.radiuses.length > 0) {
    q.radiuses = req.radiuses.map(formatCoord).join(';');
  }
  if (req.gaps) q.gaps = req.gaps;
  if (req.tidy) q.tidy = 'true';
  const waypoints = encodeIndices('Waypoints', req.waypoints ?? [], req.coordinates.length);
  if (waypoints) q.waypoints = waypoints;
  if (req.snapping) q.snapping = req.snapping;
  if (req.steps) q.steps = 'true';
  if (req.annotations && req.annotations.length > 0) q.annotations = req.annotations.join(',');
  if (req.geometries) q.geometries = req.geometries;
  if (req.overview) q.overview = req.overview;
  if (req.exclude && req.exclude.length > 0) q.exclude = req.exclude.join(',');
  return q;
}

/** encodeIndices renders coordinate indices as a semicolon-separated list,
 * rejecting anything outside the coordinate slice before a request is
 * spent. */
function encodeIndices(field: string, indices: number[], total: number): string {
  if (indices.length === 0) return '';
  const parts = indices.map((idx, i) => {
    if (idx < 0 || idx >= total) {
      throw new InvalidRequestError(
        `justrouting: ${field}[${i}] = ${idx} is out of range for ${total} coordinates`,
      );
    }
    return String(idx);
  });
  return parts.join(';');
}

function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function decodeMapMatchingResponse(data: unknown, raw: string): MapMatchingResponse {
  const d = asRecord(data);
  const resp: MapMatchingResponse = {
    code: str(d.code),
    message: str(d.message),
    // A null entry is meaningful: that coordinate could not be matched, so
    // it is preserved rather than dropped.
    tracepoints: Array.isArray(d.tracepoints)
      ? d.tracepoints.map((t) => (t === null ? null : decodeTracepoint(t)))
      : [],
    matchings: Array.isArray(d.matchings)
      ? d.matchings.filter((m): m is unknown => m != null).map((m) => decodeMatch(m))
      : [],
  };
  const err = osrmStatusError(resp.code, resp.message ?? '');
  if (err) {
    err.body = truncateBody(raw);
    throw err;
  }
  return resp;
}

function decodeMatch(v: unknown): Match {
  const d = asRecord(v);
  return { ...decodeRoute(d), confidence: num(d.confidence) };
}

function decodeTracepoint(v: unknown): Tracepoint {
  const d = asRecord(v);
  const tp: Tracepoint = {
    distance: num(d.distance),
    name: str(d.name),
    location: asPoint(d.location),
  };
  if (typeof d.alternatives_count === 'number') tp.alternativesCount = d.alternatives_count;
  if (typeof d.waypoint_index === 'number') tp.waypointIndex = d.waypoint_index;
  if (typeof d.matchings_index === 'number') tp.matchingsIndex = d.matchings_index;
  const hint = typeof d.hint === 'string' ? d.hint : undefined;
  if (hint !== undefined) tp.hint = hint;
  return tp;
}
