"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { AttachmentPart } from "@/types/chat-v3";

export function AttachmentPreview({
  attachment,
  onClose
}: {
  attachment: AttachmentPart;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), iframe, [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const previewPath = `/api/chat/attachments/${encodeURIComponent(attachment.attachmentId)}/preview`;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${attachment.filename} 预览`}
      className="fixed inset-0 z-50 grid bg-black/35 p-3 sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="m-auto flex h-full max-h-[900px] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {attachment.filename}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭附件预览"
            className="grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--surface)]"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>
        <iframe
          title={`${attachment.filename} 私有预览`}
          src={previewPath}
          className="min-h-0 flex-1 bg-[var(--surface)]"
          sandbox="allow-same-origin"
        />
      </section>
    </div>
  );
}
