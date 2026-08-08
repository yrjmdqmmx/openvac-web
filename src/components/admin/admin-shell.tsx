"use client";

import { LogOut, Menu, UserRound } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { Brand } from "@/components/brand";
import { safeAccountAvatarUrl } from "@/lib/account-avatar";
import { authClient } from "@/lib/auth-client";
import type { AdminContext } from "@/server/api/types";

export function AdminShell({
  context,
  userName,
  children
}: {
  context?: AdminContext;
  userName?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const displayName = context?.user.name || userName || "运营管理员";
  const roleLabel = context?.role || "";
  const email = context?.user.email || "";
  const avatarUrl = safeAccountAvatarUrl(context?.user.image);
  const avatarFallback = (displayName.trim().charAt(0) || "运").toUpperCase();
  return (
    <div className="min-h-screen bg-white">
      <header className="flex h-[60px] items-center justify-between border-b border-[var(--border)] px-4 sm:px-6">
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="grid h-9 w-9 place-items-center lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="打开后台导航"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Brand compact />
          <span className="border-l border-[var(--border)] pl-4 text-sm">
            运营后台
          </span>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="hidden items-center gap-3 rounded-full border border-[var(--border)] px-3 py-2 text-sm sm:flex">
            <span
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-[var(--surface)] text-xs font-medium text-[var(--foreground)]"
              aria-label="账户头像"
            >
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt={displayName}
                  className="h-full w-full object-cover"
                />
              ) : (
                avatarFallback
              )}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{displayName}</div>
              <div className="truncate text-xs text-[var(--muted)]">
                {roleLabel}
                {email ? ` · ${email}` : ""}
              </div>
            </div>
          </div>
          <Link
            href="/settings"
            className="hidden items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm sm:inline-flex"
          >
            <UserRound className="h-4 w-4" />
            账户
          </Link>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
            onClick={() => void authClient.signOut()}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </header>
      <div className="grid min-h-[calc(100vh-60px)] lg:grid-cols-[246px_minmax(0,1fr)]">
        <AdminNav
          open={open}
          onClose={() => setOpen(false)}
          context={context}
        />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
