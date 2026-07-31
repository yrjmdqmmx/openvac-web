import Link from "next/link";
import { Brand } from "@/components/brand";

export function AuthShell({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1fr)_440px]">
      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14">
        <Brand compact />
        <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center py-16">
          <h1 className="text-3xl font-semibold tracking-[-0.04em]">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
            {description}
          </p>
          <div className="mt-9">{children}</div>
        </div>
        <div className="flex gap-5 text-xs text-[var(--muted)]">
          <Link href="/legal/terms">服务协议</Link>
          <Link href="/legal/privacy">隐私政策</Link>
        </div>
      </section>

      <aside className="hidden border-l border-[var(--border)] bg-[var(--surface)] p-12 lg:flex lg:flex-col lg:justify-between">
        <p className="text-sm font-medium">OpenVac 真空泵专家</p>
        <blockquote className="text-[1.65rem] leading-[1.45] font-medium tracking-[-0.03em]">
          “先把工况讲清楚，
          <br />
          再让每个结论都有出处。”
        </blockquote>
        <p className="text-xs leading-6 text-[var(--muted)]">
          每日额度只在成功回答后结算。模型或检索失败不会扣除次数。
        </p>
      </aside>
    </main>
  );
}
