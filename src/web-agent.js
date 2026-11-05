// The web agent: checks the medicine just scanned against the web.
//
// It reads the medicine's name, batch number and barcode from the code and
// does up to three things:
//
//   0. For a plain barcode (EAN-13), looks the barcode up in a public barcode
//      database to find which medicine it belongs to.
//   1. Follows the link in the QR code, if it has one. Indian packs link to
//      either a verification page that checks this pack ("This Product is
//      GENUINE", with its batch and dates), or the maker's website, which
//      lists the batches it made — often a page or two away, sometimes as a
//      CSV file. Pages that fill themselves in with JavaScript are opened in
//      a headless browser (web/browser.js); what they say is read by rules,
//      or by Claude when the rules can't tell (web/reader.js).
//   2. Searches CDSCO's lists of batches found spurious (fake) or not of
//      standard quality. Those lists are downloaded ahead of time
//      (src/web/refresh.js), so this search is instant.
//
// It works without the MedVerify registry, so it can check medicines whose
// makers never registered with MedVerify — most medicines on sale today.
// The registry is used for one thing only: the medicine's name, when neither
// the code nor the barcode database gives one.
//
// Like the other checks, it gives evidence; fusion.js decides the verdict.

import { printed } from './format.js';
import { lookUpBarcode } from './web/barcode.js';
import { fetchPage, findLeads } from './web/link.js';
import { batchOnPage, createReader, readByRules } from './web/reader.js';

const RULES_ONLY = createReader(); // reads pages by rules alone; server.js passes one that can use Claude
const note = (signal, value, detail) => ({ signal, value, unit: null, detail });

// Words that say what form a medicine is, not which medicine it is.
const COMMON = new Set(['TABLET', 'TABLETS', 'CAPSULE', 'CAPSULES', 'INJECTION', 'SYRUP', 'SUSPENSION', 'DROPS', 'CREAM', 'WITH', 'AND']);

// The words of a medicine's name worth searching for: "Dolo 650" -> ["DOLO"].
export function nameWords(...names) {
  const words = names.filter(Boolean).join(' ').toUpperCase().split(/[^A-Z]+/);
  return [...new Set(words.filter((w) => w.length >= 4 && !COMMON.has(w)))];
}

// Does `word` appear in `text` on its own, not inside a longer word or code?
// So batch "B44" does not match a row about batch "B4471".
const asWord = (word) => new RegExp(`(^|[^A-Z0-9])${word.replace(/[^A-Z0-9]/g, (c) => `\\${c}`)}([^A-Z0-9]|$)`);
const wholeWord = (text, word) => asWord(word).test(text);

/**
 * @param code    what the scanner read (Phase 0 parser output)
 * @param record  the registry lookup verify.js already did; only record.drug is used, for the name
 * @param web     how to open a page (plainly, or in a browser), read it, and look up a barcode;
 *                tests pass fakes so they never use the internet. No `render`: no browser is used.
 */
export async function webCheck(db, code, { drug }, { open = fetchPage, lookUp = lookUpBarcode, render = null, reader = RULES_ONLY, phone = null } = {}) {
  const batch = code.batch?.toUpperCase().trim() || null;
  const gtin = code.gtin?.replace(/^0+/, '') || null; // the barcode number, as a page would print it

  // 0. A barcode number but no name, here or in the registry: which medicine is it?
  //    (A plain barcode, or a DataMatrix, which carries a barcode number but no name.)
  const nameInCode = nameWords(code.extra?.brand, code.extra?.generic).length > 0;
  const barcode = gtin && !nameInCode && !drug ? await checkBarcode(gtin, lookUp) : null;

  // The name, from the first place that has one: the QR code, the barcode database, the registry.
  const words = [
    nameWords(code.extra?.brand, code.extra?.generic),
    barcode?.words ?? [],
    nameWords(drug?.brand_name, drug?.salt),
  ].find((w) => w.length > 0) ?? [];

  const link = await checkLink(code, { batch, words, gtin, open, render, reader, phone });
  // A verification page often shows the batch and name itself; search CDSCO's lists for those too.
  const alerts = await searchAlerts(db, batch ?? link?.batch ?? null, words.length ? words : nameWords(link?.product));
  const evidence = [barcode?.note, link?.note, ...alerts.evidence].filter(Boolean);

  // A regulator alert outranks anything the pack's own link says.
  if (alerts.verdict === 'RECALLED') return { ...alerts, evidence: [...alerts.evidence, barcode?.note, link?.note].filter(Boolean) };
  // The pack's own verification page says no, or shows another batch: the pack disagrees with its record.
  if (['link_denies', 'link_batch_differs'].includes(link?.note.signal)) return { verdict: 'MISMATCH', score: 1, hard_fail: false, evidence };
  if (link?.note.signal === 'link_confirms') return { verdict: 'OK', score: 0, hard_fail: false, evidence };
  return { ...alerts, evidence };
}

// ------------------------------------------------------- 0. a plain barcode

async function checkBarcode(gtin, lookUp) {
  try {
    const product = await lookUp(gtin);
    if (!product) {
      return { words: [], note: note('barcode_unknown', gtin, `Barcode ${gtin} is not in the public barcode database, so the medicine it belongs to is unknown`) };
    }
    // The database's text is written by strangers too, so it is cut short like printed text.
    const name = printed(product.title, 80);
    const maker = product.brand ? `, brand ${printed(product.brand)}` : '';
    return {
      words: nameWords(product.title).slice(0, 2), // "Itromed 200 Mg Capsule Itraconazole…" -> ITROMED, ITRACONAZOLE
      note: note('barcode_product', product.source,
        `Barcode ${gtin} belongs to ${name}${maker} (${product.source}). Check that this matches the name on your pack`),
    };
  } catch (err) {
    return { words: [], note: note('barcode_failed', null, `The barcode could not be looked up (${printed(err.message, 60)})`) };
  }
}

// ------------------------------------------------------------ 1. the QR's link

// The link: the whole code if it is a web address, or any field that is one.
const linkIn = (code) =>
  [code.raw, ...Object.values(code.extra ?? {})].map((v) => String(v).trim()).find((v) => /^https?:\/\/\S+$/i.test(v)) ?? null;

const MAX_OPENED = 4; // the QR's page plus at most three pages or files it leads to

// Is this batch on this page (or data file), next to this medicine's name?
// Returns the dates printed after it, for the person to compare, or null.
function findBatch(page, batch, words, gtin) {
  const raw = (page.html || page.text).toUpperCase();
  const at = raw.search(asWord(batch));
  if (at === -1) return null;
  // The row about this batch: the name comes before it, the dates after it.
  const before = raw.slice(Math.max(0, at - 400), at);
  const after = raw.slice(at, at + 160);
  const named = words.length === 0 || words.some((w) => wholeWord(before + after, w)) || (gtin !== null && before.includes(gtin));
  if (!named) return null;
  // "04/2026", "09-27" or "NOV-2027", standing on their own.
  const dates = after.match(/(?<![A-Z0-9])(\d{1,2}[/-]\d{2,4}|[A-Z]{3}[- ]\d{2,4})(?![A-Z0-9])/g)?.slice(0, 2) ?? [];
  return { dates };
}

// Look for the batch on the QR's page; if it isn't there, follow the page to
// the maker's batch list (links about batches, and data files), a few at most.
async function searchSite(first, { batch, words, gtin, open }) {
  const queue = [first];
  const seen = new Set([first.url]);
  while (queue.length > 0) {
    const page = queue.shift();
    const found = findBatch(page, batch, words, gtin);
    if (found) return { page, dates: found.dates };
    const { pages, files } = page.html ? findLeads(page) : { pages: [], files: [] };
    for (const next of [...files, ...pages]) {
      if (seen.size >= MAX_OPENED || seen.has(next)) continue;
      seen.add(next);
      try {
        queue.push(await open(next));
      } catch {
        // one missing page is not a reason to stop looking
      }
    }
  }
  return null;
}

const siteOf = (page) => printed(new URL(page.url).hostname, 60); // the one thing a person can judge, so always shown
const sameBatch = (a, b) => a.toUpperCase().replace(/[^A-Z0-9]/g, '') === b.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Turn what a verification page says into evidence, comparing its batch with the pack's.
function fromReading(reading, page, batch) {
  const site = siteOf(page);
  const shown = reading.batch ? printed(reading.batch.toUpperCase().trim()) : null;
  const quote = printed(reading.quote ?? (reading.says === 'genuine' ? 'genuine' : 'not genuine'), 60);
  const by = reading.by === 'Claude' ? ' (read by Claude)' : '';
  const found = { batch: shown, product: reading.product };

  if (reading.says === 'not_genuine') {
    return { ...found, note: note('link_denies', page.url, `The verification page this QR code opens (${site}) says "${quote}"${by}`) };
  }
  // The maker counts every check, from anyone. That a code was checked before
  // is not proof of a copy; MedVerify's copy check counts the phones instead.
  if (reading.says === 'checked_before') {
    return { ...found, note: note('link_checked_before', page.url,
      `The verification page this QR code opens (${site}) warns that this code was "${quote}"${by}. That happens when the same pack is checked again, and also when its code is copied onto other packs`) };
  }
  // A copied code shows the batch of the pack it was copied from.
  if (batch && shown && !sameBatch(batch, shown)) {
    return { ...found, note: note('link_batch_differs', page.url,
      `The verification page this QR code opens (${site}) says this code belongs to batch ${shown}, but the pack is printed with batch ${printed(batch)}. A code copied from another pack shows that pack's batch`) };
  }
  const details = [
    reading.product && printed(reading.product, 40),
    shown && `batch ${shown}`,
    reading.made && `made ${printed(reading.made, 12)}`,
    reading.expires && `expires ${printed(reading.expires, 12)}`,
  ].filter(Boolean).join(', ');
  return { ...found, note: note('link_confirms', page.url,
    `The verification page this QR code opens (${site}) says "${quote}"${by}${details ? `: ${details}` : ''}. Check that these match your pack`) };
}

// Opening a verification page counts as a check on the maker's side, so the
// same phone re-scanning the same pack reuses the page it saw, for a day,
// instead of adding to the maker's count. Kept in memory only.
const seenPages = new Map(); // "phone link" -> { page, at }
const DAY = 24 * 60 * 60 * 1000;
async function renderOnce(render, address, phone) {
  if (!phone) return render(address);
  const key = `${phone} ${address}`;
  const kept = seenPages.get(key);
  if (kept && Date.now() - kept.at < DAY) return kept.page;
  const page = await render(address);
  seenPages.set(key, { page, at: Date.now() });
  return page;
}

// Returns { note, batch, product } (batch and product as the page shows them), or null with no link.
async function checkLink(code, { batch, words, gtin, open, render, reader, phone }) {
  const address = linkIn(code);
  if (!address) return null;

  let first = null;
  let problem = null;
  try {
    first = await open(address);
  } catch (err) {
    problem = err;
  }

  // 1. The page as the server sends it. Does it give an answer ("This product
  //    is genuine"), or list the batch, perhaps a page or a data file away?
  if (first) {
    const reading = readByRules(first.text);
    if (reading) return fromReading(reading, first, batch);
    if (batch) {
      const listed = await searchSite(first, { batch, words, gtin, open });
      if (listed) {
        const what = words.length ? `${printed(words.join(' '))} batch ${printed(batch)}` : `batch ${printed(batch)}`;
        const dates = listed.dates.length ? ` (dates listed with it: ${listed.dates.map((d) => printed(d)).join(', ')}; check they match your pack)` : '';
        return { batch, product: null, note: note('link_confirms', listed.page.url, `The website this QR code links to (${siteOf(first)}) lists ${what}${dates}`) };
      }
    }
  }

  // 2. Many verification pages fill themselves in with JavaScript, so the
  //    server's copy says only "loading". Open it in a browser, as a phone would.
  let shown = first;
  if (render) {
    try {
      shown = await renderOnce(render, address, phone);
    } catch (err) {
      problem ??= err;
    }
  }
  if (!shown) {
    return { note: note('link_failed', null, `The website this QR code links to could not be opened (${printed(problem.message, 60)})`) };
  }

  // 3. Read what the page says: the rules again, then Claude if they can't tell.
  const reading = await reader.read(shown);
  if (reading) return fromReading(reading, shown, batch);
  const site = siteOf(shown);
  if (batch && shown !== first && findBatch(shown, batch, words, gtin)) {
    return { batch, product: null, note: note('link_confirms', shown.url, `The website this QR code links to (${site}) lists batch ${printed(batch)}`) };
  }

  // Nothing found. With no batch to look for, say what the page shows, to compare with the pack.
  if (!batch) {
    const onPage = batchOnPage(shown.text);
    return onPage
      ? { note: note('link_shows', shown.url, `The page this QR code links to (${site}) shows batch ${printed(onPage)}. Check that it matches the batch printed on your pack`) }
      : { note: note('link_missing', shown.url, `The website this QR code links to (${site}) gives no answer about this pack, and no batch number was given to look for`) };
  }
  const what = words.length ? `${printed(words.join(' '))} batch ${printed(batch)}` : `batch ${printed(batch)}`;
  return { note: note('link_missing', shown.url, `The website this QR code links to (${site}) does not list ${what}`) };
}

// --------------------------------------------------------- 2. CDSCO's alerts

// For the evidence: the product described in a row, i.e. the text before its batch number.
const productIn = (text, batch) => text.slice(0, text.indexOf(batch)).trim().slice(0, 90) || 'a medicine';
const makerIn = (text) => text.match(/M\/S\.?\s*([^,]+)/)?.[1].trim().slice(0, 60) ?? null;
const unsure = (detail) => ({ verdict: 'INSUFFICIENT_DATA', score: null, hard_fail: false, evidence: [note('web_alerts', null, detail)] });

async function searchAlerts(db, batch, words) {
  if (!batch) return unsure('There is no batch number to search for in regulator alerts');
  // The batch is printed by whoever made the pack, so it is cleaned before it
  // goes into any sentence a person reads.
  const shown = printed(batch);

  // Have any alert lists been downloaded at all?
  const { rows: [lists] } = await db.query(
    `SELECT count(*)::int AS n, to_char(min(published), 'Mon YYYY') AS since, to_char(max(published), 'Mon YYYY') AS until
       FROM web_documents WHERE rows_found > 0`,
  );
  if (lists.n === 0) return unsure('Regulator alert lists have not been downloaded yet, so they could not be searched');

  // Rows containing the batch number as a whole word. strpos() is a plain text
  // search: unlike LIKE, a "%" or "_" printed on a pack is not a wildcard.
  const { rows } = await db.query(
    `SELECT r.text, r.kind, d.title, d.url, to_char(d.published, 'DD Mon YYYY') AS published
       FROM web_alert_rows r JOIN web_documents d ON d.url = r.url
      WHERE strpos(r.text, $1) > 0`,
    [batch],
  );
  const hits = rows.filter((r) => wholeWord(r.text, batch));
  const sameMedicine = hits.filter((r) => words.some((w) => wholeWord(r.text, w)));

  // Same batch and same medicine: the regulator has flagged this batch.
  if (sameMedicine.length > 0) {
    return {
      verdict: 'RECALLED',
      score: 1,
      hard_fail: false, // a flagged batch: this pack should not be taken, but it may be real
      evidence: sameMedicine.map((r) => {
        const maker = makerIn(r.text);
        const what = r.kind === 'spurious' ? 'spurious (fake)' : 'not of standard quality';
        // On a spurious list the maker is the one printed on the fake label, not the forger.
        const by = !maker ? '' : r.kind === 'spurious' ? ` labelled as made by ${maker}` : ` by ${maker}`;
        return note('regulator_alert', r.url,
          `CDSCO declared batch ${shown} of ${productIn(r.text, batch)}${by} ${what} (${r.title}, ${r.published})`);
      }),
    };
  }

  // Same batch number, but we don't know the medicine's name to confirm it's this one.
  if (hits.length > 0 && words.length === 0) {
    const r = hits[0];
    return {
      verdict: 'OK',
      score: 0.4,
      hard_fail: false,
      evidence: [note('alert_batch_only', r.url,
        `Batch ${shown} appears in a CDSCO alert for ${productIn(r.text, batch)}. If that is the medicine you have, do not take it`)],
    };
  }

  // Not found. That is no proof the pack is genuine — only that no alert names it.
  return {
    verdict: 'OK',
    score: 0,
    hard_fail: false,
    evidence: [note('web_alerts', lists.n,
      `Batch ${shown} is not on CDSCO's spurious or substandard drug lists (${lists.n} lists, ${lists.since} to ${lists.until})`)],
  };
}
