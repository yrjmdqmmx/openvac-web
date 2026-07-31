import { Brand } from "@/components/brand";
import Link from "next/link";

export function ContentPage({
  eyebrow,
  title,
  intro,
  children
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-white">
      <header className="shell flex h-20 items-center justify-between">
        <Brand compact />
        <Link
          href="/"
          className="text-sm text-[var(--muted)] hover:text-[var(--ink)]"
        >
          返回首页
        </Link>
      </header>
      <article className="shell max-w-[900px] py-16 sm:py-24">
        <p className="text-sm font-medium text-[var(--accent)]">{eyebrow}</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">
          {title}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--muted)]">
          {intro}
        </p>
        <div className="prose-openvac mt-16 space-y-12">{children}</div>
      </article>
    </main>
  );
}
