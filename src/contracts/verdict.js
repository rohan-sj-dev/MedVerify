/**
 * The frozen verdict contract.
 *
 * Phase 1 fixes this shape so the app, the agents and the tests can all be
 * built against it independently. Changing it after the client exists means
 * changing the client too, so change it now or not at all.
 *
 * One rule the whole system rests on: `verdict` is computed by deterministic
 * JavaScript in `fusion` (Phase 2). `narrative` is written by an LLM *from*
 * that verdict and can never alter it. Clients render the verdict field and
 * must never parse the narrative.
 */

import { z } from 'zod';

/** What the user is told. */
export const VerdictLevel = z.enum([
  'GENUINE',
  'SUSPECT',
  'COUNTERFEIT',
  /** A valid code that cannot identify a pack — a linear retail barcode. */
  'NOT_SERIALIZED',
]);

/** One agent's own finding, before fusion. */
export const AgentVerdict = z.enum([
  'OK',
  'CLONE_SUSPECTED',
  'NOT_FOUND',
  'RECALLED',
  'EXPIRED',
  'MISMATCH',
  /** No history to judge from. Must never be read as approval. */
  'INSUFFICIENT_DATA',
  'ERROR',
]);

/** Registry lifecycle. Transitions are enforced in Phase 2. */
export const UnitStatus = z.enum([
  'COMMISSIONED',
  'IN_TRANSIT',
  'AT_PHARMACY',
  'DISPENSED',
  'RECALLED',
  /** Set by the Anomaly Agent, not the manufacturer. */
  'SUSPENDED',
]);

/**
 * A single machine-readable finding.
 *
 * Never a pre-written sentence: this is what the Narrator reads, what the UI
 * renders and what an auditor would inspect, so it carries a signal name, a
 * value and a unit.
 */
export const Evidence = z.object({
  signal: z.string().min(1).describe("Stable identifier, e.g. 'geo_velocity'."),
  value: z.union([z.number(), z.string()]).nullable().default(null),
  unit: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
});

/** One agent's contribution to a verdict. */
export const AgentResult = z.object({
  agent: z.string().min(1),
  verdict: AgentVerdict,
  /** Suspicion, 0 = clean. Null when INSUFFICIENT_DATA. */
  score: z.number().min(0).max(1).nullable().default(null),
  /** This finding alone condemns the pack. Vision may never set it. */
  hard_fail: z.boolean().default(false),
  evidence: z.array(Evidence).default([]),
  elapsed_ms: z.number().int().nonnegative().nullable().default(null),
});

export const DrugRef = z.object({
  gtin: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  salt: z.string().nullable().default(null),
  strength: z.string().nullable().default(null),
  form: z.string().nullable().default(null),
  /** Blocks substitution without a doctor. See Phase 6. */
  narrow_therapeutic_index: z.boolean().default(false),
});

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .nullable()
  .default(null);

export const BatchRef = z.object({
  id: z.string().nullable().default(null),
  expiry: isoDateString,
  mfg_date: isoDateString,
  status: UnitStatus.nullable().default(null),
});

export const Alternative = z.object({
  brand: z.string().min(1),
  salt: z.string().min(1),
  strength: z.string().nullable().default(null),
  verified: z.boolean().default(false),
  note: z.string().nullable().default(null),
});

/** The response body of `GET /mock/scan` now, and `POST /scan` from Phase 2. */
export const ScanVerdict = z.object({
  scan_id: z.string().uuid(),
  verdict: VerdictLevel,
  confidence: z.number().min(0).max(1),
  /** False for batch-level codes, where unit thresholds do not apply. */
  unit_level: z.boolean(),
  drug: DrugRef.default({}),
  batch: BatchRef.default({}),
  agents: z.array(AgentResult).default([]),
  /** Written by the LLM from the evidence. Never authoritative. */
  narrative: z.string().nullable().default(null),
  alternatives: z.array(Alternative).default([]),
  warnings: z.array(z.string()).default([]),
  scanned_at: z.string().datetime({ offset: true }),
});

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** The request body of `POST /scan`, from Phase 2. */
export const ScanRequest = z.object({
  payload: z.string().min(1).describe('Raw decoded content of the scanned code.'),
  symbology: z.string().default('UNKNOWN'),
  location: GeoPoint.nullable().default(null),
  /** Hashed client-side; never a raw device identifier. */
  device_id: z.string().nullable().default(null),
  photo_count: z.number().int().nonnegative().default(0),
});

/** The request body of `POST /parse`. */
export const ParseRequest = z.object({
  payload: z.string().min(1),
  symbology: z.string().default('UNKNOWN'),
});

/** The response body of `POST /parse`. The raw serial never leaves the server. */
export const ParseResponse = z.object({
  scheme: z.string(),
  symbology: z.string(),
  gtin: z.string().nullable(),
  batch: z.string().nullable(),
  expiry: isoDateString,
  mfg_date: isoDateString,
  serial_present: z.boolean(),
  serial_hash: z.string().nullable(),
  unit_level: z.boolean(),
  extra: z.record(z.string()),
  warnings: z.array(z.string()),
});

/** Flattened evidence across every agent, for the UI. */
export function reasonsOf(verdict) {
  return verdict.agents.flatMap((agent) => agent.evidence);
}
