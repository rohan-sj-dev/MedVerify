// Builds a pretend supply chain, with fraud mixed in, for Phase 4 to learn from.
//
//   npm run generate                                   20,000 packs
//   node src/synthetic/generate.js --units 50000 --clone-rate 0.04
//
// Use node, not `npm run generate -- ...`, to pass options: PowerShell removes
// the "--" that npm needs, and the options never arrive.
//
// It saves into its own database (.data/synthetic), so the demo registry used
// by the app is not touched. The same --seed always gives the same data.
//
// Every pack gets a label saying what it really is:
//   genuine         a normal pack, sold and scanned near where it was sold
//   cloned          a real pack whose code was copied onto fakes, scanned in other cities
//   diverted        sold far from the pharmacy the registry sent it to (grey market)
//   expired_repack  old stock relabelled with a new date and sold after it expired

import { parseArgs } from 'node:util';

import { openDatabase } from '../db.js';
import { parseCode, serialHash } from '../parsers/index.js';
import { gtin14 } from '../seed.js';
import { DEV_SALT } from '../server.js';
import { CITIES, DAY, PLANTS, createRandom } from './world.js';

export const DEFAULTS = {
  units: 20000,
  cloneRate: 0.04, // share of all packs whose code gets copied
  divertRate: 0.02,
  repackRate: 0.01,
  travelRate: 0.01, // share of scanned genuine packs whose owner later scans it in another city (not fraud)
  unitsPerBatch: 500,
  seed: 42,
};

const DRUGS = [
  { gtin: gtin14('890123456789'), brand: 'Dolo 650', salt: 'Paracetamol', strength: '650 mg' },
  { gtin: gtin14('890123456790'), brand: 'Crocin 650', salt: 'Paracetamol', strength: '650 mg' },
  { gtin: gtin14('890123456791'), brand: 'Calpol 650', salt: 'Paracetamol', strength: '650 mg' },
  { gtin: gtin14('890123456793'), brand: 'Azithral 500', salt: 'Azithromycin', strength: '500 mg' },
  { gtin: gtin14('890123456794'), brand: 'Pan 40', salt: 'Pantoprazole', strength: '40 mg' },
  { gtin: gtin14('890123456795'), brand: 'Telma 40', salt: 'Telmisartan', strength: '40 mg' },
];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const yymmdd = (ms) => isoDay(ms).slice(2).replaceAll('-', '');

// ------------------------------------------------------------- step 1: build

// Everything is built as plain objects first, so it can be checked before saving.
export function buildWorld(options = {}, now = new Date()) {
  const o = { ...DEFAULTS, ...options };
  const random = createRandom(o.seed);
  const today = now.getTime();

  // Six pharmacies scattered within 8 km of each city's centre.
  const pharmacies = CITIES.flatMap((city) =>
    Array.from({ length: 6 }, (_, i) => ({ id: `ph-${city.name.toLowerCase()}-${i + 1}`, city, ...random.near(city, 8) })),
  );
  const pharmaciesIn = (city) => pharmacies.filter((p) => p.city === city);

  // Batches: made sometime in the last 900 days, with a two-year shelf life,
  // so roughly one batch in five has already expired.
  const batches = Array.from({ length: Math.ceil(o.units / o.unitsPerBatch) }, (_, i) => {
    const made = today - random.between(30, 900) * DAY;
    return {
      id: `S${String(i + 1).padStart(5, '0')}`,
      drug: random.pick(DRUGS),
      plant: random.pick(PLANTS),
      made,
      expires: made + 730 * DAY,
      cities: random.shuffle(CITIES).slice(0, random.int(1, 3)), // where this batch is sent
    };
  });

  // Packs: each walks plant -> city depot -> pharmacy -> (maybe) a customer.
  // A step only happens if its date is not in the future.
  const units = Array.from({ length: o.units }, (_, i) => {
    const batch = batches[Math.floor(i / o.unitsPerBatch)];
    const city = random.pick(batch.cities);
    const shop = random.pick(pharmaciesIn(city));
    const shipped = batch.made + random.between(2, 10) * DAY;
    const atShop = shipped + random.between(2, 14) * DAY;
    // One pack in ten never sells and stays on the shelf.
    const sold = random.chance(0.9) ? atShop + random.between(1, 90) * DAY : Infinity;

    return {
      serial: `SY${String(i + 1).padStart(8, '0')}`,
      batch,
      city,
      shop,
      shipped: shipped <= today ? shipped : null,
      atShop: atShop <= today ? atShop : null,
      sold: sold <= today && sold < batch.expires ? sold : null, // nobody sells expired stock honestly
      label: 'genuine',
      scans: [],
    };
  });

  // Choose which packs are fraud: `count` random packs from `pool` that are
  // still genuine, so no pack gets two labels.
  const mark = (pool, count, label) =>
    random.shuffle(pool.filter((u) => u.label === 'genuine')).slice(0, count).forEach((u) => (u.label = label));

  // Copied codes come from packs sold at least 60 days ago, so the copies have time to circulate.
  mark(units.filter((u) => u.sold && u.sold < today - 60 * DAY), Math.round(o.units * o.cloneRate), 'cloned');
  mark(units.filter((u) => u.sold), Math.round(o.units * o.divertRate), 'diverted');
  // Repacks are old stock still on the shelf when its batch expired.
  mark(units.filter((u) => u.atShop && !u.sold && u.batch.expires < today - 15 * DAY), Math.round(o.units * o.repackRate), 'expired_repack');

  // Scans. A device id is "the phone that scanned it". About one scan in
  // seven has no location, because the user said no to location access.
  let phones = 0;
  const newPhone = () => `phone-${++phones}`;
  const nowhere = { lat: null, lon: null };
  const scan = (unit, at, place, phone) => unit.scans.push({ at, ...(random.chance(0.15) ? nowhere : place), phone });

  // A customer scanning their own pack a few times, near where they live.
  const ownerScans = (unit, from, until, where) => {
    const phone = newPhone();
    let at = from + random.between(0, 2) * DAY;
    for (let n = random.pick([1, 1, 1, 2, 2, 3]); n > 0 && at <= until; n--) {
      scan(unit, at, random.near(where, 5), phone);
      at += random.between(0.5, 20) * DAY;
    }
  };

  for (const unit of units) {
    const until = Math.min(today, unit.batch.expires);

    if (unit.label === 'genuine' && unit.sold && random.chance(0.6)) {
      ownerScans(unit, unit.sold, until, unit.shop);
      // A few honest owners travel and scan again elsewhere, days later.
      if (unit.scans.length && random.chance(o.travelRate)) {
        const later = unit.scans.at(-1).at + random.between(2, 30) * DAY;
        if (later <= until) scan(unit, later, random.near(random.pick(CITIES), 5), unit.scans[0].phone);
      }
    }

    if (unit.label === 'cloned') {
      // The real pack is scanned normally by its owner...
      ownerScans(unit, unit.sold, until, unit.shop);
      // ...and copies of its code turn up in other cities, all at about the
      // same time, each fake box scanned by a different phone. Some copies are
      // only on one or two boxes, which is what makes them hard to catch.
      const cities = random.shuffle(CITIES).slice(0, random.int(1, 6));
      const window = random.between(2, 30) * DAY;
      const start = unit.sold + random.between(1, 30) * DAY; // at most 60 days after the sale: never in the future
      for (let n = random.int(1, 40); n > 0; n--) {
        scan(unit, start + random.next() * window, random.near(random.pick(cities), 8), newPhone());
      }
    }

    if (unit.label === 'diverted') {
      // The registry says it went to a pharmacy in one city; it is sold in
      // another, which may be close by (Mumbai to Pune is 120 km).
      const otherCities = CITIES.filter((c) => c !== unit.city);
      ownerScans(unit, unit.sold, until, random.pick(pharmaciesIn(random.pick(otherCities))));
    }

    if (unit.label === 'expired_repack') {
      // Relabelled after expiry and sold near the original pharmacy, at least 10 days after it expired.
      const from = random.between(unit.batch.expires + 10 * DAY, today - 2 * DAY);
      ownerScans(unit, from, today, unit.shop);
    }

    unit.scans.sort((a, b) => a.at - b.at);
  }

  return { options: o, pharmacies, batches, units };
}

// -------------------------------------------------------------- step 2: save

// Insert many rows at once (1,000 per query) — far faster than one at a time.
async function insertRows(db, table, columns, rows) {
  for (let start = 0; start < rows.length; start += 1000) {
    const chunk = rows.slice(start, start + 1000);
    const placeholders = chunk.map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`);
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`, chunk.flat());
  }
}

// What the pack's code says. A repack is printed with a later, fake expiry.
function printedCode(unit) {
  const expiry = unit.label === 'expired_repack' ? unit.batch.expires + 365 * DAY : unit.batch.expires;
  return `(01)${unit.batch.drug.gtin}(17)${yymmdd(expiry)}(10)${unit.batch.id}(21)${unit.serial}`;
}

export async function saveWorld(db, world, { salt = DEV_SALT } = {}) {
  const status = (u) => (u.sold ? 'DISPENSED' : u.atShop ? 'AT_PHARMACY' : u.shipped ? 'IN_TRANSIT' : 'COMMISSIONED');

  // Every pack's code goes through the real parser, exactly as a scan would.
  const codes = world.units.map((u) => parseCode(printedCode(u), 'DATA_MATRIX'));
  const hashes = codes.map((code) => serialHash(code, salt));

  const custody = world.units.flatMap((u, i) => [
    // Each hand-over is recorded where the pack arrived: the city depot, then the pharmacy.
    ...(u.shipped ? [[hashes[i], 'mfr-synthetic', `depot-${u.city.name.toLowerCase()}`, u.city.lat, u.city.lon, new Date(u.shipped).toISOString()]] : []),
    ...(u.atShop ? [[hashes[i], `depot-${u.city.name.toLowerCase()}`, u.shop.id, u.shop.lat, u.shop.lon, new Date(u.atShop).toISOString()]] : []),
  ]);
  const scans = world.units.flatMap((u, i) =>
    u.scans.map((s) => [hashes[i], codes[i].gtin, codes[i].batch, s.lat, s.lon, new Date(s.at).toISOString(), s.phone, 'DATA_MATRIX', 'GS1']),
  );

  await db.transaction(async (tx) => {
    await tx.exec('TRUNCATE agent_results, verdicts, scans, custody_events, synthetic_labels, units, batches, drugs, recalls CASCADE');
    await insertRows(tx, 'drugs', ['gtin', 'brand_name', 'salt', 'strength', 'dosage_form'],
      DRUGS.map((d) => [d.gtin, d.brand, d.salt, d.strength, 'Tablet']));
    await insertRows(tx, 'batches', ['batch_id', 'gtin', 'mfg_date', 'expiry_date', 'plant_code', 'manufacturer_id'],
      world.batches.map((b) => [b.id, b.drug.gtin, isoDay(b.made), isoDay(b.expires), b.plant.name, 'mfr-synthetic']));
    await insertRows(tx, 'units', ['serial_hash', 'batch_id', 'status'],
      world.units.map((u, i) => [hashes[i], u.batch.id, status(u)]));
    await insertRows(tx, 'synthetic_labels', ['serial_hash', 'label'], world.units.map((u, i) => [hashes[i], u.label]));
    await insertRows(tx, 'custody_events', ['serial_hash', 'from_org', 'to_org', 'lat', 'lon', 'occurred_at'], custody);
    await insertRows(tx, 'scans', ['serial_hash', 'gtin', 'batch_id', 'lat', 'lon', 'scanned_at', 'device_id', 'code_format', 'scheme'], scans);
  });

  return { batches: world.batches.length, units: world.units.length, custody: custody.length, scans: scans.length };
}

// ---------------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      units: { type: 'string' },
      'clone-rate': { type: 'string' },
      'divert-rate': { type: 'string' },
      'repack-rate': { type: 'string' },
      seed: { type: 'string' },
    },
  });

  // In PowerShell, `npm run generate -- --units 50000` loses its "--", so npm
  // keeps the flags for itself and only bare numbers arrive here. Say so,
  // rather than guess what the numbers were meant to be.
  if (positionals.length) {
    console.error(`Got values without their names (${positionals.join(' ')}).`);
    console.error('PowerShell removes the "--" in "npm run generate -- ...". Run it with node instead:');
    console.error('  node src/synthetic/generate.js --units 50000 --clone-rate 0.04');
    process.exit(2);
  }

  const options = {
    units: Number(values.units ?? DEFAULTS.units),
    cloneRate: Number(values['clone-rate'] ?? DEFAULTS.cloneRate),
    divertRate: Number(values['divert-rate'] ?? DEFAULTS.divertRate),
    repackRate: Number(values['repack-rate'] ?? DEFAULTS.repackRate),
    seed: Number(values.seed ?? DEFAULTS.seed),
  };

  const started = Date.now();
  const world = buildWorld(options);
  const folder = process.env.DB_DIR ?? '.data/synthetic';
  const db = await openDatabase(folder);
  const counts = await saveWorld(db, world, { salt: process.env.SERIAL_SALT ?? DEV_SALT });
  await db.close();

  const labels = {};
  for (const u of world.units) labels[u.label] = (labels[u.label] ?? 0) + 1;
  console.log(`saved ${counts.units} packs in ${counts.batches} batches, ${counts.custody} hand-overs, ${counts.scans} scans`);
  for (const [label, count] of Object.entries(labels)) console.log(`  ${label.padEnd(15)} ${count}`);
  console.log(`seed ${options.seed} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${folder}`);
}
