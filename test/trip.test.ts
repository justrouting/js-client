import { describe, expect, it, vi } from 'vitest';

import { ApiError, Client, InvalidCoordinatesError, InvalidRequestError } from '../src/index.js';
import type { TripRequest } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
  });
}

// Mirrors a real trip response: the waypoints reordered into the fastest
// visiting order, and the round trip itself.
const tripFixture = {
  code: 'Ok',
  waypoints: [
    { hint: 'aaa', distance: 4.216, name: 'Marina Boulevard', location: [103.81982, 1.35211] },
    { hint: 'ccc', distance: 2.3, name: 'Sentosa Gateway', location: [103.8514, 1.2897] },
    { hint: 'bbb', distance: 8.104, name: 'Changi Coast Road', location: [103.99151, 1.36442] },
  ],
  trips: [
    {
      geometry: 'aa_ceeEnAqB',
      legs: [{ steps: [], summary: '', weight: 1900.0, duration: 1900.0, distance: 30100.0 }],
      weight_name: 'routability',
      weight: 1900.0,
      duration: 1900.0,
      distance: 30100.0,
    },
  ],
};

function simpleTrip(): TripRequest {
  return {
    coordinates: [
      [103.8198, 1.3521],
      [103.8514, 1.2897],
      [103.9915, 1.3644],
    ],
  };
}

describe('TripService request building', () => {
  it('uses the default profile and joins the coordinates', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, tripFixture));
    const client = testClient(fetchImpl);
    await client.trip.get(simpleTrip());
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(url).toBe(
      'https://api.example.test/trip/v1/driving/103.8198,1.3521;103.8514,1.2897;103.9915,1.3644',
    );
  });

  it('escapes a custom profile in the path', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, tripFixture));
    const client = testClient(fetchImpl);
    await client.trip.get({ coordinates: [[0, 0], [1, 1]], profile: 'motorcycle' });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.pathname).toBe('/trip/v1/motorcycle/0,0;1,1');
  });

  it('serializes every query parameter', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, tripFixture));
    const client = testClient(fetchImpl);
    await client.trip.get({
      coordinates: [[0, 0], [1, 1]],
      roundtrip: false,
      source: 'first',
      destination: 'last',
      steps: true,
      annotations: ['duration', 'distance'],
      geometries: 'geojson',
      overview: 'full',
      exclude: ['motorway', 'ferry'],
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('roundtrip')).toBe('false');
    expect(url.searchParams.get('source')).toBe('first');
    expect(url.searchParams.get('destination')).toBe('last');
    expect(url.searchParams.get('steps')).toBe('true');
    expect(url.searchParams.get('annotations')).toBe('duration,distance');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('overview')).toBe('full');
    expect(url.searchParams.get('exclude')).toBe('motorway,ferry');
  });

  it('omits unset parameters entirely', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, tripFixture));
    const client = testClient(fetchImpl);
    await client.trip.get(simpleTrip());
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.search).toBe('');
  });
});

describe('TripService validation', () => {
  it('requires at least two coordinates', async () => {
    const client = testClient(mockFetch());
    await expect(client.trip.get({ coordinates: [[103.8, 1.3]] })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.trip.get(null as never)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects the [lat, lon] mix-up locally', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.trip.get({ coordinates: [[1.3521, 103.8198], [1.3644, 103.9915]] }),
    ).rejects.toBeInstanceOf(InvalidCoordinatesError);
  });
});

describe('TripService responses', () => {
  it('decodes a full response', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, tripFixture));
    const client = testClient(fetchImpl);
    const trip = await client.trip.get(simpleTrip());
    expect(trip.distance).toBe(30100.0);
    expect(trip.duration).toBe(1900.0);
    expect(trip.legs).toHaveLength(1);
  });

  it('getAll() returns the waypoints in visiting order', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, tripFixture));
    const client = testClient(fetchImpl);
    const resp = await client.trip.getAll(simpleTrip());
    expect(resp.trips).toHaveLength(1);
    expect(resp.waypoints).toHaveLength(3);
    // The input order was Marina, Sentosa, Changi; the engine may visit
    // Sentosa second.
    expect(resp.waypoints[1]!.name).toBe('Sentosa Gateway');
  });

  it('get() throws NoTrip when the engine found no trip', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 'Ok', trips: [], waypoints: [] }));
    const client = testClient(fetchImpl);
    const err = await client.trip.get(simpleTrip()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { osrmCode: string }).osrmCode).toBe('NoTrip');
    expect((err as { statusCode: number }).statusCode).toBe(200);
  });

  it('surfaces an in-body engine failure on HTTP 200', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'NoTrip', message: 'no trip for the points' }),
    );
    const client = testClient(fetchImpl);
    const err = await client.trip.get(simpleTrip()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { statusCode: number }).statusCode).toBe(200);
    expect((err as { body: string }).body).toContain('NoTrip');
  });
});
