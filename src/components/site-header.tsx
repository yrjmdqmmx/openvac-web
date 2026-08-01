import Link from "next/link";
import { Brand } from "@/components/brand";
import { isModelingEnabled } from "@/server/modeling/feature-flag";

export function SiteHeader() {
  const modelingEnabled = isModelingEnabled();
  return (
    <header className="shell flex h-[92px] items-center justify-between">
      <Brand />
      <nav
        className="flex items-center gap-6 text-sm font-medium sm:gap-9 sm:text-base"
        aria-label="主导航"
      >
        {modelingEnabled ? (
          <Link
            href="/modeling"
            className="hidden transition-colors hover:text-[var(--accent)] sm:block"
          >
            智能建模
          </Link>
        ) : null}
        <Link
          href="/sources"
          className="hidden transition-colors hover:text-[var(--accent)] sm:block"
        >
          知识来源
        </Link>
        <a
          href="https://github.com/zdywrnm/openvac-web"
          target="_blank"
          rel="noreferrer"
          className="hidden transition-colors hover:text-[var(--accent)] sm:block"
        >
          开源项目
        </a>
        <Link
          href="/sign-in"
          className="rounded-full border border-[var(--border-strong)] px-4 py-2 transition-colors hover:border-[var(--ink)]"
        >
          登录
        </Link>
      </nav>
    </header>
  );
}
