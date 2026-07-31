"use client";

import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { savePendingQuestionDraft } from "@/lib/pending-question-draft";
import { useHydrated } from "@/lib/use-hydrated";

const examples = [
  "如何选择旋片泵？",
  "抽速不够怎么排查？",
  "极限压力是什么？",
  "这个型号配什么油？"
];

export function HomePrompt() {
  const ready = useHydrated();
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const router = useRouter();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = question.trim();
    if (!value || submitting) return;

    setSubmitting(true);
    setDraftError("");
    if (!savePendingQuestionDraft({ text: value })) {
      setDraftError("浏览器无法暂存这个问题，请刷新后重试。");
      setSubmitting(false);
      return;
    }

    try {
      const { data } = await authClient.getSession();
      router.push(data?.session ? "/chat" : "/sign-in?returnTo=%2Fchat");
    } catch {
      router.push("/sign-in?returnTo=%2Fchat");
    }
  }

  return (
    <div>
      <form
        onSubmit={submit}
        className="flex min-h-[116px] items-center gap-3 rounded-[14px] border border-[var(--border-strong)] bg-white px-5 transition-shadow focus-within:border-[var(--ink)] focus-within:shadow-[0_0_0_3px_rgba(15,124,117,0.1)] sm:px-7"
      >
        <label htmlFor="home-question" className="visually-hidden">
          向 OpenVac 提问
        </label>
        <textarea
          id="home-question"
          rows={2}
          maxLength={4000}
          disabled={!ready}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="输入你的工况、型号、故障现象或技术问题……"
          className="min-h-16 flex-1 resize-none border-0 bg-transparent py-5 text-base leading-7 text-[var(--ink)] outline-none placeholder:text-[#8a9094] sm:text-lg"
        />
        <button
          type="submit"
          disabled={!ready || !question.trim() || submitting}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-white transition-transform hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="发送问题"
        >
          {submitting ? (
            <LoaderCircle className="h-5 w-5 animate-spin" />
          ) : (
            <ArrowUpRight className="h-5 w-5" />
          )}
        </button>
      </form>

      {draftError && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] px-4 py-3 text-sm text-[var(--danger)]"
        >
          {draftError}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            disabled={!ready}
            onClick={() => setQuestion(example)}
            className="min-h-12 rounded-lg border border-[var(--border)] px-4 text-left text-sm transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface)] sm:text-center"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
