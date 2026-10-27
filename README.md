# MedVerify

Counterfeit medicine detection: scan a pack, check its code against a manufacturer registry,
test its scan history for physical impossibility, explain the verdict in plain language.

---

## Quick start

```bash
npm install
npm test          # 93 tests
npm start         # gateway on :3000
```

With the gateway running, the app:

```bash
cd app
flutter run                                                    # emulator
flutter run --dart-define=MEDVERIFY_API=http://<your-ip>:3000  # real phone
```

The parser CLI needs no server:

```bash
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

Node 20+ and Flutter 3.3+. Runtime dependencies: `express` and `zod` (the parsers themselves
still have none).

---

## Phase 0 — the parsers

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
tests/        93 tests, plus the real-pack corpus
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

---

## Phase 1 — contract, gateway, app

```
src/contracts/verdict.js   frozen contract, zod
src/fixtures/verdicts.js   five canned verdicts, validated at import
src/server.js              Express 5 gateway
app/                       Flutter client
```

| Route | Purpose |
|---|---|
| `GET /health` | liveness; reports whether the dev salt is still in use |
| `POST /parse` | run a payload through the Phase 0 parsers |
| `GET /mock/scan?case=…` | `genuine`, `suspect`, `counterfeit`, `not_serialized`, `batch_level` |

**Every response is validated against its schema before it leaves.** A fixture or handler that
drifts from the contract fails at startup or in the test suite, never in a client that would
then render something wrong about a medicine.

`POST /parse` returns `serial_hash`, never the serial itself — a test asserts the raw serial
never appears in the response body.

### Two rules the client holds to

**Branch on `verdict`, never on the narrative.** The narrative is written by an LLM from the
evidence; the verdict is computed deterministically. A test asserts no `SUSPECT` or
`COUNTERFEIT` narrative can contain reassuring language — in place now, before a real model
ever writes one.

**Never render a bare "Genuine."** Every verdict shows the claim *and* its basis, rendering the
`evidence` array per agent. Users calibrate trust on the reasoning, and the reasoning is what
protects you when the system is wrong.

The app scans QR, DataMatrix **and** EAN-13. A batch-level code gets an explicit notice that
the code is shared across the batch and cannot be checked for copying; a linear barcode gets
"cannot be checked" rather than an error.

### Running the app

Android licences must be accepted once:

```bash
flutter doctor --android-licenses
```

Cleartext HTTP to local addresses is permitted by
`app/android/app/src/main/res/xml/network_security_config.xml` — **development only**. Delete
it and the manifest reference once the gateway is HTTPS.

---

## Phase 2 — real verification

`POST /scan` checks a pack against the registry: was the serial issued, does the printed
batch, product and expiry match the record, is it expired or recalled. The verdict is decided
in plain code (`fusion.js`); Claude only writes the explanation, and only when
`ANTHROPIC_API_KEY` is set.

```bash
npm run seed     # demo registry + samples/index.html (stop the server first)
npm start
```

Line-by-line explanation: [docs/phase-2-walkthrough.md](docs/phase-2-walkthrough.md).

---

## Synthetic supply chain

A pretend supply chain with labelled fraud, for Phase 4 to learn from and be measured
against: genuine packs, copied codes, diverted stock and relabelled expired stock.

```bash
npm run generate -- --units 50000 --clone-rate 0.04   # into .data/synthetic, ~25 s
npm run baseline                                      # how well simple rules do
```

The demo registry in `.data/pglite` is not touched. The same `--seed` always rebuilds the
same data.

Simple rules on 50,000 packs (seed 42):

| Rule | Catches | Wrongly flags genuine |
|---|---|---|
| Faster than 900 km/h between scans | 41% of copies | 0% |
| More than 5 phones | 91% of copies | 0% |
| Spread over 100 km | 96% of copies | 0.7% |
| First scan 200+ km from its pharmacy | 87% of diversions | 0.1% |
| Scanned after expiry | 100% of repacks | 0% |

These are measured on synthetic data, so they are optimistic; real performance will be lower.
Line-by-line explanation: [docs/phase-3-walkthrough.md](docs/phase-3-walkthrough.md).

---

## Next: Phase 4

Combine those signals into the Anomaly Agent, so a copied code — which today only gets
"GENUINE, 75%" — is caught at scan time.
