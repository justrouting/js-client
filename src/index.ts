/**
 * JustRouting JavaScript client.
 *
 * Official JavaScript client for the JustRouting API — routing, distance
 * matrices, and vehicle routing optimization across Southeast Asia.
 *
 *     import { Client } from 'justrouting';
 *
 *     const client = new Client('YOUR_API_KEY');
 *
 *     const route = await client.routes.get({
 *         origin: [103.8198, 1.3521],
 *         destination: [103.9915, 1.3644],
 *     });
 *     console.log(`Distance: ${(route.distance / 1000).toFixed(1)} km`);
 *
 * Coordinates are always [longitude, latitude], the order used by GeoJSON,
 * OSRM and VROOM. Failed calls throw an ApiError subclass — see
 * NoRouteError and friends.
 *
 * The package has no dependencies outside the Node.js standard library.
 */

export { Client } from './client.js';
export type { ClientOptions } from './client.js';
export { DEFAULT_BASE_URL, DEFAULT_PROFILE, VERSION } from './consts.js';
export {
  ApiError,
  CrossCountryError,
  DecodeError,
  InvalidCoordinatesError,
  InvalidRequestError,
  JustRoutingError,
  NoRouteError,
  PlanLimitExceededError,
  QuotaExceededError,
  RateLimitedError,
  TransportError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from './errors.js';
export { Geometry, encodePoints, formatCoord, validatePoint } from './geo.js';
export type { LineString, Point, PointLike, Waypoint } from './geo.js';
export { Health, HealthService } from './health.js';
export { MatrixResponse, MatrixService } from './matrix.js';
export type { MatrixRequest } from './matrix.js';
export { OptimizationService } from './optimization.js';
export type {
  Job,
  OptimizationOptions,
  OptimizationRequest,
  RouteStep,
  Shipment,
  ShipmentStep,
  Solution,
  Summary,
  TimeWindow,
  Unassigned,
  Vehicle,
  VehicleRoute,
} from './optimization.js';
export { RoutesService } from './routes.js';
export type {
  Annotation,
  Intersection,
  Lane,
  Leg,
  Maneuver,
  Route,
  RouteRequest,
  RouteResponse,
  Step,
} from './routes.js';
export type { CallOptions } from './transport.js';
