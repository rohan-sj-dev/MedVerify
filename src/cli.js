#!/usr/bin/env node
/**
 * Parse a scanned payload from the command line.
 *
 * The Phase 0 exit criterion: point this at a real code from a pharmacy pack
 * and read back its GTIN, batch and expiry.
 *
 *   node src/cli.js "(01)08901234567890(17)271130(10)B4471(21)7A9F2K3M8Q"
 *   node src/cli.js '{"uid":"7A9F2K3M8Q","bn":"B4471","exp":"11/2027"}' QR_CODE
 */

import { ParseError, isoDate, parseCode, serialHash } from './parsers/index.js';

const [payload, symbology = 'UNKNOWN'] = process.argv.slice(2);

if (!payload) {
  console.error('usage: node src/cli.js <payload> [symbology]');
  process.exit(2);
}

// Dev-only. Real deployments read this from the environment; the registry key
// is SHA256(serial + salt) so raw serials are never stored.
const salt = process.env.SERIAL_SALT ?? 'dev-only-salt-change-me';

try {
  const code = parseCode(payload, symbology);
  console.log({
    scheme: code.scheme,
    symbology: code.symbology,
    gtin: code.gtin,
    batch: code.batch,
    expiry: isoDate(code.expiry),
    mfgDate: isoDate(code.mfgDate),
    unitLevel: code.unitLevel,
    serialHash: serialHash(code, salt),
    extra: code.extra,
  });
  for (const warning of code.warnings) console.warn(`warning: ${warning}`);
} catch (err) {
  if (err instanceof ParseError) {
    console.error(`${err.name}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
