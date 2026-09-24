/**
 * Code parsing — the boundary every later phase depends on.
 *
 * One entry point, `parseCode`, which picks a scheme from the payload and the
 * scanner's symbology. Scheme and symbology are independent: a CDSCO QR and a
 * GS1 element string both arrive as `QR_CODE`.
 */

import * as cdsco from './cdsco.js';
import * as gs1 from './gs1.js';
import {
  ParseError,
  Scheme,
  Symbology,
  UnknownApplicationIdentifier,
  isoDate,
  makeParsedCode,
  parseGs1Date,
  serialHash,
} from './base.js';

export {
  ParseError,
  Scheme,
  Symbology,
  UnknownApplicationIdentifier,
  cdsco,
  gs1,
  isoDate,
  parseGs1Date,
  serialHash,
};

const LINEAR = new Set([Symbology.EAN_13, Symbology.CODE_128]);

/**
 * Parse a scanned payload.
 *
 * A linear retail barcode returns `Scheme.GTIN_ONLY` rather than throwing: it
 * is a perfectly valid code that simply cannot identify a pack, and the app
 * has to say so rather than report a failure.
 *
 * @param {string} payload Raw decoded content of the scanned code.
 * @param {string} [symbology] ML Kit barcode format name.
 * @param {{today?: Date}} [options]
 * @returns {import('./base.js').ParsedCode}
 */
export function parseCode(payload, symbology = Symbology.UNKNOWN, { today } = {}) {
  const format = symbology in Symbology ? symbology : Symbology.UNKNOWN;
  const text = String(payload ?? '').trim();
  if (!text) throw new ParseError('empty payload');

  const looksLinear =
    format === Symbology.UNKNOWN && /^\d+$/.test(text) && [8, 12, 13, 14].includes(text.length);

  if (LINEAR.has(format) || looksLinear) {
    return makeParsedCode({
      raw: payload,
      symbology: format === Symbology.UNKNOWN ? Symbology.EAN_13 : format,
      scheme: Scheme.GTIN_ONLY,
      gtin: /^\d+$/.test(text) ? text.padStart(14, '0') : null,
      warnings: [
        'linear barcode — identifies the product, not this pack; unit verification is not possible',
      ],
    });
  }

  if (gs1.looksLikeGs1(text)) {
    return gs1.parse(payload, {
      symbology: format === Symbology.UNKNOWN ? Symbology.DATA_MATRIX : format,
      today,
    });
  }

  if (cdsco.looksLikeCdsco(text)) {
    return cdsco.parse(payload, {
      symbology: format === Symbology.UNKNOWN ? Symbology.QR_CODE : format,
    });
  }

  throw new ParseError(
    `payload matches no known scheme (GS1, CDSCO, linear): ${JSON.stringify(text.slice(0, 60))}`,
  );
}
