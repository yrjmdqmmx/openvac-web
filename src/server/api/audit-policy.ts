import type { AdminRole } from "./types";

export type AuditLogReadPolicy = {
  redacted: boolean;
  searchableFields: ReadonlyArray<"action" | "targetType" | "targetId">;
};

export function auditLogReadPolicy(role: AdminRole): AuditLogReadPolicy {
  return role === "analyst"
    ? {
        redacted: true,
        searchableFields: ["action", "targetType"]
      }
    : {
        redacted: false,
        searchableFields: ["action", "targetType", "targetId"]
      };
}
