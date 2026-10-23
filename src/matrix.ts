/**
 * The Matrix service: travel duration and distance between many
 * coordinates at once.
 */

import { profileOrDefault } from './consts.js';
import { InvalidRequestError, osrmStatusError, truncateBody } from './errors.js';
import { decodeWaypoint, encodePoints } from './geo.js';
import type { PointLike, Waypoint } from './geo.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** A matrix query. coordinates is required and must hold at least two
 * points.
 *
 * By default every coordinate is used as both a source and a destination,
 * producing an NxN matrix. Set sources and/or destinations to compute a
 * rectangular subset instead, which is considerably cheaper.
 *
 * The number of coordinates is capped by the account plan; exceeding it
 * throws an error matching PlanLimitExceededError.
 *
 * Fields:
 * - coordinates: the points to measure between.
 * - sources: which coordinates act as row origins, by index into
 *   coordinates. Empty means all of them.
 * - destinations: which coordinates act as column targets, by index into
 *   coordinates. Empty means all of them.
 * - annotations: which matrices to compute: "duration", "distance", or
 *   both. Defaults to both.
 * - fallbackSpeed: estimate the duration of unreachable pairs from their
 *   as-the-crow-flies distance at this speed, in km/h. The response
 *   reports which cells were estimated in fallbackSpeedCells.
 * - fallbackCoordinate: which coordinates fallback estimates are measured
 *   from: "input" (the engine default) or "snapped".
 * - scaleFactor: scale every duration by this factor, for example 1.2 for
 *   +20%.
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
 * - exclude: road classes to avoid, such as "motorway" or "ferry".
 *   Supported values depend on the profile.
 * - snapping: how coordinates snap onto the road network: "default" (the
 *   engine default) avoids edges that cannot be used as start or end
 *   points; "any" snaps to any edge.
 * - generateHints: request a "hint" on every response waypoint for reuse
 *   in later requests. The engine does this by default; set to false to
 *   omit hints.
 * - skipWaypoints: omit the response sources and destinations. They still
 *   take part in the matrix calculation.
 * - profile: the routing profile. Defaults to "driving".
 */
export interface MatrixRequest {
  coordinates: PointLike[];
  sources?: number[];
  destinations?: number[];
  annotations?: string[];
  fallbackSpeed?: number;
  fallbackCoordinate?: string;
  scaleFactor?: number;
  bearings?: string[];
  radiuses?: string[];
  hints?: string[];
  approaches?: string[];
  exclude?: string[];
  snapping?: string;
  generateHints?: boolean;
  skipWaypoints?: boolean;
  profile?: string;
}

/** The computed matrices.
 *
 * Entries are null because the engine reports an unreachable pair as null,
 * which must stay distinguishable from a genuine zero. Prefer the duration
 * and distance accessors.
 *
 * Fields:
 * - code: the engine status, "Ok" on success.
 * - message: explains a non-Ok code.
 * - durations: travel times in seconds, indexed [source][destination].
 * - distances: travel distances in metres, indexed [source][destination].
 * - sources: the source coordinates snapped to the road network.
 * - destinations: the destination coordinates snapped to the road network.
 * - fallbackSpeedCells: the [source, destination] pairs whose duration was
 *   estimated via the fallbackSpeed option.
 */
export class MatrixResponse {
  code = '';
  message = '';
  durations: (number | null)[][] | null = null;
  distances: (number | null)[][] | null = null;
  sources: Waypoint[] = [];
  destinations: Waypoint[] = [];
  fallbackSpeedCells: number[][] = [];

  /** The travel time in seconds from source i to destination j, or null
   * when the indices are out of range or the pair is unreachable. */
  duration(i: number, j: number): number | null {
    return matrixAt(this.durations, i, j);
  }

  /** The travel distance in metres from source i to destination j, or null
   * when the indices are out of range or the pair is unreachable. */
  distance(i: number, j: number): number | null {
    return matrixAt(this.distances, i, j);
  }
}

function matrixAt(m: (number | null)[][] | null, i: number, j: number): number | null {
  if (m === null || i < 0 || i >= m.length) return null;
  const row = m[i]!;
  if (j < 0 || j >= row.length) return null;
  return row[j]!;
}

/** MatrixService computes travel duration and distance between many
 * coordinates at once. */
export class MatrixService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Compute the duration and distance matrices for req.
   *
   *     const m = await client.matrix.get({
   *         coordinates: [depot, stopA, stopB],
   *         sources: [0],            // only the depot row; cheaper than NxN
   *         destinations: [1, 2],
   *     });
   *     const seconds = m.duration(0, 1);
   *     if (seconds !== null) {
   *         console.log(`depot → stopA: ${Math.round(seconds / 60)} min`);
   *     }
   */
  async get(req: MatrixRequest, opts?: CallOptions): Promise<MatrixResponse> {
    if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
    if (req.coordinates.length < 2) {
      throw new InvalidRequestError(
        `justrouting: Coordinates needs at least 2 points, got ${req.coordinates.length}`,
      );
    }
    const coords = encodePoints(req.coordinates);

    return await this.transport.do(
      {
        method: 'GET',
        path: `/table/v1/${profileOrDefault(req.profile ?? '')}/${coords}`,
        query: matrixQuery(req),
        needsAuth: true,
      },
      decodeMatrixResponse,
      opts,
    );
  }
}

function matrixQuery(req: MatrixRequest): Record<string, string> {
  const q: Record<string, string> = {};
  const annotations = req.annotations && req.annotations.length > 0
    ? req.annotations
    : ['duration', 'distance'];
  q.annotations = annotations.join(',');

  const sources = encodeIndices('Sources', req.sources ?? [], req.coordinates.length);
  if (sources) q.sources = sources;

  const destinations = encodeIndices(
    'Destinations',
    req.destinations ?? [],
    req.coordinates.length,
  );
  if (destinations) q.destinations = destinations;

  if (req.fallbackSpeed !== undefined) q.fallback_speed = String(req.fallbackSpeed);
  if (req.fallbackCoordinate) q.fallback_coordinate = req.fallbackCoordinate;
  if (req.scaleFactor !== undefined) q.scale_factor = String(req.scaleFactor);
  if (req.bearings && req.bearings.length > 0) q.bearings = req.bearings.join(';');
  if (req.radiuses && req.radiuses.length > 0) q.radiuses = req.radiuses.join(';');
  if (req.hints && req.hints.length > 0) q.hints = req.hints.join(';');
  if (req.approaches && req.approaches.length > 0) q.approaches = req.approaches.join(';');
  if (req.exclude && req.exclude.length > 0) q.exclude = req.exclude.join(',');
  if (req.snapping) q.snapping = req.snapping;
  if (req.generateHints !== undefined) q.generate_hints = String(req.generateHints);
  if (req.skipWaypoints) q.skip_waypoints = 'true';

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

function decodeMatrix(data: unknown): (number | null)[][] | null {
  if (!Array.isArray(data)) return null;
  return data.map((row) =>
    Array.isArray(row) ? row.map((v) => (v === null ? null : num(v))) : [],
  );
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function decodeMatrixResponse(data: unknown, raw: string): MatrixResponse {
  const d = (data ?? {}) as Record<string, unknown>;
  const resp = new MatrixResponse();
  resp.code = typeof d.code === 'string' ? d.code : '';
  resp.message = typeof d.message === 'string' ? d.message : '';
  resp.durations = decodeMatrix(d.durations);
  resp.distances = decodeMatrix(d.distances);
  resp.sources = Array.isArray(d.sources) ? d.sources.map((w) => decodeWaypoint(w)) : [];
  resp.destinations = Array.isArray(d.destinations)
    ? d.destinations.map((w) => decodeWaypoint(w))
    : [];
  resp.fallbackSpeedCells = Array.isArray(d.fallback_speed_cells)
    ? d.fallback_speed_cells
        .filter((c): c is unknown[] => Array.isArray(c))
        .map((c) => c.map((v) => num(v)))
    : [];
  const err = osrmStatusError(resp.code, resp.message);
  if (err) {
    err.body = truncateBody(raw);
    throw err;
  }
  return resp;
}
