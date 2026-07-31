"use client";

import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  adminColumnLabels,
  adminModuleConfigs,
  extractAdminRows,
  formatAdminValue,
  type AdminRow,
  type AdminSection
} from "./admin-data";

export type { AdminSection } from "./admin-data";

export function AdminModuleTable({ section }: { section: AdminSection }) {
  const config = adminModuleConfigs[section];
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    const response = await fetch(config.endpoint, { cache: "no-store" });
    setLoading(false);
    if (!response.ok) {
      setError(
        response.status === 403
          ? "当前角色无权访问这个模块。"
          : "模块数据暂时无法读取。"
      );
      return;
    }
    const payload: unknown = await response.json();
    setRows(extractAdminRows(payload, section));
  }, [config.endpoint, section]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const visible = useMemo(
    () =>
      rows.filter((row) =>
        JSON.stringify(row).toLowerCase().includes(query.toLowerCase())
      ),
    [query, rows]
  );

  return (
    <main className="p-5 sm:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em]">
            {config.title}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {config.description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--border)] px-3 text-sm"
        >
          <RefreshCw className="h-4 w-4" />
          刷新
        </button>
      </div>

      <label className="mt-8 flex h-11 max-w-md items-center gap-2 rounded-lg border border-[var(--border)] px-3">
        <Search className="h-4 w-4 text-[var(--muted)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 outline-none"
          placeholder="搜索当前模块"
        />
      </label>

      {loading ? (
        <div className="grid min-h-72 place-items-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-[var(--muted)]" />
        </div>
      ) : error ? (
        <p className="mt-8 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] p-4 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto border-t border-[var(--border)]">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr>
                {config.columns.map((column) => (
                  <th
                    key={column}
                    className="border-b border-[var(--border)] px-3 py-4 font-medium"
                  >
                    {adminColumnLabels[column] ?? column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={config.columns.length}
                    className="h-48 text-center text-[var(--muted)]"
                  >
                    暂无记录
                  </td>
                </tr>
              ) : (
                visible.map((row, index) => (
                  <tr
                    key={String(row.id ?? index)}
                    className="hover:bg-[var(--surface)]"
                  >
                    {config.columns.map((column) => (
                      <td
                        key={column}
                        className="max-w-[300px] truncate border-b border-[var(--border)] px-3 py-4"
                      >
                        {formatAdminValue(column, row[column])}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
