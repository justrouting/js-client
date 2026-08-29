/**
 * Shared helpers: a mock fetch that serves canned responses, so the suite
 * runs entirely offline — the equivalent of Go's httptest servers.
 */

import { vi } from 'vitest';

/** A canned response, or a handler inspecting the request. */
export type Canned = Response | ((input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>);

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * mockFetch returns a fetch-compatible function that consumes `responses`
 * in order. Once the queue is exhausted it serves a 500, so a test that
 * under-queues fails loudly.
 */
export function mockFetch(...responses: Canned[]): typeof fetch {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const next = responses.shift();
    if (next === undefined) {
      return jsonResponse(500, { error: 'no response queued' });
    }
    return typeof next === 'function' ? await next(input, init) : next;
  });
  return fn as unknown as typeof fetch;
}

/**
 * hangingFetch returns a fetch that never settles unless the request's
 * signal aborts — for deadline and cancellation tests.
 */
export function hangingFetch(): typeof fetch {
  const fn = vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  return fn as unknown as typeof fetch;
}

/** The URL of the latest fetch call, or null when none was made. */
export function lastUrl(fetchMock: ReturnType<typeof vi.fn>): URL | null {
  const last = fetchMock.mock.lastCall;
  return last ? new URL(String(last[0])) : null;
}
