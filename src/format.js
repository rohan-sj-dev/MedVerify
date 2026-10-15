// Small helpers for the sentences shown to a patient.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2027-11-30' -> 'Nov 2027', the way Indian packs print expiry.
export const monthYear = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

// '2026-03-12' -> '12 Mar 2026'
export const dayMonthYear = (iso) => `${Number(iso.slice(8, 10))} ${monthYear(iso)}`;

// A Date -> '2026-10-15' (UTC). Compares correctly with database dates as plain text.
export const isoDay = (date) => date.toISOString().slice(0, 10);

// Text printed on a pack is controlled by whoever made the pack, so before it
// goes into a sentence: remove control characters and cut it to 32 letters.
export function printed(value, max = 32) {
  const clean = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// The medicine's name, or a fallback when it is unknown.
export const drugName = (drug) => drug?.brand_name ?? drug?.brand ?? 'this medicine';
