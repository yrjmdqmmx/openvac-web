"use client";

import {
  ChevronLeft,
  LogOut,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Settings,
  X
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Brand } from "@/components/brand";
import type { ConversationSummary } from "@/types/chat";
import { authClient } from "@/lib/auth-client";
import { clearPendingQuestionDraft } from "@/lib/pending-question-draft";
import { cn } from "@/lib/utils";

export function ConversationSidebar({
  conversations,
  activeId,
  open,
  onOpenChange,
  onSelect,
  onNew,
  onRename,
  onDelete,
  userName
}: {
  conversations: ConversationSummary[];
  activeId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  userName: string;
}) {
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string>();

  const visible = useMemo(
    () =>
      conversations.filter((conversation) =>
        conversation.title.toLowerCase().includes(query.toLowerCase())
      ),
    [conversations, query]
  );

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="fixed top-4 left-4 z-30 grid h-10 w-10 place-items-center rounded-full border border-[var(--border)] bg-white lg:hidden"
        aria-label="打开历史对话"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <button
          type="button"
          aria-label="关闭历史对话"
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => onOpenChange(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[300px] flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-20 items-center justify-between px-5">
          <Brand compact />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid h-9 w-9 place-items-center rounded-full hover:bg-white"
            aria-label="收起侧栏"
          >
            <ChevronLeft className="hidden h-5 w-5 lg:block" />
            <X className="h-5 w-5 lg:hidden" />
          </button>
        </div>

        <div className="px-4">
          <button
            type="button"
            onClick={onNew}
            className="flex h-12 w-full items-center gap-3 rounded-lg border border-[var(--border-strong)] bg-white px-4 text-sm font-medium"
          >
            <MessageSquarePlus className="h-5 w-5" />
            新对话
          </button>
          <label className="mt-3 flex h-11 items-center gap-3 rounded-lg px-3 text-sm text-[var(--muted)] focus-within:bg-white">
            <Search className="h-4 w-4" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent outline-none"
              placeholder="搜索对话"
            />
          </label>
        </div>

        <div className="mt-5 flex-1 overflow-y-auto px-3">
          <p className="px-3 py-2 text-xs text-[var(--muted)]">最近对话</p>
          <ul className="space-y-1">
            {visible.map((conversation) => (
              <li key={conversation.id} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    onSelect(conversation.id);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "flex min-h-11 w-full items-center rounded-lg border-l-2 px-3 pr-10 text-left text-sm",
                    activeId === conversation.id
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-transparent hover:bg-white"
                  )}
                >
                  <span className="truncate">{conversation.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setMenuId((current) =>
                      current === conversation.id ? undefined : conversation.id
                    )
                  }
                  className="absolute top-1.5 right-1.5 grid h-8 w-8 place-items-center rounded-md hover:bg-white"
                  aria-label={`${conversation.title} 的更多操作`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuId === conversation.id && (
                  <div className="absolute top-10 right-1 z-10 w-32 rounded-lg border border-[var(--border)] bg-white p-1 text-sm shadow-lg">
                    <button
                      type="button"
                      className="w-full rounded-md px-3 py-2 text-left hover:bg-[var(--surface)]"
                      onClick={() => {
                        const title = window.prompt(
                          "重命名对话",
                          conversation.title
                        );
                        if (title?.trim()) {
                          onRename(conversation.id, title.trim());
                        }
                        setMenuId(undefined);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-md px-3 py-2 text-left text-[var(--danger)] hover:bg-[#fff7f6]"
                      onClick={() => {
                        if (
                          window.confirm("删除这段对话？删除后将立即不可见。")
                        ) {
                          onDelete(conversation.id);
                        }
                        setMenuId(undefined);
                      }}
                    >
                      删除
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-[var(--border)] p-4">
          <div className="flex items-center gap-3 px-2 py-2">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-sm text-white">
              {userName.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{userName}</span>
            <Link href="/settings" aria-label="账户设置">
              <Settings className="h-4 w-4 text-[var(--muted)]" />
            </Link>
            <button
              type="button"
              aria-label="退出登录"
              onClick={async () => {
                clearPendingQuestionDraft();
                await authClient.signOut();
                window.location.assign("/");
              }}
            >
              <LogOut className="h-4 w-4 text-[var(--muted)]" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
