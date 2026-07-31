"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { Brand } from "@/components/brand";

export function AdminShell({
  userName,
  children
}: {
  userName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
        <span className="text-sm text-[var(--muted)]">{userName}</span>
      </header>
      <div className="grid min-h-[calc(100vh-60px)] lg:grid-cols-[246px_minmax(0,1fr)]">
        <AdminNav open={open} onClose={() => setOpen(false)} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
