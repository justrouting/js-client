// Finds the fastest order to visit a set of points and prints the trip.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/trip.mjs

import { Client } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey, { timeout: 10 });

// Three points around Singapore, all in one country. The engine returns
// the fastest order to visit them, ending where the trip began.
try {
  const resp = await client.trip.getAll(
    {
      coordinates: [
        [103.8198, 1.3521], // Marina Bay
        [103.8514, 1.2897], // Sentosa
        [103.9915, 1.3644], // Changi
      ],
    },
    { timeout: 30 },
  );

  const trip = resp.trips[0];
  console.log(`Distance: ${(trip.distance / 1000).toFixed(1)} km`);
  console.log(`Duration: ${Math.round(trip.duration / 60)} min`);
  console.log(`Legs:     ${trip.legs.length}`);

  // Waypoints are returned in the order the trip visits them.
  console.log(`Order:    ${resp.waypoints.map((wp) => wp.name).join(' -> ')}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
