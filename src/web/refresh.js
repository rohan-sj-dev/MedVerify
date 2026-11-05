// Keeps the web agent's copy of CDSCO's alerts up to date.
//
//   npm run web-refresh          (the server also does this at start and daily)
//
// Downloading PDFs takes seconds each, far too slow to do while someone waits
// for a scan result. So the agent reads the alerts ahead of time, saves the
// rows, and a scan then searches that saved copy instantly.

import { openDatabase } from '../db.js';
import { ALERTS_PAGE, fetchPdfText, fetchText, listDocuments, pdfAddress, splitRows } from './cdsco.js';
import { fetchJson, listAddress, portalMonths, rowText } from './portal.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the alert lists not already saved: the newest `limit` PDFs from
 * cdsco.gov.in (up to July 2025), then every month on CDSCO's portal since.
 * `fetchText`, `fetchPdfText` and `getJson` can be swapped out, so tests
 * never touch the internet. Without `getJson`, the portal is skipped.
 * @returns {{ read: number, rows: number, failed: string[] }}
 */
export async function refreshAlerts(db, { limit = 12, gapMs = 1500, web = { fetchText, fetchPdfText, getJson: fetchJson }, log = console } = {}) {
  // The page is not in date order, so sort it before taking the newest.
  const documents = listDocuments(await web.fetchText(ALERTS_PAGE))
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    .slice(0, limit);
  const { rows: known } = await db.query('SELECT url FROM web_documents');
  const seen = new Set(known.map((r) => r.url));

  const summary = { read: 0, rows: 0, failed: [] };
  for (const doc of documents) {
    if (seen.has(doc.link)) continue;
    try {
      const pdf = pdfAddress(await web.fetchText(doc.link));
      if (!pdf) throw new Error('no PDF on the download page');
      const rows = splitRows(await web.fetchPdfText(pdf), doc.title);

      // One document at a time, all or nothing.
      await db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO web_documents (url, source, title, published, rows_found) VALUES ($1, $2, $3, $4, $5)',
          [doc.link, 'CDSCO', doc.title, doc.published, rows.length],
        );
        for (const row of rows) {
          await tx.query('INSERT INTO web_alert_rows (url, row_no, kind, text) VALUES ($1, $2, $3, $4)',
            [doc.link, row.rowNo, row.kind, row.text]);
        }
      });
      summary.read++;
      summary.rows += rows.length;
      log.log?.(`web agent: read "${doc.title}" (${rows.length} rows)`);
    } catch (err) {
      summary.failed.push(`${doc.title}: ${err.message}`);
    }
    await pause(gapMs); // be gentle with a government website
  }
  if (web.getJson) await refreshPortal(db, { web, seen, summary, gapMs, log });
  return summary;
}

// Each month on CDSCO's portal, as two lists: not of standard quality, and spurious.
async function refreshPortal(db, { web, seen, summary, gapMs, log }) {
  let months;
  try {
    months = await portalMonths(web.getJson);
  } catch (err) {
    summary.failed.push(`CDSCO portal: ${err.message}`);
    return;
  }
  const recent = months.slice(-2); // states keep adding results to the latest months, so read them again
  for (const month of months) {
    for (const kind of ['nsq', 'spurious']) {
      const url = listAddress(kind, month);
      if (seen.has(url) && !recent.includes(month)) continue;
      const title = `CDSCO ${kind === 'nsq' ? 'not of standard quality' : 'spurious drugs'} list for ${new Date(`${month}-01T00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`;
      try {
        const entries = (await web.getJson(url)).aaData ?? [];
        await db.transaction(async (tx) => {
          await tx.query('DELETE FROM web_documents WHERE url = $1', [url]); // replaces an earlier copy of this month
          await tx.query(
            'INSERT INTO web_documents (url, source, title, published, rows_found) VALUES ($1, $2, $3, $4, $5)',
            [url, 'CDSCO portal', title, `${month}-01`, entries.length],
          );
          for (const [i, entry] of entries.entries()) {
            await tx.query('INSERT INTO web_alert_rows (url, row_no, kind, text) VALUES ($1, $2, $3, $4)', [url, i + 1, kind, rowText(entry)]);
          }
        });
        if (!seen.has(url)) summary.read++;
        summary.rows += entries.length;
        log.log?.(`web agent: read "${title}" (${entries.length} rows)`);
      } catch (err) {
        summary.failed.push(`${title}: ${err.message}`);
      }
      await pause(gapMs);
    }
  }
}

// Runs only for `npm run web-refresh`.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const db = await openDatabase(process.env.DB_DIR ?? '.data/pglite');
  const result = await refreshAlerts(db, { limit: Number(process.env.WEB_LIMIT ?? 12) });
  const { rows } = await db.query('SELECT count(*)::int AS documents, sum(rows_found)::int AS rows FROM web_documents');
  console.log(`read ${result.read} new documents (${result.rows} rows); saved in total: ${rows[0].documents} documents, ${rows[0].rows ?? 0} rows`);
  for (const f of result.failed) console.warn(`  could not read: ${f}`);
  await db.close();
}
