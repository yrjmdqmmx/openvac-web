"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { Brand } from "@/components/brand";

const publicNavItems = [
  { href: "/semacad", label: "SemaCAD" },
  { href: "/sources", label: "知识来源" }
] as const;

export function SiteHeader({ authenticated }: { authenticated: boolean }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMobileMenuOpen(false);
      menuButtonRef.current?.focus();
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);

  function closeMobileMenu() {
    setMobileMenuOpen(false);
    menuButtonRef.current?.focus();
  }

  return (
    <header className="relative z-30 bg-white">
      <div className="app-header-shell flex h-[84px] shrink-0 items-center justify-between">
        <Brand />
        <nav
          className="flex items-center gap-2 text-sm font-medium sm:gap-9 sm:text-[15px]"
          aria-label="主导航"
        >
          {publicNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="hidden transition-colors hover:text-[var(--muted)] sm:block"
            >
              {item.label}
            </Link>
          ))}
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
                ? "inline-flex min-h-11 items-center rounded-lg bg-[var(--ink)] px-4 !text-white transition-colors hover:bg-[#292b2d] sm:px-5"
                : "inline-flex min-h-11 items-center rounded-full border border-[var(--border-strong)] px-4 transition-colors hover:border-[var(--ink)]"
            }
          >
            {authenticated ? "继续对话" : "登录"}
          </Link>
          <button
            ref={menuButtonRef}
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface)] sm:hidden"
            aria-label={mobileMenuOpen ? "关闭导航菜单" : "打开导航菜单"}
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileMenuId}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            >
              {mobileMenuOpen ? (
                <>
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </>
              ) : (
                <>
                  <path d="M4 8h16" />
                  <path d="M4 16h16" />
                </>
              )}
            </svg>
          </button>
        </nav>
      </div>

      {mobileMenuOpen ? (
        <nav
          id={mobileMenuId}
          className="absolute inset-x-0 top-[84px] border-y border-[var(--border)] bg-white px-4 py-3 shadow-[0_18px_45px_rgba(17,19,21,0.08)] sm:hidden"
          aria-label="移动端导航"
        >
          <div className="mx-auto flex max-w-[1456px] flex-col">
            {publicNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeMobileMenu}
                className="flex min-h-11 items-center border-b border-[var(--border)] text-[15px] font-medium last:border-b-0"
              >
                {item.label}
              </Link>
            ))}
            <a
              href="https://github.com/zdywrnm/openvac-web"
              target="_blank"
              rel="noreferrer"
              onClick={closeMobileMenu}
              className="flex min-h-11 items-center text-[15px] font-medium"
            >
              开源项目
              <span className="ml-1.5 text-xs text-[var(--muted)]" aria-hidden>
                ↗
              </span>
            </a>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
