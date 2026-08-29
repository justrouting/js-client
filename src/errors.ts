/**
 * Errors thrown by the JustRouting client.
 *
 * The Go client classifies failures with sentinel errors and errors.Is.
 * JavaScript expresses the same classification as a class hierarchy, so
 * callers use instanceof instead of string matching:
 *
 *     try {
 *         const route = await client.routes.get(req);
 *     } catch (e) {
 *         if (e instanceof QuotaExceededError) {
 *             // daily allowance used up — retrying will not help
 *         } else if (e instanceof RateLimitedError) {
 *             // throttled; the client already retried
 *         }
 *     }
 *
 * QuotaExceededError is a subclass of RateLimitedError, mirroring how the
 * Go client reports a daily-quota response as both ErrQuotaExceeded and
 * ErrRateLimited.
 *
 * Every API failure — non-2xx responses and in-body engine failures alike —
 * throws an ApiError (or one of its subclasses). Catch it when the status
 * code, engine code, or raw body is needed:
 *
 *     catch (e) {
 *         if (e instanceof ApiError) {
 *             console.log(`HTTP ${e.statusCode}: ${e.message}\n${e.body}`);
 *         }
 *     }
 *
 * ApiError carries the same fields as the Go *Error struct. Failures that
 * never produced an API response (local validation, transport, decoding)
 * raise InvalidRequestError, TransportError or DecodeError instead.
 *
 * NOTE: The Python client names the API error base class Error; this client
 * calls it ApiError, because JavaScript already has a global Error and an
 * exported class of the same name would shadow it.
 */

import { STATUS_CODES } from 'node:http';

/** maxErrorBodyBytes bounds how much of a response body is retained on an
 * ApiError, so that a large or misbehaving upstream cannot balloon a log
 * line. */
export const MAX_ERROR_BODY_BYTES = 8 << 10;

/** Base class of every error raised by this package. */
export class JustRoutingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A failed API call.
 *
 * It is thrown whenever the API responds with a non-2xx status, and also
 * when a 2xx response carries an in-body failure code — the routing and
 * optimization engines can both report errors alongside HTTP 200.
 *
 * Fields:
 * - statusCode: the HTTP status of the response. Zero for errors that were
 *   produced without an HTTP response, such as local validation.
 * - message: the human-readable reason reported by the API.
 * - osrmCode: the routing engine's status code, such as "NoRoute" or
 *   "InvalidValue". Empty when the error did not come from the routing
 *   engine.
 * - vroomCode: the optimization engine's non-zero status code. Zero when
 *   the error did not come from the optimization engine.
 * - body: the raw response body, truncated to a sane limit. Useful for
 *   logging responses this package does not model.
 */
export class ApiError extends JustRoutingError {
  statusCode: number;
  osrmCode: string;
  vroomCode: number;
  body: string;

  constructor(
    message = '',
    options: {
      statusCode?: number;
      osrmCode?: string;
      vroomCode?: number;
      body?: string;
    } = {},
  ) {
    super(message);
    this.statusCode = options.statusCode ?? 0;
    this.osrmCode = options.osrmCode ?? '';
    this.vroomCode = options.vroomCode ?? 0;
    this.body = options.body ?? '';
  }
}

/** The API key is missing, invalid or revoked. */
export class UnauthorizedError extends ApiError {}

/** The request was throttled (per-second limit or daily quota). */
export class RateLimitedError extends ApiError {}

/** The plan's daily request quota is used up.
 *
 * Retrying before the quota resets will not help. Subclasses
 * RateLimitedError because quota exhaustion is a form of throttling.
 */
export class QuotaExceededError extends RateLimitedError {}

/** The request is larger than the plan allows — too many matrix
 * coordinates, jobs, or vehicles. */
export class PlanLimitExceededError extends ApiError {}

/** The coordinates span more than one country.
 *
 * Every coordinate in a request must fall within a single country.
 */
export class CrossCountryError extends ApiError {}

/** A coordinate was malformed, out of range, or could not be parsed. */
export class InvalidCoordinatesError extends ApiError {}

/** No route exists between the given coordinates. */
export class NoRouteError extends ApiError {}

/** The routing engine behind the API could not be reached.
 *
 * This is usually transient.
 */
export class UpstreamUnavailableError extends ApiError {}

/** The request was rejected before being sent because required fields were
 * missing or inconsistent.
 *
 * These errors carry no HTTP status; the message holds the reason.
 */
export class InvalidRequestError extends ApiError {}

/** A network-level failure while contacting the API.
 *
 * The original error is available as `cause`. Transport errors are
 * transient and are retried like 429 and 5xx responses.
 */
export class TransportError extends JustRoutingError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A successful response could not be decoded.
 *
 * The original error is available as `cause`.
 */
export class DecodeError extends JustRoutingError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** truncateBody bounds body to maxErrorBodyBytes characters. */
export function truncateBody(body: string): string {
  return body.length <= MAX_ERROR_BODY_BYTES ? body : body.slice(0, MAX_ERROR_BODY_BYTES);
}

/** osrmStatusError converts a routing engine status code into an ApiError,
 * or null when the response was successful. */
export function osrmStatusError(code: string, message: string): ApiError | null {
  if (!code || code.toLowerCase() === 'ok') return null;
  if (!message) message = `routing engine returned ${code}`;
  const cls = classifyError(200, message, code);
  return new cls(message, { statusCode: 200, osrmCode: code });
}

/**
 * errorFromResponse builds the right ApiError subclass for an HTTP error
 * response.
 *
 * Bodies are classified by shape rather than Content-Type: some API
 * handlers emit a JSON body while leaving the header set to text/plain.
 */
export function errorFromResponse(statusCode: number, body: string): ApiError {
  let message = '';
  let osrmCode = '';
  let vroomCode = 0;

  const stripped = body.trim();
  if (stripped) {
    try {
      const payload: unknown = JSON.parse(stripped);
      if (payload !== null && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        // {"error": "..."}                       gateway errors
        // {"code": "NoRoute", "message": "..."}  routing engine (string code)
        // {"code": 3, "error": "..."}            optimization engine (int code)
        message = typeof p.error === 'string' ? p.error : typeof p.message === 'string' ? p.message : '';
        const code = p.code;
        if (typeof code === 'string' && code.toLowerCase() !== 'ok') {
          osrmCode = code;
        } else if (typeof code === 'number') {
          vroomCode = code;
        }
      }
    } catch {
      // Not JSON; fall back to the raw body below.
    }
  }

  if (!message) message = fallbackMessage(statusCode, body);

  const cls = classifyError(statusCode, message, osrmCode);
  return new cls(message, {
    statusCode,
    osrmCode,
    vroomCode,
    body: truncateBody(body),
  });
}

type ApiErrorClass = new (
  message: string,
  options?: { statusCode?: number; osrmCode?: string; vroomCode?: number; body?: string },
) => ApiError;

/** classifyError picks the error class for a failure, in the same priority
 * order the Go client's Error.Is uses. */
function classifyError(statusCode: number, message: string, osrmCode: string): ApiErrorClass {
  const msg = message.toLowerCase();
  if (statusCode === 401) return UnauthorizedError;
  if (statusCode === 429) {
    if (msg.includes('daily quota')) return QuotaExceededError;
    return RateLimitedError;
  }
  if (statusCode === 502 || msg.includes('upstream unavailable')) {
    return UpstreamUnavailableError;
  }
  if (msg.includes('cross-country')) return CrossCountryError;
  if (
    msg.includes('exceeds plan limit') ||
    msg.includes('too many jobs') ||
    msg.includes('too many vehicles')
  ) {
    return PlanLimitExceededError;
  }
  if (osrmCode.toLowerCase() === 'noroute') return NoRouteError;
  if (msg.includes('cannot parse coordinates') || msg.includes('invalid coordinates')) {
    return InvalidCoordinatesError;
  }
  return ApiError;
}

/** fallbackMessage produces a message for responses with no recognisable
 * error field, such as an HTML error page from an intermediary proxy. */
function fallbackMessage(statusCode: number, body: string): string {
  const s = body.trim();
  if (s && !s.startsWith('{') && !s.startsWith('<') && s.length <= 200) {
    return s;
  }
  const text = STATUS_CODES[statusCode];
  if (text) return text.toLowerCase();
  return 'unexpected response';
}
