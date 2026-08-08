"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";

export function InvitationAcceptance({
  token,
  email
}: {
  token: string;
  email: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError("");

    try {
      const response = await fetch(
        `/api/admin/invitations/accept?token=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? "邀请已失效或与当前账号不匹配。"
        );
      }
      router.replace("/admin");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "暂时无法接受邀请，请稍后重试。"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-semibold text-[var(--accent)]">
        OpenVac 运营后台
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.045em]">
        接受后台角色邀请
      </h1>
      <p className="mt-4 text-sm leading-7 text-[var(--muted)]">
        当前登录账号为 <strong className="text-[var(--ink)]">{email}</strong>
        。确认后，系统会校验邀请邮箱、有效期和现有角色；已有角色不会被覆盖。
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={accept}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : null}
          {busy ? "正在校验" : "确认接受邀请"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => router.push("/")}
          className="min-h-11 rounded-lg border border-[var(--border-strong)] px-5 text-sm font-medium disabled:opacity-60"
        >
          暂不接受
        </button>
      </div>
    </div>
  );
}
