/**
 * Integration tests against the live JustRouting API.
 *
 * Skipped unless JUSTROUTING_API_KEY is set, so the default suite stays
 * fully offline:
 *
 *     JUSTROUTING_API_KEY=<key> npx vitest run test/integration.test.ts
 */

import { describe, expect, it } from 'vitest';

import { Client } from '../src/index.js';

const apiKey = process.env.JUSTROUTING_API_KEY ?? '';

const describeLive = apiKey ? describe : describe.skip;

describeLive('integration', () => {
  const baseUrl = process.env.JUSTROUTING_BASE_URL;

  it('reports the API as healthy', async () => {
    const client = new Client(apiKey, baseUrl ? { baseUrl } : undefined);
    const health = await client.health.get();
    expect(health.ok()).toBe(true);
  });

  it('routes between two Singapore points', async () => {
    const client = new Client(apiKey, baseUrl ? { baseUrl } : undefined);
    const route = await client.routes.get({
      origin: [103.8198, 1.3521], // Marina Bay
      destination: [103.9915, 1.3644], // Changi Airport
    });
    expect(route.distance).toBeGreaterThan(0);
    expect(route.duration).toBeGreaterThan(0);
  });
});
