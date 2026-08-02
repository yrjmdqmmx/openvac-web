"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cuboid,
  Download,
  FileText,
  Flag,
  LoaderCircle,
  MessageSquareWarning,
  ThumbsDown,
  ThumbsUp
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { evaluateCitationLink } from "@/lib/citation-link-policy";
import type { ChatMessage, Citation, ModelingCard } from "@/types/chat";

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

function SourceItem({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const link = evaluateCitationLink(citation);

  return (
    <li className="border-t border-[var(--border)] py-3 first:border-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 text-left"
      >
        <FileText className="h-4 w-4 shrink-0 text-[var(--muted)]" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {citation.title}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>
      {open && (
        <div className="mt-3 pl-7 text-xs leading-6 text-[var(--muted)]">
          <p>
            {citation.publisher}
            {citation.pageOrSection ? ` · ${citation.pageOrSection}` : ""}
          </p>
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

function ModelingCards({ cards }: { cards: ModelingCard[] }) {
  return (
    <section
      aria-label="建模项目与制品"
      className="mt-7 rounded-xl border border-[var(--border)] p-4"
    >
      <div className="flex items-center gap-2">
        <Cuboid className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-medium">建模项目与制品</h2>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
        链接已由服务端按当前账号校验；打开链接不会让问答 Agent 执行 CAD 操作。
      </p>
      <ul className="mt-3 grid gap-2">
        {cards.map((card) => (
          <li
            key={`${card.kind}:${card.kind === "project" ? card.projectId : card.artifactId}`}
          >
            {card.kind === "project" ? (
              <Link
                href={`/modeling?project=${encodeURIComponent(card.projectId)}`}
                className="flex items-center gap-3 rounded-lg bg-[var(--surface)] px-3 py-3 transition-colors hover:bg-[var(--surface-strong)]"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-[var(--accent)]">
                  <Cuboid className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-medium">
                    {card.title}
                  </strong>
                  <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
                    {card.description || "打开已授权建模项目"}
                  </span>
                </span>
                <span className="text-xs font-medium text-[var(--accent)]">
                  打开项目
                </span>
              </Link>
            ) : (
              <a
                href={`/api/modeling/artifacts/${encodeURIComponent(card.artifactId)}/download`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-lg bg-[var(--surface)] px-3 py-3 transition-colors hover:bg-[var(--surface-strong)]"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-[var(--accent)]">
                  <Download className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-medium">
                    {card.title}
                  </strong>
                  <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
                    {card.projectTitle} · {card.format} ·{" "}
                    {formatBytes(card.sizeBytes)}
                  </span>
                </span>
                <span className="text-xs font-medium text-[var(--accent)]">
                  授权下载
                </span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function ExpertAnswer({
  message,
  stage,
  onFeedback,
  onProblemReport,
  modelingEnabled = false
}: {
  message: ChatMessage;
  stage?: string;
  onFeedback: (
    messageId: string,
    rating: "up" | "down" | "report"
  ) => Promise<void>;
  onProblemReport: (messageId: string) => void;
  modelingEnabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const citations = useMemo(
    () => message.meta?.citations ?? [],
    [message.meta]
  );
  const modelingCards = useMemo(
    () => (modelingEnabled ? (message.meta?.modelingCards ?? []) : []),
    [message.meta, modelingEnabled]
  );

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
        </div>
        {stage ? (
          <p
            role="status"
            className="mt-2 flex items-center gap-2 text-sm text-[var(--muted)]"
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {stage}
          </p>
        ) : null}
      </div>

      {message.content ? (
        <AnswerText content={message.content} />
      ) : (
        <div className="space-y-3" aria-label="正在生成回答">
          <div className="h-4 w-3/5 animate-pulse rounded bg-[var(--surface-strong)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--surface-strong)]" />
          <div className="h-4 w-4/5 animate-pulse rounded bg-[var(--surface-strong)]" />
        </div>
      )}

      {citations.length > 0 && (
        <div className="mt-7 rounded-xl border border-[var(--border)] px-4">
          <p className="pt-4 text-xs font-medium tracking-wide text-[var(--muted)]">
            本次引用
          </p>
          <ul>
            {citations.map((citation) => (
              <SourceItem key={citation.sourceId} citation={citation} />
            ))}
          </ul>
        </div>
      )}

      {modelingCards.length > 0 ? (
        <ModelingCards cards={modelingCards} />
      ) : null}

      {message.status !== "streaming" && (
        <div className="mt-6 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(message.content);
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
    </article>
  );
}
