"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { resolveSafeReturnTo } from "@/lib/safe-return-to";
import { useHydrated } from "@/lib/use-hydrated";

export function TwoFactorChallenge() {
  const router = useRouter();
  const ready = useHydrated();
  const [method, setMethod] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response =
        method === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code: code.replace(/\s+/gu, ""),
              trustDevice
            })
          : await authClient.twoFactor.verifyBackupCode({
              code: code.trim(),
              trustDevice
            });
      if (response.error) throw response.error;
      const returnTo = resolveSafeReturnTo(
        window.sessionStorage.getItem("openvac:two-factor:return-to")
      );
      window.sessionStorage.removeItem("openvac:two-factor:return-to");
      router.replace(returnTo);
      router.refresh();
    } catch {
      setError("验证码无效、已使用或挑战已过期，请重试或重新登录。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex rounded-lg bg-[var(--surface)] p-1 text-sm">
        <button
          type="button"
          onClick={() => {
            setMethod("totp");
            setCode("");
          }}
          className={`min-h-10 flex-1 rounded-md ${method === "totp" ? "bg-white shadow-sm" : "text-[var(--muted)]"}`}
        >
          动态验证码
        </button>
        <button
          type="button"
          onClick={() => {
            setMethod("backup");
            setCode("");
          }}
          className={`min-h-10 flex-1 rounded-md ${method === "backup" ? "bg-white shadow-sm" : "text-[var(--muted)]"}`}
        >
          备用码
        </button>
      </div>

      <label className="block">
        <span className="mb-2 block text-sm font-medium">
          {method === "totp" ? "6 位动态验证码" : "一次性备用码"}
        </span>
        <input
          autoFocus
          required
          disabled={!ready || busy}
          inputMode={method === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          minLength={method === "totp" ? 6 : 4}
          maxLength={32}
          className="h-12 w-full rounded-lg border border-[var(--border-strong)] px-4 font-mono tracking-[0.18em] outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label className="flex items-start gap-3 text-sm text-[var(--muted)]">
        <input
          type="checkbox"
          checked={trustDevice}
          onChange={(event) => setTrustDevice(event.target.checked)}
          className="mt-1"
        />
        信任这台设备 30 天。仅在私人设备上启用。
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!ready || busy || !code.trim()}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--ink)] font-medium text-white disabled:opacity-50"
      >
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        验证并继续
      </button>
      <Link
        href="/sign-in"
        className="block text-center text-sm text-[var(--muted)] underline underline-offset-4"
      >
        返回登录
      </Link>
    </form>
  );
}
