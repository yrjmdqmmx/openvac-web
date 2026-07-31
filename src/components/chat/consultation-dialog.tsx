"use client";

import { FormEvent, useState } from "react";
import { LoaderCircle, X } from "lucide-react";

export function ConsultationDialog({
  open,
  conversationId,
  problem,
  conversationSummary,
  onClose
}: {
  open: boolean;
  conversationId?: string;
  problem: string;
  conversationSummary: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/consultations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        contactName: form.get("contactName"),
        companyName: form.get("companyName"),
        contactMethod: form.get("contactMethod"),
        contactValue: form.get("contactValue"),
        problem: form.get("problem"),
        conversationSummary: form.get("conversationSummary"),
        confirmed: form.get("confirmed") === "on"
      })
    });
    setBusy(false);
    if (response.ok) {
      setDone(true);
    } else {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(payload.error?.message ?? "咨询单提交失败，请稍后再试。");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consult-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-5">
          <div>
            <h2 id="consult-title" className="text-xl font-semibold">
              提交人工咨询
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              只有在你确认后，OpenVac 才会把联系方式和本次问题摘要交给支持人员。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-[var(--surface)]"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="mt-8 rounded-xl bg-[var(--accent-soft)] p-5 text-sm leading-7 text-[#0b5d57]">
            咨询单已提交。支持人员会通过你提供的方式联系；请勿在后续对话中重复发送敏感信息。
          </div>
        ) : (
          <form onSubmit={submit} className="mt-7 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">联系人</span>
              <input
                name="contactName"
                required
                maxLength={80}
                className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">公司</span>
              <input
                name="companyName"
                required
                maxLength={160}
                className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
              />
            </label>
            <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3">
              <label>
                <span className="mb-2 block text-sm font-medium">联系类型</span>
                <select
                  name="contactMethod"
                  className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                >
                  <option value="phone">电话</option>
                  <option value="wechat">微信</option>
                  <option value="email">邮箱</option>
                </select>
              </label>
              <label>
                <span className="mb-2 block text-sm font-medium">联系方式</span>
                <input
                  name="contactValue"
                  required
                  maxLength={160}
                  className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">咨询问题</span>
              <textarea
                name="problem"
                required
                minLength={10}
                maxLength={5000}
                defaultValue={problem}
                className="min-h-24 w-full rounded-lg border border-[var(--border)] px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">对话摘要</span>
              <textarea
                name="conversationSummary"
                required
                minLength={10}
                maxLength={8000}
                defaultValue={conversationSummary}
                className="min-h-28 w-full rounded-lg border border-[var(--border)] px-3 py-2"
              />
              <span className="mt-1 block text-xs leading-5 text-[var(--muted)]">
                提交前可以删改；只会发送你在此处确认的内容。
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-lg bg-[var(--surface)] p-4 text-sm leading-6">
              <input
                type="checkbox"
                name="confirmed"
                required
                className="mt-1"
              />
              <span>
                我确认提交以上联系方式、当前问题及对话摘要，并同意 OpenVac
                支持人员为处理本咨询与我联系。
              </span>
            </label>
            {error && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--ink)] text-sm font-medium text-white disabled:opacity-50"
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              确认提交
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
