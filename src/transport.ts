/**
 * HTTP transport: request execution, retries, backoff, and decoding.
 */

import {
  ApiError,
  DecodeError,
  TransportError,
  UnauthorizedError,
  errorFromResponse,
} from './errors.js';

/** maxResponseBytes bounds how much of a response is read. A 500x500 matrix
 * with both annotations is a few megabytes, so the limit is generous. */
export const MAX_RESPONSE_BYTES = 32 << 20;

/** Retryable statuses: throttling and server errors. Client errors other
 * than throttling will fail the same way every time and would still
 * consume quota, so they are returned immediately. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function retryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/** A backoff function: attempt is 1 for the first retry, 2 for the second,
 * and so on. Returns the delay in seconds. */
export type Backoff = (attempt: number) => number;

/** defaultBackoff grows exponentially from 500ms to a cap of 8s, with
 * jitter to keep concurrent clients from retrying in lockstep. */
export function defaultBackoff(attempt: number): number {
  const base = 0.5;
  const maxDelay = 8;
  if (attempt < 1) attempt = 1;
  let delay = maxDelay;
  if (attempt <= 20) {
    const shifted = base * 2 ** (attempt - 1);
    if (shifted < maxDelay) delay = shifted;
  }
  // Jitter across [delay/2, delay].
  const half = delay / 2;
  return half + Math.random() * half;
}

/** parseRetryAfter understands both forms of the Retry-After header: a
 * delay in seconds, or an HTTP date. Returns [delaySeconds, ok]. */
export function parseRetryAfter(value: string): [number, boolean] {
  const v = value.trim();
  if (!v) return [0, false];
  if (/^-?\d+$/.test(v)) {
    // An integer that parses as a year (e.g. "-5") must not fall through
    // to Date.parse; a negative delay is invalid.
    const seconds = Number(v);
    return seconds >= 0 ? [seconds, true] : [0, false];
  }
  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const remaining = (t - Date.now()) / 1000;
    // A date in the past means "retry now".
    return remaining > 0 ? [remaining, true] : [0, true];
  }
  return [0, false];
}

/** Options for a single call, given as the last argument of every service
 * method. */
export interface CallOptions {
  /** An AbortSignal that cancels the whole call, retries included — the
   * JavaScript equivalent of a Go context. */
  signal?: AbortSignal;
  /** Seconds allowed for the whole call, bounding the retry sequence like
   * a context deadline. */
  timeout?: number;
}

/** The shape of a request, independent of transport concerns. */
export interface RequestSpec {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  needsAuth?: boolean;
}

/** Decode parses a successful response body and checks any in-body status
 * code, which both engines can use to report failure alongside HTTP 200.
 * raw is the body text, retained on errors for logging. */
export type Decode<T> = (data: unknown, raw: string) => T;

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
  maxRetries: number;
  backoff: Backoff;
  /** Seconds allowed for a single HTTP attempt. Null disables the limit. */
  timeout: number | null;
  fetch: typeof fetch;
}

function deadlineExceeded(): DOMException {
  return new DOMException('justrouting: deadline exceeded', 'TimeoutError');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const sig = signal;
    const onAbort = () => {
      clearTimeout(timer);
      reject(sig?.reason);
    };
    const timer = setTimeout(() => {
      sig?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    sig?.addEventListener('abort', onAbort, { once: true });
  });
}

/** wait sleeps for delay seconds, rejecting early when the deadline passes
 * or the user's signal aborts. */
async function wait(
  delay: number,
  signal: AbortSignal | undefined,
  deadline: number | null,
): Promise<void> {
  if (delay <= 0) {
    // Still observe cancellation and the deadline when the delay is zero.
    if (signal?.aborted) throw signal.reason;
    if (deadline != null && Date.now() >= deadline) throw deadlineExceeded();
    return;
  }
  const remaining = deadline != null ? Math.max(0, deadline - Date.now()) : Infinity;
  try {
    await sleep(Math.min(delay * 1000, remaining), signal);
  } catch (err) {
    throw signal?.aborted ? signal.reason : err;
  }
  if (deadline != null && Date.now() >= deadline) throw deadlineExceeded();
}

/** Transport executes requests for a Client: one attempt, retries, and
 * decoding.
 *
 * The deadline (a timestamp, or null) bounds the whole retry sequence, like
 * a Go context deadline. The client's per-attempt timeout applies to each
 * individual HTTP attempt.
 */
export class Transport {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly maxRetries: number;
  readonly backoff: Backoff;
  readonly timeout: number | null;
  readonly fetch: typeof fetch;

  constructor(options: TransportOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.userAgent = options.userAgent;
    this.maxRetries = options.maxRetries;
    this.backoff = options.backoff;
    this.timeout = options.timeout;
    this.fetch = options.fetch;
  }

  /** do executes a request, retrying transient failures, and decodes a
   * successful response. A null decode discards the body. */
  async do<T>(spec: RequestSpec, decode: Decode<T> | null, opts: CallOptions = {}): Promise<T> {
    if (spec.needsAuth && !this.apiKey) {
      throw new UnauthorizedError('no API key configured; pass one to Client', {
        statusCode: 401,
      });
    }

    // Marshal once and replay the bytes on each attempt, so a retried POST
    // sends an identical body.
    let body: string | null = null;
    if (spec.body !== undefined) {
      try {
        body = JSON.stringify(spec.body);
      } catch (err) {
        throw new ApiError(`justrouting: encoding request body: ${describe(err)}`);
      }
    }

    const endpoint = this.endpoint(spec.path, spec.query);
    const deadline = opts.timeout != null ? Date.now() + opts.timeout * 1000 : null;

    let lastErr: unknown = null;
    let delay = 0;
    let retryAfter: string | null = null;

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        await wait(delay, opts.signal, deadline);
      }
      retryAfter = null;

      let payload: { status: number; text: string; retryAfter: string | null } | null = null;
      try {
        payload = await this.roundTrip(spec.method, endpoint, body, opts.signal, deadline);
      } catch (err) {
        // A cancelled call or an expired deadline is final, not transient.
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (deadline != null && Date.now() >= deadline) throw deadlineExceeded();
        lastErr = err;
      }

      if (payload !== null) {
        if (payload.status >= 200 && payload.status < 300) {
          return decodeSuccessful(payload.text, decode);
        }
        const apiErr = errorFromResponse(payload.status, payload.text);
        if (!retryableStatus(payload.status)) throw apiErr;
        lastErr = apiErr;
        retryAfter = payload.retryAfter;
      }

      if (attempt >= this.maxRetries) throw lastErr;
      delay = this.nextDelay(attempt + 1, retryAfter);
    }
  }

  /** roundTrip performs one HTTP attempt and returns the body, status and
   * Retry-After header. */
  private async roundTrip(
    method: string,
    endpoint: string,
    body: string | null,
    signal: AbortSignal | undefined,
    deadline: number | null,
  ): Promise<{ status: number; text: string; retryAfter: string | null }> {
    // Combine the user's signal with the per-attempt timeout and the time
    // left until the deadline, whichever is tighter.
    let attemptSignal: AbortSignal | undefined = signal;
    if (this.timeout != null || deadline != null) {
      let ms: number;
      if (this.timeout != null) {
        ms = this.timeout * 1000;
        if (deadline != null) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw deadlineExceeded();
          ms = Math.min(ms, remaining);
        }
      } else {
        const remaining = deadline! - Date.now();
        if (remaining <= 0) throw deadlineExceeded();
        ms = remaining;
      }
      attemptSignal = attemptSignal
        ? AbortSignal.any([attemptSignal, AbortSignal.timeout(ms)])
        : AbortSignal.timeout(ms);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== null) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetch(endpoint, {
        method,
        headers,
        body,
        signal: attemptSignal,
      });
    } catch (err) {
      // A per-attempt timeout or network failure is transient; the caller
      // re-checks the deadline and user signal, then retries.
      throw new TransportError(`justrouting: ${method} ${endpoint}: ${describe(err)}`, {
        cause: err,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new TransportError(`justrouting: reading response: ${describe(err)}`, {
        cause: err,
      });
    }
    if (text.length > MAX_RESPONSE_BYTES) text = text.slice(0, MAX_RESPONSE_BYTES);
    return {
      status: response.status,
      text,
      retryAfter: response.headers.get('Retry-After'),
    };
  }

  /** endpoint builds the absolute URL for a request path, preserving any
   * path prefix on the configured base URL. The coordinate separators ","
   * and ";" are legal in a path segment and survive unescaped. */
  endpoint(path: string, query?: Record<string, string>): string {
    const u = new URL(this.baseUrl);
    u.pathname = u.pathname.replace(/\/+$/, '') + path;
    u.search = '';
    u.hash = '';
    if (query) u.search = new URLSearchParams(query).toString();
    return u.toString();
  }

  /** nextDelay returns how long to wait before the given retry attempt,
   * preferring a Retry-After header when the server sends one. */
  private nextDelay(attempt: number, retryAfter: string | null): number {
    if (retryAfter != null) {
      const [delay, ok] = parseRetryAfter(retryAfter);
      if (ok) return delay;
    }
    return this.backoff(attempt);
  }
}

/** decodeSuccessful parses a successful response and checks any in-body
 * status code, which both engines can use to report failure alongside
 * HTTP 200. */
function decodeSuccessful<T>(text: string, decode: Decode<T> | null): T {
  if (decode === null) return null as unknown as T;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new DecodeError(`justrouting: decoding response: ${describe(err)}`, { cause: err });
  }
  return decode(data, text);
}
