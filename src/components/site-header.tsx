"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { Brand } from "@/components/brand";

const publicNavItems = [{ href: "/semacad", label: "SemaCAD" }] as const;

function GitHubMark() {
  return (
    <svg
      data-testid="github-mark"
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      fill="currentColor"
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.21c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.29-1.69-1.29-1.69-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.93 10.93 0 0 1 5.75 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.21c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

export function SiteHeader({
  authenticated,
  appearance = "default"
}: {
  authenticated: boolean;
  appearance?: "default" | "glass";
}) {
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
    <header
      className={
        appearance === "glass"
          ? "relative z-30 bg-white/35 backdrop-blur-xl"
          : "relative z-30 bg-white"
      }
    >
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
            className="hidden items-center gap-1.5 transition-colors hover:text-[var(--muted)] sm:inline-flex"
          >
            <GitHubMark />
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
          className={`absolute inset-x-0 top-[84px] border-y border-[var(--border)] px-4 py-3 shadow-[0_18px_45px_rgba(17,19,21,0.08)] sm:hidden ${
            appearance === "glass" ? "bg-white/70 backdrop-blur-xl" : "bg-white"
          }`}
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
              className="flex min-h-11 items-center gap-2 text-[15px] font-medium"
            >
              <GitHubMark />
              开源项目
            </a>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
