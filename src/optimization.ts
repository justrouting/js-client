/**
 * The Optimization service: solve vehicle routing problems — given a fleet
 * and a set of tasks, it assigns tasks to vehicles and orders each
 * vehicle's stops.
 */

import { ApiError, InvalidRequestError, truncateBody } from './errors.js';
import { asPoint, validatePoint } from './geo.js';
import type { Point, PointLike } from './geo.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** An inclusive [start, end] pair, in seconds, relative to the same origin
 * used by the rest of the request. */
export type TimeWindow = [number, number];

/** A user-supplied travel-time, distance or cost matrix for one routing
 * profile. Values are read as matrix[row][column]; rows and columns are
 * indexed by the *_index fields on vehicles and tasks. */
export interface CustomMatrix {
  /** A travel-time matrix in seconds. Providing it for every profile in use
   * makes locations optional. */
  durations?: number[][];
  /** A distance matrix in metres. It requires durations. */
  distances?: number[][];
  /** A cost matrix used in all route cost evaluations. */
  costs?: number[][];
}

/** A rest period scheduled during a vehicle's route. */
export interface Break {
  /** Identifies the break. It must be unique within the vehicle. */
  id: number;
  /** Bound when the break may start. */
  timeWindows?: TimeWindow[];
  /** The break length in seconds. */
  service?: number;
  /** An opaque label echoed back in the solution. */
  description?: string;
  /** The maximum load, per capacity dimension, under which the break may
   * happen. */
  maxLoad?: number[];
}

/** Adjusts how the solver values one vehicle. */
export interface VehicleCosts {
  /** The one-time cost of using this vehicle. Defaults to 0. */
  fixed?: number;
  /** The cost of one hour of travel time. Defaults to 3600. */
  perHour?: number;
  /** The cost of one hour of task time (setup + service). Defaults to 0. */
  perTaskHour?: number;
  /** The cost of one kilometre of travel. Defaults to 0. */
  perKm?: number;
}

/** One entry of a custom route on a Vehicle. The hosted API runs in solving
 * mode, where steps warm-start the search and only the "job", "pickup" and
 * "delivery" step types are used. */
export interface VehicleStep {
  /** "job", "pickup" or "delivery". */
  type: string;
  /** The task ID this step refers to. */
  id?: number;
}

/** One constraint violation. Violations are always empty in solving mode,
 * the only mode the hosted API runs, but the fields exist for API
 * completeness. */
export interface Violation {
  /** The violated constraint, e.g. "delay", "skills" or "missing_break". */
  cause: string;
  /** The lateness in seconds for "delay" causes, earliness for
   * "lead_time". */
  duration?: number;
}

/** A vehicle routing problem. At least one vehicle and at least one job or
 * shipment are required.
 *
 * Fleet and task counts are capped by the account plan; exceeding either
 * throws an error matching PlanLimitExceededError.
 */
export interface OptimizationRequest {
  /** The available fleet. */
  vehicles: Vehicle[];
  /** Single-location tasks. */
  jobs?: Job[];
  /** Pickup-and-delivery pairs handled by one vehicle. */
  shipments?: Shipment[];
  /** Custom matrices per routing profile; the map keys are profile names
   * such as "car" or "motorcycle". */
  matrices?: Record<string, CustomMatrix>;
  /** Solver tuning. */
  options?: OptimizationOptions;
}

/** Solver behaviour. */
export interface OptimizationOptions {
  /** Request a road-following geometry for each route. It costs extra
   * computation, so it is off by default. */
  geometry?: boolean;
}

/** One member of the fleet.
 *
 * Fields:
 * - id: identifies the vehicle in the solution. It must be unique.
 * - profile: the routing profile for this vehicle.
 * - start: where the vehicle begins, as [longitude, latitude]. Omit for a
 *   vehicle that may start anywhere.
 * - startIndex: the row/column in custom matrices that replaces start.
 * - end: where the vehicle must finish. Omit to end anywhere.
 * - endIndex: the row/column in custom matrices that replaces end.
 * - capacity: a multidimensional capacity vector. Its length must match the
 *   delivery and pickup vectors on tasks.
 * - skills: capabilities this vehicle provides.
 * - type: names this vehicle for per-type setup and service times on tasks.
 * - timeWindow: bounds when the vehicle is available.
 * - breaks: rest periods during the route.
 * - speedFactor: scales all travel times for this vehicle, in (0, 5].
 * - maxTasks: caps how many tasks the vehicle may be assigned.
 * - maxTravelTime: caps total travel time in seconds.
 * - maxDistance: caps total travel distance in metres.
 * - costs: adjusts how the solver values this vehicle.
 * - steps: a custom route used to warm-start the search.
 * - description: an opaque label echoed back in the solution.
 */
export interface Vehicle {
  id: number;
  profile?: string;
  start?: PointLike;
  startIndex?: number;
  end?: PointLike;
  endIndex?: number;
  capacity?: number[];
  skills?: number[];
  type?: string;
  timeWindow?: TimeWindow;
  breaks?: Break[];
  speedFactor?: number;
  maxTasks?: number;
  maxTravelTime?: number;
  maxDistance?: number;
  costs?: VehicleCosts;
  steps?: VehicleStep[];
  description?: string;
}

/** A task carried out at a single location.
 *
 * Fields:
 * - id: identifies the job in the solution. It must be unique.
 * - location: where the job happens, as [longitude, latitude]. Omit when
 *   custom matrices cover every profile in use; then locationIndex is
 *   required.
 * - locationIndex: the row/column in custom matrices that replaces
 *   location.
 * - setup: fixed preparation time in seconds.
 * - service: time spent on site, in seconds.
 * - setupPerType: setup overrides for vehicles of each named type.
 * - servicePerType: service overrides for vehicles of each named type.
 * - delivery: the amount unloaded here, matching vehicle capacity.
 * - pickup: the amount loaded here, matching vehicle capacity.
 * - skills: capabilities a vehicle must have to serve this job.
 * - priority: ranks this job from 0 to 100 when not everything fits.
 * - timeWindows: constrain when the job may be served.
 * - description: an opaque label echoed back in the solution.
 */
export interface Job {
  id: number;
  location?: PointLike;
  locationIndex?: number;
  setup?: number;
  service?: number;
  setupPerType?: Record<string, number>;
  servicePerType?: Record<string, number>;
  delivery?: number[];
  pickup?: number[];
  skills?: number[];
  priority?: number;
  timeWindows?: TimeWindow[];
  description?: string;
}

/** One half of a Shipment. */
export interface ShipmentStep {
  id: number;
  location?: PointLike;
  locationIndex?: number;
  setup?: number;
  service?: number;
  setupPerType?: Record<string, number>;
  servicePerType?: Record<string, number>;
  timeWindows?: TimeWindow[];
  description?: string;
}

/** A pickup and a delivery that must be served in order by the same
 * vehicle. */
export interface Shipment {
  pickup: ShipmentStep;
  delivery: ShipmentStep;
  /** The load carried between the two steps. */
  amount?: number[];
  /** Capabilities a vehicle must have. */
  skills?: number[];
  /** Ranks this shipment from 0 to 100. */
  priority?: number;
}

/** The result of an optimization run.
 *
 * Fields:
 * - code: the engine status, 0 on success.
 * - error: explains a non-zero code.
 * - summary: aggregates the whole solution.
 * - routes: one entry per vehicle that was used.
 * - unassigned: tasks that could not be served.
 */
export interface Solution {
  code: number;
  error?: string;
  summary: Summary;
  routes: VehicleRoute[];
  unassigned: Unassigned[];
}

/** Aggregates the cost and time of a whole Solution. */
export interface Summary {
  cost: number;
  routes: number;
  unassigned: number;
  delivery?: number[];
  pickup?: number[];
  setup: number;
  service: number;
  duration: number;
  waitingTime: number;
  priority: number;
  distance?: number;
  /** Always empty in solving mode. */
  violations?: Violation[];
}

/** The itinerary assigned to one vehicle. */
export interface VehicleRoute {
  /** The ID of the vehicle serving this route. */
  vehicle: number;
  cost: number;
  setup: number;
  service: number;
  duration: number;
  waitingTime: number;
  priority: number;
  distance?: number;
  delivery?: number[];
  pickup?: number[];
  /** The vehicle description echoed from the request. */
  description?: string;
  /** An encoded polyline, present only when
   * OptimizationOptions.geometry was set. */
  geometry?: string;
  /** The stops in visiting order. */
  steps: RouteStep[];
  /** Always empty in solving mode. */
  violations?: Violation[];
}

/** A single stop on a VehicleRoute. */
export interface RouteStep {
  /** One of "start", "job", "pickup", "delivery", "break" or "end". */
  type: string;
  /** Where the stop happens. */
  location?: Point;
  /** The row/column in custom matrices, when the request used matrices. */
  locationIndex?: number;
  /** The task ID, for task steps. */
  id?: number;
  /** The job ID, for job steps. */
  job?: number;
  setup: number;
  service: number;
  waitingTime: number;
  /** The arrival time in seconds. */
  arrival: number;
  duration: number;
  distance?: number;
  /** The vehicle load after this stop. */
  load?: number[];
  description?: string;
  /** Always empty in solving mode. */
  violations?: Violation[];
}

/** A task the solver could not fit into any route. */
export interface Unassigned {
  id: number;
  type?: string;
  location?: Point;
  /** The row/column in custom matrices, when the request used matrices. */
  locationIndex?: number;
  description?: string;
}

/** OptimizationService solves vehicle routing problems: given a fleet and
 * a set of tasks, it assigns tasks to vehicles and orders each vehicle's
 * stops. */
export class OptimizationService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Assign the request's tasks to its vehicles and order each route.
   *
   *     const solution = await client.optimization.solve({
   *         vehicles: [{ id: 1, start: depot, end: depot }],
   *         jobs: [
   *             { id: 1, location: stopA },
   *             { id: 2, location: stopB },
   *         ],
   *     });
   *
   * All coordinates in a request must lie within a single country;
   * otherwise the call fails with an error matching CrossCountryError.
   */
  async solve(req: OptimizationRequest, opts?: CallOptions): Promise<Solution> {
    validateOptimizationRequest(req);
    return await this.transport.do(
      {
        method: 'POST',
        path: '/optimize',
        body: serializeOptimizationRequest(req),
        needsAuth: true,
      },
      decodeSolutionResponse,
      opts,
    );
  }
}

function validateOptimizationRequest(req: OptimizationRequest): void {
  if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
  if (!req.vehicles || req.vehicles.length === 0) {
    throw new InvalidRequestError('justrouting: at least one Vehicle is required');
  }
  if ((!req.jobs || req.jobs.length === 0) && (!req.shipments || req.shipments.length === 0)) {
    throw new InvalidRequestError('justrouting: at least one Job or Shipment is required');
  }

  req.vehicles.forEach((v, i) => {
    // Start and End are both optional, but must be valid when given. A
    // custom-matrix row counts as an anchor just like coordinates.
    if (v.start && v.start.length > 0) {
      try {
        validatePoint(v.start);
      } catch (err) {
        throw new InvalidRequestError(`Vehicles[${i}].Start: ${(err as Error).message}`);
      }
    }
    if (v.end && v.end.length > 0) {
      try {
        validatePoint(v.end);
      } catch (err) {
        throw new InvalidRequestError(`Vehicles[${i}].End: ${(err as Error).message}`);
      }
    }
    if (
      (!v.start || v.start.length === 0) &&
      v.startIndex === undefined &&
      (!v.end || v.end.length === 0) &&
      v.endIndex === undefined
    ) {
      throw new InvalidRequestError(
        `justrouting: Vehicles[${i}] needs a Start, StartIndex, End or EndIndex`,
      );
    }
  });

  (req.jobs ?? []).forEach((j, i) => {
    if (j.location && j.location.length > 0) {
      try {
        validatePoint(j.location);
      } catch (err) {
        throw new InvalidRequestError(`Jobs[${i}].Location: ${(err as Error).message}`);
      }
    }
    if ((!j.location || j.location.length === 0) && j.locationIndex === undefined) {
      throw new InvalidRequestError(
        `justrouting: Jobs[${i}] needs a Location or a LocationIndex`,
      );
    }
  });

  (req.shipments ?? []).forEach((s, i) => {
    if (s.pickup.location && s.pickup.location.length > 0) {
      try {
        validatePoint(s.pickup.location);
      } catch (err) {
        throw new InvalidRequestError(
          `Shipments[${i}].Pickup.Location: ${(err as Error).message}`,
        );
      }
    }
    if (
      (!s.pickup.location || s.pickup.location.length === 0) &&
      s.pickup.locationIndex === undefined
    ) {
      throw new InvalidRequestError(
        `justrouting: Shipments[${i}].Pickup needs a Location or a LocationIndex`,
      );
    }
    if (s.delivery.location && s.delivery.location.length > 0) {
      try {
        validatePoint(s.delivery.location);
      } catch (err) {
        throw new InvalidRequestError(
          `Shipments[${i}].Delivery.Location: ${(err as Error).message}`,
        );
      }
    }
    if (
      (!s.delivery.location || s.delivery.location.length === 0) &&
      s.delivery.locationIndex === undefined
    ) {
      throw new InvalidRequestError(
        `justrouting: Shipments[${i}].Delivery needs a Location or a LocationIndex`,
      );
    }
  });
}

/** omit sets d[key] = value unless the value is empty in the Go omitempty
 * sense: undefined/null, an empty array, an empty string, or zero. */
function omit(d: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && value.length === 0) return;
  if (typeof value === 'string' && value === '') return;
  if (typeof value === 'number' && value === 0) return;
  d[key] = value;
}

function serializeVehicle(v: Vehicle): Record<string, unknown> {
  const d: Record<string, unknown> = { id: v.id };
  omit(d, 'profile', v.profile);
  omit(d, 'start', v.start);
  // 0 is a valid matrix row, so indices are only omitted when undefined.
  if (v.startIndex !== undefined) d.start_index = v.startIndex;
  omit(d, 'end', v.end);
  if (v.endIndex !== undefined) d.end_index = v.endIndex;
  omit(d, 'capacity', v.capacity);
  omit(d, 'skills', v.skills);
  omit(d, 'type', v.type);
  omit(d, 'time_window', v.timeWindow);
  if (v.breaks && v.breaks.length > 0) d.breaks = v.breaks.map((b) => serializeBreak(b));
  omit(d, 'speed_factor', v.speedFactor);
  omit(d, 'max_tasks', v.maxTasks);
  omit(d, 'max_travel_time', v.maxTravelTime);
  omit(d, 'max_distance', v.maxDistance);
  if (v.costs !== undefined) d.costs = serializeCosts(v.costs);
  if (v.steps && v.steps.length > 0) d.steps = v.steps.map((s) => serializeVehicleStep(s));
  omit(d, 'description', v.description);
  return d;
}

function serializeBreak(b: Break): Record<string, unknown> {
  const d: Record<string, unknown> = { id: b.id };
  omit(d, 'time_windows', b.timeWindows);
  omit(d, 'service', b.service);
  omit(d, 'description', b.description);
  omit(d, 'max_load', b.maxLoad);
  return d;
}

function serializeCosts(c: VehicleCosts): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  omit(d, 'fixed', c.fixed);
  omit(d, 'per_hour', c.perHour);
  omit(d, 'per_task_hour', c.perTaskHour);
  omit(d, 'per_km', c.perKm);
  return d;
}

function serializeVehicleStep(s: VehicleStep): Record<string, unknown> {
  const d: Record<string, unknown> = { type: s.type };
  omit(d, 'id', s.id);
  return d;
}

function serializeJob(j: Job): Record<string, unknown> {
  const d: Record<string, unknown> = { id: j.id };
  omit(d, 'location', j.location);
  // 0 is a valid matrix row, so the index is only omitted when undefined.
  if (j.locationIndex !== undefined) d.location_index = j.locationIndex;
  omit(d, 'setup', j.setup);
  omit(d, 'service', j.service);
  omit(d, 'setup_per_type', j.setupPerType);
  omit(d, 'service_per_type', j.servicePerType);
  omit(d, 'delivery', j.delivery);
  omit(d, 'pickup', j.pickup);
  omit(d, 'skills', j.skills);
  omit(d, 'priority', j.priority);
  omit(d, 'time_windows', j.timeWindows);
  omit(d, 'description', j.description);
  return d;
}

function serializeShipmentStep(s: ShipmentStep): Record<string, unknown> {
  const d: Record<string, unknown> = { id: s.id };
  omit(d, 'location', s.location);
  // 0 is a valid matrix row, so the index is only omitted when undefined.
  if (s.locationIndex !== undefined) d.location_index = s.locationIndex;
  omit(d, 'setup', s.setup);
  omit(d, 'service', s.service);
  omit(d, 'setup_per_type', s.setupPerType);
  omit(d, 'service_per_type', s.servicePerType);
  omit(d, 'time_windows', s.timeWindows);
  omit(d, 'description', s.description);
  return d;
}

function serializeShipment(s: Shipment): Record<string, unknown> {
  const d: Record<string, unknown> = {
    pickup: serializeShipmentStep(s.pickup),
    delivery: serializeShipmentStep(s.delivery),
  };
  omit(d, 'amount', s.amount);
  omit(d, 'skills', s.skills);
  omit(d, 'priority', s.priority);
  return d;
}

function serializeOptimizationRequest(req: OptimizationRequest): Record<string, unknown> {
  const d: Record<string, unknown> = {
    vehicles: req.vehicles.map((v) => serializeVehicle(v)),
  };
  if (req.jobs && req.jobs.length > 0) d.jobs = req.jobs.map((j) => serializeJob(j));
  if (req.shipments && req.shipments.length > 0) {
    d.shipments = req.shipments.map((s) => serializeShipment(s));
  }
  if (req.matrices && Object.keys(req.matrices).length > 0) {
    d.matrices = Object.fromEntries(
      Object.entries(req.matrices).map(([profile, m]) => [profile, serializeMatrix(m)]),
    );
  }
  if (req.options?.geometry) d.options = { g: true };
  return d;
}

function serializeMatrix(m: CustomMatrix): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  omit(d, 'durations', m.durations);
  omit(d, 'distances', m.distances);
  omit(d, 'costs', m.costs);
  return d;
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

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function decodeSolution(data: unknown): Solution {
  const d = asRecord(data);
  const s: Solution = {
    code: num(d.code),
    error: str(d.error),
    summary: decodeSummary(d.summary),
    routes: Array.isArray(d.routes) ? d.routes.map((r) => decodeVehicleRoute(r)) : [],
    unassigned: Array.isArray(d.unassigned) ? d.unassigned.map((u) => decodeUnassigned(u)) : [],
  };
  return s;
}

function decodeSummary(v: unknown): Summary {
  const d = asRecord(v);
  const s: Summary = {
    cost: num(d.cost),
    routes: num(d.routes),
    unassigned: num(d.unassigned),
    setup: num(d.setup),
    service: num(d.service),
    duration: num(d.duration),
    waitingTime: num(d.waiting_time),
    priority: num(d.priority),
  };
  if (Array.isArray(d.delivery)) s.delivery = numArr(d.delivery);
  if (Array.isArray(d.pickup)) s.pickup = numArr(d.pickup);
  if (typeof d.distance === 'number') s.distance = d.distance;
  if (Array.isArray(d.violations)) s.violations = d.violations.map((x) => decodeViolation(x));
  return s;
}

function decodeVehicleRoute(v: unknown): VehicleRoute {
  const d = asRecord(v);
  const geometry = typeof d.geometry === 'string' ? d.geometry : undefined;
  const description = str(d.description);
  const r: VehicleRoute = {
    vehicle: num(d.vehicle),
    cost: num(d.cost),
    setup: num(d.setup),
    service: num(d.service),
    duration: num(d.duration),
    waitingTime: num(d.waiting_time),
    priority: num(d.priority),
    ...(description !== '' ? { description } : {}),
    steps: Array.isArray(d.steps) ? d.steps.map((s) => decodeRouteStep(s)) : [],
  };
  if (typeof d.distance === 'number') r.distance = d.distance;
  if (Array.isArray(d.delivery)) r.delivery = numArr(d.delivery);
  if (Array.isArray(d.pickup)) r.pickup = numArr(d.pickup);
  if (geometry !== undefined) r.geometry = geometry;
  if (Array.isArray(d.violations)) r.violations = d.violations.map((x) => decodeViolation(x));
  return r;
}

function decodeRouteStep(v: unknown): RouteStep {
  const d = asRecord(v);
  const s: RouteStep = {
    type: str(d.type),
    setup: num(d.setup),
    service: num(d.service),
    waitingTime: num(d.waiting_time),
    arrival: num(d.arrival),
    duration: num(d.duration),
  };
  if (d.location != null && Array.isArray(d.location)) s.location = asPoint(d.location);
  if (typeof d.location_index === 'number') s.locationIndex = d.location_index;
  if (typeof d.id === 'number') s.id = d.id;
  if (typeof d.job === 'number') s.job = d.job;
  if (typeof d.distance === 'number') s.distance = d.distance;
  if (Array.isArray(d.load)) s.load = numArr(d.load);
  const description = str(d.description);
  if (description !== '') s.description = description;
  if (Array.isArray(d.violations)) s.violations = d.violations.map((x) => decodeViolation(x));
  return s;
}

function decodeUnassigned(v: unknown): Unassigned {
  const d = asRecord(v);
  const u: Unassigned = {
    id: num(d.id),
  };
  const type = str(d.type);
  if (type !== '') u.type = type;
  if (d.location != null && Array.isArray(d.location)) u.location = asPoint(d.location);
  if (typeof d.location_index === 'number') u.locationIndex = d.location_index;
  const description = str(d.description);
  if (description !== '') u.description = description;
  return u;
}

function decodeViolation(v: unknown): Violation {
  const d = asRecord(v);
  const violation: Violation = {
    cause: str(d.cause),
  };
  if (typeof d.duration === 'number') violation.duration = d.duration;
  return violation;
}

function decodeSolutionResponse(data: unknown, raw: string): Solution {
  const solution = decodeSolution(data);
  if (solution.code !== 0) {
    const message = solution.error || `optimization engine returned code ${solution.code}`;
    const err = new ApiError(message, { statusCode: 200, vroomCode: solution.code });
    err.body = truncateBody(raw);
    throw err;
  }
  return solution;
}
