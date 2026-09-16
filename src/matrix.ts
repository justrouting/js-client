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
 * - profile: the routing profile. Defaults to "driving".
 */
export interface MatrixRequest {
  coordinates: PointLike[];
  sources?: number[];
  destinations?: number[];
  annotations?: string[];
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
 */
export class MatrixResponse {
  code = '';
  message = '';
  durations: (number | null)[][] | null = null;
  distances: (number | null)[][] | null = null;
  sources: Waypoint[] = [];
  destinations: Waypoint[] = [];

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
  const err = osrmStatusError(resp.code, resp.message);
  if (err) {
    err.body = truncateBody(raw);
    throw err;
  }
  return resp;
}
