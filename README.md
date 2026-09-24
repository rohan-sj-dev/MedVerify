# MedVerify

Counterfeit medicine detection: scan a pack, check its code against a manufacturer registry,
test its scan history for physical impossibility, explain the verdict in plain language.

---

## Quick start

```bash
npm install
npm test

# parse a real code from a pharmacy pack
npm run parse -- "(01)08901234567890(17)271130(10)B4471(21)7A9F2K3M8Q"
npm run parse -- '{"uid":"7A9F2K3M8Q","bn":"B4471","exp":"11/2027"}' QR_CODE
npm run parse -- "8901234567890" EAN_13
```

```
{
  scheme: 'GS1',
  symbology: 'DATA_MATRIX',
  gtin: '08901234567890',
  batch: 'B4471',
  expiry: '2027-11-30',
  unitLevel: true,
  serialHash: '79fe6fca668085d889d0ce51fbb34062eb0411e84cf1669497a4a31b7db8ff54'
}
```

Node 20+. No runtime dependencies — vitest is the only dev dependency.

---


Just the parsers. Every later phase reads the shape they produce, and a mistake here looks
like random corruption three phases downstream, so it is built and tested before anything
else exists.

```
src/parsers/
  base.js     shared types, GS1 date rules, serial hashing
  gs1.js      Application Identifier table and element-string parser
  cdsco.js    tolerant Indian QR parser
  index.js    parseCode() — scheme detection and dispatch
src/cli.js    parse a payload from the command line
tests/        54 tests, plus the real-pack corpus
```

One entry point:

```js
import { parseCode, serialHash, isoDate } from './src/parsers/index.js';

const code = parseCode(payload, 'DATA_MATRIX');
// { scheme, symbology, gtin, serial, batch, expiry, mfgDate,
//   unitLevel, extra, warnings }
```

### The three things that carry the risk

**Length resolution.** Predefined-length AIs carry no separator, so `(01)` and `(17)` run
together in a scanned payload. An unrecognised AI **throws** rather than being skipped — an
unknown length mis-slices every field after it, which would surface later as data that looks
randomly corrupted.

**GS1 date rules.** `DD=00` means end-of-month, and the century comes from a sliding 50-year
window rather than a fixed pivot. Both are things a naive date parse gets wrong.

**Batch-level detection.** If a code carries no unique field, or its unique field equals the
batch number, `unitLevel` is `false`. This matters more than anything else here: many Indian
CDSCO QR codes are issued per batch, so tens of thousands of genuine packs share one code.
Apply unit-level anomaly thresholds to one and every honest scan looks like a clone.

### Scope decisions

The AI table covers what appears on a medicine pack and nothing more. Breadth would be
speculative work, and an explicit failure on an unknown AI is more useful than partial
support that silently mis-parses.

The CDSCO parser accepts all three shapes Indian manufacturers actually ship — JSON, a
verification URL, and delimited key/value — because the rule mandates content but not
encoding.

A linear EAN-13 returns `GTIN_ONLY` rather than throwing. It is a valid code that simply
cannot identify a pack, and the app has to say so rather than report an error.

**Raw serials are never stored.** `serialHash(code, salt)` gives `SHA256(serial + salt)`,
which is the registry key. A readable registry can be enumerated to mint valid-looking codes.

---

## Testing against real medicine

Synthetic fixtures prove the parsers handle the spec. Real packs prove they handle the
market, which is the harder claim — Indian QR payloads vary by manufacturer because the CDSCO
rule mandates content but not encoding.

`real-packs.json` is **gitignored on purpose**: real payloads contain real serial numbers, and
a serial published in a repo is a code that passes registry lookup. The committed
`.example.json` carries redacted values, and a test asserts it stays that way.

With no corpus present those tests skip, so a fresh clone still runs green.

**Getting the raw payload.** Your phone's camera app is the wrong tool — it sees a URL payload
and opens the browser, so you never see the text. Use a scanner that shows raw output
(*Binary Eye* on Android shows the FNC1 separators that DataMatrix needs), or photograph the
code and decode it locally with `@zxing/library`.

**What to buy.** Anything on the CDSCO top-300 list carries a QR: Dolo 650, Crocin, Augmentin,
Azithral, Pan-D, Shelcal. For a GS1 DataMatrix you need an imported or export-market pack.

**What to expect.** Many Indian QRs come back `unitLevel: false` — no unique field, or a
unique field equal to the batch number. That is not a bug; it is the single most important
real-world finding, and it decides whether Phase 4 can apply unit-level thresholds at all.
The suite prints the batch-level percentage across your corpus.