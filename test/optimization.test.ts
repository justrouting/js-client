import { describe, expect, it, vi } from 'vitest';

import { ApiError, Client, InvalidRequestError } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
  });
}

function okSolution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 0,
    summary: {
      cost: 100,
      routes: 1,
      unassigned: 0,
      setup: 0,
      service: 600,
      duration: 1200,
      waiting_time: 0,
      priority: 0,
      distance: 5000,
      violations: [],
    },
    routes: [
      {
        vehicle: 1,
        cost: 100,
        setup: 0,
        service: 600,
        duration: 1200,
        waiting_time: 0,
        priority: 0,
        distance: 5000,
        delivery: [3],
        description: 'van one',
        geometry: 'encoded-polyline',
        violations: [],
        steps: [
          {
            type: 'start',
            location: [103.8198, 1.3521],
            setup: 0,
            service: 0,
            waiting_time: 0,
            arrival: 0,
            duration: 0,
            load: [3],
            violations: [],
          },
          {
            type: 'job',
            location: [103.8514, 1.2897],
            location_index: 1,
            id: 1,
            job: 1,
            setup: 0,
            service: 300,
            waiting_time: 0,
            arrival: 300,
            duration: 300,
            load: [2],
            violations: [],
          },
          {
            type: 'end',
            location: [103.8198, 1.3521],
            setup: 0,
            service: 0,
            waiting_time: 0,
            arrival: 1200,
            duration: 0,
            load: [0],
            violations: [],
          },
        ],
      },
    ],
    unassigned: [
      {
        id: 2,
        type: 'job',
        location: [103.9915, 1.3644],
        location_index: 2,
        description: 'cannot fit',
      },
    ],
    ...overrides,
  };
}

describe('OptimizationService request building', () => {
  it('POSTs a fully-specified VROOM body', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okSolution()));
    const client = testClient(fetchImpl);
    await client.optimization.solve({
      vehicles: [
        {
          id: 1,
          profile: 'driving',
          start: [103.8198, 1.3521],
          end: [103.8198, 1.3521],
          capacity: [4],
          skills: [1, 2],
          type: 'van',
          timeWindow: [0, 28800],
          breaks: [{ id: 1, timeWindows: [[36000, 39600]], service: 1800, maxLoad: [2] }],
          speedFactor: 0.8,
          maxTasks: 5,
          maxTravelTime: 14400,
          maxDistance: 50000,
          costs: { fixed: 10, perHour: 2000, perTaskHour: 300, perKm: 2 },
          steps: [{ type: 'job', id: 1 }],
          description: 'van 1',
        },
      ],
      jobs: [
        {
          id: 1,
          location: [103.8514, 1.2897],
          setup: 60,
          service: 300,
          setupPerType: { van: 120 },
          servicePerType: { van: 600 },
          delivery: [1],
          pickup: [2],
          skills: [1],
          priority: 50,
          timeWindows: [[0, 14400]],
          description: 'stop A',
        },
      ],
      shipments: [
        {
          pickup: { id: 1, location: [103.9, 1.3], service: 120 },
          delivery: { id: 2, location: [103.95, 1.35], service: 120 },
          amount: [1],
          skills: [2],
          priority: 10,
        },
      ],
      matrices: {
        car: {
          durations: [[0, 14], [21, 0]],
          distances: [[0, 1500], [1500, 0]],
          costs: [[0, 1], [1, 0]],
        },
      },
      options: { geometry: true },
    });

    const call = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(call[0]).toBe('https://api.example.test/optimize');
    expect(call[1]?.method).toBe('POST');
    expect(call[1]?.body).toBe(JSON.stringify({
      vehicles: [
        {
          id: 1,
          profile: 'driving',
          start: [103.8198, 1.3521],
          end: [103.8198, 1.3521],
          capacity: [4],
          skills: [1, 2],
          type: 'van',
          time_window: [0, 28800],
          breaks: [{ id: 1, time_windows: [[36000, 39600]], service: 1800, max_load: [2] }],
          speed_factor: 0.8,
          max_tasks: 5,
          max_travel_time: 14400,
          max_distance: 50000,
          costs: { fixed: 10, per_hour: 2000, per_task_hour: 300, per_km: 2 },
          steps: [{ type: 'job', id: 1 }],
          description: 'van 1',
        },
      ],
      jobs: [
        {
          id: 1,
          location: [103.8514, 1.2897],
          setup: 60,
          service: 300,
          setup_per_type: { van: 120 },
          service_per_type: { van: 600 },
          delivery: [1],
          pickup: [2],
          skills: [1],
          priority: 50,
          time_windows: [[0, 14400]],
          description: 'stop A',
        },
      ],
      shipments: [
        {
          pickup: { id: 1, location: [103.9, 1.3], service: 120 },
          delivery: { id: 2, location: [103.95, 1.35], service: 120 },
          amount: [1],
          skills: [2],
          priority: 10,
        },
      ],
      matrices: {
        car: {
          durations: [[0, 14], [21, 0]],
          distances: [[0, 1500], [1500, 0]],
          costs: [[0, 1], [1, 0]],
        },
      },
      options: { g: true },
    }));
  });

  it('omits empty fields like Go omitempty', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okSolution()));
    const client = testClient(fetchImpl);
    await client.optimization.solve({
      vehicles: [{ id: 1, start: [103.8198, 1.3521] }],
      jobs: [{ id: 1, location: [103.8514, 1.2897] }],
    });
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      vehicles: [{ id: 1, start: [103.8198, 1.3521] }],
      jobs: [{ id: 1, location: [103.8514, 1.2897] }],
    });
    expect(body.options).toBeUndefined();
    expect(body.shipments).toBeUndefined();
  });
});

describe('OptimizationService validation', () => {
  it('needs at least one vehicle and one task', async () => {
    const client = testClient(mockFetch());
    await expect(client.optimization.solve({ vehicles: [] })).rejects.toMatchObject({
      message: 'justrouting: at least one Vehicle is required',
    });
    await expect(
      client.optimization.solve({ vehicles: [{ id: 1, start: [0, 0] }] }),
    ).rejects.toMatchObject({
      message: 'justrouting: at least one Job or Shipment is required',
    });
  });

  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.optimization.solve(null as never)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it('needs a start/end anchor on every vehicle', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.optimization.solve({
        vehicles: [{ id: 1 }],
        jobs: [{ id: 1, location: [0, 0] }],
      }),
    ).rejects.toMatchObject({
      message: 'justrouting: Vehicles[0] needs a Start, StartIndex, End or EndIndex',
    });
  });

  it('accepts index-only anchors', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 0, summary: {}, routes: [], unassigned: [] }));
    const client = testClient(fetchImpl);
    await client.optimization.solve({
      vehicles: [{ id: 1, startIndex: 0 }],
      jobs: [{ id: 1, locationIndex: 1 }],
      matrices: { car: { durations: [[0, 1], [1, 0]] } },
    });
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body));
    expect(body.vehicles[0].start_index).toBe(0);
    expect(body.jobs[0].location_index).toBe(1);
    expect(body.matrices.car.durations).toEqual([[0, 1], [1, 0]]);
  });

  it('rejects a job with neither location nor index', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.optimization.solve({
        vehicles: [{ id: 1, start: [0, 0] }],
        jobs: [{ id: 1 }],
      }),
    ).rejects.toMatchObject({ message: 'justrouting: Jobs[0] needs a Location or a LocationIndex' });
  });

  it('prefixes invalid coordinates with their field path', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.optimization.solve({
        vehicles: [{ id: 1, start: [1, 200] }],
        jobs: [{ id: 1, location: [0, 0] }],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Vehicles[0].Start:') });
    await expect(
      client.optimization.solve({
        vehicles: [{ id: 1, start: [0, 0] }],
        jobs: [{ id: 1, location: [200, 1] }],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Jobs[0].Location:') });
    await expect(
      client.optimization.solve({
        vehicles: [{ id: 1, start: [0, 0] }],
        shipments: [
          { pickup: { id: 1, location: [0, 0] }, delivery: { id: 2, location: [0, 200] } },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Shipments[0].Delivery.Location:') });
  });
});

describe('OptimizationService responses', () => {
  it('decodes a full solution', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okSolution()));
    const client = testClient(fetchImpl);
    const solution = await client.optimization.solve({
      vehicles: [{ id: 1, start: [103.8198, 1.3521], end: [103.8198, 1.3521] }],
      jobs: [{ id: 1, location: [103.8514, 1.2897], service: 300 }],
    });

    expect(solution.code).toBe(0);
    expect(solution.summary.cost).toBe(100);
    expect(solution.summary.service).toBe(600);
    expect(solution.summary.distance).toBe(5000);

    const route = solution.routes[0]!;
    expect(route.vehicle).toBe(1);
    expect(route.delivery).toEqual([3]);
    expect(route.description).toBe('van one');
    expect(route.geometry).toBe('encoded-polyline');
    expect(route.violations).toEqual([]);
    expect(route.steps).toHaveLength(3);

    const job = route.steps[1]!;
    expect(job.type).toBe('job');
    expect(job.id).toBe(1);
    expect(job.job).toBe(1);
    expect(job.location).toEqual([103.8514, 1.2897]);
    expect(job.locationIndex).toBe(1);
    expect(job.arrival).toBe(300);
    expect(job.load).toEqual([2]);

    const unassigned = solution.unassigned[0]!;
    expect(unassigned.id).toBe(2);
    expect(unassigned.type).toBe('job');
    expect(unassigned.locationIndex).toBe(2);
    expect(unassigned.description).toBe('cannot fit');
  });

  it('surfaces an in-body engine failure on HTTP 200', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 3, error: 'not enough vehicles' }));
    const client = testClient(fetchImpl);
    const err = await client.optimization
      .solve({
        vehicles: [{ id: 1, start: [0, 0] }],
        jobs: [{ id: 1, location: [1, 1] }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).vroomCode).toBe(3);
    expect((err as ApiError).statusCode).toBe(200);
    expect((err as ApiError).message).toBe('not enough vehicles');
  });

  it('synthesises a message when the engine sends only a code', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 2 }));
    const client = testClient(fetchImpl);
    const err = await client.optimization
      .solve({
        vehicles: [{ id: 1, start: [0, 0] }],
        jobs: [{ id: 1, location: [1, 1] }],
      })
      .catch((e: unknown) => e);
    expect((err as ApiError).message).toBe('optimization engine returned code 2');
  });
});
