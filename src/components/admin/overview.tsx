"use client";

import { useEffect, useState } from "react";

type Metrics = {
  answersToday: number;
  activeUsersToday: number;
  errorRate: number;
  p95LatencyMs: number;
  searchCallsToday: number;
  openProblemReports: number;
};

type AgentStatus = {
  enabled: boolean;
  environmentMasterSwitch: boolean;
  protocol: string;
  rollbackPath: string;
  configuration: Record<string, boolean>;
  metrics24h: {
    activeRuns: number;
    statuses: Record<string, number>;
    p95LatencyMs: number;
    providerInvocations: Record<string, number>;
    pendingKnowledgeReview: number;
  };
};

const initial: Metrics = {
  answersToday: 0,
  activeUsersToday: 0,
  errorRate: 0,
  p95LatencyMs: 0,
  searchCallsToday: 0,
  openProblemReports: 0
};

export function AdminOverview() {
  const [metrics, setMetrics] = useState(initial);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentNotice, setAgentNotice] = useState("");
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    void fetch("/api/admin/metrics", { cache: "no-store" }).then(
      async (response) => {
        if (response.status === 403) {
          setForbidden(true);
          return;
        }
        if (!response.ok) return;
        const payload = (await response.json()) as {
          metrics?: Partial<Metrics>;
          data?: Partial<Metrics>;
        };
        setMetrics({ ...initial, ...(payload.metrics ?? payload.data) });
      }
    );
    void fetch("/api/admin/agent/status", { cache: "no-store" }).then(
      async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: AgentStatus };
        if (payload.data) setAgent(payload.data);
      }
    );
  }, []);

  async function refreshAgentStatus() {
    const response = await fetch("/api/admin/agent/status", {
      cache: "no-store"
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: AgentStatus };
    if (payload.data) setAgent(payload.data);
  }

  async function toggleAgent() {
    if (!agent || agentBusy) return;
    setAgentBusy(true);
    setAgentNotice("");
    try {
      const response = await fetch("/api/admin/agent/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !agent.enabled })
      });
      const payload = (await response.json()) as {
        data?: { enabled: boolean };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        setAgentNotice(payload.error?.message ?? "Agent 开关更新失败。");
        return;
      }
      setAgent((current) =>
        current ? { ...current, enabled: payload.data!.enabled } : current
      );
      setAgentNotice(
        payload.data.enabled
          ? "Agent V2 已原子启用。"
          : "Agent V2 已关闭，新请求回到 Chat 回滚通道。"
      );
    } finally {
      setAgentBusy(false);
    }
  }

  async function runAgentCheck(check: "balance" | "responses") {
    if (agentBusy) return;
    setAgentBusy(true);
    setAgentNotice("");
    try {
      const response = await fetch("/api/admin/agent/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check })
      });
      const payload = (await response.json()) as {
        data?: {
          available?: boolean;
          balances?: Array<{ currency: string; total: string }>;
          latencyMs?: number;
        };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        setAgentNotice(payload.error?.message ?? "检查失败。");
        return;
      }
      if (check === "balance") {
        const balances = payload.data.balances ?? [];
        setAgentNotice(
          payload.data.available
            ? `余额可用：${balances.map((item) => `${item.total} ${item.currency}`).join("，") || "Provider 未返回币种明细"}`
            : "Provider 报告余额当前不可用。"
        );
      } else {
        setAgentNotice(
          `Responses 模型检查通过，耗时 ${payload.data.latencyMs ?? 0} ms。`
        );
      }
      await refreshAgentStatus();
    } finally {
      setAgentBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div className="rounded-xl border border-[#e2b8b3] bg-[#fff7f6] p-5 text-sm text-[var(--danger)]">
        当前账户没有运营后台权限。页面内容和所有后台 API
        都需要服务端管理员角色校验。
      </div>
    );
  }

  const rows = [
    ["今日成功回答", metrics.answersToday.toLocaleString("zh-CN")],
    ["今日活跃用户", metrics.activeUsersToday.toLocaleString("zh-CN")],
    ["错误率", `${(metrics.errorRate * 100).toFixed(2)}%`],
    ["P95 延迟", `${metrics.p95LatencyMs.toLocaleString("zh-CN")} ms`],
    ["今日联网调用", metrics.searchCallsToday.toLocaleString("zh-CN")],
    ["待处理问题反馈", metrics.openProblemReports.toLocaleString("zh-CN")]
  ];

  return (
    <div className="space-y-8">
      <div className="grid border-t border-l border-[var(--border)] sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="min-h-36 border-r border-b border-[var(--border)] p-6"
          >
            <p className="text-sm text-[var(--muted)]">{label}</p>
            <p className="mt-5 text-3xl font-semibold tracking-[-0.04em]">
              {value}
            </p>
          </div>
        ))}
      </div>

      {agent && (
        <section
          className="rounded-xl border border-[var(--border)] p-5"
          aria-labelledby="agent-v2-status-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 id="agent-v2-status-title" className="text-lg font-semibold">
                Agent V2
              </h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {agent.enabled
                  ? "Responses 正式流量已启用"
                  : "当前使用 Chat 回滚通道"}
                {agent.environmentMasterSwitch ? "" : "；环境总开关未开启"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
                disabled={agentBusy}
                onClick={() => void runAgentCheck("balance")}
              >
                检查余额
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
                disabled={agentBusy}
                onClick={() => void runAgentCheck("responses")}
              >
                检查 Responses
              </button>
              <button
                type="button"
                className="rounded-lg bg-[var(--foreground)] px-3 py-2 text-sm text-white disabled:opacity-50"
                disabled={agentBusy || !agent.environmentMasterSwitch}
                onClick={() => void toggleAgent()}
              >
                {agent.enabled ? "切回 Chat" : "启用 Agent V2"}
              </button>
            </div>
          </div>
          <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <AgentMetric label="活跃运行" value={agent.metrics24h.activeRuns} />
            <AgentMetric
              label="24h P95"
              value={`${agent.metrics24h.p95LatencyMs} ms`}
            />
            <AgentMetric
              label="待审知识"
              value={agent.metrics24h.pendingKnowledgeReview}
            />
            <AgentMetric
              label="配置门槛"
              value={
                Object.values(agent.configuration).every(Boolean)
                  ? "通过"
                  : "未通过"
              }
            />
          </div>
          <p
            className="mt-4 min-h-5 text-sm text-[var(--muted)]"
            aria-live="polite"
          >
            {agentNotice}
          </p>
        </section>
      )}
    </div>
  );
}

function AgentMetric({
  label,
  value
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg bg-[var(--surface)] p-3">
      <p className="text-[var(--muted)]">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}
