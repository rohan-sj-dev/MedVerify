/**
 * Shared types for the code parsers.
 *
 * A scanner gives us two things: the *symbology* it recognised (DataMatrix, QR,
 * EAN-13) and the raw payload. The symbology does not tell us the encoding
 * scheme — a CDSCO QR and a GS1 element string both arrive as `QR_CODE` — so
 * the scheme is detected from the payload itself.
 */

import { createHash } from 'node:crypto';

/** What the scanner recognised. Mirrors ML Kit's barcode format names. */
export const Symbology = Object.freeze({
  DATA_MATRIX: 'DATA_MATRIX',
  QR_CODE: 'QR_CODE',
  EAN_13: 'EAN_13',
  CODE_128: 'CODE_128',
  UNKNOWN: 'UNKNOWN',
});

/** How the payload is encoded, detected from its content. */
export const Scheme = Object.freeze({
  /** GS1 element string with Application Identifiers. */
  GS1: 'GS1',
  /** Indian CDSCO QR payload — JSON, URL or delimited key/value. */
  CDSCO: 'CDSCO',
  /** A bare retail barcode. Identifies a product, never a pack. */
  GTIN_ONLY: 'GTIN_ONLY',
  UNKNOWN: 'UNKNOWN',
});

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * A GS1 Application Identifier that is not in the table.
 *
 * Raised rather than guessed: an unknown AI has an unknown length, so
 * continuing would silently mis-slice every field after it.
 */
export class UnknownApplicationIdentifier extends ParseError {
  constructor(message) {
    super(message);
    this.name = 'UnknownApplicationIdentifier';
  }
}

/**
 * @typedef {object} ParsedCode
 * @property {string}  raw
 * @property {string}  symbology
 * @property {string}  scheme
 * @property {string|null} gtin
 * @property {string|null} serial      The only per-pack field.
 * @property {string|null} batch
 * @property {Date|null}   expiry
 * @property {Date|null}   mfgDate
 * @property {boolean} unitLevel       False for batch-level codes.
 * @property {Record<string,string>} extra
 * @property {string[]} warnings
 */

/**
 * Build the frozen `ParsedCode` shape every caller depends on.
 *
 * `unitLevel` is load-bearing. Many CDSCO QR codes are issued per *batch*, so
 * tens of thousands of genuine packs share one code. Applying unit-level
 * anomaly thresholds to a batch-level code flags every honest scan.
 *
 * @returns {ParsedCode}
 */
export function makeParsedCode({
  raw,
  symbology,
  scheme,
  gtin = null,
  serial = null,
  batch = null,
  expiry = null,
  mfgDate = null,
  extra = {},
  warnings = [],
}) {
  return Object.freeze({
    raw,
    symbology,
    scheme,
    gtin,
    serial,
    batch,
    expiry,
    mfgDate,
    unitLevel: serial !== null,
    extra: Object.freeze({ ...extra }),
    warnings: Object.freeze([...warnings]),
  });
}

/**
 * Registry key. The raw serial is never stored — a readable registry can be
 * enumerated to mint valid-looking codes.
 *
 * @param {ParsedCode} code
 * @param {string} salt
 * @returns {string|null}
 */
export function serialHash(code, salt) {
  if (code.serial === null) return null;
  return createHash('sha256').update(`${code.serial}${salt}`).digest('hex');
}

/** Format a Date as YYYY-MM-DD, for display and tests. */
export function isoDate(value) {
  return value === null ? null : value.toISOString().slice(0, 10);
}

const YYMMDD = /^\d{6}$/;

/**
 * Parse a GS1 `YYMMDD` date.
 *
 * Two GS1 rules a naive date constructor gets wrong:
 *
 *  - `DD` may be `00`, meaning "end of the month".
 *  - The century comes from a sliding window, not a fixed pivot: a two-digit
 *    year more than 50 years ahead is read as the past century.
 *
 * @param {string} value
 * @param {Date} [today] Injectable so the sliding window is testable.
 * @returns {Date}
 */
export function parseGs1Date(value, today = new Date()) {
  if (!YYMMDD.test(value)) {
    throw new ParseError(`not a GS1 YYMMDD date: ${JSON.stringify(value)}`);
  }

  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));

  if (mm < 1 || mm > 12) {
    throw new ParseError(`month out of range in ${JSON.stringify(value)}`);
  }

  const currentYy = today.getUTCFullYear() % 100;
  const century = today.getUTCFullYear() - currentYy;
  const ahead = (yy - currentYy + 100) % 100;
  const year = ahead <= 50 ? century + yy : century + yy - 100;

  if (dd === 0) {
    // "End of month": day 0 of the next month is the last day of this one.
    return new Date(Date.UTC(year, mm, 0));
  }

  const date = new Date(Date.UTC(year, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    throw new ParseError(`invalid GS1 date: ${JSON.stringify(value)}`);
  }
  return date;
}
