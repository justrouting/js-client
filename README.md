# JustRouting JavaScript Client

Official JavaScript client for the [JustRouting](https://justrouting.tech) API — routing, distance matrices, and vehicle routing optimization across Southeast Asia.

TypeScript-first, compiled to pure ESM with type declarations. No dependencies outside the Node.js standard library (`fetch`). Requires Node 20.3+.

## Install

```shell
npm install @justrouting/client
```

```ts
import { Client } from '@justrouting/client';
```

## Quickstart

```ts
import { Client } from '@justrouting/client';

const client = new Client('YOUR_API_KEY', { timeout: 10 });

const route = await client.routes.get({
    origin: [103.708362, 1.357371],
    destination: [103.984748, 1.352212],
});

console.log(`Distance: ${(route.distance / 1000).toFixed(1)} km`);
```

> The coordinates above are Singapore and Kuala Lumpur, which span two countries. See [Coordinates must share a country](#coordinates-must-share-a-country) — the runnable examples use same-country pairs.

## Services

A `Client` exposes four services.

### Routes

`routes.get` returns the best route. `routes.getAll` additionally returns alternatives and the snapped input waypoints.

```ts
const route = await client.routes.get({
    origin: [103.8198, 1.3521],
    destination: [103.9915, 1.3644],
    waypoints: [[103.8514, 1.2897]], // stops in order
    overview: 'full',                 // full geometry
    steps: true,                      // turn-by-turn
});

console.log(route.distance); // metres
console.log(route.duration); // seconds
```

`route.geometry` holds whichever encoding you asked for:

```ts
const polyline = route.geometry.polyline(); // default, and "polyline6"
const line = route.geometry.geoJSON();      // when geometries: "geojson"
```

### Matrix

Travel time and distance between many points at once.

```ts
const m = await client.matrix.get({
    coordinates: [depot, stopA, stopB],
    sources: [0],    // only the depot row; cheaper than N×N
    destinations: [1, 2],
});

const seconds = m.duration(0, 1);
if (seconds !== null) {
    console.log(`depot → stopA: ${Math.round(seconds / 60)} min`);
}
```

The accessors return `null` for unreachable pairs. The API reports those as `null`, which is deliberately kept distinct from a genuine zero — that is why `durations` and `distances` hold `number | null` entries.

### Optimization

Assign tasks to a fleet and order each vehicle's stops.

```ts
const solution = await client.optimization.solve({
    vehicles: [
        { id: 1, start: depot, end: depot, capacity: [4] },
    ],
    jobs: [
        { id: 1, location: stopA, delivery: [1], service: 300 },
        { id: 2, location: stopB, delivery: [2], service: 300 },
    ],
});

for (const route of solution.routes) {
    console.log(`vehicle ${route.vehicle}: ${route.steps.length} stops`);
}
console.log(`${solution.unassigned.length} task(s) could not be served`);
```

Use `shipments` instead of `jobs` for pickup-and-delivery pairs that must be served in order by the same vehicle.

### Health

The only call that works without an API key, which makes it a useful connectivity check.

```ts
const health = await client.health.get();
console.log(health.ok(), health.upstreams);
```

## Error handling

Every API failure throws an `ApiError` subclass. Classify it with `instanceof` rather than matching on message text:

```ts
try {
    const route = await client.routes.get(req);
} catch (err) {
    if (err instanceof QuotaExceededError) {
        // daily allowance used up — retrying will not help
    } else if (err instanceof RateLimitedError) {
        // throttled; the client already retried
    } else if (err instanceof CrossCountryError) {
        // coordinates span more than one country
    } else if (err instanceof NoRouteError) {
        // no road connects these points
    }
}
```

| Class | Meaning |
| --- | --- |
| `UnauthorizedError` | API key missing, invalid, or revoked |
| `RateLimitedError` | Throttled (per-second limit or daily quota) |
| `QuotaExceededError` | Daily quota exhausted; retrying will not help (subclass of `RateLimitedError`) |
| `PlanLimitExceededError` | Too many matrix coordinates, jobs, or vehicles |
| `CrossCountryError` | Coordinates span more than one country |
| `InvalidCoordinatesError` | Coordinate malformed or out of range |
| `NoRouteError` | No route exists between the points |
| `UpstreamUnavailableError` | Routing engine unreachable; usually transient |
| `InvalidRequestError` | Rejected locally before any request was sent |
| `TransportError` | Network-level failure; transient and retried |
| `DecodeError` | A successful response could not be decoded |

Reach for `ApiError` when you need the status code, engine code, or raw body:

```ts
} catch (err) {
    if (err instanceof ApiError) {
        console.log(`HTTP ${err.statusCode}: ${err.message}\n${err.body}`);
    }
}
```

> The Python client names this class `Error`; here it is `ApiError`, because JavaScript already has a global `Error` and an exported class of the same name would shadow it.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | `https://api.justrouting.tech` | Target a local or staging server |
| `userAgent` | `justrouting-js/<version>` | Identify your application |
| `maxRetries` | `2` | Retry budget on top of the initial attempt |
| `backoff` | 500ms → 8s, jittered | Replace the retry delay schedule |
| `timeout` | `30` | Seconds per HTTP attempt; `null` disables it |
| `fetch` | global `fetch` | Inject a fetch implementation, for tests or instrumentation |

Invalid options throw a `TypeError` immediately.

### Cancellation and deadlines

Every call accepts an options object with a `signal` and a `timeout`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000); // give up after 1s

const route = await client.routes.get(req, {
    signal: controller.signal,
    timeout: 30, // seconds for the whole call, retries included
});
```

The per-call `timeout` bounds the whole retry sequence, like a context deadline in the Go client; the constructor `timeout` applies to each individual attempt. When the deadline expires the call rejects with a `DOMException` named `TimeoutError`; aborting the signal propagates the abort reason unchanged.

### Retries

Rate limits (429), server errors (5xx), and transport failures are retried with exponential backoff and jitter; a `Retry-After` header takes precedence when present. Other 4xx responses are returned immediately — they would fail identically on a retry and would still consume quota.

## Things to know

### Coordinates are `[longitude, latitude]`

This is the GeoJSON order, and the reverse of the "lat, lng" used by most map UIs. Swapped coordinates are usually caught locally — a longitude in the latitude slot fails the `[-90, 90]` check before a request is sent — but a swap that stays in range will silently route somewhere unexpected.

### Coordinates must share a country

Every coordinate in a single request must fall within one country; the API routes each request to a per-country engine. A Singapore → Kuala Lumpur request fails with `CrossCountryError`.

Supported countries: Brunei, Cambodia, Indonesia, Laos, Malaysia, Myanmar, the Philippines, Singapore, Thailand, and Vietnam.

### Plan limits

| | Free | Hobby |
| --- | --- | --- |
| Requests per day | 100 | 10,000 |
| Requests per second | 5 | 10 |
| Matrix coordinates | 100 | 500 |
| Jobs per optimization | 100 | 1,000 |
| Vehicles per optimization | 10 | 50 |

Exceeding a size limit returns `PlanLimitExceededError`; exhausting the daily allowance returns `QuotaExceededError`.

## Examples

Runnable programs live in [`examples/`](./examples):

```shell
npm run build
export JUSTROUTING_API_KEY=<your key>
node examples/route.mjs
node examples/matrix.mjs
node examples/optimization.mjs
```

## Development

```shell
npm install
npm run typecheck
npm run build
npm test
```

The default suite runs entirely against a mocked `fetch` — no network access and no API key.

Integration tests hit a live API and are skipped unless an API key is set:

```shell
JUSTROUTING_API_KEY=<key> npx vitest run test/integration.test.ts
JUSTROUTING_API_KEY=<key> JUSTROUTING_BASE_URL=http://localhost:8080 npx vitest run test/integration.test.ts
```

## License

[MIT](./LICENSE)
