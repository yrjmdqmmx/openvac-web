import { AdminOverview } from "@/components/admin/overview";

export default function AdminPage() {
  return (
    <main className="p-5 sm:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-[-0.04em]">运行概览</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          查看用量、成本、延迟、错误与待处理运营事项。
        </p>
      </div>
      <AdminOverview />
    </main>
  );
}
