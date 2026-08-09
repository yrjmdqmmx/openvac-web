"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Flag,
  LoaderCircle,
  MessageSquareWarning,
  ThumbsDown,
  ThumbsUp
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  AnswerBlocks,
  answerBlocksToPlainText
} from "@/components/chat/answer-blocks";
import { evaluateCitationLink } from "@/lib/citation-link-policy";
import type { AgentTimelineEntry } from "@/components/chat/chat-workspace";
import type {
  AnswerV2,
  ChatMessage,
  Citation,
  PublicCalculation
} from "@/types/chat";

function AnswerText({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="answer-content">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={index} className="h-2" />;
        if (
          /^(#{1,3}\s*)?(结论|采用的条件\s*\/\s*假设|依据与来源|仍缺少的信息|建议下一步)[：:]?$/.test(
            trimmed
          )
        ) {
          return (
            <h2 key={index}>
              {trimmed.replace(/^#{1,3}\s*/, "").replace(/[：:]$/, "")}
            </h2>
          );
        }
        if (/^[-*]\s+/.test(trimmed)) {
          return (
            <p key={index} className="pl-4 before:mr-2 before:content-['•']">
              {trimmed.replace(/^[-*]\s+/, "")}
            </p>
          );
        }
        return <p key={index}>{trimmed}</p>;
      })}
    </div>
  );
}

function EvidenceMarkers({
  ids,
  citations,
  onActivate
}: {
  ids: string[];
  citations: Citation[];
  onActivate: (id: string) => void;
}) {
  const numbers = new Map(
    citations.map((citation, index) => [citation.sourceId, index + 1])
  );
  return (
    <span className="ml-1 inline-flex gap-0.5 align-baseline">
      {[...new Set(ids)].map((id) => {
        const number = numbers.get(id);
        if (!number) return null;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onActivate(id)}
            className="rounded px-0.5 text-xs font-medium text-[var(--accent)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]"
            aria-label={`查看来源 ${number}`}
          >
            [{number}]
          </button>
        );
      })}
    </span>
  );
}

function StructuredAnswer({
  answer,
  citations,
  onCitationActivate
}: {
  answer: AnswerV2;
  citations: Citation[];
  onCitationActivate: (id: string) => void;
}) {
  const section = (title: string, items: string[], empty?: string) => {
    if (items.length === 0 && !empty) return null;
    return (
      <section className="mt-6 first:mt-0">
        <h2>{title}</h2>
        {items.length ? (
          <ul className="mt-2 space-y-2">
            {items.map((item, index) => (
              <li key={`${title}-${index}`} className="leading-7">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p>{empty}</p>
        )}
      </section>
    );
  };
  return (
    <div className="answer-content">
      <section>
        <h2>结论</h2>
        <div className="mt-2 space-y-3">
          {answer.conclusion.map((claim, index) => (
            <p
              key={`conclusion-${index}`}
              data-evidence={claim.evidenceIds.join(" ")}
            >
              {claim.text}
              <EvidenceMarkers
                ids={claim.evidenceIds}
                citations={citations}
                onActivate={onCitationActivate}
              />
            </p>
          ))}
        </div>
      </section>
      {section("采用的条件/假设", answer.assumptions)}
      {answer.evidence.length > 0 ? (
        <section className="mt-6">
          <h2>依据与来源</h2>
          <ul className="mt-2 space-y-2">
            {answer.evidence.map((claim, index) => (
              <li
                key={`evidence-${index}`}
                data-evidence={claim.evidenceIds.join(" ")}
                className="leading-7"
              >
                {claim.claim}
                <EvidenceMarkers
                  ids={claim.evidenceIds}
                  citations={citations}
                  onActivate={onCitationActivate}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {section("仍缺少的信息", answer.missingInputs)}
      {section("建议下一步", answer.nextSteps)}
    </div>
  );
}

function CalculationCards({
  calculations
}: {
  calculations: PublicCalculation[];
}) {
  if (calculations.length === 0) return null;
  return (
    <section className="mt-7" aria-label="工程计算">
      <h2 className="text-sm font-medium">工程计算</h2>
      <div className="mt-3 space-y-2">
        {calculations.map((calculation) => (
          <details
            key={calculation.calculationId}
            className="rounded-xl border border-[var(--border)] px-4 py-3"
          >
            <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]">
              {calculation.title} · {calculation.result}
              {calculation.unit ? ` ${calculation.unit}` : ""}
            </summary>
            <dl className="mt-3 grid gap-2 text-xs leading-6 text-[var(--muted)]">
              {calculation.assumptions.length > 0 ? (
                <div>
                  <dt className="font-medium text-[var(--ink)]">假设</dt>
                  <dd>{calculation.assumptions.join("；")}</dd>
                </div>
              ) : null}
              {calculation.warnings.length > 0 ? (
                <div>
                  <dt className="font-medium text-[var(--warning)]">警告</dt>
                  <dd>{calculation.warnings.join("；")}</dd>
                </div>
              ) : null}
            </dl>
          </details>
        ))}
      </div>
    </section>
  );
}

function AgentTimeline({ entries }: { entries: AgentTimelineEntry[] }) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;
  const active = entries.findLast((entry) => entry.status === "running");
  return (
    <div className="mt-3 max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left font-medium"
      >
        <span>{active?.label ?? "Agent 时间线"}</span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>
      {open ? (
        <ol className="mt-2 space-y-1.5 text-[var(--muted)]">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2">
              <span aria-hidden>
                {entry.status === "running"
                  ? "◌"
                  : entry.status === "completed"
                    ? "✓"
                    : "!"}
              </span>
              <span>{entry.label}</span>
              <span className="visually-hidden">
                {entry.status === "running"
                  ? "进行中"
                  : entry.status === "completed"
                    ? "已完成"
                    : "失败"}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function SourceItem({
  citation,
  active,
  onActiveChange,
  onLocateClaim
}: {
  citation: Citation;
  active: boolean;
  onActiveChange: () => void;
  onLocateClaim: () => void;
}) {
  const [open, setOpen] = useState(false);
  const link = evaluateCitationLink(citation);
  const expanded = active || open;

  return (
    <li
      id={`source-${citation.sourceId}`}
      className="scroll-mt-24 border-t border-[var(--border)] py-3 first:border-0"
    >
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          onActiveChange();
        }}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 text-left"
      >
        <FileText className="h-4 w-4 shrink-0 text-[var(--muted)]" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {citation.title}
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>
      {expanded && (
        <div className="mt-3 pl-7 text-xs leading-6 text-[var(--muted)]">
          <p>
            {citation.publisher}
            {citation.pageOrSection ? ` · ${citation.pageOrSection}` : ""}
          </p>
          <p>
            来源等级：
            {citation.trustTier === "tier_a"
              ? "Tier A"
              : citation.trustTier === "tier_b"
                ? "Tier B"
                : "未进入最终引用等级"}
            {citation.reviewStatus === "pending_review"
              ? " · 待人工审核"
              : citation.reviewStatus === "runtime_verified"
                ? " · 本轮已核验"
                : citation.reviewStatus === "reviewed"
                  ? " · 已人工审核"
                  : citation.reviewStatus === "rejected"
                    ? " · 来源已撤回"
                    : ""}
          </p>
          <button
            type="button"
            onClick={onLocateClaim}
            className="mr-3 text-[var(--ink)] underline underline-offset-4"
          >
            定位正文
          </button>
          <p>
            授权类别：
            {
              {
                open: "开放许可",
                public_domain: "公共领域",
                metadata_only: "仅元数据与链接",
                private_authorized: "已确认私有授权",
                unknown: "尚未确认"
              }[citation.licenseClass]
            }
          </p>
          {link.allowed ? (
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ink)] underline underline-offset-4"
            >
              {link.authoritative ? "打开权威来源" : "打开参考来源"}
            </a>
          ) : (
            <p>来源链接未通过展示策略校验</p>
          )}
        </div>
      )}
    </li>
  );
}

export function ExpertAnswer({
  message,
  stage,
  timeline = [],
  onFeedback,
  onProblemReport,
  onRunAction,
  versionOptions = [],
  onVersionChange,
  historicalVersions = []
}: {
  message: ChatMessage;
  stage?: string;
  timeline?: AgentTimelineEntry[];
  onFeedback: (
    messageId: string,
    rating: "up" | "down" | "report"
  ) => Promise<void>;
  onProblemReport: (messageId: string) => void;
  onRunAction?: (action: "retry" | "regenerate" | "continue") => void;
  versionOptions?: number[];
  onVersionChange?: (version: number) => void;
  historicalVersions?: ChatMessage[];
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [activeCitation, setActiveCitation] = useState<string>();
  const citations = useMemo(
    () => message.meta?.citations ?? [],
    [message.meta]
  );
  const v3Blocks =
    message.meta?.answerV3?.blocks ?? message.meta?.answerBlocks ?? [];

  return (
    <article className="mx-auto w-full max-w-[830px] pb-10">
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-[-0.02em]">OpenVac</span>
          {message.meta?.riskLevel === "high" && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--warning)]">
              <AlertTriangle className="h-3.5 w-3.5" />
              安全优先
            </span>
          )}
          {message.status === "completed" && versionOptions.length > 1 ? (
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-[var(--muted)]">
              <span>回答版本</span>
              <select
                value={message.meta?.answerVersion ?? versionOptions.at(-1)}
                onChange={(event) =>
                  onVersionChange?.(Number(event.target.value))
                }
                className="h-8 rounded-md border border-[var(--border)] bg-white px-2 text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]"
                aria-label="切换回答版本"
              >
                {versionOptions.map((version) => (
                  <option key={version} value={version}>
                    版本 {version}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {message.meta?.resolvedMode ? (
          <p className="mt-1 text-xs text-[var(--muted)]">
            {message.meta.resolvedMode === "deep" ? "深度回答" : "快速回答"}
            {message.meta.webSearched ? " · 已联网" : " · 未使用联网来源"}
            {` · ${citations.length} 个来源`}
            {message.meta.latencyMs !== undefined
              ? ` · ${(message.meta.latencyMs / 1_000).toFixed(1)} 秒`
              : ""}
            {message.meta.context?.strategy === "summarized"
              ? " · 已使用对话摘要"
              : ""}
          </p>
        ) : null}
        {stage ? (
          <p
            role="status"
            aria-live="polite"
            className="mt-2 flex items-center gap-2 text-sm text-[var(--muted)]"
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {stage}
          </p>
        ) : null}
        <AgentTimeline entries={timeline} />
      </div>

      {v3Blocks.length > 0 ? (
        <AnswerBlocks
          blocks={v3Blocks}
          parts={message.parts}
          onEvidenceActivate={(id) => {
            setActiveCitation(id);
            window.setTimeout(
              () =>
                document
                  .getElementById(`source-${id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" }),
              0
            );
          }}
        />
      ) : message.meta?.answer && message.meta.answer.conclusion.length > 0 ? (
        <StructuredAnswer
          answer={message.meta.answer}
          citations={citations}
          onCitationActivate={(id) => {
            setActiveCitation(id);
            window.setTimeout(
              () =>
                document
                  .getElementById(`source-${id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" }),
              0
            );
          }}
        />
      ) : message.content ? (
        <AnswerText content={message.content} />
      ) : message.status === "streaming" ? (
        <div className="space-y-3" aria-label="正在生成回答">
          <div className="h-4 w-3/5 animate-pulse rounded bg-[var(--surface-strong)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--surface-strong)]" />
          <div className="h-4 w-4/5 animate-pulse rounded bg-[var(--surface-strong)]" />
        </div>
      ) : (
        <p className="text-sm text-[var(--muted)]">
          本次回答没有可显示的完整内容。
        </p>
      )}

      {historicalVersions.length > 0 ? (
        <details className="mt-5 rounded-xl border border-[var(--border)] px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            未完成或失败的历史版本（{historicalVersions.length}）
          </summary>
          <ol className="mt-3 space-y-3">
            {historicalVersions.map((historical) => {
              const historicalBlocks =
                historical.meta?.answerV3?.blocks ??
                historical.meta?.answerBlocks ??
                [];
              return (
                <li
                  key={historical.id}
                  className="rounded-lg bg-[var(--surface)] p-3 text-sm"
                >
                  <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                    版本 {historical.meta?.answerVersion ?? "-"} ·{" "}
                    {historical.status === "incomplete"
                      ? "未完成"
                      : historical.status === "error"
                        ? "失败"
                        : "已中止"}
                  </p>
                  {historicalBlocks.length > 0 ? (
                    <AnswerBlocks
                      blocks={historicalBlocks}
                      parts={historical.parts}
                    />
                  ) : historical.content ? (
                    <AnswerText content={historical.content} />
                  ) : (
                    <p className="text-[var(--muted)]">没有可恢复的内容。</p>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}

      <CalculationCards calculations={message.meta?.calculations ?? []} />

      {citations.length > 0 && (
        <div className="mt-7 rounded-xl border border-[var(--border)] px-4">
          <p className="pt-4 text-xs font-medium tracking-wide text-[var(--muted)]">
            本次引用
          </p>
          <ul>
            {citations.map((citation) => (
              <SourceItem
                key={citation.sourceId}
                citation={citation}
                active={activeCitation === citation.sourceId}
                onActiveChange={() => setActiveCitation(citation.sourceId)}
                onLocateClaim={() => {
                  document
                    .querySelector<HTMLElement>(
                      `[data-evidence~="${citation.sourceId}"]`
                    )
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              />
            ))}
          </ul>
        </div>
      )}

      {message.status === "completed" && (
        <div className="mt-6 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(
                v3Blocks.length > 0
                  ? answerBlocksToPlainText(v3Blocks)
                  : message.content
              );
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
            className="grid h-9 w-9 place-items-center rounded-full hover:bg-[var(--surface)]"
            aria-label="复制回答"
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
          {message.status === "completed" ? (
            <>
              {(
                [
                  ["up", ThumbsUp, "回答有帮助"],
                  ["down", ThumbsDown, "回答有问题"],
                  ["report", Flag, "举报回答"]
                ] as const
              ).map(([rating, Icon, label]) => (
                <button
                  key={rating}
                  type="button"
                  onClick={async () => {
                    await onFeedback(message.id, rating);
                    setFeedback(rating);
                  }}
                  className={`grid h-9 w-9 place-items-center rounded-full hover:bg-[var(--surface)] ${
                    feedback === rating ? "text-[var(--ink)]" : ""
                  }`}
                  aria-label={label}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
              <button
                type="button"
                onClick={() => onProblemReport(message.id)}
                className="ml-2 inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-strong)] px-3 text-sm hover:bg-[var(--surface)]"
              >
                <MessageSquareWarning className="h-4 w-4" />
                问题反馈
              </button>
            </>
          ) : null}
        </div>
      )}
      {onRunAction && message.meta?.turnId ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.status === "completed" ? (
            <button
              type="button"
              onClick={() => onRunAction("regenerate")}
              className="h-9 rounded-lg border border-[var(--border)] px-3 text-sm hover:bg-[var(--surface)]"
            >
              重新生成
            </button>
          ) : null}
          {message.status === "incomplete" ? (
            <button
              type="button"
              onClick={() => onRunAction("continue")}
              className="h-9 rounded-lg border border-[var(--border)] px-3 text-sm hover:bg-[var(--surface)]"
            >
              继续
            </button>
          ) : null}
          {message.status === "error" ? (
            <button
              type="button"
              onClick={() => onRunAction("retry")}
              className="h-9 rounded-lg border border-[var(--border)] px-3 text-sm hover:bg-[var(--surface)]"
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
