import { describe, expect, it, vi } from 'vitest';

import {
  Client,
  GeocodeResult,
  InvalidRequestError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../src/index.js';
import type { GeocodeRequest } from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

function testClient(fetchImpl: typeof fetch): Client {
  return new Client('key', {
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    // The error-passthrough tests queue one response per call, so retries
    // would consume the mock queue — like WithMaxRetries(0) in Go.
    maxRetries: 0,
    backoff: () => 0,
    timeout: null,
  });
}

// Mirrors a real geocoding response, nested fields included.
const geocodeFixture = {
  results: [
    {
      datasource: {
        sourcename: 'openstreetmap',
        attribution: '© OpenStreetMap contributors',
        license: 'Open Database License',
        url: 'https://www.openstreetmap.org/copyright',
      },
      name: 'Marina Bay Sands',
      housenumber: '10',
      street: 'Bayfront Avenue',
      district: 'Central Region',
      city: 'Singapore',
      county: 'Singapore',
      state: 'Singapore',
      postcode: '018956',
      country: 'Singapore',
      country_code: 'sg',
      lon: 103.859,
      lat: 1.2834,
      formatted: 'Marina Bay Sands, 10 Bayfront Avenue, 018956, Singapore',
      address_line1: 'Marina Bay Sands',
      address_line2: '10 Bayfront Avenue, 018956, Singapore',
      result_type: 'building',
      rank: {
        importance: 0.4,
        popularity: 4.0,
        confidence: 1,
        confidence_city_level: 1,
        confidence_street_level: 1,
        match_type: 'full_match',
      },
      timezone: {
        name: 'Asia/Singapore',
        offset_STD: '+08:00',
        offset_STD_seconds: 28800,
        offset_DST: '+08:00',
        offset_DST_seconds: 28800,
        abbreviation_STD: '+08',
        abbreviation_DST: '+08',
      },
      place_id: '51667b3e1416f7594059aad55757058af43ff00103f9018322790001000000c0',
      category: 'tourism.hotel',
      plus_code: '7VH8V75X+9X',
      bbox: { lon1: 103.8574, lat1: 1.2822, lon2: 103.8605, lat2: 1.2846 },
      distance: 1234,
    },
  ],
  query: {
    text: 'Marina Bay Sands, Singapore',
    parsed: { city: 'singapore', country: 'singapore', expected_type: 'building' },
  },
};

describe('GeocodeService request building', () => {
  it('sends a text query with the format pinned to json', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { results: [] }));
    const client = testClient(fetchImpl);
    await client.geocode.search({ text: 'Orchard Road' });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.pathname).toBe('/geocode/v1/search');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('text')).toBe('Orchard Road');
  });

  it('sends the structured fields that are set', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { results: [] }));
    const client = testClient(fetchImpl);
    await client.geocode.search({
      structured: {
        name: 'Marina Bay Sands',
        housenumber: '10',
        street: 'Bayfront Avenue',
        postcode: '018956',
        city: 'Singapore',
        state: 'Singapore',
        country: 'Singapore',
      },
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('name')).toBe('Marina Bay Sands');
    expect(url.searchParams.get('housenumber')).toBe('10');
    expect(url.searchParams.get('street')).toBe('Bayfront Avenue');
    expect(url.searchParams.get('postcode')).toBe('018956');
    expect(url.searchParams.get('city')).toBe('Singapore');
    expect(url.searchParams.get('state')).toBe('Singapore');
    expect(url.searchParams.get('country')).toBe('Singapore');
    expect(url.searchParams.has('text')).toBe(false);
  });

  it('serializes every option, repeating filter parameters', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { results: [] }));
    const client = testClient(fetchImpl);
    await client.geocode.search({
      text: 'Orchard Road',
      limit: 5,
      offset: 10,
      filters: ['countrycode:sg', 'city:singapore'],
      bias: 'proximity:103.8,1.3',
      type: 'street',
      lang: 'en',
    });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('offset')).toBe('10');
    expect(url.searchParams.getAll('filter')).toEqual(['countrycode:sg', 'city:singapore']);
    expect(url.searchParams.get('bias')).toBe('proximity:103.8,1.3');
    expect(url.searchParams.get('type')).toBe('street');
    expect(url.searchParams.get('lang')).toBe('en');
  });

  it('omits zero values and empty filters', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { results: [] }));
    const client = testClient(fetchImpl);
    await client.geocode.search({ text: 'Orchard Road', filters: [''] });
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0]));
    for (const key of ['limit', 'offset', 'filter', 'bias', 'type', 'lang']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });
});

describe('GeocodeService validation', () => {
  it('rejects a null request', async () => {
    const client = testClient(mockFetch());
    await expect(client.geocode.search(null as never)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects text combined with structured fields', async () => {
    const client = testClient(mockFetch());
    await expect(
      client.geocode.search({ text: 'x', structured: { city: 'Singapore' } }),
    ).rejects.toMatchObject({ message: 'justrouting: Text and Structured are mutually exclusive' });
  });

  it('rejects a request with neither input', async () => {
    const client = testClient(mockFetch());
    await expect(client.geocode.search({})).rejects.toMatchObject({
      message: 'justrouting: exactly one of Text or Structured is required',
    });
  });

  it('rejects an empty structured query', async () => {
    const client = testClient(mockFetch());
    await expect(client.geocode.search({ structured: {} })).rejects.toMatchObject({
      message: 'justrouting: exactly one of Text or Structured is required',
    });
  });

  it('rejects a negative limit and offset', async () => {
    const client = testClient(mockFetch());
    await expect(client.geocode.search({ text: 'x', limit: -1 })).rejects.toMatchObject({
      message: 'justrouting: Limit must not be negative, got -1',
    });
    await expect(client.geocode.search({ text: 'x', offset: -1 })).rejects.toMatchObject({
      message: 'justrouting: Offset must not be negative, got -1',
    });
  });
});

describe('GeocodeService responses', () => {
  it('decodes a full response, nested fields included', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, geocodeFixture));
    const client = testClient(fetchImpl);
    const resp = await client.geocode.search({ text: 'Marina Bay Sands' });
    expect(resp.results).toHaveLength(1);

    const r = resp.results[0]!;
    expect(r).toBeInstanceOf(GeocodeResult);
    expect(r.formatted).toBe('Marina Bay Sands, 10 Bayfront Avenue, 018956, Singapore');
    expect(r.street).toBe('Bayfront Avenue');
    expect(r.district).toBe('Central Region');
    expect(r.countryCode).toBe('sg');
    expect(r.lon).toBe(103.859);
    expect(r.lat).toBe(1.2834);
    expect(r.rank?.confidence).toBe(1);
    expect(r.timezone?.name).toBe('Asia/Singapore');
    expect(r.placeId).toBe('51667b3e1416f7594059aad55757058af43ff00103f9018322790001000000c0');
    expect(r.plusCode).toBe('7VH8V75X+9X');
    expect(r.bbox?.lon2).toBe(103.8605);
    expect(r.distance).toBe(1234);
    expect(r.location()).toEqual([103.859, 1.2834]);

    expect(resp.query?.text).toBe('Marina Bay Sands, Singapore');
    expect(resp.query?.parsed).toEqual({ city: 'singapore', country: 'singapore', expected_type: 'building' });
  });

  it('treats an empty result list as a valid answer', async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { results: [] }));
    const client = testClient(fetchImpl);
    const resp = await client.geocode.search({ text: 'nowhere' });
    expect(resp.results).toEqual([]);
    expect(resp.query).toBeUndefined();
  });
});

describe('GeocodeService error passthrough', () => {
  it('classifies the upstream unauthorized shape, message preferred', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid apiKey' }),
    );
    const client = testClient(fetchImpl);
    const err = await client.geocode.search({ text: 'Singapore' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as { statusCode: number }).statusCode).toBe(401);
    expect((err as { message: string }).message).toBe('Invalid apiKey');
  });

  it('classifies an upstream-unavailable gateway error', async () => {
    const fetchImpl = mockFetch(jsonResponse(502, { error: 'upstream unavailable' }));
    const client = testClient(fetchImpl);
    const err = await client.geocode.search({ text: 'Singapore' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
  });
});
