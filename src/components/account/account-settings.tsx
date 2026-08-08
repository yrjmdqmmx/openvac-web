"use client";

import {
  Camera,
  Copy,
  Database,
  Download,
  KeyRound,
  LoaderCircle,
  BrainCircuit,
  MonitorSmartphone,
  ShieldAlert,
  Trash2,
  UserRound
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { safeAccountAvatarUrl } from "@/lib/account-avatar";
import { authClient } from "@/lib/auth-client";
import {
  deleteAccountSession,
  parseAccountSessionSummaries,
  SessionManagementUnavailableError,
  type AccountSessionSummary
} from "@/lib/account-session-client";

export type AccountSettingsSection = "account" | "sessions" | "memory" | "data";

type SavedMemory = {
  id: string;
  kind: "equipment" | "operating_context" | "unit_preference";
  label: string;
  facts: Record<string, unknown>;
  status: "active" | "disabled";
};

function totpSecret(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") || uri;
  } catch {
    return uri;
  }
}

export function AccountSettingsContent({
  email,
  userName = "OpenVac 用户",
  image = null,
  twoFactorEnabled = false,
  section = "all",
  onConversationDataCleared
}: {
  email: string;
  userName?: string;
  image?: string | null;
  twoFactorEnabled?: boolean;
  section?: AccountSettingsSection | "all";
  onConversationDataCleared?: () => void;
}) {
  const [sessions, setSessions] = useState<AccountSessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState("");
  const [profileName, setProfileName] = useState(userName);
  const [avatarUrl, setAvatarUrl] = useState(safeAccountAvatarUrl(image));
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [twoFactorActive, setTwoFactorActive] = useState(twoFactorEnabled);
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [twoFactorEnrollment, setTwoFactorEnrollment] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [memories, setMemories] = useState<SavedMemory[]>([]);

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/account/sessions", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("sessions unavailable");
      const payload = (await response.json()) as { data?: unknown };
      setSessions(parseAccountSessionSummaries(payload.data));
      setSessionsError("");
    } catch {
      setSessionsError("无法读取登录设备，请稍后重试。");
    }
  }, []);

  const loadMemories = useCallback(async () => {
    try {
      const response = await fetch("/api/account/memories", {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("memories unavailable");
      const payload = (await response.json()) as {
        data?: { memories?: SavedMemory[] };
      };
      setMemories(payload.data?.memories ?? []);
    } catch {
      setMemories([]);
    }
  }, []);

  useEffect(() => {
    if (section !== "all" && section !== "account") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/account/profile", {
        cache: "no-store",
        signal: controller.signal
      })
        .then(async (response) => {
          if (!response.ok) return;
          const payload = (await response.json()) as {
            data?: {
              name?: string;
              image?: string | null;
              avatarRevision?: number;
              twoFactorEnabled?: boolean;
            };
          };
          if (typeof payload.data?.name === "string")
            setProfileName(payload.data.name);
          if (payload.data && "image" in payload.data) {
            const stableAvatarUrl = safeAccountAvatarUrl(payload.data.image);
            setAvatarUrl(
              stableAvatarUrl
                ? `${stableAvatarUrl}?revision=${payload.data.avatarRevision ?? 0}`
                : null
            );
          }
          if (typeof payload.data?.twoFactorEnabled === "boolean")
            setTwoFactorActive(payload.data.twoFactorEnabled);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [section]);

  useEffect(() => {
    if (section !== "all" && section !== "sessions") return;
    const timer = window.setTimeout(() => void loadSessions(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSessions, section]);

  useEffect(() => {
    if (section !== "all" && section !== "memory") return;
    const timer = window.setTimeout(() => void loadMemories(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMemories, section]);

  async function run(name: string, action: () => Promise<void | string>) {
    setBusy(name);
    setNotice("");
    setError("");
    try {
      const successMessage = await action();
      setNotice(successMessage || "操作已完成。");
      await loadSessions();
    } catch (caught) {
      setError(
        caught instanceof SessionManagementUnavailableError
          ? "单设备撤销功能正在接入，请先使用“撤销其他设备”。"
          : "操作失败，请重新登录后再试。"
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      {(notice || error) && (
        <p
          role={error ? "alert" : "status"}
          className={`mb-6 rounded-lg border p-4 text-sm ${
            error
              ? "border-[#e2b8b3] bg-[#fff7f6] text-[var(--danger)]"
              : "border-[#add5d1] bg-[var(--accent-soft)] text-[#0b5d57]"
          }`}
        >
          {error || notice}
        </p>
      )}

      {section === "all" || section === "account" ? (
        <section id="profile">
          <div className="flex items-center gap-3">
            <UserRound className="h-5 w-5 text-[var(--muted)]" />
            <h2 className="text-xl font-semibold">账户</h2>
          </div>
          <div className="mt-3 text-sm">
            <p className="font-medium">{profileName}</p>
            <p className="mt-1 text-[var(--muted)]">{email}</p>
          </div>
          <div className="mt-5 space-y-8 border-y border-[var(--border)] py-6 text-sm">
            <div className="grid gap-4 sm:grid-cols-[88px_1fr] sm:items-center">
              <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-full bg-[var(--surface)] text-2xl font-semibold">
                {avatarUrl ? (
                  // This is the authenticated, stable same-origin avatar endpoint.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt="账户头像"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  (profileName.trim().charAt(0) || "O").toUpperCase()
                )}
              </div>
              <div>
                <label htmlFor="account-avatar" className="block font-medium">
                  头像图片
                </label>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                  支持 JPG、PNG、WebP，最大 5
                  MB。服务端会解码、去除元数据并统一生成 256px WebP。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    id="account-avatar"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) =>
                      setAvatarFile(event.target.files?.[0] ?? null)
                    }
                    className="max-w-full text-xs"
                  />
                  <button
                    type="button"
                    disabled={!avatarFile || Boolean(busy)}
                    onClick={() =>
                      void run("avatar-upload", async () => {
                        if (!avatarFile) return;
                        const form = new FormData();
                        form.set("file", avatarFile);
                        const response = await fetch("/api/account/avatar", {
                          method: "POST",
                          body: form
                        });
                        if (!response.ok)
                          throw new Error("avatar upload failed");
                        const payload = (await response.json()) as {
                          data?: { image?: string; revision?: number };
                        };
                        setAvatarUrl(
                          `${payload.data?.image ?? "/api/account/avatar"}?revision=${payload.data?.revision ?? 0}`
                        );
                        setAvatarFile(null);
                        return "头像已更新。";
                      })
                    }
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-xs disabled:opacity-40"
                  >
                    <Camera className="h-4 w-4" /> 上传头像
                  </button>
                  {avatarUrl ? (
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run("avatar-delete", async () => {
                          const response = await fetch("/api/account/avatar", {
                            method: "DELETE"
                          });
                          if (!response.ok)
                            throw new Error("avatar delete failed");
                          setAvatarUrl(null);
                          return "头像已删除，已恢复默认头像。";
                        })
                      }
                      className="h-10 rounded-lg border border-[#d9aaa5] px-3 text-xs text-[var(--danger)] disabled:opacity-40"
                    >
                      删除头像
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const name = profileName.trim();
                if (!name || name.length > 80) {
                  setError("姓名长度需为 1–80 个字符。");
                  return;
                }
                void run("profile-name", async () => {
                  const response = await fetch("/api/account/profile", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name })
                  });
                  if (!response.ok) throw new Error("profile update failed");
                  setProfileName(name);
                  return "姓名已更新。";
                });
              }}
            >
              <label
                htmlFor="account-profile-name"
                className="block font-medium"
              >
                姓名
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  id="account-profile-name"
                  value={profileName}
                  maxLength={80}
                  onChange={(event) => setProfileName(event.target.value)}
                  className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--border)] px-3"
                />
                <button
                  type="submit"
                  disabled={Boolean(busy)}
                  className="h-11 rounded-lg border border-[var(--border)] px-4 disabled:opacity-40"
                >
                  保存姓名
                </button>
              </div>
            </form>

            <form
              className="space-y-3 border-t border-[var(--border)] pt-6"
              onSubmit={(event) => {
                event.preventDefault();
                if (newPassword.length < 10) {
                  setError("新密码至少需要 10 个字符。");
                  return;
                }
                if (newPassword !== confirmPassword) {
                  setError("两次输入的新密码不一致。");
                  return;
                }
                void run("change-password", async () => {
                  const result = await authClient.changePassword({
                    currentPassword,
                    newPassword,
                    revokeOtherSessions: true
                  });
                  if (result.error) throw result.error;
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmPassword("");
                  return "密码已修改，其他设备的会话已撤销。";
                });
              }}
            >
              <h3 className="font-medium">修改密码</h3>
              <p className="text-xs leading-5 text-[var(--muted)]">
                新密码至少 10 个字符。修改成功后将撤销其他设备的会话。
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1">
                  <span className="block text-xs text-[var(--muted)]">
                    当前密码
                  </span>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-[var(--muted)]">
                    新密码
                  </span>
                  <input
                    type="password"
                    minLength={10}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-[var(--muted)]">
                    确认新密码
                  </span>
                  <input
                    type="password"
                    minLength={10}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={
                  Boolean(busy) ||
                  !currentPassword ||
                  !newPassword ||
                  !confirmPassword
                }
                className="h-10 rounded-lg border border-[var(--border)] px-4 disabled:opacity-40"
              >
                修改密码
              </button>
            </form>

            <form
              className="space-y-3 border-t border-[var(--border)] pt-6"
              onSubmit={(event) => {
                event.preventDefault();
                void run("change-email", async () => {
                  const response = await fetch("/api/account/profile/email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      currentPassword: emailPassword,
                      newEmail: newEmail.trim()
                    })
                  });
                  if (!response.ok) throw new Error("email change failed");
                  setEmailPassword("");
                  setNewEmail("");
                  return "确认邮件已发送。请先在旧邮箱确认，再到新邮箱完成验证。";
                });
              }}
            >
              <h3 className="font-medium">更换电子邮件</h3>
              <p className="text-xs leading-5 text-[var(--muted)]">
                当前邮箱：{email}
                。需先通过当前密码验证，再依次确认旧邮箱和新邮箱。
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="block text-xs text-[var(--muted)]">
                    新邮箱
                  </span>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(event) => setNewEmail(event.target.value)}
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-[var(--muted)]">
                    邮箱更换当前密码
                  </span>
                  <input
                    type="password"
                    value={emailPassword}
                    onChange={(event) => setEmailPassword(event.target.value)}
                    className="h-11 w-full rounded-lg border border-[var(--border)] px-3"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={Boolean(busy) || !newEmail.trim() || !emailPassword}
                className="h-10 rounded-lg border border-[var(--border)] px-4 disabled:opacity-40"
              >
                发送邮箱更换确认
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {section === "all" || section === "sessions" ? (
        <section
          id="sessions"
          className={
            section === "all"
              ? "mt-12 border-t border-[var(--border)] pt-8"
              : undefined
          }
        >
          <div className="flex items-center gap-3">
            <MonitorSmartphone className="h-5 w-5 text-[var(--muted)]" />
            <h2 className="text-xl font-semibold">登录与安全</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            查看当前登录设备，并撤销不再使用的会话。
          </p>
          <ul className="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {sessionsError ? (
              <li role="alert" className="py-5 text-sm text-[var(--danger)]">
                {sessionsError}
              </li>
            ) : sessions.length === 0 ? (
              <li className="py-5 text-sm text-[var(--muted)]">
                暂未读取到登录设备。
              </li>
            ) : null}
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {session.userAgent || "未知浏览器"}
                    {session.isCurrent ? (
                      <span className="ml-2 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[#0b5d57]">
                        当前设备
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {session.ipAddress || "IP 未记录"} · 最近活动{" "}
                    {new Date(session.updatedAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false
                    })}{" "}
                    · 到期{" "}
                    {new Date(session.expiresAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void run(`revoke-${session.id}`, async () => {
                      await deleteAccountSession(session.id);
                    })
                  }
                  disabled={Boolean(busy) || session.isCurrent}
                  className="text-left text-sm text-[var(--danger)] disabled:opacity-40"
                >
                  {session.isCurrent
                    ? "当前会话"
                    : busy === `revoke-${session.id}`
                      ? "正在撤销…"
                      : "撤销会话"}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() =>
                void run("other-sessions", async () => {
                  const result = await authClient.revokeOtherSessions();
                  if (result.error) throw result.error;
                })
              }
              className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm"
            >
              撤销其他设备
            </button>
            <button
              type="button"
              onClick={() =>
                void run("all-sessions", async () => {
                  const result = await authClient.revokeSessions();
                  if (result.error) throw result.error;
                  window.location.assign("/sign-in");
                })
              }
              className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm"
            >
              撤销全部会话
            </button>
          </div>

          <section className="mt-8 border-t border-[var(--border)] pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="h-4 w-4 text-[var(--muted)]" />
              <h3 className="font-medium">TOTP 两步验证</h3>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  twoFactorActive
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-[var(--surface)] text-[var(--muted)]"
                }`}
              >
                {twoFactorActive ? "已启用" : "未启用"}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
              对所有用户可选。启用后，密码登录还需验证器动态码；每枚备用码只能使用一次。
            </p>

            {!twoFactorActive && !twoFactorEnrollment ? (
              <div className="mt-4 flex max-w-lg flex-col gap-3 sm:flex-row">
                <input
                  type="password"
                  value={twoFactorPassword}
                  onChange={(event) => setTwoFactorPassword(event.target.value)}
                  placeholder="当前密码"
                  aria-label="两步验证当前密码"
                  className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--border)] px-3"
                />
                <button
                  type="button"
                  disabled={!twoFactorPassword || Boolean(busy)}
                  onClick={() =>
                    void run("two-factor-enable", async () => {
                      const result = await authClient.twoFactor.enable({
                        password: twoFactorPassword,
                        issuer: "OpenVac"
                      });
                      if (result.error || !result.data)
                        throw result.error ?? new Error("2FA enable failed");
                      setTwoFactorEnrollment({
                        totpURI: result.data.totpURI,
                        backupCodes: result.data.backupCodes
                      });
                      return "密钥已生成。请在验证器中添加后输入动态码完成启用。";
                    })
                  }
                  className="h-11 rounded-lg border border-[var(--border)] px-4 text-sm disabled:opacity-40"
                >
                  开始启用
                </button>
              </div>
            ) : null}

            {twoFactorEnrollment ? (
              <div className="mt-4 max-w-xl space-y-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
                <p className="text-sm font-medium">1. 将密钥添加到验证器</p>
                <code className="block rounded-lg bg-white p-3 text-xs break-all">
                  {totpSecret(twoFactorEnrollment.totpURI)}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      totpSecret(twoFactorEnrollment.totpURI)
                    )
                  }
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-amber-400 px-3 text-xs"
                >
                  <Copy className="h-3.5 w-3.5" /> 复制密钥
                </button>
                <p className="text-sm font-medium">
                  2. 输入验证器生成的 6 位动态码
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={twoFactorCode}
                    onChange={(event) => setTwoFactorCode(event.target.value)}
                    aria-label="启用两步验证动态码"
                    className="h-11 min-w-0 flex-1 rounded-lg border border-amber-400 bg-white px-3 font-mono tracking-[0.18em]"
                  />
                  <button
                    type="button"
                    disabled={twoFactorCode.trim().length < 6 || Boolean(busy)}
                    onClick={() =>
                      void run("two-factor-verify", async () => {
                        const result = await authClient.twoFactor.verifyTotp({
                          code: twoFactorCode.replace(/\s+/gu, "")
                        });
                        if (result.error) throw result.error;
                        setTwoFactorActive(true);
                        setBackupCodes(twoFactorEnrollment.backupCodes);
                        setTwoFactorEnrollment(null);
                        setTwoFactorCode("");
                        setTwoFactorPassword("");
                        return "两步验证已启用。请立即保存下面的一次性备用码。";
                      })
                    }
                    className="h-11 rounded-lg bg-[var(--ink)] px-4 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    验证并启用
                  </button>
                </div>
              </div>
            ) : null}

            {twoFactorActive ? (
              <div className="mt-4 flex max-w-xl flex-col gap-3 sm:flex-row">
                <input
                  type="password"
                  value={twoFactorPassword}
                  onChange={(event) => setTwoFactorPassword(event.target.value)}
                  placeholder="当前密码"
                  aria-label="管理两步验证当前密码"
                  className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--border)] px-3"
                />
                <button
                  type="button"
                  disabled={!twoFactorPassword || Boolean(busy)}
                  onClick={() =>
                    void run("two-factor-backup-codes", async () => {
                      const result =
                        await authClient.twoFactor.generateBackupCodes({
                          password: twoFactorPassword
                        });
                      if (result.error || !result.data)
                        throw result.error ?? new Error("2FA backup failed");
                      setBackupCodes(result.data.backupCodes);
                      setTwoFactorPassword("");
                      return "旧备用码已失效，已生成一组新备用码。";
                    })
                  }
                  className="h-11 rounded-lg border border-[var(--border)] px-3 text-sm disabled:opacity-40"
                >
                  重新生成备用码
                </button>
                <button
                  type="button"
                  disabled={!twoFactorPassword || Boolean(busy)}
                  onClick={() =>
                    void run("two-factor-disable", async () => {
                      const result = await authClient.twoFactor.disable({
                        password: twoFactorPassword
                      });
                      if (result.error) throw result.error;
                      setTwoFactorActive(false);
                      setBackupCodes([]);
                      setTwoFactorPassword("");
                      return "两步验证已关闭。";
                    })
                  }
                  className="h-11 rounded-lg border border-red-300 px-3 text-sm text-red-700 disabled:opacity-40"
                >
                  关闭两步验证
                </button>
              </div>
            ) : null}

            {backupCodes.length > 0 ? (
              <div className="mt-4 max-w-xl rounded-xl border border-red-300 bg-red-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">
                    一次性备用码（仅显示在本次操作中）
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(backupCodes.join("\n"))
                    }
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-300 px-3 text-xs"
                  >
                    <Copy className="h-3.5 w-3.5" /> 复制全部
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-3">
                  {backupCodes.map((code) => (
                    <code
                      key={code}
                      className="rounded bg-white px-2 py-1.5 text-center"
                    >
                      {code}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </section>
      ) : null}

      {section === "all" || section === "memory" ? (
        <section
          className={
            section === "all"
              ? "mt-12 border-t border-[var(--border)] pt-8"
              : undefined
          }
        >
          <div className="flex items-center gap-3">
            <BrainCircuit className="h-5 w-5 text-[var(--muted)]" />
            <h2 className="text-xl font-semibold">主动记忆</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            这里只保存你在对话中明确确认的设备资料、常用工况和单位偏好。停用后不会进入新回答；删除会立即退出后续上下文。
          </p>
          <ul className="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {memories.length === 0 ? (
              <li className="py-5 text-sm text-[var(--muted)]">
                尚未保存主动记忆。
              </li>
            ) : null}
            {memories.map((memory) => (
              <li key={memory.id} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{memory.label}</p>
                    <p className="mt-1 text-xs leading-6 break-words text-[var(--muted)]">
                      {JSON.stringify(memory.facts)}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {memory.status === "active" ? "已启用" : "已停用"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const label = window
                          .prompt("修改记忆名称", memory.label)
                          ?.trim();
                        if (!label || label === memory.label) return;
                        void run(`memory-edit-${memory.id}`, async () => {
                          const response = await fetch(
                            `/api/account/memories/${memory.id}`,
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ label })
                            }
                          );
                          if (!response.ok)
                            throw new Error("memory edit failed");
                          await loadMemories();
                        });
                      }}
                      className="h-8 rounded-md border border-[var(--border)] px-2.5 text-xs"
                    >
                      编辑名称
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const raw = window.prompt(
                          "编辑记忆内容（JSON 对象）",
                          JSON.stringify(memory.facts, null, 2)
                        );
                        if (!raw) return;
                        let facts: Record<string, unknown>;
                        try {
                          const parsed = JSON.parse(raw) as unknown;
                          if (
                            !parsed ||
                            typeof parsed !== "object" ||
                            Array.isArray(parsed)
                          ) {
                            throw new Error("memory facts must be an object");
                          }
                          facts = parsed as Record<string, unknown>;
                        } catch {
                          setError("记忆内容必须是有效的 JSON 对象。");
                          return;
                        }
                        void run(`memory-facts-${memory.id}`, async () => {
                          const response = await fetch(
                            `/api/account/memories/${memory.id}`,
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ facts })
                            }
                          );
                          if (!response.ok)
                            throw new Error("memory facts edit failed");
                          await loadMemories();
                        });
                      }}
                      className="h-8 rounded-md border border-[var(--border)] px-2.5 text-xs"
                    >
                      编辑内容
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void run(`memory-toggle-${memory.id}`, async () => {
                          const response = await fetch(
                            `/api/account/memories/${memory.id}`,
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                status:
                                  memory.status === "active"
                                    ? "disabled"
                                    : "active"
                              })
                            }
                          );
                          if (!response.ok)
                            throw new Error("memory toggle failed");
                          await loadMemories();
                        })
                      }
                      className="h-8 rounded-md border border-[var(--border)] px-2.5 text-xs"
                    >
                      {memory.status === "active" ? "停用" : "启用"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`确认删除“${memory.label}”？`))
                          return;
                        void run(`memory-delete-${memory.id}`, async () => {
                          const response = await fetch(
                            `/api/account/memories/${memory.id}`,
                            {
                              method: "DELETE"
                            }
                          );
                          if (!response.ok)
                            throw new Error("memory delete failed");
                          await loadMemories();
                        });
                      }}
                      className="h-8 rounded-md border border-[#d9aaa5] px-2.5 text-xs text-[var(--danger)]"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {section === "all" || section === "data" ? (
        <section
          className={
            section === "all"
              ? "mt-12 border-t border-[var(--border)] pt-8"
              : undefined
          }
        >
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-[var(--muted)]" />
            <h2 className="text-xl font-semibold">数据管理</h2>
          </div>
          <h3 className="mt-6 text-base font-semibold">清空对话数据</h3>
          <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
            在线数据会立即删除，无法在产品中恢复。受限运维备份可能在不超过 30
            天的保留周期内延迟反映删除，并在保留期届满后过期。
          </p>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm("确认清空全部对话、消息、引用与反馈？"))
                return;
              void run("clear-data", async () => {
                const response = await fetch("/api/account/data", {
                  method: "DELETE"
                });
                if (!response.ok) throw new Error("clear failed");
                onConversationDataCleared?.();
              });
            }}
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-[#d9aaa5] px-4 text-sm text-[var(--danger)]"
          >
            <Trash2 className="h-4 w-4" />
            清空对话
          </button>

          <section className="mt-10 border-t border-[var(--border)] pt-8">
            <h3 className="text-base font-semibold">导出个人数据</h3>
            <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
              下载账户资料、非敏感设备信息、对话、消息、主动记忆、反馈和问题报告。导出不包含会话令牌、认证凭据、管理员内部备注或审计日志。
            </p>
            <a
              href="/api/account/export"
              download
              className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-4 text-sm"
            >
              <Download className="h-4 w-4" />
              下载 JSON 导出
            </a>
          </section>

          <section className="mt-10 border-t border-[var(--border)] pt-8">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-[var(--danger)]" />
              <h2 className="text-xl font-semibold">注销账户</h2>
            </div>
            <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
              输入密码后发送注销确认邮件。点击邮件中的有效确认链接后，账户和关联用户数据会立即删除，不设置冷静期；管理员角色账户仍需先移交职责。
            </p>
            <div className="mt-5 flex max-w-lg flex-col gap-3 sm:flex-row">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="当前密码"
                className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--border)] px-3"
              />
              <button
                type="button"
                disabled={!password || Boolean(busy)}
                onClick={() => {
                  if (!window.confirm("确认发送 OpenVac 账户注销邮件？"))
                    return;
                  void run("delete-user", async () => {
                    const result = await authClient.deleteUser({ password });
                    if (result.error) throw result.error;
                    setPassword("");
                    return "注销确认邮件已发送，请在链接有效期内前往邮箱完成确认。";
                  });
                }}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--danger)] px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy === "delete-user" && (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                )}
                发送注销确认邮件
              </button>
            </div>
          </section>
        </section>
      ) : null}
    </>
  );
}

export function AccountSettings({
  email,
  userName,
  image,
  twoFactorEnabled
}: {
  email: string;
  userName?: string;
  image?: string | null;
  twoFactorEnabled?: boolean;
}) {
  return (
    <main className="shell max-w-[840px] py-14 sm:py-20">
      <h1 className="text-3xl font-semibold tracking-[-0.04em]">账户设置</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">{email}</p>
      <div className="mt-12">
        <AccountSettingsContent
          email={email}
          userName={userName}
          image={image}
          twoFactorEnabled={twoFactorEnabled}
          section="all"
        />
      </div>
    </main>
  );
}
