/**
 * Phase 1 gateway.
 *
 *   GET  /health       liveness
 *   POST /parse        run a payload through the Phase 0 parsers
 *   GET  /mock/scan    canned verdicts conforming to the frozen contract
 *
 * `POST /scan` arrives in Phase 2, when there is a registry to query.
 *
 * Every response is validated against its zod schema before it leaves. That is
 * deliberate belt-and-braces: a fixture or handler that drifts from the
 * contract fails here, loudly, rather than in a client that then renders
 * something wrong about a medicine.
 *
 * Express 5, not 4. In Express 4 an async handler that rejects never reaches
 * the error handler and the request hangs — which here means a user watching a
 * spinner instead of learning their medicine is fake. Express 5 forwards
 * rejections to `next` automatically.
 */

import cors from 'cors';
import express from 'express';

import { CASES, fixture } from './fixtures/verdicts.js';
import { ParseRequest, ParseResponse, ScanVerdict } from './contracts/verdict.js';
import { ParseError, isoDate, parseCode, serialHash } from './parsers/index.js';

const SERIAL_SALT = process.env.SERIAL_SALT ?? 'dev-only-salt-change-me';

/** Map a ParsedCode to the wire shape. The raw serial never leaves the server. */
function toParseResponse(code) {
  return {
    scheme: code.scheme,
    symbology: code.symbology,
    gtin: code.gtin,
    batch: code.batch,
    expiry: isoDate(code.expiry),
    mfg_date: isoDate(code.mfgDate),
    serial_present: code.serial !== null,
    serial_hash: serialHash(code, SERIAL_SALT),
    unit_level: code.unitLevel,
    extra: code.extra,
    warnings: [...code.warnings],
  };
}

export function buildServer() {
  const app = express();

  // The Flutter web build runs on a different origin (flutter run -d chrome
  // serves from a random port), so without this the browser blocks every
  // request and the app reports the gateway as unreachable. Open in
  // development; Phase 2 narrows this to known origins.
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      phase: 1,
      dev_salt_in_use: SERIAL_SALT === 'dev-only-salt-change-me',
      cases: CASES,
    });
  });

  /**
   * Parse a scanned payload without verifying it.
   *
   * Useful on its own: this is how you check a real pack from a pharmacy
   * before any agent exists.
   */
  app.post('/parse', (req, res) => {
    const parsedBody = ParseRequest.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        error: 'invalid_request',
        detail: parsedBody.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const { payload, symbology } = parsedBody.data;
    try {
      const code = parseCode(payload, symbology);
      return res.json(ParseResponse.parse(toParseResponse(code)));
    } catch (err) {
      if (err instanceof ParseError) {
        // 422: the request was well-formed, the payload was not parseable.
        return res.status(422).json({ error: err.name, detail: err.message });
      }
      throw err;
    }
  });

  /** Canned verdicts for the client. Removed in Phase 2. */
  app.get('/mock/scan', (req, res) => {
    const requested = req.query.case ?? 'genuine';
    if (!CASES.includes(requested)) {
      return res.status(404).json({
        error: 'unknown_case',
        detail: `unknown case '${requested}'`,
        cases: CASES,
      });
    }
    return res.json(ScanVerdict.parse(fixture(requested)));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Four arguments, or Express does not recognise it as an error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // A malformed JSON body is the client's fault, not a server fault.
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', detail: 'body is not valid JSON' });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

// Started directly rather than imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer().listen(port, '0.0.0.0', () => {
    console.log(`medverify gateway listening on http://0.0.0.0:${port}`);
  });
}
