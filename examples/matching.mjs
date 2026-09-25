// Snaps a noisy GPS trace onto the road network and prints the match.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/matching.mjs

import { Client } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey, { timeout: 10 });

// A GPS trace along the East Coast Parkway, from Marina Bay towards
// Changi — points a few kilometres apart, with a little GPS noise.
try {
  const match = await client.mapMatching.get(
    {
      coordinates: [
        [103.823679, 1.355111],
        [103.831810, 1.355074],
        [103.839222, 1.346059],
        [103.856595, 1.343471],
        [103.864702, 1.329605],
        [103.887874, 1.322419],
        [103.928786, 1.335564],
        [103.962769, 1.350345],
        [103.983033, 1.344782],
        [103.990312, 1.361474],
      ],
    },
    { timeout: 30 },
  );

  console.log(`Confidence: ${Math.round(match.confidence * 100)}%`);
  console.log(`Distance:   ${(match.distance / 1000).toFixed(1)} km`);
  console.log(`Duration:   ${Math.round(match.duration / 60)} min`);
  console.log(`Legs:       ${match.legs.length}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
