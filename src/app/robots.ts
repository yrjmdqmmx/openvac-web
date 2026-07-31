import type { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

const DEFAULT_APP_URL = "https://openvac.yixingretail.cn";

function runtimeAppUrl(): string {
  return (process.env.APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
}

export default function robots(): MetadataRoute.Robots {
  const base = runtimeAppUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/sources", "/product", "/legal/", "/help"],
        disallow: ["/api/", "/chat", "/admin", "/settings"]
      }
    ],
    sitemap: `${base}/sitemap.xml`
  };
}
