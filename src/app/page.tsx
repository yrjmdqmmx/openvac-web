import Link from "next/link";
import { BookOpenText, Code2, ShieldCheck } from "lucide-react";
import { HomePrompt } from "@/components/home-prompt";
import { SiteHeader } from "@/components/site-header";

const principles = [
  {
    icon: BookOpenText,
    title: "答案有来源",
    body: "引用可展开、可回到原文；证据不足就明确追问。"
  },
  {
    icon: ShieldCheck,
    title: "安全有边界",
    body: "高风险工况只给停机、隔离与检查建议，并要求联系制造商或现场合格人员。"
  },
  {
    icon: Code2,
    title: "源码可审计",
    body: "OpenVac Web 采用 AGPL-3.0 开源，模型与密钥仅在服务端。"
  }
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white">
      <SiteHeader />

      <section className="shell pt-[10vh] sm:pt-[12vh]">
        <div className="mx-auto max-w-[920px]">
          <h1 className="text-[2.65rem] leading-[1.08] font-semibold tracking-[-0.055em] text-balance sm:text-[3.5rem]">
            真空泵问题，直接问
          </h1>
          <p className="mt-5 text-base leading-8 text-[var(--muted)] sm:text-lg">
            选泵、查故障、理解方案、找配件，不用再翻手册。
          </p>
          <div className="mt-12">
            <HomePrompt />
          </div>
          <p className="mt-4 text-center text-xs leading-6 text-[var(--muted)]">
            AI
            生成内容仅供排查参考；涉及拆机、电气或危险介质时，请由合格人员操作。
          </p>
        </div>
      </section>

      <section
        className="shell mt-[15vh] border-t border-[var(--border)] py-14 sm:mt-[18vh]"
        aria-label="产品原则"
      >
        <div className="grid gap-10 md:grid-cols-3 md:gap-14">
          {principles.map(({ icon: Icon, title, body }) => (
            <article key={title} className="flex items-start gap-4">
              <Icon
                className="mt-0.5 h-6 w-6 shrink-0 text-[var(--accent)]"
                strokeWidth={1.6}
              />
              <div>
                <h2 className="font-medium">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  {body}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer className="border-t border-[var(--border)]">
        <div className="shell flex flex-col gap-5 py-7 text-xs text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 OpenVac · 真空泵专家 Agent</span>
          <nav className="flex flex-wrap gap-5" aria-label="页脚导航">
            <Link href="/product">产品说明</Link>
            <Link href="/legal/terms">服务协议</Link>
            <Link href="/legal/privacy">隐私政策</Link>
            <Link href="/feedback">问题反馈</Link>
            <Link href="/complaints">法律投诉</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
