export interface PayPalErrorDetail {
  field?: string;
  issue?: string;
  description?: string;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorName: string | undefined,
    readonly debugId: string | undefined,
    readonly details: PayPalErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'PayPalError';
  }

  /** First issue code, e.g. "AUTHORIZATION_ALREADY_CAPTURED". Useful for branching. */
  get issue(): string | undefined {
    return this.details[0]?.issue ?? this.errorName;
  }
}

export class PayPalResponseShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string,
  ) {
    super(`Unexpected PayPal response shape from ${path}: ${issues}`);
    this.name = 'PayPalResponseShapeError';
  }
}
