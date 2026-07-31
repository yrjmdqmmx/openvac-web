import { describe, expect, it } from "vitest";

import {
  assertCurrentOwnerRole,
  assertOwnerRoleRevocationAllowed
} from "./role-policy";

describe("administrator role invariants", () => {
  it("blocks an owner from removing their own unique owner role", () => {
    expect(() =>
      assertOwnerRoleRevocationAllowed({
        role: "owner",
        ownerCount: 1,
        targetUserId: "owner-1",
        actorUserId: "owner-1"
      })
    ).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "LAST_OWNER_SELF_REMOVAL_FORBIDDEN"
      })
    );
  });

  it("blocks removing the final owner through another owner session", () => {
    expect(() =>
      assertOwnerRoleRevocationAllowed({
        role: "owner",
        ownerCount: 1,
        targetUserId: "owner-1",
        actorUserId: "owner-2"
      })
    ).toThrowError(
      expect.objectContaining({
        status: 409,
        code: "LAST_OWNER_REQUIRED"
      })
    );
  });

  it("allows owner removal when another owner remains", () => {
    expect(() =>
      assertOwnerRoleRevocationAllowed({
        role: "owner",
        ownerCount: 2,
        targetUserId: "owner-1",
        actorUserId: "owner-1"
      })
    ).not.toThrow();
  });

  it("does not apply the owner invariant to other roles", () => {
    expect(() =>
      assertOwnerRoleRevocationAllowed({
        role: "admin",
        ownerCount: 0,
        targetUserId: "admin-1",
        actorUserId: "admin-1"
      })
    ).not.toThrow();
  });

  it("rejects a role mutation after the acting owner was revoked", () => {
    expect(() => assertCurrentOwnerRole(undefined)).toThrowError(
      expect.objectContaining({
        status: 403,
        code: "ADMIN_AUTHORIZATION_REVOKED"
      })
    );
  });
});
