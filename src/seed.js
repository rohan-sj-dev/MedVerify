// Fills the local registry with demo data and writes scannable sample codes.
//
//   npm run seed      (stop the server first: two programs can't share the database folder)
//
// Dates are worked out from today, so the "in date" batch is always in date
// and the "expired" one always expired. Each sample is then checked through
// the real verifier before it is written to samples/index.html.
//
// All products, batches, serials and the recall are made up for the demo.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import bwipjs from 'bwip-js';

import { openDatabase } from './db.js';
import { isoDay } from './format.js';
import { addBatch, addDrug, addRecall, addUnits, changeStatus, recallBatch } from './ledger.js';
import { createNarrator } from './narrator.js';
import { DEV_SALT } from './server.js';
import { createVerifier } from './verify.js';

const MAKER = { org: 'mfr-demo-01', role: 'manufacturer' };
const DISTRIBUTOR = { org: 'dist-pune-01', role: 'distributor' };
const PHARMACY = { org: 'pharm-pune-07', role: 'pharmacy' };
const REGULATOR = { org: 'regulator-demo', role: 'regulator' };

// A GTIN needs a correct check digit, or scanners and barcode makers reject it.
export function gtin14(first12) {
  const sum = [...first12].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return `0${first12}${(10 - (sum % 10)) % 10}`;
}

export const GTIN = {
  DOLO: gtin14('890123456789'),
  CROCIN: gtin14('890123456790'),
  CALPOL: gtin14('890123456791'),
  THYRONORM: gtin14('890123456792'),
};

// Last day of the month, `months` from now, as 'YYYY-MM-DD'.
const monthEnd = (now, months) => isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months + 1, 0)));
const serial = (batchId, n) => `SN${batchId}${String(n).padStart(4, '0')}`;

function batches(now) {
  return [
    { id: 'B4471', gtin: GTIN.DOLO, mfgDate: monthEnd(now, -7), expiryDate: monthEnd(now, 13), units: 12 }, // in date
    { id: 'B3302', gtin: GTIN.DOLO, mfgDate: monthEnd(now, -30), expiryDate: monthEnd(now, -6), units: 2 }, // expired
    { id: 'B5590', gtin: GTIN.CROCIN, mfgDate: monthEnd(now, -9), expiryDate: monthEnd(now, 15), units: 3 }, // recalled
    { id: 'B6120', gtin: GTIN.CALPOL, mfgDate: monthEnd(now, -5), expiryDate: monthEnd(now, 18), units: 0 }, // batch-level code
    { id: 'T1101', gtin: GTIN.THYRONORM, mfgDate: monthEnd(now, -4), expiryDate: monthEnd(now, 20), units: 2 },
  ];
}

export async function seedDemo(db, { salt = DEV_SALT, now = new Date() } = {}) {
  const hash = (text) => createHash('sha256').update(`${text}${salt}`).digest('hex');
  await db.exec('TRUNCATE agent_results, verdicts, scans, custody_events, units, batches, drugs, recalls CASCADE');

  await addDrug(db, { gtin: GTIN.DOLO, brand: 'Dolo 650', salt: 'Paracetamol', strength: '650 mg', form: 'Tablet' });
  await addDrug(db, { gtin: GTIN.CROCIN, brand: 'Crocin 650', salt: 'Paracetamol', strength: '650 mg', form: 'Tablet' });
  await addDrug(db, { gtin: GTIN.CALPOL, brand: 'Calpol 650', salt: 'Paracetamol', strength: '650 mg', form: 'Tablet' });
  await addDrug(db, { gtin: GTIN.THYRONORM, brand: 'Thyronorm 50', salt: 'Levothyroxine', strength: '50 mcg', form: 'Tablet', nti: true });

  for (const b of batches(now)) {
    await addBatch(db, { ...b, manufacturer: MAKER.org }, MAKER);
    const serials = Array.from({ length: b.units }, (_, i) => serial(b.id, i + 1));
    if (serials.length) await addUnits(db, b.id, serials.map(hash), MAKER);
  }

  // Walk packs down the supply chain: factory -> depot (Pune) -> pharmacy (Kothrud).
  // Each hand-over is recorded where the pack arrived, as in the synthetic data.
  const ship = async (batchId, n, dispense) => {
    const h = hash(serial(batchId, n));
    await changeStatus(db, h, 'IN_TRANSIT', MAKER, { toOrg: DISTRIBUTOR.org, lat: 18.5204, lon: 73.8567 });
    await changeStatus(db, h, 'AT_PHARMACY', DISTRIBUTOR, { toOrg: PHARMACY.org, lat: 18.5074, lon: 73.8077 });
    if (dispense) await changeStatus(db, h, 'DISPENSED', PHARMACY);
  };
  for (let n = 1; n <= 4; n++) await ship('B4471', n, true);
  for (let n = 5; n <= 8; n++) await ship('B4471', n, false);
  for (let n = 1; n <= 2; n++) await ship('B3302', n, false);
  for (let n = 1; n <= 3; n++) await ship('B5590', n, false);

  // Date the hand-overs before the scan history below (which goes back 20
  // days), or the timeline check would rightly call those scans impossible.
  await db.query(
    `UPDATE custody_events
        SET occurred_at = $1::timestamptz - CASE to_org WHEN $2 THEN interval '40 days' ELSE interval '30 days' END`,
    [now.toISOString(), DISTRIBUTOR.org],
  );

  await recallBatch(db, 'B5590', REGULATOR);
  await addRecall(db, {
    batchId: 'B5590', gtin: GTIN.CROCIN, source: 'DEMO-REGULATOR', reference: 'DEMO/2026/014',
    reason: 'Demonstration notice: failed dissolution test (not a real recall)', issuedAt: isoDay(now),
  });

  // Scan history, so copy detection (Phase 4) has something to see.
  //   pack 1 — genuine: its owner scanned it twice, at home near the pharmacy
  //   pack 4 — copied: its owner scanned it in Pune, then fake packs with the
  //            same code were scanned in Mumbai, Delhi and Kolkata within half an hour
  const ago = (days, minutes = 0) => new Date(now.getTime() - days * 86400000 + minutes * 60000).toISOString();
  const history = [
    [serial('B4471', 1), ago(20), 18.51, 73.81, 'demo-owner-1'],
    [serial('B4471', 1), ago(12), 18.51, 73.81, 'demo-owner-1'],
    [serial('B4471', 4), ago(10), 18.51, 73.81, 'demo-owner-4'],
    [serial('B4471', 4), ago(2), 19.08, 72.88, 'demo-fake-a'], // Mumbai
    [serial('B4471', 4), ago(2, 12), 28.7, 77.1, 'demo-fake-b'], // Delhi, 12 minutes later
    [serial('B4471', 4), ago(2, 31), 22.57, 88.36, 'demo-fake-c'], // Kolkata
  ];
  for (const [sn, at, lat, lon, phone] of history) {
    await db.query(
      `INSERT INTO scans (serial_hash, gtin, batch_id, lat, lon, scanned_at, device_id, code_format, scheme)
       VALUES ($1, $2, 'B4471', $3, $4, $5, $6, 'DATA_MATRIX', 'GS1')`,
      [hash(sn), GTIN.DOLO, lat, lon, at, phone],
    );
  }
}

// The codes to scan, and the verdict each one must give.
export function demoSamples(now = new Date()) {
  const [current, expired, recalled, batchLevel] = batches(now);
  const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const gs1 = (gtin, expiry, batch, sn) => `(01)${gtin}(17)${yymmdd(expiry)}(10)${batch}(21)${sn}`;
  const mmYYYY = (iso) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

  return [
    { id: 'genuine-serialised', expect: 'GENUINE', symbology: 'DATA_MATRIX', what: 'Issued serial, printed exactly as registered',
      payload: gs1(GTIN.DOLO, current.expiryDate, 'B4471', serial('B4471', 1)) },
    { id: 'genuine-batch-level', expect: 'GENUINE', symbology: 'QR_CODE', what: 'QR with no serial: registered batch, weaker result',
      payload: JSON.stringify({ gtin: GTIN.CALPOL, bn: 'B6120', exp: mmYYYY(batchLevel.expiryDate), brand: 'Calpol 650' }) },
    { id: 'counterfeit-unissued-serial', expect: 'COUNTERFEIT', symbology: 'DATA_MATRIX', what: 'A serial no manufacturer ever issued',
      payload: gs1(GTIN.DOLO, current.expiryDate, 'B4471', serial('B4471', 9999)) },
    { id: 'counterfeit-batch-swap', expect: 'COUNTERFEIT', symbology: 'DATA_MATRIX', what: 'Real serial copied onto a pack printed with another batch',
      payload: gs1(GTIN.DOLO, current.expiryDate, 'B4472', serial('B4471', 2)) },
    { id: 'counterfeit-unregistered-batch', expect: 'COUNTERFEIT', symbology: 'QR_CODE', what: 'QR naming a batch that was never registered',
      payload: JSON.stringify({ gtin: GTIN.CALPOL, bn: 'X0091', exp: mmYYYY(batchLevel.expiryDate) }) },
    { id: 'suspect-relabelled-expiry', expect: 'SUSPECT', symbology: 'DATA_MATRIX', what: 'Real serial, but the printed expiry was pushed out',
      payload: gs1(GTIN.DOLO, monthEnd(now, 25), 'B4471', serial('B4471', 3)) },
    { id: 'suspect-expired', expect: 'SUSPECT', symbology: 'DATA_MATRIX', what: 'Real pack from an expired batch',
      payload: gs1(GTIN.DOLO, expired.expiryDate, 'B3302', serial('B3302', 1)) },
    { id: 'suspect-recalled', expect: 'SUSPECT', symbology: 'DATA_MATRIX', what: 'Real pack from a recalled batch',
      payload: gs1(GTIN.CROCIN, recalled.expiryDate, 'B5590', serial('B5590', 1)) },
    { id: 'suspect-copied-code', expect: 'SUSPECT', symbology: 'DATA_MATRIX', what: 'Real serial whose code was copied: scanned in three cities within half an hour',
      payload: gs1(GTIN.DOLO, current.expiryDate, 'B4471', serial('B4471', 4)) },
    { id: 'not-serialised', expect: 'NOT_SERIALIZED', symbology: 'EAN_13', what: 'Retail barcode: product known, pack not checkable',
      payload: GTIN.DOLO.slice(1) },
  ];
}

// Draw each sample in the format a real pack carries it in.
const BARCODE = {
  DATA_MATRIX: { bcid: 'gs1datamatrix', scale: 4 },
  QR_CODE: { bcid: 'qrcode', scale: 4 },
  EAN_13: { bcid: 'ean13', scale: 3, height: 18, includetext: true },
};

function writeSamplesPage(samples) {
  mkdirSync('samples', { recursive: true });
  const cards = samples.map((s) => `
  <figure class="${s.expect.toLowerCase()}">
    ${bwipjs.toSVG({ ...BARCODE[s.symbology], text: s.payload, paddingwidth: 6, paddingheight: 6 })}
    <figcaption><b>${s.expect.replace('_', ' ')}</b> ${s.what}</figcaption>
  </figure>`);

  writeFileSync('samples/index.html', `<!doctype html><meta charset="utf-8">
<title>MedVerify samples</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f2f4f6; margin: 24px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  figure { margin: 0; background: #fff; border: 1px solid #d3dae1; border-radius: 6px; padding: 12px; }
  svg { width: 100%; height: auto; }
  figcaption { font-size: 13px; margin-top: 8px; }
  .genuine b { color: #1f6b45; } .suspect b { color: #8f6310; }
  .counterfeit b { color: #a8372a; } .not_serialized b { color: #47555f; }
</style>
<h1>MedVerify demo samples</h1>
<p>Scan each code with the app. The coloured word is the verdict it should show.</p>
<main>${cards.join('')}</main>`);
}

// Runs only when started with `npm run seed`.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const salt = process.env.SERIAL_SALT ?? DEV_SALT;
  const now = new Date();
  const db = await openDatabase(process.env.DB_DIR ?? '.data/pglite');
  await seedDemo(db, { salt, now });

  // Check every sample through the real verifier before handing it out.
  const verify = createVerifier({ db, narrator: createNarrator(), salt, now: () => now });
  const samples = demoSamples(now);
  let wrong = 0;
  for (const s of samples) {
    const { verdict } = await verify(s);
    const ok = verdict.verdict === s.expect;
    if (!ok) wrong++;
    console.log(`${ok ? '✓' : '✗'} ${s.id.padEnd(32)} ${verdict.verdict}`);
  }

  writeSamplesPage(samples);
  console.log('wrote samples/index.html');
  await db.close();
  if (wrong) process.exit(1);
}
