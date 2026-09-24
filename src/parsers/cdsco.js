/**
 * CDSCO QR parser.
 *
 * The Drugs (Eighth Amendment) Rules, 2022 require a QR code on the top 300
 * drug formulations from 1 Aug 2023, carrying: unique product identification
 * code, generic name, brand name, manufacturer name and address, batch number,
 * manufacture date, expiry date and manufacturing licence number.
 *
 * Unlike GS1 it mandates *content*, not *encoding*. Manufacturers ship JSON, a
 * verification URL with query parameters, or delimited key/value text, with no
 * agreed field names. So this parser is deliberately tolerant: it tries each
 * shape, maps a set of key aliases, and keeps what it could not place in
 * `extra` rather than failing.
 *
 * The consequential field is the unique code. The rule says "unique product
 * identification code" and many implementations read that as per-*batch*. A
 * batch-level code is scanned legitimately by thousands of people, so treating
 * one as a serial makes every honest scan look like a clone.
 */

import { ParseError, Scheme, Symbology, makeParsedCode } from './base.js';

/** Key aliases seen across Indian implementations, normalised to our fields. */
const ALIASES = {
  serial: ['uid', 'uniqueid', 'uniquecode', 'serial', 'serialno', 'serialnumber', 'sn'],
  batch: ['batch', 'batchno', 'batchnumber', 'bn', 'lot', 'lotno'],
  expiry: ['exp', 'expiry', 'expirydate', 'expdate', 'dateofexpiry'],
  mfgDate: ['mfg', 'mfd', 'mfgdate', 'manufacturingdate', 'dateofmanufacture'],
  gtin: ['gtin', 'ean', 'productcode'],
  brand: ['brand', 'brandname', 'tradename', 'productname'],
  generic: ['generic', 'genericname', 'salt', 'composition'],
  manufacturer: ['mfr', 'manufacturer', 'manufacturername', 'company'],
  licence: ['lic', 'licence', 'license', 'licenceno', 'licenseno'],
};

const FIELD_BY_ALIAS = Object.fromEntries(
  Object.entries(ALIASES).flatMap(([field, aliases]) => aliases.map((a) => [a, field])),
);

const DELIMITER = /[;|,&\n]/;

const normaliseKey = (key) => key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** Month names, for the `Nov 2027` spelling that appears on Indian packs. */
const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
/** Day 0 of the next month is the last day of this one. */
const endOfMonth = (y, m) => new Date(Date.UTC(y, m, 0));

/** Expand a two-digit year the way a pack date is meant: always this century. */
const expandYear = (yy) => (yy >= 100 ? yy : 2000 + yy);

/**
 * Parse the date spellings Indian packs use.
 *
 * A month-only value (`11/2027`, common for expiry) resolves to the last day
 * of that month, matching the GS1 "end of month" convention so both parsers
 * produce comparable dates.
 *
 * @returns {Date|null}
 */
export function parseLooseDate(value) {
  const text = String(value).trim();
  if (!text) return null;

  // ISO: 2027-11-30
  let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return utc(+m[1], +m[2], +m[3]);

  // Day first: 30-11-2027, 30/11/27
  m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
  if (m) return utc(expandYear(+m[3]), +m[2], +m[1]);

  // Compact: 20271130
  m = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return utc(+m[1], +m[2], +m[3]);

  // Month only, numeric: 11/2027, 11-27
  m = text.match(/^(\d{1,2})[-/](\d{2}|\d{4})$/);
  if (m) return endOfMonth(expandYear(+m[2]), +m[1]);

  // Month only, named: Nov 2027, November-2027
  m = text.match(/^([A-Za-z]{3,})[-\s/](\d{2}|\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (month !== -1) return endOfMonth(expandYear(+m[2]), month + 1);
  }

  return null;
}

/**
 * Pull a flat key/value map out of whichever shape the payload is in.
 * @returns {Record<string,string>}
 */
export function collect(payload) {
  const text = String(payload).trim();
  if (!text) throw new ParseError('empty CDSCO payload');

  // 1. JSON. Arrays are caught here too, so they are rejected as malformed
  //    JSON rather than falling through to the delimited parser.
  if (text.startsWith('{') || text.startsWith('[')) {
    let loaded;
    try {
      loaded = JSON.parse(text);
    } catch (err) {
      throw new ParseError(`payload looks like JSON but does not parse: ${err.message}`);
    }
    if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new ParseError('CDSCO JSON payload must be an object');
    }
    return Object.fromEntries(
      Object.entries(loaded)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
  }

  // 2. Verification URL with query parameters
  if (/^https?:\/\//i.test(text)) {
    const { searchParams } = new URL(text);
    const pairs = Object.fromEntries([...searchParams].filter(([, v]) => v !== ''));
    if (Object.keys(pairs).length === 0) {
      throw new ParseError('verification URL carries no query parameters');
    }
    return pairs;
  }

  // 3. Delimited key=value text
  const pairs = {};
  for (const chunk of text.split(DELIMITER)) {
    const sep = chunk.includes('=') ? '=' : chunk.includes(':') ? ':' : null;
    if (!sep) continue;
    const index = chunk.indexOf(sep);
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key && value) pairs[key] = value;
  }

  if (Object.keys(pairs).length === 0) {
    throw new ParseError(
      `no recognisable key/value pairs in payload: ${JSON.stringify(text.slice(0, 60))}`,
    );
  }
  return pairs;
}

/** Cheap detection, used by the dispatcher. */
export function looksLikeCdsco(payload) {
  const text = String(payload).trim();
  if (text.startsWith('{') || text.startsWith('[') || /^https?:\/\//i.test(text)) {
    return true;
  }
  if (!text.includes('=') && !text.includes(':')) return false;
  try {
    return Object.keys(collect(text)).some((k) => normaliseKey(k) in FIELD_BY_ALIAS);
  } catch {
    return false;
  }
}

/**
 * Parse a CDSCO QR payload into a `ParsedCode`.
 *
 * @param {string} payload
 * @param {{symbology?: string}} [options]
 */
export function parse(payload, { symbology = Symbology.QR_CODE } = {}) {
  const rawFields = collect(payload);
  const warnings = [];

  const mapped = {};
  const extra = {};
  for (const [key, value] of Object.entries(rawFields)) {
    const field = FIELD_BY_ALIAS[normaliseKey(key)];
    if (field && !(field in mapped)) mapped[field] = value;
    else extra[key] = value;
  }

  let expiry = null;
  let mfgDate = null;
  if ('expiry' in mapped) {
    expiry = parseLooseDate(mapped.expiry);
    if (expiry === null) {
      warnings.push(`unrecognised expiry format: ${JSON.stringify(mapped.expiry)}`);
    }
  }
  if ('mfgDate' in mapped) {
    mfgDate = parseLooseDate(mapped.mfgDate);
    if (mfgDate === null) {
      warnings.push(`unrecognised manufacture date format: ${JSON.stringify(mapped.mfgDate)}`);
    }
  }

  if (expiry && mfgDate && expiry < mfgDate) {
    warnings.push('expiry date precedes manufacture date');
  }

  let serial = mapped.serial ?? null;
  const batch = mapped.batch ?? null;

  if (serial === null) {
    warnings.push(
      'no unique code field — treating as batch-level, unit anomaly thresholds must not be applied',
    );
  } else if (batch !== null && serial === batch) {
    // The unique code is the batch number. Per-pack tracking is impossible.
    serial = null;
    warnings.push('unique code equals the batch number — batch-level code, not a serial');
  }

  for (const field of ['brand', 'generic', 'manufacturer', 'licence']) {
    if (field in mapped) extra[field] = mapped[field];
  }

  return makeParsedCode({
    raw: payload,
    symbology,
    scheme: Scheme.CDSCO,
    gtin: mapped.gtin ?? null,
    serial,
    batch,
    expiry,
    mfgDate,
    extra,
    warnings,
  });
}
