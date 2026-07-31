import { describe, expect, it } from "vitest";

import { auditLogReadPolicy } from "./audit-policy";

describe("audit log read policy", () => {
  it("redacts analyst DTOs and excludes hidden identifiers from search", () => {
    expect(auditLogReadPolicy("analyst")).toEqual({
      redacted: true,
      searchableFields: ["action", "targetType"]
    });
  });

  it("allows privileged administrators to search target identifiers", () => {
    expect(auditLogReadPolicy("owner")).toEqual({
      redacted: false,
      searchableFields: ["action", "targetType", "targetId"]
    });
  });
});
