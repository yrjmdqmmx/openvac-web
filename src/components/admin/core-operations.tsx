"use client";

import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRoundCog
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import type {
  AdminCapability,
  AdminContext,
  AdminRole
} from "@/server/api/types";

type Row = Record<string, unknown>;
type PageData = {
  items: Row[];
  page: number;
  pageSize: number;
  total: number;
};

const emptyPage: PageData = { items: [], page: 1, pageSize: 20, total: 0 };

function record(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function formatDate(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false
      });
}

function parsePage(payload: unknown): PageData {
  const data = record(record(payload).data);
  const items = Array.isArray(data.items)
    ? data.items.filter(
        (item): item is Row => typeof item === "object" && item !== null
      )
    : [];
  return {
    items,
    page: typeof data.page === "number" ? data.page : 1,
    pageSize: typeof data.pageSize === "number" ? data.pageSize : 20,
    total: typeof data.total === "number" ? data.total : items.length
  };
}

async function readError(response: Response): Promise<string> {
  const payload = record(await response.json().catch(() => null));
  const error = record(payload.error);
  const message = text(error.message);
  const requestId =
    response.headers.get("x-request-id") || text(error.requestId);
  const fallback =
    response.status === 403
      ? "当前角色无权执行该操作。"
      : response.status === 409
        ? "记录已变化，请刷新后重试。"
        : "操作暂时失败，请稍后重试。";
  return `${message || fallback}${requestId ? `（请求 ${requestId}）` : ""}`;
}

function useAdminPage(endpoint: string, initialStatus = "") {
  const [data, setData] = useState<PageData>(emptyPage);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "20"
      });
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      try {
        const response = await fetch(`${endpoint}?${params}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(await readError(response));
        setData(parsePage(await response.json()));
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "读取失败。");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, page, query, revision, status]);

  return {
    data,
    query,
    setQuery: (value: string) => {
      setPage(1);
      setQuery(value);
    },
    status,
    setStatus: (value: string) => {
      setPage(1);
      setStatus(value);
    },
    page,
    setPage,
    loading,
    error,
    refresh
  };
}

function useAdminContext() {
  const [context, setContext] = useState<AdminContext | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/context", {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = record(await response.json());
        setContext(record(payload.data) as AdminContext);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return context;
}

function has(context: AdminContext | null, capability: AdminCapability) {
  return Boolean(context?.capabilities.includes(capability));
}

function Header({
  title,
  description,
  onRefresh
}: {
  title: string;
  description: string;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <h1 className="text-3xl font-semibold tracking-[-0.04em]">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">
          {description}
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 text-sm"
      >
        <RefreshCw size={16} /> 刷新
      </button>
    </div>
  );
}

function Filters({
  query,
  onQuery,
  status,
  onStatus,
  statuses
}: {
  query: string;
  onQuery: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  statuses: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
      <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] px-3">
        <Search size={16} className="text-[var(--muted)]" />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          className="min-w-0 flex-1 outline-none"
          placeholder="服务端搜索"
        />
      </label>
      <select
        value={status}
        onChange={(event) => onStatus(event.target.value)}
        className="min-h-11 rounded-lg border border-[var(--border)] bg-white px-3 text-sm"
      >
        <option value="">全部状态</option>
        {statuses.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Pager({ page }: { page: ReturnType<typeof useAdminPage> }) {
  const last = Math.max(1, Math.ceil(page.data.total / page.data.pageSize));
  return (
    <div className="mt-5 flex items-center justify-between text-sm text-[var(--muted)]">
      <span>共 {page.data.total} 条</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page.page <= 1}
          onClick={() => page.setPage(Math.max(1, page.page - 1))}
          className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] disabled:opacity-40"
          aria-label="上一页"
        >
          <ChevronLeft size={16} />
        </button>
        <span>
          {page.page} / {last}
        </span>
        <button
          type="button"
          disabled={page.page >= last}
          onClick={() => page.setPage(Math.min(last, page.page + 1))}
          className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] disabled:opacity-40"
          aria-label="下一页"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function LoadingOrError({
  loading,
  error
}: {
  loading: boolean;
  error: string;
}) {
  if (loading)
    return (
      <div className="grid min-h-56 place-items-center">
        <LoaderCircle className="animate-spin text-[var(--muted)]" />
      </div>
    );
  if (error)
    return (
      <p
        role="alert"
        className="mt-5 rounded-lg bg-red-50 p-4 text-sm text-red-700"
      >
        {error}
      </p>
    );
  return null;
}

function StatusMessage({ message }: { message: string }) {
  return message ? (
    <p
      role="status"
      className="mt-4 rounded-lg bg-[var(--accent-soft)] p-3 text-sm"
    >
      {message}
    </p>
  ) : null;
}

export function UsersManager() {
  const page = useAdminPage("/api/admin/users");
  const context = useAdminContext();
  const [selectedId, setSelectedId] = useState("");
  const selected =
    page.data.items.find((item) => text(item.id) === selectedId) ??
    page.data.items[0];
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [quota, setQuota] = useState("0");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const writable = has(context, "users:write");

  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage("操作已完成并写入审计记录。");
      page.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="p-5 sm:p-8">
      <Header
        title="用户"
        description="查看账号详情，执行有效封禁、解封、单独加额和全部会话撤销。封禁会立即撤销现有会话。"
        onRefresh={page.refresh}
      />
      <Filters
        query={page.query}
        onQuery={page.setQuery}
        status={page.status}
        onStatus={page.setStatus}
        statuses={[
          { value: "active", label: "正常" },
          { value: "banned", label: "已封禁" }
        ]}
      />
      <LoadingOrError loading={page.loading} error={page.error} />
      {!page.loading && !page.error ? (
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className="overflow-hidden rounded-xl border border-[var(--border)]">
            {page.data.items.length === 0 ? (
              <p className="p-10 text-center text-sm text-[var(--muted)]">
                暂无用户
              </p>
            ) : (
              page.data.items.map((item) => {
                const id = text(item.id);
                return (
                  <button
                    type="button"
                    key={id}
                    onClick={() => setSelectedId(id)}
                    className={`block w-full border-b border-[var(--border)] p-4 text-left last:border-0 ${text(selected?.id) === id ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface)]"}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <strong className="truncate text-sm">
                        {text(item.name) || "未设置姓名"}
                      </strong>
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${bool(item.banned) ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}
                      >
                        {bool(item.banned) ? "已封禁" : "正常"}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--muted)]">
                      {text(item.email)}
                    </p>
                  </button>
                );
              })
            )}
          </div>

          <section className="rounded-xl border border-[var(--border)] p-5">
            {selected ? (
              <>
                <h2 className="text-xl font-semibold">
                  {text(selected.name) || "用户详情"}
                </h2>
                <dl className="mt-4 grid gap-3 text-sm">
                  <div>
                    <dt className="text-[var(--muted)]">邮箱</dt>
                    <dd className="mt-1 break-all">{text(selected.email)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">创建时间</dt>
                    <dd className="mt-1">{formatDate(selected.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">封禁到期</dt>
                    <dd className="mt-1">{formatDate(selected.banExpires)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">每日加额</dt>
                    <dd className="mt-1">
                      {String(selected.dailyQuotaBonus ?? 0)}
                    </dd>
                  </div>
                </dl>

                {writable ? (
                  <div className="mt-6 space-y-5 border-t border-[var(--border)] pt-5">
                    <label className="block text-sm">
                      <span className="mb-2 block font-medium">处置原因</span>
                      <textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        className="min-h-20 w-full rounded-lg border border-[var(--border)] p-3"
                        placeholder="封禁、加额或会话撤销的审计原因"
                      />
                    </label>
                    {!bool(selected.banned) ? (
                      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                        <input
                          type="datetime-local"
                          value={expiresAt}
                          onChange={(event) => setExpiresAt(event.target.value)}
                          className="min-h-11 rounded-lg border border-[var(--border)] px-3 text-sm"
                          aria-label="封禁到期时间"
                        />
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 1}
                          onClick={() =>
                            void mutate(
                              `/api/admin/users/${encodeURIComponent(text(selected.id))}/ban`,
                              "PATCH",
                              {
                                banned: true,
                                reason: reason.trim(),
                                ...(expiresAt
                                  ? {
                                      expiresAt: new Date(
                                        expiresAt
                                      ).toISOString()
                                    }
                                  : {})
                              }
                            )
                          }
                          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          <Ban size={16} />
                          封禁并撤销会话
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/api/admin/users/${encodeURIComponent(text(selected.id))}/ban`,
                            "PATCH",
                            { banned: false }
                          )
                        }
                        className="min-h-11 w-full rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        解除封禁
                      </button>
                    )}
                    <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                      <input
                        type="number"
                        min="0"
                        max="100000"
                        value={quota}
                        onChange={(event) => setQuota(event.target.value)}
                        className="min-h-11 rounded-lg border border-[var(--border)] px-3"
                        aria-label="每日加额"
                      />
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 3}
                        onClick={() =>
                          void mutate(
                            `/api/admin/users/${encodeURIComponent(text(selected.id))}/quota`,
                            "PATCH",
                            { dailyBonus: Number(quota), reason: reason.trim() }
                          )
                        }
                        className="min-h-11 rounded-lg border border-[var(--border-strong)] px-4 text-sm font-medium disabled:opacity-50"
                      >
                        保存每日加额
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={busy || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          `/api/admin/users/${encodeURIComponent(text(selected.id))}/sessions`,
                          "DELETE",
                          { reason: reason.trim() }
                        )
                      }
                      className="min-h-11 w-full rounded-lg border border-red-300 px-4 text-sm font-medium text-red-700 disabled:opacity-50"
                    >
                      撤销该用户全部会话
                    </button>
                  </div>
                ) : null}
                <StatusMessage message={message} />
              </>
            ) : (
              <p className="text-sm text-[var(--muted)]">选择用户查看详情。</p>
            )}
          </section>
        </div>
      ) : null}
      <Pager page={page} />
    </main>
  );
}

const roleLabels: Record<AdminRole, string> = {
  owner: "Owner",
  admin: "Admin",
  knowledge_editor: "知识编辑",
  support: "支持",
  analyst: "分析"
};

export function AdminsManager() {
  const admins = useAdminPage("/api/admin/admins");
  const invitations = useAdminPage("/api/admin/invitations");
  const context = useAdminContext();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("support");
  const [message, setMessage] = useState("");
  const [acceptUrl, setAcceptUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const writable = has(context, "admins:write");
  const roles = useMemo<AdminRole[]>(
    () =>
      context?.role === "owner"
        ? ["owner", "admin", "knowledge_editor", "support", "analyst"]
        : ["knowledge_editor", "support", "analyst"],
    [context?.role]
  );

  async function mutate(method: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/admins", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage("角色操作已完成并写入审计记录。");
      admins.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "角色操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setAcceptUrl("");
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role })
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = record(record(await response.json()).data);
      setAcceptUrl(text(payload.acceptUrl));
      setEmail("");
      setMessage(
        "邀请已创建。一次性链接只在这里显示，请安全发送给对应邮箱持有人。"
      );
      invitations.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "邀请创建失败。");
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvitation(id: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitationId: id })
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage("邀请已撤销。");
      invitations.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "撤销失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="p-5 sm:p-8">
      <Header
        title="管理员与邀请"
        description="每个账号只能持有一个后台角色。Owner 可管理全部角色，Admin 只能管理专业角色；最后一个 Owner 受保护。"
        onRefresh={() => {
          admins.refresh();
          invitations.refresh();
        }}
      />
      {writable ? (
        <form
          onSubmit={invite}
          className="mt-6 grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 md:grid-cols-[minmax(220px,1fr)_190px_auto]"
        >
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="已注册并完成验证的邮箱"
            className="min-h-11 rounded-lg border border-[var(--border)] bg-white px-3"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as AdminRole)}
            className="min-h-11 rounded-lg border border-[var(--border)] bg-white px-3"
          >
            {roles.map((item) => (
              <option key={item} value={item}>
                {roleLabels[item]}
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            className="min-h-11 rounded-lg bg-[var(--ink)] px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            创建 48 小时邀请
          </button>
        </form>
      ) : null}
      <StatusMessage message={message} />
      {acceptUrl ? (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 text-xs break-all">{acceptUrl}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(acceptUrl)}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-400 px-3 text-sm"
          >
            <Copy size={15} />
            复制一次性链接
          </button>
        </div>
      ) : null}

      <Filters
        query={admins.query}
        onQuery={admins.setQuery}
        status={admins.status}
        onStatus={admins.setStatus}
        statuses={Object.entries(roleLabels).map(([value, label]) => ({
          value,
          label
        }))}
      />
      <LoadingOrError loading={admins.loading} error={admins.error} />
      {!admins.loading && !admins.error ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {admins.data.items.map((item) => {
            const currentRole = text(item.role) as AdminRole;
            return (
              <article
                key={`${text(item.userId)}:${currentRole}`}
                className="rounded-xl border border-[var(--border)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">
                      {text(item.name) || "未设置姓名"}
                    </h2>
                    <p className="mt-1 truncate text-xs text-[var(--muted)]">
                      {text(item.email)}
                    </p>
                  </div>
                  <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs">
                    {roleLabels[currentRole]}
                  </span>
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">
                  授权于 {formatDate(item.createdAt)}
                </p>
                {writable ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <select
                      defaultValue={currentRole}
                      id={`role-${text(item.userId)}`}
                      className="min-h-10 rounded-lg border border-[var(--border)] bg-white px-2 text-sm"
                    >
                      {roles.map((candidate) => (
                        <option key={candidate} value={candidate}>
                          {roleLabels[candidate]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const element = document.getElementById(
                          `role-${text(item.userId)}`
                        ) as HTMLSelectElement | null;
                        if (element && element.value !== currentRole)
                          void mutate("PATCH", {
                            userId: item.userId,
                            expectedRole: currentRole,
                            role: element.value
                          });
                      }}
                      className="min-h-10 rounded-lg border border-[var(--border-strong)] px-3 text-sm"
                    >
                      替换角色
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("确认撤销该后台角色？"))
                          void mutate("DELETE", {
                            userId: item.userId,
                            role: currentRole
                          });
                      }}
                      className="min-h-10 rounded-lg border border-red-300 px-3 text-sm text-red-700"
                    >
                      撤销
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
      <Pager page={admins} />

      <section className="mt-10 border-t border-[var(--border)] pt-8">
        <h2 className="text-xl font-semibold">角色邀请记录</h2>
        <div className="mt-4 space-y-3">
          {invitations.data.items.map((item) => {
            const invitationStatus = text(item.status);
            const pending = invitationStatus === "pending";
            return (
              <div
                key={text(item.id)}
                className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <strong className="text-sm">{text(item.email)}</strong>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {roleLabels[text(item.role) as AdminRole]} ·{" "}
                    {invitationStatus === "pending"
                      ? "待接受"
                      : invitationStatus === "accepted"
                        ? "已接受"
                        : invitationStatus === "revoked"
                          ? "已撤销"
                          : "已过期"}{" "}
                    · 到期 {formatDate(item.expiresAt)}
                  </p>
                </div>
                {writable && pending ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeInvitation(text(item.id))}
                    className="min-h-10 rounded-lg border border-red-300 px-3 text-sm text-red-700"
                  >
                    撤销邀请
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <Pager page={invitations} />
      </section>
    </main>
  );
}

function WorkflowManager({ kind }: { kind: "feedback" | "problem-reports" }) {
  const isFeedback = kind === "feedback";
  const endpoint = isFeedback
    ? "/api/admin/feedback"
    : "/api/admin/problem-reports";
  const page = useAdminPage(endpoint);
  const context = useAdminContext();
  const [selectedId, setSelectedId] = useState("");
  const selected =
    page.data.items.find((item) => text(item.id) === selectedId) ??
    page.data.items[0];
  const [status, setStatus] = useState(isFeedback ? "reviewing" : "reviewing");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const writable = has(
    context,
    isFeedback ? "feedback:write" : "problem_reports:write"
  );
  const statuses = isFeedback
    ? [
        { value: "open", label: "待处理" },
        { value: "reviewing", label: "处理中" },
        { value: "resolved", label: "已解决" },
        { value: "dismissed", label: "不处理" }
      ]
    : [
        { value: "new", label: "新报告" },
        { value: "reviewing", label: "复核中" },
        { value: "closed", label: "已关闭" }
      ];

  async function save() {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `${endpoint}/${encodeURIComponent(text(selected.id))}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status,
            ...(note.trim() ? { note: note.trim() } : {})
          })
        }
      );
      if (!response.ok) throw new Error(await readError(response));
      setMessage("处理状态与内部备注已保存。");
      page.refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="p-5 sm:p-8">
      <Header
        title={isFeedback ? "用户反馈" : "问题报告"}
        description={
          isFeedback
            ? "领取回答反馈、更新处理状态并记录内部备注。"
            : "处理回答、引用、系统错误和产品建议；联系方式仅展示给具有问题报告读取权限的角色。"
        }
        onRefresh={page.refresh}
      />
      <Filters
        query={page.query}
        onQuery={page.setQuery}
        status={page.status}
        onStatus={page.setStatus}
        statuses={statuses}
      />
      <LoadingOrError loading={page.loading} error={page.error} />
      {!page.loading && !page.error ? (
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
          <div className="space-y-3">
            {page.data.items.map((item) => (
              <button
                key={text(item.id)}
                type="button"
                onClick={() => setSelectedId(text(item.id))}
                className={`block w-full rounded-xl border p-4 text-left ${text(selected?.id) === text(item.id) ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)]"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-sm">
                    {isFeedback
                      ? text(item.reason) || text(item.rating) || "回答反馈"
                      : text(item.category) || "问题报告"}
                  </strong>
                  <span className="text-xs text-[var(--muted)]">
                    {text(item.status)}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                  {text(item.comment) ||
                    text(item.details) ||
                    text(item.description) ||
                    "未填写补充说明"}
                </p>
              </button>
            ))}
          </div>
          <section className="rounded-xl border border-[var(--border)] p-5 xl:sticky xl:top-5 xl:self-start">
            {selected ? (
              <>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={18} className="text-[var(--accent)]" />
                  <h2 className="font-semibold">处理详情</h2>
                </div>
                <dl className="mt-5 space-y-4 text-sm">
                  <div>
                    <dt className="text-[var(--muted)]">内容</dt>
                    <dd className="mt-1 leading-6 whitespace-pre-wrap">
                      {text(selected.comment) ||
                        text(selected.details) ||
                        text(selected.description) ||
                        "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">当前状态</dt>
                    <dd className="mt-1">{text(selected.status)}</dd>
                  </div>
                  {!isFeedback && selected.contactValue ? (
                    <div>
                      <dt className="text-[var(--muted)]">联系方式</dt>
                      <dd className="mt-1 break-all">
                        {text(selected.contactType)} ·{" "}
                        {text(selected.contactValue)}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-[var(--muted)]">提交时间</dt>
                    <dd className="mt-1">{formatDate(selected.createdAt)}</dd>
                  </div>
                </dl>
                {writable ? (
                  <div className="mt-6 space-y-3 border-t border-[var(--border)] pt-5">
                    <select
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                      className="min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3"
                    >
                      {statuses.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      className="min-h-28 w-full rounded-lg border border-[var(--border)] p-3 text-sm"
                      placeholder="内部备注"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void save()}
                      className="min-h-11 w-full rounded-lg bg-[var(--ink)] px-4 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      保存处理结果
                    </button>
                  </div>
                ) : null}
                <StatusMessage message={message} />
              </>
            ) : (
              <p className="text-sm text-[var(--muted)]">暂无记录。</p>
            )}
          </section>
        </div>
      ) : null}
      <Pager page={page} />
    </main>
  );
}

export function FeedbackManager() {
  return <WorkflowManager kind="feedback" />;
}

export function ConversationsManager() {
  const page = useAdminPage("/api/admin/conversations");
  const [selectedId, setSelectedId] = useState("");
  const selected =
    page.data.items.find((item) => text(item.id) === selectedId) ??
    page.data.items[0];
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const effectiveId = text(selected?.id);

  useEffect(() => {
    if (!effectiveId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setDetailLoading(true);
      setDetailError("");
      try {
        const response = await fetch(
          `/api/admin/conversations/${encodeURIComponent(effectiveId)}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!response.ok) throw new Error(await readError(response));
        setDetail(record(record(await response.json()).data));
      } catch (caught) {
        if (!controller.signal.aborted)
          setDetailError(
            caught instanceof Error ? caught.message : "对话详情读取失败。"
          );
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [effectiveId]);

  const visibleMessages = Array.isArray(detail?.messages)
    ? detail.messages.filter(
        (item): item is Row => typeof item === "object" && item !== null
      )
    : [];

  return (
    <main className="p-5 sm:p-8">
      <Header
        title="对话只读复核"
        description="仅展示用户与助手可见消息的白名单字段；后台没有修改或删除用户消息的接口。"
        onRefresh={page.refresh}
      />
      <Filters
        query={page.query}
        onQuery={page.setQuery}
        status={page.status}
        onStatus={page.setStatus}
        statuses={[
          { value: "active", label: "进行中" },
          { value: "archived", label: "已归档" }
        ]}
      />
      <LoadingOrError loading={page.loading} error={page.error} />
      {!page.loading && !page.error ? (
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
          <div className="space-y-3">
            {page.data.items.map((item) => (
              <button
                key={text(item.id)}
                type="button"
                onClick={() => setSelectedId(text(item.id))}
                className={`block w-full rounded-xl border p-4 text-left ${effectiveId === text(item.id) ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)]"}`}
              >
                <strong className="block truncate text-sm">
                  {text(item.title) || "新对话"}
                </strong>
                <p className="mt-1 truncate text-xs text-[var(--muted)]">
                  {text(item.userEmail)} · {text(item.model) || "未记录模型"}
                </p>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--muted)]">
                  {text(item.summary) || "暂无摘要"}
                </p>
              </button>
            ))}
          </div>
          <section className="min-h-72 rounded-xl border border-[var(--border)] p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">
                {text(detail?.title) || "对话详情"}
              </h2>
              <span className="rounded-full bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)]">
                只读
              </span>
            </div>
            {detailLoading ? (
              <div className="grid min-h-48 place-items-center">
                <LoaderCircle className="animate-spin" />
              </div>
            ) : detailError ? (
              <p role="alert" className="mt-4 text-sm text-red-700">
                {detailError}
              </p>
            ) : (
              <div className="mt-5 space-y-4">
                {visibleMessages.map((message) => (
                  <article
                    key={text(message.id)}
                    className={`rounded-xl p-4 ${text(message.role) === "user" ? "bg-[var(--surface)]" : "border border-[var(--border)]"}`}
                  >
                    <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                      <span>
                        {text(message.role) === "user" ? "用户" : "OpenVac"}
                      </span>
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    <p className="mt-3 text-sm leading-7 whitespace-pre-wrap">
                      {text(message.content) || "—"}
                    </p>
                  </article>
                ))}
                {visibleMessages.length === 0 ? (
                  <p className="py-10 text-center text-sm text-[var(--muted)]">
                    暂无可见消息。
                  </p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      ) : null}
      <Pager page={page} />
    </main>
  );
}

export function ProblemReportsManager() {
  return <WorkflowManager kind="problem-reports" />;
}

type BudgetRow = {
  model: string;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  enabled: boolean;
  dailyUsedCents: number;
  monthlyUsedCents: number;
  projectedMonthlyCents: number;
  circuitStatus: "ok" | "warning" | "tripped" | "disabled";
};

export function BudgetManager() {
  const context = useAdminContext();
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const writable = has(context, "budgets:write");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/budgets", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const data = record(record(await response.json()).data);
      setBudgets(
        Array.isArray(data.budgets)
          ? data.budgets.filter(
              (item): item is BudgetRow =>
                typeof item === "object" && item !== null
            )
          : []
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "预算读取失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/budgets", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          budgets: budgets.map(
            ({ model, dailyLimitCents, monthlyLimitCents, enabled }) => ({
              model,
              dailyLimitCents,
              monthlyLimitCents,
              enabled
            })
          )
        })
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage("预算与熔断限额已保存。");
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "预算保存失败。");
    } finally {
      setBusy(false);
    }
  }

  function patchBudget(index: number, patch: Partial<BudgetRow>) {
    setBudgets((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item
      )
    );
  }

  return (
    <main className="p-5 sm:p-8">
      <Header
        title="模型预算与熔断"
        description="展示日/月限额、实际消耗、按本月进度预测和熔断状态。读取失败时不会用 0 冒充正常数据。"
        onRefresh={() => void load()}
      />
      <LoadingOrError loading={loading} error={error} />
      {!loading && !error ? (
        <div className="mt-6 space-y-4">
          {budgets.length === 0 ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">
              尚未配置任何模型预算；这不是“消耗为 0”。请由 Owner 或 Admin
              明确创建限额后再启用模型。
            </p>
          ) : null}
          {budgets.map((budget, index) => (
            <article
              key={budget.model || index}
              className="rounded-xl border border-[var(--border)] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                {writable ? (
                  <input
                    value={budget.model}
                    onChange={(event) =>
                      patchBudget(index, { model: event.target.value })
                    }
                    aria-label={`模型 ${index + 1}`}
                    className="min-h-10 min-w-48 rounded-lg border border-[var(--border)] px-3 font-medium"
                  />
                ) : (
                  <h2 className="font-semibold">{budget.model}</h2>
                )}
                <span
                  className={`rounded-full px-2.5 py-1 text-xs ${budget.circuitStatus === "tripped" ? "bg-red-50 text-red-700" : budget.circuitStatus === "warning" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}
                >
                  {budget.circuitStatus === "tripped"
                    ? "已熔断"
                    : budget.circuitStatus === "warning"
                      ? "接近限额"
                      : budget.circuitStatus === "disabled"
                        ? "已停用"
                        : "正常"}
                </span>
              </div>
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg bg-[var(--surface)] p-3">
                  <p className="text-xs text-[var(--muted)]">
                    今日消耗 / 限额（分）
                  </p>
                  <p className="mt-2 font-semibold">
                    {budget.dailyUsedCents} / {budget.dailyLimitCents}
                  </p>
                </div>
                <div className="rounded-lg bg-[var(--surface)] p-3">
                  <p className="text-xs text-[var(--muted)]">
                    本月消耗 / 限额（分）
                  </p>
                  <p className="mt-2 font-semibold">
                    {budget.monthlyUsedCents} / {budget.monthlyLimitCents}
                  </p>
                </div>
                <div className="rounded-lg bg-[var(--surface)] p-3">
                  <p className="text-xs text-[var(--muted)]">本月预测（分）</p>
                  <p className="mt-2 font-semibold">
                    {budget.projectedMonthlyCents}
                  </p>
                </div>
              </div>
              {writable ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <input
                    type="number"
                    min="0"
                    value={budget.dailyLimitCents}
                    onChange={(event) =>
                      patchBudget(index, {
                        dailyLimitCents: Number(event.target.value)
                      })
                    }
                    aria-label={`${budget.model} 每日限额`}
                    className="min-h-10 rounded-lg border border-[var(--border)] px-3"
                  />
                  <input
                    type="number"
                    min="0"
                    value={budget.monthlyLimitCents}
                    onChange={(event) =>
                      patchBudget(index, {
                        monthlyLimitCents: Number(event.target.value)
                      })
                    }
                    aria-label={`${budget.model} 每月限额`}
                    className="min-h-10 rounded-lg border border-[var(--border)] px-3"
                  />
                  <label className="flex min-h-10 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={budget.enabled}
                      onChange={(event) =>
                        patchBudget(index, { enabled: event.target.checked })
                      }
                    />
                    启用
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setBudgets((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                    className="min-h-10 rounded-lg border border-red-300 px-3 text-sm text-red-700"
                  >
                    移除
                  </button>
                </div>
              ) : null}
            </article>
          ))}
          {writable ? (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() =>
                  setBudgets((current) => [
                    ...current,
                    {
                      model: "",
                      dailyLimitCents: 0,
                      monthlyLimitCents: 0,
                      enabled: false,
                      dailyUsedCents: 0,
                      monthlyUsedCents: 0,
                      projectedMonthlyCents: 0,
                      circuitStatus: "disabled"
                    }
                  ])
                }
                className="min-h-11 rounded-lg border border-[var(--border)] px-4 text-sm"
              >
                添加模型预算
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="min-h-11 rounded-lg bg-[var(--ink)] px-5 text-sm font-semibold text-white disabled:opacity-50"
              >
                保存预算
              </button>
            </div>
          ) : null}
          <StatusMessage message={message} />
        </div>
      ) : null}
    </main>
  );
}

export function CoreOperationsLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
      <span className="inline-flex items-center gap-1">
        <ShieldCheck size={14} />
        服务端 RBAC
      </span>
      <span className="inline-flex items-center gap-1">
        <UserRoundCog size={14} />
        完整审计
      </span>
    </div>
  );
}
