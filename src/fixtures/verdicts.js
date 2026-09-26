import { randomUUID } from 'node:crypto';

import { ScanVerdict } from '../contracts/verdict.js';

const DOLO = {
  gtin: '08901234567890',
  brand: 'Dolo 650',
  salt: 'Paracetamol',
  strength: '650 mg',
  form: 'Tablet',
  narrow_therapeutic_index: false,
};

const PARACETAMOL_ALTERNATIVES = [
  { brand: 'Crocin 650', salt: 'Paracetamol', strength: '650 mg', verified: true, note: null },
  { brand: 'Calpol 650', salt: 'Paracetamol', strength: '650 mg', verified: true, note: null },
];

const base = () => ({ scan_id: randomUUID(), scanned_at: new Date().toISOString() });

const build = {
  genuine: () => ({
    ...base(),
    verdict: 'GENUINE',
    confidence: 0.97,
    unit_level: true,
    drug: DOLO,
    batch: { id: 'B-4471', expiry: '2027-11-30', mfg_date: '2026-03-12', status: 'DISPENSED' },
    agents: [
      {
        agent: 'ledger',
        verdict: 'OK',
        score: 0.02,
        evidence: [
          {
            signal: 'registry_match',
            detail: 'Registered to batch B-4471, commissioned 12 Mar 2026',
          },
        ],
      },
      {
        agent: 'anomaly',
        verdict: 'OK',
        score: 0.05,
        evidence: [
          { signal: 'scan_count', value: 2, unit: 'scans' },
          { signal: 'hull_area', value: 3.1, unit: 'km2', detail: 'Both scans within Pune' },
        ],
      },
    ],
    narrative:
      'This pack is registered to batch B-4471, which expires in November 2027. It has been ' +
      'scanned twice, both times in Pune, which is what a single genuine pack looks like.',
  }),

  suspect: () => ({
    ...base(),
    verdict: 'SUSPECT',
    confidence: 0.81,
    unit_level: true,
    drug: DOLO,
    batch: { id: 'B-4471', expiry: '2027-11-30' },
    agents: [
      { agent: 'ledger', verdict: 'OK', score: 0.02 },
      {
        agent: 'anomaly',
        verdict: 'CLONE_SUSPECTED',
        score: 0.94,
        evidence: [
          {
            signal: 'geo_velocity',
            value: 1840,
            unit: 'km/h',
            detail: 'Mumbai 09:12 to Delhi 09:34, 21 Sep 2026',
          },
          {
            signal: 'scan_count',
            value: 312,
            unit: 'scans',
            detail: 'expected 1-3 for a unit-level serial',
          },
          {
            signal: 'batch_contagion',
            value: 0.41,
            unit: 'fraction',
            detail: '41% of scanned serials in B-4471 are flagged',
          },
        ],
      },
      { agent: 'vision', verdict: 'INSUFFICIENT_DATA', score: null },
    ],
    narrative:
      'The serial is registered, but this code has been scanned 312 times across seven ' +
      'states. One scan in Mumbai was followed 22 minutes later by a scan in Delhi — the ' +
      'same pack cannot be in both places, so this code has very likely been copied onto ' +
      'other packaging.',
    alternatives: PARACETAMOL_ALTERNATIVES,
  }),

  counterfeit: () => ({
    ...base(),
    verdict: 'COUNTERFEIT',
    confidence: 0.99,
    unit_level: true,
    drug: DOLO,
    batch: {},
    agents: [
      {
        agent: 'ledger',
        verdict: 'NOT_FOUND',
        score: 1.0,
        hard_fail: true,
        evidence: [
          {
            signal: 'registry_match',
            detail: 'No manufacturer has ever issued this serial',
          },
        ],
      },
    ],
    narrative:
      'This serial number was never issued by any registered manufacturer. Do not take this ' +
      'medicine. Return it to the pharmacy you bought it from.',
    alternatives: PARACETAMOL_ALTERNATIVES.slice(0, 1),
  }),

  not_serialized: () => ({
    ...base(),
    verdict: 'NOT_SERIALIZED',
    confidence: 0.0,
    unit_level: false,
    drug: DOLO,
    batch: {},
    agents: [{ agent: 'ledger', verdict: 'INSUFFICIENT_DATA', score: null }],
    narrative:
      'This is a retail barcode. It identifies the product but carries no serial number, so ' +
      'there is no way to check this particular pack.',
    warnings: ['linear barcode — unit verification is not possible'],
  }),

  batch_level: () => ({
    ...base(),
    verdict: 'GENUINE',
    confidence: 0.55,
    unit_level: false,
    drug: DOLO,
    batch: { id: 'B-4471', expiry: '2027-11-30' },
    agents: [
      { agent: 'ledger', verdict: 'OK', score: 0.02 },
      {
        agent: 'anomaly',
        verdict: 'INSUFFICIENT_DATA',
        score: null,
        evidence: [
          {
            signal: 'code_granularity',
            value: 'batch',
            detail: 'This QR is shared by every pack in the batch, so scan patterns cannot identify one pack',
          },
        ],
      },
    ],
    narrative:
      'This batch is registered and in date. The QR on this pack identifies the batch rather ' +
      'than the individual pack, so it cannot be checked for copying — the result is weaker ' +
      'than for a serialised pack.',
  }),
};

export const CASES = Object.keys(build);

/**
 * Build a fixture, validated against the frozen contract.
 * @param {string} name one of CASES
 */
export function fixture(name) {
  const make = build[name];
  if (!make) throw new Error(`unknown fixture case: ${name}`);
  return ScanVerdict.parse(make());
}

// Fail fast at import: a fixture that no longer matches the contract is a bug
// that must surface at startup, not on a client request.
for (const name of CASES) fixture(name);
