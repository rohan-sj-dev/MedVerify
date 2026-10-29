// Decides the final verdict from the check results (Plate 6).
//
// This is the only place a verdict is decided, and no language model is
// involved: same inputs, same answer, every time. Rules are checked from most
// serious to least, and the first one that matches wins.

export function fuse(results, { scheme, unitLevel }) {
  const ledger = results.find((r) => r.agent === 'ledger');
  const anomaly = results.find((r) => r.agent === 'anomaly'); // arrives in Phase 4
  const first = (verdict) => results.find((r) => r.verdict === verdict);
  const decide = (verdict, confidence, decidedBy, warnings = []) => ({ verdict, confidence, decidedBy, warnings });

  // 1. A code that cannot identify a pack has nothing to verify.
  if (scheme === 'GTIN_ONLY' || ledger?.verdict === 'INSUFFICIENT_DATA') {
    return decide('NOT_SERIALIZED', 0, ledger, ['This code identifies the product, not this pack, so the pack itself cannot be checked.']);
  }

  // 2. A hard fail condemns on its own. Vision may only ever raise suspicion.
  const hardFail = results.find((r) => r.hard_fail && r.agent !== 'vision');
  if (hardFail) return decide('COUNTERFEIT', hardFail.verdict === 'NOT_FOUND' ? 0.99 : 0.95, hardFail);

  // 3. Recalled, expired, or the pack disagrees with its record.
  //    A recall is SUSPECT, not COUNTERFEIT: the medicine is usually real but unsafe.
  if (first('RECALLED')) return decide('SUSPECT', 0.95, first('RECALLED'));
  if (first('EXPIRED')) return decide('SUSPECT', 0.9, first('EXPIRED'));
  if (first('MISMATCH')) return decide('SUSPECT', 0.8, first('MISMATCH'));

  // 4. The scan pattern, or the registry's timeline, says the code was copied (Phase 4).
  const diverted = anomaly?.verdict === 'DIVERTED';
  if (anomaly && !diverted && (anomaly.verdict === 'CLONE_SUSPECTED' || anomaly.score > 0.75)) {
    return decide('SUSPECT', Math.max(0.7, anomaly.score), anomaly);
  }

  // 5. Sold far outside the supply chain it was registered to. Often real
  //    medicine, but nobody can vouch for its storage or handling since it left
  //    that chain, so it stays SUSPECT. The warning says why it differs from a
  //    copy; regulators find these in agent_results.
  if (diverted) {
    return decide('SUSPECT', 0.7, anomaly, [
      'The serial is registered and shows no sign of copying, but this pack was sold far from the pharmacy it was supplied to, outside its approved supply chain. How it was stored and handled since then cannot be checked.',
    ]);
  }

  // 6. Passed every check that ran. Lower the confidence for whatever could not run.
  let confidence = 0.97;
  const warnings = [];
  if (!unitLevel) {
    confidence = 0.55;
    warnings.push('This code is shared by every pack in the batch, so it cannot show whether this pack is a copy.');
  } else if (!anomaly) {
    confidence = 0.75;
    warnings.push('Copy detection did not run, so this confirms the serial was issued, not that this pack is the original.');
  } else if (anomaly.verdict === 'INSUFFICIENT_DATA') {
    confidence = 0.75;
    warnings.push('This code has too few scans so far to check it for copying.');
  }
  // Copies of other codes from this batch are circulating. Not a verdict on this pack.
  if (anomaly?.evidence.some((e) => e.signal === 'batch_contagion')) {
    confidence = Math.min(confidence, 0.6);
    warnings.push('Codes from other packs in this batch have been copied. This pack shows no sign of it, but check the packaging carefully.');
  }
  for (const r of results.filter((r) => r.verdict === 'ERROR')) {
    confidence = Math.min(confidence, 0.6);
    warnings.push(`The ${r.agent} check could not run, so this result is weaker than usual.`);
  }
  return decide('GENUINE', confidence, ledger, warnings);
}
