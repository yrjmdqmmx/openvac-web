import { afterEach, describe, expect, it, vi } from "vitest";

import robots, { dynamic as robotsDynamic } from "./robots";
import sitemap, { dynamic as sitemapDynamic } from "./sitemap";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime metadata routes", () => {
  it("forces runtime generation instead of baking the image-build URL", () => {
    expect(robotsDynamic).toBe("force-dynamic");
    expect(sitemapDynamic).toBe("force-dynamic");
  });

  it("uses APP_URL at request time and ignores the public build-time URL", () => {
    vi.stubEnv("APP_URL", "https://runtime.openvac.example/");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");

    expect(robots().sitemap).toBe(
      "https://runtime.openvac.example/sitemap.xml"
    );
    expect(sitemap().map((entry) => entry.url)).toEqual([
      "https://runtime.openvac.example",
      "https://runtime.openvac.example/sources",
      "https://runtime.openvac.example/product",
      "https://runtime.openvac.example/legal/terms",
      "https://runtime.openvac.example/legal/privacy",
      "https://runtime.openvac.example/help",
      "https://runtime.openvac.example/consult"
    ]);
  });

  it("falls back to the public production origin when APP_URL is empty", () => {
    vi.stubEnv("APP_URL", " ");

    expect(robots().sitemap).toBe("https://openvac.cn/sitemap.xml");
    expect(sitemap()[0]?.url).toBe("https://openvac.cn");
  });
});
