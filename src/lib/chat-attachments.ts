import type {
  AttachmentKind,
  AttachmentPart,
  AttachmentStatus
} from "@/types/chat-v3";

export const CHAT_ATTACHMENT_ACCEPT =
  ".pdf,.docx,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png";
export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 5;

const MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png"
} as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type LocalAttachmentStatus = "hashing" | AttachmentStatus | "cancelled";

export type LocalChatAttachment = {
  localId: string;
  file: File;
  attachmentId?: string;
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  status: LocalAttachmentStatus;
  error?: string;
};

export type AttachmentUploadUpdate = Partial<
  Pick<
    LocalChatAttachment,
    "attachmentId" | "kind" | "sha256" | "status" | "error"
  >
>;

type UploadChatAttachmentOptions = {
  conversationId?: string;
  signal: AbortSignal;
  onUpdate: (update: AttachmentUploadUpdate) => void;
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
};

export function validateChatAttachmentFile(
  file: File
):
  | { ok: true; mimeType: string; kind: AttachmentKind }
  | { ok: false; message: string } {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType =
    MIME_BY_EXTENSION[extension as keyof typeof MIME_BY_EXTENSION];
  if (!mimeType) {
    return {
      ok: false,
      message: "仅支持 PDF、DOCX、XLSX、CSV、TXT、MD、JPG 和 PNG。"
    };
  }
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    return { ok: false, message: "单个附件不能超过 25 MiB。" };
  }
  return {
    ok: true,
    mimeType,
    kind: mimeType.startsWith("image/") ? "image" : "document"
  };
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function uploadChatAttachment(
  file: File,
  options: UploadChatAttachmentOptions
): Promise<AttachmentPart> {
  const fetcher = options.fetcher ?? fetch;
  const validation = validateChatAttachmentFile(file);
  if (!validation.ok) throw new Error(validation.message);

  assertNotAborted(options.signal);
  options.onUpdate({ status: "hashing" });
  const sha256 = await sha256Hex(file);
  assertNotAborted(options.signal);
  options.onUpdate({ sha256, status: "initiated" });

  const initiated = await fetcher("/api/chat/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : {}),
      filename: file.name,
      contentType: validation.mimeType,
      sizeBytes: file.size,
      sha256
    }),
    signal: options.signal
  });
  if (!initiated.ok) {
    throw new Error(await responseError(initiated, "附件登记失败，请重试。"));
  }

  const initiatedPayload = (await initiated.json()) as unknown;
  const initiation = parseInitiation(initiatedPayload, file, validation);
  options.onUpdate({
    attachmentId: initiation.attachment.attachmentId,
    kind: initiation.attachment.kind,
    status: "uploading"
  });

  const uploaded = await fetcher(initiation.uploadUrl, {
    method: "PUT",
    headers: initiation.requiredHeaders,
    body: file,
    signal: options.signal
  });
  if (!uploaded.ok) throw new Error("附件直传失败，请重试。");

  options.onUpdate({ status: "scanning" });
  const completed = await fetcher(
    `/api/chat/attachments/${encodeURIComponent(initiation.attachment.attachmentId)}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256 }),
      signal: options.signal
    }
  );
  if (!completed.ok) {
    throw new Error(
      await responseError(completed, "附件校验或处理任务启动失败，请重试。")
    );
  }

  const completedPart = parseAttachmentEnvelope(
    await completed.json().catch(() => null)
  );
  if (completedPart) {
    options.onUpdate({ status: completedPart.status });
    if (isTerminal(completedPart.status)) return completedPart;
  }

  return pollUntilTerminal(initiation.attachment, options, fetcher);
}

export async function cancelChatAttachment(
  attachmentId: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  await fetcher(`/api/chat/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE"
  }).catch(() => undefined);
}

async function pollUntilTerminal(
  initial: AttachmentPart,
  options: UploadChatAttachmentOptions,
  fetcher: typeof fetch
): Promise<AttachmentPart> {
  const maxPolls = options.maxPolls ?? 240;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  let latest = initial;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    assertNotAborted(options.signal);
    await abortableDelay(pollIntervalMs, options.signal);
    const response = await fetcher(
      `/api/chat/attachments/${encodeURIComponent(initial.attachmentId)}`,
      { cache: "no-store", signal: options.signal }
    );
    if (!response.ok) {
      throw new Error(await responseError(response, "无法获取附件处理状态。"));
    }
    const part = parseAttachmentEnvelope(await response.json());
    if (!part) throw new Error("附件状态响应不完整，请重试。");
    latest = part;
    options.onUpdate({ status: latest.status });
    if (isTerminal(latest.status)) return latest;
  }
  throw new Error("附件处理超时，请移除后重试。");
}

function parseInitiation(
  payload: unknown,
  file: File,
  validation: { mimeType: string; kind: AttachmentKind }
): {
  attachment: AttachmentPart;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
} {
  const data = recordValue(payload)?.data;
  const record = recordValue(data);
  const upload = recordValue(record?.upload);
  const uploadUrl = stringValue(upload?.url) ?? stringValue(upload?.uploadUrl);
  const method = stringValue(upload?.method);
  const requiredHeaders = stringRecordValue(upload?.requiredHeaders);
  const attachment =
    parseAttachment(record?.attachment) ??
    parseAttachment({
      type: "attachment",
      attachmentId: record?.attachmentId,
      kind: validation.kind,
      filename: file.name,
      mimeType: validation.mimeType,
      sizeBytes: file.size,
      status: "initiated"
    });
  if (
    !attachment ||
    !uploadUrl ||
    !safeUploadUrl(uploadUrl) ||
    method !== "PUT" ||
    !requiredHeaders
  ) {
    throw new Error("附件登记响应不完整，请重新发起上传。");
  }
  return { attachment, uploadUrl, requiredHeaders };
}

function parseAttachmentEnvelope(payload: unknown): AttachmentPart | undefined {
  const root = recordValue(payload);
  const data = recordValue(root?.data);
  return parseAttachment(data?.attachment ?? data ?? root?.attachment ?? root);
}

function parseAttachment(value: unknown): AttachmentPart | undefined {
  const record = recordValue(value);
  const attachmentId = stringValue(record?.attachmentId);
  const filename = stringValue(record?.filename);
  const mimeType = stringValue(record?.mimeType);
  const sizeBytes = record?.sizeBytes;
  const kind = record?.kind;
  const status = record?.status;
  if (
    record?.type !== "attachment" ||
    !attachmentId ||
    !UUID_PATTERN.test(attachmentId) ||
    !filename ||
    !mimeType ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    (kind !== "document" && kind !== "image") ||
    !isAttachmentStatus(status)
  ) {
    return undefined;
  }
  return {
    type: "attachment",
    attachmentId,
    filename,
    mimeType,
    sizeBytes,
    kind,
    status
  };
}

function isAttachmentStatus(value: unknown): value is AttachmentStatus {
  return (
    value === "initiated" ||
    value === "uploading" ||
    value === "scanning" ||
    value === "processing" ||
    value === "ready" ||
    value === "failed" ||
    value === "deleted"
  );
}

function isTerminal(status: AttachmentStatus) {
  return status === "ready" || status === "failed" || status === "deleted";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  return entries.every((entry): entry is [string, string] =>
    entry.every((item) => typeof item === "string")
  )
    ? Object.fromEntries(entries)
    : undefined;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeUploadUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function responseError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  return typeof payload?.error?.message === "string"
    ? payload.error.message
    : fallback;
}
