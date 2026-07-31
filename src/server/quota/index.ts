import { QuotaService } from "./service";
import type {
  QuotaStatusInput,
  ReserveQuotaInput,
  TransitionQuotaInput
} from "./types";

export * from "./service";
export * from "./types";
export * from "./window";

export const quotaService = new QuotaService();

export function reserveQuota(input: ReserveQuotaInput) {
  return quotaService.reserve(input);
}

export function reserveAnswerQuota(input: Omit<ReserveQuotaInput, "resource">) {
  return quotaService.reserve({ ...input, resource: "answer" });
}

export function reserveWebSearchQuota(
  input: Omit<ReserveQuotaInput, "resource">
) {
  return quotaService.reserve({ ...input, resource: "web_search" });
}

export function commitQuota(input: TransitionQuotaInput) {
  return quotaService.commit(input);
}

export function releaseQuota(input: TransitionQuotaInput) {
  return quotaService.release(input);
}

export function getQuotaStatus(input: QuotaStatusInput) {
  return quotaService.status(input);
}

export async function withQuotaReservation<T>(
  input: ReserveQuotaInput,
  operation: (
    reservation: Awaited<ReturnType<typeof reserveQuota>>
  ) => Promise<T>
): Promise<T> {
  return quotaService.withReservation(input, operation);
}
