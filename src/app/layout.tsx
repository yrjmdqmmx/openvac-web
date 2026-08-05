import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://openvac.cn"),
  title: {
    default: "OpenVac｜真空泵专家",
    template: "%s｜OpenVac"
  },
  description:
    "有依据的真空泵专业问答：选泵、方案、故障与配件问题，提供来源引用和问题反馈入口。",
  applicationName: "OpenVac",
  icons: null,
  openGraph: {
    title: "OpenVac｜真空泵专家",
    description:
      "描述泵型、工况或故障现象，OpenVac 会结合资料给出可核查的回答。",
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
