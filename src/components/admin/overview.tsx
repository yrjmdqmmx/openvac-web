"use client";

import { useEffect, useState } from "react";
import { AdminTaskCenter } from "@/components/admin/task-center";

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

function isMetrics(value: unknown): value is Metrics {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [
    "answersToday",
    "activeUsersToday",
    "errorRate",
    "p95LatencyMs",
    "searchCallsToday",
    "openProblemReports"
  ].every((key) => typeof record[key] === "number");
}

export function AdminOverview() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsUnavailable, setMetricsUnavailable] = useState(false);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [canExecuteModels, setCanExecuteModels] = useState(false);
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
        if (!response.ok) {
          setMetricsUnavailable(true);
          return;
        }
        const payload = (await response.json()) as {
          metrics?: Partial<Metrics>;
          data?: Partial<Metrics>;
        };
        const value = payload.metrics ?? payload.data;
        if (isMetrics(value)) setMetrics(value);
        else setMetricsUnavailable(true);
      }
    );
    void fetch("/api/admin/context", { cache: "no-store" }).then(
      async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data?: { capabilities?: string[] };
        };
        setCanExecuteModels(
          payload.data?.capabilities?.includes("models:execute") ?? false
        );
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

  async function runAgentCheck(check: "balance" | "responses") {
    if (agentBusy) return;
    if (!window.confirm("这会主动调用外部模型或余额接口，确认继续？")) return;
    setAgentBusy(true);
    setAgentNotice("");
    try {
      const response = await fetch("/api/admin/agent/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check,
          confirmation: "EXECUTE_EXTERNAL_MODEL_CHECK"
        })
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

  const rows = metrics
    ? [
        ["今日成功回答", metrics.answersToday.toLocaleString("zh-CN")],
        ["今日活跃用户", metrics.activeUsersToday.toLocaleString("zh-CN")],
        ["错误率", `${(metrics.errorRate * 100).toFixed(2)}%`],
        ["P95 延迟", `${metrics.p95LatencyMs.toLocaleString("zh-CN")} ms`],
        ["今日联网调用", metrics.searchCallsToday.toLocaleString("zh-CN")],
        ["待处理问题反馈", metrics.openProblemReports.toLocaleString("zh-CN")]
      ]
    : [];

  return (
    <div className="space-y-8">
      <AdminTaskCenter />
      {metricsUnavailable ? (
        <div
          role="alert"
          className="rounded-xl border border-[#e2b8b3] bg-[#fff7f6] p-5 text-sm text-[var(--danger)]"
        >
          概览指标暂时不可用；为避免误判，本页不会用 0 代替缺失数据。
        </div>
      ) : null}
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
          aria-labelledby="agent-v3-status-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 id="agent-v3-status-title" className="text-lg font-semibold">
                Agent V3
              </h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Responses 为唯一聊天运行路径；回滚使用上一镜像摘要
              </p>
            </div>
            {canExecuteModels ? (
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
              </div>
            ) : null}
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
