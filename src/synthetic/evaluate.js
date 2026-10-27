// How well does the anomaly check catch fraud at the moment of scanning?
//
//   node src/synthetic/evaluate.js                     50,000 packs, seed 7
//   node src/synthetic/evaluate.js --units 20000 --seed 3
//
// This is exit check. baseline.js looks at each pack's whole
// history at once; this replays each pack's scans one at a time, in order, and
// asks judgeScans() what it would have said at that moment — exactly what the
// server does. So it measures what a person scanning would have been told.
//
// The thresholds in src/anomaly.js were chosen while looking at seed 42, so
// they are measured here on another seed: data they have never seen.

import { parseArgs } from 'node:util';

import { judgeScans } from '../anomaly.js';
import { buildWorld } from './generate.js';

// For each scanned pack: was it flagged, and at which of its scans?
export function replay(world) {
  return world.units
    .filter((unit) => unit.scans.length > 0)
    .map((unit) => {
      for (let i = 0; i < unit.scans.length; i++) {
        // Everything before scan i is the history; scan i is "now".
        const result = judgeScans(unit.scans.slice(0, i), unit.scans[i], { shop: unit.shop });
        if (result.verdict === 'CLONE_SUSPECTED' || result.verdict === 'MISMATCH') {
          return { label: unit.label, flaggedAt: i + 1, as: result.verdict };
        }
      }
      // Repacks are not the anomaly check's job: the ledger check refuses an
      // expired batch on every scan. Record whether it would have.
      const expiredWhenScanned = unit.scans.some((s) => s.at > unit.batch.expires);
      return { label: unit.label, flaggedAt: null, expiredWhenScanned };
    });
}

// Per kind of pack: how many were caught, and how early.
export function summarise(outcomes) {
  const kinds = {};
  for (const o of outcomes) {
    const k = (kinds[o.label] ??= { packs: 0, caught: 0, at: [] });
    k.packs++;
    if (o.flaggedAt || o.expiredWhenScanned) k.caught++;
    if (o.flaggedAt) k.at.push(o.flaggedAt);
  }
  for (const k of Object.values(kinds)) {
    k.at.sort((a, b) => a - b);
    k.medianScan = k.at.length ? k.at[Math.floor(k.at.length / 2)] : null;
  }
  return kinds;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { values } = parseArgs({ options: { units: { type: 'string' }, seed: { type: 'string' } } });
  const units = Number(values.units ?? 50000);
  const seed = Number(values.seed ?? 7);

  const world = buildWorld({ units, seed });
  const kinds = summarise(replay(world));
  const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
  const ordinal = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

  console.log(`held-out data: ${units} packs, seed ${seed} (the rules were chosen looking at seed 42)\n`);
  console.log('kind of pack'.padEnd(18) + 'scanned'.padStart(8) + '   caught'.padEnd(12) + '  usually by the');
  for (const [label, name] of [['cloned', 'copied code'], ['diverted', 'diverted'], ['expired_repack', 'expired repack']]) {
    const k = kinds[label];
    if (!k) continue;
    const when = label === 'expired_repack' ? '1st scan (ledger expiry check)' : k.medianScan ? `${ordinal(k.medianScan)} scan` : '—';
    console.log(name.padEnd(18) + String(k.packs).padStart(8) + `   ${pct(k.caught, k.packs)}`.padEnd(12) + `  ${when}`);
  }
  // For a genuine pack, any flag is a false alarm.
  const g = kinds.genuine;
  // Two decimals: a rate like 0.04% must not round down to "0.0%".
  console.log(`\ngenuine packs wrongly flagged: ${g.at.length} of ${g.packs} (${((100 * g.at.length) / g.packs).toFixed(2)}%)`);
}
