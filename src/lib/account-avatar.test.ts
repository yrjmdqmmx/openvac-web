import { describe, expect, it } from "vitest";

import { safeAccountAvatarUrl } from "./account-avatar";

describe("safeAccountAvatarUrl", () => {
  it("allows only the stable same-origin avatar endpoint", () => {
    expect(safeAccountAvatarUrl("/api/account/avatar")).toBe(
      "/api/account/avatar"
    );
    expect(safeAccountAvatarUrl("/api/account/avatar?revision=4")).toBe(
      "/api/account/avatar?revision=4"
    );
  });

  it("rejects legacy external, protocol-relative, and lookalike URLs", () => {
    expect(safeAccountAvatarUrl("https://example.com/avatar.jpg")).toBeNull();
    expect(safeAccountAvatarUrl("//example.com/avatar.jpg")).toBeNull();
    expect(safeAccountAvatarUrl("/api/account/avatar/other")).toBeNull();
    expect(safeAccountAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAccountAvatarUrl(null)).toBeNull();
  });
});
