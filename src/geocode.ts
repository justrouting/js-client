/**
 * The Geocode service: convert addresses into coordinates.
 */

import { InvalidRequestError } from './errors.js';
import type { Point } from './geo.js';
import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** A forward-geocoding search. Exactly one of text and structured must be
 * set.
 *
 * Fields:
 * - text: the free-form address to search for, such as "Marina Bay Sands,
 *   Singapore". Mutually exclusive with structured.
 * - structured: an address given as typed components. Mutually exclusive
 *   with text.
 * - limit: caps the number of results. The API defaults to 5.
 * - offset: skips the first offset results before applying limit.
 * - filters: restrict results, for example "countrycode:sg". Each entry is
 *   sent as its own filter parameter; the API applies all of them.
 * - bias: steers results toward a location, for example
 *   "proximity:103.8,1.3". It is forwarded verbatim.
 * - type: restricts results to a feature type such as "street" or "city".
 * - lang: requests results in a language, such as "en".
 */
export interface GeocodeRequest {
  text?: string;
  structured?: StructuredQuery;
  limit?: number;
  offset?: number;
  filters?: string[];
  bias?: string;
  type?: string;
  lang?: string;
}

/** An address expressed as typed fields. Only the fields that are set are
 * sent. */
export interface StructuredQuery {
  name?: string;
  /** Lowercased to match the upstream parameter name. */
  housenumber?: string;
  street?: string;
  postcode?: string;
  city?: string;
  state?: string;
  country?: string;
}

/** The result of a forward-geocoding search.
 *
 * Fields:
 * - results: ordered best first. Empty when nothing matches.
 * - query: echoes how the API interpreted the request, when returned.
 */
export interface GeocodeResponse {
  results: GeocodeResult[];
  query?: GeocodeQuery;
}

/** How the API interpreted the request. */
export interface GeocodeQuery {
  /** The free-text query as received by the API. */
  text: string;
  /** The API's structured interpretation of text. Its shape is not
   * guaranteed, so it is preserved as the decoded JSON value. */
  parsed?: unknown;
}

/** One matching place. */
export class GeocodeResult {
  /** Credits the data provider. */
  datasource?: Datasource;
  housenumber = '';
  street = '';
  suburb = '';
  city = '';
  county = '';
  state = '';
  stateCode = '';
  postcode = '';
  country = '';
  countryCode = '';
  lon = 0;
  lat = 0;
  formatted = '';
  addressLine1 = '';
  addressLine2 = '';
  resultType = '';
  /** Scores the result's relevance and match confidence. */
  rank?: Rank;
  /** The result's time zone with standard- and daylight-time offsets. */
  timezone?: Timezone;
  /** The upstream's opaque identifier for the place. */
  placeId = '';
  category = '';
  plusCode = '';
  name = '';
  /** The result's bounding box as [lon1, lat1, lon2, lat2]. */
  bbox?: BBox;
  /** The metres from the bias location, meaningful only when Bias is set. */
  distance = 0;

  /** The result's position as [longitude, latitude], in the package's
   * usual order. */
  location(): Point {
    return [this.lon, this.lat];
  }
}

/** The data provider of a GeocodeResult. */
export interface Datasource {
  sourcename: string;
  attribution: string;
  license: string;
  url: string;
}

/** A GeocodeResult's relevance and match confidence. */
export interface Rank {
  importance: number;
  popularity: number;
  confidence: number;
  confidenceCityLevel: number;
  confidenceStreetLevel: number;
  matchType: string;
}

/** A GeocodeResult's time zone with standard- and daylight-time offsets. */
export interface Timezone {
  name: string;
  offsetSTD: string;
  offsetSTDSeconds: number;
  offsetDST: string;
  offsetDSTSeconds: number;
  abbreviationSTD: string;
  abbreviationDST: string;
}

/** A bounding box as [lon1, lat1, lon2, lat2]. */
export interface BBox {
  lon1: number;
  lat1: number;
  lon2: number;
  lat2: number;
}

/** GeocodeService converts addresses into coordinates. */
export class GeocodeService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Geocode req and return matching places, ordered best first.
   *
   *     const resp = await client.geocode.search({
   *         text: 'Marina Bay Sands, Singapore',
   *     });
   *     console.log(resp.results[0]!.formatted);
   *
   * A response with an empty results list means nothing matched; it is not
   * an error.
   */
  async search(req: GeocodeRequest, opts?: CallOptions): Promise<GeocodeResponse> {
    validateGeocodeRequest(req);
    return await this.transport.do(
      {
        method: 'GET',
        path: '/geocode/v1/search',
        query: geocodeQuery(req),
        needsAuth: true,
      },
      decodeGeocodeResponse,
      opts,
    );
  }
}

function validateGeocodeRequest(req: GeocodeRequest): void {
  if (req == null) throw new InvalidRequestError('justrouting: request must not be null');
  const hasText = !!req.text;
  const hasStructured =
    !!req.structured && Object.values(req.structured).some((v) => v !== undefined && v !== '');
  if (hasText && hasStructured) {
    throw new InvalidRequestError('justrouting: Text and Structured are mutually exclusive');
  }
  if (!hasText && !hasStructured) {
    throw new InvalidRequestError('justrouting: exactly one of Text or Structured is required');
  }
  if (req.limit != null && req.limit < 0) {
    throw new InvalidRequestError(`justrouting: Limit must not be negative, got ${req.limit}`);
  }
  if (req.offset != null && req.offset < 0) {
    throw new InvalidRequestError(`justrouting: Offset must not be negative, got ${req.offset}`);
  }
}

function geocodeQuery(req: GeocodeRequest): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = {};
  // The client decodes JSON, so pin the response format instead of
  // relying on the API's default.
  q.format = 'json';
  if (req.text) q.text = req.text;
  if (req.structured) {
    const set = (key: string, v: string | undefined): void => {
      if (v) q[key] = v;
    };
    set('name', req.structured.name);
    set('housenumber', req.structured.housenumber);
    set('street', req.structured.street);
    set('postcode', req.structured.postcode);
    set('city', req.structured.city);
    set('state', req.structured.state);
    set('country', req.structured.country);
  }
  if (req.limit != null && req.limit > 0) q.limit = String(req.limit);
  if (req.offset != null && req.offset > 0) q.offset = String(req.offset);
  if (req.filters && req.filters.length > 0) {
    // Filter is repeatable; the array preserves the given order. An empty
    // array would serialize as a bare "filter=" parameter, so skip it.
    const filters = req.filters.filter((f) => f !== '');
    if (filters.length > 0) q.filter = filters;
  }
  if (req.bias) q.bias = req.bias;
  if (req.type) q.type = req.type;
  if (req.lang) q.lang = req.lang;
  return q;
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function decodeGeocodeResponse(data: unknown): GeocodeResponse {
  const d = asRecord(data);
  const resp: GeocodeResponse = {
    results: Array.isArray(d.results)
      ? d.results.filter((r): r is unknown => r != null).map((r) => decodeGeocodeResult(r))
      : [],
  };
  if (d.query != null && typeof d.query === 'object') resp.query = decodeGeocodeQuery(d.query);
  return resp;
}

function decodeGeocodeQuery(v: unknown): GeocodeQuery {
  const d = asRecord(v);
  const q: GeocodeQuery = { text: str(d.text) };
  if (d.parsed !== undefined) q.parsed = d.parsed;
  return q;
}

function decodeGeocodeResult(v: unknown): GeocodeResult {
  const d = asRecord(v);
  const r = new GeocodeResult();
  if (d.datasource != null && typeof d.datasource === 'object') {
    r.datasource = decodeDatasource(d.datasource);
  }
  r.housenumber = str(d.housenumber);
  r.street = str(d.street);
  r.suburb = str(d.suburb);
  r.city = str(d.city);
  r.county = str(d.county);
  r.state = str(d.state);
  r.stateCode = str(d.state_code);
  r.postcode = str(d.postcode);
  r.country = str(d.country);
  r.countryCode = str(d.country_code);
  r.lon = num(d.lon);
  r.lat = num(d.lat);
  r.formatted = str(d.formatted);
  r.addressLine1 = str(d.address_line1);
  r.addressLine2 = str(d.address_line2);
  r.resultType = str(d.result_type);
  if (d.rank != null && typeof d.rank === 'object') r.rank = decodeRank(d.rank);
  if (d.timezone != null && typeof d.timezone === 'object') r.timezone = decodeTimezone(d.timezone);
  r.placeId = str(d.place_id);
  r.category = str(d.category);
  r.plusCode = str(d.plus_code);
  r.name = str(d.name);
  if (d.bbox != null && typeof d.bbox === 'object') r.bbox = decodeBBox(d.bbox);
  r.distance = num(d.distance);
  return r;
}

function decodeDatasource(v: unknown): Datasource {
  const d = asRecord(v);
  return {
    sourcename: str(d.sourcename),
    attribution: str(d.attribution),
    license: str(d.license),
    url: str(d.url),
  };
}

function decodeRank(v: unknown): Rank {
  const d = asRecord(v);
  return {
    importance: num(d.importance),
    popularity: num(d.popularity),
    confidence: num(d.confidence),
    confidenceCityLevel: num(d.confidence_city_level),
    confidenceStreetLevel: num(d.confidence_street_level),
    matchType: str(d.match_type),
  };
}

function decodeTimezone(v: unknown): Timezone {
  const d = asRecord(v);
  return {
    name: str(d.name),
    offsetSTD: str(d.offset_STD),
    offsetSTDSeconds: num(d.offset_STD_seconds),
    offsetDST: str(d.offset_DST),
    offsetDSTSeconds: num(d.offset_DST_seconds),
    abbreviationSTD: str(d.abbreviation_STD),
    abbreviationDST: str(d.abbreviation_DST),
  };
}

function decodeBBox(v: unknown): BBox {
  const d = asRecord(v);
  return {
    lon1: num(d.lon1),
    lat1: num(d.lat1),
    lon2: num(d.lon2),
    lat2: num(d.lat2),
  };
}
