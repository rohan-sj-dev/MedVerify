// Barcode -> product name, from a free public barcode database.
//
// A plain barcode (EAN-13) names a product, not a pack: every strip of
// Itromed-200 carries 8904250608493. Looking it up tells us which medicine the
// barcode belongs to, so the person can check it matches the name on the strip
// and the web agent can search CDSCO's alerts for that medicine.
//
// Source: UPCitemdb's free lookup (no key; about 100 lookups a day per server).
// GS1 India, who issue Indian barcodes, have a lookup too, but it needs an
// access key that they give to retailers, so it is not used here.

const LOOKUP = 'https://api.upcitemdb.com/prod/trial/lookup?upc=';
const TIMEOUT_MS = 8000;

// Results are kept in memory for a day: the same medicine is scanned often,
// and the free lookup allows only about 100 a day. Nothing is written to disk.
const remembered = new Map();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {Promise<{title: string, brand: string|null, source: string} | null>}
 *          null when the database doesn't know the barcode
 */
export async function lookUpBarcode(gtin) {
  const ean = gtin.replace(/^0+(?=\d{13}$)/, ''); // 08904250608493 -> 8904250608493
  const kept = remembered.get(ean);
  if (kept && Date.now() - kept.at < DAY_MS) return kept.product;

  const res = await fetch(LOOKUP + encodeURIComponent(ean), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) throw new Error('the barcode database has had too many lookups today');
  if (!res.ok) throw new Error(`the barcode database answered ${res.status}`);

  const item = (await res.json()).items?.[0];
  const product = item ? { title: item.title, brand: item.brand || null, source: 'UPCitemdb' } : null;
  remembered.set(ean, { at: Date.now(), product });
  return product;
}
