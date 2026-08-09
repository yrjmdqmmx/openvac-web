"use client";

import {
  BrainCircuit,
  CircleStop,
  Globe2,
  Link2,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Send,
  X
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

import {
  cancelChatAttachment,
  CHAT_ATTACHMENT_ACCEPT,
  type LocalChatAttachment,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  uploadChatAttachment,
  validateChatAttachmentFile
} from "@/lib/chat-attachments";

export type ComposerLink = { id: string; url: string; label: string };

const ATTACHMENT_STATUS_LABELS: Record<LocalChatAttachment["status"], string> =
  {
    hashing: "计算校验值",
    initiated: "准备上传",
    uploading: "上传中",
    scanning: "安全扫描",
    processing: "解析中",
    ready: "就绪",
    failed: "失败",
    deleted: "已取消",
    cancelled: "已取消"
  };

export function ChatComposer({
  input,
  onInputChange,
  links,
  onLinksChange,
  attachments,
  onAttachmentsChange,
  conversationId,
  onEnsureConversation,
  busy,
  mode,
  webMode,
  onModeChange,
  onWebModeChange,
  onSubmit,
  onCancelRun,
  onError
}: {
  input: string;
  onInputChange: (value: string) => void;
  links: ComposerLink[];
  onLinksChange: (value: ComposerLink[]) => void;
  attachments: LocalChatAttachment[];
  onAttachmentsChange: (
    update:
      | LocalChatAttachment[]
      | ((current: LocalChatAttachment[]) => LocalChatAttachment[])
  ) => void;
  conversationId?: string;
  onEnsureConversation?: () => Promise<string>;
  busy: boolean;
  mode: "auto" | "deep";
  webMode: "auto" | "always";
  onModeChange: (value: "auto" | "deep") => void;
  onWebModeChange: (value: "auto" | "always") => void;
  onSubmit: () => void;
  onCancelRun: () => void;
  onError: (message: string) => void;
}) {
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const controllersRef = useRef(new Map<string, AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values()) {
        controller.abort();
      }
      controllersRef.current.clear();
    },
    []
  );
  useEffect(() => {
    const retained = new Set(
      attachments.map((attachment) => attachment.localId)
    );
    for (const [localId, controller] of controllersRef.current) {
      if (!retained.has(localId)) controller.abort();
    }
  }, [attachments]);

  const activeAttachments = attachments.filter(
    (attachment) =>
      attachment.status !== "cancelled" && attachment.status !== "deleted"
  );
  const attachmentWorkPending = activeAttachments.some(
    (attachment) => attachment.status !== "ready"
  );
  const textLength = Array.from(input.trim()).length;
  const hasContent =
    textLength >= 2 || links.length > 0 || activeAttachments.length > 0;
  const canSend = !busy && hasContent && !attachmentWorkPending;

  function updateAttachment(
    localId: string,
    update: Partial<LocalChatAttachment>
  ) {
    onAttachmentsChange((current) =>
      current.map((attachment) =>
        attachment.localId === localId
          ? { ...attachment, ...update }
          : attachment
      )
    );
  }

  async function startUpload(attachment: LocalChatAttachment) {
    const controller = new AbortController();
    controllersRef.current.set(attachment.localId, controller);
    let registeredAttachmentId = attachment.attachmentId;
    try {
      const uploadConversationId =
        conversationId ?? (await onEnsureConversation?.());
      if (!uploadConversationId) {
        throw new Error("暂时无法创建附件所属对话，请稍后重试。");
      }
      const part = await uploadChatAttachment(attachment.file, {
        conversationId: uploadConversationId,
        signal: controller.signal,
        onUpdate(update) {
          if (update.attachmentId) registeredAttachmentId = update.attachmentId;
          updateAttachment(attachment.localId, update);
        }
      });
      updateAttachment(attachment.localId, {
        attachmentId: part.attachmentId,
        kind: part.kind,
        mimeType: part.mimeType,
        status: part.status,
        ...(part.status === "failed"
          ? { error: "附件扫描或解析失败，请移除后重试。" }
          : {})
      });
    } catch (caught) {
      if (controller.signal.aborted) {
        updateAttachment(attachment.localId, { status: "cancelled" });
      } else {
        updateAttachment(attachment.localId, {
          status: "failed",
          error:
            caught instanceof Error ? caught.message : "附件上传失败，请重试。"
        });
      }
    } finally {
      controllersRef.current.delete(attachment.localId);
      if (controller.signal.aborted && registeredAttachmentId) {
        await cancelChatAttachment(registeredAttachmentId);
      }
    }
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    let remaining = MAX_CHAT_ATTACHMENTS_PER_MESSAGE - activeAttachments.length;
    if (fileList.length > remaining) {
      onError(`每条消息最多包含 ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} 个附件。`);
    }
    for (const file of Array.from(fileList)) {
      if (remaining <= 0) break;
      const validation = validateChatAttachmentFile(file);
      if (!validation.ok) {
        onError(`${file.name}：${validation.message}`);
        continue;
      }
      remaining -= 1;
      const attachment: LocalChatAttachment = {
        localId: crypto.randomUUID(),
        file,
        kind: validation.kind,
        filename: file.name,
        mimeType: validation.mimeType,
        sizeBytes: file.size,
        status: "hashing"
      };
      onAttachmentsChange((current) => [...current, attachment]);
      void startUpload(attachment);
    }
  }

  function addLink() {
    const raw = linkDraft.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      onError("请输入完整的 HTTPS 链接。");
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      raw.length > 2_048
    ) {
      onError("链接必须使用 HTTPS，且不能包含账号凭据。");
      return;
    }
    if (links.length >= 10) {
      onError("每条消息最多添加 10 个链接。");
      return;
    }
    const url = parsed.toString();
    if (!links.some((link) => link.url === url)) {
      onLinksChange([
        ...links,
        { id: crypto.randomUUID(), url, label: parsed.hostname }
      ]);
    }
    setLinkDraft("");
    setLinkEditorOpen(false);
  }

  function trySubmit() {
    if (textLength === 1) {
      onError("请至少输入 2 个字符，以便 OpenVac 理解你的问题。");
      return;
    }
    if (canSend) onSubmit();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    trySubmit();
  }

  return (
    <form
      aria-busy={busy || attachmentWorkPending}
      onSubmit={submit}
      className="rounded-[14px] border border-[var(--border-strong)] bg-white p-3 shadow-[0_4px_20px_rgba(17,19,21,0.04)] transition-[border-color,box-shadow] focus-within:border-[var(--ink)] focus-within:shadow-[0_0_0_3px_rgba(17,19,21,0.08)]"
    >
      {links.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="已添加链接">
          {links.map((link) => (
            <li
              key={link.id}
              className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs text-[var(--ink)]"
            >
              <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{link.label}</span>
              <button
                type="button"
                onClick={() =>
                  onLinksChange(links.filter((item) => item.id !== link.id))
                }
                aria-label={`移除链接 ${link.label}`}
                className="rounded-full"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="mb-2 grid gap-1.5 sm:grid-cols-2" aria-label="工程附件">
          {attachments.map((attachment) => {
            const working =
              attachment.status === "hashing" ||
              attachment.status === "initiated" ||
              attachment.status === "uploading" ||
              attachment.status === "scanning" ||
              attachment.status === "processing";
            return (
              <li
                key={attachment.localId}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-2 text-xs"
              >
                {working ? (
                  <LoaderCircle
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 animate-spin"
                  />
                ) : (
                  <Paperclip aria-hidden className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {attachment.filename}
                  </span>
                  <span
                    className={
                      attachment.status === "failed"
                        ? "text-[var(--danger)]"
                        : "text-[var(--muted)]"
                    }
                  >
                    {ATTACHMENT_STATUS_LABELS[attachment.status]} ·{" "}
                    {formatBytes(attachment.sizeBytes)}
                  </span>
                  {attachment.error ? (
                    <span className="block text-[var(--danger)]">
                      {attachment.error}
                    </span>
                  ) : null}
                </span>
                {attachment.status === "failed" ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (attachment.attachmentId) {
                        await cancelChatAttachment(attachment.attachmentId);
                      }
                      updateAttachment(attachment.localId, {
                        attachmentId: undefined,
                        status: "hashing",
                        error: undefined
                      });
                      void startUpload({
                        ...attachment,
                        attachmentId: undefined,
                        status: "hashing",
                        error: undefined
                      });
                    }}
                    aria-label={`重试附件 ${attachment.filename}`}
                    className="rounded p-1"
                  >
                    <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (
                      attachment.status === "cancelled" ||
                      attachment.status === "deleted"
                    ) {
                      onAttachmentsChange((current) =>
                        current.filter(
                          (item) => item.localId !== attachment.localId
                        )
                      );
                      return;
                    }
                    const controller = controllersRef.current.get(
                      attachment.localId
                    );
                    controller?.abort();
                    updateAttachment(attachment.localId, {
                      status: "cancelled",
                      error: undefined
                    });
                    if (!controller && attachment.attachmentId) {
                      void cancelChatAttachment(attachment.attachmentId);
                    }
                  }}
                  aria-label={`${working ? "取消上传" : "移除附件"} ${attachment.filename}`}
                  className="rounded p-1"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {linkEditorOpen ? (
        <div className="mb-2 flex gap-2">
          <label htmlFor="chat-link" className="visually-hidden">
            HTTPS 链接
          </label>
          <input
            id="chat-link"
            type="url"
            inputMode="url"
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            placeholder="https://example.com/manual"
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] px-3 text-sm"
            autoFocus
          />
          <button
            type="button"
            onClick={addLink}
            className="h-9 rounded-lg bg-[var(--ink)] px-3 text-xs text-white"
          >
            添加
          </button>
          <button
            type="button"
            onClick={() => setLinkEditorOpen(false)}
            className="h-9 rounded-lg px-2 text-xs text-[var(--muted)]"
          >
            取消
          </button>
        </div>
      ) : null}

      <div className="flex min-h-[64px] items-end gap-3 pl-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="chat-input" className="visually-hidden">
            继续提问
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                trySubmit();
              }
            }}
            rows={2}
            maxLength={16_000}
            placeholder="继续描述工况、型号或故障现象……"
            className="composer-textarea max-h-40 min-h-11 w-full resize-none border-0 bg-transparent py-2 text-sm leading-6 outline-none sm:text-base"
          />
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--surface)] px-2 text-xs text-[var(--muted)] hover:text-[var(--ink)]">
              <Paperclip aria-hidden className="h-3.5 w-3.5" />
              附件
              <input
                type="file"
                multiple
                accept={CHAT_ATTACHMENT_ACCEPT}
                disabled={busy || activeAttachments.length >= 5}
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
                className="visually-hidden"
                aria-label="添加工程附件"
              />
            </label>
            <button
              type="button"
              onClick={() => setLinkEditorOpen((value) => !value)}
              aria-expanded={linkEditorOpen}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--surface)] px-2 text-xs text-[var(--muted)] hover:text-[var(--ink)]"
            >
              <Link2 aria-hidden className="h-3.5 w-3.5" />
              链接
            </button>
            <button
              type="button"
              aria-pressed={mode === "deep"}
              title="关闭时自动选择思考强度；开启后下一轮强制深度思考"
              onClick={() => onModeChange(mode === "deep" ? "auto" : "deep")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
                mode === "deep"
                  ? "bg-[var(--ink)] text-white"
                  : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <BrainCircuit aria-hidden className="h-3.5 w-3.5" />
              深度思考
            </button>
            <button
              type="button"
              aria-pressed={webMode === "always"}
              title="关闭时按问题自动联网；开启后下一轮强制联网"
              onClick={() =>
                onWebModeChange(webMode === "always" ? "auto" : "always")
              }
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
                webMode === "always"
                  ? "bg-[var(--ink)] text-white"
                  : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Globe2 aria-hidden className="h-3.5 w-3.5" />
              联网
            </button>
          </div>
        </div>
        {busy ? (
          <button
            type="button"
            onClick={onCancelRun}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[var(--ink)] text-white"
            aria-label="取消回答"
          >
            <CircleStop className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            title={attachmentWorkPending ? "所有附件就绪后才能发送" : undefined}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[var(--ink)] text-white transition-colors hover:bg-[#292b2d] disabled:opacity-30"
            aria-label="发送"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="mt-2 px-2 text-[10px] leading-4 text-[var(--muted)]">
        附件会私密直传，并发送到阿里云模型处理；不会自动加入知识库。支持
        PDF、DOCX、XLSX、CSV、TXT、MD、JPG、PNG，单文件不超过 25 MiB。
      </p>
    </form>
  );
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
