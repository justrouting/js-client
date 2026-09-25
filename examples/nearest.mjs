// Finds the road segment closest to a coordinate and prints it.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/nearest.mjs

import { Client } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey, { timeout: 10 });

try {
  const wp = await client.nearest.get(
    { coordinate: [103.8198, 1.3521] },
    { timeout: 30 },
  );

  console.log(`Street:   ${wp.name}`);
  console.log(`Location: ${wp.location[0].toFixed(6)}, ${wp.location[1].toFixed(6)}`);
  console.log(`Distance: ${Math.round(wp.distance)} m`);
  if (wp.nodes && wp.nodes.length > 0) {
    console.log(`Nodes:    [${wp.nodes.join(' ')}]`);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
