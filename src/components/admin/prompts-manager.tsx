"use client";

import {
  Archive,
  CheckCircle2,
  FileDiff,
  FlaskConical,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";

type PromptVersion = {
  id: string;
  key: string;
  version: number;
  content: string;
  notes?: string | null;
  status: "draft" | "active" | "archived";
  createdBy?: string | null;
  publishedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type DiffLine = { kind: "same" | "added" | "removed"; text: string };

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

export function buildPromptLineDiff(
  previous: string,
  current: string
): DiffLine[] {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  return [
    ...before.slice(0, prefix).map((text) => ({ kind: "same" as const, text })),
    ...before
      .slice(prefix, before.length - suffix)
      .map((text) => ({ kind: "removed" as const, text })),
    ...after
      .slice(prefix, after.length - suffix)
      .map((text) => ({ kind: "added" as const, text })),
    ...(suffix > 0 ? after.slice(after.length - suffix) : []).map((text) => ({
      kind: "same" as const,
      text
    }))
  ];
}

function statusLabel(status: PromptVersion["status"]): string {
  return { draft: "草稿", active: "已激活", archived: "已归档" }[status];
}

export function PromptsManager() {
  const [items, setItems] = useState<PromptVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
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
  const [canExecute, setCanExecute] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<{
    promptId: string;
    output: string;
    model: string;
    totalTokens?: number;
  }>();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ key: "", content: "", notes: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (submittedQuery) params.set("q", submittedQuery);
    if (status) params.set("status", status);
    const response = await fetch(`/api/admin/prompts?${params}`, {
      cache: "no-store"
    });
    setLoading(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    const payload = unwrap<{ items: PromptVersion[]; total: number }>(
      await response.json()
    );
    setItems(payload.items ?? []);
    setTotal(payload.total ?? 0);
    setSelectedId((current) =>
      current && payload.items.some((item) => item.id === current)
        ? current
        : payload.items[0]?.id
    );
  }, [page, status, submittedQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const response = await fetch("/api/admin/context", { cache: "no-store" });
      if (!response.ok) return;
      const context = unwrap<{ capabilities: string[] }>(await response.json());
      setCanWrite(context.capabilities.includes("prompts:write"));
      setCanExecute(context.capabilities.includes("models:execute"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const selected = items.find((item) => item.id === selectedId);
  const previous = selected
    ? items
        .filter(
          (item) => item.key === selected.key && item.version < selected.version
        )
        .sort((left, right) => right.version - left.version)[0]
    : undefined;
  const diff = useMemo(
    () =>
      selected && previous
        ? buildPromptLineDiff(previous.content, selected.content)
        : [],
    [previous, selected]
  );

  function openCreate(base?: PromptVersion) {
    setCreating(true);
    setForm({ key: base?.key ?? "", content: base?.content ?? "", notes: "" });
    setError("");
    setNotice("");
  }

  async function createVersion(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch("/api/admin/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: form.key,
        content: form.content,
        ...(form.notes ? { notes: form.notes } : {})
      })
    });
    setSaving(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setCreating(false);
    setNotice("新提示词版本已创建为草稿，现有激活版本未被修改。");
    await load();
  }

  async function transition(
    prompt: PromptVersion,
    nextStatus: "active" | "archived"
  ) {
    const question =
      nextStatus === "active"
        ? `确认激活 ${prompt.key} v${prompt.version}？同一配置项当前的激活版本将归档。`
        : `确认归档 ${prompt.key} v${prompt.version}？归档后不可重新激活。`;
    if (!window.confirm(question)) return;
    setSaving(true);
    setError("");
    const response = await fetch(`/api/admin/prompts/${prompt.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: nextStatus })
    });
    setSaving(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    setNotice(
      nextStatus === "active"
        ? "版本已激活，旧激活版本已归档。"
        : "版本已归档。"
    );
    await load();
  }

  async function runTest(prompt: PromptVersion) {
    const input = testInput.trim();
    if (!input) {
      setError("请输入测试问题。");
      return;
    }
    if (!window.confirm(`确认使用 ${prompt.key} v${prompt.version} 调用模型？`))
      return;
    setTesting(true);
    setError("");
    setNotice("");
    const response = await fetch(`/api/admin/prompts/${prompt.id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, confirm: "RUN_PROMPT_TEST" })
    });
    setTesting(false);
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    const result = unwrap<{
      output: string;
      model: string;
      usage?: { totalTokens?: number };
    }>(await response.json());
    setTestResult({
      promptId: prompt.id,
      output: result.output,
      model: result.model,
      totalTokens: result.usage?.totalTokens
    });
    setNotice("提示词测试已完成，并已写入模型调用与审计记录。");
  }

  return (
    <main className="p-5 sm:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em]">
            提示词版本
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
            正文只通过“创建新版本”变更。已激活或已归档版本内容不可原地覆盖。
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
              onClick={() => openCreate()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--foreground)] px-3 text-sm text-[var(--background)]"
            >
              <Plus className="h-4 w-4" />
              创建新版本
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
            aria-label="搜索提示词"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="按 key 搜索"
          />
        </label>
        <select
          aria-label="提示词状态"
          value={status}
          onChange={(event) => {
            setPage(1);
            setStatus(event.target.value);
          }}
          className="h-11 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm"
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="active">已激活</option>
          <option value="archived">已归档</option>
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

      {creating ? (
        <form
          onSubmit={createVersion}
          className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">创建新版本</h2>
            <button
              type="button"
              aria-label="关闭提示词表单"
              onClick={() => setCreating(false)}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-5 grid gap-4">
            <label className="grid gap-1.5 text-sm">
              <span className="text-[var(--muted)]">提示词 key</span>
              <input
                required
                pattern="[a-z0-9][a-z0-9._-]{1,79}"
                value={form.key}
                onChange={(e) =>
                  setForm((current) => ({ ...current, key: e.target.value }))
                }
                className="h-11 rounded-lg border border-[var(--border)] bg-transparent px-3"
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-[var(--muted)]">版本正文</span>
              <textarea
                required
                value={form.content}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    content: e.target.value
                  }))
                }
                rows={12}
                className="rounded-lg border border-[var(--border)] bg-transparent p-3 font-mono text-xs"
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-[var(--muted)]">版本备注</span>
              <textarea
                value={form.notes}
                onChange={(e) =>
                  setForm((current) => ({ ...current, notes: e.target.value }))
                }
                rows={3}
                className="rounded-lg border border-[var(--border)] bg-transparent p-3"
              />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
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
              保存为新草稿
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="grid min-h-72 place-items-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-[var(--muted)]" />
        </div>
      ) : (
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
          <section
            className="grid content-start gap-2"
            aria-label="提示词版本列表"
          >
            {items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--muted)]">
                暂无提示词版本
              </p>
            ) : (
              items.map((prompt) => (
                <article
                  key={prompt.id}
                  className={`rounded-xl border p-4 ${selectedId === prompt.id ? "border-[var(--foreground)]" : "border-[var(--border)]"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{prompt.key}</p>
                      <p className="mt-1 text-sm text-[var(--muted)]">
                        版本 {prompt.version} · {statusLabel(prompt.status)}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`查看版本 ${prompt.version}`}
                      onClick={() => setSelectedId(prompt.id)}
                      className="h-8 rounded-lg border border-[var(--border)] px-2 text-xs"
                    >
                      查看
                    </button>
                  </div>
                  <p className="mt-3 line-clamp-2 font-mono text-xs whitespace-pre-wrap text-[var(--muted)]">
                    {prompt.content}
                  </p>
                </article>
              ))
            )}
          </section>
          <section className="min-w-0 rounded-2xl border border-[var(--border)] p-4 sm:p-6">
            {selected ? (
              <>
                <div className="flex flex-col justify-between gap-4 sm:flex-row">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">
                        {selected.key} v{selected.version}
                      </h2>
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">
                        {statusLabel(selected.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      更新时间{" "}
                      {selected.updatedAt
                        ? new Date(selected.updatedAt).toLocaleString("zh-CN")
                        : "—"}
                    </p>
                  </div>
                  {canWrite ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => openCreate(selected)}
                        className="h-9 rounded-lg border border-[var(--border)] px-3 text-sm"
                      >
                        以此创建新版本
                      </button>
                      {selected.status === "draft" ? (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void transition(selected, "active")}
                          className="inline-flex h-9 items-center gap-1 rounded-lg bg-[var(--foreground)] px-3 text-sm text-[var(--background)]"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          激活此版本
                        </button>
                      ) : null}
                      {selected.status !== "archived" ? (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void transition(selected, "archived")}
                          className="inline-flex h-9 items-center gap-1 rounded-lg border border-[var(--border)] px-3 text-sm"
                        >
                          <Archive className="h-4 w-4" />
                          归档
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                  <h3 className="text-sm font-medium">版本正文（只读）</h3>
                  <pre className="mt-3 max-h-80 overflow-auto font-mono text-xs leading-6 whitespace-pre-wrap">
                    {selected.content}
                  </pre>
                </div>
                <div className="mt-5">
                  <div className="flex items-center gap-2">
                    <FileDiff className="h-4 w-4" />
                    <h3 className="text-sm font-medium">与上一版本的差异</h3>
                  </div>
                  {previous ? (
                    <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-[var(--border)] font-mono text-xs">
                      {diff.map((line, index) => (
                        <div
                          key={`${line.kind}-${index}`}
                          className={`px-3 py-1 whitespace-pre-wrap ${line.kind === "added" ? "bg-emerald-50 text-emerald-900" : line.kind === "removed" ? "bg-red-50 text-red-900" : "text-[var(--muted)]"}`}
                        >
                          {line.kind === "added"
                            ? "+ "
                            : line.kind === "removed"
                              ? "- "
                              : "  "}
                          {line.text}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-[var(--muted)]">
                      这是该 key 的首个版本。
                    </p>
                  )}
                </div>
                <div className="mt-5 rounded-xl border border-[var(--border)] p-4">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="h-4 w-4" />
                    <h3 className="text-sm font-medium">真实模型测试</h3>
                  </div>
                  <label className="mt-3 grid gap-1.5 text-sm">
                    <span className="text-[var(--muted)]">测试输入</span>
                    <textarea
                      value={testInput}
                      onChange={(event) => setTestInput(event.target.value)}
                      rows={4}
                      maxLength={4000}
                      className="rounded-lg border border-[var(--border)] bg-transparent p-3"
                    />
                  </label>
                  {canExecute ? (
                    <button
                      type="button"
                      disabled={testing || !testInput.trim()}
                      onClick={() => void runTest(selected)}
                      className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--foreground)] px-4 text-sm text-[var(--background)] disabled:opacity-40"
                    >
                      {testing ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <FlaskConical className="h-4 w-4" />
                      )}
                      运行测试
                    </button>
                  ) : (
                    <p className="mt-3 text-xs text-[var(--muted)]">
                      仅 Owner/Admin 可执行模型测试。
                    </p>
                  )}
                  {testResult?.promptId === selected.id ? (
                    <div className="mt-4 rounded-lg bg-[var(--surface)] p-3 text-sm">
                      <p className="text-xs text-[var(--muted)]">
                        {testResult.model}
                        {testResult.totalTokens !== undefined
                          ? ` · ${testResult.totalTokens} tokens`
                          : ""}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap">
                        {testResult.output}
                      </p>
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                选择一个版本查看详情。
              </p>
            )}
          </section>
        </div>
      )}
      <div className="mt-6 flex items-center justify-between text-sm text-[var(--muted)]">
        <span>共 {total} 个版本</span>
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
