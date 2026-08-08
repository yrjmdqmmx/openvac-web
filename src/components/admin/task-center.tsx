"use client";

import { ArrowRight, Clock3, RefreshCw, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type TaskState = {
  assigneeUserId: string | null;
  status: "open" | "in_progress" | "done";
  dueAt: string | null;
  snoozedUntil: string | null;
  note: string | null;
  revision: number;
};

type Task = {
  key: string;
  sourceType: string;
  sourceId: string;
  sourceStatus: string;
  title: string;
  summary: string;
  href: string;
  severity: "critical" | "high" | "medium" | "low";
  occurredAt: string;
  state: TaskState;
};

const severityLabel = {
  critical: "关键",
  high: "高",
  medium: "中",
  low: "低"
} as const;

export function AdminTaskCenter() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [tasksResponse, contextResponse] = await Promise.all([
      fetch("/api/admin/tasks", { cache: "no-store" }),
      fetch("/api/admin/context", { cache: "no-store" })
    ]);
    if (!tasksResponse.ok || !contextResponse.ok) {
      setNotice("任务中心暂时不可用，请稍后刷新。");
      return;
    }
    const tasksPayload = (await tasksResponse.json()) as {
      data?: { items?: Task[] };
    };
    const contextPayload = (await contextResponse.json()) as {
      data?: { user?: { id?: string } };
    };
    const items = tasksPayload.data?.items ?? [];
    setTasks(items);
    setCurrentUserId(contextPayload.data?.user?.id ?? "");
    setSelectedKey(items[0]?.key ?? "");
    setNote(items[0]?.state.note ?? "");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = useMemo(
    () => tasks.find((task) => task.key === selectedKey) ?? null,
    [selectedKey, tasks]
  );

  async function updateState(patch: Record<string, unknown>) {
    if (!selected || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskKey: selected.key,
          expectedRevision: selected.state.revision,
          ...patch
        })
      });
      const payload = (await response.json()) as {
        data?: TaskState;
        error?: { message?: string };
      };
      if (response.status === 409) {
        setNotice("任务已被其他管理员更新，已为你刷新。");
        await load();
        return;
      }
      if (!response.ok || !payload.data) {
        setNotice(payload.error?.message ?? "任务更新失败。");
        return;
      }
      setTasks((current) =>
        current.map((task) =>
          task.key === selected.key ? { ...task, state: payload.data! } : task
        )
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="admin-task-center-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="admin-task-center-title" className="text-xl font-semibold">
            运营任务
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            由真实业务状态生成；领取、截止时间和备注不会改写源记录。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
        >
          <RefreshCw className="size-4" />
          刷新
        </button>
      </div>

      {notice ? (
        <p
          role="status"
          className="rounded-lg bg-[var(--surface)] px-4 py-3 text-sm"
        >
          {notice}
        </p>
      ) : null}

      <div className="grid min-h-[430px] overflow-hidden rounded-xl border border-[var(--border)] lg:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)]">
        <div className="divide-y divide-[var(--border)] lg:border-r lg:border-[var(--border)]">
          {tasks.length === 0 ? (
            <p className="p-6 text-sm text-[var(--muted)]">
              当前没有待处理任务。
            </p>
          ) : null}
          {tasks.map((task) => (
            <button
              key={task.key}
              type="button"
              onClick={() => {
                setSelectedKey(task.key);
                setNote(task.state.note ?? "");
                setMobileDetailOpen(true);
              }}
              className={`block w-full p-4 text-left hover:bg-[var(--surface)] ${
                selectedKey === task.key ? "bg-[var(--accent-soft)]" : ""
              }`}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="font-medium">{task.title}</span>
                <span
                  className={`rounded-full px-2 py-1 text-xs ${
                    task.severity === "critical"
                      ? "bg-[#fff0ee] text-[var(--danger)]"
                      : "bg-[var(--surface)] text-[var(--muted)]"
                  }`}
                >
                  {severityLabel[task.severity]}
                </span>
              </span>
              <span className="mt-2 line-clamp-2 block text-sm text-[var(--muted)]">
                {task.summary}
              </span>
              <span className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
                <Clock3 className="size-3.5" />
                {task.state.status === "in_progress"
                  ? "处理中"
                  : task.state.status === "done"
                    ? "已完成"
                    : "待领取"}
              </span>
            </button>
          ))}
        </div>

        <TaskDetail
          task={selected}
          note={note}
          setNote={setNote}
          busy={busy}
          currentUserId={currentUserId}
          mobileOpen={mobileDetailOpen}
          closeMobile={() => setMobileDetailOpen(false)}
          updateState={updateState}
        />
      </div>
    </section>
  );
}

function TaskDetail({
  task,
  note,
  setNote,
  busy,
  currentUserId,
  mobileOpen,
  closeMobile,
  updateState
}: {
  task: Task | null;
  note: string;
  setNote: (value: string) => void;
  busy: boolean;
  currentUserId: string;
  mobileOpen: boolean;
  closeMobile: () => void;
  updateState: (patch: Record<string, unknown>) => Promise<void>;
}) {
  if (!task)
    return (
      <div className="hidden p-6 text-sm text-[var(--muted)] lg:block">
        选择一项任务查看详情。
      </div>
    );

  return (
    <aside
      aria-label="任务详情"
      className={`${
        mobileOpen ? "fixed inset-0 z-50 flex" : "hidden"
      } flex-col bg-white lg:static lg:flex`}
    >
      <div className="flex-1 overflow-y-auto p-5 sm:p-7">
        <button
          type="button"
          onClick={closeMobile}
          className="float-right grid size-10 place-items-center lg:hidden"
          aria-label="关闭任务详情"
        >
          <X className="size-5" />
        </button>
        <p className="text-xs tracking-wide text-[var(--muted)] uppercase">
          {task.sourceType} · {task.sourceStatus}
        </p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">
          {task.title}
        </h3>
        <p className="mt-4 text-sm leading-7 text-[var(--muted)]">
          {task.summary}
        </p>
        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-[var(--surface)] p-3">
            <dt className="text-[var(--muted)]">优先级</dt>
            <dd className="mt-1 font-medium">{severityLabel[task.severity]}</dd>
          </div>
          <div className="rounded-lg bg-[var(--surface)] p-3">
            <dt className="text-[var(--muted)]">负责人</dt>
            <dd className="mt-1 font-medium">
              {task.state.assigneeUserId || "未领取"}
            </dd>
          </div>
        </dl>
        <label className="mt-6 block text-sm font-medium" htmlFor="task-note">
          内部备注
        </label>
        <textarea
          id="task-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          className="mt-2 min-h-28 w-full rounded-lg border border-[var(--border)] p-3 text-sm"
        />
        <Link
          href={task.href}
          className="mt-5 inline-flex items-center gap-2 text-sm font-medium"
        >
          打开源记录 <ArrowRight className="size-4" />
        </Link>
      </div>
      <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-[var(--border)] bg-white p-4">
        <button
          type="button"
          disabled={busy || !currentUserId}
          onClick={() =>
            void updateState({
              assigneeUserId: currentUserId,
              status: "in_progress"
            })
          }
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--foreground)] px-4 text-sm text-white disabled:opacity-40"
        >
          <UserRound className="size-4" />
          领取任务
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void updateState({ note })}
          className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm disabled:opacity-40"
        >
          保存备注
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void updateState({ status: "done" })}
          className="h-10 rounded-lg border border-[var(--border)] px-4 text-sm disabled:opacity-40"
        >
          标记完成
        </button>
      </div>
    </aside>
  );
}
