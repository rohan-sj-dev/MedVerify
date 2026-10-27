// Verifies one scanned pack. This is everything behind POST /scan:
//
//   read the code -> look it up -> run the checks -> decide -> explain
//
// If the registry cannot be read there is no verdict at all, because
// answering without having checked is worse than not answering.

import { randomUUID } from 'node:crypto';

import { anomalyCheck } from './anomaly.js';
import { ledgerCheck, recallCheck } from './checks.js';
import { AgentResult, ScanVerdict } from './contracts/verdict.js';
import { isoDay } from './format.js';
import { fuse } from './fusion.js';
import { getBatch, getDrug, getUnit } from './ledger.js';
import { parseCode, serialHash } from './parsers/index.js';

export class VerificationUnavailable extends Error {}

export function createVerifier({ db, narrator, salt, now = () => new Date() }) {
  return async function verify({ payload, symbology, location = null, device_id = null }) {
    const code = parseCode(payload, symbology); // throws ParseError if the code is unreadable
    const hash = serialHash(code, salt); // null when the code has no serial
    const scannedAt = now();

    // 1. Look the pack up once, so every check sees the same record.
    let record;
    try {
      record = await lookUp(db, code, hash);
    } catch (err) {
      throw new VerificationUnavailable('the registry could not be read', { cause: err });
    }

    // 2. Run the three checks at the same time. The anomaly check also needs
    //    this scan itself: where and when it happened, and on which phone.
    const thisScan = { at: scannedAt.getTime(), lat: location?.lat ?? null, lon: location?.lon ?? null, phone: device_id };
    const results = await Promise.all([
      runCheck('ledger', () => ledgerCheck(code, record, isoDay(scannedAt))),
      runCheck('recall', () => recallCheck(db, code, record)),
      runCheck('anomaly', () => anomalyCheck(db, code, record, thisScan)),
    ]);
    if (results[0].verdict === 'ERROR') throw new VerificationUnavailable('the registry check failed');

    // 3. Decide the verdict, then explain it.
    const decision = fuse(results, { scheme: code.scheme, unitLevel: code.unitLevel });
    const drug = record.drug
      ? { gtin: record.drug.gtin, brand: record.drug.brand_name, salt: record.drug.salt, strength: record.drug.strength,
          form: record.drug.dosage_form, narrow_therapeutic_index: record.drug.narrow_therapeutic_index }
      : { gtin: code.gtin };
    const batch = record.batch
      ? { id: record.batch.batch_id, expiry: record.batch.expiry_date, mfg_date: record.batch.mfg_date, status: record.unit?.status ?? null }
      : {};

    const narrative = await narrator.narrate({
      verdict: decision.verdict,
      unitLevel: code.unitLevel,
      drug,
      batch,
      reason: decision.decidedBy?.evidence[0],
      evidence: results.flatMap((r) => r.evidence),
      warnings: decision.warnings,
    });

    // 4. Shape the answer exactly as the contract says (throws if it does not fit).
    const verdict = ScanVerdict.parse({
      scan_id: randomUUID(),
      verdict: decision.verdict,
      confidence: decision.confidence,
      unit_level: code.unitLevel,
      drug,
      batch,
      agents: results,
      narrative,
      alternatives: [], // Phase 6
      warnings: decision.warnings,
      scanned_at: scannedAt.toISOString(),
    });

    // The server sends the verdict first, then calls save() — logging never slows the answer.
    // Every scan is kept, even unknown serials: the scan log is Phase 4's evidence.
    const save = () => saveScan(db, { verdict, code, hash, location, device_id, scannedAt });
    return { verdict, save };
  };
}

// Find the pack's registry record: its unit, batch and drug (any may be missing).
async function lookUp(db, code, hash) {
  if (code.scheme === 'GTIN_ONLY') {
    return { unit: null, batch: null, drug: await getDrug(db, code.gtin) };
  }
  const unit = hash ? await getUnit(db, hash) : null;
  const batchId = hash ? unit?.batch_id : code.batch; // a serial's batch comes from the registry, not the print
  const batch = batchId ? await getBatch(db, batchId) : null;
  const gtin = batch?.gtin ?? code.gtin;
  return { unit, batch, drug: gtin ? await getDrug(db, gtin) : null };
}

// Run one check. If it crashes, report ERROR instead of crashing the scan.
async function runCheck(agent, check) {
  const started = Date.now();
  try {
    const result = await check();
    return AgentResult.parse({ agent, ...result, elapsed_ms: Date.now() - started });
  } catch (err) {
    console.error(`${agent} check failed:`, err);
    const evidence = [{ signal: 'agent_error', detail: 'This check could not run' }];
    return AgentResult.parse({ agent, verdict: 'ERROR', evidence, elapsed_ms: Date.now() - started });
  }
}

async function saveScan(db, { verdict, code, hash, location, device_id, scannedAt }) {
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO scans (scan_id, serial_hash, gtin, batch_id, lat, lon, scanned_at, device_id, code_format, scheme)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [verdict.scan_id, hash, code.gtin, verdict.batch.id ?? code.batch, location?.lat ?? null, location?.lon ?? null,
        scannedAt, device_id, code.symbology, code.scheme],
    );
    await tx.query(
      'INSERT INTO verdicts (scan_id, level, confidence, unit_level, narrative) VALUES ($1, $2, $3, $4, $5)',
      [verdict.scan_id, verdict.verdict, verdict.confidence, verdict.unit_level, verdict.narrative],
    );
    for (const a of verdict.agents) {
      await tx.query(
        `INSERT INTO agent_results (scan_id, agent_name, verdict, score, hard_fail, evidence, elapsed_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [verdict.scan_id, a.agent, a.verdict, a.score, a.hard_fail, JSON.stringify(a.evidence), a.elapsed_ms],
      );
    }
  });
}
