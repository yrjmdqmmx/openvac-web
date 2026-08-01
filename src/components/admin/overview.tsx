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
  }, []);

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
  );
}
