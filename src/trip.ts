/**
 * The Trip service: the fastest order to visit a set of coordinates.
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
import { decodeRoute } from './routes.js';
import type { Route } from './routes.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** A trip query. coordinates is required and must hold at least two points.
 *
 * The engine solves the travelling-salesman problem with a greedy
 * heuristic: the returned trip visits every coordinate once, in whatever
 * order is fastest. The number of coordinates is capped by the account
 * plan; exceeding it throws an error matching PlanLimitExceededError.
 *
 * Fields:
 * - coordinates: the points to visit, in any order.
 * - roundtrip: whether the trip ends where it started. Undefined leaves the
 *   engine default, which is true.
 * - source: where the trip starts: "any" (the default) or "first".
 * - destination: where the trip ends: "any" (the default) or "last".
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
 * - bearings: restrict the direction of travel at each coordinate, one
 *   entry per coordinate in visiting order: "{bearing}" or
 *   "{bearing},{range}" in degrees, for example "0,20" for north within
 *   ±20°. Coordinates without a restriction use the default when their
 *   entry is missing at the end of the list.
 * - radiuses: the snapping radius in metres per coordinate, one entry per
 *   coordinate in visiting order; "unlimited" disables snapping for that
 *   coordinate.
 * - hints: opaque tokens from a previous response's waypoints that speed
 *   up snapping, one entry per coordinate in visiting order.
 * - approaches: restrict the road direction at each waypoint, one entry
 *   per waypoint in visiting order: "curb", "opposite", or "unrestricted"
 *   (the engine default). An empty entry also selects the default.
 * - snapping: how coordinates snap onto the road network: "default" (the
 *   engine default) avoids edges that cannot be used as start or end
 *   points; "any" snaps to any edge.
 * - generateHints: request a "hint" on every response waypoint for reuse
 *   in later requests. The engine does this by default; set to false to
 *   omit hints.
 * - skipWaypoints: omit the response waypoints. They still take part in
 *   the trip calculation.
 */
export interface TripRequest {
  coordinates: PointLike[];
  roundtrip?: boolean;
  source?: string;
  destination?: string;
  profile?: string;
  steps?: boolean;
  annotations?: string[];
  geometries?: string;
  overview?: string;
  exclude?: string[];
  bearings?: string[];
  radiuses?: string[];
  hints?: string[];
  approaches?: string[];
  snapping?: string;
  generateHints?: boolean;
  skipWaypoints?: boolean;
}

/** The full result of a trip query.
 *
 * Fields:
 * - code: the engine status, "Ok" on success.
 * - message: explains a non-Ok code.
 * - trips: the candidate round trips, best first.
 * - waypoints: the input coordinates snapped to the road network, in the
 *   order the trip visits them.
 */
export interface TripResponse {
  code: string;
  message?: string;
  trips: Route[];
  waypoints: Waypoint[];
}

/** TripService finds the fastest order to visit a set of coordinates. */
export class TripService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** The best trip for req.
   *
   *     const trip = await client.trip.get({
   *         coordinates: [depot, stopA, stopB],
   *     });
   *     console.log(`fastest order covers ${(trip.distance / 1000).toFixed(1)} km`);
   *
   * Throws an error with osrmCode "NoTrip" when no trip can be assembled.
   * The waypoints in TripResponse.waypoints are ordered as visited — use
   * getAll() to retrieve them.
   */
  async get(req: TripRequest, opts?: CallOptions): Promise<Route> {
    const resp = await this.getAll(req, opts);
    if (resp.trips.length === 0) {
      throw new ApiError('no trip found for the given coordinates', {
        statusCode: 200,
        osrmCode: 'NoTrip',
      });
    }
    return resp.trips[0]!;
  }

  /** Every trip the engine produced for req, along with the snapped
   * waypoints in visiting order. */
  async getAll(req: TripRequest, opts?: CallOptions): Promise<TripResponse> {
    validateTripRequest(req);
    const coords = encodePoints(req.coordinates);
    return await this.transport.do(
      {
        method: 'GET',
        path: `/trip/v1/${profileOrDefault(req.profile ?? '')}/${coords}`,
        query: tripQuery(req),
        needsAuth: true,
      },
      decodeTripResponse,
      opts,
    );
  }
}

function validateTripRequest(req: TripRequest): void {
  if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
  if (req.coordinates.length < 2) {
    throw new InvalidRequestError(
      `justrouting: Coordinates needs at least 2 points, got ${req.coordinates.length}`,
    );
  }
}

function tripQuery(req: TripRequest): Record<string, string> {
  const q: Record<string, string> = {};
  if (req.roundtrip !== undefined) q.roundtrip = String(req.roundtrip);
  if (req.source) q.source = req.source;
  if (req.destination) q.destination = req.destination;
  if (req.steps) q.steps = 'true';
  if (req.annotations && req.annotations.length > 0) q.annotations = req.annotations.join(',');
  if (req.geometries) q.geometries = req.geometries;
  if (req.overview) q.overview = req.overview;
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

function decodeTripResponse(data: unknown, raw: string): TripResponse {
  const d = asRecord(data);
  const resp: TripResponse = {
    code: str(d.code),
    message: str(d.message),
    trips: Array.isArray(d.trips)
      ? d.trips.filter((t): t is unknown => t != null).map((t) => decodeRoute(t))
      : [],
    waypoints: Array.isArray(d.waypoints) ? d.waypoints.map((w) => decodeWaypoint(w)) : [],
  };
  const err = osrmStatusError(resp.code, resp.message ?? '');
  if (err) {
    err.body = truncateBody(raw);
    throw err;
  }
  return resp;
}
