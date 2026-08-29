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
 * - end: where the vehicle must finish. Omit to end anywhere.
 * - capacity: a multidimensional capacity vector. Its length must match the
 *   delivery and pickup vectors on tasks.
 * - skills: capabilities this vehicle provides.
 * - timeWindow: bounds when the vehicle is available.
 * - maxTasks: caps how many tasks the vehicle may be assigned.
 * - description: an opaque label echoed back in the solution.
 */
export interface Vehicle {
  id: number;
  profile?: string;
  start?: PointLike;
  end?: PointLike;
  capacity?: number[];
  skills?: number[];
  timeWindow?: TimeWindow;
  maxTasks?: number;
  description?: string;
}

/** A task carried out at a single location.
 *
 * Fields:
 * - id: identifies the job in the solution. It must be unique.
 * - location: where the job happens, as [longitude, latitude].
 * - setup: fixed preparation time in seconds.
 * - service: time spent on site, in seconds.
 * - delivery: the amount unloaded here, matching vehicle capacity.
 * - pickup: the amount loaded here, matching vehicle capacity.
 * - skills: capabilities a vehicle must have to serve this job.
 * - priority: ranks this job from 0 to 100 when not everything fits.
 * - timeWindows: constrain when the job may be served.
 * - description: an opaque label echoed back in the solution.
 */
export interface Job {
  id: number;
  location: PointLike;
  setup?: number;
  service?: number;
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
  location: PointLike;
  setup?: number;
  service?: number;
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
  /** An encoded polyline, present only when
   * OptimizationOptions.geometry was set. */
  geometry?: string;
  /** The stops in visiting order. */
  steps: RouteStep[];
}

/** A single stop on a VehicleRoute. */
export interface RouteStep {
  /** One of "start", "job", "pickup", "delivery", "break" or "end". */
  type: string;
  /** Where the stop happens. */
  location?: Point;
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
}

/** A task the solver could not fit into any route. */
export interface Unassigned {
  id: number;
  type?: string;
  location?: Point;
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
        path: '/vroom',
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
    // Start and End are both optional, but must be valid when given.
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
    if ((!v.start || v.start.length === 0) && (!v.end || v.end.length === 0)) {
      throw new InvalidRequestError(`justrouting: Vehicles[${i}] needs a Start or an End`);
    }
  });

  (req.jobs ?? []).forEach((j, i) => {
    try {
      validatePoint(j.location);
    } catch (err) {
      throw new InvalidRequestError(`Jobs[${i}].Location: ${(err as Error).message}`);
    }
  });

  (req.shipments ?? []).forEach((s, i) => {
    try {
      validatePoint(s.pickup.location);
    } catch (err) {
      throw new InvalidRequestError(`Shipments[${i}].Pickup.Location: ${(err as Error).message}`);
    }
    try {
      validatePoint(s.delivery.location);
    } catch (err) {
      throw new InvalidRequestError(
        `Shipments[${i}].Delivery.Location: ${(err as Error).message}`,
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
  omit(d, 'end', v.end);
  omit(d, 'capacity', v.capacity);
  omit(d, 'skills', v.skills);
  omit(d, 'time_window', v.timeWindow);
  omit(d, 'max_tasks', v.maxTasks);
  omit(d, 'description', v.description);
  return d;
}

function serializeJob(j: Job): Record<string, unknown> {
  const d: Record<string, unknown> = { id: j.id, location: j.location };
  omit(d, 'setup', j.setup);
  omit(d, 'service', j.service);
  omit(d, 'delivery', j.delivery);
  omit(d, 'pickup', j.pickup);
  omit(d, 'skills', j.skills);
  omit(d, 'priority', j.priority);
  omit(d, 'time_windows', j.timeWindows);
  omit(d, 'description', j.description);
  return d;
}

function serializeShipmentStep(s: ShipmentStep): Record<string, unknown> {
  const d: Record<string, unknown> = { id: s.id, location: s.location };
  omit(d, 'setup', s.setup);
  omit(d, 'service', s.service);
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
  if (req.options?.geometry) d.options = { g: true };
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
  return s;
}

function decodeVehicleRoute(v: unknown): VehicleRoute {
  const d = asRecord(v);
  const geometry = typeof d.geometry === 'string' ? d.geometry : undefined;
  const r: VehicleRoute = {
    vehicle: num(d.vehicle),
    cost: num(d.cost),
    setup: num(d.setup),
    service: num(d.service),
    duration: num(d.duration),
    waitingTime: num(d.waiting_time),
    priority: num(d.priority),
    steps: Array.isArray(d.steps) ? d.steps.map((s) => decodeRouteStep(s)) : [],
  };
  if (typeof d.distance === 'number') r.distance = d.distance;
  if (Array.isArray(d.delivery)) r.delivery = numArr(d.delivery);
  if (Array.isArray(d.pickup)) r.pickup = numArr(d.pickup);
  if (geometry !== undefined) r.geometry = geometry;
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
  if (typeof d.id === 'number') s.id = d.id;
  if (typeof d.job === 'number') s.job = d.job;
  if (typeof d.distance === 'number') s.distance = d.distance;
  if (Array.isArray(d.load)) s.load = numArr(d.load);
  const description = str(d.description);
  if (description !== '') s.description = description;
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
  const description = str(d.description);
  if (description !== '') u.description = description;
  return u;
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
