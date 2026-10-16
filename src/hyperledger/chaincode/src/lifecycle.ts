// The unit lifecycle

import type { Role, UnitStatus } from './types';

// Which status may follow which, RECALLED is final
export const NEXT: Record<UnitStatus, UnitStatus[]> = {
  COMMISSIONED: ['IN_TRANSIT', 'RECALLED'],
  IN_TRANSIT: ['IN_TRANSIT', 'AT_PHARMACY', 'RECALLED'],
  AT_PHARMACY: ['DISPENSED', 'RECALLED', 'SUSPENDED'],
  DISPENSED: ['RECALLED', 'SUSPENDED'],
  SUSPENDED: ['AT_PHARMACY', 'RECALLED'],
  RECALLED: [],
};

// Who may set each status
// SUSPENDED is set by the system (anomaly agent)

export const WHO: Partial<Record<UnitStatus, Role[]>> = {
  IN_TRANSIT: ['manufacturer', 'distributor'],
  AT_PHARMACY: ['distributor'],
  DISPENSED: ['pharmacy'],
  RECALLED: ['manufacturer', 'regulator'],
  SUSPENDED: ['system'],
};
