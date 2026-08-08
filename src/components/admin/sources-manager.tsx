"use client";

import {
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState
} from "react";

type RightsDecision = {
  status: "approved" | "pending" | "rejected";
  scope: "full_text" | "metadata_only";
  basis: string;
  evidenceUrl: string;
  appliesToRecordUrl: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

type SourceRecord = {
  id: string;
  kind: string;
  name: string;
  publisher: string;
  canonicalUrl: string;
  baseUrl: string;
  sourceTier: string;
  licensePolicy: string;
  notes?: string | null;
  enabled: boolean;
  rightsStatus?: string;
  metadata?: { rightsDecision?: RightsDecision };
  updatedAt?: string;
};

type SourceForm = {
  kind: string;
  name: string;
  publisher: string;
  canonicalUrl: string;
  baseUrl: string;
  sourceTier: string;
  licensePolicy: string;
  notes: string;
  enabled: boolean;
  recordRights: boolean;
  rightsStatus: RightsDecision["status"];
  rightsScope: RightsDecision["scope"];
  rightsBasis: string;
  evidenceUrl: string;
};

const EMPTY_FORM: SourceForm = {
  kind: "manual",
  name: "",
  publisher: "",
  canonicalUrl: "",
  baseUrl: "",
  sourceTier: "metadata_only",
  licensePolicy: "",
  notes: "",
  enabled: true,
  recordRights: false,
  rightsStatus: "pending",
  rightsScope: "metadata_only",
  rightsBasis: "",
  evidenceUrl: ""
};

const KIND_OPTIONS = [
  ["manual", "人工资料"],
  ["upload", "上传资料"],
  ["manufacturer", "制造商"],
  ["standard", "标准"],
  ["patent", "专利"],
  ["web", "网站"]
] as const;

const TIER_OPTIONS = [
  ["open_license", "开放许可"],
  ["metadata_only", "仅元数据"],
  ["manufacturer_metadata", "制造商元数据"],
  ["standard_metadata", "标准元数据"],
  ["internal", "内部资料"]
] as const;

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
      message?: string;
    };
    return (
      payload.error?.message ?? payload.message ?? "操作失败，请稍后重试。"
    );
  } catch {
    return "操作失败，请稍后重试。";
  }
}

function sourceForm(source?: SourceRecord): SourceForm {
  if (!source) return { ...EMPTY_FORM };
  return {
    kind: source.kind,
    name: source.name,
    publisher: source.publisher,
    canonicalUrl: source.canonicalUrl,
    baseUrl: source.baseUrl,
    sourceTier: source.sourceTier,
    licensePolicy: source.licensePolicy,
    notes: source.notes ?? "",
    enabled: source.enabled,
    recordRights: false,
    rightsStatus: "pending",
    rightsScope: "metadata_only",
    rightsBasis: "",
    evidenceUrl: ""
  };
}

function rightsLabel(status?: string): string {
  return (
    {
      approved: "已批准",
      pending: "待核验",
      rejected: "已驳回",
      stale: "已失效",
      not_recorded: "未记录"
    }[status ?? "not_recorded"] ?? "未记录"
  );
}

export function SourcesManager() {
  const [items, setItems] = useState<SourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [canWrite, setCanWrite] = useState(false);
  const [canReviewRights, setCanReviewRights] = useState(false);
  const [editing, setEditing] = useState<SourceRecord | null | undefined>();
  const [form, setForm] = useState<SourceForm>(sourceForm());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (submittedQuery) params.set("q", submittedQuery);
    if (status) params.set("status", status);
    const response = await fetch(`/api/admin/sources?${params}`, {
      cache: "no-store"
    });
    setLoading(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    const payload = unwrap<{
      items: SourceRecord[];
      total: number;
    }>(await response.json());
    setItems(payload.items ?? []);
    setTotal(payload.total ?? 0);
  }, [page, status, submittedQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const response = await fetch("/api/admin/context", { cache: "no-store" });
      if (!response.ok) return;
      const context = unwrap<{
        role: string;
        capabilities: string[];
      }>(await response.json());
      setCanWrite(context.capabilities.includes("sources:write"));
      setCanReviewRights(context.role === "owner" || context.role === "admin");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function openForm(source?: SourceRecord) {
    setEditing(source ?? null);
    setForm(sourceForm(source));
    setError("");
    setNotice("");
  }

  function patchForm<K extends keyof SourceForm>(key: K, value: SourceForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = {
      kind: form.kind,
      name: form.name,
      publisher: form.publisher,
      canonicalUrl: form.canonicalUrl,
      baseUrl: form.baseUrl,
      sourceTier: form.sourceTier,
      licensePolicy: form.licensePolicy,
      ...(form.notes ? { notes: form.notes } : {}),
      enabled: form.enabled
    };
    if (form.recordRights && canReviewRights) {
      body.rightsDecision = {
        status: form.rightsStatus,
        scope: form.rightsScope,
        basis: form.rightsBasis,
        evidenceUrl: form.evidenceUrl,
        appliesToRecordUrl: form.canonicalUrl
      };
    }
    const target = editing?.id
      ? `/api/admin/sources/${editing.id}`
      : "/api/admin/sources";
    const response = await fetch(target, {
      method: editing?.id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    setSaving(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setEditing(undefined);
    setNotice(
      editing?.id ? "来源已更新。" : "来源已创建。权利状态只适用于该记录地址。"
    );
    await load();
  }

  async function setEnabled(source: SourceRecord) {
    const response = await fetch(`/api/admin/sources/${source.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !source.enabled })
    });
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setNotice(source.enabled ? "来源已禁用。" : "来源已启用。");
    await load();
  }

  async function remove(source: SourceRecord) {
    if (!window.confirm(`确认删除来源“${source.name}”？该操作会同时禁用它。`))
      return;
    const response = await fetch(`/api/admin/sources/${source.id}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setNotice("来源已删除并禁用。已有审计记录会保留。");
    await load();
  }

  return (
    <main className="p-5 sm:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em]">
            来源白名单
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
            来源启用状态与逐条记录的权利决定分别管理。批准一条记录不会授权同域名下的其他内容。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-sm"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
          {canWrite ? (
            <button
              type="button"
              onClick={() => openForm()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--foreground)] px-3 text-sm text-[var(--background)]"
            >
              <Plus className="h-4 w-4" />
              新增来源
            </button>
          ) : null}
        </div>
      </div>

      <form
        className="mt-6 flex flex-col gap-3 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSubmittedQuery(query.trim());
        }}
      >
        <label className="flex h-11 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] px-3 sm:max-w-md">
          <Search className="h-4 w-4 text-[var(--muted)]" />
          <input
            aria-label="搜索来源"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="按名称搜索"
          />
        </label>
        <select
          aria-label="来源状态"
          value={status}
          onChange={(event) => {
            setPage(1);
            setStatus(event.target.value);
          }}
          className="h-11 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm"
        >
          <option value="">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已禁用</option>
        </select>
        <button className="h-11 rounded-lg border border-[var(--border)] px-4 text-sm">
          搜索
        </button>
      </form>

      {notice ? (
        <p className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mt-5 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] p-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {editing !== undefined ? (
        <form
          onSubmit={submit}
          className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              {editing ? "编辑来源" : "新增来源"}
            </h2>
            <button
              type="button"
              aria-label="关闭来源表单"
              onClick={() => setEditing(undefined)}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="来源名称">
              <input
                required
                value={form.name}
                onChange={(e) => patchForm("name", e.target.value)}
              />
            </Field>
            <Field label="发布机构">
              <input
                required
                value={form.publisher}
                onChange={(e) => patchForm("publisher", e.target.value)}
              />
            </Field>
            <Field label="来源类型">
              <select
                value={form.kind}
                onChange={(e) => patchForm("kind", e.target.value)}
              >
                {KIND_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="来源层级">
              <select
                value={form.sourceTier}
                onChange={(e) => patchForm("sourceTier", e.target.value)}
              >
                {TIER_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="记录地址" className="sm:col-span-2">
              <input
                required
                type="url"
                value={form.canonicalUrl}
                onChange={(e) => patchForm("canonicalUrl", e.target.value)}
                placeholder="https://…/record/…"
              />
            </Field>
            <Field label="基础地址" className="sm:col-span-2">
              <input
                required
                type="url"
                value={form.baseUrl}
                onChange={(e) => patchForm("baseUrl", e.target.value)}
                placeholder="https://…/"
              />
            </Field>
            <Field label="授权策略" className="sm:col-span-2">
              <input
                required
                value={form.licensePolicy}
                onChange={(e) => patchForm("licensePolicy", e.target.value)}
              />
            </Field>
            <Field label="内部备注" className="sm:col-span-2">
              <textarea
                value={form.notes}
                onChange={(e) => patchForm("notes", e.target.value)}
                rows={3}
              />
            </Field>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => patchForm("enabled", e.target.checked)}
            />
            创建后启用
          </label>
          {canReviewRights ? (
            <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={form.recordRights}
                  onChange={(e) => patchForm("recordRights", e.target.checked)}
                />
                同时记录权利决定
              </label>
              {form.recordRights ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field label="权利状态">
                    <select
                      value={form.rightsStatus}
                      onChange={(e) =>
                        patchForm(
                          "rightsStatus",
                          e.target.value as RightsDecision["status"]
                        )
                      }
                    >
                      <option value="pending">待核验</option>
                      <option value="approved">批准</option>
                      <option value="rejected">驳回</option>
                    </select>
                  </Field>
                  <Field label="授权范围">
                    <select
                      value={form.rightsScope}
                      onChange={(e) =>
                        patchForm(
                          "rightsScope",
                          e.target.value as RightsDecision["scope"]
                        )
                      }
                    >
                      <option value="metadata_only">仅元数据</option>
                      <option value="full_text">全文</option>
                    </select>
                  </Field>
                  <Field label="权利依据" className="sm:col-span-2">
                    <textarea
                      required
                      minLength={10}
                      value={form.rightsBasis}
                      onChange={(e) => patchForm("rightsBasis", e.target.value)}
                      rows={3}
                    />
                  </Field>
                  <Field label="证据地址" className="sm:col-span-2">
                    <input
                      required
                      type="url"
                      value={form.evidenceUrl}
                      onChange={(e) => patchForm("evidenceUrl", e.target.value)}
                    />
                  </Field>
                  <p className="text-xs text-[var(--muted)] sm:col-span-2">
                    适用记录固定为当前“记录地址”，服务端会拒绝跨记录授权。
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(undefined)}
              className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm"
            >
              取消
            </button>
            <button
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--foreground)] px-4 text-sm text-[var(--background)] disabled:opacity-50"
            >
              {saving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : null}
              保存来源
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="grid min-h-72 place-items-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-[var(--muted)]" />
        </div>
      ) : items.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--muted)]">
          暂无来源记录
        </p>
      ) : (
        <div className="mt-6 grid gap-3">
          {items.map((source) => {
            const rights = source.metadata?.rightsDecision;
            return (
              <article
                key={source.id}
                className="rounded-xl border border-[var(--border)] p-4 sm:p-5"
              >
                <div className="flex flex-col justify-between gap-4 sm:flex-row">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-medium">{source.name}</h2>
                      <Badge>{source.enabled ? "已启用" : "已禁用"}</Badge>
                      <Badge>
                        {rightsLabel(source.rightsStatus ?? rights?.status)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {source.publisher} · {source.sourceTier}
                    </p>
                    <a
                      href={source.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 block truncate text-sm underline underline-offset-4"
                    >
                      {source.canonicalUrl}
                    </a>
                  </div>
                  {canWrite ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => openForm(source)}
                        className="inline-flex h-9 items-center gap-1 rounded-lg border border-[var(--border)] px-3 text-sm"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void setEnabled(source)}
                        className="h-9 rounded-lg border border-[var(--border)] px-3 text-sm"
                      >
                        {source.enabled ? "禁用" : "启用"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(source)}
                        className="inline-flex h-9 items-center gap-1 rounded-lg border border-red-200 px-3 text-sm text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </button>
                    </div>
                  ) : null}
                </div>
                <dl className="mt-4 grid gap-3 border-t border-[var(--border)] pt-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-[var(--muted)]">授权策略</dt>
                    <dd className="mt-1">{source.licensePolicy}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">权利范围</dt>
                    <dd className="mt-1">{rights?.scope ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">核验时间</dt>
                    <dd className="mt-1">
                      {rights?.reviewedAt
                        ? new Date(rights.reviewedAt).toLocaleString("zh-CN")
                        : "—"}
                    </dd>
                  </div>
                  {rights?.basis ? (
                    <div className="sm:col-span-3">
                      <dt className="text-[var(--muted)]">记录级依据</dt>
                      <dd className="mt-1 whitespace-pre-wrap">
                        {rights.basis}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            );
          })}
        </div>
      )}
      <div className="mt-6 flex items-center justify-between text-sm text-[var(--muted)]">
        <span>共 {total} 条</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
            className="h-9 rounded-lg border border-[var(--border)] px-3 disabled:opacity-40"
          >
            上一页
          </button>
          <button
            type="button"
            disabled={page * 20 >= total}
            onClick={() => setPage((value) => value + 1)}
            className="h-9 rounded-lg border border-[var(--border)] px-3 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  className = "",
  children
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={`grid gap-1.5 text-sm [&_input]:h-11 [&_input]:rounded-lg [&_input]:border [&_input]:border-[var(--border)] [&_input]:bg-transparent [&_input]:px-3 [&_select]:h-11 [&_select]:rounded-lg [&_select]:border [&_select]:border-[var(--border)] [&_select]:bg-transparent [&_select]:px-3 [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-[var(--border)] [&_textarea]:bg-transparent [&_textarea]:p-3 ${className}`}
    >
      <span className="text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
      {children}
    </span>
  );
}
