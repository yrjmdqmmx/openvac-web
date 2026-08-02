"use client";

import {
  LogOut,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Settings,
  X,
  LoaderCircle
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "@/types/chat";
import { authClient } from "@/lib/auth-client";
import {
  clearPendingQuestionDraft,
  clearPendingQuestionIntent
} from "@/lib/pending-question-draft";
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
  searchQuery,
  onSearchQueryChange,
  loading,
  hasMore,
  onLoadMore,
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
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  userName: string;
}) {
  const [menuId, setMenuId] = useState<string>();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const searching = Boolean(searchQuery.trim());

  useEffect(() => {
    if (!open) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="点击遮罩关闭对话记录"
        className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]"
        onClick={() => onOpenChange(false)}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-history-title"
        className="fixed inset-y-0 left-0 z-40 flex w-[min(360px,calc(100vw-20px))] flex-col border-r border-[var(--border)] bg-[var(--surface)] shadow-[12px_0_40px_rgba(17,19,21,0.12)]"
      >
        <div className="flex h-[84px] items-center justify-between border-b border-[var(--border)] px-5">
          <h2 id="conversation-history-title" className="text-lg font-semibold">
            对话记录
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white"
            aria-label="关闭对话记录"
          >
            <X className="h-5 w-5" />
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
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              className="min-w-0 flex-1 bg-transparent outline-none"
              placeholder="搜索对话"
              aria-label="搜索对话"
            />
          </label>
        </div>

        <div className="mt-5 flex-1 overflow-y-auto px-3">
          <div className="flex items-center justify-between px-3 py-2 text-xs text-[var(--muted)]">
            <p>{searching ? "搜索结果" : "最近对话"}</p>
            {loading && (
              <span className="flex items-center gap-1" role="status">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {searching ? "搜索中" : "加载中"}
              </span>
            )}
          </div>
          <ul className="space-y-1">
            {conversations.map((conversation) => (
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
                      ? "border-[#6e7376] bg-[#e8eaea]"
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
          {!loading && conversations.length === 0 && (
            <p className="px-3 py-6 text-center text-xs leading-5 text-[var(--muted)]">
              {searching ? "没有找到匹配的对话。" : "还没有历史对话。"}
            </p>
          )}
          {hasMore && (
            <button
              type="button"
              disabled={loading}
              onClick={onLoadMore}
              className="mt-3 h-10 w-full rounded-lg text-xs font-medium text-[var(--muted)] hover:bg-white disabled:opacity-50"
            >
              {loading ? "正在加载…" : "加载更多对话"}
            </button>
          )}
        </div>

        <div className="border-t border-[var(--border)] p-4">
          <div className="flex items-center gap-3 px-2 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{userName}</span>
            <Link href="/settings" aria-label="账户设置">
              <Settings className="h-4 w-4 text-[var(--muted)]" />
            </Link>
            <button
              type="button"
              aria-label="退出登录"
              onClick={async () => {
                clearPendingQuestionDraft();
                clearPendingQuestionIntent();
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
