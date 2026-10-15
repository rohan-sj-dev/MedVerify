-- MedVerify schema, Plate 7 of PLAN.md.
--
-- Two halves with opposite trust properties:
--
--   drugs / batches / units / custody_events
--       What manufacturers ASSERT. Mirrors the ledger; these tables move to
--       Fabric chaincode in Phase 5 and this copy becomes a read cache.
--
--   scans / verdicts / agent_results
--       What the system OBSERVES. High-volume, single-writer, and full of
--       patient location data -- this half never goes on-chain.
--
-- No extensions are required. Locations are plain lat/lon columns until
-- Phase 4, when the anomaly agent needs PostGIS and a migration derives a
-- geography column from them. UUIDs come from the built-in gen_random_uuid().


-- ============================================================ registry half

CREATE TABLE drugs (
    gtin                      TEXT PRIMARY KEY,
    brand_name                TEXT NOT NULL,
    salt                      TEXT NOT NULL,
    strength                  TEXT,
    dosage_form               TEXT,
    -- Blocks automatic substitution. Warfarin, levothyroxine, lithium,
    -- phenytoin: a different brand is not clinically interchangeable.
    narrow_therapeutic_index  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE batches (
    batch_id         TEXT PRIMARY KEY,
    gtin             TEXT NOT NULL REFERENCES drugs(gtin),
    mfg_date         DATE NOT NULL,
    expiry_date      DATE NOT NULL,
    plant_code       TEXT,
    manufacturer_id  TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'RECALLED')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT expiry_after_mfg CHECK (expiry_date > mfg_date)
);

CREATE INDEX batches_gtin_idx ON batches (gtin);

CREATE TABLE units (
    -- SHA256(serial + salt). The raw serial is never stored: a readable
    -- registry can be enumerated to mint valid-looking codes.
    serial_hash  TEXT PRIMARY KEY,
    batch_id     TEXT NOT NULL REFERENCES batches(batch_id),
    status       TEXT NOT NULL DEFAULT 'COMMISSIONED'
                 CHECK (status IN ('COMMISSIONED', 'IN_TRANSIT', 'AT_PHARMACY',
                                   'DISPENSED', 'RECALLED', 'SUSPENDED')),
    -- FALSE when the code identifies a batch rather than a pack. Unit-level
    -- anomaly thresholds must not be applied to these.
    unit_level   BOOLEAN NOT NULL DEFAULT TRUE,
    minted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX units_batch_idx ON units (batch_id);

CREATE TABLE custody_events (
    event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    serial_hash  TEXT NOT NULL REFERENCES units(serial_hash),
    from_org     TEXT,
    to_org       TEXT NOT NULL,
    lat          DOUBLE PRECISION CHECK (lat BETWEEN -90 AND 90),
    lon          DOUBLE PRECISION CHECK (lon BETWEEN -180 AND 180),
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT custody_location_is_a_pair CHECK ((lat IS NULL) = (lon IS NULL))
);

CREATE INDEX custody_serial_idx ON custody_events (serial_hash, occurred_at);


-- ============================================================ evidence half

CREATE TABLE scans (
    scan_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Not a foreign key: an unknown serial is exactly the case we must log.
    serial_hash  TEXT,
    gtin         TEXT,
    batch_id     TEXT,
    lat          DOUBLE PRECISION CHECK (lat BETWEEN -90 AND 90),
    lon          DOUBLE PRECISION CHECK (lon BETWEEN -180 AND 180),
    scanned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Hashed client-side. Never a raw device identifier.
    device_id    TEXT,
    code_format  TEXT NOT NULL,
    scheme       TEXT NOT NULL,

    CONSTRAINT scan_location_is_a_pair CHECK ((lat IS NULL) = (lon IS NULL))
);

-- The Anomaly Agent's hot path: every scan of one serial, in time order.
CREATE INDEX scans_serial_time_idx ON scans (serial_hash, scanned_at);
CREATE INDEX scans_batch_idx ON scans (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE verdicts (
    scan_id     UUID PRIMARY KEY REFERENCES scans(scan_id) ON DELETE CASCADE,
    level       TEXT NOT NULL
                CHECK (level IN ('GENUINE', 'SUSPECT', 'COUNTERFEIT', 'NOT_SERIALIZED')),
    confidence  REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    unit_level  BOOLEAN NOT NULL,
    -- Written from the evidence. Never authoritative: clients render
    -- `level`, never a parse of this text.
    narrative   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX verdicts_level_idx ON verdicts (level, created_at)
    WHERE level IN ('SUSPECT', 'COUNTERFEIT');

CREATE TABLE agent_results (
    result_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id     UUID NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
    agent_name  TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    score       REAL CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    hard_fail   BOOLEAN NOT NULL DEFAULT FALSE,
    -- Array of {signal, value, unit, detail}. Machine-readable so it can be
    -- rendered, narrated and audited -- never a pre-written sentence.
    evidence    JSONB NOT NULL DEFAULT '[]'::jsonb,
    elapsed_ms  INTEGER,

    UNIQUE (scan_id, agent_name)
);


-- Recall notices, read by the Recall Agent. Entered by hand in Phase 2;
-- later polled from CDSCO / WHO alert feeds.
CREATE TABLE recalls (
    recall_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id    TEXT,
    gtin        TEXT,
    source      TEXT NOT NULL,
    reference   TEXT,
    reason      TEXT,
    issued_at   DATE NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A NULL batch_id with a gtin means every batch of that product.
    CONSTRAINT recall_targets_something CHECK (batch_id IS NOT NULL OR gtin IS NOT NULL)
);

CREATE INDEX recalls_batch_idx ON recalls (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX recalls_gtin_idx ON recalls (gtin) WHERE batch_id IS NULL;
