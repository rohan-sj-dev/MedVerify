/**
 * GS1 element string parser.
 *
 * Handles both forms a pharmaceutical pack produces:
 *
 *   Scanner form — AIs concatenated, variable-length fields terminated by FNC1
 *   (`GS`, 0x1D), optionally prefixed with an AIM symbology identifier:
 *
 *       ]d2010890123456789017271130<GS>10B4471<GS>217A9F2K3M8Q
 *
 *   Human-readable form — the bracketed notation printed under the code:
 *
 *       (01)08901234567890(17)271130(10)B4471(21)7A9F2K3M8Q
 *
 * The hard part is length resolution. Some AIs have a predefined value length
 * and carry no separator; the rest run until the next FNC1 or the end of the
 * string. Get that wrong and every field after it is mis-sliced, so an
 * unrecognised AI throws rather than guesses.
 *
 * The table is deliberately limited to AIs that appear on a medicine pack.
 * Anything else is an explicit failure, not a silent skip.
 */

import {
  ParseError,
  Scheme,
  Symbology,
  UnknownApplicationIdentifier,
  makeParsedCode,
  parseGs1Date,
} from './base.js';

/** FNC1 as it arrives from a scanner. */
export const GS = '\x1d';

// Most scanners emit the real control character; test fixtures and some
// keyboard-wedge scanners substitute a printable placeholder.
const SEPARATOR_ALIASES = ['<GS>', '{GS}', '␝'];

// AIM symbology identifiers a pharma scanner may prepend.
const AIM_PREFIX = /^\](?:d2|Q3|C1|e0|d1|Q1)/;

const BRACKETED = /\((\d{2,4})\)([^(]*)/g;

/**
 * Predefined-length AIs: value length is fixed and no separator follows.
 * @type {Record<string, number>}
 */
const FIXED = {
  '00': 18, // SSCC — shipping container, appears on cartons
  '01': 14, // GTIN
  '02': 14, // GTIN of contained trade items
  11: 6, // production date
  15: 6, // best before
  17: 6, // expiration date
};

/**
 * Variable-length AIs: value runs to the next FNC1 or end of string.
 * Value is the maximum permitted length.
 * @type {Record<string, number>}
 */
const VARIABLE = {
  10: 20, // batch / lot
  21: 20, // SERIAL — the only per-pack field
  30: 8, // count of items
  240: 30, // additional product identification
  710: 20, // national healthcare reimbursement number — India
  711: 20,
  712: 20,
  713: 20,
  714: 20,
};

/**
 * Resolve the AI at `pos`.
 *
 * AIs are 2, 3 or 4 digits with no delimiter, so length is resolved by
 * matching the table shortest-first — a longer read would swallow a short AI
 * plus its data.
 *
 * @returns {{ai: string, length: number|null}} `length` null means variable.
 */
function resolveAi(payload, pos) {
  const two = payload.slice(pos, pos + 2);
  if (two in FIXED) return { ai: two, length: FIXED[two] };
  if (two in VARIABLE) return { ai: two, length: null };

  const three = payload.slice(pos, pos + 3);
  if (three in VARIABLE) return { ai: three, length: null };

  throw new UnknownApplicationIdentifier(
    `unrecognised GS1 Application Identifier at offset ${pos}: ` +
      `${JSON.stringify(payload.slice(pos, pos + 4))}. Only AIs printed on ` +
      `medicine packs are supported.`,
  );
}

/** Strip the AIM prefix and normalise separator spellings to real FNC1. */
export function normalise(payload) {
  let text = payload.trim().replace(AIM_PREFIX, '');
  for (const alias of SEPARATOR_ALIASES) text = text.split(alias).join(GS);
  return text;
}

/** Cheap detection, used by the dispatcher before committing to a parser. */
export function looksLikeGs1(payload) {
  const text = normalise(payload);
  if (!text) return false;
  if (/^\(\d{2,4}\)/.test(text)) return true;
  // A GS1 element string opens with an AI; a pharma pack opens with the GTIN.
  return ['01', '00', '02'].includes(text.slice(0, 2)) && /\d/.test(text.charAt(2));
}

/**
 * Parse a GS1 element string into `{ai: value}`.
 * Accepts either the bracketed human-readable form or the scanner form.
 *
 * @returns {Record<string,string>}
 */
export function parseElements(payload) {
  const text = normalise(payload);
  if (!text) throw new ParseError('empty GS1 payload');

  if (text.includes('(')) {
    const elements = {};
    let consumed = 0;
    BRACKETED.lastIndex = 0;
    for (const match of text.matchAll(BRACKETED)) {
      elements[match[1]] = match[2].trim();
      consumed = match.index + match[0].length;
    }
    if (Object.keys(elements).length === 0) {
      throw new ParseError(`bracketed payload with no AIs: ${JSON.stringify(text)}`);
    }
    if (consumed !== text.length) {
      throw new ParseError(
        `trailing data after last AI: ${JSON.stringify(text.slice(consumed))}`,
      );
    }
    return elements;
  }

  const elements = {};
  let pos = 0;
  while (pos < text.length) {
    if (text[pos] === GS) {
      pos += 1; // stray separator, e.g. doubled by the scanner
      continue;
    }

    const { ai, length } = resolveAi(text, pos);
    pos += ai.length;

    let value;
    if (length === null) {
      let end = text.indexOf(GS, pos);
      if (end === -1) end = text.length;
      value = text.slice(pos, end);
      pos = end < text.length ? end + 1 : text.length;

      const limit = VARIABLE[ai];
      if (value.length > limit) {
        throw new ParseError(
          `AI (${ai}) value exceeds its ${limit}-character maximum: ${JSON.stringify(value)}`,
        );
      }
    } else {
      value = text.slice(pos, pos + length);
      if (value.length < length) {
        throw new ParseError(
          `AI (${ai}) is predefined-length ${length} but only ${value.length} characters remain`,
        );
      }
      pos += length;
    }

    if (!value) throw new ParseError(`AI (${ai}) has an empty value`);
    elements[ai] = value;
  }

  return elements;
}

/**
 * Parse a GS1 payload into a `ParsedCode`.
 *
 * @param {string} payload
 * @param {{symbology?: string, today?: Date}} [options]
 */
export function parse(payload, { symbology = Symbology.DATA_MATRIX, today } = {}) {
  const elements = parseElements(payload);
  const warnings = [];

  const gtin = elements['01'] ?? elements['02'] ?? null;
  if (gtin !== null && !/^\d+$/.test(gtin)) {
    throw new ParseError(`GTIN must be numeric: ${JSON.stringify(gtin)}`);
  }

  const expiry = '17' in elements ? parseGs1Date(elements['17'], today) : null;
  const mfgDate = '11' in elements ? parseGs1Date(elements['11'], today) : null;

  if (expiry && mfgDate && expiry < mfgDate) {
    warnings.push('expiry date precedes manufacture date');
  }

  const serial = elements['21'] ?? null;
  if (serial === null) {
    warnings.push('no AI (21) serial — this code identifies a batch, not a pack');
  }

  const consumed = new Set(['01', '02', '10', '11', '17', '21']);
  const extra = Object.fromEntries(
    Object.entries(elements).filter(([ai]) => !consumed.has(ai)),
  );

  return makeParsedCode({
    raw: payload,
    symbology,
    scheme: Scheme.GS1,
    gtin,
    serial,
    batch: elements['10'] ?? null,
    expiry,
    mfgDate,
    extra,
    warnings,
  });
}
