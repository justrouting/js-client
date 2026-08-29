// Computes travel times from a depot to several stops.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/matrix.mjs

import { Client } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey);

const depot = [103.8198, 1.3521]; // Marina Bay
const stops = [
  [103.8514, 1.2897], // Marina Barrage
  [103.9915, 1.3644], // Changi Airport
  [103.7649, 1.3329], // Jurong East
];

const coordinates = [depot, ...stops];

// Restricting sources to the depot computes one row instead of the full
// square matrix, which counts against a much smaller plan limit.
const destinations = stops.map((_, i) => i + 1);

try {
  const m = await client.matrix.get(
    { coordinates, sources: [0], destinations },
    { timeout: 30 },
  );

  console.log('From the depot:');
  for (let j = 0; j < stops.length; j++) {
    const seconds = m.duration(0, j);
    if (seconds === null) {
      console.log(`  stop ${j + 1}: unreachable`);
      continue;
    }
    const metres = m.distance(0, j) ?? 0;
    console.log(
      `  stop ${j + 1}: ${(seconds / 60).toFixed(1).padStart(5)} min  ${(metres / 1000).toFixed(1).padStart(6)} km`,
    );
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
