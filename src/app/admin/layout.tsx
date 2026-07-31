import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { auth } from "@/server/auth";

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

  return (
    <AdminShell userName={session.user.name || "运营管理员"}>
      {children}
    </AdminShell>
  );
}
