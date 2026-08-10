import { MAX_CHAT_ATTACHMENT_BYTES } from "@/server/chat-v3/contracts";
import type { ParsedDocument, ParsedDocumentPage } from "@/server/providers";

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_ITEMS = 200_000;
const DEFAULT_MIN_TEXT_CHARACTERS = 16;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface LocalPdfTextOptions {
  maxInputBytes?: number;
  maxPages?: number;
  maxTextBytes?: number;
  maxTextItems?: number;
  minTextCharacters?: number;
  timeoutMs?: number;
}

/**
 * Extracts an existing PDF text layer without rendering pages or evaluating
 * embedded PDF JavaScript. Invalid, encrypted, scanned, oversized, or slow
 * documents return null so the caller can use its bounded OCR fallback.
 */
export async function extractLocalPdfText(
  bytes: Uint8Array,
  options: LocalPdfTextOptions = {}
): Promise<ParsedDocument | null> {
  const maxInputBytes = positiveInteger(
    options.maxInputBytes ?? MAX_CHAT_ATTACHMENT_BYTES,
    "maxInputBytes"
  );
  const maxPages = positiveInteger(
    options.maxPages ?? DEFAULT_MAX_PAGES,
    "maxPages"
  );
  const maxTextBytes = positiveInteger(
    options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
    "maxTextBytes"
  );
  const maxTextItems = positiveInteger(
    options.maxTextItems ?? DEFAULT_MAX_TEXT_ITEMS,
    "maxTextItems"
  );
  const minTextCharacters = positiveInteger(
    options.minTextCharacters ?? DEFAULT_MIN_TEXT_CHARACTERS,
    "minTextCharacters"
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs"
  );

  if (
    bytes.byteLength < 5 ||
    bytes.byteLength > maxInputBytes ||
    new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-"
  ) {
    return null;
  }

  const deadline = createDeadline(timeoutMs);
  let destroy: (() => Promise<void>) | undefined;
  try {
    const pdfjs = await deadline.run(import("pdfjs-dist/legacy/build/pdf.mjs"));
    const loadingTask = pdfjs.getDocument({
      // Copy the immutable object bytes so PDF.js cannot detach the caller's
      // buffer if its implementation changes to use a worker transfer.
      data: Uint8Array.from(bytes),
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS
    });
    destroy = async () => loadingTask.destroy();
    const document = await deadline.run(loadingTask.promise);
    if (document.numPages < 1 || document.numPages > maxPages) return null;

    const pages: ParsedDocumentPage[] = [];
    let textBytes = 0;
    let textItems = 0;
    let meaningfulCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await deadline.run(document.getPage(pageNumber));
      try {
        const content = await deadline.run(page.getTextContent());
        const pageText = textContentToMarkdown(content.items);
        textItems += content.items.length;
        if (textItems > maxTextItems) return null;
        if (!pageText) continue;

        textBytes += Buffer.byteLength(pageText, "utf8");
        if (textBytes > maxTextBytes) return null;
        meaningfulCharacters += pageText.replace(/\s/gu, "").length;
        pages.push({ pageNumber, markdown: pageText });
      } finally {
        page.cleanup();
      }
    }

    if (meaningfulCharacters < minTextCharacters || pages.length === 0) {
      return null;
    }
    return { jobId: "local-pdf-text", pages };
  } catch {
    return null;
  } finally {
    deadline.dispose();
    if (destroy) await settleWithin(destroy(), 5_000);
  }
}

function textContentToMarkdown(items: readonly unknown[]): string {
  let text = "";
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as { str?: unknown; hasEOL?: unknown };
    if (typeof record.str !== "string" || !record.str) continue;
    text += record.str;
    text += record.hasEOL === true ? "\n" : " ";
  }
  return text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function createDeadline(timeoutMs: number): {
  run<T>(operation: Promise<T>): Promise<T>;
  dispose(): void;
} {
  const timeoutError = new Error("Local PDF text extraction timed out.");
  let rejectTimeout: ((reason: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => rejectTimeout?.(timeoutError), timeoutMs);
  timer.unref?.();
  return {
    run: async <T>(operation: Promise<T>) => Promise.race([operation, timeout]),
    dispose: () => clearTimeout(timer)
  };
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([operation.catch(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}
