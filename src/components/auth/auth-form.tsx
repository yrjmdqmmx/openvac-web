"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { resolveSafeReturnTo } from "@/lib/safe-return-to";
import { useHydrated } from "@/lib/use-hydrated";

type Mode = "sign-in" | "sign-up" | "forgot" | "reset";

function friendlyError(error: unknown) {
  const message =
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";

  if (/verify|verification|email.*not/i.test(message)) {
    return "请先完成邮箱验证。验证邮件可在登录页重新发送。";
  }
  if (/password|credential|invalid/i.test(message)) {
    return "邮箱或密码不正确，请重试。";
  }
  if (/rate|too many|429/i.test(message)) {
    return "操作过于频繁，请稍后再试。";
  }
  return "暂时无法完成操作，请稍后重试。";
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ready = useHydrated();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const returnTo = resolveSafeReturnTo(searchParams.get("returnTo"));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");

    try {
      if (mode === "sign-in") {
        const response = await authClient.signIn.email({
          email,
          password,
          rememberMe: true,
          callbackURL: returnTo
        });
        if (response.error) throw response.error;
        router.push(returnTo);
        router.refresh();
        return;
      }

      if (mode === "sign-up") {
        if (password !== confirmPassword) {
          setError("两次输入的密码不一致。");
          return;
        }
        const nickname = `工程用户-${crypto.randomUUID().slice(0, 6)}`;
        const response = await authClient.signUp.email({
          name: nickname,
          email,
          password,
          callbackURL: returnTo
        });
        if (response.error) throw response.error;
        setNotice(
          "验证邮件已发送。如果邮箱已注册，也会看到同样提示。请检查收件箱后继续。"
        );
        return;
      }

      if (mode === "forgot") {
        const response = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}/reset-password`
        });
        if (response.error) throw response.error;
        setNotice(
          "如果该邮箱存在，我们已发送密码重置邮件。请在一小时内完成操作。"
        );
        return;
      }

      const token = searchParams.get("token");
      if (!token) {
        setError("重置链接缺少有效令牌，请重新申请。");
        return;
      }
      if (password !== confirmPassword) {
        setError("两次输入的密码不一致。");
        return;
      }
      const response = await authClient.resetPassword({
        newPassword: password,
        token
      });
      if (response.error) throw response.error;
      setNotice("密码已更新，所有旧会话均已撤销。正在返回登录页……");
      window.setTimeout(() => router.push("/sign-in"), 900);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  const needsPassword = mode !== "forgot";
  const needsConfirmation = mode === "sign-up" || mode === "reset";
  const submitLabel = {
    "sign-in": "登录",
    "sign-up": "创建账户",
    forgot: "发送重置邮件",
    reset: "更新密码"
  }[mode];

  return (
    <form onSubmit={submit} className="space-y-5">
      {(mode === "sign-in" || mode === "sign-up" || mode === "forgot") && (
        <label className="block">
          <span className="mb-2 block text-sm font-medium">邮箱</span>
          <input
            type="email"
            autoComplete="email"
            required
            disabled={!ready}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.com"
            className="h-12 w-full rounded-lg border border-[var(--border-strong)] px-4 transition-shadow outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(15,124,117,0.1)]"
          />
        </label>
      )}

      {needsPassword && (
        <label className="block">
          <span className="mb-2 block text-sm font-medium">
            {mode === "reset" ? "新密码" : "密码"}
          </span>
          <input
            type="password"
            autoComplete={
              mode === "sign-in" ? "current-password" : "new-password"
            }
            required
            disabled={!ready}
            minLength={10}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-12 w-full rounded-lg border border-[var(--border-strong)] px-4 transition-shadow outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(15,124,117,0.1)]"
          />
          {mode !== "sign-in" && (
            <span className="mt-2 block text-xs text-[var(--muted)]">
              至少 10 个字符，建议包含字母、数字和符号。
            </span>
          )}
        </label>
      )}

      {needsConfirmation && (
        <label className="block">
          <span className="mb-2 block text-sm font-medium">确认密码</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            disabled={!ready}
            minLength={10}
            maxLength={128}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="h-12 w-full rounded-lg border border-[var(--border-strong)] px-4 transition-shadow outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(15,124,117,0.1)]"
          />
        </label>
      )}

      {mode === "sign-in" && (
        <div className="flex items-center justify-between text-sm">
          <Link
            href="/forgot-password"
            className="text-[var(--muted)] underline decoration-[var(--border-strong)] underline-offset-4"
          >
            忘记密码
          </Link>
          <button
            type="button"
            disabled={!ready || busy}
            className="text-[var(--accent)]"
            onClick={async () => {
              if (!email) {
                setError("请先填写邮箱，再补发验证邮件。");
                return;
              }
              setBusy(true);
              setError("");
              const response = await authClient.sendVerificationEmail({
                email,
                callbackURL: returnTo
              });
              setBusy(false);
              if (response.error) {
                setError(friendlyError(response.error));
              } else {
                setNotice("验证邮件已发送，请检查收件箱。");
              }
            }}
          >
            补发验证邮件
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[#e2b8b3] bg-[#fff7f6] px-4 py-3 text-sm text-[var(--danger)]"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-[#add5d1] bg-[var(--accent-soft)] px-4 py-3 text-sm leading-6 text-[#0b5d57]"
        >
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={!ready || busy}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-4 font-medium text-white transition-opacity disabled:opacity-50"
      >
        {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
        {submitLabel}
      </button>

      <p className="text-center text-sm text-[var(--muted)]">
        {mode === "sign-in" && (
          <>
            还没有账户？{" "}
            <Link href="/sign-up" className="text-[var(--ink)] underline">
              免费注册
            </Link>
          </>
        )}
        {mode === "sign-up" && (
          <>
            已有账户？{" "}
            <Link href="/sign-in" className="text-[var(--ink)] underline">
              返回登录
            </Link>
          </>
        )}
        {(mode === "forgot" || mode === "reset") && (
          <Link href="/sign-in" className="text-[var(--ink)] underline">
            返回登录
          </Link>
        )}
      </p>
    </form>
  );
}
