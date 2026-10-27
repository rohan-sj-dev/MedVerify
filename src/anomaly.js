// The anomaly check ("agent"): does this code's scan history look like one
// real pack, or like a code copied onto fakes?
//
// A real pack is scanned a few times, by one or two phones, near where it was
// sold. A copied code turns up in several places at once, on many phones. The
// registry can't see this — only the scan log can.
//
// judgeScans() makes the decision and is a pure function: scans in, verdict
// out. src/synthetic/evaluate.js replays thousands of synthetic packs through
// it, so what is measured is exactly what runs on a scan.
//
// A copied code gives CLONE_SUSPECTED, which fusion turns into SUSPECT — never
// COUNTERFEIT. A copy means *some* pack with this code is fake, not that this
// one is: the person scanning may be holding the original.

import { distanceKm } from './geo.js';

// The thresholds. Each comes with the reason it is where it is.
export const LIMITS = {
  speedKmh: 900, // faster than an airliner: one pack cannot travel that fast
  phones: 5, // one pack is normally scanned by one or two phones
  spreadKm: 100, // scans further apart than a city...
  spreadPhones: 3, // ...count only with 3+ phones: an owner who travels uses the same phone
  offRouteKm: 200, // first scan this far from its pharmacy: sold outside its supply chain
};

const HOUR = 60 * 60 * 1000;
const note = (signal, value, unit, detail) => ({ signal, value, unit, detail });
const unsure = (detail) => ({ verdict: 'INSUFFICIENT_DATA', score: null, hard_fail: false, evidence: [note('scan_history', null, null, detail)] });

// '25 minutes', '3 hours', '4 days'
function howLong(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 120) return `${minutes} minutes`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

// The fastest the pack would have had to travel between two scans in a row.
// A gap under a minute counts as one minute, so the speed stays finite.
function fastestHop(located) {
  let fastest = null;
  for (let i = 1; i < located.length; i++) {
    const [a, b] = [located[i - 1], located[i]];
    const km = distanceKm(a, b);
    const kmh = km / Math.max((b.at - a.at) / HOUR, 1 / 60);
    if (!fastest || kmh > fastest.kmh) fastest = { kmh, km, ms: b.at - a.at };
  }
  return fastest;
}

/**
 * Decide from the scan history.
 *
 * @param past     earlier scans of this code: [{ at (ms), lat, lon, phone }]
 * @param current  the scan happening now, same shape (lat/lon/phone may be null)
 * @param shop     where the registry delivered the pack: { lat, lon }, or null
 * @param batch    { flagged, scanned }: how many packs of this batch look copied, or null
 */
export function judgeScans(past, current, { shop = null, batch = null } = {}) {
  const scans = [...past, current].sort((a, b) => a.at - b.at);
  const located = scans.filter((s) => s.lat !== null && s.lat !== undefined);
  const phones = new Set(scans.map((s) => s.phone).filter(Boolean)).size;
  const spread = located.length ? Math.max(...located.map((s) => distanceKm(located[0], s))) : 0;
  const fastest = fastestHop(located);
  // Only the true first scan can say where the pack was first used. If it had
  // no location, a later scan elsewhere may just be the owner travelling.
  const fromShop = shop && scans[0].lat != null ? distanceKm(shop, scans[0]) : 0;

  // Look for problems, most serious first. The first one found names the verdict.
  const problems = [];
  const add = (verdict, score, evidence) => problems.push({ verdict, score, evidence });

  if (fastest && fastest.kmh > LIMITS.speedKmh) {
    add('CLONE_SUSPECTED', 0.95, note('geo_velocity', Math.round(fastest.kmh), 'km/h',
      `Scanned ${Math.round(fastest.km)} km apart within ${howLong(fastest.ms)} — one pack cannot travel that fast`));
  }
  if (phones > LIMITS.phones) {
    add('CLONE_SUSPECTED', 0.9, note('phone_count', phones, 'phones',
      `Scanned by ${phones} different phones; one pack is normally scanned by one or two`));
  }
  if (spread > LIMITS.spreadKm && phones >= LIMITS.spreadPhones) {
    add('CLONE_SUSPECTED', 0.8, note('spread', Math.round(spread), 'km',
      `Scanned in places up to ${Math.round(spread)} km apart, by ${phones} phones`));
  }
  if (fromShop > LIMITS.offRouteKm) {
    add('MISMATCH', 0.7, note('off_route', Math.round(fromShop), 'km',
      `First scanned ${Math.round(fromShop)} km from the pharmacy it was delivered to`));
  }

  let result;
  if (problems.length > 0) {
    result = {
      verdict: problems[0].verdict,
      score: Math.max(...problems.map((p) => p.score)),
      hard_fail: false, // a copy proves some pack is fake — not this one
      evidence: problems.map((p) => p.evidence),
    };
  } else if (scans.filter((s) => s.lat != null || s.phone).length < 2) {
    // Nothing to compare: a first scan, or scans with neither a location nor a
    // phone. That is no evidence either way, so it must not count as "fine".
    result = unsure(scans.length === 1
      ? 'This is the first time this code has been scanned, so copying cannot be checked yet'
      : 'Earlier scans of this code had no location or phone, so copying cannot be checked');
  } else {
    const who = phones ? ` by ${phones} phone${phones > 1 ? 's' : ''}` : '';
    result = {
      verdict: 'OK',
      score: 0.05,
      hard_fail: false,
      evidence: [note('scan_history', scans.length, 'scans',
        `Scanned ${scans.length} times${who}, all within ${Math.round(spread)} km — what one pack looks like`)],
    };
  }

  // Batch contagion: if several packs from the same batch have copied codes,
  // counterfeiters have this batch. This pack may be fine, so it only adds a
  // warning (and lowers confidence) — it never makes the verdict worse.
  if (batch && batch.flagged >= 3 && batch.flagged / batch.scanned >= 0.05) {
    result.evidence.push(note('batch_contagion', batch.flagged, 'packs',
      `${batch.flagged} of the ${batch.scanned} scanned packs from this batch have had their codes copied`));
    if (result.verdict === 'OK') result.score = 0.5;
  }
  return result;
}

// ---------------------------------------------------------------- on a scan

// Packs of this batch the anomaly check has already flagged as copied.
const BATCH_SQL = `
  SELECT count(DISTINCT s.serial_hash) FILTER (WHERE r.verdict = 'CLONE_SUSPECTED')::int AS flagged,
         count(DISTINCT s.serial_hash)::int AS scanned
    FROM scans s
    LEFT JOIN agent_results r ON r.scan_id = s.scan_id AND r.agent_name = 'anomaly'
   WHERE s.batch_id = $1 AND s.serial_hash IS NOT NULL`;

// Load this pack's history from the database, then judge it.
// `current` is the scan happening now: { at, lat, lon, phone }.
export async function anomalyCheck(db, code, { unit, batch }, current) {
  if (!code.unitLevel) return unsure('This code is shared by every pack in the batch, so its scans cannot be traced to one pack');
  if (!unit) return unsure('This serial is not registered, so there is no pack to trace');

  const history = await db.query(
    'SELECT scanned_at, lat, lon, device_id FROM scans WHERE serial_hash = $1 ORDER BY scanned_at',
    [unit.serial_hash],
  );
  const shop = await db.query(
    'SELECT lat, lon FROM custody_events WHERE serial_hash = $1 AND lat IS NOT NULL ORDER BY occurred_at DESC LIMIT 1',
    [unit.serial_hash],
  );
  const contagion = await db.query(BATCH_SQL, [batch.batch_id]);

  const past = history.rows.map((r) => ({ at: r.scanned_at.getTime(), lat: r.lat, lon: r.lon, phone: r.device_id }));
  return judgeScans(past, current, { shop: shop.rows[0] ?? null, batch: contagion.rows[0] });
}
