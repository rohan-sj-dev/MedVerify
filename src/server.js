// The HTTP API the app talks to.
//
//   GET  /health      is the server up?
//   POST /parse       read a code without verifying it
//   POST /scan        verify a pack against the registry  (the real thing)
//   GET  /mock/scan   example verdicts for the app's example screens

import express from 'express';

import { ParseRequest, ParseResponse, ScanRequest, ScanVerdict } from './contracts/verdict.js';
import { openDatabase } from './db.js';
import { CASES, fixture } from './fixtures/verdicts.js';
import { narratorFromEnv } from './narrator.js';
import { ParseError, isoDate, parseCode, serialHash } from './parsers/index.js';
import { VerificationUnavailable, createVerifier } from './verify.js';
import { browserPath, closeBrowser, renderPage } from './web/browser.js';
import { readerFromEnv } from './web/reader.js';
import { refreshAlerts } from './web/refresh.js';

export const DEV_SALT = 'dev-only-salt-change-me';
const SERIAL_SALT = process.env.SERIAL_SALT ?? DEV_SALT;

// zod's error list, as short "field: problem" strings.
const problems = (error) => error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

// Without `verify`, POST /scan answers 503 — parsing and the example screens still work.
export function buildServer({ verify = null, log = console } = {}) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      phase: 4,
      dev_salt_in_use: SERIAL_SALT === DEV_SALT,
      verification: verify ? 'ready' : 'unavailable',
      cases: CASES,
    });
  });

  // Read a code without verifying it. The raw serial never leaves the server, only its hash.
  app.post('/parse', (req, res) => {
    const body = ParseRequest.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_request', detail: problems(body.error) });

    try {
      const code = parseCode(body.data.payload, body.data.symbology);
      return res.json(ParseResponse.parse({
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
      }));
    } catch (err) {
      if (err instanceof ParseError) return res.status(422).json({ error: err.name, detail: err.message });
      throw err;
    }
  });

  // Verify a pack. 422 if the code can't be read, 503 if the registry can't be — never a guess.
  app.post('/scan', async (req, res) => {
    const body = ScanRequest.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_request', detail: problems(body.error) });
    if (!verify) return res.status(503).json({ error: 'verification_unavailable', detail: 'No registry is configured.' });

    try {
      const { verdict, save } = await verify(body.data);
      res.json(verdict);
      save().catch((err) => log.error('could not save the scan:', err)); // after replying
    } catch (err) {
      if (err instanceof ParseError) return res.status(422).json({ error: err.name, detail: err.message });
      if (err instanceof VerificationUnavailable) {
        log.error(err.message, err.cause ?? '');
        return res.status(503).json({ error: 'verification_unavailable', detail: 'Verification is unavailable right now. Try again shortly.' });
      }
      throw err;
    }
  });

  // Example verdicts for the app's example screens. Not used when scanning.
  app.get('/mock/scan', (req, res) => {
    const requested = req.query.case ?? 'genuine';
    if (!CASES.includes(requested)) {
      return res.status(404).json({ error: 'unknown_case', detail: `unknown case '${requested}'`, cases: CASES });
    }
    return res.json(ScanVerdict.parse(fixture(requested)));
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // Express recognises an error handler by its four arguments.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', detail: 'body is not valid JSON' });
    }
    log.error(err);
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

// Runs only when started with `node src/server.js`, not when a test imports this file.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const db = await openDatabase(process.env.DB_DIR ?? '.data/pglite');
  const narrator = narratorFromEnv();
  // The web agent opens pages that need JavaScript in Chrome or Edge, if this machine has one,
  // and lets Claude read pages its rules can't, if an API key is set.
  const reader = readerFromEnv();
  const render = browserPath() ? renderPage : null;
  const verify = createVerifier({ db, narrator, salt: SERIAL_SALT, web: { render, reader } });
  console.log(`web agent: browser ${browserPath() ?? 'none (set CHROME_PATH)'} · pages read by ${reader.usesClaude ? 'rules, then Claude' : 'rules only'}`);

  const { rows } = await db.query('SELECT count(*)::int AS units FROM units');
  console.log(`registry: ${rows[0].units} units · explanations: ${narrator.source}`);
  if (rows[0].units === 0) console.warn('registry is empty — stop the server and run `npm run seed`');

  const port = Number(process.env.PORT ?? 3000);
  const server = buildServer({ verify }).listen(port, '0.0.0.0', () => {
    console.log(`medverify gateway listening on http://0.0.0.0:${port}`);
  });

  // The web agent's copy of CDSCO's alerts: refresh now and then daily, in the
  // background, so scanning never waits for it. WEB_AGENT=off skips this.
  if (process.env.WEB_AGENT !== 'off') {
    const refresh = () =>
      refreshAlerts(db, { log: { log() {} } })
        .then((r) => console.log(`web agent: ${r.read} new alert lists (${r.rows} rows)${r.failed.length ? `, ${r.failed.length} failed` : ''}`))
        .catch((err) => console.warn(`web agent: could not reach CDSCO (${err.message})`));
    refresh();
    setInterval(refresh, 24 * 60 * 60 * 1000).unref();
  }

  // PGlite saves to disk, so close it cleanly on Ctrl+C.
  process.on('SIGINT', () => server.close(() => closeBrowser().then(() => db.close()).finally(() => process.exit(0))));
}
