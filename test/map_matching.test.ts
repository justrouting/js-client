import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  Client,
  InvalidCoordinatesError,
  InvalidRequestError,
} from '../src/index.js';
import type { MapMatchingRequest } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
  });
}

// Mirrors a real matching response: a null tracepoint for a coordinate that
// could not be matched, and one matching with confidence.
const matchFixture = {
  code: 'Ok',
  tracepoints: [
    {
      alternatives_count: 2,
      waypoint_index: 0,
      matchings_index: 0,
      name: 'Marina Boulevard',
      hint: 'aaa',
      distance: 4.216,
      location: [103.81982, 1.35211],
    },
    null,
    {
      alternatives_count: 0,
      waypoint_index: 1,
      matchings_index: 0,
      name: 'Changi Coast Road',
      hint: 'bbb',
      distance: 8.104,
      location: [103.99151, 1.36442],
    },
  ],
  matchings: [
    {
      confidence: 0.95,
      geometry: 'aa_ceeEnAqB',
      legs: [
        { steps: [], summary: 'East Coast Parkway', weight: 1583.4, duration: 1583.4, distance: 24512.7 },
      ],
      weight_name: 'routability',
      weight: 1583.4,
      duration: 1583.4,
      distance: 24512.7,
    },
  ],
};

function simpleMatch(): MapMatchingRequest {
  return {
    coordinates: [
      [103.8198, 1.3521],
      [103.8514, 1.2897],
      [103.9915, 1.3644],
    ],
    timestamps: [1720000000, 1720000060, 1720000120],
  };
}

describe('MapMatchingService request building', () => {
  it('uses the default profile and joins the trace in order', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, matchFixture));
    const client = testClient(fetchImpl);
    await client.mapMatching.get(simpleMatch());
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(url).toBe(
      'https://api.example.test/match/v1/driving/103.8198,1.3521;103.8514,1.2897;103.9915,1.3644?timestamps=1720000000%3B1720000060%3B1720000120',
    );
  });

  it('escapes a custom profile in the path', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, matchFixture));
    const client = testClient(fetchImpl);
    await client.mapMatching.get({
      coordinates: [[0, 0], [1, 1]],
      timestamps: [1720000000, 1720000060],
      profile: 'motorcycle',
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.pathname).toBe('/match/v1/motorcycle/0,0;1,1');
  });

  it('serializes every query parameter', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, matchFixture));
    const client = testClient(fetchImpl);
    await client.mapMatching.get({
      coordinates: [[0, 0], [1, 1], [2, 2]],
      timestamps: [1720000000, 1720000060, 1720000120],
      radiuses: [10, 15, 25],
      gaps: 'ignore',
      tidy: true,
      waypoints: [0, 2],
      snapping: 'any',
      steps: true,
      annotations: ['duration', 'distance'],
      geometries: 'geojson',
      overview: 'full',
      exclude: ['motorway', 'ferry'],
      bearings: ['0,20', '90', ''],
      hints: ['abcDEF==', 'ghiJKL==', 'mnoPQR=='],
      approaches: ['curb', 'opposite', ''],
      generateHints: false,
      skipWaypoints: true,
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('timestamps')).toBe('1720000000;1720000060;1720000120');
    expect(url.searchParams.get('radiuses')).toBe('10;15;25');
    expect(url.searchParams.get('gaps')).toBe('ignore');
    expect(url.searchParams.get('tidy')).toBe('true');
    expect(url.searchParams.get('waypoints')).toBe('0;2');
    expect(url.searchParams.get('snapping')).toBe('any');
    expect(url.searchParams.get('steps')).toBe('true');
    expect(url.searchParams.get('annotations')).toBe('duration,distance');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('overview')).toBe('full');
    expect(url.searchParams.get('exclude')).toBe('motorway,ferry');
    expect(url.searchParams.get('bearings')).toBe('0,20;90;');
    expect(url.searchParams.get('hints')).toBe('abcDEF==;ghiJKL==;mnoPQR==');
    expect(url.searchParams.get('approaches')).toBe('curb;opposite;');
    expect(url.searchParams.get('generate_hints')).toBe('false');
    expect(url.searchParams.get('skip_waypoints')).toBe('true');
  });

  it('omits unset parameters except the required timestamps', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, matchFixture));
    const client = testClient(fetchImpl);
    await client.mapMatching.get(simpleMatch());
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('timestamps')).toBe('1720000000;1720000060;1720000120');
    for (const key of [
      'radiuses', 'gaps', 'tidy', 'waypoints', 'snapping', 'steps',
      'geometries', 'overview', 'annotations', 'bearings', 'hints',
      'approaches', 'generate_hints', 'skip_waypoints',
    ]) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });
});

describe('MapMatchingService validation', () => {
  it('requires at least two coordinates', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({ coordinates: [[103.8, 1.3]] }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.mapMatching.get(null as never)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects a missing timestamps list', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({ coordinates: [[0, 0], [1, 1]] }),
    ).rejects.toMatchObject({
      message: 'justrouting: Timestamps is required for map matching',
    });
  });

  it('rejects a timestamp count mismatch', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({ coordinates: [[0, 0], [1, 1]], timestamps: [1720000000] }),
    ).rejects.toMatchObject({
      message: 'justrouting: Timestamps has 1 values for 2 coordinates',
    });
  });

  it('rejects radiuses that do not cover every coordinate', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({
        coordinates: [[0, 0], [1, 1]],
        timestamps: [1720000000, 1720000060],
        radiuses: [10],
      }),
    ).rejects.toMatchObject({
      message: 'justrouting: Radiuses needs one value per coordinate, got 1 for 2 coordinates',
    });
  });

  it('rejects a negative radius', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({
        coordinates: [[0, 0], [1, 1]],
        timestamps: [1720000000, 1720000060],
        radiuses: [-5, -5],
      }),
    ).rejects.toMatchObject({ message: 'justrouting: Radiuses[0] must not be negative, got -5' });
  });

  it('rejects a waypoint index outside the coordinate slice', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({
        coordinates: [[0, 0], [1, 1]],
        timestamps: [1720000000, 1720000060],
        waypoints: [0, 5],
      }),
    ).rejects.toMatchObject({
      message: 'justrouting: Waypoints[1] = 5 is out of range for 2 coordinates',
    });
  });

  it('rejects the [lat, lon] mix-up locally', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.mapMatching.get({
        coordinates: [[1.3521, 103.8198], [1.3644, 103.9915]],
        timestamps: [1720000000, 1720000060],
      }),
    ).rejects.toBeInstanceOf(InvalidCoordinatesError);
  });
});

describe('MapMatchingService responses', () => {
  it('decodes a full response, confidence included', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, matchFixture));
    const client = testClient(fetchImpl);
    const match = await client.mapMatching.get(simpleMatch());
    expect(match.confidence).toBe(0.95);
    expect(match.distance).toBe(24512.7);
    expect(match.duration).toBe(1583.4);
    expect(match.legs).toHaveLength(1);
    expect(match.legs[0]!.summary).toBe('East Coast Parkway');
  });

  it('getAll() preserves null tracepoints for unmatched coordinates', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, matchFixture));
    const client = testClient(fetchImpl);
    const resp = await client.mapMatching.getAll(simpleMatch());
    expect(resp.matchings).toHaveLength(1);
    expect(resp.tracepoints).toHaveLength(3);
    expect(resp.tracepoints[1]).toBeNull();
    expect(resp.tracepoints[0]!.alternativesCount).toBe(2);
    expect(resp.tracepoints[0]!.waypointIndex).toBe(0);
    expect(resp.tracepoints[2]!.matchingsIndex).toBe(0);
    expect(resp.tracepoints[2]!.name).toBe('Changi Coast Road');
  });

  it('get() throws NoMatch when the engine produced no matching', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 'Ok', tracepoints: [], matchings: [] }));
    const client = testClient(fetchImpl);
    const err = await client.mapMatching.get(simpleMatch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { osrmCode: string }).osrmCode).toBe('NoMatch');
    expect((err as { statusCode: number }).statusCode).toBe(200);
  });

  it('surfaces an in-body engine failure on HTTP 200', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'NoMatch', message: 'no matching for the trace' }),
    );
    const client = testClient(fetchImpl);
    const err = await client.mapMatching.get(simpleMatch()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { statusCode: number }).statusCode).toBe(200);
    expect((err as { body: string }).body).toContain('NoMatch');
  });
});
