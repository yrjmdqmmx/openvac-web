import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AccountSettings } from "@/components/account/account-settings";
import { Brand } from "@/components/brand";
import { auth } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?returnTo=%2Fsettings");

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-[var(--border)]">
        <div className="shell flex h-20 items-center justify-between">
          <Brand compact />
          <a href="/chat" className="text-sm text-[var(--muted)]">
            返回对话
          </a>
        </div>
      </header>
      <AccountSettings
        email={session.user.email}
        userName={session.user.name || "OpenVac 用户"}
      />
    </div>
  );
}
