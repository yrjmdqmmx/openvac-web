"use client";

import dynamic from "next/dynamic";
import { FileOutput, FileText, Link2, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";

import { evaluateVerifiedLinkPart } from "@/lib/citation-link-policy";
import type {
  ArtifactPart,
  AttachmentPart,
  InputMessagePart,
  MessagePart
} from "@/types/chat-v3";

const AttachmentPreview = dynamic(
  () =>
    import("@/components/chat/attachment-preview").then(
      (module) => module.AttachmentPreview
    ),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="text-sm text-[var(--muted)]">
        正在加载私有预览…
      </p>
    )
  }
);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function MessagePartCards({
  parts = [],
  inputParts = [],
  compact = false,
  includeText = false
}: {
  parts?: MessagePart[];
  inputParts?: InputMessagePart[];
  compact?: boolean;
  includeText?: boolean;
}) {
  const [preview, setPreview] = useState<AttachmentPart>();
  const previewTriggerRef = useRef<HTMLButtonElement | undefined>(undefined);
  const visibleParts = parts.filter(
    (part) => includeText || part.type !== "text"
  );
  const optimisticParts = inputParts.filter((inputPart) => {
    if (inputPart.type === "text") {
      return !parts.some((part) => part.type === "text");
    }
    if (inputPart.type === "link") {
      return !parts.some(
        (part) => part.type === "verified_link" && part.url === inputPart.url
      );
    }
    return !parts.some(
      (part) =>
        part.type === "attachment" &&
        part.attachmentId === inputPart.attachmentId
    );
  });
  if (visibleParts.length === 0 && optimisticParts.length === 0) return null;

  return (
    <>
      <div
        className={`flex flex-wrap gap-2 ${compact ? "mt-2 justify-end" : "mt-4"}`}
      >
        {visibleParts.map((part, index) => {
          if (part.type === "text") {
            return (
              <p key={`text-${index}`} className="w-full whitespace-pre-wrap">
                {part.text}
              </p>
            );
          }
          if (part.type === "verified_link") {
            const decision = evaluateVerifiedLinkPart(part);
            return decision.allowed ? (
              <a
                key={part.linkId}
                href={decision.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs underline underline-offset-2"
              >
                <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{part.label}</span>
              </a>
            ) : (
              <span
                key={part.linkId}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]"
              >
                <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{part.label} · 链接不可用</span>
              </span>
            );
          }
          if (part.type === "attachment") {
            return (
              <AttachmentCard
                key={part.attachmentId}
                attachment={part}
                onPreview={(trigger) => {
                  previewTriggerRef.current = trigger;
                  setPreview(part);
                }}
              />
            );
          }
          if (part.type === "artifact") {
            return <ArtifactCard key={part.artifactId} artifact={part} />;
          }
          return null;
        })}
        {optimisticParts.map((part, index) => {
          if (part.type === "text" && includeText) {
            return (
              <p
                key={`input-text-${index}`}
                className="w-full whitespace-pre-wrap"
              >
                {part.text}
              </p>
            );
          }
          if (part.type === "link") {
            return (
              <span
                key={`${part.url}-${index}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]"
              >
                <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {part.label ?? part.url} · 待验证
                </span>
              </span>
            );
          }
          if (part.type === "attachment") {
            return (
              <span
                key={`${part.attachmentId}-${index}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs"
              >
                <FileText aria-hidden className="h-3.5 w-3.5" />
                工程附件
              </span>
            );
          }
          return null;
        })}
      </div>
      {preview ? (
        <AttachmentPreview
          attachment={preview}
          onClose={() => {
            setPreview(undefined);
            window.setTimeout(() => previewTriggerRef.current?.focus(), 0);
          }}
        />
      ) : null}
    </>
  );
}

function AttachmentCard({
  attachment,
  onPreview
}: {
  attachment: AttachmentPart;
  onPreview: (trigger: HTMLButtonElement) => void;
}) {
  const status = {
    initiated: "等待上传",
    uploading: "上传中",
    scanning: "安全扫描",
    processing: "解析中",
    ready: "已就绪",
    failed: "处理失败",
    deleted: "已删除"
  }[attachment.status];
  const working =
    attachment.status === "initiated" ||
    attachment.status === "uploading" ||
    attachment.status === "scanning" ||
    attachment.status === "processing";
  return (
    <article className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
      {working ? (
        <LoaderCircle aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
      ) : (
        <FileText aria-hidden className="h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {attachment.filename}
        </span>
        <span className="text-[var(--muted)]">{status}</span>
      </span>
      {attachment.status === "ready" &&
      UUID_PATTERN.test(attachment.attachmentId) ? (
        <button
          type="button"
          onClick={(event) => onPreview(event.currentTarget)}
          className="ml-1 rounded-md px-2 py-1 font-medium hover:bg-[var(--surface)]"
        >
          预览
        </button>
      ) : null}
    </article>
  );
}

function ArtifactCard({ artifact }: { artifact: ArtifactPart }) {
  const downloadable =
    artifact.status === "ready" && UUID_PATTERN.test(artifact.artifactId);
  return (
    <article className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
      <FileOutput aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{artifact.title}</span>
        <span className="text-[var(--muted)]">
          {artifact.status === "generating"
            ? "生成中"
            : artifact.status === "ready"
              ? artifact.formats.join(" / ").toUpperCase()
              : artifact.status === "failed"
                ? "生成失败"
                : "已删除"}
        </span>
      </span>
      {downloadable && artifact.formats[0] ? (
        <a
          href={`/api/chat/artifacts/${encodeURIComponent(artifact.artifactId)}/download?format=${encodeURIComponent(artifact.formats[0])}`}
          className="rounded-md px-2 py-1 font-medium hover:bg-[var(--surface)]"
        >
          下载
        </a>
      ) : null}
    </article>
  );
}
