import { describe, expect, it } from 'vitest';

import {
  ApiError,
  CrossCountryError,
  InvalidCoordinatesError,
  JustRoutingError,
  NoRouteError,
  PlanLimitExceededError,
  QuotaExceededError,
  RateLimitedError,
  UnauthorizedError,
  UpstreamUnavailableError,
} from '../src/index.js';
import { MAX_ERROR_BODY_BYTES, errorFromResponse, osrmStatusError } from '../src/errors.js';

describe('errorFromResponse', () => {
  it('reads the gateway {"error": ...} shape', () => {
    const err = errorFromResponse(500, '{"error":"boom"}');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('boom');
  });

  it('reads the routing {"code": "NoRoute", "message": ...} shape', () => {
    const err = errorFromResponse(400, '{"code":"NoRoute","message":"no path"}');
    expect(err).toBeInstanceOf(NoRouteError);
    expect(err.osrmCode).toBe('NoRoute');
    expect(err.vroomCode).toBe(0);
  });

  it('reads the optimization {"code": 3, "error": ...} shape', () => {
    const err = errorFromResponse(400, '{"code":3,"error":"not enough vehicles"}');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.vroomCode).toBe(3);
    expect(err.message).toBe('not enough vehicles');
  });

  it('ignores an "Ok" code and falls back to the message field', () => {
    const err = errorFromResponse(400, '{"code":"Ok","message":"something"}');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.osrmCode).toBe('');
    expect(err.message).toBe('something');
  });

  it('classifies bodies by shape, not content type', () => {
    const err = errorFromResponse(400, 'not json at all');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('not json at all');
  });

  it('falls back to the status text for HTML bodies', () => {
    const err = errorFromResponse(404, '<html><body>oops</body></html>');
    expect(err.message).toBe('not found');
  });

  it('falls back to a generic message for empty bodies', () => {
    expect(errorFromResponse(599, '').message).toBe('unexpected response');
  });

  it('truncates a large body', () => {
    const err = errorFromResponse(500, '{"error":"' + 'x'.repeat(MAX_ERROR_BODY_BYTES * 2) + '"}');
    expect(err.body.length).toBe(MAX_ERROR_BODY_BYTES);
  });
});

describe('error classification', () => {
  it('401 becomes UnauthorizedError', () => {
    expect(errorFromResponse(401, '{"error":"bad key"}')).toBeInstanceOf(UnauthorizedError);
  });

  it('429 becomes RateLimitedError', () => {
    expect(errorFromResponse(429, '{"error":"slow down"}')).toBeInstanceOf(RateLimitedError);
  });

  it('429 with a daily quota message becomes QuotaExceededError', () => {
    const err = errorFromResponse(429, '{"error":"daily quota exceeded"}');
    expect(err).toBeInstanceOf(QuotaExceededError);
    // Quota exhaustion is a form of throttling.
    expect(err).toBeInstanceOf(RateLimitedError);
  });

  it('502 or an upstream-unavailable message becomes UpstreamUnavailableError', () => {
    expect(errorFromResponse(502, '{"error":"boom"}')).toBeInstanceOf(UpstreamUnavailableError);
    expect(errorFromResponse(500, '{"error":"upstream unavailable"}')).toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('a cross-country message becomes CrossCountryError', () => {
    expect(errorFromResponse(400, '{"error":"cross-country request"}')).toBeInstanceOf(
      CrossCountryError,
    );
  });

  it('a plan-limit message becomes PlanLimitExceededError', () => {
    expect(errorFromResponse(400, '{"error":"exceeds plan limit"}')).toBeInstanceOf(
      PlanLimitExceededError,
    );
    expect(errorFromResponse(400, '{"error":"too many jobs"}')).toBeInstanceOf(
      PlanLimitExceededError,
    );
    expect(errorFromResponse(400, '{"error":"too many vehicles"}')).toBeInstanceOf(
      PlanLimitExceededError,
    );
  });

  it('a NoRoute engine code becomes NoRouteError', () => {
    expect(errorFromResponse(400, '{"code":"NoRoute","message":"no path"}')).toBeInstanceOf(
      NoRouteError,
    );
  });

  it('an invalid-coordinates message becomes InvalidCoordinatesError', () => {
    expect(errorFromResponse(400, '{"error":"cannot parse coordinates"}')).toBeInstanceOf(
      InvalidCoordinatesError,
    );
    expect(errorFromResponse(400, '{"error":"invalid coordinates"}')).toBeInstanceOf(
      InvalidCoordinatesError,
    );
  });

  it('classification order prefers status over message', () => {
    // 429 with a cross-country message is still throttling.
    expect(errorFromResponse(429, '{"error":"cross-country"}')).toBeInstanceOf(RateLimitedError);
  });
});

describe('osrmStatusError', () => {
  it('returns null for Ok or empty codes', () => {
    expect(osrmStatusError('Ok', '')).toBeNull();
    expect(osrmStatusError('', '')).toBeNull();
    expect(osrmStatusError('ok', '')).toBeNull();
  });

  it('builds an error with the engine code and HTTP 200', () => {
    const err = osrmStatusError('NoRoute', 'no path');
    expect(err).toBeInstanceOf(NoRouteError);
    expect(err?.statusCode).toBe(200);
    expect(err?.osrmCode).toBe('NoRoute');
  });

  it('synthesises a message when the engine sends none', () => {
    expect(osrmStatusError('InvalidValue', '')?.message).toBe(
      'routing engine returned InvalidValue',
    );
  });
});

describe('error hierarchy', () => {
  it('every error is a JustRoutingError', () => {
    expect(new ApiError('x')).toBeInstanceOf(JustRoutingError);
    expect(new NoRouteError('x')).toBeInstanceOf(JustRoutingError);
  });

  it('is also a native Error, with the right name', () => {
    const err = new NoRouteError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NoRouteError');
  });

  it('has no HTTP status for locally produced errors', () => {
    expect(new NoRouteError('x').statusCode).toBe(0);
  });
});
