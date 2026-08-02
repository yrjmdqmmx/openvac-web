import { headers } from "next/headers";
import Link from "next/link";
import { HomePrompt } from "@/components/home-prompt";
import { SiteHeader } from "@/components/site-header";
import { auth } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  return (
    <main className="flex min-h-screen flex-col bg-white">
      <div className="border-b border-[var(--border)]">
        <SiteHeader authenticated={Boolean(session)} />
      </div>

      <section className="shell flex flex-1 items-center py-16 sm:py-20">
        <div className="mx-auto w-full max-w-[884px] -translate-y-6 sm:-translate-y-7">
          <h1 className="text-center text-[clamp(2.35rem,4.2vw,3.75rem)] leading-[1.08] font-semibold tracking-[-0.06em] text-balance">
            今天想解决<span className="whitespace-nowrap">什么真空问题？</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[720px] text-center text-base leading-7 text-[var(--muted)] sm:text-[17px]">
            描述泵型、工况或故障现象，OpenVac 会结合资料给出可核查的回答。
          </p>
          <div className="mt-10 sm:mt-11">
            <HomePrompt currentUserId={session?.user.id} />
          </div>
          <p className="mt-8 text-center text-xs leading-6 text-[var(--muted)]">
            AI
            生成内容仅供排查参考；涉及拆机、电气或危险介质时，请由合格人员操作。
          </p>
        </div>
      </section>

      <footer className="border-t border-[var(--border)]">
        <div className="footer-shell flex flex-col gap-5 py-8 text-xs text-[var(--muted)] sm:min-h-[135px] sm:flex-row sm:items-center sm:justify-between sm:py-0">
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
