"use client";

import { Database, MonitorSmartphone, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AccountSettingsContent,
  type AccountSettingsSection
} from "@/components/account/account-settings";
import { cn } from "@/lib/utils";

const sections: {
  id: AccountSettingsSection;
  label: string;
  icon: typeof UserRound;
}[] = [
  { id: "account", label: "账户", icon: UserRound },
  { id: "sessions", label: "登录与安全", icon: MonitorSmartphone },
  { id: "data", label: "数据管理", icon: Database }
];

export function AccountSettingsDialog({
  initialSection,
  userName,
  email,
  onClose
}: {
  initialSection: AccountSettingsSection;
  userName: string;
  email: string;
  onClose: () => void;
}) {
  const [section, setSection] =
    useState<AccountSettingsSection>(initialSection);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/25 p-3 backdrop-blur-[1px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-dialog-title"
        className="grid max-h-[min(760px,calc(100dvh-24px))] w-full max-w-[860px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-[0_24px_80px_rgba(17,19,21,0.22)] sm:max-h-[min(720px,calc(100dvh-48px))]"
      >
        <header className="flex h-16 items-center justify-between border-b border-[var(--border)] px-5 sm:px-6">
          <h2
            id="account-settings-dialog-title"
            className="text-lg font-semibold tracking-[-0.02em]"
          >
            设置
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            aria-label="关闭设置"
          >
            <X aria-hidden className="h-5 w-5" />
          </button>
        </header>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[190px_minmax(0,1fr)] sm:grid-rows-1">
          <nav
            aria-label="设置分类"
            className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[#f7f7f8] p-2 sm:flex-col sm:border-r sm:border-b-0 sm:p-3"
          >
            {sections.map((item) => {
              const Icon = item.icon;
              const selected = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    "flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)] sm:w-full",
                    selected
                      ? "bg-white font-medium shadow-[0_1px_2px_rgba(17,19,21,0.08)]"
                      : "text-[var(--muted)] hover:bg-[#ececed] hover:text-[var(--ink)]"
                  )}
                >
                  <Icon aria-hidden className="h-[18px] w-[18px]" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 overflow-y-auto px-5 py-6 sm:px-8 sm:py-7">
            <AccountSettingsContent
              email={email}
              userName={userName}
              section={section}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
