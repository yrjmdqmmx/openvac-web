import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import { ArrowUpRight, Check, Download } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { isSemacadDownloadReady, semacadRelease } from "@/lib/semacad-release";
import { auth } from "@/server/auth";

const description =
  "SemaCAD 是基于 FreeCAD 的本地优先 CAD，让手动建模与 OpenVac 辅助建模在同一工作区完成。";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SemaCAD",
  description,
  alternates: { canonical: "https://openvac.cn/semacad" },
  openGraph: {
    title: "SemaCAD｜OpenVac",
    description,
    type: "website",
    url: "https://openvac.cn/semacad",
    images: [
      {
        url: "https://openvac.cn/semacad/semacad-app-icon.png",
        width: 1024,
        height: 1024,
        alt: "SemaCAD 应用图标"
      }
    ]
  },
  twitter: {
    card: "summary",
    title: "SemaCAD｜OpenVac",
    description,
    images: ["https://openvac.cn/semacad/semacad-app-icon.png"]
  }
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function jsonLd(): string {
  const readyRelease = isSemacadDownloadReady(semacadRelease)
    ? semacadRelease
    : null;
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SemaCAD",
    description,
    applicationCategory: "DesignApplication",
    operatingSystem: `macOS ${semacadRelease.minimumMacOS}+`,
    softwareVersion: readyRelease?.version,
    downloadUrl: readyRelease?.downloadUrl,
    releaseNotes: readyRelease?.releaseUrl,
    image: "https://openvac.cn/semacad/semacad-app-icon.png",
    publisher: {
      "@type": "Organization",
      name: "OpenVac",
      url: "https://openvac.cn"
    }
  };

  return JSON.stringify(data).replaceAll("<", "\\u003c");
}

const capabilitySections = [
  {
    number: "01",
    title: "完整的 FreeCAD，也是一条真实的手动 CAD 路径",
    body: "SemaCAD 建立在 FreeCAD 之上，不把专业建模缩减成一个聊天窗口。你仍可直接使用熟悉的工作台、参数和工程文件，OpenVac 辅助能力与手动操作共处于同一工作区。"
  },
  {
    number: "02",
    title: "本地优先，模型服务由你选择",
    body: "应用与工程文件以本地工作流为中心。需要模型能力时，SemaCAD 按照你选择并配置的服务商发起调用；密钥与服务选择由你管理，而不是被绑定到单一云端。"
  },
  {
    number: "03",
    title: "OpenVac 把建模意图变成可检查的操作",
    body: "从自然语言理解、必要澄清到结构化计划与预览，OpenVac 帮助你把意图整理成更明确的 CAD 操作。含糊或高影响的步骤会先停下来确认。"
  },
  {
    number: "04",
    title: "先预览，再确认；工程师拥有最终决定权",
    body: "辅助操作强调可检查、可确认和可撤销。只有在你确认后才形成版本；不满意时可以继续修改或回到此前状态，最终工程判断始终属于使用者。"
  }
] as const;

export default async function SemacadPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const readyRelease = isSemacadDownloadReady(semacadRelease)
    ? semacadRelease
    : null;
  const downloadReady = Boolean(readyRelease);

  const releaseFacts = [
    ["发布状态", downloadReady ? "Public Beta" : "Public Beta · 准备中"],
    ["架构", semacadRelease.architecture],
    ["系统要求", `macOS ${semacadRelease.minimumMacOS}+`],
    ["版本", readyRelease?.version ?? "待发布"],
    ["构建", readyRelease?.build ?? "待发布"],
    ["安装包", readyRelease ? formatBytes(readyRelease.sizeBytes) : "待发布"],
    ["公证状态", readyRelease?.notarized ? "已公证" : "发布前验证"]
  ] as const;

  return (
    <main className="min-h-screen overflow-x-hidden bg-white">
      <div className="border-b border-[var(--border)]">
        <SiteHeader authenticated={Boolean(session)} />
      </div>

      <article>
        <section className="shell grid min-h-[680px] items-center gap-14 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)] lg:py-28">
          <div className="max-w-[790px]">
            <Image
              src="/semacad/semacad-app-icon.png"
              alt="SemaCAD 应用图标"
              width={112}
              height={112}
              priority
              className="size-20 rounded-[22px] sm:size-28 sm:rounded-[30px]"
            />
            <h1 className="mt-9 text-[clamp(3.6rem,8vw,7.5rem)] leading-[0.92] font-semibold tracking-[-0.075em]">
              SemaCAD
            </h1>
            <p className="mt-8 max-w-[730px] text-xl leading-9 tracking-[-0.02em] text-[var(--muted)] sm:text-2xl sm:leading-10">
              基于 FreeCAD 的本地优先 CAD，让手动建模与 OpenVac
              辅助建模在同一工作区完成。
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              {readyRelease ? (
                <a
                  href={readyRelease.downloadUrl}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-5 text-sm font-medium !text-white transition-colors hover:bg-[#292b2d]"
                >
                  <Download aria-hidden="true" className="size-4" />
                  下载 Mac 版
                </a>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex min-h-12 cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-[#dfe2e2] px-5 text-sm font-medium text-[#707779]"
                >
                  <Download aria-hidden="true" className="size-4" />
                  下载准备中
                </span>
              )}
              <a
                href="https://github.com/zdywrnm/SemaCAD"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-[var(--border-strong)] px-5 text-sm font-medium transition-colors hover:border-[var(--ink)]"
              >
                查看源代码
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </a>
            </div>
          </div>

          <dl className="border-t border-[var(--border)] text-sm lg:mb-2 lg:self-end">
            {releaseFacts.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[116px_1fr] gap-4 border-b border-[var(--border)] py-4"
              >
                <dt className="text-[var(--muted)]">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
            {readyRelease ? (
              <div className="grid grid-cols-[116px_1fr] gap-4 border-b border-[var(--border)] py-4">
                <dt className="text-[var(--muted)]">SHA-256</dt>
                <dd className="font-mono text-xs leading-5 break-all">
                  {readyRelease.sha256}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section className="shell pb-24 sm:pb-32" aria-label="SemaCAD 应用预览">
          {readyRelease ? (
            <div className="overflow-hidden rounded-[28px] border border-[var(--border)] bg-[#e9ebeb] p-2 shadow-[0_30px_90px_rgba(17,19,21,0.12)] sm:p-3">
              <Image
                src="/semacad/semacad-main-window.png"
                alt="SemaCAD 公开 Beta 主窗口，显示干净的 FreeCAD 工作区"
                width={1600}
                height={1000}
                sizes="(max-width: 1420px) calc(100vw - 48px), 1368px"
                className="h-auto w-full rounded-[21px]"
              />
            </div>
          ) : (
            <div className="flex min-h-64 flex-col justify-between rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-7 sm:min-h-80 sm:p-10">
              <div className="flex items-center gap-3 text-sm font-medium">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-white">
                  <Check
                    aria-hidden="true"
                    className="size-4"
                    strokeWidth={1.75}
                  />
                </span>
                公开 Beta 发布校验中
              </div>
              <p className="max-w-xl text-2xl leading-9 font-medium tracking-[-0.035em] sm:text-3xl sm:leading-11">
                真实应用截图将在最终构建完成签名、公证和隐私检查后展示。
              </p>
            </div>
          )}
        </section>

        <div className="border-t border-[var(--border)]">
          <div className="shell">
            {capabilitySections.map((section, index) => (
              <section
                key={section.number}
                className="grid gap-8 border-b border-[var(--border)] py-16 sm:py-24 lg:grid-cols-[0.7fr_1.3fr] lg:gap-24"
              >
                <div>
                  <span className="text-sm text-[var(--muted)] tabular-nums">
                    {section.number}
                  </span>
                  <h2 className="mt-5 max-w-[520px] text-3xl leading-[1.15] font-semibold tracking-[-0.045em] sm:text-4xl">
                    {section.title}
                  </h2>
                </div>
                <p
                  className={`max-w-[690px] text-lg leading-9 text-[var(--muted)] lg:self-end ${
                    index % 2 === 1 ? "lg:justify-self-end" : ""
                  }`}
                >
                  {section.body}
                </p>
              </section>
            ))}
          </div>
        </div>

        <section className="shell py-20 sm:py-32">
          <div className="flex flex-col items-start justify-between gap-10 rounded-[28px] bg-[var(--ink)] px-7 py-10 text-white sm:px-12 sm:py-14 lg:flex-row lg:items-end">
            <div>
              <h2 className="max-w-2xl text-3xl leading-tight font-semibold tracking-[-0.045em] sm:text-5xl">
                让 CAD 操作保持清楚，
                <br className="hidden sm:block" />
                也让决定权留在你手中。
              </h2>
              <p className="mt-5 max-w-xl leading-7 text-[#b7bdbd]">
                {readyRelease
                  ? "SemaCAD Public Beta 面向 Apple Silicon Mac，源代码现已公开。"
                  : "公开 Beta 正在完成发布校验；源代码现已公开。"}
              </p>
            </div>
            {readyRelease ? (
              <a
                href={readyRelease.downloadUrl}
                className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-medium !text-[var(--ink)] transition-colors hover:bg-[#eceeee]"
              >
                <Download aria-hidden="true" className="size-4" />
                下载 Mac 版
              </a>
            ) : (
              <a
                href="https://github.com/zdywrnm/SemaCAD"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-medium !text-[var(--ink)] transition-colors hover:bg-[#eceeee]"
              >
                查看 SemaCAD 仓库
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </a>
            )}
          </div>
        </section>
      </article>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd() }}
      />
    </main>
  );
}
