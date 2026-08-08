import { describe, expect, it } from "vitest";

describe("effective account bans", () => {
  it("blocks permanent and unexpired bans but not expired temporary bans", async () => {
    const { isEffectiveBan } = await import("./ban-policy");
    const now = new Date("2026-08-08T12:00:00.000Z");

    expect(isEffectiveBan({ banned: false, banExpires: null }, now)).toBe(
      false
    );
    expect(isEffectiveBan({ banned: true, banExpires: null }, now)).toBe(true);
    expect(
      isEffectiveBan(
        { banned: true, banExpires: new Date("2026-08-08T12:00:01.000Z") },
        now
      )
    ).toBe(true);
    expect(
      isEffectiveBan(
        { banned: true, banExpires: new Date("2026-08-08T12:00:00.000Z") },
        now
      )
    ).toBe(false);
    expect(
      isEffectiveBan(
        { banned: true, banExpires: new Date("2026-08-08T11:59:59.000Z") },
        now
      )
    ).toBe(false);
  });

  it("classifies session creation as allowed, blocked, or requiring expired-ban cleanup", async () => {
    const { banDisposition } = await import("./ban-policy");
    const now = new Date("2026-08-08T12:00:00.000Z");

    expect(banDisposition({ banned: false, banExpires: null }, now)).toBe(
      "allow"
    );
    expect(banDisposition({ banned: true, banExpires: null }, now)).toBe(
      "block"
    );
    expect(
      banDisposition(
        { banned: true, banExpires: new Date("2026-08-08T12:00:01.000Z") },
        now
      )
    ).toBe("block");
    expect(
      banDisposition(
        { banned: true, banExpires: new Date("2026-08-08T12:00:00.000Z") },
        now
      )
    ).toBe("clear");
  });
});
