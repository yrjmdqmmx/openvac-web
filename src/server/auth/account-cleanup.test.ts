import { describe, expect, it } from "vitest";

import { assertUserCanSelfDelete } from "./account-cleanup";

describe("account deletion policy", () => {
  it("blocks self-deletion while any administrator role remains", () => {
    expect(() => assertUserCanSelfDelete([{ role: "analyst" }])).toThrowError(
      expect.objectContaining({
        code: "ADMIN_ACCOUNT_DELETION_FORBIDDEN"
      })
    );
  });

  it("allows a regular account to continue through deletion cleanup", () => {
    expect(() => assertUserCanSelfDelete([])).not.toThrow();
  });
});
