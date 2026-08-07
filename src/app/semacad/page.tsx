import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import {
  ArrowUpRight,
  Check,
  Download,
  KeyRound,
  RotateCcw
} from "lucide-react";

import { SemacadHeroBackdrop } from "@/components/semacad/semacad-hero-backdrop";
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
    title: "完整的 FreeCAD，保留真实的手动 CAD 路径",
    body: "熟悉的工作台、参数和工程文件继续存在。OpenVac 辅助能力不会把专业建模缩减成一个聊天窗口，你可以随时回到完整的 FreeCAD 工作区继续操作。",
    visual: "workspace"
  },
  {
    number: "02",
    title: "把建模意图变成可检查的操作",
    body: "从意图理解、必要澄清到结构化计划和本地预览，OpenVac 会把高影响步骤停在执行之前。你先看清楚计划，再决定是否写入当前文档。",
    visual: "agent"
  },
  {
    number: "03",
    title: "本地优先，模型服务由你选择",
    body: "应用与工程文件以本地工作流为中心。需要模型能力时，SemaCAD 按照你选择并配置的服务商发起调用；密钥、服务选择与调用边界由你管理。",
    visual: "local"
  },
  {
    number: "04",
    title: "先预览，再确认；决定权留给工程师",
    body: "辅助操作强调可检查、可确认和可撤销。只有在你明确同意后才写入工程；不满意时可以继续修改或回到此前状态。",
    visual: "control"
  }
] as const;

function CapabilityVisual({
  visual
}: {
  visual: (typeof capabilitySections)[number]["visual"];
}) {
  if (visual === "workspace") {
    return (
      <div className="relative min-h-[330px] overflow-hidden rounded-[26px] bg-[#dfe6e9] sm:min-h-[430px]">
        <Image
          src="/semacad/semacad-public-beta-main-window-r1.png"
          alt="六孔真空盲板法兰示意件的 FreeCAD 工作区近景"
          fill
          sizes="(max-width: 1024px) 100vw, 56vw"
          className="object-cover object-[28%_50%] p-5 drop-shadow-[0_24px_45px_rgba(17,19,21,0.18)] sm:p-8"
        />
      </div>
    );
  }

  if (visual === "agent") {
    return (
      <div className="relative min-h-[330px] overflow-hidden rounded-[26px] bg-[#d8e1e7] sm:min-h-[430px]">
        <Image
          src="/semacad/semacad-public-beta-main-window-r1.png"
          alt="OpenVac 建模计划与等待确认状态近景"
          fill
          sizes="(max-width: 1024px) 100vw, 56vw"
          className="object-cover object-right p-5 drop-shadow-[0_24px_45px_rgba(17,19,21,0.18)] sm:p-8"
        />
      </div>
    );
  }

  if (visual === "local") {
    return (
      <div className="flex min-h-[330px] flex-col justify-between rounded-[26px] bg-[#eef1f0] p-7 sm:min-h-[430px] sm:p-10">
        <div className="flex size-12 items-center justify-center rounded-full bg-white shadow-sm">
          <KeyRound aria-hidden="true" className="size-5" strokeWidth={1.6} />
        </div>
        <div className="space-y-5">
          <div className="border-b border-[#cfd5d3] pb-5">
            <p className="text-sm text-[var(--muted)]">工程文件</p>
            <p className="mt-2 text-xl font-medium">保留在本地工作区</p>
          </div>
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <span className="rounded-full bg-white px-4 py-3 text-center">
              选择服务商
            </span>
            <span className="rounded-full bg-white px-4 py-3 text-center">
              配置自己的密钥
            </span>
            <span className="rounded-full bg-white px-4 py-3 text-center">
              确认调用边界
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[330px] flex-col justify-between rounded-[26px] bg-[#111412] p-7 text-white sm:min-h-[430px] sm:p-10">
      <div className="flex size-12 items-center justify-center rounded-full bg-white/10">
        <RotateCcw aria-hidden="true" className="size-5" strokeWidth={1.6} />
      </div>
      <div>
        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-center text-sm sm:gap-4 sm:text-base">
          <span className="rounded-full border border-white/20 px-3 py-3">
            检查
          </span>
          <span aria-hidden="true" className="text-white/40">
            →
          </span>
          <span className="rounded-full border border-white/20 px-3 py-3">
            确认
          </span>
          <span aria-hidden="true" className="text-white/40">
            →
          </span>
          <span className="rounded-full border border-white/20 px-3 py-3">
            形成版本
          </span>
        </div>
        <p className="mt-8 max-w-lg text-xl leading-8 text-[#c6cdca] sm:text-2xl sm:leading-9">
          随时继续修改或撤销，最终工程判断始终属于使用者。
        </p>
      </div>
    </div>
  );
}

export default async function SemacadPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const readyRelease = isSemacadDownloadReady(semacadRelease)
    ? semacadRelease
    : null;
  const releaseFacts = [
    ["发布状态", readyRelease ? "Public Beta" : "Public Beta · 准备中"],
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
        <section className="relative isolate min-h-[820px] overflow-hidden bg-[#dbe4eb] sm:min-h-[900px]">
          <SemacadHeroBackdrop />
          <div className="shell flex flex-col items-center pt-16 text-center sm:pt-20 lg:pt-24">
            <Image
              src="/semacad/semacad-app-icon.png"
              alt="SemaCAD 应用图标"
              width={168}
              height={168}
              priority
              className="size-[112px] rounded-[30px] shadow-[0_20px_52px_rgba(17,19,21,0.2)] md:size-[152px] md:rounded-[40px] lg:size-[168px] lg:rounded-[44px]"
            />
            <h1 className="mt-2 text-[clamp(3.7rem,8vw,7.5rem)] leading-[0.92] font-semibold tracking-[-0.075em]">
              SemaCAD
            </h1>
            <p className="mt-6 max-w-[720px] text-lg leading-8 tracking-[-0.02em] sm:text-2xl sm:leading-10">
              基于 FreeCAD 的本地优先 CAD，让手动建模与 OpenVac
              辅助建模在同一工作区完成。
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {readyRelease ? (
                <a
                  href={readyRelease.downloadUrl}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ink)] px-6 text-sm font-medium !text-white transition-transform hover:-translate-y-0.5"
                >
                  <Download aria-hidden="true" className="size-4" />
                  下载 Mac 版
                </a>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex min-h-12 cursor-not-allowed items-center justify-center gap-2 rounded-full bg-[#dfe2e2] px-6 text-sm font-medium text-[#707779]"
                >
                  <Download aria-hidden="true" className="size-4" />
                  下载准备中
                </span>
              )}
              <a
                href="https://github.com/zdywrnm/SemaCAD"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-black/20 bg-white/60 px-6 text-sm font-medium backdrop-blur-md transition-transform hover:-translate-y-0.5"
              >
                查看源代码
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </a>
            </div>
          </div>
        </section>

        <section
          className="shell relative z-10 -mt-[160px] pb-20 sm:-mt-[220px] sm:pb-28"
          aria-label="SemaCAD 应用预览"
        >
          {readyRelease ? (
            <div className="overflow-hidden rounded-[24px] border border-white/70 bg-[#e9ebeb] p-1.5 shadow-[0_36px_100px_rgba(17,25,30,0.24)] sm:rounded-[30px] sm:p-2.5">
              <Image
                src="/semacad/semacad-public-beta-main-window-r1.png"
                alt="六孔真空盲板法兰示意件与 OpenVac 计划面板"
                width={3136}
                height={1882}
                priority
                sizes="(max-width: 1420px) calc(100vw - 48px), 1368px"
                className="h-auto w-full rounded-[18px] sm:rounded-[22px]"
              />
            </div>
          ) : (
            <div className="flex min-h-64 flex-col justify-between rounded-[28px] border border-white/70 bg-white/70 p-7 backdrop-blur-md sm:min-h-80 sm:p-10">
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

        <section
          aria-label="SemaCAD 产品亮点"
          className="border-y border-[var(--border)]"
        >
          <div className="shell grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              "FreeCAD",
              "本地优先",
              "BYOK",
              "Apple Silicon",
              "已公证",
              "开源"
            ].map((item) => (
              <span
                key={item}
                className="flex min-h-16 items-center justify-center border-r border-b border-[var(--border)] px-3 text-center text-sm font-medium last:border-r-0 sm:min-h-20 lg:border-b-0"
              >
                {item}
              </span>
            ))}
          </div>
        </section>

        <section className="shell py-20 sm:py-32">
          <h2 className="max-w-5xl text-4xl leading-[1.08] font-semibold tracking-[-0.05em] sm:text-6xl">
            让专业建模与智能辅助发生在同一个工作区。
          </h2>
        </section>

        <div className="border-t border-[var(--border)]">
          {capabilitySections.map((section, index) => (
            <section
              key={section.number}
              className="shell grid min-h-[620px] items-center gap-12 border-b border-[var(--border)] py-16 sm:py-24 lg:grid-cols-[0.82fr_1.18fr] lg:gap-20"
            >
              <div className={index % 2 === 1 ? "lg:order-2" : ""}>
                <span className="text-sm text-[var(--muted)] tabular-nums">
                  {section.number}
                </span>
                <h2 className="mt-5 max-w-[560px] text-3xl leading-[1.12] font-semibold tracking-[-0.045em] sm:text-5xl">
                  {section.title}
                </h2>
                <p className="mt-7 max-w-[620px] text-lg leading-9 text-[var(--muted)]">
                  {section.body}
                </p>
              </div>
              <div className={index % 2 === 1 ? "lg:order-1" : ""}>
                <CapabilityVisual visual={section.visual} />
              </div>
            </section>
          ))}
        </div>

        <section className="shell py-20 sm:py-28" aria-label="SemaCAD 发布详情">
          <div className="mb-10 flex items-end justify-between gap-8">
            <div>
              <p className="text-sm font-medium text-[var(--muted)]">RELEASE</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">
                Public Beta
              </h2>
            </div>
            {readyRelease ? (
              <a
                href={readyRelease.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="hidden items-center gap-2 text-sm font-medium sm:inline-flex"
              >
                查看发布说明
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </a>
            ) : null}
          </div>
          <dl className="grid border-t border-l border-[var(--border)] text-sm sm:grid-cols-2 lg:grid-cols-4">
            {releaseFacts.map(([label, value]) => (
              <div
                key={label}
                className="border-r border-b border-[var(--border)] p-5 sm:p-6"
              >
                <dt className="text-[var(--muted)]">{label}</dt>
                <dd className="mt-3 font-medium">{value}</dd>
              </div>
            ))}
            {readyRelease ? (
              <div className="border-r border-b border-[var(--border)] p-5 sm:col-span-2 sm:p-6 lg:col-span-4">
                <dt className="text-[var(--muted)]">SHA-256</dt>
                <dd className="mt-3 font-mono text-xs leading-5 break-all">
                  {readyRelease.sha256}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section className="bg-[var(--ink)] text-white">
          <div className="shell flex min-h-[470px] flex-col items-start justify-center py-20 sm:py-28">
            <h2 className="max-w-4xl text-4xl leading-[1.05] font-semibold tracking-[-0.05em] sm:text-6xl">
              让 CAD 操作保持清楚，
              <br />
              也让决定权留在你手中。
            </h2>
            <p className="mt-6 max-w-xl leading-7 text-[#b7bdbd]">
              {readyRelease
                ? "SemaCAD Public Beta 面向 Apple Silicon Mac，源代码现已公开。"
                : "公开 Beta 正在完成发布校验；源代码现已公开。"}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              {readyRelease ? (
                <a
                  href={readyRelease.downloadUrl}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-sm font-medium !text-[var(--ink)] transition-colors hover:bg-[#eceeee]"
                >
                  <Download aria-hidden="true" className="size-4" />
                  下载 Mac 版
                </a>
              ) : null}
              <a
                href="https://github.com/zdywrnm/SemaCAD"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/25 px-6 text-sm font-medium !text-white"
              >
                查看源代码
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </a>
            </div>
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
