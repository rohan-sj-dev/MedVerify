// The pretend world the synthetic supply chain runs in: places, distances,
// and a random number generator that gives the same results for the same seed.

export const DAY = 24 * 60 * 60 * 1000; // milliseconds
export const HOUR = 60 * 60 * 1000;

// Factories, where batches are made.
export const PLANTS = [
  { name: 'Baddi', lat: 30.9578, lon: 76.7914 },
  { name: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
  { name: 'Ahmedabad', lat: 23.0225, lon: 72.5714 },
];

// Cities with a distributor depot and pharmacies around it.
export const CITIES = [
  { name: 'Mumbai', lat: 19.076, lon: 72.8777 },
  { name: 'Delhi', lat: 28.7041, lon: 77.1025 },
  { name: 'Pune', lat: 18.5204, lon: 73.8567 },
  { name: 'Kolkata', lat: 22.5726, lon: 88.3639 },
  { name: 'Chennai', lat: 13.0827, lon: 80.2707 },
  { name: 'Hyderabad', lat: 17.385, lon: 78.4867 },
  { name: 'Lucknow', lat: 26.8467, lon: 80.9462 },
  { name: 'Jaipur', lat: 26.9124, lon: 75.7873 },
];

// Distance between two places, shared with the anomaly check (src/geo.js).
export { distanceKm } from '../geo.js';

// A random generator that repeats exactly for the same seed (mulberry32),
// so a dataset can be rebuilt and an experiment re-run.
export function createRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 0 <= n < 1
  };

  const random = {
    next,
    between: (min, max) => min + next() * (max - min), // any number in [min, max)
    int: (min, max) => Math.floor(random.between(min, max + 1)), // whole number in [min, max]
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (probability) => next() < probability,

    // A copy of `list` in random order (Fisher–Yates).
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },

    // A random point within `km` of a place.
    near(place, km) {
      const distance = km * Math.sqrt(next()); // sqrt spreads points evenly over the circle
      const angle = next() * 2 * Math.PI;
      const dLat = (distance / 111) * Math.cos(angle); // ~111 km per degree of latitude
      const dLon = (distance / (111 * Math.cos((place.lat * Math.PI) / 180))) * Math.sin(angle);
      return { lat: place.lat + dLat, lon: place.lon + dLon };
    },
  };
  return random;
}
