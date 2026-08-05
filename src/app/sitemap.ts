import type { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

const DEFAULT_APP_URL = "https://openvac.cn";

function runtimeAppUrl(): string {
  return (process.env.APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = runtimeAppUrl();
  return [
    "",
    "/semacad",
    "/sources",
    "/product",
    "/legal/terms",
    "/legal/privacy",
    "/help",
    "/feedback",
    "/complaints"
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : 0.6
  }));
}
