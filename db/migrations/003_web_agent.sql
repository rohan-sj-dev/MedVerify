-- The web agent's own copy of regulator alerts, and a verdict for packs the
-- registry doesn't know.


-- Each alert document the agent has read (one PDF from CDSCO), so a refresh
-- only downloads documents it hasn't seen.
CREATE TABLE web_documents (
    url         TEXT PRIMARY KEY,
    source      TEXT NOT NULL,          -- 'CDSCO'
    title       TEXT NOT NULL,
    published   DATE,
    rows_found  INTEGER NOT NULL,       -- 0 means the PDF had no readable text
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row of an alert table, kept as plain text. Rows are not split into
-- columns: CDSCO's layout varies, so the agent searches the whole row for
-- the batch number and the medicine's name instead.
CREATE TABLE web_alert_rows (
    row_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url       TEXT NOT NULL REFERENCES web_documents(url) ON DELETE CASCADE,
    row_no    INTEGER NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('nsq', 'spurious')),
    text      TEXT NOT NULL             -- upper case, single spaces
);

CREATE INDEX web_alert_rows_url_idx ON web_alert_rows (url);


-- UNVERIFIED: the product isn't in the MedVerify registry, so the pack can be
-- neither confirmed nor condemned by it. Most medicines on sale today are in
-- this position, because their makers don't use MedVerify.
ALTER TABLE verdicts DROP CONSTRAINT verdicts_level_check;
ALTER TABLE verdicts ADD CONSTRAINT verdicts_level_check
    CHECK (level IN ('GENUINE', 'SUSPECT', 'COUNTERFEIT', 'NOT_SERIALIZED', 'UNVERIFIED'));
