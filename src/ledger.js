// The registry: what manufacturers say they made, and what regulators recalled.
//
// Reads are used on every scan. Writes are used by manufacturers, distributors,
// pharmacies and regulators (and by seed.js for the demo). In Phase 5 these
// same functions talk to Hyperledger Fabric instead of this database.

export class LedgerError extends Error {}

function check(ok, message) {
  if (!ok) throw new LedgerError(message);
}

// Which status may follow which (Plate 4). RECALLED is final.
const NEXT = {
  COMMISSIONED: ['IN_TRANSIT', 'RECALLED'],
  IN_TRANSIT: ['IN_TRANSIT', 'AT_PHARMACY', 'RECALLED'],
  AT_PHARMACY: ['DISPENSED', 'RECALLED', 'SUSPENDED'],
  DISPENSED: ['RECALLED', 'SUSPENDED'],
  SUSPENDED: ['AT_PHARMACY', 'RECALLED'],
  RECALLED: [],
};

// Who may set each status. SUSPENDED is set by the system itself.
const WHO = {
  IN_TRANSIT: ['manufacturer', 'distributor'],
  AT_PHARMACY: ['distributor'],
  DISPENSED: ['pharmacy'],
  RECALLED: ['manufacturer', 'regulator'],
  SUSPENDED: ['system'],
};

// ---------------------------------------------------------------- reads

export async function getDrug(db, gtin) {
  const { rows } = await db.query('SELECT * FROM drugs WHERE gtin = $1', [gtin]);
  return rows[0] ?? null;
}

// Dates come back as 'YYYY-MM-DD' text so no timezone can shift them a day.
export async function getBatch(db, batchId) {
  const { rows } = await db.query(
    `SELECT batch_id, gtin, status, manufacturer_id,
            mfg_date::text AS mfg_date, expiry_date::text AS expiry_date
       FROM batches WHERE batch_id = $1`,
    [batchId],
  );
  return rows[0] ?? null;
}

export async function getUnit(db, serialHash) {
  const { rows } = await db.query('SELECT * FROM units WHERE serial_hash = $1', [serialHash]);
  return rows[0] ?? null;
}

// Recall notices for this batch, or for every batch of this product.
export async function getRecalls(db, batchId, gtin) {
  const { rows } = await db.query(
    `SELECT source, reference, reason, issued_at::text AS issued_at
       FROM recalls
      WHERE batch_id = $1 OR (gtin = $2 AND batch_id IS NULL)`,
    [batchId, gtin],
  );
  return rows;
}

// --------------------------------------------------------------- writes
// `who` is the organisation making the change: { org, role }.

export async function addDrug(db, drug) {
  await db.query(
    `INSERT INTO drugs (gtin, brand_name, salt, strength, dosage_form, narrow_therapeutic_index)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [drug.gtin, drug.brand, drug.salt, drug.strength, drug.form, drug.nti ?? false],
  );
}

export async function addBatch(db, batch, who) {
  check(who?.role === 'manufacturer' && who.org === batch.manufacturer, 'only the named manufacturer may create a batch');
  await db.query(
    `INSERT INTO batches (batch_id, gtin, mfg_date, expiry_date, manufacturer_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [batch.id, batch.gtin, batch.mfgDate, batch.expiryDate, batch.manufacturer],
  );
}

// Record new packs. Stores SHA256(serial + salt), never the serial itself.
export async function addUnits(db, batchId, serialHashes, who) {
  const batch = await getBatch(db, batchId);
  check(batch, `no batch ${batchId}`);
  check(who?.role === 'manufacturer' && who.org === batch.manufacturer_id, 'only the batch manufacturer may add units');
  check(batch.status !== 'RECALLED', `batch ${batchId} is recalled`);

  await db.transaction(async (tx) => {
    for (const hash of serialHashes) {
      await tx.query('INSERT INTO units (serial_hash, batch_id) VALUES ($1, $2)', [hash, batchId]);
    }
  });
}

// Move a pack to its next status. Give `toOrg` (and optionally lat/lon) when
// it changes hands, and the hand-over is recorded in the custody trail.
export async function changeStatus(db, serialHash, status, who, { toOrg, lat = null, lon = null } = {}) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query('SELECT status FROM units WHERE serial_hash = $1 FOR UPDATE', [serialHash]);
    const unit = rows[0];
    check(unit, 'no such unit');
    check(NEXT[unit.status].includes(status), `${unit.status} -> ${status} is not allowed`);

    // Lifting a suspension is a regulator's call, never the manufacturer's.
    const allowed = unit.status === 'SUSPENDED' ? ['regulator'] : WHO[status];
    check(allowed.includes(who?.role), `a ${who?.role} may not set ${status}`);

    if (toOrg) {
      await tx.query(
        'INSERT INTO custody_events (serial_hash, from_org, to_org, lat, lon) VALUES ($1, $2, $3, $4, $5)',
        [serialHash, who.org, toOrg, lat, lon],
      );
    }
    await tx.query('UPDATE units SET status = $2, updated_at = now() WHERE serial_hash = $1', [serialHash, status]);
  });
}

// Recall a whole batch: the batch and every pack in it.
export async function recallBatch(db, batchId, who) {
  const batch = await getBatch(db, batchId);
  check(batch, `no batch ${batchId}`);
  const ownMaker = who?.role === 'manufacturer' && who.org === batch.manufacturer_id;
  check(who?.role === 'regulator' || ownMaker, `a ${who?.role} may not recall ${batchId}`);

  await db.transaction(async (tx) => {
    await tx.query(`UPDATE batches SET status = 'RECALLED' WHERE batch_id = $1`, [batchId]);
    await tx.query(`UPDATE units SET status = 'RECALLED', updated_at = now() WHERE batch_id = $1`, [batchId]);
  });
}

// A recall notice from a regulator (CDSCO, WHO, a state drug controller).
export async function addRecall(db, { batchId = null, gtin = null, source, reference, reason, issuedAt }) {
  await db.query(
    `INSERT INTO recalls (batch_id, gtin, source, reference, reason, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [batchId, gtin, source, reference, reason, issuedAt],
  );
}
