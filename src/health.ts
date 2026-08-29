/**
 * The Health service: API availability.
 */

import { Transport } from './transport.js';
import type { CallOptions } from './transport.js';

/** The API's self-reported status.
 *
 * Fields:
 * - status: "ok" when every upstream is reachable, otherwise "degraded".
 * - timestamp: when the check ran, in RFC 3339 format.
 * - upstreams: maps each routing engine to its reachability.
 */
export class Health {
  status = '';
  timestamp = '';
  upstreams: Record<string, boolean> = {};

  /** Whether every upstream is healthy. */
  ok(): boolean {
    return this.status === 'ok';
  }
}

function decodeHealth(data: unknown): Health {
  const d = (data ?? {}) as Record<string, unknown>;
  const h = new Health();
  h.status = typeof d.status === 'string' ? d.status : '';
  h.timestamp = typeof d.timestamp === 'string' ? d.timestamp : '';
  if (d.upstreams !== null && typeof d.upstreams === 'object') {
    h.upstreams = {};
    for (const [k, v] of Object.entries(d.upstreams as Record<string, unknown>)) {
      if (typeof v === 'boolean') h.upstreams[k] = v;
    }
  }
  return h;
}

/** HealthService reports API availability. */
export class HealthService {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** The current API status. It is the only call that works without an API
   * key, which makes it useful as a connectivity check. */
  async get(opts?: CallOptions): Promise<Health> {
    return await this.transport.do({ method: 'GET', path: '/health' }, decodeHealth, opts);
  }
}
