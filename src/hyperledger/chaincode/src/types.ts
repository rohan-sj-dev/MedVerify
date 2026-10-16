// Records stored on the ledger. They mirror the drugs / batches / units
// tables in db/migrations/001_init.sql.

export type Role = 'manufacturer' | 'distributor' | 'pharmacy' | 'regulator' | 'system';

export type UnitStatus = 'COMMISSIONED' | 'IN_TRANSIT' | 'AT_PHARMACY' | 'DISPENSED' | 'RECALLED' | 'SUSPENDED';

export interface Drug {
  gtin: string;
  brandName: string;
  salt: string;
}

export interface Batch {
  batchId: string;
  gtin: string;
  mfgDate: string; // YYYY-MM-DD
  expiryDate: string; // YYYY-MM-DD
  manufacturerId: string;
  status: 'ACTIVE' | 'RECALLED';
}

export interface Unit {
  serialHash: string; // SHA256(serial + salt)
  batchId: string;
  status: UnitStatus;
}
