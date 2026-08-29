// Assigns deliveries to a small fleet and prints the resulting routes.
//
// Usage:
//
//	JUSTROUTING_API_KEY=<key> node examples/optimization.mjs

import { Client, PlanLimitExceededError } from '../dist/index.js';

const defaultApiKey = 'e7d5c0f6c1da7752488610d21fd80959';

const apiKey = process.env.JUSTROUTING_API_KEY || defaultApiKey;

const client = new Client(apiKey);

const depot = [103.8198, 1.3521];

// Two vans, each able to carry three parcels, working a morning shift.
const shift = [8 * 3600, 12 * 3600];
const vehicles = [
  { id: 1, start: depot, end: depot, capacity: [3], timeWindow: shift },
  { id: 2, start: depot, end: depot, capacity: [3], timeWindow: shift },
];

// Four deliveries, each taking five minutes on site.
const jobs = [
  { id: 1, location: [103.8514, 1.2897], delivery: [1], service: 300 },
  { id: 2, location: [103.9915, 1.3644], delivery: [1], service: 300 },
  { id: 3, location: [103.7649, 1.3329], delivery: [2], service: 300 },
  { id: 4, location: [103.8198, 1.4382], delivery: [1], service: 300 },
];

try {
  // The g flag requests road-following geometry and distances for each
  // route; it costs extra computation, so it is off by default.
  const solution = await client.optimization.solve(
    { vehicles, jobs, options: { geometry: true } },
    { timeout: 60 },
  );

  console.log(
    `cost ${solution.summary.cost}, ${solution.summary.routes} route(s), ${solution.summary.unassigned} unassigned\n`,
  );

  for (const route of solution.routes) {
    console.log(
      `vehicle ${route.vehicle} — ${Math.round(route.duration / 60)} min, ${(route.distance / 1000).toFixed(1)} km`,
    );
    for (const step of route.steps) {
      if (step.type === 'start' || step.type === 'end') {
        console.log(`  ${step.type.padEnd(8)} at ${step.location}`);
      } else {
        console.log(`  ${step.type.padEnd(8)} job ${step.job}, arrive ${Math.round(step.arrival / 60)} min in`);
      }
    }
    console.log();
  }

  for (const task of solution.unassigned) {
    console.log(`unassigned: task ${task.id} at ${task.location}`);
  }
} catch (err) {
  if (err instanceof PlanLimitExceededError) {
    console.error('the fleet or job count exceeds your plan limit');
  } else {
    console.error(err);
  }
  process.exit(1);
}
