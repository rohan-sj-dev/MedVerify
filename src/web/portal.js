// CDSCO's alerts since August 2025, from its online portal.
//
// On 28 Aug 2025 CDSCO stopped posting monthly alert PDFs on cdsco.gov.in
// (cdsco.js reads those, up to July 2025) and moved the lists to a searchable
// page, cdscoonline.gov.in/CDSCO/viewPublicNSQDrug. That page loads each
// month's list as JSON from public addresses, the same ones any visitor's
// browser calls. This file asks for each month the same way.
//
// Rows are saved in the same tables and the same text shape as the PDF rows,
// so the web agent searches both alike.

export const PORTAL = 'https://cdscoonline.gov.in/CDSCO';
export const FIRST_MONTH = '2025-08'; // the first month published on the portal

const HEADERS = { 'user-agent': 'MedVerify research prototype (medicine verification)', 'x-requested-with': 'XMLHttpRequest' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return JSON.parse(await res.text());
}

// The months the portal has lists for, from FIRST_MONTH on, oldest first: ['2025-08', …, '2026-09'].
export async function portalMonths(getJson = fetchJson) {
  const years = (await getJson(`${PORTAL}/reportingYears?tab=nsq`)).map(Number).filter((y) => y >= Number(FIRST_MONTH.slice(0, 4)));
  const months = [];
  for (const year of years) {
    for (const name of await getJson(`${PORTAL}/publicReportingMonths?year=${year}&tab=nsq`)) {
      const month = `${year}-${String(MONTHS.indexOf(name) + 1).padStart(2, '0')}`;
      if (MONTHS.includes(name) && month >= FIRST_MONTH) months.push(month);
    }
  }
  return months.sort();
}

// The address of one month's list: kind 'nsq' or 'spurious', month '2026-09'.
export function listAddress(kind, month) {
  const name = `${MONTHS[Number(month.slice(5)) - 1]}-${month.slice(0, 4)}`;
  const table = kind === 'nsq' ? 'filteredNsqDrugTable' : 'filteredSpuriousDrugTable';
  return `${PORTAL}/${table}?month=${name}&source=All&tab=${kind}`;
}

const clean = (value) => String(value ?? '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();

// One portal entry -> one row of text, shaped like a PDF row:
// product (brand), batch, dates, "M/S. maker", and the finding.
export function rowText(entry) {
  const brand = clean(entry.str_brand_name).replace(/^\((.*)\)$/, '$1');
  const product = clean(entry.str_product_name ?? entry.product_name_from_dtl);
  return clean([
    brand ? `${product} (BRAND NAME: ${brand})` : product,
    clean(entry.str_batch_no),
    `MFG ${clean(entry.dt_manufacturing_date)} EXP ${clean(entry.dt_expiry_date)}`,
    `M/S. ${clean(entry.str_manufactured_by)},`,
    clean(entry.str_nsq_result),
    clean(entry.str_nsq_remarks),
    `REPORTED BY ${clean(entry.str_reported_by_lab_or_state)}`,
  ].join(' ')).toUpperCase();
}
