// How well do simple hand-written rules catch each kind of fraud?
//
//   npm run baseline          (after `npm run generate`)
//
// This is the Phase 3 exit check, and the bar Phase 4 has to beat. For every
// scanned pack it measures a few facts from the scan log, applies one rule
// per fact, and compares the result with the pack's true label.

import { openDatabase } from '../db.js';

// One row per scanned pack, with the facts the rules use.
const FEATURES_SQL = `
  WITH counts AS (
    -- every scan counts here, with or without a location
    SELECT serial_hash,
           count(*)::int                  AS scans,
           count(DISTINCT device_id)::int AS phones,
           max(scanned_at)                AS last_at
      FROM scans
     WHERE serial_hash IS NOT NULL
     GROUP BY serial_hash
  ),
  located AS (
    -- only scans with a location; each one next to the located scan just before it
    SELECT serial_hash, lat, lon, scanned_at,
           LAG(lat) OVER w AS prev_lat, LAG(lon) OVER w AS prev_lon, LAG(scanned_at) OVER w AS prev_at
      FROM scans
     WHERE serial_hash IS NOT NULL AND lat IS NOT NULL
    WINDOW w AS (PARTITION BY serial_hash ORDER BY scanned_at)
  ),
  geo AS (
    SELECT serial_hash,
           -- fastest the pack would have had to travel between two scans in a row
           -- (a gap under a minute counts as one minute, so the speed stays finite)
           coalesce(max(km(prev_lat, prev_lon, lat, lon)
                        / greatest(extract(epoch FROM scanned_at - prev_at) / 3600, 1.0 / 60)), 0) AS max_kmh,
           (array_agg(lat ORDER BY scanned_at))[1] AS first_lat,
           (array_agg(lon ORDER BY scanned_at))[1] AS first_lon
      FROM located
     GROUP BY serial_hash
  ),
  shop AS (
    -- where the registry says the pack was last delivered (its pharmacy)
    SELECT DISTINCT ON (serial_hash) serial_hash, lat, lon
      FROM custody_events
     ORDER BY serial_hash, occurred_at DESC
  )
  SELECT c.serial_hash, c.scans, c.phones,
         coalesce(g.max_kmh, 0) AS max_kmh,
         -- furthest any located scan is from the first one
         (SELECT max(km(g.first_lat, g.first_lon, s.lat, s.lon))
            FROM scans s WHERE s.serial_hash = c.serial_hash AND s.lat IS NOT NULL) AS spread_km,
         km(shop.lat, shop.lon, g.first_lat, g.first_lon) AS km_from_shop,
         c.last_at::date > b.expiry_date AS after_expiry,
         l.label
    FROM counts c
    JOIN units u ON u.serial_hash = c.serial_hash
    JOIN batches b ON b.batch_id = u.batch_id
    LEFT JOIN geo g ON g.serial_hash = c.serial_hash
    LEFT JOIN shop ON shop.serial_hash = c.serial_hash
    LEFT JOIN synthetic_labels l ON l.serial_hash = c.serial_hash
`;

// One simple rule per fact, each aimed at one kind of fraud.
export const RULES = [
  { name: 'moved faster than 900 km/h between scans', catches: 'cloned', flags: (f) => f.max_kmh > 900 },
  { name: 'scanned by more than 5 phones', catches: 'cloned', flags: (f) => f.phones > 5 },
  { name: 'scans spread over more than 100 km', catches: 'cloned', flags: (f) => f.spread_km > 100 },
  { name: 'first scanned 200+ km from its pharmacy', catches: 'diverted', flags: (f) => f.km_from_shop > 200 },
  { name: 'scanned after its batch expired', catches: 'expired_repack', flags: (f) => f.after_expiry },
];

export async function packFacts(db) {
  return (await db.query(FEATURES_SQL)).rows;
}

// For each rule: what share of its target fraud it catches, and what share
// of genuine packs it wrongly flags.
export function scoreRules(facts) {
  const genuine = facts.filter((f) => f.label === 'genuine');
  return RULES.map((rule) => {
    const targets = facts.filter((f) => f.label === rule.catches);
    return {
      rule: rule.name,
      catches: rule.catches,
      caught: targets.filter(rule.flags).length,
      of: targets.length,
      falseAlarms: genuine.filter(rule.flags).length,
      genuine: genuine.length,
    };
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const db = await openDatabase(process.env.DB_DIR ?? '.data/synthetic');
  const facts = await packFacts(db);
  await db.close();
  if (facts.length === 0) {
    console.error('no scans found — run `npm run generate` first');
    process.exit(1);
  }

  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—').padStart(6);
  console.log(`${facts.length} scanned packs\n`);
  console.log('rule'.padEnd(44) + 'aimed at'.padEnd(16) + 'catches   wrongly flags genuine');
  for (const s of scoreRules(facts)) {
    console.log(
      s.rule.padEnd(44) + s.catches.padEnd(16) +
      `${pct(s.caught, s.of)} (${s.caught}/${s.of})`.padEnd(18) + `${pct(s.falseAlarms, s.genuine)} (${s.falseAlarms})`,
    );
  }
}
