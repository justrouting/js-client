import { describe, expect, it, vi } from 'vitest';

import { Client, DEFAULT_BASE_URL } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

describe('Client construction', () => {
  it('defaults to the hosted endpoint', () => {
    const client = new Client('key');
    expect(client.baseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('keeps the configured base URL, trimmed', () => {
    const client = new Client('key', { baseUrl: ' http://localhost:8080/api/ ' });
    expect(client.baseUrl()).toBe('http://localhost:8080/api/');
  });

  it('trims the API key', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { status: 'ok', timestamp: 't', upstreams: {} }),
    );
    const client = new Client('  key  ', {
      baseUrl: 'https://api.example.test',
      fetch: fetchImpl,
      timeout: null,
    });
    await client.health.get();
    const init = vi.mocked(fetchImpl).mock.calls[0]![1];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
  });

  it('exposes the four services', () => {
    const client = new Client('key');
    expect(client.routes).toBeDefined();
    expect(client.matrix).toBeDefined();
    expect(client.optimization).toBeDefined();
    expect(client.health).toBeDefined();
  });

  it('throws TypeError for an empty baseUrl', () => {
    expect(() => new Client('key', { baseUrl: '' })).toThrow(TypeError);
    expect(() => new Client('key', { baseUrl: '   ' })).toThrow(TypeError);
  });

  it('throws TypeError for a non-absolute baseUrl', () => {
    expect(() => new Client('key', { baseUrl: 'not a url' })).toThrow(TypeError);
    expect(() => new Client('key', { baseUrl: 'localhost:8080' })).toThrow(TypeError);
  });

  it('throws TypeError for an empty userAgent', () => {
    expect(() => new Client('key', { userAgent: '' })).toThrow(TypeError);
  });

  it('throws TypeError for a negative maxRetries', () => {
    expect(() => new Client('key', { maxRetries: -1 })).toThrow(TypeError);
  });

  it('throws TypeError for a non-function backoff', () => {
    expect(() => new Client('key', { backoff: 'fast' as never })).toThrow(TypeError);
  });

  it('throws TypeError for a non-positive timeout, but allows null', () => {
    expect(() => new Client('key', { timeout: 0 })).toThrow(TypeError);
    expect(() => new Client('key', { timeout: -5 })).toThrow(TypeError);
    expect(() => new Client('key', { timeout: null })).not.toThrow();
  });

  it('throws TypeError for a non-function fetch', () => {
    expect(() => new Client('key', { fetch: 'fetch' as never })).toThrow(TypeError);
  });
});
