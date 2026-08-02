"use client";

import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { savePendingQuestionIntent } from "@/lib/pending-question-draft";
import { useHydrated } from "@/lib/use-hydrated";

const examples = [
  "如何选择旋片泵？",
  "抽速不够怎么排查？",
  "极限压力是什么？",
  "这个型号配什么油？"
];

export function HomePrompt({ currentUserId }: { currentUserId?: string }) {
  const ready = useHydrated();
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const router = useRouter();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = question.trim();
    if (submitting) return;
    if (Array.from(value).length < 2) {
      setDraftError("请至少输入 2 个字符，以便 OpenVac 理解你的问题。");
      return;
    }

    setSubmitting(true);
    setDraftError("");
    if (
      !savePendingQuestionIntent({
        text: value,
        ownerUserId: currentUserId
      })
    ) {
      setDraftError("浏览器无法暂存这个问题，请刷新后重试。");
      setSubmitting(false);
      return;
    }

    router.push(currentUserId ? "/chat" : "/sign-in?returnTo=%2Fchat");
  }

  return (
    <div>
      <form
        onSubmit={submit}
        className="flex min-h-[138px] items-center gap-3 rounded-[14px] border border-[var(--border-strong)] bg-white px-5 transition-[border-color,box-shadow] focus-within:border-[var(--ink)] focus-within:shadow-[0_0_0_3px_rgba(17,19,21,0.08)] sm:px-7"
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
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="输入你的工况、型号、故障现象或技术问题……"
          className="composer-textarea min-h-16 flex-1 resize-none border-0 bg-transparent py-5 text-base leading-7 text-[var(--ink)] outline-none placeholder:text-[#8a9094] sm:text-lg"
        />
        <button
          type="submit"
          disabled={
            !ready || Array.from(question.trim()).length < 2 || submitting
          }
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[var(--ink)] text-white transition-colors hover:bg-[#292b2d] disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="发送问题"
        >
          {submitting ? (
            <LoaderCircle className="h-5 w-5 animate-spin" />
          ) : (
            <ArrowUpRight className="h-5 w-5" />
          )}
        </button>
      </form>

      {draftError ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] px-4 py-3 text-sm text-[var(--danger)]"
        >
          {draftError}
        </p>
      ) : null}

      <div className="mx-auto mt-9 grid max-w-[808px] grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            disabled={!ready}
            onClick={() => setQuestion(example)}
            className="min-h-12 rounded-xl border border-[var(--border)] px-4 text-left text-sm transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface)] sm:text-center"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
