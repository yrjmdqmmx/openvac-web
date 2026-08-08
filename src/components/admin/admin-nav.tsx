"use client";

import {
  BarChart3,
  BookOpen,
  Bot,
  ClipboardList,
  Database,
  FileCheck2,
  Gauge,
  MessagesSquare,
  ScrollText,
  ShieldCheck,
  Users,
  X
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AdminCapability, AdminContext } from "@/server/api/types";
import { cn } from "@/lib/utils";

const items = [
  {
    href: "/admin",
    label: "概览",
    icon: BarChart3,
    capabilities: ["metrics:read"] as AdminCapability[]
  },
  {
    href: "/admin/users",
    label: "用户",
    icon: Users,
    capabilities: ["users:read"] as AdminCapability[]
  },
  {
    href: "/admin/conversations",
    label: "对话",
    icon: MessagesSquare,
    capabilities: ["conversations:read"] as AdminCapability[]
  },
  {
    href: "/admin/feedback",
    label: "用户反馈",
    icon: MessagesSquare,
    capabilities: ["feedback:read"] as AdminCapability[]
  },
  {
    href: "/admin/problem-reports",
    label: "问题反馈",
    icon: ClipboardList,
    capabilities: ["problem_reports:read"] as AdminCapability[]
  },
  {
    href: "/admin/knowledge",
    label: "知识库",
    icon: BookOpen,
    capabilities: ["knowledge:read"] as AdminCapability[]
  },
  {
    href: "/admin/sources",
    label: "来源白名单",
    icon: ShieldCheck,
    capabilities: ["sources:read"] as AdminCapability[]
  },
  {
    href: "/admin/prompts",
    label: "提示词与评测",
    icon: FileCheck2,
    capabilities: ["prompts:read"] as AdminCapability[]
  },
  {
    href: "/admin/models",
    label: "模型与预算",
    icon: Bot,
    capabilities: ["models:execute", "budgets:read"] as AdminCapability[]
  },
  {
    href: "/admin/admins",
    label: "管理员",
    icon: Database,
    capabilities: ["admins:read"] as AdminCapability[]
  },
  {
    href: "/admin/audit",
    label: "审计日志",
    icon: ScrollText,
    capabilities: ["audit:read"] as AdminCapability[]
  }
];

export function AdminNav({
  open,
  onClose,
  context
}: {
  open: boolean;
  onClose: () => void;
  context?: AdminContext;
}) {
  const pathname = usePathname();
  const visibleItems = context
    ? items.filter((item) =>
        item.capabilities.some((capability) =>
          context.capabilities.includes(capability)
        )
      )
    : items;
  return (
    <>
      {open && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={onClose}
          aria-label="关闭导航"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[246px] border-r border-[var(--border)] bg-white pt-[72px] transition-transform lg:static lg:translate-x-0 lg:pt-4",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 grid h-9 w-9 place-items-center lg:hidden"
          aria-label="关闭导航"
        >
          <X className="h-5 w-5" />
        </button>
        <nav className="space-y-1 px-3" aria-label="运营后台">
          {visibleItems.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/admin"
                ? pathname === href
                : pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-lg border-l-2 px-3 text-sm",
                  active
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium"
                    : "border-transparent hover:bg-[var(--surface)]"
                )}
              >
                <Icon className="h-4.5 w-4.5" strokeWidth={1.7} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-8 px-6 text-xs leading-6 text-[var(--muted)]">
          <Gauge className="mb-2 h-4 w-4" />
          完整审计留痕。
        </div>
      </aside>
    </>
  );
}
