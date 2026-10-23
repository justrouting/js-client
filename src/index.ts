/**
 * JustRouting JavaScript client.
 *
 * Official JavaScript client for the JustRouting API — routing, distance
 * matrices, map matching, trips, nearest-road lookup, vehicle routing
 * optimization, and geocoding across Southeast Asia.
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
export { GeocodeResult, GeocodeService } from './geocode.js';
export type {
  BBox,
  Datasource,
  GeocodeQuery,
  GeocodeRequest,
  GeocodeResponse,
  Rank,
  StructuredQuery,
  Timezone,
} from './geocode.js';
export { Geometry, encodePoints, formatCoord, validatePoint } from './geo.js';
export type { LineString, Point, PointLike, Waypoint } from './geo.js';
export { Health, HealthService } from './health.js';
export { MapMatchingService } from './map_matching.js';
export type {
  MapMatchingRequest,
  MapMatchingResponse,
  Match,
  Tracepoint,
} from './map_matching.js';
export { MatrixResponse, MatrixService } from './matrix.js';
export type { MatrixRequest } from './matrix.js';
export { NearestService } from './nearest.js';
export type { NearestRequest, NearestResponse } from './nearest.js';
export { OptimizationService } from './optimization.js';
export type {
  Break,
  CustomMatrix,
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
  VehicleCosts,
  VehicleRoute,
  VehicleStep,
  Violation,
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
export { TripService } from './trip.js';
export type { TripRequest, TripResponse } from './trip.js';
export type { CallOptions } from './transport.js';
