/**
 * The Nearest service: the road segments closest to a coordinate.
 */

import { profileOrDefault } from './consts.js';
import {
  ApiError,
  InvalidRequestError,
  osrmStatusError,
  truncateBody,
} from './errors.js';
import { decodeWaypoint, encodePoints } from './geo.js';
import type { PointLike, Waypoint } from './geo.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** A nearest-segment query. coordinate is required.
 *
 * Fields:
 * - coordinate: the point to snap, as [longitude, latitude].
 * - number: how many nearby segments to return, ordered by distance.
 *   Defaults to 1.
 * - profile: the routing profile. Defaults to "driving".
 * - exclude: road classes to avoid, such as "motorway" or "ferry".
 *   Supported values depend on the profile.
 * - bearings: restrict the direction of travel at the coordinate:
 *   "{bearing}" or "{bearing},{range}" in degrees, for example "0,20" for
 *   north within ±20°.
 * - radiuses: the snapping radius in metres for the coordinate;
 *   "unlimited" disables snapping.
 * - hints: opaque tokens from a previous response's waypoints that speed
 *   up snapping.
 * - approaches: restrict the road direction at the waypoint: "curb",
 *   "opposite", or "unrestricted" (the engine default).
 * - snapping: how the coordinate snaps onto the road network: "default"
 *   (the engine default) avoids edges that cannot be used as start or end
 *   points; "any" snaps to any edge.
 * - generateHints: request a "hint" on every response waypoint for reuse
 *   in later requests. The engine does this by default; set to false to
 *   omit hints.
 * - skipWaypoints: omit the response waypoints. They still take part in
 *   the nearest-segment calculation.
 */
export interface NearestRequest {
  coordinate: PointLike;
  number?: number;
  profile?: string;
  exclude?: string[];
  bearings?: string[];
  radiuses?: string[];
  hints?: string[];
  approaches?: string[];
  snapping?: string;
  generateHints?: boolean;
  skipWaypoints?: boolean;
}

/** The result of a nearest-segment query.
 *
 * Fields:
 * - code: the engine status, "Ok" on success.
 * - message: explains a non-Ok code.
 * - waypoints: the segments nearest to the coordinate, best first.
 */
export interface NearestResponse {
  code: string;
  message?: string;
  waypoints: Waypoint[];
}

/** NearestService finds the road segments closest to a coordinate. */
export class NearestService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** The road segment closest to req.coordinate.
   *
   *     const wp = await client.nearest.get({
   *         coordinate: [103.8198, 1.3521],
   *     });
   *     console.log(`snapped to ${wp.name}, ${Math.round(wp.distance)} m away`);
   *
   * Throws an error with osrmCode "NoSegment" when nothing is near the
   * coordinate. Use getAll() for the second-, third-, … nearest segments.
   */
  async get(req: NearestRequest, opts?: CallOptions): Promise<Waypoint> {
    const resp = await this.getAll(req, opts);
    if (resp.waypoints.length === 0) {
      throw new ApiError('no segment found near the given coordinate', {
        statusCode: 200,
        osrmCode: 'NoSegment',
      });
    }
    return resp.waypoints[0]!;
  }

  /** Up to req.number road segments near req.coordinate, best first. */
  async getAll(req: NearestRequest, opts?: CallOptions): Promise<NearestResponse> {
    validateNearestRequest(req);
    const coords = encodePoints([req.coordinate]);
    return await this.transport.do(
      {
        method: 'GET',
        path: `/nearest/v1/${profileOrDefault(req.profile ?? '')}/${coords}`,
        query: nearestQuery(req),
        needsAuth: true,
      },
      decodeNearestResponse,
      opts,
    );
  }
}

function validateNearestRequest(req: NearestRequest): void {
  if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
  if (!req.coordinate || req.coordinate.length === 0) {
    throw new InvalidRequestError('justrouting: Coordinate is required');
  }
  if (req.number != null && req.number < 0) {
    throw new InvalidRequestError(`justrouting: Number must not be negative, got ${req.number}`);
  }
}

function nearestQuery(req: NearestRequest): Record<string, string> {
  const q: Record<string, string> = {};
  if (req.number != null && req.number > 0) q.number = String(req.number);
  if (req.exclude && req.exclude.length > 0) q.exclude = req.exclude.join(',');
  if (req.bearings && req.bearings.length > 0) q.bearings = req.bearings.join(';');
  if (req.radiuses && req.radiuses.length > 0) q.radiuses = req.radiuses.join(';');
  if (req.hints && req.hints.length > 0) q.hints = req.hints.join(';');
  if (req.approaches && req.approaches.length > 0) q.approaches = req.approaches.join(';');
  if (req.snapping) q.snapping = req.snapping;
  if (req.generateHints !== undefined) q.generate_hints = String(req.generateHints);
  if (req.skipWaypoints) q.skip_waypoints = 'true';
  return q;
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function decodeNearestResponse(data: unknown, raw: string): NearestResponse {
  const d = asRecord(data);
  const resp: NearestResponse = {
    code: str(d.code),
    message: str(d.message),
    waypoints: Array.isArray(d.waypoints) ? d.waypoints.map((w) => decodeWaypoint(w)) : [],
  };
  const err = osrmStatusError(resp.code, resp.message ?? '');
  if (err) {
    err.body = truncateBody(raw);
    throw err;
  }
  return resp;
}
