// The two checks ("agents") run on every scan. Each one returns:
//   { verdict, score, hard_fail, evidence: [{ signal, detail }] }
// A check only judges. It never decides the final answer — fusion.js does.

import { isoDate } from './parsers/index.js';
import { dayMonthYear, drugName, monthYear, printed } from './format.js';
import { getRecalls } from './ledger.js';

const note = (signal, detail) => ({ signal, value: null, unit: null, detail });

const unsure = (signal, detail) => ({ verdict: 'INSUFFICIENT_DATA', score: null, hard_fail: false, evidence: [note(signal, detail)] });
const notFound = (detail) => ({ verdict: 'NOT_FOUND', score: 1, hard_fail: true, evidence: [note('registry_match', detail)] });

// ------------------------------------------------------------ ledger check
// Does the registry agree with what is printed on the pack?

export function ledgerCheck(code, { unit, batch, drug }, today) {
  if (code.scheme === 'GTIN_ONLY') {
    return unsure('cannot_check', drug
      ? `This barcode identifies ${drugName(drug)}, but carries no serial or batch, so this pack cannot be checked`
      : 'This barcode is not in the drug catalogue');
  }
  if (code.serial === null && code.batch === null) {
    return unsure('cannot_check', 'The code carries neither a serial nor a batch number to look up');
  }

  // Never registered at all.
  if (code.serial !== null && !unit) return notFound('No manufacturer has ever issued this serial number');
  if (!batch) return notFound(`No manufacturer has registered batch ${printed(code.batch)}`);

  // Registered — now look for problems, most serious first.
  // The first problem found decides this check's verdict.
  const problems = [];
  const add = (verdict, score, hard, signal, detail) => problems.push({ verdict, score, hard, evidence: note(signal, detail) });

  if (unit?.status === 'SUSPENDED') {
    add('CLONE_SUSPECTED', 1, true, 'unit_status', 'This serial was suspended after its code was found copied onto other packs');
  }
  if (code.gtin && code.gtin !== batch.gtin) {
    add('MISMATCH', 1, true, 'gtin_mismatch', `This code belongs to ${drugName(drug)}, but the pack is printed with a different product code`);
  }
  if (unit && code.batch && code.batch !== unit.batch_id) {
    add('MISMATCH', 1, true, 'batch_mismatch', `This serial belongs to batch ${unit.batch_id}, but the pack is printed with batch ${printed(code.batch)}`);
  }
  if (batch.status === 'RECALLED' || unit?.status === 'RECALLED') {
    add('RECALLED', 1, false, 'batch_recalled', `Batch ${batch.batch_id} has been recalled`);
  }

  // Packs print the expiry month, so compare 'YYYY-MM' only.
  const printedExpiry = code.expiry ? isoDate(code.expiry) : null;
  if (printedExpiry && printedExpiry.slice(0, 7) !== batch.expiry_date.slice(0, 7)) {
    add('MISMATCH', 0.8, false, 'expiry_mismatch',
      `The pack says it expires ${monthYear(printedExpiry)}, but this batch was registered to expire ${monthYear(batch.expiry_date)}`);
  }
  if (batch.expiry_date < today) {
    add('EXPIRED', 0.9, false, 'expired', `This batch expired on ${dayMonthYear(batch.expiry_date)}`);
  }

  if (problems.length > 0) {
    return {
      verdict: problems[0].verdict,
      score: Math.max(...problems.map((p) => p.score)),
      hard_fail: problems.some((p) => p.hard),
      evidence: problems.map((p) => p.evidence),
    };
  }

  // No problems.
  const evidence = [note('registry_match', unit
    ? `Serial registered to batch ${batch.batch_id} of ${drugName(drug)}, made ${dayMonthYear(batch.mfg_date)}`
    : `Batch ${batch.batch_id} of ${drugName(drug)} is registered, made ${dayMonthYear(batch.mfg_date)}`)];
  if (!unit) evidence.push(note('code_granularity', 'This code is shared by every pack in the batch, so it cannot identify one pack'));
  return { verdict: 'OK', score: 0.02, hard_fail: false, evidence };
}

// ------------------------------------------------------------ recall check
// Has a regulator issued a recall notice for this batch or product?
// A recall is never a hard fail: a recalled medicine is usually genuine but unsafe.

export async function recallCheck(db, code, { batch, drug }) {
  const batchId = batch?.batch_id ?? code.batch;
  const gtin = drug?.gtin ?? code.gtin;
  if (!batchId && !gtin) return unsure('recall_check', 'No batch or product code to check against recall notices');

  const notices = await getRecalls(db, batchId, gtin);
  if (notices.length === 0) {
    const detail = batchId ? `No recall notices for batch ${printed(batchId)}` : 'No recall notices for this product';
    return { verdict: 'OK', score: 0, hard_fail: false, evidence: [note('recall_check', detail)] };
  }

  return {
    verdict: 'RECALLED',
    score: 1,
    hard_fail: false,
    evidence: notices.map((n) =>
      note('recall_notice', `${n.source} ${n.reference}: ${n.reason} (issued ${dayMonthYear(n.issued_at)})`)),
  };
}
