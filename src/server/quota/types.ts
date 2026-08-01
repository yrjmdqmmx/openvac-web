export type QuotaResource = "answer" | "web_search" | "model_attempt";
export type QuotaScopeType = "global" | "user";
export type QuotaReservationStatus = "committed" | "released" | "reserved";

export interface QuotaScopePolicy {
  scopeType: QuotaScopeType;
  scopeKey: string;
  limit: number;
}

export interface QuotaWindow {
  key: string;
  resetAt: Date;
}

export interface QuotaScopeUsage {
  scopeType: QuotaScopeType;
  scopeKey: string;
  limit: number;
  reserved: number;
  committed: number;
  remaining: number;
  resetAt: Date;
}

export interface QuotaReservation {
  leaseId: string;
  actorUserId: string;
  clientRequestId: string;
  resource: QuotaResource;
  units: number;
  status: QuotaReservationStatus;
  window: QuotaWindow;
  scopes: QuotaScopeUsage[];
  idempotent: boolean;
}

export interface ReserveQuotaInput {
  userId: string;
  clientRequestId: string;
  resource: QuotaResource;
  units?: number;
  at?: Date;
  metadata?: Record<string, unknown>;
}

export interface TransitionQuotaInput {
  leaseId: string;
  userId?: string;
  reason?: string;
}

export interface QuotaStatusInput {
  userId: string;
  resource: QuotaResource;
  at?: Date;
}

export interface QuotaStatus {
  resource: QuotaResource;
  window: QuotaWindow;
  scopes: QuotaScopeUsage[];
  remaining: number;
}

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";
  readonly resource: QuotaResource;
  readonly scopeType: QuotaScopeType;
  readonly limit: number;
  readonly resetAt: Date;

  constructor(input: {
    resource: QuotaResource;
    scopeType: QuotaScopeType;
    limit: number;
    resetAt: Date;
  }) {
    super(
      `${input.resource} quota exceeded for ${input.scopeType} scope until ${input.resetAt.toISOString()}`
    );
    this.name = "QuotaExceededError";
    this.resource = input.resource;
    this.scopeType = input.scopeType;
    this.limit = input.limit;
    this.resetAt = input.resetAt;
  }
}

export class QuotaReservationNotFoundError extends Error {
  readonly code = "QUOTA_RESERVATION_NOT_FOUND";

  constructor(leaseId: string) {
    super(`Quota reservation ${leaseId} was not found`);
    this.name = "QuotaReservationNotFoundError";
  }
}

export class QuotaRequestInProgressError extends Error {
  readonly code = "QUOTA_REQUEST_IN_PROGRESS";

  constructor(clientRequestId: string) {
    super(`Quota request ${clientRequestId} is already in progress`);
    this.name = "QuotaRequestInProgressError";
  }
}

export class QuotaRequestAlreadyUsedError extends Error {
  readonly code = "QUOTA_REQUEST_ALREADY_USED";

  constructor(
    clientRequestId: string,
    status: Exclude<QuotaReservationStatus, "reserved">
  ) {
    super(`Quota request ${clientRequestId} is already ${status}`);
    this.name = "QuotaRequestAlreadyUsedError";
  }
}

export class QuotaAccountUnavailableError extends Error {
  readonly code = "QUOTA_ACCOUNT_UNAVAILABLE";

  constructor() {
    super("Quota account is unavailable");
    this.name = "QuotaAccountUnavailableError";
  }
}

export class QuotaAccountDeletionPendingError extends Error {
  readonly code = "QUOTA_ACCOUNT_DELETION_PENDING";

  constructor() {
    super("Quota account deletion is pending");
    this.name = "QuotaAccountDeletionPendingError";
  }
}
