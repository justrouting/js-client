import { describe, expect, it, vi } from 'vitest';

import { ApiError, Client, InvalidCoordinatesError, InvalidRequestError } from '../src/index.js';
import type { NearestRequest } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
  });
}

// Mirrors a real nearest response with two candidates, including the OSM
// node IDs of the closest segment.
const nearestFixture = {
  code: 'Ok',
  waypoints: [
    { hint: 'aaa', distance: 4.216, name: 'Marina Boulevard', location: [103.81982, 1.35211], nodes: [1234, 5678] },
    { hint: 'bbb', distance: 21.7, name: 'Bayfront Avenue', location: [103.82001, 1.35237], nodes: [4321] },
  ],
};

function simpleNearest(): NearestRequest {
  return { coordinate: [103.8198, 1.3521] };
}

describe('NearestService request building', () => {
  it('uses the default profile and a single coordinate', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, nearestFixture));
    const client = testClient(fetchImpl);
    await client.nearest.get(simpleNearest());
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(url).toBe('https://api.example.test/nearest/v1/driving/103.8198,1.3521');
  });

  it('escapes a custom profile in the path', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, nearestFixture));
    const client = testClient(fetchImpl);
    await client.nearest.get({ coordinate: [0, 0], profile: 'cycling' });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.pathname).toBe('/nearest/v1/cycling/0,0');
  });

  it('serializes number and exclude', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, nearestFixture));
    const client = testClient(fetchImpl);
    await client.nearest.get({ coordinate: [0, 0], number: 3, exclude: ['motorway', 'ferry'] });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('number')).toBe('3');
    expect(url.searchParams.get('exclude')).toBe('motorway,ferry');
  });

  it('omits unset parameters entirely', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, nearestFixture));
    const client = testClient(fetchImpl);
    await client.nearest.get(simpleNearest());
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.search).toBe('');
  });
});

describe('NearestService validation', () => {
  it('requires a coordinate', async () => {
    const client = testClient(mockFetch());
    await expect(client.nearest.get({ coordinate: [] })).rejects.toMatchObject({
      message: 'justrouting: Coordinate is required',
    });
  });

  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.nearest.get(null as never)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects a negative number', async () => {
    const client = testClient(mockFetch());
    await expect(client.nearest.get({ coordinate: [0, 0], number: -1 })).rejects.toMatchObject({
      message: 'justrouting: Number must not be negative, got -1',
    });
  });

  it('rejects the [lat, lon] mix-up locally', async () => {
    const client = testClient(mockFetch());
    await expect(client.nearest.get({ coordinate: [1.3521, 103.8198] })).rejects.toBeInstanceOf(
      InvalidCoordinatesError,
    );
  });
});

describe('NearestService responses', () => {
  it('decodes a full response, nodes included', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, nearestFixture));
    const client = testClient(fetchImpl);
    const wp = await client.nearest.get(simpleNearest());
    expect(wp.name).toBe('Marina Boulevard');
    expect(wp.distance).toBe(4.216);
    expect(wp.location).toEqual([103.81982, 1.35211]);
    expect(wp.nodes).toEqual([1234, 5678]);
  });

  it('getAll() returns every candidate, best first', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, nearestFixture));
    const client = testClient(fetchImpl);
    const resp = await client.nearest.getAll(simpleNearest());
    expect(resp.waypoints).toHaveLength(2);
    expect(resp.waypoints[0]!.distance).toBeLessThan(resp.waypoints[1]!.distance);
  });

  it('get() throws NoSegment when nothing is near the coordinate', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 'Ok', waypoints: [] }));
    const client = testClient(fetchImpl);
    const err = await client.nearest.get(simpleNearest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { osrmCode: string }).osrmCode).toBe('NoSegment');
    expect((err as { statusCode: number }).statusCode).toBe(200);
  });

  it('surfaces an in-body engine failure on HTTP 200', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'NoSegment', message: 'nothing near the point' }),
    );
    const client = testClient(fetchImpl);
    const err = await client.nearest.get(simpleNearest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { statusCode: number }).statusCode).toBe(200);
    expect((err as { body: string }).body).toContain('NoSegment');
  });
});
