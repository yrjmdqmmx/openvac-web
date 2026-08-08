import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { HomePrompt } from "@/components/home-prompt";
import { SemacadHeroBackdrop } from "@/components/semacad/semacad-hero-backdrop";
import { SiteHeader } from "@/components/site-header";
import { apiStore } from "@/server/api/store";
import { auth } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth.api.getSession({
    headers: await headers()
  });
  let hasAdminRole = false;
  if (session) {
    try {
      hasAdminRole = Boolean(await apiStore.getAdminRole(session.user.id));
    } catch {
      // Public pages remain available when RBAC storage is unavailable or
      // the account is intentionally fail-closed due to a role conflict.
    }
  }

  return (
    <main className="relative isolate flex min-h-screen flex-col overflow-x-hidden">
      <SemacadHeroBackdrop />
      <div className="relative z-20 border-b border-[var(--border)]">
        <SiteHeader
          authenticated={Boolean(session)}
          user={
            session
              ? { name: session.user.name, image: session.user.image }
              : undefined
          }
          hasAdminRole={hasAdminRole}
          appearance="glass"
        />
      </div>

      <section className="shell relative z-10 flex flex-1 items-center py-16 sm:py-20">
        <div className="mx-auto w-full max-w-[884px]">
          <h1
            aria-label="今天想解决什么真空问题？"
            className="text-center text-[clamp(2.35rem,4.2vw,3.75rem)] leading-[1.08] font-semibold tracking-[-0.06em] text-balance drop-shadow-[0_2px_14px_rgba(255,255,255,0.78)]"
          >
            <span className="block sm:inline">今天想解决</span>
            <span className="block whitespace-nowrap sm:inline">
              什么真空问题？
            </span>
          </h1>
          <p className="mx-auto mt-5 w-fit max-w-[720px] rounded-2xl bg-[rgba(255,255,255,0.72)] px-4 py-2 text-center text-base leading-7 text-[#344048] shadow-[0_10px_30px_rgba(20,30,36,0.06)] backdrop-blur-xl sm:px-5 sm:text-[17px]">
            描述泵型、工况或故障现象，OpenVac 会结合资料给出可核查的回答。
          </p>
          <div className="mt-10 sm:mt-11">
            <HomePrompt currentUserId={session?.user.id} />
          </div>
          <p className="mx-auto mt-8 w-fit max-w-full rounded-full bg-[rgba(255,255,255,0.76)] px-4 py-1.5 text-center text-xs leading-6 text-[#3f494f] backdrop-blur-xl">
            AI
            生成内容仅供排查参考；涉及拆机、电气或危险介质时，请由合格人员操作。
          </p>
          <Link
            href="/semacad"
            className="group mt-10 flex items-center gap-4 rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.68)] px-5 py-4 shadow-[0_18px_45px_rgba(17,25,30,0.10)] backdrop-blur-xl transition-colors hover:border-white/90 sm:gap-5 sm:px-6"
          >
            <Image
              src="/semacad/semacad-app-icon.png"
              alt=""
              width={56}
              height={56}
              className="size-12 shrink-0 rounded-[13px] sm:size-14 sm:rounded-2xl"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold tracking-[-0.02em]">
                SemaCAD
              </span>
              <span className="mt-1 block text-sm leading-6 text-[#38434a]">
                基于 FreeCAD 的本地优先 CAD，让手动建模与 OpenVac
                辅助建模在同一工作区完成。
              </span>
            </span>
            <span className="hidden shrink-0 items-center gap-1.5 text-sm font-medium sm:inline-flex">
              了解 SemaCAD
              <ArrowUpRight
                aria-hidden="true"
                className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                strokeWidth={1.75}
              />
            </span>
          </Link>
        </div>
      </section>

      <footer className="relative z-10 border-t border-[var(--border)] bg-[rgba(255,255,255,0.68)] text-[#465057] backdrop-blur-xl">
        <div className="footer-shell flex flex-col gap-5 py-8 text-xs sm:min-h-[135px] sm:flex-row sm:items-center sm:justify-between sm:py-0">
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
