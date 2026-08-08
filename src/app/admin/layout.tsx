import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { apiStore } from "@/server/api/store";
import { auth } from "@/server/auth";
import { buildAdminContext } from "@/server/api/auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in?returnTo=%2Fadmin");
  }

  const role = await apiStore.getAdminRole(session.user.id);
  if (!role) {
    return (
      <main className="grid min-h-screen place-items-center bg-white px-6">
        <div className="max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.04em]">
            你没有权限进入运营后台。
          </h1>
          <p className="mt-3 text-sm text-[var(--muted)]">
            这个账号当前没有持久化的后台角色，请联系 owner 重新分配权限。
          </p>
        </div>
      </main>
    );
  }

  const context = buildAdminContext({
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
    banned: Boolean(session.user.banned),
    roleHint: null,
    role
  });

  return (
    <AdminShell context={context} userName={session.user.name || "运营管理员"}>
      {children}
    </AdminShell>
  );
}
