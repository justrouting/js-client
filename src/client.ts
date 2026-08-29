/**
 * The JustRouting client.
 *
 * A client is created with an API key and, optionally, an options object:
 *
 *     const client = new Client('YOUR_API_KEY');
 *
 *     const route = await client.routes.get({
 *         origin: [103.8198, 1.3521],
 *         destination: [103.9915, 1.3644],
 *     });
 *     console.log(`Distance: ${(route.distance / 1000).toFixed(1)} km`);
 *
 * Coordinates are always [longitude, latitude], the order used by GeoJSON,
 * OSRM and VROOM. Every call accepts optional `signal` and `timeout`
 * options that bound the whole retry sequence, like a context deadline in
 * the Go client.
 *
 * Failed calls throw an ApiError subclass. Use `instanceof` for control
 * flow and ApiError when the status code or raw body is needed:
 *
 *     try {
 *         const route = await client.routes.get(req);
 *     } catch (e) {
 *         if (e instanceof justrouting.RateLimitedError) {
 *             // back off and retry later
 *         }
 *     }
 *
 * Unlike the Go client, invalid constructor options throw TypeError
 * immediately — JavaScript constructors can fail, so there is no need to
 * defer the error to the first request.
 *
 * The package has no dependencies outside the Node.js standard library.
 */

import { DEFAULT_BASE_URL, VERSION } from './consts.js';
import { HealthService } from './health.js';
import { MatrixService } from './matrix.js';
import { OptimizationService } from './optimization.js';
import { RoutesService } from './routes.js';
import { Transport, defaultBackoff } from './transport.js';
import type { Backoff } from './transport.js';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT = 30;

export interface ClientOptions {
  /** The API endpoint, default DEFAULT_BASE_URL. Target a local or staging
   * server with baseUrl: "http://localhost:8080". Any path is kept as a
   * prefix for every request. */
  baseUrl?: string;
  /** Override the User-Agent header. Identifying your application helps
   * when diagnosing traffic against the API. */
  userAgent?: string;
  /** How many times a failed request is retried, on top of the initial
   * attempt. The default is 2. Pass 0 to disable retries. Only rate-limit
   * (429), server (5xx) and transport errors are retried; other 4xx
   * responses are returned immediately. */
  maxRetries?: number;
  /** A function (attempt: number) => seconds returning the delay before
   * retry `attempt` (1 for the first retry, 2 for the second, and so on).
   * The default is exponential backoff with jitter, starting at 500ms and
   * capped at 8s. A Retry-After response header, when present, takes
   * precedence. */
  backoff?: Backoff;
  /** Seconds allowed for a single HTTP attempt, like http.Client.Timeout
   * in Go. The default is 30. Pass null to disable. Use the per-call
   * `timeout` option instead to bound the whole retry sequence. */
  timeout?: number | null;
  /** The fetch implementation, for tests and instrumentation — the
   * equivalent of WithHTTPClient in the Go client. */
  fetch?: typeof fetch;
}

/** A JustRouting API client.
 *
 * It is safe for concurrent use, and should be created once and reused.
 *
 * The API key is sent as an "Authorization: Bearer" header on every request
 * that needs it. An empty key is allowed but only health.get() will work;
 * every other call fails with UnauthorizedError before any request is sent.
 */
export class Client {
  private readonly transport: Transport;

  /** Routes computes routes between two or more coordinates. */
  readonly routes: RoutesService;
  /** Matrix computes duration and distance matrices. */
  readonly matrix: MatrixService;
  /** Optimization solves vehicle routing problems. */
  readonly optimization: OptimizationService;
  /** Health reports API and upstream availability. */
  readonly health: HealthService;

  constructor(apiKey: string, options: ClientOptions = {}) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim();
    if (!baseUrl) throw new TypeError('justrouting: baseUrl must not be empty');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new TypeError(`justrouting: baseUrl ${JSON.stringify(options.baseUrl)} is not an absolute URL`);
    }
    if (!parsed.protocol || !parsed.host) {
      throw new TypeError(`justrouting: baseUrl ${JSON.stringify(options.baseUrl)} is not an absolute URL`);
    }

    const userAgent = options.userAgent ?? `justrouting-js/${VERSION}`;
    if (!userAgent.trim()) throw new TypeError('justrouting: userAgent must not be empty');

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (maxRetries < 0) {
      throw new TypeError(`justrouting: maxRetries must not be negative, got ${maxRetries}`);
    }

    const backoff = options.backoff ?? defaultBackoff;
    if (typeof backoff !== 'function') throw new TypeError('justrouting: backoff must be a function');

    const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;
    if (timeout != null && timeout <= 0) {
      throw new TypeError('justrouting: timeout must be positive or null');
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('justrouting: fetch must be a function');
    }

    this.transport = new Transport({
      apiKey: apiKey.trim(),
      baseUrl,
      userAgent,
      maxRetries,
      backoff,
      timeout,
      fetch: fetchImpl,
    });

    this.routes = new RoutesService(this.transport);
    this.matrix = new MatrixService(this.transport);
    this.optimization = new OptimizationService(this.transport);
    this.health = new HealthService(this.transport);
  }

  /** The API endpoint the client sends requests to. */
  baseUrl(): string {
    return this.transport.baseUrl;
  }
}
