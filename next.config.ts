import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep provider SDKs external so their runtime constructors and prototype
  // methods survive the standalone build (notably ali-oss signed URLs).
  serverExternalPackages: [
    "ali-oss",
    "@alicloud/docmind-api20220711",
    "@alicloud/tea-util"
  ],
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb"
    }
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=()"
        }
      ]
    }
  ]
};

export default nextConfig;
