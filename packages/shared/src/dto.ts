import type { DeliveryStatus } from './delivery-state.js';
import type { PayPalCurrency } from './money.js';

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
