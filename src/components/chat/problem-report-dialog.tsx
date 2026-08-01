"use client";

import { FormEvent, useState } from "react";
import { LoaderCircle, X } from "lucide-react";

const categories = [
  ["answer_incorrect", "回答内容不正确"],
  ["citation_problem", "引用或来源有问题"],
  ["unsafe_answer", "回答可能不安全"],
  ["system_error", "系统错误或无法使用"],
  ["product_suggestion", "产品建议"],
  ["other", "其他"]
] as const;

export function ProblemReportDialog({
  open,
  conversationId,
  messageId,
  description,
  onClose
}: {
  open: boolean;
  conversationId?: string;
  messageId?: string;
  description: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<{
    reportId: string;
    receivedAt: string;
  }>();
  const [error, setError] = useState("");

  if (!open) return null;

  function close() {
    setBusy(false);
    setSubmitted(undefined);
    setError("");
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const contactType = String(form.get("contactType") ?? "").trim();
    const contactValue = String(form.get("contactValue") ?? "").trim();
    const response = await fetch("/api/problem-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        messageId,
        category: form.get("category"),
        description: form.get("description"),
        includeContext: form.get("includeContext") === "on",
        contactType: contactType || undefined,
        contactValue: contactValue || undefined,
        consentToContact: form.get("consentToContact") === "on"
      })
    });
    setBusy(false);
    if (response.ok) {
      const payload = (await response.json()) as {
        reportId?: string;
        receivedAt?: string;
      };
      if (payload.reportId && payload.receivedAt) {
        setSubmitted({
          reportId: payload.reportId,
          receivedAt: payload.receivedAt
        });
      } else {
        setError("反馈已保存，但回执信息读取失败。请勿重复提交。");
      }
    } else {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(payload.error?.message ?? "问题反馈提交失败，请稍后再试。");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="problem-report-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-5">
          <div>
            <h2 id="problem-report-title" className="text-xl font-semibold">
              提交问题反馈
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              用于报告回答、引用或产品问题；不提供实时或紧急支持，也不承诺回复或处理时限。
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-[var(--surface)]"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {submitted ? (
          <div className="mt-8 rounded-xl bg-[var(--accent-soft)] p-5 text-sm leading-7 text-[#0b5d57]">
            <p>问题反馈已提交。</p>
            <dl className="mt-3 grid grid-cols-[76px_1fr] gap-y-1">
              <dt>反馈编号</dt>
              <dd className="break-all">{submitted.reportId}</dd>
              <dt>接收时间</dt>
              <dd>
                {new Date(submitted.receivedAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  hour12: false
                })}
              </dd>
            </dl>
            <p className="mt-3">
              提交不代表 OpenVac
              承诺回复；如你自愿提供联系方式，我们仅可能在需要澄清时联系。此入口不提供紧急支持。
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-7 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">问题类型</span>
              <select
                name="category"
                defaultValue="answer_incorrect"
                className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
              >
                {categories.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">问题描述</span>
              <textarea
                name="description"
                required
                maxLength={3000}
                defaultValue={description}
                className="min-h-32 w-full rounded-lg border border-[var(--border)] px-3 py-2"
                placeholder="请说明哪里有问题，以及你期望看到什么。"
              />
            </label>
            {(conversationId || messageId) && (
              <label className="flex items-start gap-3 rounded-lg bg-[var(--surface)] p-4 text-sm leading-6">
                <input type="checkbox" name="includeContext" className="mt-1" />
                <span>
                  附带当前对话的必要上下文（最多最近 8
                  条消息）。默认不附带，勾选后才会由服务端生成快照。
                </span>
              </label>
            )}
            <fieldset className="space-y-3 rounded-lg border border-[var(--border)] p-4">
              <legend className="px-1 text-sm font-medium">
                联系方式（可选）
              </legend>
              <p className="text-xs leading-5 text-[var(--muted)]">
                不会自动填入注册邮箱。仅在可能需要进一步澄清时使用。
              </p>
              <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3">
                <label>
                  <span className="mb-2 block text-sm">联系类型</span>
                  <select
                    name="contactType"
                    defaultValue=""
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  >
                    <option value="">不提供</option>
                    <option value="email">邮箱</option>
                    <option value="phone">电话</option>
                    <option value="wechat">微信</option>
                  </select>
                </label>
                <label>
                  <span className="mb-2 block text-sm">联系方式</span>
                  <input
                    name="contactValue"
                    maxLength={160}
                    autoComplete="off"
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  />
                </label>
              </div>
              <label className="flex items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  name="consentToContact"
                  className="mt-1"
                />
                <span>
                  如果我填写了联系方式，我明确同意 OpenVac
                  可能为澄清本条反馈而联系我。
                </span>
              </label>
            </fieldset>
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
              提交问题反馈
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
