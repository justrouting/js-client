import { describe, expect, it, vi } from 'vitest';

import { Client, InvalidRequestError, MatrixResponse } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
  });
}

const points = [
  [103.8198, 1.3521],
  [103.8514, 1.2897],
  [103.9915, 1.3644],
];

describe('MatrixService request building', () => {
  it('computes a full NxN matrix by default', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'Ok', durations: [], distances: [], sources: [], destinations: [] }),
    );
    const client = testClient(fetchImpl);
    await client.matrix.get({ coordinates: points });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.pathname).toBe(
      '/table/v1/driving/103.8198,1.3521;103.8514,1.2897;103.9915,1.3644',
    );
    expect(url.searchParams.get('annotations')).toBe('duration,distance');
    expect(url.searchParams.has('sources')).toBe(false);
    expect(url.searchParams.has('destinations')).toBe(false);
  });

  it('computes a rectangular subset for sources and destinations', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'Ok', durations: [], distances: [], sources: [], destinations: [] }),
    );
    const client = testClient(fetchImpl);
    await client.matrix.get({
      coordinates: points,
      sources: [0],
      destinations: [1, 2],
      annotations: ['duration'],
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('sources')).toBe('0');
    expect(url.searchParams.get('destinations')).toBe('1;2');
    expect(url.searchParams.get('annotations')).toBe('duration');
  });
});

describe('MatrixService validation', () => {
  it('needs at least two coordinates', async () => {
    const client = testClient(mockFetch());
    await expect(client.matrix.get({ coordinates: [] })).rejects.toMatchObject({
      message: 'justrouting: Coordinates needs at least 2 points, got 0',
    });
    await expect(client.matrix.get({ coordinates: [[0, 0]] })).rejects.toMatchObject({
      message: 'justrouting: Coordinates needs at least 2 points, got 1',
    });
  });

  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.matrix.get(null as never)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects out-of-range indices before a request is spent', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.matrix.get({ coordinates: points, sources: [3] }),
    ).rejects.toMatchObject({
      message: 'justrouting: Sources[0] = 3 is out of range for 3 coordinates',
    });
    await expect(
      client.matrix.get({ coordinates: points, destinations: [0, -1] }),
    ).rejects.toMatchObject({
      message: 'justrouting: Destinations[1] = -1 is out of range for 3 coordinates',
    });
  });
});

describe('MatrixService responses', () => {
  it('keeps unreachable pairs distinct from zeros', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        code: 'Ok',
        durations: [[0, 60.5, null]],
        distances: [[0, 4234.1, null]],
        sources: [{ name: 'Depot', location: [103.8198, 1.3521], distance: 0 }],
        destinations: [
          { name: '', location: [103.8198, 1.3521], distance: 0 },
          { name: 'A', location: [103.8514, 1.2897], distance: 2 },
          { name: 'B', location: [103.9915, 1.3644], distance: 9 },
        ],
      }),
    );
    const client = testClient(fetchImpl);
    const m = await client.matrix.get({ coordinates: points, sources: [0] });
    expect(m).toBeInstanceOf(MatrixResponse);
    expect(m.durations).toEqual([[0, 60.5, null]]);
    expect(m.duration(0, 1)).toBe(60.5);
    expect(m.duration(0, 2)).toBeNull();
    expect(m.duration(0, 0)).toBe(0);
    expect(m.distance(0, 2)).toBeNull();
    expect(m.distance(0, 1)).toBe(4234.1);
    expect(m.sources[0]!.name).toBe('Depot');
    expect(m.destinations[2]!.location).toEqual([103.9915, 1.3644]);
  });

  it('returns null from the accessors for out-of-range indices', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'Ok', durations: [[0, 1]], distances: [[0, 1]] }),
    );
    const client = testClient(fetchImpl);
    const m = await client.matrix.get({ coordinates: points, sources: [0], destinations: [1] });
    expect(m.duration(-1, 0)).toBeNull();
    expect(m.duration(0, -1)).toBeNull();
    expect(m.duration(1, 0)).toBeNull();
    expect(m.duration(0, 5)).toBeNull();
    expect(m.distance(1, 0)).toBeNull();
  });

  it('surfaces an in-body engine failure on HTTP 200', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { code: 'InvalidValue', message: 'cannot parse coordinates' }),
    );
    const client = testClient(fetchImpl);
    await expect(client.matrix.get({ coordinates: points })).rejects.toMatchObject({
      statusCode: 200,
      osrmCode: 'InvalidValue',
    });
  });
});
