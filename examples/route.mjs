// Computes a route between two points and prints its distance.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/route.mjs

import { Client, CrossCountryError } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey, { timeout: 10 });

// Marina Bay to Changi Airport. Every coordinate in a request must lie
// within one country, so both points are in Singapore.
try {
  const route = await client.routes.get(
    {
      origin: [103.8198, 1.3521],
      destination: [103.9915, 1.3644],
      overview: 'full',
    },
    { timeout: 30 },
  );

  console.log(`Distance: ${(route.distance / 1000).toFixed(1)} km`);
  console.log(`Duration: ${Math.round(route.duration / 60)} min`);
  console.log(`Legs:     ${route.legs.length}`);

  try {
    console.log(`Geometry(Polyline): ${route.geometry.polyline()}`);
  } catch {
    // overview=false, or geometries=geojson
  }
} catch (err) {
  if (err instanceof CrossCountryError) {
    console.error('origin and destination must be in the same country');
  } else {
    console.error(err);
  }
  process.exit(1);
}
