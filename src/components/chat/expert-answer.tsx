"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Flag,
  MessageSquareWarning,
  ThumbsDown,
  ThumbsUp
} from "lucide-react";
import { useMemo, useState } from "react";
import { evaluateCitationLink } from "@/lib/citation-link-policy";
import type { ChatMessage, Citation } from "@/types/chat";

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
        <FileText className="h-4 w-4 shrink-0 text-[var(--accent)]" />
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
              className="text-[var(--accent)] underline underline-offset-4"
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
  onFeedback,
  onProblemReport
}: {
  message: ChatMessage;
  onFeedback: (
    messageId: string,
    rating: "up" | "down" | "report"
  ) => Promise<void>;
  onProblemReport: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const citations = useMemo(
    () => message.meta?.citations ?? [],
    [message.meta]
  );

  return (
    <article className="mx-auto w-full max-w-[760px] pb-10">
      <div className="mb-6 flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full border border-[#abd4d0] bg-[var(--accent-soft)] text-sm font-semibold text-[var(--accent)]">
          OV
        </span>
        <span className="font-medium">OpenVac 真空专家</span>
        {message.meta?.riskLevel === "high" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--warning)]">
            <AlertTriangle className="h-3.5 w-3.5" />
            安全优先
          </span>
        )}
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
                feedback === rating ? "text-[var(--accent)]" : ""
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
        </div>
      )}
    </article>
  );
}
