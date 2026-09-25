// Searches for an address and prints the matches.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/geocode.mjs

import { Client } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey, { timeout: 10 });

try {
  const resp = await client.geocode.search(
    {
      text: 'Marina Bay Sands, Singapore',
      limit: 5,
      filters: ['countrycode:sg'],
    },
    { timeout: 30 },
  );

  resp.results.forEach((r, i) => {
    const [lon, lat] = r.location();
    console.log(`#${i + 1} ${r.formatted}`);
    console.log(`  Location:   ${lon.toFixed(6)}, ${lat.toFixed(6)}`);
    console.log(`  Type:       ${r.resultType}`);
    console.log(`  Place ID:   ${r.placeId}`);
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
