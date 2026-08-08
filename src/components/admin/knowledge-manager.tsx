"use client";

import {
  Archive,
  FileSearch,
  LoaderCircle,
  RotateCcw,
  Search,
  Upload
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  normalizeKnowledgeDocuments,
  type KnowledgeDocumentView
} from "./admin-data";

const statusLabel: Record<string, string> = {
  draft: "草稿",
  processing: "处理中",
  review: "待复核",
  published: "已发布",
  failed: "失败",
  archived: "已归档"
};

const sourceTierLabel: Record<string, string> = {
  open_license: "开放许可",
  metadata_only: "仅元数据",
  manufacturer_metadata: "厂商元数据",
  standard_metadata: "标准元数据",
  internal: "内部资料"
};

const ingestionModeLabel: Record<string, string> = {
  full_text: "全文",
  metadata_only: "仅元数据"
};

type StateTone = "positive" | "warning" | "negative" | "neutral";

type DisplayState = {
  label: string;
  tone: StateTone;
};

type ReviewSectionDecision = {
  decision: "approved" | "rejected" | "changes_requested";
  note?: string | null;
  revision: number;
};

type ReviewSection = {
  id: string;
  versionId: string;
  sectionIndex: number;
  contentZh: string;
  officialText: string;
  pageStart: number | null;
  pageEnd: number | null;
  sectionHash: string;
  reviewStatus: "required" | ReviewSectionDecision["decision"];
  decision: ReviewSectionDecision | null;
};

type ReviewWorkspace = {
  documentId: string;
  versionId: string;
  versionContentHash: string;
  versionStatus: string;
  sections: ReviewSection[];
};

const toneClass: Record<StateTone, string> = {
  positive: "bg-[var(--accent)]",
  warning: "bg-[var(--warning)]",
  negative: "bg-[var(--danger)]",
  neutral: "bg-[#92999b]"
};

function documentState(status: string): DisplayState {
  return {
    label: statusLabel[status] ?? status,
    tone:
      status === "published"
        ? "positive"
        : status === "review"
          ? "warning"
          : status === "failed"
            ? "negative"
            : "neutral"
  };
}

function reviewState(status?: string): DisplayState {
  if (!status) return { label: "人审状态未返回", tone: "neutral" };
  if (status === "approved") {
    return { label: "人审已通过", tone: "positive" };
  }
  if (status === "rejected" || status === "failed") {
    return { label: "人审未通过", tone: "negative" };
  }
  if (status === "invalidated") {
    return { label: "内容已变化，审核失效", tone: "negative" };
  }
  if (status === "required" || status === "pending_review") {
    return { label: "待人工复核", tone: "warning" };
  }
  return { label: status, tone: "neutral" };
}

function embeddingState(status?: string): DisplayState {
  if (!status) return { label: "Embedding 状态未返回", tone: "neutral" };
  if (status === "completed") {
    return { label: "Embedding 已完成", tone: "positive" };
  }
  if (status === "not_applicable") {
    return { label: "无需 Embedding", tone: "neutral" };
  }
  if (status === "failed") {
    return { label: "Embedding 失败", tone: "negative" };
  }
  if (
    status === "pending" ||
    status === "pending_review" ||
    status === "processing"
  ) {
    return { label: "Embedding 待完成", tone: "warning" };
  }
  return { label: status, tone: "neutral" };
}

function publishState(document: KnowledgeDocumentView): DisplayState {
  if (document.status === "published") {
    if (
      document.reviewStatus === "required" ||
      document.reviewStatus === "pending_review"
    ) {
      return { label: "已接入检索 · 待人工复核", tone: "warning" };
    }
    return { label: "当前修订已发布", tone: "positive" };
  }
  if (document.publishReady === true) {
    return { label: "可发布", tone: "positive" };
  }
  if (document.publishReady === false) {
    return { label: "未满足发布门禁", tone: "negative" };
  }
  return { label: "发布门禁未返回", tone: "neutral" };
}

function StateLine({ state }: { state: DisplayState }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneClass[state.tone]}`}
      />
      <span>{state.label}</span>
    </span>
  );
}

function DetailRow({
  term,
  value,
  mono = false
}: {
  term: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-[var(--muted)]">{term}</dt>
      <dd
        className={`min-w-0 text-right break-words ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function formatDateTime(value?: string): string {
  if (!value) return "未返回";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  });
}

function formatConfidence(value?: number): string {
  if (value === undefined) return "未返回";
  const percentage = value <= 1 ? value * 100 : value;
  return `${percentage.toFixed(1)}%`;
}

function versionLabel(document: KnowledgeDocumentView): string {
  return document.version === undefined ? "未返回" : `v${document.version}`;
}

async function responseError(
  response: Response,
  fallback: string
): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: unknown };
    };
    return typeof payload.error?.message === "string"
      ? payload.error.message
      : fallback;
  } catch {
    return fallback;
  }
}

export function KnowledgeManager() {
  const [documents, setDocuments] = useState<KnowledgeDocumentView[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [sourceTierFilter, setSourceTierFilter] = useState("");
  const [licenseFilter, setLicenseFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actioning, setActioning] = useState<
    "publish" | "archive" | "rollback"
  >();
  const [actionError, setActionError] = useState("");
  const [reviewWorkspace, setReviewWorkspace] = useState<ReviewWorkspace>();
  const [reviewWorkspaceLoading, setReviewWorkspaceLoading] = useState(false);
  const [reviewSectionIndex, setReviewSectionIndex] = useState(0);
  const [reviewSectionNotes, setReviewSectionNotes] = useState<
    Record<string, string>
  >({});
  const [reviewSectionActioning, setReviewSectionActioning] = useState(false);
  const [mobileReviewStep, setMobileReviewStep] = useState<0 | 1 | 2>(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/knowledge", {
        cache: "no-store"
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? "当前角色无权查看知识库。"
            : "知识库暂时无法读取。"
        );
        return;
      }

      const list = normalizeKnowledgeDocuments(await response.json());
      setDocuments(list);
      setSelectedId((current) =>
        current && list.some((document) => document.id === current)
          ? current
          : list[0]?.id
      );
    } catch {
      setError("知识库暂时无法读取。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return documents.filter((document) => {
      const matchesQuery =
        !normalizedQuery ||
        [
          document.title,
          document.sourceName,
          document.sourceTier,
          document.licensePolicy
        ].some((value) => value?.toLowerCase().includes(normalizedQuery));
      return (
        matchesQuery &&
        (!sourceTierFilter || document.sourceTier === sourceTierFilter) &&
        (!licenseFilter || document.licensePolicy === licenseFilter) &&
        (!statusFilter || document.status === statusFilter)
      );
    });
  }, [documents, licenseFilter, query, sourceTierFilter, statusFilter]);

  async function importCandidate(file?: File) {
    if (!file) return;
    setImporting(true);
    setImportMessage("");
    setActionError("");
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const response = await fetch("/api/admin/knowledge/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        setActionError(await responseError(response, "待审知识导入失败。"));
        return;
      }
      setImportMessage("导入成功，资料已进入逐段人工复核。");
      await refresh();
    } catch {
      setActionError("请选择符合受治理知识候选格式的有效 JSON 文件。");
    } finally {
      setImporting(false);
    }
  }

  const selected =
    visible.find((document) => document.id === selectedId) ?? visible[0];

  const loadReviewWorkspace = useCallback(async (documentId: string) => {
    setReviewWorkspaceLoading(true);
    try {
      const response = await fetch(
        `/api/admin/knowledge/${documentId}/review`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        setReviewWorkspace(undefined);
        return;
      }
      const payload = (await response.json()) as { data?: unknown };
      const data = payload.data as Partial<ReviewWorkspace> | undefined;
      setReviewWorkspace(
        data &&
          typeof data.versionId === "string" &&
          Array.isArray(data.sections)
          ? (data as ReviewWorkspace)
          : undefined
      );
      setReviewSectionIndex(0);
      setMobileReviewStep(0);
    } catch {
      setReviewWorkspace(undefined);
    } finally {
      setReviewWorkspaceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selected?.currentVersionId) return;
    const timer = window.setTimeout(
      () => void loadReviewWorkspace(selected.id),
      0
    );
    return () => window.clearTimeout(timer);
  }, [loadReviewWorkspace, selected?.currentVersionId, selected?.id]);

  const currentReviewWorkspace =
    reviewWorkspace?.documentId === selected?.id ? reviewWorkspace : undefined;
  const activeReviewSection =
    currentReviewWorkspace?.sections[reviewSectionIndex];

  async function decideReviewSection(
    decision: "approved" | "rejected" | "changes_requested"
  ) {
    if (!selected || !currentReviewWorkspace || !activeReviewSection) return;
    const note = reviewSectionNotes[activeReviewSection.id]?.trim();
    if (decision !== "approved" && !note) {
      setActionError("驳回或要求修改段落时必须填写审核备注。");
      return;
    }
    setReviewSectionActioning(true);
    setActionError("");
    try {
      const response = await fetch(
        `/api/admin/knowledge/${selected.id}/versions/${currentReviewWorkspace.versionId}/sections/${activeReviewSection.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedSectionHash: activeReviewSection.sectionHash,
            expectedRevision: activeReviewSection.decision?.revision ?? 0,
            decision,
            ...(note ? { note } : {})
          })
        }
      );
      if (!response.ok) {
        setActionError(await responseError(response, "段落决定保存失败。"));
        return;
      }
      await loadReviewWorkspace(selected.id);
    } catch {
      setActionError("段落决定保存失败。");
    } finally {
      setReviewSectionActioning(false);
    }
  }

  async function completeSectionReview() {
    if (!selected || !currentReviewWorkspace) return;
    setReviewSectionActioning(true);
    setActionError("");
    try {
      const response = await fetch(
        `/api/admin/knowledge/${selected.id}/versions/${currentReviewWorkspace.versionId}/complete-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId: currentReviewWorkspace.versionId,
            expectedContentHash: currentReviewWorkspace.versionContentHash
          })
        }
      );
      if (!response.ok) {
        setActionError(await responseError(response, "完成逐段审核失败。"));
        return;
      }
      await Promise.all([refresh(), loadReviewWorkspace(selected.id)]);
    } catch {
      setActionError("完成逐段审核失败。");
    } finally {
      setReviewSectionActioning(false);
    }
  }

  async function action(name: "publish" | "archive" | "rollback") {
    if (!selected) return;
    if (name === "publish" && selected.publishReady !== true) return;
    if (
      name === "rollback" &&
      (selected.status !== "published" || !selected.previousPublishedVersionId)
    ) {
      return;
    }
    if (name === "archive" && selected.status === "archived") return;
    setActioning(name);
    setActionError("");
    try {
      const response = await fetch(
        `/api/admin/knowledge/${selected.id}/${name}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            name === "rollback"
              ? { versionId: selected.previousPublishedVersionId }
              : {}
          )
        }
      );
      if (!response.ok) {
        setActionError(
          await responseError(
            response,
            name === "publish"
              ? "发布失败，请重试。"
              : name === "archive"
                ? "归档失败，请重试。"
                : "回滚失败，请重试。"
          )
        );
        return;
      }
      await refresh();
    } catch {
      setActionError(
        name === "publish"
          ? "发布失败，请重试。"
          : name === "archive"
            ? "归档失败，请重试。"
            : "回滚失败，请重试。"
      );
    } finally {
      setActioning(undefined);
    }
  }

  const publishDisabledReason = selected
    ? selected.publishReady === undefined
      ? "接口尚未返回发布门禁结果。"
      : selected.publishReady === false
        ? (selected.publishBlockers[0] ?? "尚未满足发布门禁。")
        : undefined
    : undefined;
  return (
    <div className="grid min-h-[calc(100vh-60px)] xl:grid-cols-[minmax(0,1fr)_390px]">
      <section className="min-w-0 p-5 sm:p-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em]">知识库</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            管理可检索、可引用、可回滚的真空领域资料。
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-[auto_minmax(16rem,1fr)_auto_auto_auto]">
          <label className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-4 text-sm font-medium text-white">
            <Upload className="h-4 w-4" />
            {importing ? "导入中…" : "导入待审 JSON"}
            <input
              type="file"
              accept="application/json,.json"
              aria-label="导入待审知识 JSON"
              disabled={importing}
              className="sr-only"
              onChange={(event) => {
                void importCandidate(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] px-3">
            <Search className="h-4 w-4 text-[var(--muted)]" />
            <input
              type="search"
              aria-label="搜索知识文档或来源"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 outline-none"
              placeholder="搜索文档或来源"
            />
          </label>
          <select
            aria-label="来源层级"
            value={sourceTierFilter}
            onChange={(event) => setSourceTierFilter(event.target.value)}
            className="h-11 min-w-0 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm"
          >
            <option value="">全部来源层级</option>
            {Object.entries(sourceTierLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="许可状态"
            value={licenseFilter}
            onChange={(event) => setLicenseFilter(event.target.value)}
            className="h-11 min-w-0 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm"
          >
            <option value="">全部许可</option>
            {[
              ...new Set(
                documents.map((item) => item.licensePolicy).filter(Boolean)
              )
            ].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="发布状态"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="h-11 min-w-0 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm"
          >
            <option value="">全部状态</option>
            {Object.entries(statusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {importMessage ? (
          <p role="status" className="mt-3 text-sm text-[var(--accent)]">
            {importMessage}
          </p>
        ) : null}

        {loading ? (
          <div className="grid min-h-64 place-items-center">
            <LoaderCircle className="h-6 w-6 animate-spin text-[var(--muted)]" />
          </div>
        ) : error ? (
          <p
            role="alert"
            className="mt-8 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] p-4 text-sm text-[var(--danger)]"
          >
            {error}
          </p>
        ) : visible.length === 0 ? (
          <div className="mt-8 grid min-h-64 place-items-center border border-dashed border-[var(--border-strong)] text-center">
            <div>
              <FileSearch className="mx-auto h-7 w-7 text-[var(--muted)]" />
              <p className="mt-3 text-sm font-medium">还没有可显示的资料</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                新资料会先进入草稿和人工复核，不会直接发布。
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-7 overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
              <thead className="text-xs text-[var(--muted)]">
                <tr className="border-b border-[var(--border)]">
                  <th className="px-3 py-4 font-medium">文档</th>
                  <th className="px-3 py-4 font-medium">来源</th>
                  <th className="px-3 py-4 font-medium">状态</th>
                  <th className="px-3 py-4 font-medium">人工复核</th>
                  <th className="px-3 py-4 font-medium">Embedding</th>
                  <th className="px-3 py-4 font-medium">发布门禁</th>
                  <th className="px-3 py-4 font-medium">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((document) => (
                  <tr
                    key={document.id}
                    tabIndex={0}
                    aria-selected={selected?.id === document.id}
                    onClick={() => {
                      setSelectedId(document.id);
                      setActionError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(document.id);
                        setActionError("");
                      }
                    }}
                    className={`cursor-pointer border-b border-[var(--border)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)] ${
                      selected?.id === document.id
                        ? "border-l-2 border-l-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-l-2 border-l-transparent hover:bg-[var(--surface)]"
                    }`}
                  >
                    <td className="max-w-[300px] px-3 py-4">
                      <p className="truncate font-medium">{document.title}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {versionLabel(document)}
                      </p>
                    </td>
                    <td className="max-w-[220px] px-3 py-4">
                      <p className="truncate">
                        {document.sourceName ?? "未关联来源"}
                      </p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {document.sourceTier
                          ? (sourceTierLabel[document.sourceTier] ??
                            document.sourceTier)
                          : "来源层级未返回"}
                      </p>
                    </td>
                    <td className="px-3 py-4">
                      <StateLine state={documentState(document.status)} />
                    </td>
                    <td className="px-3 py-4">
                      <StateLine state={reviewState(document.reviewStatus)} />
                    </td>
                    <td className="px-3 py-4">
                      <StateLine
                        state={embeddingState(document.embeddingStatus)}
                      />
                    </td>
                    <td className="px-3 py-4">
                      <StateLine state={publishState(document)} />
                    </td>
                    <td className="px-3 py-4 text-[var(--muted)]">
                      {formatDateTime(document.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {reviewWorkspaceLoading ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-[var(--muted)]">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            正在生成稳定审核段落…
          </div>
        ) : currentReviewWorkspace && activeReviewSection ? (
          <section className="mt-10 border-t border-[var(--border)] pt-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">逐段知识审核</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  第 {activeReviewSection.sectionIndex + 1} /{" "}
                  {currentReviewWorkspace.sections.length} 段
                </p>
              </div>
              <button
                type="button"
                disabled={
                  reviewSectionActioning ||
                  !currentReviewWorkspace.sections.every(
                    (section) => section.reviewStatus === "approved"
                  )
                }
                onClick={() => void completeSectionReview()}
                className="h-10 rounded-lg bg-[var(--ink)] px-4 text-sm font-medium text-white disabled:opacity-30"
              >
                完成逐段审核
              </button>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2 lg:hidden">
              {["中文段落", "原文或定位证据", "审核决定"].map(
                (label, index) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setMobileReviewStep(index as 0 | 1 | 2)}
                    className={`h-9 rounded-lg border text-xs ${mobileReviewStep === index ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`}
                  >
                    {index + 1}. {label}
                  </button>
                )
              )}
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              <article
                className={`${mobileReviewStep === 0 ? "block" : "hidden"} rounded-xl border border-[var(--border)] p-5 lg:block`}
              >
                <p className="text-xs font-semibold text-[var(--muted)]">
                  中文段落
                </p>
                <p className="mt-4 text-sm leading-7">
                  {activeReviewSection.contentZh}
                </p>
              </article>
              <article
                className={`${mobileReviewStep === 1 ? "block" : "hidden"} rounded-xl border border-[var(--border)] p-5 lg:block`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-[var(--muted)]">
                    官方原文或定位证据
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {activeReviewSection.pageStart
                      ? activeReviewSection.pageEnd &&
                        activeReviewSection.pageEnd !==
                          activeReviewSection.pageStart
                        ? `第 ${activeReviewSection.pageStart}–${activeReviewSection.pageEnd} 页`
                        : `第 ${activeReviewSection.pageStart} 页`
                      : "页码未提供"}
                  </p>
                </div>
                <p className="mt-4 text-sm leading-7">
                  {activeReviewSection.officialText ||
                    "未提供官方原文或定位证据。"}
                </p>
              </article>
              <article
                className={`${mobileReviewStep === 2 ? "block" : "hidden"} rounded-xl border border-[var(--border)] p-5 lg:block`}
              >
                <p className="text-xs font-semibold text-[var(--muted)]">
                  审核决定
                </p>
                <textarea
                  aria-label="段落审核备注"
                  value={reviewSectionNotes[activeReviewSection.id] ?? ""}
                  onChange={(event) =>
                    setReviewSectionNotes((current) => ({
                      ...current,
                      [activeReviewSection.id]: event.target.value
                    }))
                  }
                  rows={4}
                  maxLength={2000}
                  placeholder="驳回或需修改时必须说明原因"
                  className="mt-4 w-full resize-y rounded-lg border border-[var(--border)] bg-transparent p-3 text-sm outline-none"
                />
                <div className="mt-4 grid gap-2">
                  <button
                    type="button"
                    disabled={reviewSectionActioning}
                    onClick={() => void decideReviewSection("approved")}
                    className="h-9 rounded-lg border border-[var(--accent)] text-sm text-[var(--accent)] disabled:opacity-30"
                  >
                    通过段落
                  </button>
                  <button
                    type="button"
                    disabled={reviewSectionActioning}
                    onClick={() =>
                      void decideReviewSection("changes_requested")
                    }
                    className="h-9 rounded-lg border border-[var(--warning)] text-sm text-[var(--warning)] disabled:opacity-30"
                  >
                    需修改
                  </button>
                  <button
                    type="button"
                    disabled={reviewSectionActioning}
                    onClick={() => void decideReviewSection("rejected")}
                    className="h-9 rounded-lg border border-[var(--danger)] text-sm text-[var(--danger)] disabled:opacity-30"
                  >
                    驳回段落
                  </button>
                </div>
              </article>
            </div>

            <div className="mt-5 flex items-center justify-between">
              <button
                type="button"
                disabled={reviewSectionIndex === 0}
                onClick={() => setReviewSectionIndex((index) => index - 1)}
                className="text-sm disabled:opacity-30"
              >
                上一段
              </button>
              <button
                type="button"
                disabled={
                  reviewSectionIndex >=
                  currentReviewWorkspace.sections.length - 1
                }
                onClick={() => setReviewSectionIndex((index) => index + 1)}
                className="text-sm disabled:opacity-30"
              >
                下一段
              </button>
            </div>
          </section>
        ) : null}
      </section>

      <aside className="border-l border-[var(--border)] p-6">
        <h2 className="text-sm font-semibold">文档详情</h2>
        {selected ? (
          <>
            <p className="mt-5 font-medium break-words">{selected.title}</p>
            {selected.description ? (
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                {selected.description}
              </p>
            ) : null}

            <dl className="mt-7 space-y-4 text-sm">
              <DetailRow
                term="文档状态"
                value={documentState(selected.status).label}
              />
              <DetailRow
                term="来源"
                value={selected.sourceName ?? "未关联来源"}
              />
              <DetailRow
                term="来源层级"
                value={
                  selected.sourceTier
                    ? (sourceTierLabel[selected.sourceTier] ??
                      selected.sourceTier)
                    : "未返回"
                }
              />
              <DetailRow
                term="授权策略"
                value={selected.licensePolicy ?? "未返回"}
              />
              <DetailRow term="当前修订" value={versionLabel(selected)} />
              <DetailRow
                term="修订状态"
                value={
                  selected.versionStatus
                    ? (statusLabel[selected.versionStatus] ??
                      selected.versionStatus)
                    : "未返回"
                }
              />
              <DetailRow
                term="采集模式"
                value={
                  selected.ingestionMode
                    ? (ingestionModeLabel[selected.ingestionMode] ??
                      selected.ingestionMode)
                    : "未返回"
                }
              />
              <DetailRow
                term="OCR 置信度"
                value={formatConfidence(selected.ocrConfidence)}
              />
              <DetailRow
                term="当前版本 ID"
                value={selected.currentVersionId ?? "未返回"}
                mono
              />
            </dl>

            <section className="mt-7 border-t border-[var(--border)] pt-6">
              <h3 className="text-xs font-semibold tracking-wide text-[var(--muted)]">
                人工复核
              </h3>
              <div className="mt-4 text-sm">
                <StateLine state={reviewState(selected.reviewStatus)} />
              </div>
              <dl className="mt-4 space-y-4 text-sm">
                <DetailRow
                  term="复核人"
                  value={selected.reviewedBy ?? "未返回"}
                />
                <DetailRow
                  term="复核时间"
                  value={formatDateTime(selected.reviewedAt)}
                />
                <DetailRow
                  term="内容哈希"
                  value={selected.contentHash ?? "未返回"}
                  mono
                />
                <DetailRow
                  term="审核失效时间"
                  value={formatDateTime(selected.reviewInvalidatedAt)}
                />
              </dl>
              <p className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--muted)]">
                整份哈希批准已停用。请在逐段审核工作台为每一段记录通过、驳回或需修改决定。
              </p>
            </section>

            <section className="mt-7 border-t border-[var(--border)] pt-6">
              <h3 className="text-xs font-semibold tracking-wide text-[var(--muted)]">
                向量化
              </h3>
              <div className="mt-4 text-sm">
                <StateLine state={embeddingState(selected.embeddingStatus)} />
              </div>
              <dl className="mt-4 space-y-4 text-sm">
                <DetailRow
                  term="片段进度"
                  value={
                    selected.chunkCount === undefined
                      ? "未返回"
                      : `${selected.embeddedChunkCount ?? 0} / ${selected.chunkCount}`
                  }
                />
                <DetailRow
                  term="Embedding 模型"
                  value={selected.embeddingModel ?? "未返回"}
                />
              </dl>
            </section>

            <section className="mt-7 border-t border-[var(--border)] pt-6">
              <h3 className="text-xs font-semibold tracking-wide text-[var(--muted)]">
                发布门禁
              </h3>
              <div className="mt-4 text-sm">
                <StateLine state={publishState(selected)} />
              </div>
              {selected.publishBlockers.length > 0 ? (
                <ul className="mt-4 space-y-2 text-xs leading-5 text-[var(--danger)]">
                  {selected.publishBlockers.map((blocker) => (
                    <li key={blocker}>· {blocker}</li>
                  ))}
                </ul>
              ) : selected.publishReady === undefined ? (
                <p className="mt-4 text-xs leading-5 text-[var(--muted)]">
                  详情响应未包含 publishReady，前端不会据状态自行放行。
                </p>
              ) : null}
            </section>

            <div className="mt-8 space-y-3">
              <button
                type="button"
                onClick={() => void action("publish")}
                disabled={
                  selected.publishReady !== true || actioning !== undefined
                }
                title={publishDisabledReason}
                className="h-11 w-full rounded-lg bg-[var(--ink)] text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-30"
              >
                {actioning === "publish" ? "发布中…" : "发布新修订"}
              </button>
              <button
                type="button"
                onClick={() => void action("rollback")}
                disabled={
                  selected.status !== "published" ||
                  !selected.previousPublishedVersionId ||
                  actioning !== undefined
                }
                className="inline-flex h-11 w-full items-center justify-center gap-2 text-sm font-medium text-[var(--warning)] disabled:cursor-not-allowed disabled:opacity-30"
              >
                {actioning === "rollback" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                {actioning === "rollback" ? "回滚中…" : "回滚至上一版"}
              </button>
              <button
                type="button"
                onClick={() => void action("archive")}
                disabled={
                  selected.status === "archived" || actioning !== undefined
                }
                className="inline-flex h-11 w-full items-center justify-center gap-2 text-sm font-medium text-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-30"
              >
                {actioning === "archive" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                {actioning === "archive" ? "归档中…" : "归档文档"}
              </button>
            </div>

            {actionError ? (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] p-3 text-xs leading-5 text-[var(--danger)]"
              >
                {actionError}
              </p>
            ) : null}

            <p className="mt-5 text-xs leading-6 text-[var(--muted)]">
              首期来源可在授权与内容哈希固定后先接入检索，并保持“待人工复核”标记；批准会转为正式复核状态，驳回会立即归档并退出检索。
            </p>
          </>
        ) : (
          <p className="mt-5 text-sm leading-6 text-[var(--muted)]">
            选择一份资料查看来源、人工复核、Embedding 和发布门禁。
          </p>
        )}
      </aside>
    </div>
  );
}
