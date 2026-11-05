// Reading CDSCO's drug alerts from its website.
//
// CDSCO (India's drug regulator) publishes, every month, lists of drug batches
// found "not of standard quality" (NSQ) and lists of batches found spurious
// (fake). Each list is a PDF linked from one page. This file:
//   1. reads that page to find the list documents
//   2. downloads a document's PDF
//   3. splits the PDF's text into one row per batch

import { extractText, getDocumentProxy } from 'unpdf';

export const SITE = 'https://cdsco.gov.in';
export const ALERTS_PAGE = `${SITE}/opencms/opencms/en/Notifications/nsq-drugs/`;

// Tell the site who is asking. Public, read-only, slow requests.
const HEADERS = { 'user-agent': 'MedVerify research prototype (medicine verification)' };

// Turn odd characters (the page has some mis-encoded ones) into spaces.
const clean = (text) => text.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------- 1. the list page

// Each document on the page looks like:
//   <a href='/…/download_file_division.jsp?num_id=MTI3Mzg='>
//   <span class="font_black"> NSQ ALERT FOR THE MONTH OF April-2025</span> … 2025-May-20</a>
const LINK = /<a href='([^']*download_file_division\.jsp\?num_id=[^']*)'>\s*<span class="font_black">([^<]*)<\/span>[^]*?(\d{4})-([A-Za-z]{3})-(\d{2})/g;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

// The alert documents listed on the page, newest first.
export function listDocuments(html) {
  return [...html.matchAll(LINK)].map(([, href, title, year, month, day]) => ({
    link: SITE + href,
    title: clean(title),
    published: MONTHS[month] ? `${year}-${MONTHS[month]}-${day}` : null,
  }));
}

// --------------------------------------------------------------- 2. download

// The document link returns a small page holding the PDF in an <iframe>;
// the PDF's own address has spaces, which must be encoded.
export function pdfAddress(downloadPage) {
  const src = downloadPage.match(/<iframe src='([^']+)'/)?.[1];
  return src ? SITE + encodeURI(src) : null;
}

export async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

// The text of a PDF, all pages joined.
export async function fetchPdfText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

// ------------------------------------------------------------ 3. table rows

// Each batch is a numbered row: "5. Ceftriaxone … (CEFRITZ S 1.5) 24DH13V 08/2024 …".
// Rows are kept as whole text (upper case, single spaces) rather than split
// into columns, because the column layout differs between lists.
export function splitRows(pdfText, title) {
  const listIsSpurious = /spurious/i.test(title) && !/standard quality/i.test(title);
  return pdfText
    .split(/\n(?=\d{1,4}\.\s)/)
    .map((chunk) => chunk.match(/^(\d{1,4})\.\s+([^]*)$/))
    .filter(Boolean)
    .map(([, rowNo, body]) => {
      const text = clean(body).toUpperCase();
      return { rowNo: Number(rowNo), text, kind: listIsSpurious || /SPURIOUS/.test(text) ? 'spurious' : 'nsq' };
    })
    .filter((row) => row.text.length > 10);
}
