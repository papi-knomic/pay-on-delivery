import type { DeliveryStatus } from './delivery-state.js';
import type { PayPalCurrency } from './money.js';
import type { CheckResult } from './verification.js';

/** Output of apps/api DeliveryResource. Money fields are decimal strings ("12.50"); never do float math on them. */
export interface DeliveryDto {
  id: string;
  status: DeliveryStatus;
  merchantId: string;
  buyerId: string;
  riderId: string | null;
  amount: string;
  riderFee: string;
  capturedAmount?: string;
  currency: PayPalCurrency;
  deliveryAddress: string;
  authorizedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Ops-only
  paypalOrderId?: string;
  currentAuthorizationId?: string;
  honorPeriodFlaggedAt?: string;
}

/** Output of apps/api EvidenceResource. */
export interface EvidenceDto {
  id: string;
  deliveryId: string;
  attempt: number;
  photoUrl: string;
  photoTakenAt?: string;
  createdAt: string;
  // Ops-only
  gps?: { lat: number; lng: number; accuracyM?: number };
  checks?: CheckResult[];
}

export interface PaginationMeta {
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface Wrapped<T> {
  data: T;
}
