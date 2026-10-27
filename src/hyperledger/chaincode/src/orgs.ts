// Which role each organisation plays on the network, keyed by its MSP ID.
//
// The MSP ID is checked by Fabric against the channel's trusted certificate
// authorities, so one organisation cannot claim another's. Attributes written
// inside a certificate are not safe for this: every organisation runs its own
// CA and could write "manufacturer" or "regulator" into its own certificates.
//
// Adding an organisation means adding it here and upgrading the chaincode.

import type { Role } from './types';

export const ROLE_OF_ORG: Record<string, Role> = {
  ManufacturerMSP: 'manufacturer',
  DistributorMSP: 'distributor',
  PharmacyMSP: 'pharmacy',
  RegulatorMSP: 'regulator',
  MedVerifyMSP: 'system', // the MedVerify server itself: suspends copied serials (Phase 4)
};
