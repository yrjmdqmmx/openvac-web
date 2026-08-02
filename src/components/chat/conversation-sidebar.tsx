"use client";

import {
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  LogOut,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  UserRound
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  clearPendingQuestionDraft,
  clearPendingQuestionIntent
} from "@/lib/pending-question-draft";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "@/types/chat";

function accountInitial(userName: string) {
  return Array.from(userName.trim())[0]?.toLocaleUpperCase("zh-CN") ?? "U";
}

export function ConversationSidebar({
  conversations,
  activeId,
  expanded,
  onExpandedChange,
  mobileOpen,
  onMobileOpenChange,
  onSelect,
  onNew,
  onRename,
  onDelete,
  searchQuery,
  onSearchQueryChange,
  loading,
  hasMore,
  onLoadMore,
  userName,
  userEmail
}: {
  conversations: ConversationSummary[];
  activeId?: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
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
  userEmail: string;
}) {
  const [conversationMenuId, setConversationMenuId] = useState<string>();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const mobileReturnFocusRef = useRef<HTMLElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const firstAccountItemRef = useRef<HTMLAnchorElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusRequestedRef = useRef(false);
  const searching = Boolean(searchQuery.trim());
  const fullSidebar = expanded || mobileOpen;
  const initial = accountInitial(userName);

  useEffect(() => {
    if (!mobileOpen) return;

    mobileReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelToggleRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setConversationMenuId(undefined);
        onMobileOpenChange(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      mobileReturnFocusRef.current?.focus();
    };
  }, [mobileOpen, onMobileOpenChange]);

  useEffect(() => {
    if (!expanded || !searchFocusRequestedRef.current) return;
    searchFocusRequestedRef.current = false;
    searchInputRef.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    firstAccountItemRef.current?.focus();

    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountMenuRef.current?.contains(event.target)
      ) {
        setAccountMenuOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setAccountMenuOpen(false);
      accountButtonRef.current?.focus();
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  function openSearchFromRail() {
    searchFocusRequestedRef.current = true;
    onExpandedChange(true);
  }

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="点击遮罩关闭对话记录"
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] lg:hidden"
          onClick={() => {
            setConversationMenuId(undefined);
            onMobileOpenChange(false);
          }}
        />
      ) : null}

      <aside
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? "true" : undefined}
        aria-labelledby={mobileOpen ? "conversation-history-title" : undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--border)] bg-[#f7f7f8] transition-[width,transform] duration-200 lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 lg:shadow-none",
          mobileOpen
            ? "visible w-[min(320px,calc(100vw-16px))] translate-x-0 shadow-[12px_0_40px_rgba(17,19,21,0.12)]"
            : "invisible w-[min(320px,calc(100vw-16px))] -translate-x-full lg:visible lg:flex",
          expanded ? "lg:w-[280px]" : "lg:w-[68px]"
        )}
      >
        <div
          className={cn(
            "flex h-[68px] shrink-0 items-center border-b border-transparent",
            fullSidebar ? "justify-between px-4" : "justify-center px-2"
          )}
        >
          {fullSidebar ? (
            <Link
              href="/"
              className="text-xl font-semibold tracking-[-0.045em]"
              aria-label="OpenVac 首页"
            >
              OpenVac
            </Link>
          ) : null}
          <button
            ref={panelToggleRef}
            type="button"
            onClick={() => {
              if (mobileOpen) {
                setConversationMenuId(undefined);
                onMobileOpenChange(false);
                return;
              }
              if (expanded) setConversationMenuId(undefined);
              onExpandedChange(!expanded);
            }}
            className="grid h-10 w-10 place-items-center rounded-lg transition-colors hover:bg-[#ececed] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            aria-label={
              mobileOpen ? "关闭对话记录" : expanded ? "收起边栏" : "展开边栏"
            }
          >
            {mobileOpen || expanded ? (
              <PanelLeftClose aria-hidden className="h-[19px] w-[19px]" />
            ) : (
              <PanelLeftOpen aria-hidden className="h-[19px] w-[19px]" />
            )}
          </button>
        </div>

        {fullSidebar ? (
          <>
            <h2 id="conversation-history-title" className="sr-only">
              对话记录
            </h2>
            <div className="px-3">
              <button
                type="button"
                onClick={() => {
                  onNew();
                  if (mobileOpen) {
                    setConversationMenuId(undefined);
                    onMobileOpenChange(false);
                  }
                }}
                className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-[#ececed] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]"
              >
                <MessageSquarePlus aria-hidden className="h-[18px] w-[18px]" />
                新对话
              </button>
              <label className="mt-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm text-[var(--muted)] transition-colors focus-within:bg-white focus-within:text-[var(--ink)]">
                <Search aria-hidden className="h-[17px] w-[17px]" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => onSearchQueryChange(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
                  placeholder="搜索对话"
                  aria-label="搜索对话"
                />
              </label>
            </div>

            <div className="mt-4 flex-1 overflow-y-auto px-3">
              <div className="flex items-center justify-between px-3 py-2 text-xs text-[var(--muted)]">
                <p>{searching ? "搜索结果" : "最近对话"}</p>
                {loading ? (
                  <span className="flex items-center gap-1" role="status">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    {searching ? "搜索中" : "加载中"}
                  </span>
                ) : null}
              </div>
              <ul className="space-y-1">
                {conversations.map((conversation) => (
                  <li key={conversation.id} className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(conversation.id);
                        if (mobileOpen) {
                          setConversationMenuId(undefined);
                          onMobileOpenChange(false);
                        }
                      }}
                      className={cn(
                        "flex min-h-11 w-full items-center rounded-lg px-3 pr-10 text-left text-sm transition-colors",
                        activeId === conversation.id
                          ? "bg-[#e7e7e8]"
                          : "hover:bg-[#ececed]"
                      )}
                      aria-current={
                        activeId === conversation.id ? "page" : undefined
                      }
                    >
                      <span className="truncate">{conversation.title}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setConversationMenuId((current) =>
                          current === conversation.id
                            ? undefined
                            : conversation.id
                        )
                      }
                      className="absolute top-1.5 right-1.5 grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-white"
                      aria-label={`${conversation.title} 的更多操作`}
                    >
                      <MoreHorizontal aria-hidden className="h-4 w-4" />
                    </button>
                    {conversationMenuId === conversation.id ? (
                      <div className="absolute top-10 right-1 z-10 w-32 rounded-xl border border-[var(--border)] bg-white p-1 text-sm shadow-lg">
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left hover:bg-[var(--surface)]"
                          onClick={() => {
                            const title = window.prompt(
                              "重命名对话",
                              conversation.title
                            );
                            if (title?.trim()) {
                              onRename(conversation.id, title.trim());
                            }
                            setConversationMenuId(undefined);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left text-[var(--danger)] hover:bg-[#fff7f6]"
                          onClick={() => {
                            if (
                              window.confirm(
                                "删除这段对话？删除后将立即不可见。"
                              )
                            ) {
                              onDelete(conversation.id);
                            }
                            setConversationMenuId(undefined);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!loading && conversations.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs leading-5 text-[var(--muted)]">
                  {searching ? "没有找到匹配的对话。" : "还没有历史对话。"}
                </p>
              ) : null}
              {hasMore ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={onLoadMore}
                  className="mt-3 h-10 w-full rounded-lg text-xs font-medium text-[var(--muted)] hover:bg-white disabled:opacity-50"
                >
                  {loading ? "正在加载…" : "加载更多对话"}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center gap-1 px-2 pt-1">
            <button
              type="button"
              onClick={onNew}
              className="grid h-11 w-11 place-items-center rounded-lg transition-colors hover:bg-[#ececed] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]"
              aria-label="新对话"
              title="新对话"
            >
              <MessageSquarePlus aria-hidden className="h-[19px] w-[19px]" />
            </button>
            <button
              type="button"
              onClick={openSearchFromRail}
              className="grid h-11 w-11 place-items-center rounded-lg transition-colors hover:bg-[#ececed] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]"
              aria-label="搜索对话"
              title="搜索对话"
            >
              <Search aria-hidden className="h-[18px] w-[18px]" />
            </button>
          </div>
        )}

        <div
          ref={accountMenuRef}
          className={cn(
            "relative shrink-0 border-t border-[var(--border)]",
            fullSidebar ? "p-3" : "p-2"
          )}
        >
          {accountMenuOpen ? (
            <div
              role="menu"
              aria-label="账户菜单"
              className={cn(
                "absolute bottom-[calc(100%+8px)] z-20 rounded-2xl border border-[var(--border)] bg-white p-2 shadow-[0_16px_50px_rgba(17,19,21,0.16)]",
                fullSidebar ? "right-3 left-3" : "left-2 w-[264px]"
              )}
            >
              <div className="flex items-center gap-3 px-2 py-2.5">
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-sm font-medium text-white"
                  aria-hidden
                >
                  {initial}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {userName}
                  </span>
                  <span className="block truncate text-xs text-[var(--muted)]">
                    {userEmail}
                  </span>
                </span>
              </div>
              <div className="my-1 border-t border-[var(--border)]" />
              <Link
                ref={firstAccountItemRef}
                href="/settings#profile"
                role="menuitem"
                className="flex h-11 items-center gap-3 rounded-lg px-3 text-sm hover:bg-[var(--surface)]"
              >
                <UserRound aria-hidden className="h-[18px] w-[18px]" />
                个人资料
              </Link>
              <Link
                href="/settings"
                role="menuitem"
                className="flex h-11 items-center gap-3 rounded-lg px-3 text-sm hover:bg-[var(--surface)]"
              >
                <Settings aria-hidden className="h-[18px] w-[18px]" />
                设置
              </Link>
              <Link
                href="/help"
                role="menuitem"
                className="flex h-11 items-center gap-3 rounded-lg px-3 text-sm hover:bg-[var(--surface)]"
              >
                <CircleHelp aria-hidden className="h-[18px] w-[18px]" />
                帮助
              </Link>
              <div className="my-1 border-t border-[var(--border)]" />
              <button
                type="button"
                role="menuitem"
                className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-[var(--surface)]"
                onClick={async () => {
                  clearPendingQuestionDraft();
                  clearPendingQuestionIntent();
                  await authClient.signOut();
                  window.location.assign("/");
                }}
              >
                <LogOut aria-hidden className="h-[18px] w-[18px]" />
                退出登录
              </button>
            </div>
          ) : null}

          <button
            ref={accountButtonRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            aria-label={`账户：${userName}`}
            title={fullSidebar ? undefined : userName}
            onClick={() => setAccountMenuOpen((current) => !current)}
            className={cn(
              "flex items-center rounded-xl transition-colors hover:bg-[#ececed] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]",
              fullSidebar
                ? "h-12 w-full gap-3 px-2"
                : "mx-auto h-11 w-11 justify-center"
            )}
          >
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-xs font-medium text-white"
              aria-hidden
            >
              {initial}
            </span>
            {fullSidebar ? (
              <>
                <span className="min-w-0 flex-1 truncate text-left text-sm">
                  {userName}
                </span>
                <ChevronRight
                  aria-hidden
                  className="h-4 w-4 text-[var(--muted)]"
                />
              </>
            ) : null}
          </button>
        </div>
      </aside>
    </>
  );
}
