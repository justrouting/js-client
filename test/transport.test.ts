import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  Client,
  DecodeError,
  TransportError,
  UnauthorizedError,
  VERSION,
} from '../src/index.js';
import { defaultBackoff, parseRetryAfter } from '../src/transport.js';
import { hangingFetch, jsonResponse, mockFetch } from './helpers.js';

function testClient(
  apiKey: string,
  fetchImpl: typeof fetch,
  overrides: ConstructorParameters<typeof Client>[1] = {},
): Client {
  return new Client(apiKey, {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    backoff: () => 0,
    timeout: null,
    ...overrides,
  });
}

const healthyBody = { status: 'ok', timestamp: '2026-08-29T00:00:00Z', upstreams: { osrm: true } };

describe('retries', () => {
  it('retries 5xx responses and succeeds', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(500, { error: 'boom' }),
      jsonResponse(503, { error: 'boom' }),
      jsonResponse(200, healthyBody),
    );
    const client = testClient('key', fetchImpl);
    const health = await client.health.get();
    expect(health.ok()).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(3);
  });

  it('exhausts the retry budget and surfaces the last error', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(500, { error: 'boom' }),
      jsonResponse(500, { error: 'boom' }),
      jsonResponse(500, { error: 'boom' }),
    );
    const client = testClient('key', fetchImpl, { maxRetries: 2 });
    await expect(client.health.get()).rejects.toMatchObject({ statusCode: 500 });
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(3);
  });

  it('honours maxRetries: 0', async () => {
    const fetchImpl = mockFetch(jsonResponse(500, { error: 'boom' }));
    const client = testClient('key', fetchImpl, { maxRetries: 0 });
    await expect(client.health.get()).rejects.toBeInstanceOf(ApiError);
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(1);
  });

  it('returns other 4xx responses immediately', async () => {
    const fetchImpl = mockFetch(jsonResponse(400, { error: 'bad request' }));
    const client = testClient('key', fetchImpl);
    await expect(client.health.get()).rejects.toMatchObject({ statusCode: 400 });
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(1);
  });

  it('prefers a Retry-After header over the backoff function', async () => {
    const backoff = vi.fn(() => 999);
    const fetchImpl = mockFetch(
      jsonResponse(429, { error: 'slow down' }, { 'Retry-After': '0' }),
      jsonResponse(200, healthyBody),
    );
    const client = testClient('key', fetchImpl, { backoff: backoff as never });
    await client.health.get();
    expect(backoff).not.toHaveBeenCalled();
  });

  it('uses the backoff function when Retry-After is absent', async () => {
    const backoff = vi.fn(() => 0);
    const fetchImpl = mockFetch(
      jsonResponse(500, { error: 'boom' }),
      jsonResponse(200, healthyBody),
    );
    const client = testClient('key', fetchImpl, { backoff: backoff as never });
    await client.health.get();
    expect(backoff).toHaveBeenCalledWith(1);
  });

  it('stops retrying when the call deadline expires during the backoff wait', async () => {
    const fetchImpl = mockFetch(jsonResponse(500, { error: 'boom' }));
    const client = testClient('key', fetchImpl, { backoff: () => 10 });
    const err = await client.health.get({ timeout: 0.05 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(1);
  });
});

describe('transport errors', () => {
  it('fails when the network rejects, and retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, healthyBody));
    const client = testClient('key', fetchImpl as unknown as typeof fetch, { maxRetries: 1 });
    const health = await client.health.get();
    expect(health.ok()).toBe(true);
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it('surfaces the last transport error once the budget is spent', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = testClient('key', fetchImpl as unknown as typeof fetch, { maxRetries: 1 });
    await expect(client.health.get()).rejects.toBeInstanceOf(TransportError);
  });

  it('throws a TimeoutError when the per-call deadline expires mid-request', async () => {
    const client = testClient('key', hangingFetch());
    const err = await client.health.get({ timeout: 0.05 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
  });

  it('treats a per-attempt timeout as transient and retries', async () => {
    const client = testClient('key', hangingFetch(), { timeout: 0.05, maxRetries: 1 });
    await expect(client.health.get({ timeout: 1 })).rejects.toBeInstanceOf(TransportError);
  });

  it('propagates a user abort unchanged', async () => {
    const client = testClient('key', hangingFetch());
    const controller = new AbortController();
    const promise = client.health.get({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('throws DecodeError on an unparsable 2xx body', async () => {
    const fetchImpl = mockFetch(new Response('not json', { status: 200 }));
    const client = testClient('key', fetchImpl);
    await expect(client.health.get()).rejects.toBeInstanceOf(DecodeError);
  });
});

describe('request headers', () => {
  it('sends the auth, Accept and User-Agent headers', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, healthyBody));
    const client = testClient('key', fetchImpl);
    await client.health.get();
    const init = vi.mocked(fetchImpl).mock.calls[0]![1];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    expect(new Headers(init?.headers).get('User-Agent')).toBe(`justrouting-js/${VERSION}`);
  });

  it('omits the Authorization header without an API key', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, healthyBody));
    const client = testClient('', fetchImpl);
    await client.health.get();
    const init = vi.mocked(fetchImpl).mock.calls[0]![1];
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
  });

  it('sets Content-Type only on requests with a body', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, healthyBody),
      jsonResponse(200, { code: 0, summary: {}, routes: [], unassigned: [] }),
    );
    const client = testClient('key', fetchImpl);
    await client.health.get();
    await client.optimization.solve({
      vehicles: [{ id: 1, start: [103.8198, 1.3521] }],
      jobs: [{ id: 1, location: [103.9915, 1.3644] }],
    });
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(new Headers(calls[0]![1]?.headers).get('Content-Type')).toBeNull();
    expect(new Headers(calls[1]![1]?.headers).get('Content-Type')).toBe('application/json');
  });
});

describe('endpoint building', () => {
  it('preserves a path prefix on the base URL', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, healthyBody));
    const client = new Client('key', {
      baseUrl: 'https://api.example.test/v1/',
      fetch: fetchImpl,
      timeout: null,
    });
    await client.health.get();
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('https://api.example.test/v1/health');
  });

  it('keeps coordinate separators unescaped in the path', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { code: 'Ok', routes: [], waypoints: [] }));
    const client = testClient('key', fetchImpl);
    await client.routes.getAll({
      origin: [103.8198, 1.3521],
      destination: [103.9915, 1.3644],
    });
    const url = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(url).toBe(
      'https://api.example.test/route/v1/driving/103.8198,1.3521;103.9915,1.3644',
    );
  });
});

describe('missing API key', () => {
  it('fails needsAuth calls before any request is sent', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, healthyBody));
    const client = testClient('', fetchImpl);
    const err = await client.routes
      .get({ origin: [0, 0], destination: [1, 1] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as ApiError).statusCode).toBe(401);
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(0);
  });
});

describe('parseRetryAfter', () => {
  it('understands a delay in seconds', () => {
    expect(parseRetryAfter('5')).toEqual([5, true]);
    expect(parseRetryAfter(' 7 ')).toEqual([7, true]);
  });

  it('rejects negative or non-numeric values', () => {
    expect(parseRetryAfter('-5')).toEqual([0, false]);
    expect(parseRetryAfter('abc')).toEqual([0, false]);
    expect(parseRetryAfter('')).toEqual([0, false]);
  });

  it('understands an HTTP date', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const [delay, ok] = parseRetryAfter(future);
    expect(ok).toBe(true);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5);
  });

  it('treats a past date as "retry now"', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toEqual([0, true]);
  });
});

describe('defaultBackoff', () => {
  it('grows exponentially from 500ms and caps at 8s, with jitter in [d/2, d]', () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      const d = Math.min(8, 0.5 * 2 ** (attempt - 1));
      const got = defaultBackoff(attempt);
      expect(got).toBeGreaterThanOrEqual(d / 2);
      expect(got).toBeLessThanOrEqual(d);
    }
    // Deep attempts stay at the cap.
    const got = defaultBackoff(100);
    expect(got).toBeGreaterThanOrEqual(4);
    expect(got).toBeLessThanOrEqual(8);
  });
});
