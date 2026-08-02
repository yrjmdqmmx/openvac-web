import Link from "next/link";
import { Brand } from "@/components/brand";
import { isModelingEnabled } from "@/server/modeling/feature-flag";

export function SiteHeader({ authenticated }: { authenticated: boolean }) {
  const modelingEnabled = isModelingEnabled();
  return (
    <header className="app-header-shell flex h-[84px] shrink-0 items-center justify-between border-b border-transparent">
      <Brand />
      <nav
        className="flex items-center gap-5 text-sm font-medium sm:gap-9 sm:text-[15px]"
        aria-label="主导航"
      >
        {modelingEnabled ? (
          <Link
            href="/modeling"
            className="hidden transition-colors hover:text-[var(--muted)] sm:block"
          >
            智能建模
          </Link>
        ) : null}
        <Link
          href="/sources"
          className="hidden transition-colors hover:text-[var(--muted)] sm:block"
        >
          知识来源
        </Link>
        <a
          href="https://github.com/zdywrnm/openvac-web"
          target="_blank"
          rel="noreferrer"
          className="hidden transition-colors hover:text-[var(--muted)] sm:block"
        >
          开源项目
        </a>
        <Link
          href={authenticated ? "/chat" : "/sign-in"}
          className={
            authenticated
              ? "rounded-lg bg-[var(--ink)] px-5 py-2.5 text-white transition-colors hover:bg-[#292b2d]"
              : "rounded-full border border-[var(--border-strong)] px-4 py-2 transition-colors hover:border-[var(--ink)]"
          }
        >
          {authenticated ? "继续对话" : "登录"}
        </Link>
      </nav>
    </header>
  );
}
