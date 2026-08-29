import { describe, expect, it, vi } from 'vitest';

import {
  Client,
  InvalidCoordinatesError,
  InvalidRequestError,
  NoRouteError,
} from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
  });
}

function okRoute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'Ok',
    routes: [
      {
        distance: 12345.6,
        duration: 987.6,
        weight: 987.6,
        weight_name: 'routability',
        geometry: 'q`kpA~dulLfC_C~AhB',
        legs: [
          {
            distance: 12345.6,
            duration: 987.6,
            weight: 987.6,
            summary: '',
            steps: [],
          },
        ],
      },
    ],
    waypoints: [
      {
        name: 'Marina Bay',
        location: [103.8198, 1.3521],
        distance: 3.4,
        hint: 'hint-token',
      },
    ],
    ...overrides,
  };
}

describe('RoutesService request building', () => {
  it('uses the default profile and flattens origin, waypoints and destination', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okRoute()));
    const client = testClient(fetchImpl);
    await client.routes.getAll({
      origin: [103.8198, 1.3521],
      waypoints: [[103.8514, 1.2897]],
      destination: [103.9915, 1.3644],
    });
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(url).toBe(
      'https://api.example.test/osrm/route/v1/driving/103.8198,1.3521;103.8514,1.2897;103.9915,1.3644',
    );
  });

  it('escapes a custom profile in the path', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okRoute()));
    const client = testClient(fetchImpl);
    await client.routes.get({
      origin: [0, 0],
      destination: [1, 1],
      profile: 'my profile',
    });
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(url).toContain('/my%20profile/');
  });

  it('serializes every query parameter', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okRoute()));
    const client = testClient(fetchImpl);
    await client.routes.get({
      origin: [0, 0],
      destination: [1, 1],
      alternatives: 3,
      steps: true,
      annotations: ['duration', 'nodes'],
      geometries: 'geojson',
      overview: 'full',
      continueStraight: false,
      exclude: ['motorway', 'ferry'],
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('alternatives')).toBe('3');
    expect(url.searchParams.get('steps')).toBe('true');
    expect(url.searchParams.get('annotations')).toBe('duration,nodes');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('overview')).toBe('full');
    expect(url.searchParams.get('continue_straight')).toBe('false');
    expect(url.searchParams.get('exclude')).toBe('motorway,ferry');
  });

  it('omits unset parameters entirely', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, okRoute()));
    const client = testClient(fetchImpl);
    await client.routes.get({ origin: [0, 0], destination: [1, 1] });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.search).toBe('');
  });
});

describe('RoutesService validation', () => {
  it('requires an origin and a destination', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.routes.get({ origin: [], destination: [1, 1] }),
    ).rejects.toMatchObject({ message: 'justrouting: Origin is required' });
    await expect(
      client.routes.get({ origin: [0, 0], destination: [] }),
    ).rejects.toMatchObject({ message: 'justrouting: Destination is required' });
  });

  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.routes.get(null as never)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('reports the index of an invalid waypoint within the flattened list', async () => {
    const client = testClient(mockFetch());
    // origin is index 0, the invalid waypoint is index 2.
    await expect(
      client.routes.get({
        origin: [0, 0],
        waypoints: [[0, 0], [1, 200]],
        destination: [1, 1],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('coordinate 2:') });
    await expect(
      client.routes.get({
        origin: [0, 0],
        waypoints: [[0, 0], [1, 200]],
        destination: [1, 1],
      }),
    ).rejects.toBeInstanceOf(InvalidCoordinatesError);
  });
});

describe('RoutesService responses', () => {
  it('decodes a full response, geometry included', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        code: 'Ok',
        routes: [
          {
            distance: 1100.5,
            duration: 300.25,
            weight: 300.25,
            weight_name: 'routability',
            geometry: { type: 'LineString', coordinates: [[103.8, 1.3], [103.9, 1.4]] },
            legs: [
              {
                distance: 1100.5,
                duration: 300.25,
                weight: 300.25,
                summary: 'Main Street',
                steps: [
                  {
                    distance: 500,
                    duration: 120,
                    weight: 120,
                    geometry: 'encoded',
                    name: 'Main Street',
                    ref: 'A1',
                    mode: 'driving',
                    maneuver: {
                      location: [103.8, 1.3],
                      bearing_before: 10,
                      bearing_after: 20,
                      type: 'depart',
                      modifier: 'right',
                      exit: 1,
                    },
                    intersections: [
                      {
                        location: [103.8, 1.3],
                        bearings: [10, 200],
                        entry: [true, false],
                        in: 0,
                        out: 1,
                        lanes: [{ indications: ['left'], valid: true }],
                      },
                    ],
                  },
                ],
                annotation: {
                  distance: [500],
                  duration: [120],
                  speed: [4.2],
                  nodes: [1, 2],
                  datasources: [0],
                },
              },
            ],
          },
        ],
        waypoints: [{ name: 'Start', location: [103.8, 1.3], distance: 1.2 }],
      }),
    );
    const client = testClient(fetchImpl);
    const resp = await client.routes.getAll({ origin: [103.8, 1.3], destination: [103.9, 1.4] });
    expect(resp.code).toBe('Ok');
    expect(resp.routes).toHaveLength(1);

    const route = resp.routes[0]!;
    expect(route.distance).toBe(1100.5);
    expect(route.duration).toBe(300.25);
    expect(route.weightName).toBe('routability');
    expect(route.geometry.geoJSON().coordinates).toEqual([[103.8, 1.3], [103.9, 1.4]]);

    const leg = route.legs[0]!;
    expect(leg.summary).toBe('Main Street');
    expect(leg.annotation?.speed).toEqual([4.2]);
    expect(leg.annotation?.nodes).toEqual([1, 2]);

    const step = leg.steps![0]!;
    expect(step.name).toBe('Main Street');
    expect(step.ref).toBe('A1');
    expect(step.geometry.polyline()).toBe('encoded');
    expect(step.maneuver.type).toBe('depart');
    expect(step.maneuver.modifier).toBe('right');
    expect(step.maneuver.exit).toBe(1);
    expect(step.intersections![0]!.lanes![0]!.indications).toEqual(['left']);
    expect(step.intersections![0]!.in).toBe(0);
    expect(step.intersections![0]!.out).toBe(1);

    expect(resp.waypoints[0]!.name).toBe('Start');
    expect(resp.waypoints[0]!.location).toEqual([103.8, 1.3]);
    expect(resp.waypoints[0]!.distance).toBe(1.2);
  });

  it('get() returns the best route only', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        code: 'Ok',
        routes: [
          { distance: 100, duration: 60, weight: 60, weight_name: 'routability', geometry: null, legs: [] },
          { distance: 200, duration: 120, weight: 120, weight_name: 'routability', geometry: null, legs: [] },
        ],
        waypoints: [],
      }),
    );
    const client = testClient(fetchImpl);
    const route = await client.routes.get({ origin: [0, 0], destination: [1, 1] });
    expect(route.distance).toBe(100);
  });

  it('get() throws NoRouteError when the engine found no route', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 'Ok', routes: [], waypoints: [] }));
    const client = testClient(fetchImpl);
    await expect(client.routes.get({ origin: [0, 0], destination: [1, 1] })).rejects.toBeInstanceOf(
      NoRouteError,
    );
  });

  it('surfaces an in-body engine failure on HTTP 200', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'NoRoute', message: 'no path between the points' }),
    );
    const client = testClient(fetchImpl);
    const err = await client.routes
      .get({ origin: [0, 0], destination: [1, 1] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect((err as { statusCode: number }).statusCode).toBe(200);
    expect((err as { body: string }).body).toContain('NoRoute');
  });
});
