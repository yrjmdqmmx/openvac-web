"use client";

import {
  Database,
  LoaderCircle,
  BrainCircuit,
  MonitorSmartphone,
  ShieldAlert,
  Trash2,
  UserRound
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

export function AccountSettingsContent({
  email,
  userName = "OpenVac 用户",
  section = "all",
  onConversationDataCleared
}: {
  email: string;
  userName?: string;
  section?: AccountSettingsSection | "all";
  onConversationDataCleared?: () => void;
}) {
  const [sessions, setSessions] = useState<AccountSessionSummary[]>([]);
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
    } catch {
      setSessions([]);
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
    if (section !== "all" && section !== "sessions") return;
    const timer = window.setTimeout(() => void loadSessions(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSessions, section]);

  useEffect(() => {
    if (section !== "all" && section !== "memory") return;
    const timer = window.setTimeout(() => void loadMemories(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMemories, section]);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setNotice("");
    setError("");
    try {
      await action();
      setNotice("操作已完成。");
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
          <dl className="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)] text-sm">
            <div className="grid gap-2 py-4 sm:grid-cols-[120px_1fr]">
              <dt className="text-[var(--muted)]">姓名</dt>
              <dd className="break-words sm:text-right">{userName}</dd>
            </div>
            <div className="grid gap-2 py-4 sm:grid-cols-[120px_1fr]">
              <dt className="text-[var(--muted)]">电子邮件</dt>
              <dd className="break-all sm:text-right">{email}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {section === "all" || section === "sessions" ? (
        <section
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
            {sessions.length === 0 ? (
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
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {session.ipAddress || "IP 未记录"} · 到期{" "}
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
                  disabled={Boolean(busy)}
                  className="text-left text-sm text-[var(--danger)] disabled:opacity-40"
                >
                  {busy === `revoke-${session.id}` ? "正在撤销…" : "撤销会话"}
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
            在线数据会立即删除，无法在产品中恢复。当前封闭测试环境的受限运维备份可能延迟反映删除；公开试用前将启用并验证不超过
            30 天的自动过期机制。
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
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-[var(--danger)]" />
              <h2 className="text-xl font-semibold">注销账户</h2>
            </div>
            <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
              输入密码后永久注销账户，并删除问题反馈中的可选联系方式和账户关联；只可能保留无法再识别个人的匿名汇总统计。管理员角色账户需要先移交职责，不能直接自助删除。
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
                  if (!window.confirm("确认永久注销 OpenVac 账户？")) return;
                  void run("delete-user", async () => {
                    const result = await authClient.deleteUser({ password });
                    if (result.error) throw result.error;
                    window.location.assign("/");
                  });
                }}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--danger)] px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy === "delete-user" && (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                )}
                永久注销
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
  userName
}: {
  email: string;
  userName?: string;
}) {
  return (
    <main className="shell max-w-[840px] py-14 sm:py-20">
      <h1 className="text-3xl font-semibold tracking-[-0.04em]">账户设置</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">{email}</p>
      <div className="mt-12">
        <AccountSettingsContent
          email={email}
          userName={userName}
          section="all"
        />
      </div>
    </main>
  );
}
