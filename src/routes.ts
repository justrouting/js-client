/**
 * The Routes service: fastest route between coordinates.
 */

import { profileOrDefault } from './consts.js';
import {
  InvalidRequestError,
  NoRouteError,
  osrmStatusError,
  truncateBody,
} from './errors.js';
import {
  Geometry,
  asPoint,
  decodeWaypoint,
  encodePoints,
} from './geo.js';
import type { Point, PointLike, Waypoint } from './geo.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** A routing query. origin and destination are required; every other field
 * is optional.
 *
 * Fields:
 * - origin: where the route starts, as [longitude, latitude].
 * - destination: where the route ends, as [longitude, latitude].
 * - waypoints: intermediate stops, visited in the order given.
 * - profile: the routing profile. Defaults to "driving".
 * - alternatives: up to this many alternative routes. They are returned by
 *   getAll(); get() always yields the best route. The engine may return
 *   fewer, or none, if no reasonable alternative exists.
 * - steps: request turn-by-turn instructions on each leg.
 * - annotations: per-segment metadata. Valid values include "duration",
 *   "distance", "speed" and "nodes".
 * - geometries: the geometry encoding: "polyline" (the default),
 *   "polyline6" or "geojson". See Geometry.
 * - overview: geometry detail: "simplified" (the default), "full" or
 *   "false" to omit it.
 * - continueStraight: force or forbid continuing straight at the first
 *   waypoint. Undefined leaves the decision to the engine.
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
 *   the route calculation.
 * - waypointIndices: the indices of the input coordinates that the
 *   response should treat as waypoints, for example [0, 3] to keep only
 *   the first and last. The engine treats every input coordinate as a
 *   waypoint by default.
 */
export interface RouteRequest {
  origin: PointLike;
  destination: PointLike;
  waypoints?: PointLike[];
  profile?: string;
  alternatives?: number;
  steps?: boolean;
  annotations?: string[];
  geometries?: string;
  overview?: string;
  continueStraight?: boolean;
  exclude?: string[];
  bearings?: string[];
  radiuses?: string[];
  hints?: string[];
  approaches?: string[];
  snapping?: string;
  generateHints?: boolean;
  skipWaypoints?: boolean;
  waypointIndices?: number[];
}

/** The full result of a routing query.
 *
 * Fields:
 * - code: the engine status, "Ok" on success.
 * - message: explains a non-Ok code.
 * - dataVersion: the timestamp of the OSM data the engine used.
 * - routes: ordered best first.
 * - waypoints: the input coordinates snapped to the road network.
 */
export interface RouteResponse {
  code: string;
  message?: string;
  dataVersion?: string;
  routes: Route[];
  waypoints: Waypoint[];
}

/** A single path through the road network. */
export interface Route {
  /** The route length in metres. */
  distance: number;
  /** The estimated travel time in seconds. */
  duration: number;
  /** The value the engine minimised, in weightName units. */
  weight: number;
  /** The optimisation metric, such as "routability". */
  weightName: string;
  /** The route's shape. */
  geometry: Geometry;
  /** One entry per consecutive pair of waypoints. */
  legs: Leg[];
}

/** The portion of a route between two consecutive waypoints. */
export interface Leg {
  distance: number;
  duration: number;
  weight: number;
  summary: string;
  steps?: Step[];
  annotation?: Annotation;
}

/** A single turn-by-turn instruction, returned when
 * RouteRequest.steps is set. */
export interface Step {
  distance: number;
  duration: number;
  weight: number;
  geometry: Geometry;
  name: string;
  ref?: string;
  mode: string;
  maneuver: Maneuver;
  intersections?: Intersection[];
}

/** The action taken at the start of a Step. */
export interface Maneuver {
  location: Point;
  bearingBefore: number;
  bearingAfter: number;
  type: string;
  modifier?: string;
  exit?: number;
}

/** A junction passed during a Step. */
export interface Intersection {
  location: Point;
  bearings: number[];
  entry: boolean[];
  in?: number;
  out?: number;
  lanes?: Lane[];
  /** The road classes of the exiting roads, such as "toll" and "ferry". */
  classes?: string[];
}

/** A turn lane at an Intersection. */
export interface Lane {
  indications: string[];
  valid: boolean;
}

/** Per-segment metadata, returned when RouteRequest.annotations is set. */
export interface Annotation {
  distance?: number[];
  duration?: number[];
  speed?: number[];
  weight?: number[];
  nodes?: number[];
  datasources?: number[];
}

/** RoutesService computes the fastest route between coordinates. */
export class RoutesService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** The best route for req.
   *
   *     const route = await client.routes.get({
   *         origin: [103.8198, 1.3521],
   *         destination: [103.9915, 1.3644],
   *     });
   *     console.log(`${(route.distance / 1000).toFixed(1)} km`);
   *
   * Throws an error matching NoRouteError when the coordinates cannot be
   * connected. Use getAll() for alternatives and snapped waypoints.
   */
  async get(req: RouteRequest, opts?: CallOptions): Promise<Route> {
    const resp = await this.getAll(req, opts);
    if (resp.routes.length === 0) {
      throw new NoRouteError('no route found between the given coordinates', {
        statusCode: 200,
        osrmCode: 'NoRoute',
      });
    }
    return resp.routes[0]!;
  }

  /** Every route the engine produced for req, along with the snapped input
   * waypoints. */
  async getAll(req: RouteRequest, opts?: CallOptions): Promise<RouteResponse> {
    validateRouteRequest(req);
    const coords = encodePoints([req.origin, ...(req.waypoints ?? []), req.destination]);
    return await this.transport.do(
      {
        method: 'GET',
        path: `/route/v1/${profileOrDefault(req.profile ?? '')}/${coords}`,
        query: routeQuery(req),
        needsAuth: true,
      },
      decodeRouteResponse,
      opts,
    );
  }
}

function validateRouteRequest(req: RouteRequest): void {
  if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
  if (!req.origin || req.origin.length === 0) {
    throw new InvalidRequestError('justrouting: Origin is required');
  }
  if (!req.destination || req.destination.length === 0) {
    throw new InvalidRequestError('justrouting: Destination is required');
  }
}

function routeQuery(req: RouteRequest): Record<string, string> {
  const q: Record<string, string> = {};
  if (req.alternatives != null && req.alternatives > 0) q.alternatives = String(req.alternatives);
  if (req.steps) q.steps = 'true';
  if (req.annotations && req.annotations.length > 0) q.annotations = req.annotations.join(',');
  if (req.geometries) q.geometries = req.geometries;
  if (req.overview) q.overview = req.overview;
  if (req.continueStraight !== undefined) q.continue_straight = String(req.continueStraight);
  if (req.exclude && req.exclude.length > 0) q.exclude = req.exclude.join(',');
  if (req.bearings && req.bearings.length > 0) q.bearings = req.bearings.join(';');
  if (req.radiuses && req.radiuses.length > 0) q.radiuses = req.radiuses.join(';');
  if (req.hints && req.hints.length > 0) q.hints = req.hints.join(';');
  if (req.approaches && req.approaches.length > 0) q.approaches = req.approaches.join(';');
  if (req.snapping) q.snapping = req.snapping;
  if (req.generateHints !== undefined) q.generate_hints = String(req.generateHints);
  if (req.skipWaypoints) q.skip_waypoints = 'true';
  if (req.waypointIndices && req.waypointIndices.length > 0) {
    q.waypoints = req.waypointIndices.map(String).join(';');
  }
  return q;
}

function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function numArr(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => num(x)) : [];
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function boolArr(v: unknown): boolean[] {
  return Array.isArray(v) ? v.map((x) => x === true) : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function decodeRouteResponse(data: unknown, raw: string): RouteResponse {
  const d = asRecord(data);
  const dataVersion = str(d.data_version);
  const resp: RouteResponse = {
    code: str(d.code),
    message: str(d.message),
    ...(dataVersion !== '' ? { dataVersion } : {}),
    routes: Array.isArray(d.routes) ? d.routes.map((r) => decodeRoute(r)) : [],
    waypoints: Array.isArray(d.waypoints) ? d.waypoints.map((w) => decodeWaypoint(w)) : [],
  };
  const err = osrmStatusError(resp.code, resp.message ?? '');
  if (err) {
    err.body = truncateBody(raw);
    throw err;
  }
  return resp;
}

/** decodeRoute decodes one route object. Exported for the Map Matching
 * service, whose Match entries embed a Route. */
export function decodeRoute(v: unknown): Route {
  const d = asRecord(v);
  return {
    distance: num(d.distance),
    duration: num(d.duration),
    weight: num(d.weight),
    weightName: str(d.weight_name),
    geometry: new Geometry(d.geometry ?? null),
    legs: Array.isArray(d.legs) ? d.legs.map((l) => decodeLeg(l)) : [],
  };
}

function decodeLeg(v: unknown): Leg {
  const d = asRecord(v);
  const annotation = d.annotation;
  const leg: Leg = {
    distance: num(d.distance),
    duration: num(d.duration),
    weight: num(d.weight),
    summary: str(d.summary),
    steps: Array.isArray(d.steps) ? d.steps.map((s) => decodeStep(s)) : [],
  };
  if (annotation != null) leg.annotation = decodeAnnotation(annotation);
  return leg;
}

function decodeStep(v: unknown): Step {
  const d = asRecord(v);
  const maneuver = d.maneuver;
  const ref = str(d.ref);
  const step: Step = {
    distance: num(d.distance),
    duration: num(d.duration),
    weight: num(d.weight),
    geometry: new Geometry(d.geometry ?? null),
    name: str(d.name),
    ...(ref !== '' ? { ref } : {}),
    mode: str(d.mode),
    maneuver: maneuver != null ? decodeManeuver(maneuver) : {
      location: [0, 0] as Point,
      bearingBefore: 0,
      bearingAfter: 0,
      type: '',
    },
    intersections: Array.isArray(d.intersections)
      ? d.intersections.map((i) => decodeIntersection(i))
      : [],
  };
  return step;
}

function decodeManeuver(v: unknown): Maneuver {
  const d = asRecord(v);
  const modifier = str(d.modifier);
  const m: Maneuver = {
    location: asPoint(d.location),
    bearingBefore: num(d.bearing_before),
    bearingAfter: num(d.bearing_after),
    type: str(d.type),
    ...(modifier !== '' ? { modifier } : {}),
  };
  const exit = d.exit;
  if (typeof exit === 'number' && exit !== 0) m.exit = exit;
  return m;
}

function decodeIntersection(v: unknown): Intersection {
  const d = asRecord(v);
  const i: Intersection = {
    location: asPoint(d.location),
    bearings: numArr(d.bearings),
    entry: boolArr(d.entry),
  };
  if (typeof d.in === 'number') i.in = d.in;
  if (typeof d.out === 'number') i.out = d.out;
  if (Array.isArray(d.lanes)) i.lanes = d.lanes.map((l) => decodeLane(l));
  if (Array.isArray(d.classes)) i.classes = strArr(d.classes);
  return i;
}

function decodeLane(v: unknown): Lane {
  const d = asRecord(v);
  return {
    indications: strArr(d.indications),
    valid: d.valid === true,
  };
}

function decodeAnnotation(v: unknown): Annotation {
  const d = asRecord(v);
  const a: Annotation = {};
  if (Array.isArray(d.distance)) a.distance = numArr(d.distance);
  if (Array.isArray(d.duration)) a.duration = numArr(d.duration);
  if (Array.isArray(d.speed)) a.speed = numArr(d.speed);
  if (Array.isArray(d.weight)) a.weight = numArr(d.weight);
  if (Array.isArray(d.nodes)) a.nodes = numArr(d.nodes);
  if (Array.isArray(d.datasources)) a.datasources = numArr(d.datasources);
  return a;
}
