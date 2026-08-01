import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  ),
  title: {
    default: "OpenVac｜真空泵专家",
    template: "%s｜OpenVac"
  },
  description:
    "有依据的真空泵专业问答：选泵、方案、故障与配件问题，提供来源引用和问题反馈入口。",
  applicationName: "OpenVac",
  openGraph: {
    title: "OpenVac｜真空泵专家",
    description: "选泵、查故障、理解方案、找配件，不用再翻手册。",
    type: "website",
    locale: "zh_CN"
  },
  robots: {
    index: true,
    follow: true
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
  colorScheme: "light"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
