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

  it('finds the road segment nearest to a point', async () => {
    const client = new Client(apiKey, baseUrl ? { baseUrl } : undefined);
    const wp = await client.nearest.get({ coordinate: [103.8198, 1.3521] });
    expect(wp.location[0]).toBeGreaterThan(100);
    expect(wp.location[1]).toBeGreaterThan(0);
  });

  it('matches a GPS trace along the East Coast Parkway', async () => {
    const client = new Client(apiKey, baseUrl ? { baseUrl } : undefined);
    // A trace from Marina Bay towards Changi. Map matching needs points
    // that follow a drivable path, not arbitrary far-apart coordinates.
    const match = await client.mapMatching.get({
      coordinates: [
        [103.823679, 1.355111],
        [103.831810, 1.355074],
        [103.839222, 1.346059],
        [103.856595, 1.343471],
        [103.864702, 1.329605],
        [103.887874, 1.322419],
        [103.928786, 1.335564],
        [103.962769, 1.350345],
        [103.983033, 1.344782],
        [103.990312, 1.361474],
      ],
      timestamps: [
        1720000000, 1720000180, 1720000360, 1720000540, 1720000720,
        1720000900, 1720001080, 1720001260, 1720001440, 1720001620,
      ],
    });
    expect(match.confidence).toBeGreaterThan(0);
    expect(match.confidence).toBeLessThanOrEqual(1);
    expect(match.distance).toBeGreaterThan(0);
  });

  it('finds the fastest trip through three Singapore points', async () => {
    const client = new Client(apiKey, baseUrl ? { baseUrl } : undefined);
    const resp = await client.trip.getAll({
      coordinates: [
        [103.8198, 1.3521], // Marina Bay
        [103.8514, 1.2897], // Sentosa
        [103.9915, 1.3644], // Changi
      ],
    });
    expect(resp.trips.length).toBeGreaterThan(0);
    expect(resp.trips[0]!.distance).toBeGreaterThan(0);
    expect(resp.waypoints).toHaveLength(3);
  });

  it('geocodes an address', async () => {
    const client = new Client(apiKey, baseUrl ? { baseUrl } : undefined);
    const resp = await client.geocode.search({
      text: 'Marina Bay Sands, Singapore',
      limit: 3,
    });
    expect(resp.results.length).toBeGreaterThan(0);
    const top = resp.results[0]!;
    expect(top.formatted).not.toBe('');
    expect(top.lon).toBeGreaterThan(100);
    expect(top.lat).toBeGreaterThan(0);
  });
});
